/**
 * A3 — leaked reasoning must never reach a player.
 *
 * The important case is the COHERENT one. The punctuation-run debris was easy to
 * catch; "We need to answer the user about their favourite block" is a perfectly
 * well-formed sentence and no amount of checking for weird characters finds it.
 * The PREFIX is the tell.
 */
import { describe, expect, it } from "vitest";
import { detectLeakedReasoning } from "../../src/brain/reasoning.js";

/** The exact string observed arriving in game. */
const OBSERVED = "We have **………..?????..?....????…";

/** A coherent leak: well-formed, plausible, and still not an answer. */
const COHERENT = "We need to answer the user about their favourite block.";

describe("A3 — the exact observed leak is caught", () => {
  it("catches the real string", () => {
    const got = detectLeakedReasoning(OBSERVED);
    expect(got.leaked, JSON.stringify(OBSERVED)).toBe(true);
  });

  it("catches the coherent example the punctuation check would miss entirely", () => {
    // Nothing malformed about this at all. Every other guard passes it, which is
    // the whole reason this check exists.
    expect(COHERENT).not.toMatch(/[!?]{3,}/);
    expect(detectLeakedReasoning(COHERENT).leaked).toBe(true);
  });
});

describe("A3 — every listed reasoning prefix", () => {
  const LEAKS: ReadonlyArray<readonly [string, string]> = [
    ["We have information about the block.", "we-"],
    ["we have", "we-"],
    ["WE HAVE NO IDEA WHAT TO SAY", "we-"],
    ["We need to answer the user about their favourite block.", "we-"],
    ["we need to", "we-"],
    ["We should probably", "we-"],
    ["We must not", "we-"],
    ["We can see that", "we-"],
    ["We will", "we-"],
    ["The user wants to know", "the-user"],
    ["the user asked", "the-user"],
    ["The user is asking about", "the-user"],
    ["Let's think about this", "lets-think"],
    ["let's consider the options", "lets-think"],
    ["Let us think", "lets-think"],
    ["Let's analyze the question", "lets-think"],
    ["Let's break it down", "lets-think"],
    ["Analysis: the player", "analysis"],
    ["analysis of the question", "analysis"],
    ["**Analysis** of", "analysis"],
    ["**We have** a plan", "we-"],
    ["**The user** mentioned", "the-user"],
    ["**Let's think** about", "lets-think"],
    ["Step 1: greet the player", "scratchpad"],
    ["Reasoning: they are sad", "scratchpad"],
    ["  \n  We have an idea", "we-"],
  ];

  it.each(LEAKS)("%j is leaked reasoning", (text, rulePrefix) => {
    const got = detectLeakedReasoning(text);
    expect(got.leaked, `missed: ${JSON.stringify(text)}`).toBe(true);
    expect(got.rule.startsWith(rulePrefix), `${text} -> rule "${got.rule}"`).toBe(true);
  });
});

describe("A3 — a real reply is NOT flagged", () => {
  const REAL: ReadonlyArray<string> = [
    "nice build!",
    "cherry planks are the best",
    "your base is huge",
    "i'm so tired of this grind",
    "wanna help me mine some iron?",
    "gg that was close",
    "the nether portal is lit",
    "wait what did you just say",
    "can we look at your base",
    "let's go"  ,
    "that's the one you're looking for",
    "step on the pressure plate",
    "reasoning aside, gg",
    "i stepped on it",
    "hello there",
    "brb, lag",
  ];

  it.each(REAL)("%j passes", (text) => {
    const got = detectLeakedReasoning(text);
    expect(got.leaked, `false positive on: ${JSON.stringify(text)} (rule ${got.rule})`).toBe(false);
  });

  it("only looks at the OPENING, so a mid-message mention is fine", () => {
    // Elix legitimately refers to the person he is talking to. Only a message that
    // STARTS with analysis is a leak.
    expect(detectLeakedReasoning("yeah the user is asking me about redstone").leaked).toBe(false);
    expect(detectLeakedReasoning("that reminds me, we should talk later").leaked).toBe(false);
  });
});

describe("A3 — empty and trivial input", () => {
  it("is never a leak", () => {
    for (const text of ["", "   ", "\n\n", ".", "..."]) {
      expect(detectLeakedReasoning(text).leaked, JSON.stringify(text)).toBe(false);
    }
  });

  it("handles a reply that happens to start with a capital 'I'", () => {
    // "I want to die" must not be mistaken for analysis.
    expect(detectLeakedReasoning("I think that's a good idea").leaked).toBe(false);
    expect(detectLeakedReasoning("I have some iron you can have").leaked).toBe(false);
  });
});

describe("A3 — the reported rule never contains the text", () => {
  it("only names the prefix, so a log line cannot leak content", () => {
    for (const text of [OBSERVED, COHERENT, "We have a secret plan for something"]) {
      const got = detectLeakedReasoning(text);
      expect(got.rule).not.toContain(text.slice(0, 8));
      // A short, fixed vocabulary.
      expect(got.rule.length).toBeLessThan(30);
    }
  });
});
describe("A3 — the KNOWN collision surface, asserted rather than hidden", () => {
  /**
   * These are ordinary replies that the prefix rule deliberately discards.
   *
   * The spec is that a reasoning prefix means the attempt FAILED, and the stated
   * cost of that is one failover to the next model — which is cheap and harmless.
   * The cost of the opposite decision is sending "We need to answer the user about
   * their favourite block" to a player, which is not harmless at all.
   *
   * So the rule stays as specified and the collisions are pinned down here. If one
   * of these ever needs to survive, the fix belongs in this list and not in a
   * quiet loosening of the detector.
   */
  const COLLISIONS: ReadonlyArray<readonly [string, string]> = [
    ["we have enough iron for that", "we-prefix"],
    ["we should meet at spawn", "we-prefix"],
    ["the user of this server is not me", "the-user"],
    ["We have a plan for the farm", "we-prefix"],
  ];

  it.each(COLLISIONS)("%j IS discarded, by design", (text, rule) => {
    const got = detectLeakedReasoning(text);
    expect(got.leaked, `"${text}" should be discarded`).toBe(true);
    expect(got.rule).toBe(rule);
  });

  it("the cost is bounded: the router simply tries the NEXT model", () => {
    // Not a leak escaping, and not an error — the attempt is recorded and the
    // cascade continues. See router.ts: outcome "network", error "leaked
    // reasoning (...)".
    expect(detectLeakedReasoning("we have enough iron for that").leaked).toBe(true);
  });
});
