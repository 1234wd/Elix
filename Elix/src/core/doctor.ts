import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { ElixConfig } from "./config.js";
import { getActiveProfile, loadModelsConfig, PROJECT_ROOT } from "./config.js";
import { pingServer } from "../connection/ping.js";
import { expectedProtocol, hasDataFor } from "../connection/version.js";
import { buildBrain } from "../brain/index.js";
import type { FetchLike } from "../brain/types.js";

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
  /** Override the Hugging Face embeddings probe (tests). */
  embeddingsCall?: (model: string, token: string) => Promise<boolean>;
  /** Override the fetch used for model discovery (tests). */
  fetchImpl?: FetchLike;
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

/**
 * The cloud providers Elix can use: Groq and Hugging Face.
 *
 * `builtin` needs no key — it is Elix's own scripted fallback code.
 */
export const PROVIDER_KEYS: ReadonlyArray<readonly [env: string, label: string, baseUrl: string]> = [
  ["GROQ_API_KEY", "Groq", "https://api.groq.com/openai/v1"],
  ["HF_TOKEN", "Hugging Face", "https://router.huggingface.co/v1"],
];

export function checkApiKeys(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const present = PROVIDER_KEYS.filter(([k]) => !!env[k]);
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
  _provider: string,
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

/**
 * Hugging Face embeddings are NOT on the /v1 chat route.
 *
 * The router exposes feature extraction on a separate pipeline endpoint, so
 * `elix doctor` probes it directly. If it fails, memory falls back to FTS5
 * keyword search and embeds lazily afterwards.
 */
export const HF_ROUTER_BASE = "https://router.huggingface.co";

/**
 * Build the feature-extraction URL.
 *
 * A3: the model id contains a slash (`BAAI/bge-small-en-v1.5`) and the router
 * path expects a real slash there. `encodeURIComponent` on the whole id turns it
 * into `BAAI%2Fbge-small-en-v1.5`, which the router does not route. Each path
 * segment is encoded individually so the separator survives.
 */
export function hfFeatureExtractionUrl(model: string, base = HF_ROUTER_BASE): string {
  const encoded = model.split("/").map(encodeURIComponent).join("/");
  return `${base}/hf-inference/models/${encoded}/pipeline/feature-extraction`;
}

/** Hugging Face chat completions — the fallback path for the chat role. */
export function hfChatCompletionsUrl(base = HF_ROUTER_BASE): string {
  return `${base}/v1/chat/completions`;
}

async function defaultHfEmbeddingCall(model: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(hfFeatureExtractionUrl(model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: "elix doctor warmup" }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Async version actually used by the runner. */
export async function checkHfEmbeddingsAsync(
  env: NodeJS.ProcessEnv = process.env,
  call: (model: string, token: string) => Promise<boolean> = defaultHfEmbeddingCall,
  model = "BAAI/bge-small-en-v1.5",
): Promise<CheckResult> {
  const token = env["HF_TOKEN"];
  if (!token) {
    return {
      name: "hf-embeddings",
      status: "warn",
      note: "no HF_TOKEN — memory vectors unavailable, retrieval falls back to FTS5 keyword search",
    };
  }
  const ok = await call(model, token);
  return {
    name: "hf-embeddings",
    status: ok ? "ok" : "warn",
    note: ok
      ? `${model} reachable at ${hfFeatureExtractionUrl(model)}`
      : `${model} FAILED at ${hfFeatureExtractionUrl(model)} — memory uses FTS5 keyword search and embeds later`,
  };
}

export async function checkLiveApiKeys(
  env: NodeJS.ProcessEnv = process.env,
  call: (provider: string, apiKey: string, baseUrl: string) => Promise<boolean> = testLiveApiCall,
): Promise<CheckResult> {
  const results: string[] = [];
  for (const [envKey, label, baseUrl] of PROVIDER_KEYS) {
    const key = env[envKey];
    if (!key) continue;
    const ok = await call(label, key, baseUrl);
    // Lowercase the label so output is stable regardless of display casing.
    results.push(`${label.toLowerCase()}: ${ok ? "ok" : "FAIL"}`);
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

/**
 * Which model each role resolves to, and which fall back to `builtin` (B2).
 *
 * Uses the router's real resolution so `doctor` cannot disagree with the game.
 */
export async function checkModelResolution(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<CheckResult> {
  const groqKey = env["GROQ_API_KEY"]?.trim();
  const hfKey = env["HF_TOKEN"]?.trim();

  if (!groqKey && !hfKey) {
    return {
      name: "models",
      status: "warn",
      note: "no provider keys — every role uses scripted fallback lines",
    };
  }

  const models = await loadModelsConfig();
  const brain = buildBrain({
    models,
    projectRoot: PROJECT_ROOT,
    env,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    const resolutions = await brain.router.resolveRoles();
    const lines: string[] = [];
    const builtinRoles: string[] = [];
    for (const r of resolutions) {
      if (r.chosen) lines.push(`${r.role} → ${r.chosen.provider}/${r.chosen.model}`);
      else {
        lines.push(`${r.role} → builtin`);
        builtinRoles.push(r.role);
      }
    }
    const disabled = brain.router.disabledProviders();
    const suffix =
      disabled.length > 0
        ? ` (disabled: ${disabled.map((d) => `${d.provider} ${d.reason}`).join(", ")})`
        : "";
    return {
      name: "models",
      status: builtinRoles.length === resolutions.length ? "warn" : "ok",
      note:
        lines.join("; ") +
        suffix +
        (builtinRoles.length > 0 ? ` — builtin fallback for: ${builtinRoles.join(", ")}` : ""),
    };
  } catch (err) {
    return { name: "models", status: "warn", note: `resolution failed: ${(err as Error).message}` };
  } finally {
    brain.close();
  }
}

/**
 * Is there local protocol data for the target version? Without it Elix cannot
 * join (A11 — the version is a config value, the data must exist for it).
 */
export function checkVersionData(version: string): CheckResult {
  if (!hasDataFor(version)) {
    return {
      name: "version-data",
      status: "fail",
      note: `no minecraft-data for "${version}" — vendored data covers 26.2; update vendor/minecraft-data to move versions`,
    };
  }
  const protocol = expectedProtocol(version);
  if (protocol === 0) {
    return { name: "version-data", status: "fail", note: `protocol unknown for "${version}"` };
  }
  return { name: "version-data", status: "ok", note: `${version} = protocol ${protocol}` };
}

/**
 * Ping the server and compare its protocol to the one we expect for the
 * configured version (A11/A13: warn on a mismatch rather than failing).
 */
export async function checkServer(
  host: string,
  port: number,
  ping: (h: string, p: number) => Promise<{ version: string; protocol: number; software: string; motd: string; players: { online: number; max: number } }> = pingServer,
  targetVersion?: string,
): Promise<CheckResult> {
  const expected = targetVersion ? expectedProtocol(targetVersion) : 0;
  try {
    const r = await ping(host, port);
    const base = `${host}:${port} — ${r.software} "${r.version}" (protocol ${r.protocol}), ${r.players.online}/${r.players.max} players`;

    // A5: the mismatch must be computed BEFORE the MOTD is appended. Returning
    // early on a non-empty MOTD meant a real server (which always has one) could
    // never report a protocol mismatch.
    const mismatch =
      expected !== 0 && r.protocol !== expected
        ? ` — protocol mismatch: expected ${expected} for ${targetVersion}, server reports ${r.protocol}`
        : "";
    const motd = r.motd.length > 0 ? ` — motd: ${r.motd}` : "";

    return {
      name: "server",
      status: mismatch.length > 0 ? "warn" : "ok",
      note: `${base}${mismatch}${motd}`,
    };
  } catch (err) {
    return {
      name: "server",
      status: "warn",
      note: `${host}:${port} ping failed: ${(err as Error).message} (elix start will retry with backoff)`,
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
    Promise.resolve(checkVersionData(profile.version)),
    checkFfmpeg(exec),
    Promise.resolve(checkApiKeys(env)),
    checkLiveApiKeys(env, liveCall),
    checkHfEmbeddingsAsync(env, opts.embeddingsCall),
    checkModelResolution(env, opts.fetchImpl),
    checkServer(profile.host, profile.port, ping, profile.version),
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
