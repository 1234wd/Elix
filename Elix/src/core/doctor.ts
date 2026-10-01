import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { ElixConfig } from "./config.js";
import { getActiveProfile } from "./config.js";
import { pingServer } from "../connection/ping.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  note: string;
}

export interface DoctorOptions {
  config: ElixConfig;
  /** Environment variables (defaults to process.env). Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override exec (tests). */
  execFile?: typeof execFileAsync;
  /** Override server ping (tests). */
  ping?: (host: string, port: number) => Promise<{ version: string; protocol: number; software: string; motd: string; players: { online: number; max: number } }>;
  /** Override live API call (tests). */
  liveApiCall?: (provider: string, apiKey: string, baseUrl: string) => Promise<boolean>;
}

const MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkNodeVersion(version: string = process.version): CheckResult {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  if (Number.isNaN(major)) {
    return { name: "node", status: "warn", note: `cannot parse node version "${version}"` };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: "node",
      status: "fail",
      note: `node ${version} found; elix needs >= ${MIN_NODE_MAJOR} (24 LTS recommended)`,
    };
  }
  return { name: "node", status: "ok", note: `node ${version}` };
}

export async function checkFfmpeg(
  exec: typeof execFileAsync = execFileAsync,
): Promise<CheckResult> {
  try {
    await exec("ffmpeg", ["-version"]);
    return { name: "ffmpeg", status: "ok", note: "system ffmpeg found" };
  } catch {
    // Check for ffmpeg-static npm package as fallback
    try {
      require.resolve("ffmpeg-static");
      return {
        name: "ffmpeg",
        status: "ok",
        note: "system ffmpeg not found, but ffmpeg-static npm package is available",
      };
    } catch {
      return {
        name: "ffmpeg",
        status: "warn",
        note: "no system ffmpeg and no ffmpeg-static — voice audio won't work (install ffmpeg-static)",
      };
    }
  }
}

export function checkApiKeys(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const keys: Array<[string, string]> = [
    ["GROQ_API_KEY", "Groq"],
    ["NVIDIA_API_KEY", "NVIDIA NIM"],
    ["HF_TOKEN", "Hugging Face"],
  ];
  const present = keys.filter(([k]) => !!env[k]);
  if (present.length === 0) {
    return {
      name: "api-keys",
      status: "warn",
      note: "no provider keys in .env — Elix will run on scripted fallback lines until keys are added",
    };
  }
  return {
    name: "api-keys",
    status: "ok",
    note: `found: ${present.map(([, label]) => label).join(", ")}`,
  };
}

/** Make one cheap live API call to verify the key works. */
async function testLiveApiCall(
  provider: string,
  apiKey: string,
  baseUrl: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkLiveApiKeys(
  env: NodeJS.ProcessEnv = process.env,
  call: (provider: string, apiKey: string, baseUrl: string) => Promise<boolean> = testLiveApiCall,
): Promise<CheckResult> {
  const providers: Array<[string, string, string]> = [
    ["groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1"],
    ["nvidia", "NVIDIA_API_KEY", "https://integrate.api.nvidia.com/v1"],
    ["hf", "HF_TOKEN", "https://router.huggingface.co/v1"],
  ];
  const results: string[] = [];
  for (const [name, envKey, baseUrl] of providers) {
    const key = env[envKey];
    if (!key) continue;
    const ok = await call(name, key, baseUrl);
    results.push(`${name}: ${ok ? "ok" : "FAIL"}`);
  }
  if (results.length === 0) {
    return { name: "api-live", status: "warn", note: "no keys to test" };
  }
  const allOk = results.every((r) => r.endsWith("ok"));
  return {
    name: "api-live",
    status: allOk ? "ok" : "warn",
    note: results.join(", "),
  };
}

export async function checkServer(
  host: string,
  port: number,
  ping: (h: string, p: number) => Promise<{ version: string; protocol: number; software: string; motd: string; players: { online: number; max: number } }> = pingServer,
): Promise<CheckResult> {
  try {
    const r = await ping(host, port);
    return {
      name: "server",
      status: "ok",
      note: `${host}:${port} — ${r.software} ${r.version} (protocol ${r.protocol}), ${r.players.online}/${r.players.max} players`,
    };
  } catch (err) {
    return {
      name: "server",
      status: "warn",
      note: `${host}:${port} ping failed: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDoctor(opts: DoctorOptions): Promise<CheckResult[]> {
  const env = opts.env ?? process.env;
  const exec = opts.execFile ?? execFileAsync;
  const ping = opts.ping ?? pingServer;
  const liveCall = opts.liveApiCall ?? testLiveApiCall;
  const c = opts.config;
  const profile = getActiveProfile(c);

  return Promise.all([
    Promise.resolve(checkNodeVersion()),
    checkFfmpeg(exec),
    Promise.resolve(checkApiKeys(env)),
    checkLiveApiKeys(env, liveCall),
    checkServer(profile.host, profile.port, ping),
  ]);
}

export function renderDoctor(results: CheckResult[]): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines = results.map((r) => `  ${icon[r.status]} ${r.name.padEnd(10)} ${r.note}`);
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("");
  lines.push(`  ${fails} failing, ${warns} warnings`);
  if (fails > 0) lines.push("  Fix the failing checks before `elix start`.");
  else lines.push("  All good — `elix start` when you're ready.");
  return lines.join("\n");
}
