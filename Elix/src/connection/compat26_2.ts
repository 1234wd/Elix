/**
 * Compatibility shim for 26.2 — runs before createBot.
 *
 * prismarine-physics has its own features.json that doesn't include 26.2.
 * This shim patches the in-memory features list so 26.2 is recognized.
 * No node_modules hand-edits; this is a runtime patch.
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export function applyCompat26_2(): void {
  try {
    // Use realpath to resolve through pnpm symlinks
    const mineflayerPath = realpathSync(join(process.cwd(), "node_modules", "mineflayer"));
    const req = createRequire(mineflayerPath);
    const featuresPath = req.resolve("prismarine-physics/lib/features.json");
    const features = req(featuresPath) as Array<{ name: string; versions: string[] }>;
    for (const f of features) {
      if (f.name === "proportionalLiquidGravity" && !f.versions.includes("26.2")) {
        f.versions.push("26.2");
      }
      if (f.name === "independentLiquidGravity" && !f.versions.includes("26.2")) {
        f.versions.push("26.2");
      }
    }
  } catch {
    // prismarine-physics not resolvable — will be retried on next import
  }
}
