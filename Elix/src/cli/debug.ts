import type { Command } from "commander";
import { describeReason } from "../connection/kickReason.js";
import { classifyDisconnect } from "../connection/reconnect.js";

/**
 * `elix debug kick-reason <json>` — classify a raw disconnect reason.
 *
 * This exists so the kick-reason pipeline can be tested against the *built*
 * bundle from a real node process. Unit tests run inside vitest, which injects
 * its own `require`; that hides the `"type": "module"` ReferenceError and the
 * esbuild `__require` rewrite that both break NBT parsing in production.
 *
 * Not part of the user-facing CLI surface; it is a diagnostic.
 */
export function registerDebug(program: Command): void {
  const debug = program
    .command("debug")
    .description("Internal diagnostics (not part of the normal CLI)")
    .allowUnknownOption(false);

  debug
    .command("kick-reason")
    .argument("<raw>", "raw disconnect reason: a JSON string or an NBT/chat object as JSON")
    .description("Classify a raw disconnect reason the way bot.ts does")
    .action((raw: string) => {
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A plain string like "Kicked by an operator" — pass it through.
      }

      const described = describeReason(parsed);
      const info = classifyDisconnect(described.translateKey ?? described.text, 0);

      console.log(
        JSON.stringify(
          {
            text: described.text,
            translateKey: described.translateKey ?? null,
            kind: info.kind,
            shouldRetry: info.shouldRetry,
            retryAfterMs: info.retryAfterMs,
          },
          null,
          2,
        ),
      );
    });
}