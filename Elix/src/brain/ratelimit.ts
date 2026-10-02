/**
 * Rate-limit header parsing.
 *
 * Groq returns these on every chat completion response:
 *   x-ratelimit-limit-requests,      x-ratelimit-remaining-requests
 *   x-ratelimit-reset-requests,      x-ratelimit-limit-tokens
 *   x-ratelimit-remaining-tokens,    x-ratelimit-reset-tokens
 *
 * The reset values are durations, not timestamps: "2m59.56s", "7.66s", "1ms".
 * Everything here is pure so the parsing can be tested without a network.
 */

export interface RateLimitInfo {
  limitRequests?: number;
  remainingRequests?: number;
  /** Seconds until the request limit resets. */
  resetRequestsSec?: number;
  limitTokens?: number;
  remainingTokens?: number;
  /** Seconds until the token limit resets. */
  resetTokensSec?: number;
  /** Seconds from Retry-After, when present. */
  retryAfterSec?: number;
}

/**
 * Duration units, longest alternative FIRST.
 *
 * Order is load-bearing: regex alternation is first-match-wins, so with a
 * naive `h|m|ms|s` list, "500ms" matched the bare `m` and came back as 30000
 * seconds instead of 0.5 — a cooldown thirty thousand times too long.
 */
const DURATION_UNITS: ReadonlyArray<[RegExp, number]> = [
  [/^(?:hours|hrs|hr|h)$/, 3600],
  [/^(?:minutes|mins|min|m)$/, 60],
  [/^(?:milliseconds|millis|msec|ms)$/, 0.001],
  [/^(?:microseconds|micros|usec|us|µs)$/, 0.000001],
  [/^(?:seconds|secs|sec|s)$/, 1],
];

function unitSeconds(unit: string): number | undefined {
  for (const [re, factor] of DURATION_UNITS) {
    if (re.test(unit)) return factor;
  }
  return undefined;
}

/**
 * Parse a Go/Python-style duration as emitted by Groq's reset headers.
 *
 * Accepts combinations of h, m, s, ms, µs/us and bare numbers:
 *   "2m59.56s" -> 179.56
 *   "7.66s"    -> 7.66
 *   "1h"       -> 3600
 *   "500ms"    -> 0.5
 *
 * Returns undefined for anything unparseable, so a malformed header degrades to
 * "no reset information" rather than a wrong cooldown.
 */
export function parseDurationSeconds(input: string | null | undefined): number | undefined {
  if (input === null || input === undefined) return undefined;
  const text = String(input).trim().toLowerCase();
  if (text.length === 0) return undefined;

  // A bare number is seconds.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : undefined;
  }

  const re = /(-?\d+(?:\.\d+)?)\s*([a-zµ]+)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const factor = unitSeconds(m[2]!);
    if (factor === undefined) continue;
    matched = true;
    total += Number.parseFloat(m[1]!) * factor;
  }
  if (!matched) return undefined;
  return Number.isFinite(total) ? total : undefined;
}

/** Parse an integer header, tolerating values like "1234" or "1234.0". */
function parseCount(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number.parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Read the rate-limit headers off a Headers-like object. */
export function parseRateLimitHeaders(headers: Headers | undefined): RateLimitInfo {
  if (!headers) return {};
  const get = (n: string) => headers.get(n);
  return {
    limitRequests: parseCount(get("x-ratelimit-limit-requests")),
    remainingRequests: parseCount(get("x-ratelimit-remaining-requests")),
    resetRequestsSec: parseDurationSeconds(get("x-ratelimit-reset-requests")),
    limitTokens: parseCount(get("x-ratelimit-limit-tokens")),
    remainingTokens: parseCount(get("x-ratelimit-remaining-tokens")),
    resetTokensSec: parseDurationSeconds(get("x-ratelimit-reset-tokens")),
    retryAfterSec: parseDurationSeconds(get("retry-after")),
  };
}

/**
 * Is this a per-minute limit or a per-day one?
 *
 * Groq distinguishes them in the error body: a per-minute limit says
 * "Rate limit reached ... Please try again in 8.29s", while a per-day limit says
 * "requests per day" / "TPM" phrasing with a much larger reset, or the body
 * mentions a daily allowance.
 */
export interface LimitWindow {
  kind: "minute" | "day" | "unknown";
  /** Best guess at when to retry, epoch ms. */
  retryAt: number;
  reason: string;
}

export function classifyLimitWindow(
  body: string,
  info: RateLimitInfo,
  now: number,
): LimitWindow {
  const text = (body ?? "").toLowerCase();

  // Retry-After is authoritative when present.
  if (info.retryAfterSec !== undefined && info.retryAfterSec > 0) {
    return {
      kind: info.retryAfterSec >= 3600 ? "day" : "minute",
      retryAt: now + info.retryAfterSec * 1000,
      reason: `retry-after ${info.retryAfterSec}s`,
    };
  }

  // A token reset far in the future is a daily bucket.
  const tokenReset = info.resetTokensSec ?? info.resetRequestsSec;
  const mentionsDay =
    /\bper[ _-]?day\b/.test(text) ||
    /\bdaily\b/.test(text) ||
    /\bquota\b/.test(text) ||
    /\bcredits?\b/.test(text) ||
    /\bexceeded your current quota\b/.test(text);

  if (mentionsDay) {
    // Reset to the next UTC midnight, plus a small buffer.
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const fromHeader =
      tokenReset !== undefined ? now + tokenReset * 1000 : midnight.getTime();
    const retryAt = mentionsDay && tokenReset === undefined ? midnight.getTime() : fromHeader;
    return { kind: "day", retryAt, reason: "daily limit" };
  }

  if (tokenReset !== undefined) {
    return {
      kind: tokenReset >= 3600 ? "day" : "minute",
      retryAt: now + tokenReset * 1000,
      reason: `resets in ${tokenReset}s`,
    };
  }

  // Nothing usable: wait a conservative minute rather than hammering.
  return { kind: "unknown", retryAt: now + 60_000, reason: "no reset header" };
}

/** Hugging Face signals "out of credit" distinctly — it disables the provider. */
export function isCreditOrQuotaError(body: string): boolean {
  const text = (body ?? "").toLowerCase();
  return (
    // "insufficient credits", "credits exhausted", "credits have run out"
    (/\bcredits?\b/.test(text) &&
      /exceed|insufficient|exhaust|\brun out\b|\bno\b|empty|spent|depleted/.test(text)) ||
    // Word order varies: both "quota exceeded" and "exceeded your current quota".
    (/\bquota\b/.test(text) &&
      /exceed|exhaust|reached|\brun out\b|insufficient|no longer/.test(text)) ||
    /\bbilling\b/.test(text) ||
    /\bpayment required\b/.test(text) ||
    /\binsufficient (?:credits|quota|balance)\b/.test(text) ||
    /\b(?:can'?t|cannot) be run\b/.test(text)
  );
}