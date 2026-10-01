import type { Command } from "commander";
import type { ElixConfig } from "../core/config.js";
import { runDoctor, renderDoctor, type CheckResult } from "../core/doctor.js";

/** `elix doctor` — environment + config health check. */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check Node, the 26.2 data, ffmpeg (voice only), provider API keys, and server reachability",
    )
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const results: CheckResult[] = await runDoctor({ config });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(renderDoctor(results));
      }
      // Set exitCode instead of calling process.exit(): an abrupt exit races
      // pino's transport worker, which on Windows can abort with
      // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" and turns a
      // successful doctor run into a crash (exit -1073740791).
      const fails = results.filter((r) => r.status === "fail").length;
      process.exitCode = fails > 0 ? 1 : 0;
    });
}
