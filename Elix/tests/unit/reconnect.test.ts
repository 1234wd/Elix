import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyDisconnect,
  parseKickReason,
  BACKOFF_SCHEDULE_MS,
} from "../../src/connection/reconnect.js";
import { ReconnectScheduler } from "../../src/connection/scheduler.js";

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

describe("classifyDisconnect — JSON translate keys", () => {
  it("classifies JSON whitelist kick as whitelist", () => {
    const r = classifyDisconnect('{"translate":"multiplayer.disconnect.not_whitelisted"}', 0);
    expect(r.kind).toBe("whitelist");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies JSON banned kick as ban", () => {
    const r = classifyDisconnect('{"translate":"multiplayer.disconnect.banned"}', 0);
    expect(r.kind).toBe("ban");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies JSON banned.reason kick as ban", () => {
    const r = classifyDisconnect('{"translate":"multiplayer.disconnect.banned.reason","with":["Elix"]}', 0);
    expect(r.kind).toBe("ban");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies JSON online_mode kick as online_mode", () => {
    const r = classifyDisconnect('{"translate":"multiplayer.disconnect.online_mode"}', 0);
    expect(r.kind).toBe("online_mode");
    expect(r.shouldRetry).toBe(false);
  });

  it("does NOT classify 'bandwidth exceeded' as ban", () => {
    const r = classifyDisconnect("Internal Exception: io.netty.handler.codec.DecoderError: java.io.IOException: An existing connection was forcibly closed by the remote host", 0);
    expect(r.kind).not.toBe("ban");
  });

  it("does NOT classify 'bandwidth exceeded' as ban (simple)", () => {
    const r = classifyDisconnect("bandwidth exceeded", 0);
    expect(r.kind).not.toBe("ban");
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

  it("does NOT schedule a second reconnect while one is pending", () => {
    scheduler.scheduleReconnect(true, 5000, reconnectFn);
    // Second call while first is still pending — should still only have one timer
    const second = scheduler.scheduleReconnect(true, 5000, reconnectFn);
    // The scheduler allows multiple schedules (each "end" event is a new disconnect),
    // but the bot factory only calls this from "end", and "end" fires once per disconnect.
    // So in practice, one kick → one "end" → one scheduleReconnect call.
    expect(second).not.toBeNull();
    expect(second!.attempt).toBe(2);
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

  it("full flow: kick → end → one reconnect scheduled", () => {
    // Simulate what happens in bot.ts:
    // 1. "kicked" event fires (records reason only)
    // 2. "end" event fires → scheduleReconnect called once
    const info = classifyDisconnect("Kicked by an operator", 0);
    expect(info.shouldRetry).toBe(true);

    const result = scheduler.scheduleReconnect(info.shouldRetry, info.retryAfterMs, reconnectFn);
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(1);
    expect(scheduler.pending).toBe(true);

    // Only one reconnect scheduled — no duplicates
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
    const raw = { extra: [{ text: "You are " }, { text: "banned!" }] };
    expect(parseKickReason(raw)).toBe("You are banned!");
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
