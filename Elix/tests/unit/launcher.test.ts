import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../src/core/config.js";

/**
 * Vision rule 10: "runs on my Windows laptop from CMD with one command".
 * These tests pin the launcher so `elix start` keeps working from any folder.
 */

describe("elix.cmd — the Windows launcher", () => {
  it("resolves everything from its own folder, never from the cwd", async () => {
    const src = await readFile(join(PROJECT_ROOT, "elix.cmd"), "utf8");
    // %~dp0 is the script's own directory — the only correct anchor.
    expect(src).toContain("%~dp0");
    expect(src).toContain('set "ELIX_HOME=%~dp0"');
    // Every path that reaches into the project is anchored to that variable.
    const unanchored = src
      .split("\n")
      .filter((l) => /["%]?(dist|src|node_modules)[\\/]/.test(l))
      .filter((l) => !l.includes("%~dp0") && !l.includes("%ELIX_HOME%"))
      .filter((l) => !l.trim().startsWith("rem") && !l.trim().startsWith("::"));
    expect(unanchored, `unanchored paths:\n${unanchored.join("\n")}`).toEqual([]);
  });

  it("prefers the built release and falls back to tsx", async () => {
    const src = await readFile(join(PROJECT_ROOT, "elix.cmd"), "utf8");
    expect(src).toContain("dist\\cli\\index.js");
    expect(src).toContain("tsx.cmd");
    // bin.ts, not index.ts — index.ts's autorun guard is bypassed by the env var.
    expect(src).toContain("src\\cli\\bin.ts");
  });

  it("propagates the CLI's exit code instead of swallowing it", async () => {
    const src = await readFile(join(PROJECT_ROOT, "elix.cmd"), "utf8");
    // Vision rule: a permanent disconnect exits non-zero; the launcher must not
    // turn that into success.
    expect(src).toContain("exit /b %ERRORLEVEL%");
  });

  it("prints install instructions when nothing is built", async () => {
    const src = await readFile(join(PROJECT_ROOT, "elix.cmd"), "utf8");
    expect(src).toContain("pnpm install");
    expect(src).toContain("pnpm build");
  });
});

describe("elix.sh — the Unix launcher", () => {
  it("resolves its own directory and prefers the built release", async () => {
    const src = await readFile(join(PROJECT_ROOT, "elix.sh"), "utf8");
    expect(src).toContain('dirname "${BASH_SOURCE[0]}"');
    expect(src).toContain("$ELIX_HOME/dist/cli/index.js");
    expect(src).toContain("src/cli/bin.ts");
  });

  it("uses exec so the CLI owns the terminal (Ctrl+C reaches it)", async () => {
    // Without exec, bash sits between Elix and SIGINT and "gtg, cya" never runs.
    const src = await readFile(join(PROJECT_ROOT, "elix.sh"), "utf8");
    expect(src).toContain("exec node");
    expect(src).toContain('exec "$ELIX_HOME/node_modules/.bin/tsx"');
  });
});

describe("package.json — the bin entry matches the build output", () => {
  it("points bin.elix at dist/cli/index.js", async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin.elix).toBe("dist/cli/index.js");
  });

  it("that file is produced by the build", async () => {
    const st = await stat(join(PROJECT_ROOT, "dist", "cli", "index.js")).catch(() => null);
    // Tests run `pnpm build` (cli.test.ts does); if this fails the build is stale.
    expect(st, "dist/cli/index.js must exist — run pnpm build").not.toBeNull();
  });
});

describe("tsup output depth keeps PROJECT_ROOT correct", () => {
  it("emits two levels below the project root", async () => {
    const config = await readFile(join(PROJECT_ROOT, "tsup.config.ts"), "utf8");
    expect(config).toContain('"cli/index"');
    // PROJECT_ROOT is `../..` from src/core or dist/cli — both are 2 deep.
    expect(config).toContain("src/cli/bin.ts");
  });
});