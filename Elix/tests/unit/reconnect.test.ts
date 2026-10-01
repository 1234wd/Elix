import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyDisconnect,
  parseKickReason,
  BACKOFF_SCHEDULE_MS,
  type DisconnectKind,
} from "../../src/connection/reconnect.js";
import { ReconnectScheduler } from "../../src/connection/scheduler.js";
import { describeReason } from "../../src/connection/kickReason.js";

describe("classifyDisconnect", () => {
  it("classifies ban as permanent", () => {
    const r = classifyDisconnect("You are banned from this server!", 0);
    expect(r.kind).toBe("ban");
    expect(r.shouldRetry).toBe(false);
    expect(r.retryAfterMs).toBe(0);
  });

  it("classifies whitelist as permanent", () => {
    const r = classifyDisconnect("You are not whitelisted on this server!", 0);
    expect(r.kind).toBe("whitelist");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies online-mode as permanent", () => {
    const r = classifyDisconnect("Failed to verify username!", 0);
    expect(r.kind).toBe("online_mode");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies captcha as permanent", () => {
    const r = classifyDisconnect("Please complete the captcha to continue", 0);
    expect(r.kind).toBe("captcha");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies network timeout as retryable", () => {
    const r = classifyDisconnect("Connection timed out", 0);
    expect(r.kind).toBe("network");
    expect(r.shouldRetry).toBe(true);
    expect(r.retryAfterMs).toBe(BACKOFF_SCHEDULE_MS[0]);
  });

  it("classifies generic kick as retryable", () => {
    const r = classifyDisconnect("Kicked by an operator", 0);
    expect(r.kind).toBe("kick");
    expect(r.shouldRetry).toBe(true);
  });

  it("applies exponential backoff", () => {
    expect(classifyDisconnect("timeout", 0).retryAfterMs).toBe(5_000);
    expect(classifyDisconnect("timeout", 1).retryAfterMs).toBe(10_000);
    expect(classifyDisconnect("timeout", 2).retryAfterMs).toBe(30_000);
    expect(classifyDisconnect("timeout", 3).retryAfterMs).toBe(60_000);
    expect(classifyDisconnect("timeout", 4).retryAfterMs).toBe(60_000);
    expect(classifyDisconnect("timeout", 10).retryAfterMs).toBe(60_000);
  });
});

describe("classifyDisconnect — translate keys", () => {
  const permanentKeys: Array<[string, DisconnectKind]> = [
    ["multiplayer.disconnect.not_whitelisted", "whitelist"],
    ["multiplayer.disconnect.banned", "ban"],
    ["multiplayer.disconnect.banned.reason", "ban"],
    ["multiplayer.disconnect.banned.expiration", "ban"],
    ["multiplayer.disconnect.banned_ip", "ban"],
    ["multiplayer.disconnect.online_mode", "online_mode"],
  ];

  for (const [key, kind] of permanentKeys) {
    it(`classifies ${key} as permanent ${kind}`, () => {
      const r = classifyDisconnect(`{"translate":"${key}"}`, 0);
      expect(r.kind).toBe(kind);
      expect(r.shouldRetry).toBe(false);
    });
  }
});

describe("A2 — vanilla's hyphenated 'white-listed' text", () => {
  // The old pattern /\bwhite-list\b/ did not match "white-listed", so a real
  // vanilla whitelist kick was classified as a generic retryable kick.
  it("matches 'You are not white-listed on this server!'", () => {
    const r = classifyDisconnect("You are not white-listed on this server!", 0);
    expect(r.kind).toBe("whitelist");
    expect(r.shouldRetry).toBe(false);
  });

  it("matches the hyphenated and unhyphenated spellings", () => {
    expect(classifyDisconnect("You are not whitelisted here", 0).kind).toBe("whitelist");
    expect(classifyDisconnect("You are not white listed here", 0).kind).toBe("whitelist");
    expect(classifyDisconnect("You are not white-listed here", 0).kind).toBe("whitelist");
  });

  it("does not misfire on unrelated words containing 'ban'", () => {
    expect(classifyDisconnect("urban exploration server", 0).kind).not.toBe("ban");
  });
});

describe("classifyDisconnect — retryable network reasons", () => {
  it("does NOT classify a connection-reset message as ban", () => {
    const r = classifyDisconnect(
      "Internal Exception: io.netty.handler.codec.DecoderError: java.io.IOException: An existing connection was forcibly closed by the remote host",
      0,
    );
    expect(r.kind).not.toBe("ban");
    expect(r.shouldRetry).toBe(true);
  });

  it("does NOT classify 'bandwidth exceeded' as ban", () => {
    const r = classifyDisconnect("bandwidth exceeded", 0);
    expect(r.kind).not.toBe("ban");
    expect(r.shouldRetry).toBe(true);
  });

  it("treats a bare socketClosed as a retryable network drop", () => {
    // This is what minecraft-protocol emits after a kick when there is no
    // stored kick reason — the reason A1 exists.
    const r = classifyDisconnect("socketClosed", 0);
    expect(r.shouldRetry).toBe(true);
    expect(r.retryAfterMs).toBe(5_000);
  });
});

describe("ReconnectScheduler — one kick = exactly one reconnect", () => {
  let scheduler: ReconnectScheduler;
  let reconnectFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scheduler = new ReconnectScheduler();
    reconnectFn = vi.fn();
  });

  afterEach(() => {
    scheduler.cancel();
  });

  it("schedules exactly one reconnect for one retryable disconnect", () => {
    const result = scheduler.scheduleReconnect(true, 5000, reconnectFn);
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(1);
    expect(result!.delayMs).toBe(5000);
    expect(reconnectFn).not.toHaveBeenCalled(); // not yet — timer hasn't fired
    expect(scheduler.pending).toBe(true);
  });

  it("does NOT schedule a reconnect for permanent disconnects", () => {
    const result = scheduler.scheduleReconnect(false, 0, reconnectFn);
    expect(result).toBeNull();
    expect(reconnectFn).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(false);
  });

  it("refuses a second reconnect while one is pending", () => {
    const first = scheduler.scheduleReconnect(true, 5000, reconnectFn);
    expect(first).not.toBeNull();
    // Second call while the first is still pending must be refused, otherwise
    // one kick produces two reconnects.
    const second = scheduler.scheduleReconnect(true, 5000, reconnectFn);
    expect(second).toBeNull();
    expect(scheduler.currentAttempt).toBe(1);
  });

  it("cancel prevents the reconnect from firing", () => {
    vi.useFakeTimers();
    try {
      scheduler.scheduleReconnect(true, 5000, reconnectFn);
      scheduler.cancel();
      vi.advanceTimersByTime(10_000);
      expect(reconnectFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires the reconnect after the delay", () => {
    vi.useFakeTimers();
    try {
      scheduler.scheduleReconnect(true, 5000, reconnectFn);
      vi.advanceTimersByTime(5000);
      expect(reconnectFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a new reconnect once the previous one has fired", () => {
    vi.useFakeTimers();
    try {
      scheduler.scheduleReconnect(true, 5000, reconnectFn);
      vi.advanceTimersByTime(5000);
      expect(scheduler.pending).toBe(false);
      const second = scheduler.scheduleReconnect(true, 5000, reconnectFn);
      expect(second).not.toBeNull();
      expect(second!.attempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() clears the attempt count without cancelling a pending timer", () => {
    vi.useFakeTimers();
    try {
      scheduler.scheduleReconnect(true, 5000, reconnectFn);
      scheduler.scheduleReconnect(true, 5000, reconnectFn); // refused
      expect(scheduler.currentAttempt).toBe(1);
      scheduler.reset();
      expect(scheduler.currentAttempt).toBe(0);
      expect(scheduler.pending).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(reconnectFn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("full flow: kick → end → one reconnect scheduled", () => {
    const info = classifyDisconnect("Kicked by an operator", 0);
    expect(info.shouldRetry).toBe(true);
    const result = scheduler.scheduleReconnect(info.shouldRetry, info.retryAfterMs, reconnectFn);
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(1);
    expect(scheduler.currentAttempt).toBe(1);
  });
});

describe("parseKickReason", () => {
  it("handles plain string", () => {
    expect(parseKickReason("You are banned!")).toBe("You are banned!");
  });

  it("handles JSON chat component with text", () => {
    expect(parseKickReason({ text: "You are banned!" })).toBe("You are banned!");
  });

  it("handles JSON chat component with translate key", () => {
    expect(parseKickReason({ translate: "multiplayer.disconnect.not_whitelisted" })).toBe(
      "multiplayer.disconnect.not_whitelisted",
    );
  });

  it("handles JSON chat component with extra array", () => {
    expect(parseKickReason({ extra: [{ text: "You are " }, { text: "banned!" }] })).toBe(
      "You are banned!",
    );
  });

  it("handles reason field", () => {
    expect(parseKickReason({ reason: "Failed to verify username" })).toBe(
      "Failed to verify username",
    );
  });

  it("handles null/undefined gracefully", () => {
    expect(parseKickReason(null)).toBe("null");
    expect(parseKickReason(undefined)).toBe("undefined");
  });
});

describe("A1 — the real kick reason must win over the end reason", () => {
  /** Exactly what bot.ts does: stash on kicked, read + clear on end. */
  function simulate(reason: unknown, endReason = "socketClosed"): DisconnectKind {
    let lastKick: string | undefined;
    const described = describeReason(reason);
    lastKick = described.translateKey ?? described.text;
    const used = lastKick ?? describeReason(endReason).text;
    const info = classifyDisconnect(used, 0);
    lastKick = undefined;
    return info.kind;
  }

  it("classifies a whitelist kick, not the socketClosed fallback", () => {
    expect(simulate('{"translate":"multiplayer.disconnect.not_whitelisted"}')).toBe("whitelist");
  });

  it("classifies a ban kick, not the socketClosed fallback", () => {
    expect(
      simulate({ type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.banned" } } }),
    ).toBe("ban");
  });

  it("still retries a generic operator kick", () => {
    expect(
      simulate({ type: "compound", value: { text: { type: "string", value: "Kicked by an operator" } } }),
    ).toBe("kick");
  });
});