import type { Command } from "commander";
import type { ElixConfig } from "../core/config.js";
import { getActiveProfile } from "../core/config.js";
import { runBot } from "../connection/bot.js";
import { Lifecycle } from "../core/lifecycle.js";
import { exitCleanly } from "../core/exit.js";
import type { Logger } from "../core/logger.js";

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
      const log = cmd.optsWithGlobals().elixLogger as Logger;

      // All three flags are wired through (A10): --profile, --username, --version.
      const profile = getActiveProfile(config, {
        host: opts.host as string | undefined,
        port: opts.port as number | undefined,
        version: opts.version as string | undefined,
        username: opts.username as string | undefined,
        profile: opts.profile as string | undefined,
      });

      if (opts.username !== undefined && !/^[A-Za-z0-9_]{3,16}$/.test(profile.username)) {
        console.error(
          `username "${profile.username}" is not valid — Minecraft requires 3-16 characters from A-Z, a-z, 0-9 and _`,
        );
        exitCleanly(1);
        return;
      }

      // Vision rule 8: only join servers the user explicitly allowlisted.
      if (
        config.bot.serverAllowlist.length > 0 &&
        !config.bot.serverAllowlist.includes(profile.host)
      ) {
        console.error(
          `server ${profile.host} is not in the allowlist — add it to config/elix.yaml bot.serverAllowlist`,
        );
        exitCleanly(1);
        return;
      }

      const lifecycle = new Lifecycle(log);
      // Signal handlers go up before connecting, so Ctrl+C during ping/login is clean (A15).
      lifecycle.handleSignals();

      try {
        // runBot registers its own cleanup synchronously (before the first await
        // of the network work), so a Ctrl+C during ping still unwinds properly.
        await runBot({ config, profile, log, registerCleanup: (fn) => void lifecycle.onCleanup(fn) });
      } catch (err) {
        log.error({ err: (err as Error).message }, "failed to start");
        exitCleanly(1);
      }
    });

  program
    .command("status")
    .description("Show current config summary")
    .action((_opts: unknown, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const profile = getActiveProfile(config);
      console.log("Elix status");
      console.log(`  username:       ${config.bot.username}`);
      // A4: print the version actually resolved for THIS profile, not bot.version.
      console.log(`  target version: ${profile.version}`);
      console.log(`  profile:        ${profile.name} (${profile.host}:${profile.port})`);
      console.log(`  voice:          ${config.voice.enabled ? "on" : "off (text-only)"}`);
      console.log(`  content level:  ${config.safety.contentLevel}`);
      console.log(`  chat rate:      ${config.safety.chatRateLimitPer2s} per 2s`);
      console.log(`  data dir:       ${config.dataDir}`);
      console.log(`  log level:      ${config.logLevel}`);
    });

  program.command("usage").description("Show today's LLM calls per provider").action(phaseStub(3, "Usage tracking"));

  const memory = program.command("memory").description("Search and manage memory");
  memory
    .command("search")
    .argument("<query>", "what to look for")
    .description("Search remembered episodes and facts")
    .action(phaseStub(4, "Memory search"));
  // A10: `.command("forget --player <name>")` made commander reject `--player`.
  // `requiredOption` is the correct form.
  memory
    .command("forget")
    .requiredOption("--player <name>", "player whose data to delete")
    .description("Delete a player's data on request")
    .action((opts: { player: string }) => phaseStub(4, `Player data deletion for ${opts.player}`)());

  // The vision's CLI is `elix forget --player <name>` — keep a top-level alias.
  program
    .command("forget")
    .requiredOption("--player <name>", "player whose data to delete")
    .description("Delete a player's data on request (alias for `elix memory forget`)")
    .action((opts: { player: string }) => phaseStub(4, `Player data deletion for ${opts.player}`)());

  const kb = program.command("kb").description("Minecraft knowledge base");
  kb.command("build")
    .description("Build the offline wiki knowledge base")
    .action(phaseStub(8, "Knowledge base build"));
}