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
  /**
   * Capitalised analysis openers, plus the lowercase leaks that carry vocabulary.
   *
   * The lowercase FRAGMENTS that used to be in this list — bare "we have", bare
   * "we need to", bare "let's consider the options" — were removed by A2 and are
   * asserted as NOT leaks in the block at the end of this file. They are exactly
   * the strings Elix says normally, and treating them as leaked reasoning threw
   * away good replies.
   */
  const LEAKS: ReadonlyArray<readonly [string, string]> = [
    ["We have information about the block.", "we-"],
    ["We need to answer the user about their favourite block.", "we-"],
    ["We should probably", "we-"],
    ["We must not", "we-"],
    ["We can see that", "we-"],
    ["We will", "we-"],
    ["The user wants to know", "the-user"],
    ["The user is asking about", "the-user"],
    ["Let's think about this", "lets-think"],
    ["Let us think", "lets-think"],
    ["Let's analyze the question", "lets-think"],
    ["Let's break it down", "lets-think"],
    ["Analysis: the player", "analysis"],
    ["**Analysis** of", "analysis"],
    ["**We have** a plan", "we-"],
    ["**The user** mentioned", "the-user"],
    ["**Let's think** about", "lets-think"],
    ["Step 1: greet the player", "scratchpad"],
    ["Reasoning: they are sad", "scratchpad"],
    ["  \n  We have an idea", "we-"],
    // Lowercase, but unmistakably analysis: caught by the vocabulary fallback.
    ["the user asked about redstone", "analysis-vocabulary"],
    ["let me think about the best answer", "analysis-vocabulary"],
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
    // A mid-message mention with no analysis vocabulary is fine.
    expect(detectLeakedReasoning("that reminds me, we should talk later").leaked).toBe(false);
    expect(detectLeakedReasoning("i like your base, we should build one too").leaked).toBe(false);
  });

  it("but third-person framing about the player IS a leak, wherever it sits", () => {
    // This used to assert the opposite, on the grounds that a mid-message "the user"
    // is legitimate. It is not: Elix addresses people as "you". Referring to the
    // person he is talking to as "the user" is third-person framing, and that is the
    // leak signature whether or not it starts the sentence.
    for (const text of [
      "yeah the user is asking me about redstone",
      "the user asked about redstone",
      "answering the user now",
    ]) {
      expect(detectLeakedReasoning(text).leaked, text).toBe(true);
    }
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
describe("A2 — ordinary lowercase chat is no longer discarded", () => {
  /**
   * Round 9 pinned these as a KNOWN COST. The cost is now removed.
   *
   * persona.md says Elix writes casual LOWERCASE chat, and every observed leak is
   * capitalised, so case is a real signal rather than a stylistic guess. The old
   * rule matched any case and silently threw away replies like "we have enough iron
   * for that" — which wastes a model call and pushes the answer onto a fallback.
   */
  const CHAT: ReadonlyArray<string> = [
    "we have enough iron for that",
    "we should meet at spawn",
    "we have a plan for the farm",
    "we can go that way",
    "we need to go to the nether",
    "let's go to the mine",
    "we want to mine some more stone",
  ];

  it.each(CHAT)("%j passes", (text) => {
    const got = detectLeakedReasoning(text);
    expect(got.leaked, `${JSON.stringify(text)} should NOT be discarded (got ${got.rule})`).toBe(false);
    expect(got.rule).toBe("no-prefix-match");
  });

  it("the capitalised leaks are STILL caught, in both original forms", () => {
    expect(detectLeakedReasoning(OBSERVED).leaked).toBe(true);
    expect(detectLeakedReasoning(COHERENT).leaked).toBe(true);
    expect(detectLeakedReasoning("We have a plan for the farm").leaked).toBe(true);
    expect(detectLeakedReasoning("The user asked about redstone").leaked).toBe(true);
    expect(detectLeakedReasoning("The user of this server is not me").leaked).toBe(true);
  });

  it("a lowercase leak is still caught by the vocabulary fallback", () => {
    // Capitalisation is a fast path, not the only path. Vocabulary Elix would
    // never use catches a leak that does not begin at position zero.
    expect(detectLeakedReasoning("we need to answer the question here").leaked).toBe(true);
    expect(detectLeakedReasoning("i should follow the system prompt").leaked).toBe(true);
    expect(detectLeakedReasoning("let me think about the instructions").leaked).toBe(true);
    expect(detectLeakedReasoning("as an ai, i would say that").leaked).toBe(true);
  });

  it("the rule names which signal fired, so it is traceable", () => {
    expect(detectLeakedReasoning(COHERENT).rule).toBe("we-" + "prefix");
    expect(detectLeakedReasoning("The user asked about redstone").rule).toBe("the-user");
    expect(detectLeakedReasoning("i should follow the system prompt").rule).toBe(
      "analysis-vocabulary",
    );
    expect(detectLeakedReasoning("we have enough iron").rule).toBe("no-prefix-match");
  });
});

describe("A2 — the lowercase fragments that were wrongly discarded", () => {
  /**
   * Every one of these was in the A3 leak list and is ordinary chat.
   *
   * "we have enough iron for that" is a sentence Elix says, and the rule discarded
   * it — wasting a call and pushing the answer to a fallback. persona.md is
   * explicit that he writes lowercase, so capitalisation is the discriminator.
   */
  const FRAGMENTS: ReadonlyArray<string> = [
    "we have",
    "we need to",
    "let's consider the options",
    "WE HAVE NO IDEA WHAT TO SAY",
  ];

  it.each(FRAGMENTS)("%j is not leaked reasoning", (text) => {
    expect(detectLeakedReasoning(text).leaked, text).toBe(false);
  });
});
