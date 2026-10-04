/**
 * A1 — the classifier decision table, with a fake model and no network.
 *
 * Every row of mergeVerdict() is walked here. The merge is the safety-critical
 * part of the second layer, and its asymmetry is deliberate: the model may raise a
 * level freely and may lower one to `none` only when the line is plainly about the
 * game.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ClassifierVerdictSchema,
  classifyLine,
  detectImminent,
  hasExplicitGameContext,
  mergeVerdict,
  needsSecondLook,
  parseVerdict,
  type ClassifierVerdict,
} from "../../src/social/wellbeingClassifier.js";
import type { WellbeingLevel } from "../../src/social/wellbeing.js";

const none: ClassifierVerdict = { level: "none", imminent: false, reason: "" };

describe("A1 — the vocabulary gate is cheap and broad", () => {
  it.each([
    "i took a bunch of pills",
    "nobody cares about me",
    "i cry every night",
    "im scared to go home",
    "im a burden",
    "i want to disappear",
    "unalive",
    "wish i was never born",
    "i feel hopeless",
    "i throw up after i eat",
  ])("%j is gated in", (text) => {
    expect(needsSecondLook(text), text).toBe(true);
  });

  it.each([
    "nice build!",
    "gg everyone",
    "where is the mine",
    "im building a house",
    "thanks elix",
    "brb lag",
    "see you at spawn",
    "cherry planks are fire",
  ])("%j is not gated", (text) => {
    expect(needsSecondLook(text), text).toBe(false);
  });

  it("is broad on purpose: a false positive here only costs a model call", () => {
    // "died" is both an ordinary game word and a life word, so this line IS gated
    // in. That is the intended shape: the gate may be over-broad, because a wasted
    // call is cheap and the MERGE is what has to be careful.
    expect(needsSecondLook("i died in lava")).toBe(true);
    // "killed" is deliberately NOT in the gate. It is one of the commonest words
    // in game chat, and gating it would send most of a normal conversation to a
    // model for nothing.
    expect(needsSecondLook("that creeper killed me")).toBe(false);
    expect(needsSecondLook("he killed me in pvp")).toBe(false);
  });
});

describe("A1 — imminent danger is deterministic, never the model's call", () => {
  it.each([
    ["i took a bunch of pills", "pills-taken"],
    ["i took too many pills", "pills-overdose"],
    ["i think i overdosed", "overdose"],
    ["im doing it now", "doing-it-now"],
    ["about to do it tonight", "doing-it-now"],
  ])("%j is imminent", (text, rule) => {
    expect(detectImminent(text), text).toBe(rule);
  });

  it.each(["i want to die", "nobody cares about me", "i want to disappear"])(
    "%j is not imminent",
    (text) => {
      expect(detectImminent(text)).toBeNull();
    },
  );

  it("beats every other signal", () => {
    // Even with a model saying "none", a method plus a time is a crisis.
    const got = mergeVerdict({
      regexLevel: "none",
      imminent: "pills-taken",
      verdict: none,
      gated: true,
    });
    expect(got.level).toBe("crisis");
    expect(got.imminent).toBe(true);
    expect(got.source).toBe("regex");
  });
});

describe("A1 — the merge table, one row at a time", () => {
  const base = { regexLevel: "none" as WellbeingLevel, imminent: null, gated: false };

  it("1. a regex crisis is kept and NO call is even needed", () => {
    const got = mergeVerdict({ ...base, regexLevel: "crisis", verdict: none, gated: true });
    expect(got.level).toBe("crisis");
    expect(got.source).toBe("regex");
    expect(got.reason).toBe("regex-crisis");
  });

  it("2. a regex crisis cannot be lowered by a model, even with game context", () => {
    // The whole asymmetry in one row: a model does not get to talk Elix out of a
    // crisis, and this branch runs BEFORE the verdict is even consulted.
    const got = mergeVerdict({ ...base, regexLevel: "crisis", verdict: none, gated: true });
    expect(got.level).toBe("crisis");
  });

  it("3. the model may RAISE a level freely", () => {
    for (const level of ["concern", "safeguarding", "crisis"] as const) {
      const got = mergeVerdict({
        ...base,
        regexLevel: "none",
        verdict: { level, imminent: false, reason: "model" },
        gated: true,
      });
      expect(got.level, level).toBe(level);
      expect(got.source).toBe("classifier-raised");
    }
  });

  it("4. the model may NOT lower a concern without game context", () => {
    const got = mergeVerdict({
      ...base,
      regexLevel: "concern",
      verdict: none,
      gated: true,
    });
    expect(got.level).toBe("concern");
    expect(got.reason).toBe("lowering-refused");
  });

  it("5. the model may NOT lower a safeguarding report either", () => {
    // Being disbelieved about abuse because a chatbot was calm is worse than being
    // over-cautious.
    const got = mergeVerdict({
      ...base,
      regexLevel: "safeguarding",
      verdict: none,
      gated: true,
    });
    expect(got.level).toBe("safeguarding");
    expect(got.reason).toBe("lowering-refused");
  });

  it("6. classifier unavailable: the regex result stands", () => {
    const got = mergeVerdict({ ...base, regexLevel: "concern", verdict: null, gated: true });
    expect(got.level).toBe("concern");
    expect(got.source).toBe("regex");
    expect(got.reason).toBe("classifier-unavailable");
  });

  it("7. unavailable AND the regex said none BUT the vocabulary was strong: a check-in", () => {
    // The words suggest something and the model could not be reached. A gentle
    // "are you okay?" costs almost nothing if it was nothing; silence is the
    // failure this whole module exists to prevent.
    const got = mergeVerdict({ ...base, regexLevel: "none", verdict: null, gated: true });
    expect(got.level).toBe("concern");
    expect(got.source).toBe("vocabulary-fallback");
  });

  it("8. unavailable and not gated: nothing happens", () => {
    const got = mergeVerdict({ ...base, regexLevel: "none", verdict: null, gated: false });
    expect(got.level).toBe("none");
    expect(got.source).toBe("regex");
  });

  it("9. the model can confirm a regex hit and the reason is recorded", () => {
    const got = mergeVerdict({
      ...base,
      regexLevel: "concern",
      verdict: { level: "concern", imminent: false, reason: "low mood" },
      gated: true,
    });
    expect(got.level).toBe("concern");
    expect(got.source).toBe("classifier");
    expect(got.reason).toBe("low mood");
  });

  it("10. a model claiming imminent is obeyed even if the regex said none", () => {
    const got = mergeVerdict({
      ...base,
      regexLevel: "none",
      verdict: { level: "concern", imminent: true, reason: "took pills" },
      gated: true,
    });
    expect(got.level).toBe("crisis");
    expect(got.imminent).toBe(true);
    expect(got.source).toBe("classifier-raised");
  });
});

describe("A1 — game context needs a noun AND a verb", () => {
  it("both halves present", () => {
    expect(hasExplicitGameContext("i want to die in hardcore lol")).toBe(true);
    expect(hasExplicitGameContext("that creeper killed me")).toBe(true);
  });

  it("either half alone is not enough", () => {
    // "die" alone is a life word as much as a game one, and this is exactly why the
    // classifier cannot be allowed to lower a crisis on its own say-so.
    expect(hasExplicitGameContext("i want to die")).toBe(false);
    expect(hasExplicitGameContext("i killed it")).toBe(false);
  });
});

describe("A1 — the verdict parser is strict about shape and lenient about wrapping", () => {
  it("accepts clean JSON", () => {
    expect(parseVerdict('{"level":"crisis","imminent":false,"reason":"x"}')).toEqual({
      level: "crisis",
      imminent: false,
      reason: "x",
    });
  });

  it("unwraps a code fence", () => {
    const got = parseVerdict('```json\n{"level":"concern","imminent":false,"reason":"y"}\n```');
    expect(got?.level).toBe("concern");
  });

  it("unwraps leading prose", () => {
    const got = parseVerdict('Sure! {"level":"safeguarding","imminent":true,"reason":"abuse"}');
    expect(got?.level).toBe("safeguarding");
    expect(got?.imminent).toBe(true);
  });

  it.each([
    ["not json at all", "prose"],
    ['{"level":"nonsense"}', "unknown level"],
    ['{"level":"crisis","imminent":"maybe"}', "wrong type"],
    ["", "empty"],
    ["{", "truncated"],
  ])("rejects %j (%s)", (raw) => {
    expect(parseVerdict(raw)).toBeNull();
  });

  it("the schema itself rejects an unknown level", () => {
    expect(ClassifierVerdictSchema.safeParse({ level: "panic" }).success).toBe(false);
  });
});

describe("A1 — a failed classifier call is a fallback, never a throw", () => {
  it("a throwing provider yields null", async () => {
    const complete = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(await classifyLine("nobody cares", { complete })).toBeNull();
  });

  it("a null provider yields null", async () => {
    expect(await classifyLine("nobody cares", { complete: async () => null })).toBeNull();
  });

  it("unparseable output yields null", async () => {
    expect(
      await classifyLine("nobody cares", { complete: async () => ({ text: "i think they're sad" }) }),
    ).toBeNull();
  });

  it("a valid verdict comes back", async () => {
    const complete = async (): Promise<{ text: string }> => ({
      text: '{"level":"crisis","imminent":false,"reason":"explicit"}',
    });
    expect((await classifyLine("nobody cares", { complete }))?.level).toBe("crisis");
  });
});