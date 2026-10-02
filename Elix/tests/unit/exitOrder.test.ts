/**
 * A2: exitCleanly is first-call-wins.
 *
 * The scenario that used to break: a second Ctrl+C commits 130, then the first
 * shutdown finishes and calls exitCleanly(0). Because `process.exitCode = code`
 * ran before the "already scheduled" check, the process exited 0 instead of 130
 * whenever the event loop drained before the 250 ms force-exit timer.
 *
 * These run in real spawned processes, because the bug only appears when the
 * event loop actually drains — a mocked process.exit cannot reproduce it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../src/core/config.js";

/** Write a tiny script that imports exitCleanly and runs `body`. */
async function runScript(body: string): Promise<{ status: number | null; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "elix-exit-"));
  const file = join(dir, "script.mts");
  try {
    // A file:// URL, not a bare Windows path — ESM rejects "c:\..." imports.
    const moduleUrl = pathToFileURL(
      resolve(PROJECT_ROOT, "src", "core", "exit.ts"),
    ).href;
    await writeFile(
      file,
      `import { exitCleanly, committedExitCode } from ${JSON.stringify(moduleUrl)};\n${body}\n`,
      "utf8",
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", file], {
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: child.status, stderr: child.stderr ?? "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("A2 — the first exitCleanly call wins", () => {
  it("130 then 0 exits 130, not 0", async () => {
    // The exact bug: forced exit 130, then the first shutdown completes with 0.
    const r = await runScript(`
      exitCleanly(130);
      exitCleanly(0);
    `);
    expect(r.status).toBe(130);
  });

  it("2 then 0 exits 2 — a whitelist stop is never downgraded to success", async () => {
    const r = await runScript(`
      exitCleanly(2);
      exitCleanly(0);
      exitCleanly(0);
    `);
    expect(r.status).toBe(2);
  });

  it("0 then 1 exits 0 — the first decision still holds", async () => {
    const r = await runScript(`
      exitCleanly(0);
      exitCleanly(1);
    `);
    expect(r.status).toBe(0);
  });

  it("committedExitCode reports the first code to later callers", async () => {
    const r = await runScript(`
      exitCleanly(130);
      const second = exitCleanly(0);
      if (second !== 130) throw new Error("second call returned " + second);
      if (committedExitCode() !== 130) throw new Error("committed is " + committedExitCode());
      // Keep the loop alive so the 250 ms force-exit timer is what ends us.
      setTimeout(() => {}, 400);
    `);
    // 130 whether the loop drains or the timer fires.
    expect(r.status).toBe(130);
  });

  it("does not exit at all when the loop drains before the timer", async () => {
    // This is the branch that made the bug visible: nothing holds the loop open,
    // so process.exitCode is what decides. It must still be the first code.
    const r = await runScript(`
      exitCleanly(130);
      exitCleanly(0);
    `);
    expect(r.status).toBe(130);
  });
});