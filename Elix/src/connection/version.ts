/**
 * Version adapter — the single source of truth for the target MC version.
 *
 * Precedence: CLI flag > profile > bot config. Switching to 26.3 is one line
 * in config/elix.yaml (bot.version) or the profile, with no code change.
 *
 * `expectedProtocol` reads minecraft-data so the protocol number is never
 * hard-coded anywhere in Elix's source.
 */
import { createRequire } from "node:module";
import type { ElixConfig, ServerProfile } from "../core/config.js";

const require = createRequire(import.meta.url);

/** Shape of the vendored minecraft-data wrapper we actually use. */
interface McData {
  version: { version: number; minecraftVersion: string; majorVersion: string };
}

/**
 * Resolve the target version: CLI > profile > bot config.
 */
export function resolveTargetVersion(
  config: ElixConfig,
  profile: Pick<ServerProfile, "version">,
  cliVersion?: string,
): string {
  return cliVersion?.trim() || profile.version || config.bot.version;
}

/**
 * Get the expected protocol number for a version, read from minecraft-data.
 * Returns 0 when the version has no data (caller must warn, not crash).
 */
export function expectedProtocol(version: string): number {
  try {
    const mcData = require("minecraft-data") as (v: string) => McData;
    return mcData(version)?.version?.version ?? 0;
  } catch {
    return 0;
  }
}

/** True when minecraft-data has data for this version (so we can join it). */
export function hasDataFor(version: string): boolean {
  try {
    const mcData = require("minecraft-data") as (v: string) => McData;
    return !!mcData(version)?.version?.version;
  } catch {
    return false;
  }
}