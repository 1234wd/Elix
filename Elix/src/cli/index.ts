import { Command } from "commander";
import { loadElixConfig, ConfigError } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { bus } from "../core/events.js";
import { registerDoctor } from "./doctor.js";
import { registerStubs } from "./stubs.js";

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();

  program
    .name("elix")
    .description("Elix — an autonomous Minecraft companion that plays like a friend.")
    // Root version flag is -V/--elix-version so `elix start --version 26.2`
    // (target MC version) isn't intercepted by commander's built-in --version.
    .version("0.1.0", "-V, --elix-version");

  // Commands that need config load it up front so failures are clear.
  // preAction hook args: (program, actionCommand) — we want the action command.
  const configCommands = ["doctor", "start", "status"];
  program.hook("preAction", async (_program, actionCommand) => {
    if (!configCommands.includes(actionCommand.name())) return;
    try {
      const config = await loadElixConfig();
      actionCommand.setOptionValue("elixConfig", config);
      const log = createLogger(config);
      actionCommand.setOptionValue("elixLogger", log);
      bus.emit("config:loaded", config);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Config error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  });

  registerDoctor(program);
  registerStubs(program);

  await program.parseAsync(argv);
  return 0;
}

// Allow `node dist/cli/index.js` and tsx direct execution.
const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
