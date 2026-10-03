import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { registerStubs } from "../../src/cli/stubs.js";
import { registerMemoryCommands } from "../../src/cli/memory.js";
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

  it("doctor lists all eight checks from another folder", async () => {
    const { stdout } = await runCli(["doctor", "--json"], tmp);
    const results = JSON.parse(stdout) as Array<{ name: string }>;
    expect(results.map((r) => r.name)).toEqual([
      "node",
      "version-data",
      "ffmpeg",
      "api-keys",
      "api-live",
      "hf-embeddings",
      "models",
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

/**
 * Run the built CLI with a .env at PROJECT_ROOT, then put the project back
 * exactly as it was.
 *
 * This used to write the fake key over PROJECT_ROOT/.env and then delete the
 * file. The cleanup flag was set unconditionally, so it ran even when a real
 * .env already existed - which means running the suite DESTROYED the keys on
 * the machine this was written on.
 */
async function withProjectEnv<T>(contents: string, fn: () => Promise<T>): Promise<T> {
  const envPath = join(PROJECT_ROOT, ".env");
  const backupPath = join(PROJECT_ROOT, ".env.test-backup");
  const original: Buffer | null = existsSync(envPath) ? readFileSync(envPath) : null;
  if (original) writeFileSync(backupPath, original);

  let result: T | undefined;
  let restoreError: Error | null = null;
  try {
    writeFileSync(envPath, contents, "utf8");
    // The fake key must be on disk for the WHOLE of `fn`. A first version
    // restored in the finally and ran the caller afterwards, so the child
    // process always read the original (or no) .env: the test passed on a
    // machine with real keys for entirely the wrong reason, and failed on a
    // clean clone.
    result = await fn();
  } finally {
    try {
      if (original) {
        // Restore, never delete: if the original were unreadable we would be
        // destroying real keys, so the backup is kept on disk instead.
        if (existsSync(envPath) && readFileSync(envPath).equals(original)) {
          rmSync(envPath);
          renameSync(backupPath, envPath);
        } else {
          writeFileSync(envPath, original);
          rmSync(backupPath, { force: true });
        }
      } else {
        rmSync(envPath, { force: true });
      }
    } catch (err) {
      // Recorded, never thrown from inside the finally: a throw there replaces
      // whatever error the test was already reporting, hiding the real failure.
      restoreError = err as Error;
      console.error(
        `[TEST] could not restore ${envPath} (${(err as Error).message}); ` +
          `the original is at ${backupPath}`,
      );
    }
  }
  if (restoreError) {
    throw new Error(`failed to restore ${envPath}: ${restoreError.message}`);
  }
  return result as T;
}

describe("A5 — .env is loaded from the project root, not the cwd", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "elix-dotenv-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds a key in a .env placed at PROJECT_ROOT even when run elsewhere", async () => {
    // Never touches the developer's real .env: withProjectEnv copies it aside and
    // puts it back byte-for-byte AFTER the CLI has run.
    const { stdout } = await withProjectEnv("GROQ_API_KEY=elix_cli_test_key\n", () =>
      runCli(["doctor", "--json"], tmp),
    );
    const results = JSON.parse(stdout) as Array<{ name: string; status: string; note: string }>;
    const keys = results.find((r) => r.name === "api-keys");
    // The fake key is present in the environment as far as doctor is concerned;
    // the live call then correctly reports FAIL.
    expect(keys?.status).toBe("ok");
    expect(keys?.note).toContain("Groq");
  });

  it("leaves an existing PROJECT_ROOT .env byte-for-byte intact", async () => {
    // The regression test for the destructive cleanup this replaced: running
    // the suite used to overwrite and then DELETE a real .env, which destroyed
    // the keys on the machine it was written on.
    const envPath = join(PROJECT_ROOT, ".env");
    const hadOne = existsSync(envPath);
    const before = hadOne ? readFileSync(envPath) : null;
    await withProjectEnv("GROQ_API_KEY=elix_cli_test_key\n", async () => {
      // While the fake is in place, the CLI must see the FAKE key. This is the
      // half that used to be missing, which let the test pass for the wrong
      // reason on a machine that had real keys.
      const { stdout } = await runCli(["doctor", "--json"], tmp);
      const results = JSON.parse(stdout) as Array<{ name: string; note: string }>;
      expect(results.find((r) => r.name === "api-keys")?.note).toContain("Groq");
    });
    if (hadOne && before) {
      expect(readFileSync(envPath).equals(before)).toBe(true);
    } else {
      // Nothing to protect: the fake must be gone again.
      expect(existsSync(envPath)).toBe(false);
    }
    // No backup left lying around either.
    expect(existsSync(join(PROJECT_ROOT, ".env.test-backup"))).toBe(false);
  });

  it("does not pick up a .env from the current folder", async () => {
    // The intent is "a .env in cwd is IGNORED", not "no keys exist". The old
    // assertion was `note` contains "no provider keys", which only held on a
    // machine with no PROJECT_ROOT/.env — and stopped holding the moment real
    // keys were present, for a reason that had nothing to do with cwd.
    //
    // So assert the thing that is actually true either way: the cwd key is never
    // the key that is found.
    const cwdKey = "cwd_only_key_9f3a2b1c8d";
    await writeFile(join(tmp, ".env"), `HF_TOKEN=${cwdKey}\n`, "utf8");
    const { stdout } = await runCli(["doctor", "--json"], tmp);
    expect(stdout, "the cwd key must never appear in doctor output").not.toContain(cwdKey);
    const results = JSON.parse(stdout) as Array<{ name: string; note: string; status: string }>;
    const keys = results.find((r) => r.name === "api-keys");
    // Whatever the project root has, the cwd file changed nothing.
    if (!existsSync(join(PROJECT_ROOT, ".env"))) {
      expect(keys?.note).toMatch(/no provider keys|no \.env file/);
      expect(keys?.status).toBe("warn");
    } else {
      expect(keys?.status).toBe("ok");
    }
  });

  it("names the exact fix when .env is missing (A5)", async () => {
    const { stdout } = await runCli(["doctor", "--json"], tmp);
    const results = JSON.parse(stdout) as Array<{ name: string; note: string }>;
    const keys = results.find((r) => r.name === "api-keys");
    if (!existsSync(join(PROJECT_ROOT, ".env"))) {
      // A new user gets told the command, not just the symptom.
      expect(keys?.note).toContain("copy .env.example .env");
    }
  });

  /**
   * A4: a key-shaped value planted in .env must never reach the CLI's output.
   *
   * A key was once recovered from a vitest log, because a test asserted on the
   * CONTENTS of .env and the failing assertion printed the value. This is the
   * runtime half of that fix: it puts a realistic-shaped secret into .env, runs
   * every command that reports on keys, and proves not one character of it comes
   * back out on stdout or stderr.
   *
   * The planted value is assembled from fragments so this test file does not
   * itself contain a match for the scanner in secrets.test.ts.
   */
  it("A4 — never prints a key-shaped value loaded from .env", async () => {
    const planted = `${["gs", "k_"].join("")}AQ${"z7R4mX2pL9wK6nT3vB8yF".repeat(3)}`;
    // Same shape as a real key, so any code path that echoes the value is caught
    // by the same regex a real leak would trip.
    expect(planted.length).toBeGreaterThan(40);

    const { stdout, stderr } = await withProjectEnv(`GROQ_API_KEY=${planted}\n`, async () => {
      // doctor is the command that reports on keys, and it has a --json form.
      const a = await runCli(["doctor", "--json"], tmp);
      const b = await runCli(["doctor"], tmp);
      const c = await runCli(["status"], tmp);
      return { ...a, stderr: a.stderr + b.stdout + b.stderr + c.stdout + c.stderr };
    });

    // The assertion below compares PRESENCE, never the value. That is the rule
    // this whole file now follows, and it is the rule that stops a failure here
    // from writing the secret into vitest's output directory.
    expect(stdout.includes(planted), "stdout must not echo a key").toBe(false);
    expect(stderr.includes(planted), "stderr must not echo a key").toBe(false);
    // A partial prefix is just as dangerous in a log, so check the head too.
    expect(stdout.includes(planted.slice(0, 20)), "stdout must not echo a key prefix").toBe(false);
    expect(stderr.includes(planted.slice(0, 20)), "stderr must not echo a key prefix").toBe(false);
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
  /**
   * `forget` lives in registerMemoryCommands (Phase 4, D8) rather than in the
   * Phase 1 stubs, so both registrars run here. Registering only the stubs would
   * silently test a CLI that has no forget command at all.
   */
  function buildProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerStubs(program);
    registerMemoryCommands(program);
    return program;
  }

  function parseForget(argv: string[]): { ok: boolean; error?: string; player?: string } {
    const program = buildProgram();
    let player: string | undefined;
    // Overriding the action is the point: it proves the option parsed without
    // ever opening the database.
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
    const program = buildProgram();
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

  it("registers memory search and stats exactly once each (D8)", () => {
    // Commander throws "cannot add command 'memory' as already have command
    // 'memory'" if the parent is created twice, which broke the whole CLI.
    const program = buildProgram();
    const memory = program.commands.filter((c) => c.name() === "memory");
    expect(memory).toHaveLength(1);
    const names = memory[0]!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["forget", "search", "stats"]);
    // The top-level alias exists alongside the subcommand.
    expect(program.commands.filter((c) => c.name() === "forget")).toHaveLength(1);
    // Both entry points accept --yes.
    expect(program.commands.find((c) => c.name() === "forget")!.options.map((o) => o.long)).toContain(
      "--yes",
    );
    expect(memory[0]!.commands.find((c) => c.name() === "forget")!.options.map((o) => o.long)).toContain(
      "--yes",
    );
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