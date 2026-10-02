import type { Command } from "commander";
import { loadModelsConfig, PROJECT_ROOT } from "../core/config.js";
import { buildBrain } from "../brain/index.js";
import { PERSONA_LITE, buildChatMessages, loadPersonaLite } from "../brain/persona.js";
import { checkInputSafety } from "../brain/fallback.js";
import type { Logger } from "../core/logger.js";

/**
 * Phase 3 CLI surface: `elix ask` and `elix usage` (B9).
 *
 * `elix ask` sends one fast-role call through the full router and prints the
 * reply, the model used, the latency and the token counts. It exists so the
 * brain can be exercised without being in game.
 */
export function registerBrain(program: Command): void {
  program
    .command("ask")
    .description("Send one message to Elix's brain and print the reply")
    .argument("<text>", "what to ask")
    .option("--role <role>", "model role to use", "fast")
    .option("--json", "machine-readable output")
    .action(async (text: string, opts: { role?: string; json?: boolean }, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig;
      const log = cmd.optsWithGlobals().elixLogger as Logger | undefined;
      const models = await loadModelsConfig();

      const safety = checkInputSafety(text);
      if (!safety.safe) {
        // Never forward a suspected injection attempt to a provider.
        console.log("that one's off-limits, i can't help with that one");
        process.exitCode = 0;
        return;
      }

      const brain = buildBrain({
        models,
        projectRoot: PROJECT_ROOT,
        fastMaxTokens: config.brain.fastMaxTokens,
        smartMaxTokens: config.brain.smartMaxTokens,
        idleChatterBudgetPerHour: config.brain.idleChatterBudgetPerHour,
      });

      try {
        const persona = loadPersonaLite(PROJECT_ROOT);
        const result = await brain.router.complete({
          messages: buildChatMessages("Ali", text, persona),
          role: opts.role === "smart" ? "smart" : "fast",
          maxTokens: 200,
          source: "elix-ask",
          bypassIdleBudget: true,
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                reply: result.text,
                provider: result.provider,
                model: result.model,
                latencyMs: result.latencyMs,
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
                reasoningTokens: result.reasoningTokens,
                fromFallback: result.fromFallback,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(result.text);
        console.log("");
        console.log(
          `  ${result.provider}/${result.model}  ${result.latencyMs}ms  ` +
            `tokens in ${result.tokensIn} out ${result.tokensOut}` +
            (result.reasoningTokens > 0 ? ` (reasoning ${result.reasoningTokens})` : "") +
            (result.fromFallback ? "  [scripted fallback]" : ""),
        );
      } finally {
        brain.close();
        void log;
        void PERSONA_LITE;
      }
    });

  program
    .command("usage")
    .description("Show today's LLM calls per provider and model")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig;
      const models = await loadModelsConfig();
      const brain = buildBrain({
        models,
        projectRoot: PROJECT_ROOT,
        fastMaxTokens: config.brain.fastMaxTokens,
        smartMaxTokens: config.brain.smartMaxTokens,
      });

      try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const rows = brain.store.usageSince(startOfDay.getTime());

        const byModel = new Map<string, { calls: number; inTok: number; outTok: number; reasoning: number; latency: number }>();
        for (const r of rows) {
          const key = `${r.provider}/${r.model}`;
          const cur = byModel.get(key) ?? { calls: 0, inTok: 0, outTok: 0, reasoning: 0, latency: 0 };
          cur.calls += 1;
          cur.inTok += r.tokensIn;
          cur.outTok += r.tokensOut;
          cur.reasoning += r.reasoningTokens;
          cur.latency += r.latencyMs;
          byModel.set(key, cur);
        }

        const cooldowns = brain.router.activeCooldowns();
        const disabled = brain.router.disabledProviders();

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                since: startOfDay.toISOString(),
                models: Object.fromEntries(byModel),
                cooldowns,
                disabled,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log("Elix usage — today");
        if (byModel.size === 0) {
          console.log("  (no calls yet)");
        }
        for (const [key, v] of [...byModel.entries()].sort()) {
          console.log(
            `  ${key.padEnd(38)} ${String(v.calls).padStart(4)} calls  ` +
              `in ${v.inTok}  out ${v.outTok}` +
              (v.reasoning > 0 ? `  reasoning ${v.reasoning}` : "") +
              `  avg ${Math.round(v.latency / v.calls)}ms`,
          );
        }

        if (disabled.length > 0) {
          console.log("");
          console.log("  disabled:");
          for (const d of disabled) {
            console.log(`    ${d.provider} — ${d.reason}, until ${new Date(d.until).toISOString()}`);
          }
        }
        if (cooldowns.length > 0) {
          console.log("");
          console.log("  cooldowns:");
          for (const c of cooldowns) {
            const secs = Math.max(0, Math.round((c.until - Date.now()) / 1000));
            console.log(`    ${c.provider}/${c.model} — ${c.reason}, ${secs}s left`);
          }
        }
      } finally {
        brain.close();
      }
    });
}