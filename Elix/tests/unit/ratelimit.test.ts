/**
 * B3 — rate-limit header parsing.
 *
 * Groq's reset headers are Go duration strings, not timestamps. Every format
 * below is taken from the docs or a real response, not invented.
 *
 * Source: https://console.groq.com/docs/rate-limits
 *   x-ratelimit-limit-requests      always RPD (requests per day)
 *   x-ratelimit-remaining-requests  always RPD
 *   x-ratelimit-reset-requests      duration, e.g. "2m59.56s"
 *   x-ratelimit-limit-tokens        always TPM (tokens per minute)
 *   x-ratelimit-remaining-tokens    always TPM
 *   x-ratelimit-reset-tokens        duration, e.g. "7.66s"
 *   retry-after                     seconds, only on 429
 */
import { describe, expect, it } from "vitest";
import {
  parseDurationSeconds,
  parseRateLimitHeaders,
  classifyLimitWindow,
  isCreditOrQuotaError,
} from "../../src/brain/ratelimit.js";

describe("B3 — parseDurationSeconds", () => {
  it("parses the exact formats Groq documents", () => {
    expect(parseDurationSeconds("2m59.56s")).toBeCloseTo(179.56, 2);
    expect(parseDurationSeconds("7.66s")).toBeCloseTo(7.66, 2);
  });

  it("parses compound durations", () => {
    expect(parseDurationSeconds("1h")).toBe(3600);
    expect(parseDurationSeconds("1h30m")).toBe(5400);
    expect(parseDurationSeconds("1h2m3.5s")).toBeCloseTo(3723.5, 1);
    expect(parseDurationSeconds("90s")).toBe(90);
  });

  it("parses sub-second units", () => {
    expect(parseDurationSeconds("500ms")).toBe(0.5);
    expect(parseDurationSeconds("250us")).toBe(0.00025);
    expect(parseDurationSeconds("250µs")).toBe(0.00025);
  });

  it("treats a bare number as seconds", () => {
    expect(parseDurationSeconds("2")).toBe(2);
    expect(parseDurationSeconds("2.5")).toBe(2.5);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseDurationSeconds("2M59.56S")).toBeCloseTo(179.56, 2);
    expect(parseDurationSeconds("  7.66s  ")).toBeCloseTo(7.66, 2);
  });

  it("returns undefined rather than guessing on nonsense", () => {
    expect(parseDurationSeconds("")).toBeUndefined();
    expect(parseDurationSeconds("soon")).toBeUndefined();
    expect(parseDurationSeconds(null)).toBeUndefined();
    expect(parseDurationSeconds(undefined)).toBeUndefined();
  });
});

describe("B3 — parseRateLimitHeaders", () => {
  it("reads a full Groq header set", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "14400",
      "x-ratelimit-remaining-requests": "14370",
      "x-ratelimit-reset-requests": "2m59.56s",
      "x-ratelimit-limit-tokens": "18000",
      "x-ratelimit-remaining-tokens": "17997",
      "x-ratelimit-reset-tokens": "7.66s",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      limitRequests: 14400,
      remainingRequests: 14370,
      resetRequestsSec: expect.closeTo(179.56, 2),
      limitTokens: 18000,
      remainingTokens: 17997,
      resetTokensSec: expect.closeTo(7.66, 2),
      retryAfterSec: undefined,
    });
  });

  it("reads retry-after on a 429", () => {
    const info = parseRateLimitHeaders(new Headers({ "retry-after": "2" }));
    expect(info.retryAfterSec).toBe(2);
  });

  it("returns an empty object when no rate-limit headers are present", () => {
    const info = parseRateLimitHeaders(new Headers({ "content-type": "application/json" }));
    expect(info.remainingTokens).toBeUndefined();
    expect(info.resetTokensSec).toBeUndefined();
  });

  it("tolerates a missing headers object", () => {
    expect(parseRateLimitHeaders(undefined)).toEqual({});
  });
});

describe("B3 — classifyLimitWindow", () => {
  const NOW = 1_700_000_000_000;

  it("treats a short retry-after as a per-minute limit", () => {
    const w = classifyLimitWindow("Rate limit reached", { retryAfterSec: 8 }, NOW);
    expect(w.kind).toBe("minute");
    expect(w.retryAt).toBe(NOW + 8000);
  });

  it("treats a long retry-after as a daily limit", () => {
    const w = classifyLimitWindow("Rate limit reached", { retryAfterSec: 40_000 }, NOW);
    expect(w.kind).toBe("day");
  });

  it("falls back to the next UTC midnight when the body says 'per day'", () => {
    const w = classifyLimitWindow(
      "Rate limit reached: 1000 requests per day exceeded",
      {},
      NOW,
    );
    expect(w.kind).toBe("day");
    const midnight = new Date(NOW);
    midnight.setUTCHours(24, 0, 0, 0);
    expect(w.retryAt).toBe(midnight.getTime());
  });

  it("recognises a daily quota without the exact phrase", () => {
    expect(classifyLimitWindow("You have exceeded your current quota", {}, NOW).kind).toBe("day");
    expect(classifyLimitWindow("daily allowance reached", {}, NOW).kind).toBe("day");
  });

  it("uses the token reset header for a per-minute limit", () => {
    const w = classifyLimitWindow("Rate limit reached", { resetTokensSec: 7.66 }, NOW);
    expect(w.kind).toBe("minute");
    expect(w.retryAt).toBe(NOW + 7660);
  });

  it("waits a conservative minute when nothing usable is present", () => {
    const w = classifyLimitWindow("", {}, NOW);
    expect(w.kind).toBe("unknown");
    expect(w.retryAt).toBe(NOW + 60_000);
  });
});

describe("B3 — isCreditOrQuotaError", () => {
  it("detects Hugging Face credit exhaustion", () => {
    expect(isCreditOrQuotaError("Insufficient credits to run this model")).toBe(true);
    expect(isCreditOrQuotaError("Your credits have run out")).toBe(true);
    expect(isCreditOrQuotaError("You have exceeded your current quota")).toBe(true);
    expect(isCreditOrQuotaError("Payment required")).toBe(true);
  });

  it("does not fire on an ordinary error", () => {
    expect(isCreditOrQuotaError("Model not found")).toBe(false);
    expect(isCreditOrQuotaError("")).toBe(false);
    expect(isCreditOrQuotaError("Invalid API key")).toBe(false);
  });
});
