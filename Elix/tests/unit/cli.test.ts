import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { registerStubs } from "../../src/cli/stubs.js";
import { registerDoctor } from "../../src/cli/doctor.js";
import { elixConfigSchema, PROJECT_ROOT } from "../../src/core/config.js";

const execFileAsync = promisify(execFile);

/**
 * A5/A9/A10: the CLI must work from any folder, load .env from the project
 * root (not the cwd), and honour --profile / --username / --version / --player.
 */
const DIST = resolve(PROJECT_ROOT, "dist", "cli", "index.js");
// A6: the build happens once in tests/global-setup.ts, so every test file can
// rely on dist/ without each one shelling out to pnpm.
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
void PNPM;
void execFileAsync;

/** Run the built CLI from an unrelated folder. */
async function runCli(args: string[], cwd: string) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [DIST, ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
  });
  return { stdout, stderr };
}

describe("A9 — the built CLI works from any folder", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "elix-cli-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prints status with the resolved project config, not the cwd's", async () => {
    const { stdout } = await runCli(["status"], tmp);
    expect(stdout).toContain("145.241.127.222:25565");
    expect(stdout).toContain("target version: 26.2");
  });

  it("prints help without touching the network", async () => {
    const { stdout } = await runCli(["--help"], tmp);
    expect(stdout).toContain("start");
    expect(stdout).toContain("doctor");
    // The vision's CLI: `elix forget --player <name>`
    expect(stdout).toContain("forget");
  });

  it("doctor lists all seven checks from another folder", async () => {
    const { stdout } = await runCli(["doctor", "--json"], tmp);
    const results = JSON.parse(stdout) as Array<{ name: string }>;
    expect(results.map((r) => r.name)).toEqual([
      "node",
      "version-data",
      "ffmpeg",
      "api-keys",
      "api-live",
      "hf-embeddings",
      "server",
    ]);
  });

  it("doctor exits 0 and does not crash the process", async () => {
    // Regression: process.exit() raced pino's transport worker and aborted with
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" on Windows.
    const { stdout } = await runCli(["doctor"], tmp);
    expect(stdout).toContain("failing");
  });
});

describe("A5 — .env is loaded from the project root, not the cwd", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "elix-dotenv-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds a key in a .env placed at PROJECT_ROOT even when run elsewhere", async () => {
    const envPath = join(PROJECT_ROOT, ".env");
    let created = false;
    try {
      await writeFile(envPath, "GROQ_API_KEY=elix_cli_test_key\n", "utf8");
      created = true;
      const { stdout } = await runCli(["doctor", "--json"], tmp);
      const results = JSON.parse(stdout) as Array<{ name: string; status: string; note: string }>;
      const keys = results.find((r) => r.name === "api-keys");
      // The fake key is present in the environment as far as doctor is
      // concerned; the live call then correctly reports FAIL.
      expect(keys?.status).toBe("ok");
      expect(keys?.note).toContain("Groq");
    } finally {
      if (created) await rm(envPath, { force: true });
    }
  });

  it("does not pick up a .env from the current folder", async () => {
    // A .env in cwd must NOT be read — the path is resolved from PROJECT_ROOT.
    await writeFile(join(tmp, ".env"), "HF_TOKEN=cwd_key\n", "utf8");
    const { stdout } = await runCli(["doctor", "--json"], tmp);
    const results = JSON.parse(stdout) as Array<{ name: string; note: string }>;
    const keys = results.find((r) => r.name === "api-keys");
    expect(keys?.note).toContain("no provider keys");
  });
});

describe("A10 — CLI flags are accepted and wired through", () => {
  /** Collect the resolved options for a parsed command, without running it. */
  function captureStartArgs(argv: string[]): Record<string, unknown> {
    const program = new Command();
    let captured: Record<string, unknown> = {};
    program.exitOverride();
    registerStubs(program);
    program
      .command("probe")
      .description("noop")
      .allowUnknownOption()
      .action(() => {});
    // Parse against `start` but intercept the action.
    const start = program.commands.find((c) => c.name() === "start")!;
    start.action((opts: Record<string, unknown>) => {
      captured = opts;
    });
    program.parse(["node", "elix", ...argv]);
    return captured;
  }

  it("accepts --username, --version and --profile without erroring", () => {
    const opts = captureStartArgs([
      "start",
      "--username",
      "Bob",
      "--version",
      "26.2",
      "--profile",
      "main",
    ]);
    expect(opts.username).toBe("Bob");
    expect(opts.version).toBe("26.2");
    expect(opts.profile).toBe("main");
  });

  it("defaults them to undefined so config wins", () => {
    const opts = captureStartArgs(["start"]);
    expect(opts.username).toBeUndefined();
    expect(opts.version).toBeUndefined();
    expect(opts.profile).toBeUndefined();
  });
});

describe("A10 — getActiveProfile wires every flag", () => {
  const cfg = elixConfigSchema.parse({
    version: 1,
    bot: { username: "Elix", version: "26.2" },
    server: { profile: "main" },
    profiles: {
      main: { host: "1.1.1.1", port: 25565, version: "26.2" },
      alt: { host: "2.2.2.2", port: 25566, version: "26.1" },
    },
  });

  it("uses the named profile", async () => {
    const { getActiveProfile } = await import("../../src/core/config.js");
    const p = getActiveProfile(cfg, { profile: "alt" });
    expect(p.name).toBe("alt");
    expect(p.host).toBe("2.2.2.2");
    expect(p.version).toBe("26.1");
  });

  it("applies --username", async () => {
    const { getActiveProfile } = await import("../../src/core/config.js");
    expect(getActiveProfile(cfg, { username: "Bob" }).username).toBe("Bob");
  });

  it("applies --version over the profile", async () => {
    const { getActiveProfile } = await import("../../src/core/config.js");
    expect(getActiveProfile(cfg, { profile: "alt", version: "26.2" }).version).toBe("26.2");
  });
});

describe("A10 — the forget command accepts --player", () => {
  function parseForget(argv: string[]): { ok: boolean; error?: string; player?: string } {
    const program = new Command();
    program.exitOverride();
    registerStubs(program);
    let player: string | undefined;
    const forget = program.commands.find((c) => c.name() === "forget")!;
    forget.action((opts: { player: string }) => {
      player = opts.player;
    });
    try {
      program.parse(["node", "elix", ...argv]);
      return { ok: true, player };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  it("elix forget --player Ali parses (the vision's CLI)", () => {
    const r = parseForget(["forget", "--player", "Ali"]);
    expect(r.ok).toBe(true);
    expect(r.player).toBe("Ali");
  });

  it("elix memory forget --player Ali parses", () => {
    const program = new Command();
    program.exitOverride();
    registerStubs(program);
    const memory = program.commands.find((c) => c.name() === "memory")!;
    let player: string | undefined;
    const forget = memory.commands.find((c) => c.name() === "forget")!;
    forget.action((opts: { player: string }) => {
      player = opts.player;
    });
    expect(() => program.parse(["node", "elix", "memory", "forget", "--player", "Ali"])).not.toThrow();
    expect(player).toBe("Ali");
  });

  it("rejects a missing --player with a readable message", () => {
    const r = parseForget(["forget"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--player");
  });
});

describe("A18 — the doctor description matches reality", () => {
  it("does not mention Java or Docker", async () => {
    const program = new Command();
    registerDoctor(program);
    const doctor = program.commands.find((c) => c.name() === "doctor")!;
    const desc = doctor.description();
    expect(desc.toLowerCase()).not.toContain("java");
    expect(desc.toLowerCase()).not.toContain("docker");
    expect(desc).toContain("26.2");
  });
});

describe("A18 — the username rule matches Minecraft's", () => {
  it("rejects names Minecraft would not accept", () => {
    const base = { version: 1 as const, profiles: {} };
    for (const bad of ["ab", "a".repeat(17), "has space", "dash-name", "emoji😀"]) {
      const r = elixConfigSchema.safeParse({ ...base, bot: { username: bad } });
      expect(r.success, `"${bad}" must be rejected`).toBe(false);
    }
  });

  it("accepts valid names", () => {
    const base = { version: 1 as const, profiles: {} };
    for (const good of ["Elix", "Bob_99", "abc", "A".repeat(16)]) {
      const r = elixConfigSchema.safeParse({ ...base, bot: { username: good } });
      expect(r.success, `"${good}" must be accepted`).toBe(true);
    }
  });
});

describe("A18 — data/overrides is trackable, the db is not", () => {
  it("ignores only the generated artefacts", async () => {
    const { readFile } = await import("node:fs/promises");
    const gitignore = await readFile(join(PROJECT_ROOT, ".gitignore"), "utf8");
    const lines = gitignore.split("\n").map((l) => l.trim());
    expect(lines).toContain("data/elix.db*");
    expect(lines).toContain("data/backups/");
    expect(lines).toContain("data/kb/");
    // Phase 8 commits data/overrides/26.2.json, so data/ must not be blanket-ignored.
    expect(lines).not.toContain("data/");
  });

  it("the data directory exists so overrides/ can be committed", async () => {
    const { stat } = await import("node:fs/promises");
    // A6: git cannot track an empty folder, so data/overrides/.gitkeep is
    // committed. Assert on that file, not on the directory, so a fresh clone
    // really is covered.
    const gitkeep = join(PROJECT_ROOT, "data", "overrides", ".gitkeep");
    const st = await stat(gitkeep).catch(() => null);
    expect(st, "data/overrides/.gitkeep must be committed").not.toBeNull();
    const stDir = await stat(join(PROJECT_ROOT, "data", "overrides"));
    expect(stDir.isDirectory()).toBe(true);
  });
});