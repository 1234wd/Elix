import { describe, it, expect } from "vitest";
import {
  SayQueue,
  SAY_DEFAULTS,
  MAX_QUEUE_LENGTH,
  type SayOptions,
} from "../../src/social/say.js";

/**
 * A14: outbound chat must be rate limited, must have a typing delay so it
 * doesn't appear instantly, and must drop duplicates. `now` and `sleep` are
 * injected so these are deterministic and instant.
 */
function harness(opts: Partial<SayOptions> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const sent: string[] = [];
  const dropped: string[] = [];

  const queue = new SayQueue({
    now: () => clock,
    // Advance the injected clock instead of really waiting.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      await Promise.resolve();
    },
    onDrop: (text) => dropped.push(text),
    ...opts,
  });
  queue.setTransport((text) => sent.push(text));

  return {
    queue,
    sent,
    sleeps,
    dropped,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("SayQueue — rate limit (vision rule 8)", () => {
  it("defaults to 1 message per 2 s", () => {
    expect(SAY_DEFAULTS.maxPerWindow).toBe(1);
    expect(SAY_DEFAULTS.rateWindowMs).toBe(2000);
    const h = harness();
    expect(h.queue.minIntervalMs).toBe(2000);
  });

  it("derives the minimum gap from maxPerWindow/rateWindowMs", () => {
    // 2 per 2 s means one every second.
    expect(harness({ maxPerWindow: 2 }).queue.minIntervalMs).toBe(1000);
  });

  it("sends the first message immediately", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("hi");
    await h.queue.flush();
    expect(h.sent).toEqual(["hi"]);
  });

  it("holds the second message until the window closes", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("one");
    h.queue.say("two");
    await h.queue.flush();
    expect(h.sent).toEqual(["one", "two"]);
    // The gap between them was the full 2 s window.
    expect(h.sleeps).toContain(2000);
  });

  it("does not wait when enough time has already passed", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("one");
    await h.queue.flush();
    h.advance(5_000);
    h.queue.say("two");
    await h.queue.flush();
    expect(h.sleeps).not.toContain(2000);
    expect(h.sent).toEqual(["one", "two"]);
  });

  it("reports the remaining wait before the window closes", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("one");
    await h.queue.flush();
    // One send just happened, so the next is gated for the rest of the window.
    expect(h.queue.timeUntilAllowed()).toBeGreaterThan(0);
    h.advance(2_000);
    expect(h.queue.timeUntilAllowed()).toBe(0);
  });
});

describe("SayQueue — typing delay (vision rule 9)", () => {
  it("waits roughly 55 ms per character", async () => {
    const h = harness();
    h.queue.say("abcde"); // 5 chars × 55 ms = 275 ms
    await h.queue.flush();
    expect(h.sleeps).toContain(275);
  });

  it("caps the typing delay at 3 s for long messages", async () => {
    const h = harness();
    h.queue.say("x".repeat(500)); // 500 × 55 = 27_500 ms → capped
    await h.queue.flush();
    expect(h.sleeps).toContain(SAY_DEFAULTS.maxTypingMs);
  });

  it("skips the typing delay for the shutdown goodbye but keeps the queue", async () => {
    const h = harness();
    h.queue.say("gtg, cya", true);
    await h.queue.flush();
    expect(h.sent).toEqual(["gtg, cya"]);
    // No typing sleep, but the send still happened through the queue.
    expect(h.sleeps.filter((s) => s > 0 && s !== 2000)).toEqual([]);
  });

  it("still applies the rate limit to the goodbye", async () => {
    const h = harness();
    h.queue.say("first", true);
    h.queue.say("gtg, cya", true);
    await h.queue.flush();
    expect(h.sent).toEqual(["first", "gtg, cya"]);
    expect(h.sleeps).toContain(2000);
  });
});

describe("SayQueue — dedup", () => {
  it("drops an identical message inside the 10 s window", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("gm");
    await h.queue.flush();
    h.queue.say("gm");
    await h.queue.flush();
    expect(h.sent).toEqual(["gm"]);
    expect(h.dropped).toEqual(["gm"]);
  });

  it("allows the same text again after the window expires", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("gm");
    await h.queue.flush();
    h.advance(10_100);
    h.queue.say("gm");
    await h.queue.flush();
    expect(h.sent).toEqual(["gm", "gm"]);
  });

  it("does not let a duplicate consume a rate-limit slot", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("gm");
    h.queue.say("gm"); // dropped, must not push the next send's window
    h.queue.say("yo");
    await h.queue.flush();
    expect(h.sent).toEqual(["gm", "yo"]);
    expect(h.dropped).toEqual(["gm"]);
  });

  it("does not treat different text as a duplicate", async () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.say("gm");
    h.queue.say("gm!");
    await h.queue.flush();
    expect(h.sent).toEqual(["gm", "gm!"]);
    expect(h.dropped).toEqual([]);
  });
});

describe("A11 — the dedup map does not leak", () => {
  it("prunes entries older than the dedup window on every say()", () => {
    const h = harness({ typingMsPerChar: 0 });
    // Without pruning this grows once per distinct message for the whole
    // session — a 6-hour run leaked thousands of entries.
    for (let i = 0; i < 50; i++) {
      h.queue.say(`message number ${i}`);
      h.advance(100);
    }
    // 20 messages in the last 10 s window are still tracked.
    expect(h.queue.dedupSize).toBeGreaterThan(0);

    // Move well past the window; the next say() must sweep the old entries.
    h.advance(SAY_DEFAULTS.dedupWindowMs * 2);
    h.queue.say("fresh message");
    // Only the fresh message and anything inside the window remain.
    expect(h.queue.dedupSize).toBeLessThanOrEqual(2);
  });

  it("keeps at most one full window's worth of entries", () => {
    const h = harness({ typingMsPerChar: 0, dedupWindowMs: 1000 });
    for (let i = 0; i < 200; i++) {
      h.queue.say(`msg ${i}`);
      h.advance(10);
    }
    // 1000 ms window / 10 ms per message = ~100 messages could be live.
    expect(h.queue.dedupSize).toBeLessThanOrEqual(120);
  });
});

describe("A11 — the outbound queue is capped", () => {
  it("drops the oldest non-priority message when full", async () => {
    const h = harness({ typingMsPerChar: 0, maxPerWindow: 1000 });
    const total = MAX_QUEUE_LENGTH + 4;
    for (let i = 0; i < total; i++) h.queue.say(`m${i}`, true);

    // The first message is picked up immediately by the drain loop, so only the
    // rest compete for space. The queue never exceeds the cap.
    const queued = h.queue.pending;
    expect(queued).toBeLessThanOrEqual(MAX_QUEUE_LENGTH);

    await h.queue.flush();
    // 9 messages offered, 1 went out immediately, 3 more were discarded to stay
    // within the cap — so only a handful are ever sent.
    expect(h.queue.dropped).toBe(total - 1 - queued);
    expect(h.queue.dropped).toBeGreaterThan(0);
    expect(h.sent).toContain(`m${total - 1}`);
    expect(h.sent.length).toBeLessThan(total);
  });

  it("never drops a priority message (the goodbye)", async () => {
    const h = harness({ typingMsPerChar: 0, maxPerWindow: 1000 });
    h.queue.say("gtg, cya", true, true);
    for (let i = 0; i < MAX_QUEUE_LENGTH + 5; i++) h.queue.say(`filler ${i}`, true);
    await h.queue.flush();
    expect(h.sent).toContain("gtg, cya");
  });

  it("reports dropped-queue-full when only priority items remain", () => {
    const h = harness({ typingMsPerChar: 0, maxPerWindow: 1000 });
    // The drain loop takes the first one immediately, so queue MAX to fill it.
    for (let i = 0; i <= MAX_QUEUE_LENGTH; i++) h.queue.say(`p${i}`, true, true);
    expect(h.queue.pending).toBe(MAX_QUEUE_LENGTH);
    // A non-priority message cannot displace a priority one.
    expect(h.queue.say("ordinary", true)).toBe("dropped-queue-full");
  });

  it("the cap is small enough that the backlog cannot run to minutes", () => {
    // At 1 message per 2 s, 5 queued items is at most ~10 s of backlog.
    expect(MAX_QUEUE_LENGTH * 2000).toBeLessThanOrEqual(10_000);
  });
});

describe("SayQueue — lifecycle", () => {
  it("preserves ordering across many queued messages", async () => {
    const h = harness({ typingMsPerChar: 0 });
    for (const text of ["a", "b", "c", "d"]) h.queue.say(text);
    await h.queue.flush();
    expect(h.sent).toEqual(["a", "b", "c", "d"]);
  });

  it("close() discards anything still waiting to go out", async () => {
    const h = harness({ typingMsPerChar: 0 });
    // The first message is sent synchronously by drain(); the second is still
    // gated behind the rate-limit window when we close.
    h.queue.say("one");
    h.queue.say("two");
    h.queue.close();
    await h.queue.flush();
    expect(h.sent).not.toContain("two");
    expect(h.queue.pending).toBe(0);
  });

  it("says nothing after close()", () => {
    const h = harness({ typingMsPerChar: 0 });
    h.queue.close();
    expect(h.queue.say("hi")).toBe("dropped-duplicate");
    expect(h.queue.pending).toBe(0);
  });

  it("flush() resolves even when nothing is queued", async () => {
    const h = harness();
    await expect(h.queue.flush()).resolves.toBeUndefined();
  });
});