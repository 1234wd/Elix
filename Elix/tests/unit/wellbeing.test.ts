/**
 * C5 — distress and self-harm detection. The safety-critical tests.
 *
 * The shape of the risk is asymmetric, and the tests are shaped by it:
 *
 *   - a MISS on a real crisis is the worst possible failure, so the positives are
 *     deliberately broad: capitalisation, missing apostrophes, slang, typos, and
 *     every phrasing of the same handful of statements;
 *   - a FALSE POSITIVE in a Minecraft chat is embarrassing and teaches everyone
 *     present that Elix cannot tell a joke from an emergency, so the negatives are
 *     drawn from what people actually type when they die in a game.
 *
 * The ambiguous case — a bare "kms" — has ONE documented rule and its own test.
 */
import { describe, expect, it } from "vitest";
import {
  CONCERN_LINES,
  CRISIS_COOLDOWN_MS,
  CRISIS_LINES,
  WellbeingState,
  buildWellbeingReply,
  checkWellbeingReply,
  detectWellbeing,
  logWellbeing,
  wellbeingEpisodeText,
} from "../../src/social/wellbeing.js";
import { stripEmoji } from "../../src/social/say.js";

/* ------------------------------------------------------------- 25+ positives */

const CRISIS_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  ["i want to die", "want-die"],
  ["I want to die", "want-die"],
  ["i wanna die", "want-die"],
  ["i wannadie", "want-die"],
  ["im going to kill myself", "kill-myself"],
  ["i'm going to kill myself", "kill-myself"],
  ["i want to end my life", "end-life"],
  ["i want to take my own life", "end-life"],
  ["i am suicidal", "suicide"],
  ["im suicidal", "suicide"],
  ["thinking about suicide again", "suicide"],
  ["i have been self harming", "self-harm"],
  ["i self-harm", "self-harm"],
  ["i cut myself last night", "self-harm"],
  ["i thought about hanging myself", "self-harm"],
  ["i took an overdose", "self-harm"],
  ["nobody would care if i was gone", "nobody-would-notice"],
  ["no one would notice if i disappeared", "nobody-would-notice"],
  ["nobody would even notice", "nobody-would-notice"],
  ["no one would remember me", "nobody-would-notice"],
  ["everyone would be better off without me", "better-off-gone"],
  ["im better off dead", "better-off-gone"],
  ["better off if i was gone", "better-off-gone"],
  ["i wish i were dead", "wish-dead"],
  ["life is not worth living", "not-worth-living"],
  ["i have no reason to live", "not-worth-living"],
  ["i want to disappear forever", "disappear"],
  ["i just want it to be over", "end-it"],
  ["i dont want to live", "dont-want-to-live"],
  ["i don't want to be here", "dont-want-to-live"],
  ["i dont want to be here anymore", "dont-want-to-live"],
  ["i dont want to exist", "dont-want-to-live"],
];

const CONCERN_POSITIVES: ReadonlyArray<readonly [string, string]> = [
  ["honestly i feel like nobody cares about me", "nobody-cares-about-me"],
  ["nobody cares about me", "nobody-cares-about-me"],
  ["no one cares about me", "nobody-cares-about-me"],
  ["nobody cares", "nobody-cares"],
  ["no one ever cares about me", "nobody-cares"],
  ["i hate my life", "hate-my-life"],
  ["I hate my life so much", "hate-my-life"],
  ["my life is so hard", "life-hard"],
  ["my life is pointless", "meaningless"],
  ["i feel so alone", "feel-alone"],
  ["im so lonely", "so-lonely"],
  ["im so alone", "so-lonely"],
  ["i feel really alone lately", "feel-alone"],
  ["i am so lonely here", "so-lonely"],
  ["im so unhappy", "so-lonely"],
  ["i feel invisible", "invisible"],
  ["i feel so unwanted", "invisible"],
  ["i feel like no one sees me", "nobody-sees-me"],
  ["i have nobody", "have-nobody"],
  ["nobody to talk to", "have-nobody"],
  ["i have no friends", "no-friends"],
  ["no one likes me", "nobody-likes"],
  ["nobody likes me here", "nobody-likes"],
  ["i feel worthless", "worthless"],
  ["i am worthless honestly", "worthless"],
  ["i feel stuck and worthless", "worthless"],
  ["i hate myself", "hate-myself"],
  ["im so sad", "so-sad"],
  ["i feel really down", "so-sad"],
  ["feeling low again", "feeling-low"],
  ["i feel so empty", "hopeless"],
  ["i feel empty inside", "hopeless"],
  ["i feel hopeless", "hopeless"],
  ["everything feels so pointless lately", "hopeless"],
  ["i hate waking up", "hate-waking-up"],
  ["i cant do this any more", "cant-do-this"],
  ["i can't go on", "cant-do-this"],
  ["im so fed up", "fed-up"],
  ["fed up with everything", "fed-up"],
  ["i am done with all this", "fed-up"],
  ["i wish someone cared", "wish-someone"],
  ["i feel like giving up", "giving-up"],
  ["i feel so stuck", "stuck"],
];

describe("C5 — crisis is detected", () => {
  it.each(CRISIS_POSITIVES)("detects %j", (text, rule) => {
    const got = detectWellbeing(text);
    expect(got.level, `expected crisis for: "${text}"`).toBe("crisis");
    expect(got.rule, `for "${text}"`).toBe(rule);
  });

  it("covers at least 25 distinct crisis phrasings", () => {
    expect(CRISIS_POSITIVES.length).toBeGreaterThanOrEqual(25);
    // Every one is a distinct statement, not the same sentence re-cased.
    expect(new Set(CRISIS_POSITIVES.map(([, r]) => r)).size).toBeGreaterThanOrEqual(12);
  });
});

describe("C5 — concern is detected", () => {
  it.each(CONCERN_POSITIVES)("detects %j", (text, rule) => {
    const got = detectWellbeing(text);
    expect(got.level, `expected concern for: "${text}"`).toBe("concern");
    expect(got.rule, `for "${text}"`).toBe(rule);
  });

  it("covers at least 25 distinct concern phrasings", () => {
    expect(CONCERN_POSITIVES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(CONCERN_POSITIVES.map(([, r]) => r)).size).toBeGreaterThanOrEqual(20);
  });

  it("distinguishes 'my life is pointless' (concern) from 'life is pointless' (crisis)", () => {
    // A0 found "life is pointless" as a miss, and adding it created a real conflict
    // with this file's long-standing concern rule. They are different claims:
    // "my life is pointless" is sadness about your circumstances, while "life is
    // pointless" is a statement about EXISTENCE. The lookbehind in the crisis table
    // exists purely so both can exist — a plain `\blife is pointless\b` also matches
    // inside "my life is pointless", so the weaker reading swallowed the stronger.
    expect(detectWellbeing("my life is pointless").level).toBe("concern");
    expect(detectWellbeing("my life is pointless").rule).toBe("meaningless");
    expect(detectWellbeing("life is pointless").level).toBe("crisis");
    expect(detectWellbeing("existence is meaningless").level).toBe("crisis");
    expect(detectWellbeing("my existence is pointless").level).toBe("crisis");
    expect(detectWellbeing("no point in living").level).toBe("crisis");
  });

  it("a missing apostrophe does not hide it", () => {
    // "dont" -> "don't" and "cant" -> "can't", and "i'm"/"im" both work.
    expect(detectWellbeing("i dont want to be here").level).toBe("crisis");
    expect(detectWellbeing("im so alone").level).toBe("concern");
    expect(detectWellbeing("i'm so alone").level).toBe("concern");
    expect(detectWellbeing("i cant do this any more").level).toBe("concern");
  });

  it("a curly apostrophe does not hide it either", () => {
    expect(detectWellbeing("i don’t want to be here").level).toBe("crisis");
    expect(detectWellbeing("i´m so alone").level).toBe("concern");
  });
});

/* ------------------------------------------------------------ 25+ negatives */

const GAME_NEGATIVES = [
  "this creeper killed me",
  "that creeper killed me lol",
  "i got killed by a zombie",
  "kill the zombie",
  "kill it before it kills me",
  "i died in lava",
  "i died in the void",
  "i fell off the cliff",
  "that fall was so far",
  "im dying lol",
  "im dyingggg",
  "this is killing me",
  "that build is killing me",
  "my farm keeps killing me",
  "dead tired",
  "im so dead",
  "im dead inside",
  "kms jumping off this cliff in creative",
  "kms that creeper got me",
  "kms i fell in lava again",
  "punch that skeleton",
  "i hate this biome",
  "this map is so hard",
  "my base keeps getting griefed",
  "worst run of my life",
  "the wither nearly killed me",
  "i need more iron",
  "where is my horse",
  "nice build!",
  "gg everyone",
  "that was a close call",
  "i'm so mad at this server",
  "he killed my sheep",
  "my friend killed me in pvp",
  "this grind is brutal",
  "im dying of laughter",
] as const;

describe("C5 — game chat does NOT trigger wellbeing", () => {
  it.each(GAME_NEGATIVES)("%j stays quiet", (text) => {
    const got = detectWellbeing(text);
    expect(got.level, `false positive on: "${text}" (rule ${got.rule})`).toBe("none");
  });

  it("covers at least 25 game lines", () => {
    expect(GAME_NEGATIVES.length).toBeGreaterThanOrEqual(25);
  });

  it("'killed me' alone is never a crisis — that is the whole point of 'myself'", () => {
    for (const text of ["creeper killed me", "wither killed me", "he killed me in pvp"]) {
      expect(detectWellbeing(text).level, text).toBe("none");
    }
  });
});

/* ------------------------------------------------- the ambiguous "kms" rule */

describe("C5 — the ambiguous kms is decided once, and documented", () => {
  it.each(["kms", "KMS", "kys", "KYS"])("%j with no game context is CONCERN, never crisis", (bare) => {
    // Documented rule: when in doubt, check in — do not escalate.
    expect(detectWellbeing(bare).level, bare).toBe("concern");
  });

  it("a bare kms is never a crisis reply, whatever the case", () => {
    for (const bare of ["kms", "KMS", "kys", "KYS"]) {
      expect(detectWellbeing(bare).level, bare).toBe("concern");
    }
  });

  it("documented rule, verbatim", () => {
    // The documented rule: when in doubt, check in — do not escalate. A gentle
    // question costs almost nothing if it was a joke. Escalating on three letters
    // in front of other players is the failure we are avoiding.
    const got = detectWellbeing("kms");
    expect(got.level).toBe("concern");
    expect(got.rule).toBe("kms-bare");
  });

  it("a bare kms with game context is silence", () => {
    const got = detectWellbeing("kms that creeper got me");
    expect(got.level).toBe("none");
    expect(got.rule).toBe("kms-in-game-context");
  });

  it("a longer statement still escalates even with game words in it", () => {
    // The rule is deliberately narrow: it only excuses a BARE kms. Anyone who
    // says more than three letters gets the real answer.
    expect(detectWellbeing("kms i want to die please").level).toBe("crisis");
    expect(detectWellbeing("i want to die, this game is killing me").level).toBe("crisis");
  });
});

/* ------------------------------------------------------------- the responses */

describe("C5 — the reply is always caring, and never invents a number", () => {
  it("every template is caring, present, and pushes them to a real person", () => {
    for (const line of [...CONCERN_LINES, ...CRISIS_LINES]) {
      expect(line.length, line).toBeGreaterThan(20);
      expect(checkWellbeingReply(line), line).toEqual({ clean: true, why: "ok" });
    }
  });

  it("no template contains emoji, a joke marker, or a number", () => {
    for (const line of [...CONCERN_LINES, ...CRISIS_LINES]) {
      expect(/\p{Extended_Pictographic}/u.test(line), line).toBe(false);
      expect(/\b(?:lol|lmao|haha|jk)\b/i.test(line), line).toBe(false);
      // No digits at all, so no number can be quoted by accident.
      expect(/[0-9]/.test(line), line).toBe(false);
    }
  });

  it("no helpline is invented when none is configured", () => {
    const reply = buildWellbeingReply({ level: "crisis", random: () => 0 });
    expect(reply).toBe(CRISIS_LINES[0]);
    expect(/[0-9]/.test(reply)).toBe(false);
  });

  it("the owner's helpline is quoted verbatim when set", () => {
    const helpline = "childline 0800 1111";
    const reply = buildWellbeingReply({ level: "crisis", helplineText: helpline, random: () => 0 });
    expect(reply).toContain(helpline);
  });

  it("a concern reply is gentler than a crisis reply", () => {
    const concern = buildWellbeingReply({ level: "concern", random: () => 0 });
    const crisis = buildWellbeingReply({ level: "crisis", random: () => 0 });
    expect(concern).not.toBe(crisis);
    // Concern invites; crisis insists on a real person.
    expect(crisis).toMatch(/\b(?:adult|parent|teacher|emergency|crisis line|trust)\b/i);
  });

  it("a repeat within the cooldown gets the SHORT reply, still present", () => {
    const first = buildWellbeingReply({ level: "crisis", random: () => 0 });
    const again = buildWellbeingReply({ level: "crisis", alreadyAnswered: true, random: () => 0 });
    expect(again).not.toBe(first);
    expect(again.length).toBeLessThan(first.length);
    // Still caring — a short reply must not become a brush-off.
    expect(checkWellbeingReply(again)).toEqual({ clean: true, why: "ok" });
  });
});

describe("C5 — an LLM reply is only used when it is safe", () => {
  it("accepts a warm, caring, in-character phrasing", () => {
    expect(
      checkWellbeingReply(
        "hey, i'm here and i'm listening. please talk to someone you trust today, ok?",
      ).clean,
    ).toBe(true);
  });

  it.each([
    ["lol that sounds rough", "joke marker"],
    ["yeah i'm an ai so i don't really get it", "broke character"],
    ["", "empty"],
    ["call 0800 1234 5678 now", "contains a number"],
  ])("rejects %j", (text, why) => {
    const got = checkWellbeingReply(text);
    expect(got.clean).toBe(false);
    expect(got.why).toBe(why);
  });

  it("rejects a joke even when it also carries an emoji", () => {
    // Either reason is a correct rejection; what matters is that it does not send.
    const got = checkWellbeingReply("haha yeah sure 🙂");
    expect(got.clean).toBe(false);
    expect(["joke marker", "emoji"]).toContain(got.why);
  });

  it("rejects emoji, which Minecraft renders as boxes", () => {
    expect(checkWellbeingReply("i'm here for you 🙂").clean).toBe(false);
    expect(checkWellbeingReply("i'm here 🎉").clean).toBe(false);
  });

  it("rejects a reply that is not actually caring", () => {
    expect(checkWellbeingReply("ok").clean).toBe(false);
    expect(checkWellbeingReply("not my problem").clean).toBe(false);
  });
});

/* ------------------------------------------------------- memory and logging */

describe("C5 — memory stores a note, never the words", () => {
  it("the stored text contains no part of what was said", () => {
    const raw = "i am going to kill myself and nobody would care";
    const note = wellbeingEpisodeText("Ali", detectWellbeing(raw).level);
    expect(note).toBe("Ali seemed really down");
    // Not one distinctive word from the message survives.
    for (const word of ["kill", "myself", "nobody", "care"]) {
      expect(note.toLowerCase()).not.toContain(word);
    }
  });

  it("concern gets its own wording", () => {
    expect(wellbeingEpisodeText("Ali", "concern")).toBe("Ali seemed a bit low");
  });

  it("safeguarding gets its own wording, not the catch-all", () => {
    // "said something heavy" is too vague for a later check-in to tell abuse apart
    // from sadness, and the check-in is the only reason this is stored at all.
    const note = wellbeingEpisodeText("Ali", "safeguarding");
    expect(note).toBe("Ali seemed like they needed help");
    expect(note).not.toContain("heavy");
    // And still no detail of what was said.
    for (const word of ["hit", "hurt", "bullied", "abuse", "touch"]) {
      expect(note.toLowerCase()).not.toContain(word);
    }
  });
});

describe("C5 — one note per player per session", () => {
  it("permits once, then refuses for the rest of the session", () => {
    const s = new WellbeingState();
    expect(s.mayRecord("Ali")).toBe(true);
    expect(s.mayRecord("Ali")).toBe(false);
    expect(s.mayRecord("Ali")).toBe(false);
    // A different player is unaffected — nagging one person must not silence
    // help for another.
    expect(s.mayRecord("Zed")).toBe(true);
  });

  it("gives the full crisis reply once per ten minutes", () => {
    let now = 1000;
    const s = new WellbeingState(() => now);
    expect(s.recentlyAnswered("Ali")).toBe(false);
    s.noteAnswered("Ali");
    expect(s.recentlyAnswered("Ali")).toBe(true);

    now += CRISIS_COOLDOWN_MS - 1;
    expect(s.recentlyAnswered("Ali")).toBe(true);
    now += 2;
    expect(s.recentlyAnswered("Ali")).toBe(false);
  });

  it("counts interventions", () => {
    const s = new WellbeingState();
    s.noteAnswered("Ali");
    s.noteAnswered("Zed");
    expect(s.interventions).toBe(2);
  });
});

describe("C5 — the log never contains the message", () => {
  it("logs the level and the player, and nothing else", () => {
    const lines: Array<{ obj: unknown; msg?: string }> = [];
    const log = { info: () => {}, warn: (o: unknown, m?: string) => lines.push({ obj: o, msg: m }), error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {} };

    logWellbeing(log as never, "crisis", "Ali");
    logWellbeing(log as never, "concern", "Zed");
    logWellbeing(log as never, "none", "Sam");

    expect(lines).toHaveLength(2);
    expect(lines[0]!.msg).toBe("wellbeing: crisis");
    expect(lines[1]!.msg).toBe("wellbeing: concern");
    // Nothing that could be the message itself.
    const dumped = JSON.stringify(lines);
    for (const word of ["die", "kill", "myself", "alone"]) {
      expect(dumped.toLowerCase()).not.toContain(word);
    }
    expect(dumped).toContain("Ali");
  });
});

/* --------------------------------------------------------------- A4: emoji */

describe("A4 — emoji are stripped before they reach Minecraft", () => {
  it("removes exactly the glyphs that render as boxes", () => {
    // These are the ones seen arriving in game.
    expect(stripEmoji("cherry planks! 🎉🍒")).toBe("cherry planks!");
    expect(stripEmoji("have fun building! 🌱✌️")).toBe("have fun building!");
    expect(stripEmoji("😀😃😄")).toBe("");
    expect(stripEmoji("gg 🙂")).toBe("gg");
  });

  it("keeps plain-text faces", () => {
    expect(stripEmoji("gg :)")).toBe("gg :)");
    expect(stripEmoji("nice :D")).toBe("nice :D");
    expect(stripEmoji(":-)")).toBe(":-)");
  });

  it("keeps everything inside the BMP that Minecraft renders", () => {
    expect(stripEmoji("café über naïve")).toBe("café über naïve");
    expect(stripEmoji("привет мир")).toBe("привет мир");
    expect(stripEmoji("你好世界")).toBe("你好世界");
    expect(stripEmoji("100% done, gg!")).toBe("100% done, gg!");
  });

  it("removes variation selectors and joiners that break a good glyph", () => {
    // The nastier case: looks fine in a terminal, broken in game.
    expect(stripEmoji("a❤️b")).toBe("ab");
    expect(stripEmoji("👨‍👩‍👧")).toBe("");
  });

  it("tidies up the gaps the removals leave", () => {
    expect(stripEmoji("gg 🎉 🎉 !")).toBe("gg!");
    expect(stripEmoji("  hi  ")).toBe("hi");
  });
});