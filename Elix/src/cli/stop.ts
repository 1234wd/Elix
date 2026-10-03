/**
 * `elix stop` (A1).
 *
 * The second door into the same shutdown as Ctrl+C, for anything that is not a
 * human at a keyboard: scripts, tests, and agents that cannot send a console
 * control event. It connects to the local control channel `elix start` opens and
 * asks for a stop, then waits and reports the exit code that Elix actually used.
 *
 * It never opens a network port, so this is not a remote way to stop Elix.
 */
import type { Command } from "commander";
import { requestStop, controlPath, STOP_REQUEST_TIMEOUT_MS } from "../core/controlChannel.js";
import { PROJECT_ROOT } from "../core/config.js";
import { exitCleanly } from "../core/exit.js";

export function registerStop(program: Command): void {
  program
    .command("stop")
    .description("Ask a running Elix to shut down cleanly, and report its exit code")
    .option("--timeout <ms>", "how long to wait for the shutdown", (v) => Number.parseInt(v, 10))
    .action(async (opts: Record<string, unknown>) => {
      const path = controlPath(PROJECT_ROOT);
      const timeoutMs = (opts.timeout as number | undefined) ?? STOP_REQUEST_TIMEOUT_MS;
      console.log(`asking Elix to stop (control channel ${path})…`);

      const result = await requestStop(PROJECT_ROOT, { timeoutMs });

      if (result.ok) {
        console.log(`Elix stopped — exit code ${result.exitCode}`);
        exitCleanly(result.exitCode);
        return;
      }
      if (result.reason === "not-running") {
        console.log("Elix is not running");
        exitCleanly(1);
        return;
      }
      // The channel answered but the process never reported a code: it is stuck,
      // or it died mid-shutdown. Say so plainly rather than claiming success.
      console.error(
        `Elix accepted the stop request but never reported an exit code within ` +
          `${Math.round(timeoutMs / 1000)} s. It may still be shutting down.`,
      );
      exitCleanly(1);
    });
}
