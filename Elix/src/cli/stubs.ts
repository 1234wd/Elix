import type { Command } from "commander";
import type { ElixConfig } from "../core/config.js";
import { getActiveProfile } from "../core/config.js";
import { runBot } from "../connection/bot.js";
import { Lifecycle } from "../core/lifecycle.js";

/**
 * Phase-2 start command — connects Elix to the server.
 * Later phases add the brain, memory, social, etc.
 */

function phaseStub(phase: number, feature: string) {
  return () => {
    console.log(`${feature} lands in phase ${phase}.`);
    console.log("See README.md for the build plan. Nothing is faked here.");
  };
}

export function registerStubs(program: Command): void {
  program
    .command("setup")
    .description("First-run wizard: keys, username, server, voice, models")
    .action(phaseStub(5, "The setup wizard"));

  program
    .command("start")
    .description("Connect Elix to a server and start playing")
    .option("--host <host>", "server host")
    .option("--port <port>", "server port", (v) => Number.parseInt(v, 10))
    .option("--username <name>", "in-game username")
    .option("--version <ver>", "target server version (e.g. 26.2)")
    .option("--profile <name>", "saved server profile")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const log = cmd.optsWithGlobals().elixLogger as import("../core/logger.js").Logger;
      const profile = getActiveProfile(config, {
        host: opts.host as string | undefined,
        port: opts.port as number | undefined,
        version: opts.version as string | undefined,
      });

      // Check allowlist
      if (
        config.bot.serverAllowlist.length > 0 &&
        !config.bot.serverAllowlist.includes(profile.host)
      ) {
        console.error(
          `server ${profile.host} is not in the allowlist — add it to config/elix.yaml bot.serverAllowlist`,
        );
        process.exit(1);
      }

      const lifecycle = new Lifecycle(log);
      lifecycle.handleSignals();

      // Run the bot — register its shutdown as an awaited Lifecycle cleanup
      try {
        const botCleanup = await runBot({ config, profile, log });
        lifecycle.onCleanup(botCleanup);
      } catch (err) {
        log.error({ err }, "failed to start");
        process.exit(1);
      }
    });

  program
    .command("status")
    .description("Show current config summary")
    .action((_opts: unknown, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const profile = getActiveProfile(config);
      console.log("Elix status");
      console.log(`  username:      ${config.bot.username}`);
      console.log(`  target version: ${config.bot.version}`);
      console.log(`  profile:       ${profile.name} (${profile.host}:${profile.port})`);
      console.log(`  voice:         ${config.voice.enabled ? "on" : "off (text-only)"}`);
      console.log(`  content level: ${config.safety.contentLevel}`);
      console.log(`  data dir:      ${config.dataDir}`);
      console.log(`  log level:     ${config.logLevel}`);
    });

  const usage = program.command("usage").description("Show today's LLM calls per provider");
  usage.action(phaseStub(3, "Usage tracking"));

  const memory = program.command("memory").description("Search and manage memory");
  memory
    .command("search <query>")
    .description("Search remembered episodes and facts")
    .action(phaseStub(4, "Memory search"));
  memory
    .command("forget --player <name>")
    .description("Delete a player's data on request")
    .action(phaseStub(4, "Player data deletion"));

  const kb = program.command("kb").description("Minecraft knowledge base");
  kb.command("build").description("Build the offline wiki knowledge base").action(
    phaseStub(8, "Knowledge base build"),
  );
}
