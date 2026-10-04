/**
 * Does a `*fix` follow-up respect the rate window?
 *
 * The first live run of rows 13-15 reported "2 gap(s) under 2000 ms: 1677, 1 ms"
 * and the row-14 reply was followed immediately by its own "*that" correction. If
 * the fix line goes out a millisecond after the typo it corrects, the player sees
 * two messages in the same instant — which is exactly the spam the 2 s limit
 * exists to prevent, and it is introduced BY the realism feature.
 */
import { describe, expect, it } from "vitest";
import { SayQueue } from "../../src/social/say.js";

/** A SayQueue with a fake clock and a transport that records send times. */
function build(opts: { maxPerWindow?: number; rateWindowMs?: number } = {}) {
  let clock = 1_000;
  const sent: Array<{ at: number; text: string }> = [];
  const queue = new SayQueue({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    typingMsPerChar: 0,
    maxTypingMs: 0,
    ...opts,
  });
  queue.setTransport((text) => sent.push({ at: clock, text }));
  return { queue, sent, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe("A2 — a `*fix` follow-up is rate-limited like any other message", () => {
  it("a typo and its fix are at least a rate window apart", async () => {
    const { queue, sent } = build();
    queue.say("lol fhat creeper was a legend");
    queue.say("*that", true); // skipTypingDelay, as the bridge passes it
    await queue.flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toBe("lol fhat creeper was a legend");
    expect(sent[1]?.text).toBe("*that");
    // The gap is the whole point. skipTypingDelay must NOT skip the rate window.
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(2000);
  });

  it("three messages in a row stay spaced", async () => {
    const { queue, sent } = build();
    queue.say("one");
    queue.say("two", true);
    queue.say("three");
    await queue.flush();
    expect(sent).toHaveLength(3);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.at - sent[i - 1]!.at, `gap ${i}`).toBeGreaterThanOrEqual(2000);
    }
  });

  it("a fix sent much later is not delayed unnecessarily", async () => {
    // The rate window must not become a reason to hold a message that arrived
    // outside the window anyway.
    const { queue, sent, advance } = build();
    queue.say("hello there");
    await queue.flush();
    advance(5000);
    queue.say("*word", true);
    await queue.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(5000);
  });

  it("a fix never overtakes the typo it corrects", async () => {
    // Ordering, not just spacing: a fix that arrives first is a typo nobody can read.
    const { queue, sent } = build();
    queue.say("fhat was a legend");
    queue.say("*that", true);
    await queue.flush();
    expect(sent.map((s) => s.text)).toEqual(["fhat was a legend", "*that"]);
  });
});