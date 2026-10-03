#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { loadElixConfig, ConfigError, PROJECT_ROOT } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { exitCleanly } from "../core/exit.js";
import { bus } from "../core/events.js";
import { registerDoctor } from "./doctor.js";
import { registerStubs } from "./stubs.js";
import { registerStop } from "./stop.js";
import { registerDebug } from "./debug.js";
import { registerBrain } from "./brain.js";
import { registerMemoryCommands } from "./memory.js";

// Load .env before anything else so API keys are available from any folder (A5).
loadDotenv({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();

  program
    .name("elix")
    .description("Elix — an autonomous Minecraft companion that plays like a friend.")
    // Root version flag is -V/--elix-version so `elix start --version 26.2`
    // (target MC version) isn't intercepted by commander's built-in --version.
    .version("0.1.0", "-V, --elix-version");

  // Commands that need config load it up front so failures are clear.
  // `ask` and `usage` read the brain token/idle budgets, so they need it too —
  // they were missing here and died on `undefined.brain`.
  const configCommands = ["doctor", "start", "status", "ask", "usage"];
  program.hook("preAction", async (_program, actionCommand) => {
    if (!configCommands.includes(actionCommand.name())) return;
    try {
      // ELIX_CONFIG lets the runtime tests point at a bad config on purpose.
      const override = process.env["ELIX_CONFIG"];
      const config = await loadElixConfig(override);
      const log = createLogger(config);
      actionCommand.setOptionValue("elixConfig", config);
      actionCommand.setOptionValue("elixLogger", log);
      bus.emit("config:loaded", config);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Config error: ${err.message}`);
        exitCleanly(1);
        // Stop commander from running the action with an undefined config.
        throw new CommanderError(1, "config error", "elix");
      }
      throw err;
    }
  });

  registerDoctor(program);
  registerStubs(program);
  registerStop(program);
  registerBrain(program);
  registerMemoryCommands(program);
  registerDebug(program);

  await program.parseAsync(argv);
  return 0;
}

/**
 * Robust direct-run detection (A10).
 *
 * The old check compared `import.meta.url` against `file://${process.argv[1]}`,
 * which breaks on Windows (drive-letter case, backslashes, spaces) and made
 * `elix` silently do nothing. Comparing realpath on both sides, case-insensitively
 * on win32, is reliable.
 */
export function isDirectRun(argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(argv1);
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    return norm(selfPath) === norm(invokedPath);
  } catch {
    // argv[1] may be a loader/eval path that doesn't exist on disk.
    return false;
  }
}

export async function run(): Promise<void> {
  try {
    const code = await main();
    if (code !== 0) exitCleanly(code);
  } catch (err) {
    // A CommanderError is how we stop parsing deliberately (e.g. a config
    // error). Its exitCode is already the intended one.
    if (err instanceof CommanderError) {
      if (err.exitCode !== 0) exitCleanly(err.exitCode);
      return;
    }
    console.error(err instanceof Error ? err.message : err);
    exitCleanly(1);
  }
}

/**
 * Auto-run when this module IS the process entrypoint (i.e. `tsx src/cli/index.ts`
 * during development). The published binary uses bin.ts, which calls run()
 * unconditionally — bundling folds both into one file, so the guard has to
 * tolerate argv[1] pointing at the bundle rather than at index.ts.
 */
if (isDirectRun() && process.env["ELIX_NO_AUTORUN"] !== "1") {
  void run();
}