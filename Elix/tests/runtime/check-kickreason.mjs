/**
 * Runtime check for the kick-reason parser, run against the BUILT bundle.
 *
 * Unit tests run inside vitest, which injects its own `require` — so they pass
 * even when the source would throw ReferenceError under plain node ESM, and
 * even when esbuild rewrites `require` into a throwing `__require`. This script
 * spawns real node processes against dist/cli/index.js so both failure modes are
 * covered.
 *
 * Usage: node tests/runtime/check-kickreason.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const dist = resolve(root, "dist", "cli", "index.js");

/** The NBT compound a 26.2 server sends for a whitelist rejection in play state. */
const NBT_WHITELIST = JSON.stringify({
  type: "compound",
  value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
});
const NBT_OPERATOR_KICK = JSON.stringify({
  type: "compound",
  value: { text: { type: "string", value: "Kicked by an operator" } },
});

function run(cmd, args) {
  const child = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function check(label, { cmd, args, expect }) {
  const r = run(cmd, args);
  let parsed = {};
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = { raw: r.stdout.trim(), stderr: r.stderr.trim() };
  }
  const problems = [];
  for (const [key, want] of Object.entries(expect)) {
    if (parsed[key] !== want) problems.push(`${key}: got ${JSON.stringify(parsed[key])}, want ${JSON.stringify(want)}`);
  }
  // A crash shows up as an abnormal exit code, never as a clean JSON answer.
  if (r.status !== 0) problems.push(`exit code ${r.status} (stderr: ${r.stderr.trim().slice(0, 300)})`);
  const ok = problems.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`      stdout: ${r.stdout.trim().slice(0, 300)}`);
    for (const p of problems) console.log(`      ${p}`);
  }
  return ok;
}

if (!existsSync(dist)) {
  console.error("dist/cli/index.js is missing — run `pnpm build` first.");
  process.exit(1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const results = [
  check("source under tsx: NBT whitelist kick is permanent", {
    cmd: process.execPath,
    args: ["--import", "tsx", resolve(root, "tests", "runtime", "probe-kickreason.mts")],
    expect: { translateKey: "multiplayer.disconnect.not_whitelisted", kind: "whitelist", shouldRetry: false },
  }),
  check("built bundle: NBT whitelist kick is permanent", {
    cmd: process.execPath,
    args: [dist, "debug", "kick-reason", NBT_WHITELIST],
    expect: { translateKey: "multiplayer.disconnect.not_whitelisted", kind: "whitelist", shouldRetry: false },
  }),
  check("built bundle: NBT operator kick still retries", {
    cmd: process.execPath,
    args: [dist, "debug", "kick-reason", NBT_OPERATOR_KICK],
    expect: { kind: "kick", shouldRetry: true },
  }),
  check("built bundle: login-state JSON whitelist kick is permanent", {
    cmd: process.execPath,
    args: [dist, "debug", "kick-reason", '{"translate":"multiplayer.disconnect.not_whitelisted"}'],
    expect: { kind: "whitelist", shouldRetry: false },
  }),
];

void pnpm;
const passed = results.every(Boolean);
console.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(passed ? 0 : 1);