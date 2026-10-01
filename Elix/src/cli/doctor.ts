import type { Command } from "commander";
import type { ElixConfig } from "../core/config.js";
import { runDoctor, renderDoctor, type CheckResult } from "../core/doctor.js";

/** `elix doctor` — environment + config health check. */
export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check Node, Java, ffmpeg, Docker, API keys, and server reachability")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const results: CheckResult[] = await runDoctor({ config });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(renderDoctor(results));
      }
      const fails = results.filter((r) => r.status === "fail").length;
      process.exit(fails > 0 ? 1 : 0);
    });
}
