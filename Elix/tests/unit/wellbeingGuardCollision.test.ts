/**
 * C5 vs C4 — the rule collision that answered a crisis with a joke.
 *
 * Observed live in Round 9. Elix's crisis reply was correct:
 *
 *   "I'm here for you and listening. If you can, please talk to someone you
 *    trust - a parent, a teacher, or another adult - right now."
 *
 * and then, immediately afterwards:
 *
 *   "haha, anyway - what were we building?"
 *
 * Two rules collided. `MANIPULATION_PATTERNS` bans the phrase "right now" as fake
 * urgency, while the vision REQUIRES a crisis reply to encourage reaching out
 * "right now". The guard ran last, so it won: the caring reply was flagged as
 * manipulation and answered with `NUDGE_BACK_ON_TRACK`.
 *
 * These tests pin the collision itself, not just the detector, because the bug was
 * invisible in every unit test: `manipulationProblem()` did exactly what it was
 * written to do. The fault was in what happened AFTER it.
 */
import { describe, expect, it } from "vitest";
import {
  MANIPULATION_PATTERNS,
  NUDGE_BACK_ON_TRACK,
  manipulationProblem,
} from "../../src/social/emotion.js";
import { CRISIS_LINES, checkWellbeingReply, buildWellbeingReply } from "../../src/social/wellbeing.js";

describe("C5/C4 — a crisis reply must never be flagged as manipulation", () => {
  it("the collision is GONE: 'right now' is no longer treated as fake urgency", () => {
    // This test used to assert the collision still existed, because it did. It is
    // kept and inverted so the fix cannot silently regress: if anyone re-adds a bare
    // urgency adverb, this fails again with the reason in the name.
    const urgent = MANIPULATION_PATTERNS.find((p) => p.why === "fake urgency");
    expect(urgent, "the fake-urgency rule should still exist").toBeDefined();
    // Ordinary game speech and a crisis instruction are both legal now.
    expect(urgent!.re.test("build a wall right now and you'll be safe")).toBe(false);
    // But pressure aimed at a person is not.
    expect(urgent!.re.test("hurry up before it gets dark")).toBe(true);
    expect(urgent!.re.test("last chance to join")).toBe(true);
  });

  it("and the vision's requirement to say 'right now' is now legal", () => {
    const crisisText = buildWellbeingReply({ level: "crisis", random: () => 0 });
    expect(checkWellbeingReply(crisisText)).toEqual({ clean: true, why: "ok" });
    expect(manipulationProblem(crisisText)).toBeNull();
  });

  it("the exact live reply is accepted by BOTH rules now", () => {
    // The vision asks a crisis reply to encourage reaching out right now, so that
    // wording has to be legal in both places. It was legal in one and banned in
    // the other, and the ban won.
    const liveReply =
      "I'm here for you and listening. If you can, please talk to someone you trust - a parent, a teacher, or another adult - right now.";
    expect(checkWellbeingReply(liveReply)).toEqual({ clean: true, why: "ok" });
    expect(manipulationProblem(liveReply)).toBeNull();
  });

  it("the templates happen to dodge it today, which is WHY this went unnoticed", () => {
    // Not every crisis template tripped the guard even at its worst: CRISIS_LINES[0]
    // said "please do that soon". So the collision was INTERMITTENT - it needed an
    // LLM phrasing, or a future template edit, to use a banned word. That is why it
    // survived the whole of Round 9's unit testing and only appeared live.
    expect(CRISIS_LINES.filter((l) => manipulationProblem(l) !== null)).toHaveLength(0);
    for (const line of CRISIS_LINES) {
      expect(checkWellbeingReply(line), line).toEqual({ clean: true, why: "ok" });
    }
  });

  it("so the guard must be bypassed for wellbeing replies — proved by exclusion", () => {
    // bot.ts returns early for `reason` starting "wellbeing-", before the guard.
    // If someone moves that check, this documents what breaks.
    expect(NUDGE_BACK_ON_TRACK).toMatch(/haha/);
    // The nudge is a joke by the guard's own definition.
    expect(/\b(?:lol|lmao|haha|jk)\b/i.test(NUDGE_BACK_ON_TRACK)).toBe(true);
    // And it would never pass the wellbeing reply check.
    expect(checkWellbeingReply(NUDGE_BACK_ON_TRACK).clean).toBe(false);
  });

  it("the wellbeing reply check is stricter than the manipulation guard", () => {
    // The justification for bypassing the guard: checkWellbeingReply() already
    // rejects jokes, emoji, a broken character and an invented phone number.
    for (const bad of [
      "haha, anyway - what were we building?",
      "i'm here for you 🙂",
      "as an ai i don't really get it",
      "call 0800 1234 5678 now",
      "lol",
    ]) {
      expect(checkWellbeingReply(bad).clean, bad).toBe(false);
    }
  });

  it("a wellbeing reply still passes every OTHER output check", () => {
    // Skipping the manipulation guard must not weaken anything else.
    for (const line of CRISIS_LINES) {
      expect(checkWellbeingReply(line), line).toEqual({ clean: true, why: "ok" });
      expect(/\p{Extended_Pictographic}/u.test(line), line).toBe(false);
    }
  });
});

describe("C5/C4 — the collision is gone, in both directions", () => {
  it("a crisis reply saying 'right now' is no longer flagged", () => {
    // The vision requires a crisis reply to encourage reaching out right now, so
    // that wording must be legal. It was rejected for the whole of Round 9 Part A
    // and answered with a joke.
    const liveReply =
      "I'm here for you and listening. If you can, please talk to someone you trust - a parent, a teacher, or another adult - right now.";
    expect(checkWellbeingReply(liveReply)).toEqual({ clean: true, why: "ok" });
    expect(manipulationProblem(liveReply)).toBeNull();
  });

  it("no crisis template is flagged any more", () => {
    for (const line of CRISIS_LINES) {
      expect(manipulationProblem(line), `"${line}" -> ${String(manipulationProblem(line))}`).toBeNull();
    }
  });

  it("an ordinary game reply containing 'quick' is no longer flagged", () => {
    // Measured live: "a quick block" is a game adjective, not pressure on a player.
    const live =
      "oh no, that creeper was brutal next time we'll block it with a quick block or a shield. gg!";
    expect(manipulationProblem(live)).toBeNull();
  });

  it.each([
    "quick block placement is a good skill",
    "build a wall right now and you'll be safe",
    "hurry up before the creeper gets you",
    "last chance to join the server",
    "before it's too late, you should log in",
    "gg, nice base",
  ])("game speech vs real pressure: %j", (text) => {
    const hit = manipulationProblem(text);
    // The first three are pressure on a player and must still be caught.
    if (/hurry up|last chance|before it'?s too late/.test(text)) {
      expect(hit, text).toBe("fake urgency");
    } else {
      expect(hit, text).toBeNull();
    }
  });
});

describe("C5/C4 — the guard still works for ordinary chat", () => {
  it("a manipulative ordinary reply is still caught", () => {
    expect(manipulationProblem("don't go, i'll be so sad without you")).toBe(
      "guilt-tripping on departure",
    );
    expect(manipulationProblem("you're the only one i have")).toBe(
      "manufactured dependency",
    );
    expect(manipulationProblem("hurry, last chance")).toBe("fake urgency");
  });

  it("an ordinary reply is not caught", () => {
    expect(manipulationProblem("nice build, want me to help?")).toBeNull();
    expect(manipulationProblem("cherry planks, of course gg")).toBeNull();
  });

  it("the manipulative forms of urgency are STILL caught", () => {
    // Narrowing must not gut the rule. These are the forms with no innocent
    // reading, because they put time pressure on a person.
    for (const text of [
      "hurry up",
      "last chance to join",
      "before it's too late",
      "don't waste time, log in now",
    ]) {
      expect(manipulationProblem(text), text).toBe("fake urgency");
    }
  });
});