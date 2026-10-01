/**
 * Reconnect logic with exponential backoff and kick-reason classification.
 *
 * Pure functions — no mineflayer, no I/O — so they're fully unit-testable.
 * The bot wrapper (bot.ts) calls these to decide whether and when to retry.
 */

/** Backoff schedule: 5s → 10s → 30s → 60s (max). */
export const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 30_000, 60_000] as const;

export type DisconnectKind =
  | "network"
  | "kick"
  | "ban"
  | "whitelist"
  | "online_mode"
  | "captcha"
  | "other";

export interface DisconnectInfo {
  kind: DisconnectKind;
  reason: string;
  shouldRetry: boolean;
  retryAfterMs: number;
}

/** Minecraft translate keys that indicate permanent disconnection. */
const PERMANENT_TRANSLATE_KEYS: Array<[string, DisconnectKind]> = [
  ["multiplayer.disconnect.not_whitelisted", "whitelist"],
  ["multiplayer.disconnect.banned", "ban"],
  ["multiplayer.disconnect.banned.reason", "ban"],
  ["multiplayer.disconnect.banned.expiration", "ban"],
  ["multiplayer.disconnect.banned_ip", "ban"],
  ["multiplayer.disconnect.banned_ip.reason", "ban"],
  ["multiplayer.disconnect.banned_ip.expiration", "ban"],
  ["multiplayer.disconnect.online_mode", "online_mode"],
  ["multiplayer.disconnect.not_allowed", "other"],
];

/** Whole-word regex patterns for text-based kick reasons. */
const BAN_PATTERNS = [/\bbanned\b/, /\bban\b(?!ned\s+from\s+being\s+over)/];
const WHITELIST_PATTERNS = [/\bnot\s+whitelisted\b/, /\bwhitelist\b/, /\bwhite-list\b/];
const ONLINE_MODE_PATTERNS = [
  /\bonline[ -]?mode\b/,
  /\bfailed\s+to\s+verify\s+username\b/,
  /\bencryption\s+request\b/,
];
const CAPTCHA_PATTERNS = [/\bcaptcha\b/, /\banti[ -]?bot\b/, /\bbot\s+check\b/];
const NETWORK_PATTERNS = [
  /\btimeout\b/,
  /\btimed\s+out\b/,
  /\bconnection\s+reset\b/,
  /\bconnection\s+closed\b/,
  /\beconnreset\b/,
  /\beconnrefused\b/,
  /\bsocket\s+hang\s+up\b/,
  /\bnetwork\b/,
];

/**
 * Parse a kick/disconnect reason into a plain string.
 * Handles JSON chat components, translate keys, and plain text.
 */
export function parseKickReason(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.translate === "string") return obj.translate;
    if (Array.isArray(obj.extra)) {
      return obj.extra
        .map((e) =>
          e && typeof e === "object" && typeof (e as Record<string, unknown>).text === "string"
            ? ((e as Record<string, unknown>).text as string)
            : "",
        )
        .join("");
    }
    if (typeof obj.reason === "string") return obj.reason;
  }
  return String(raw);
}

/**
 * Classify a kick/disconnect reason and decide whether to retry.
 *
 * Order: JSON translate keys first (permanent), then whole-word regex.
 * Ban, whitelist, online-mode and captcha are permanent — stop immediately.
 */
export function classifyDisconnect(reason: string, attempt: number): DisconnectInfo {
  const lower = reason.toLowerCase();

  // 1. Check Minecraft translate keys first (JSON-string reasons)
  for (const [key, kind] of PERMANENT_TRANSLATE_KEYS) {
    if (lower.includes(key)) {
      return { kind, reason, shouldRetry: false, retryAfterMs: 0 };
    }
  }

  // 2. Whole-word regex patterns
  if (BAN_PATTERNS.some((p) => p.test(lower))) {
    return { kind: "ban", reason, shouldRetry: false, retryAfterMs: 0 };
  }
  if (WHITELIST_PATTERNS.some((p) => p.test(lower))) {
    return { kind: "whitelist", reason, shouldRetry: false, retryAfterMs: 0 };
  }
  if (ONLINE_MODE_PATTERNS.some((p) => p.test(lower))) {
    return { kind: "online_mode", reason, shouldRetry: false, retryAfterMs: 0 };
  }
  if (CAPTCHA_PATTERNS.some((p) => p.test(lower))) {
    return { kind: "captcha", reason, shouldRetry: false, retryAfterMs: 0 };
  }
  if (NETWORK_PATTERNS.some((p) => p.test(lower))) {
    const retryAfterMs = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]!;
    return { kind: "network", reason, shouldRetry: true, retryAfterMs };
  }

  // 3. Generic kick — retry with backoff
  const retryAfterMs = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]!;
  return { kind: "kick", reason, shouldRetry: true, retryAfterMs };
}
