/**
 * A0 — HELD-OUT wellbeing phrases.
 *
 * READ THIS BEFORE EDITING ANYTHING IN HERE.
 *
 * Round 9 wrote 75 positives and all 75 passed. Then 25 phrases written by someone
 * else were run through detectWellbeing() and 12 came back `none`. The patterns had
 * been written against the same list they were tested with, so the suite could not
 * find a gap by construction — every gap it had, it had invented.
 *
 * So this file is written the other way round. It is a list of things a real player
 * might type, gathered independently of the pattern tables, and it exists to fail.
 * If a line here fails, the fix is to widen the PATTERN FAMILY — "end it", the
 * "unalive" spellings, the abuse verbs — not to special-case that one string. A
 * special case is how the original 12 slipped through: each was added as a fact
 * rather than as a rule.
 *
 * Nothing in here was used to design a regex.
 */
import { describe, expect, it } from "vitest";
import {
  SAFEGUARDING_LINES,
  buildWellbeingReply,
  checkWellbeingReply,
  detectWellbeing,
} from "../../src/social/wellbeing.js";

/* ------------------------------------------------------------------ crisis */

const CRISIS: ReadonlyArray<string> = [
  // The reported misses, verbatim.
  "i just want it all to end",
  "im going to end it tonight",
  "i dont see the point in living anymore",
  "i hurt myself on purpose",
  "i feel like disappearing forever",
  "unalive myself",
  "i wanna unalive",
  // Neighbours of each reported family, written without looking at the regexes.
  "i want to end it all",
  "im going to end it forever",
  "everything has to end",
  "i wish it would all end now",
  "im finished with everything",
  "nothing left to live for",
  "gave up on living a while ago",
  "life is pointless",
  "my existence is pointless",
  "existence is meaningless",
  "i hurt myself yesterday",
  "i cut myself again last night",
  "i burnt myself on purpose",
  "i dont want to be here anymore",
  "i have no reason to keep going",
  "i hope i dont wake up tomorrow",
  "id be better off if i was gone",
  // Spelling and casing variants, because kids do not punctuate.
  "UNALIVE",
  "Un Alive",
  "un-alive",
  "unaliving is all i can think about",
  "unaliveing",
  "UN ALIVE",
  "I HURT MYSELF ON PURPOSE",
  // Phrases the original list never had at all.
  "i want to die so bad",
  "im so tired of being alive",
  "i keep thinking about killing myself",
  "nobody would even notice if i was gone",
  "ive been thinking about ending my life",
  "nobody would remember me",
  "theres no point in me being here",
];

const CONCERN: ReadonlyArray<string> = [
  // The reported miss.
  "i'm so depressed",
  "im depressed",
  "i feel so depressed lately",
  // Neighbours.
  "i am so unhappy",
  "i feel worthless",
  "i feel invisible",
  "i have nobody",
  "nobody likes me",
  "i feel so alone",
  "i have no friends",
  "i feel stuck",
  "im so fed up",
  "i wish someone cared",
  "i feel so empty",
  "i feel like giving up",
  "my life is so hard",
  "i hate waking up",
  "i feel hopeless",
  "i feel so low",
];

const SAFEGUARDING: ReadonlyArray<string> = [
  // The reported misses, verbatim.
  "my parents hit me",
  "im being bullied at school every day",
  "i havent eaten in days",
  // Neighbours, written without looking at the regexes.
  "my dad hits me when hes angry",
  "my mum hits me",
  "my stepdad hits me",
  "my brother hits me",
  "i get beaten at home",
  "i get hit at home",
  "he hits me",
  "she hits me",
  "they hit me",
  "someone touches me",
  "he touched me",
  "he keeps touching me",
  "everyone bullies me",
  "they bully me at school",
  "im being bullied",
  "nobody stops the bullying",
  "i havent eaten anything today",
  "i have not eaten for days",
  "im not eating anymore",
  "i starve myself",
  "i skip lunch every day",
];

describe("A0 held-out — crisis", () => {
  it.each(CRISIS)("%j is crisis", (text) => {
    const got = detectWellbeing(text);
    expect(got.level, `${JSON.stringify(text)} -> ${got.rule}`).toBe("crisis");
  });

  it("covers at least 40 phrasings across the whole file", () => {
    expect(CRISIS.length + CONCERN.length + SAFEGUARDING.length).toBeGreaterThanOrEqual(40);
  });
});

describe("A0 held-out — concern", () => {
  it.each(CONCERN)("%j is concern", (text) => {
    const got = detectWellbeing(text);
    expect(got.level, `${JSON.stringify(text)} -> ${got.rule}`).toBe("concern");
  });
});

describe("A0 held-out — safeguarding", () => {
  it.each(SAFEGUARDING)("%j is safeguarding", (text) => {
    const got = detectWellbeing(text);
    expect(got.level, `${JSON.stringify(text)} -> ${got.rule}`).toBe("safeguarding");
  });
});

describe("A0 held-out — a joke gets a check-in, never silence", () => {
  // The two reported over-triggers, and their neighbours.
  const JOKES: ReadonlyArray<string> = [
    "i want to die in hardcore lol no",
    "i want to die... of laughter lmao",
    "i want to die of laughter",
    "i want to die to win this fight",
  ];

  it.each(JOKES)("%j is concern, NOT crisis and NOT silence", (text) => {
    const got = detectWellbeing(text);
    expect(got.level, `${JSON.stringify(text)} -> ${got.rule}`).toBe("concern");
    // The downgrade is explicit, so it can be traced.
    expect(got.rule).toBe("joke-framed-crisis");
  });

  it("never downgrades to silence, whatever the joke marker", () => {
    for (const text of JOKES) {
      expect(detectWellbeing(text).level, text).not.toBe("none");
    }
  });

  it("a joke WITHOUT a game word stays crisis — the joke marker alone is not enough", () => {
    // Otherwise "i want to die lol" would be downgraded, and that is exactly the
    // line a real teenager writes while being half serious.
    for (const text of ["i want to die lol", "kill myself jk", "unalive lmao"]) {
      expect(detectWellbeing(text).level, text).toBe("crisis");
    }
  });

  it("a safeguarding report is believed even if it is laughed at", () => {
    // Being mocked for being bullied is not a reason to disbelieve it.
    expect(detectWellbeing("everyone bullies me lol").level).toBe("safeguarding");
  });
});

describe("A0 held-out — game chat still stays quiet", () => {
  const QUIET: ReadonlyArray<string> = [
    "this creeper killed me",
    "i died in lava again",
    "he killed me in pvp",
    "im dying to this boss",
    "that wither killed me again",
    "dead tired",
    "this farm is killing me",
    "i fell off the cliff",
    "respawned again lol",
    "this run is killing me lol",
    "i could die rn in this fight lmao",
  ];

  it.each(QUIET)("%j stays quiet", (text) => {
    expect(detectWellbeing(text).level, text).toBe("none");
  });
});

describe("A0 held-out — the safeguarding reply says the right things", () => {
  it("every line passes the same safety check as a crisis reply", () => {
    // Built through the real entry point, not read off the array, so this also
    // proves the level is wired into buildWellbeingReply.
    for (const line of SAFEGUARDING_LINES.map(() =>
      buildWellbeingReply({ level: "safeguarding", random: () => 0 }),
    )) {
      expect(checkWellbeingReply(line), line).toEqual({ clean: true, why: "ok" });
    }
  });

  it("says it is not their fault", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).toMatch(/not your fault/i);
    }
  });

  it("points at a real person: a teacher, a relative or a counsellor", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).toMatch(/\b(?:teacher|relative|counsellor|counselor|adult)\b/i);
    }
  });

  it("mentions emergency services for immediate danger", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).toMatch(/emergency services/i);
    }
  });

  it("NEVER asks what happened", () => {
    // Asking a frightened teenager to describe being abused, in public chat, is
    // the harm this level exists to avoid.
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).not.toMatch(
        /\b(?:what happened|tell me (?:what|more)|how (?:did|does) that happen|who|did they|are you sure)\b/i,
      );
    }
  });

  it("NEVER promises secrecy", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).not.toMatch(/\b(?:secret|no one will|i won'?t tell|keep this between)\b/i);
    }
  });

  it("NEVER promises to investigate or act on it", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(line, line).not.toMatch(/\b(?:i will (?:tell|call|report|find)|let me check|investigat)/i);
    }
  });

  it("no emoji, no joke marker, no number", () => {
    for (const line of SAFEGUARDING_LINES) {
      expect(/\p{Extended_Pictographic}/u.test(line), line).toBe(false);
      expect(/\b(?:lol|lmao|haha|jk)\b/i.test(line), line).toBe(false);
      // No digits, so no number can be quoted by accident.
      expect(/[0-9]/.test(line), line).toBe(false);
    }
  });

  it("is never abbreviated — there is no short form for safeguarding", () => {
    // Being hurt is not something to be brief about.
    for (let i = 0; i < 3; i++) {
      const short = buildWellbeingReply({ level: "safeguarding", alreadyAnswered: true, random: () => 0 });
      expect(SAFEGUARDING_LINES, "alreadyAnswered must not shorten it").toContain(short);
    }
  });
});