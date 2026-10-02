import { execFileSync } from "node:child_process";

/**
 * Vitest global setup.
 *
 * A6: `pnpm test` must pass on a fresh clone. Several tests assert that
 * dist/cli/index.js exists (launcher.test.ts) or shell out to the built CLI
 * (cli.test.ts), so the build has to happen before any test runs — not inside
 * one test file, which would race the others.
 */

const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export default function setup(): void {
  console.log("[global-setup] building dist/ so the CLI tests can use it…");
  execFileSync(PNPM, ["build"], {
    stdio: "inherit",
    // Windows needs shell:true for the .cmd shim.
    shell: process.platform === "win32",
  });
}