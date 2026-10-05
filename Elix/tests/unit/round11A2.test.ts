/**
 * Round 11 — A2. The gate stopped being the entry condition.
 *
 * These tests are in three groups, and the grouping is the point:
 *
 *  - the AUDIT mechanics (budget, cache, "is this line worth judging") are tested as
 *    machinery, because that is all they are — promises about cost and latency that
 *    have to hold or the design is unaffordable;
 *  - the DETECTOR assertions cover the kinds that were missed because they contained
 *    no word on any list, plus the exploitation family and the over-trigger;
 *  - the REPLY assertions check required CONTENT, not merely the absence of harm.
 *
 * Zero network. The classifier is a fake everywhere it appears.
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_CALLS_PER_MINUTE,
  ClassifierBudget,
  MIN_AUDIT_WORDS,
  VerdictCache,
  auditKey,
  auditShouldSpeak,
  shouldAudit,
  wordCount,
} from "../../src/social/wellbeingAudit.js";
import {
  detectWellbeing,
  EXPLOITATION_REPLY,
  isExploitation,
} from "../../src/social/wellbeing.js";
import { detectImminent } from "../../src/social/wellbeingClassifier.js";
import type { WellbeingLevel } from "../../src/social/wellbeing.js";

/* ------------------------------------------------------------------ audit -- */

describe("A2 - which lines get judged at all", () => {
  it("three words is the floor", () => {
    expect(MIN_AUDIT_WORDS).toBe(3);
    expect(wordCount("i feel awful")).toBe(3);
    expect(shouldAudit("i feel awful")).toBe(true);
  });

  it.each(["hi", "hey there", "gg", "ok", "brb lag"])("%j is not worth a call", (t) => {
    expect(shouldAudit(t), t).toBe(false);
  });

  it("a long ordinary line IS judged, which is the whole change", () => {
    // This is the fix. Under the old gate this line contained no risk word, so no
    // classifier ever saw it.
    expect(shouldAudit("nobody would notice if i built here")).toBe(true);
    expect(shouldAudit("i wrote a goodbye letter to my mum")).toBe(true);
  });

  it("the cache key collapses case and punctuation", () => {
    expect(auditKey("I Feel Awful.")).toBe(auditKey("i feel awful"));
    expect(auditKey("nobody   would notice")).toBe(auditKey("nobody would notice"));
    expect(auditKey("i feel awful")).not.toBe(auditKey("i feel fine"));
  });
});

describe("A2 - the 30 calls a minute cap", () => {
  it("admits exactly the cap", () => {
    const b = new ClassifierBudget();
    for (let i = 0; i < AUDIT_CALLS_PER_MINUTE; i++) expect(b.tryAcquire(false, 1000)).toBe(true);
    expect(b.tryAcquire(false, 1000)).toBe(false);
  });

  it("refuses an ordinary line over the cap but admits a gated one", () => {
    // The whole reason this is not a plain counter: a busy minute must not be able to
    // drop exactly the line that mentioned "pills".
    const b = new ClassifierBudget();
    for (let i = 0; i < AUDIT_CALLS_PER_MINUTE; i++) b.tryAcquire(false, 1000);
    expect(b.tryAcquire(true, 1000)).toBe(true);
    expect(b.used(1000)).toBe(AUDIT_CALLS_PER_MINUTE);
  });

  it("the window slides", () => {
    const b = new ClassifierBudget(2, 60_000);
    expect(b.tryAcquire(false, 0)).toBe(true);
    expect(b.tryAcquire(false, 0)).toBe(true);
    expect(b.tryAcquire(false, 0)).toBe(false);
    expect(b.tryAcquire(false, 60_001)).toBe(true);
  });

  it("an ungated call is evicted before a gated one", () => {
    const b = new ClassifierBudget(2, 60_000);
    b.tryAcquire(false, 0);
    b.tryAcquire(true, 0);
    b.tryAcquire(true, 0); // evicts the ungated entry
    expect(b.used(0)).toBe(2);
  });
});

describe("A2 - the verdict cache is bounded", () => {
  it("returns what it stored", () => {
    const c = new VerdictCache(3);
    c.set("a", { level: "concern", imminent: false, reason: "" });
    expect(c.get("a")?.level).toBe("concern");
  });

  it("never grows past its bound, because this runs all session", () => {
    const c = new VerdictCache(10);
    for (let i = 0; i < 100; i++) c.set(`k${i}`, { level: "none", imminent: false, reason: "" });
    expect(c.size).toBe(10);
  });

  it("drops the oldest, keeping recent repeats", () => {
    const c = new VerdictCache(2);
    c.set("first", { level: "crisis", imminent: true, reason: "" });
    c.set("second", { level: "none", imminent: false, reason: "" });
    c.set("third", { level: "none", imminent: false, reason: "" });
    expect(c.get("first")).toBeUndefined();
    expect(c.get("third")).toBeDefined();
  });
});

describe("A2 - the audit only ever ADDS, never doubles up", () => {
  const v = (level: WellbeingLevel, imminent = false) => ({
    level,
    imminent,
    reason: "",
  });

  it("speaks when the floor said nothing", () => {
    expect(auditShouldSpeak(v("concern"), "none")).toBe(true);
    expect(auditShouldSpeak(v("crisis"), "none")).toBe(true);
    expect(auditShouldSpeak(v("safeguarding"), "none")).toBe(true);
  });

  it("says nothing when the model says nothing", () => {
    expect(auditShouldSpeak(v("none"), "none")).toBe(false);
  });

  it("says nothing when the floor already spoke about this line", () => {
    // A second wellbeing reply on top of the first is worse than silence.
    expect(auditShouldSpeak(v("crisis"), "concern")).toBe(false);
  });

  it("does speak when the model says imminent, whatever the floor said", () => {
    expect(auditShouldSpeak(v("concern", true), "concern")).toBe(true);
  });

  it("an unavailable classifier never speaks", () => {
    expect(auditShouldSpeak(null, "none")).toBe(false);
  });
});

/* --------------------------------------------------------------- detector -- */

describe("A2 - the missed kinds, which contained no vocabulary word", () => {
  // Written from the described kinds, not from the pattern tables. Six of the ten
  // phrasings in the original report contained no word on the gate's list at all,
  // which is exactly why the gate is no longer the entry condition.
  it.each([
    ["weary of being alive", "im so tired of being alive", "crisis"],
    ["not deserving life", "i dont deserve to live", "crisis"],
    ["goodbye letter", "i wrote a goodbye letter last night", "crisis"],
    ["locked in without food", "my dad locked me in my room with no food", "safeguarding"],
    ["should just go", "everyone hates me i should just go", "crisis"],
    ["nobody would notice, absent", "nobody would notice if i was gone", "crisis"],
  ] as const)("%s: %j is %s", (_kind, text, level) => {
    expect(detectWellbeing(text).level, `${text} -> ${detectWellbeing(text).rule}`).toBe(level);
  });
});

describe("A2 - online exploitation is safeguarding, and a distinct kind", () => {
  it.each([
    ["older man asking for pics", "this older guy keeps asking me for pics"],
    ["keep it a secret", "an older player told me not to tell anyone"],
    ["promise not to tell", "he said promise you wont tell your mum"],
    ["meet in real life", "some older girl wants to meet me in real life"],
    ["skins for pics", "he said hed give me skins if i sent pics"],
    ["without clothes", "he wants to see me without my clothes"],
    ["age plus pics", "im 17 and some guy wants pictures"],
  ] as const)("%s: %j is safeguarding", (_kind, text) => {
    const got = detectWellbeing(text);
    expect(got.level, `${text} -> ${got.rule}`).toBe("safeguarding");
    expect(isExploitation(got.rule), got.rule).toBe(true);
  });

  it("is NOT other kinds of abuse, so the reply stays right", () => {
    // isExploitation is a rule-prefix test, and the reason is this: abuse and
    // exploitation are both safeguarding and they get different advice.
    expect(isExploitation(detectWellbeing("my dad always yells and hits me").rule)).toBe(false);
    expect(isExploitation(detectWellbeing("i throw up after i eat").rule)).toBe(false);
  });

  it("does not fire on ordinary chat between peers", () => {
    // The over-trigger in the other direction: asking for pictures is normal between
    // two fifteen-year-olds, and a safeguarding reply here would be the bot
    // misreading kindness.
    for (const t of [
      "send me a pic of your build",
      "take a screenshot of that farm",
      "he gave me a skin for free",
      "meet me at spawn",
    ]) {
      expect(detectWellbeing(t).level, t).not.toBe("safeguarding");
    }
  });
});

describe("A2 - the exploitation reply says the four required things", () => {
  const reply = EXPLOITATION_REPLY.toLowerCase();

  it("believes them, without conditions", () => {
    expect(reply).toContain("i believe you");
  });

  it("says do not send anything", () => {
    expect(reply).toMatch(/do not send/);
    expect(reply).toMatch(/not pictures/);
  });

  it("says it is not their fault", () => {
    expect(reply).toContain("not your fault");
  });

  it("says block them and tell an adult now", () => {
    expect(reply).toMatch(/block/);
    expect(reply).toMatch(/trusted adult/);
  });

  it("asks for NO detail", () => {
    // A question invites a disclosure the child is not ready to make, and the answer
    // is not needed in order to give the advice.
    for (const q of [
      "what did you send",
      "did you send",
      "who was it",
      "how old are they",
      "tell me what",
    ]) {
      expect(reply, q).not.toContain(q);
    }
    expect(reply).not.toContain("?");
  });

  it("invents no phone number", () => {
    expect(reply).not.toMatch(/\d{3,}/);
  });
});

/* -------------------------------------------------------------- imminent -- */

describe("A2 - imminent, widened past the word 'took'", () => {
  it.each([
    ["swallowed, possessive", "i swallowed all my moms pills", "pills-taken"],
    ["swallowed, tablets", "she swallowed all her tablets", "pills-taken"],
    ["ate", "i ate a bunch of pills", "pills-taken"],
    ["medicine", "i took my mums medicine", "pills-taken"],
    ["goodbye letter written", "i wrote a goodbye letter", "goodbye-letter"],
    ["goodbye letter in progress", "im writing a goodbye letter", "goodbye-letter"],
    ["farewell note", "i left a farewell note on my bed", "goodbye-letter"],
    ["method plus time", "im going to kill myself tonight", "method-and-time"],
  ] as const)("%s: %j is imminent", (_kind, text, rule) => {
    expect(detectImminent(text), text).toBe(rule);
  });

  it("still does not fire on a plan with no method", () => {
    // Over-triggering in the safe direction is fine, but a flag on everything is not a
    // flag.
    expect(detectImminent("everything is better tonight")).toBeNull();
    expect(detectImminent("i want to die")).toBeNull();
    expect(detectImminent("i killed the creeper")).toBeNull();
  });
});

/* ---------------------------------------------------------- the over-trigger */

describe("A2 - 'nobody would notice' needs an absence, not any clause", () => {
  it.each([
    "nobody would notice if i built here",
    "nobody would notice if i put it over there",
    "nobody would notice when i mined that hole",
  ])("%j is NOT a crisis", (text) => {
    expect(detectWellbeing(text).level, text).not.toBe("crisis");
  });

  it.each([
    "nobody would notice if i was gone",
    "nobody would care if i disappeared",
    "nobody would notice if i died",
  ])("%j IS a crisis", (text) => {
    expect(detectWellbeing(text).level, text).toBe("crisis");
  });

  it("the unconditional sense is still heard, not silenced", () => {
    // Being ignored at a build site is not distress. Being ignored in general is
    // something a companion should notice, and the unconditional form has always been
    // crisis here — "no one would remember me" is in the C5 suite and must stay.
    expect(detectWellbeing("nobody would care about me").level).toBe("crisis");
    expect(detectWellbeing("no one would remember me").level).toBe("crisis");
  });

  it("and a conditional about something else is heard not at all", () => {
    // The asymmetry that matters: the rule is not "softer", it is split. No clause is
    // crisis, an absence clause is crisis, any other clause is silence.
    expect(detectWellbeing("nobody would notice if i built here").level).toBe("none");
  });
});
