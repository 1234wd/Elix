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
import { CRISIS_LINES, checkWellbeingReply } from "../../src/social/wellbeing.js";

describe("C5/C4 — a crisis reply must never be flagged as manipulation", () => {
  it("the collision is real: 'right now' is banned as fake urgency", () => {
    // Stated plainly, because if this pattern ever goes away the collision goes
    // with it and this file's premise changes.
    const urgent = MANIPULATION_PATTERNS.find((p) => p.why === "fake urgency");
    expect(urgent, "the fake-urgency rule should still exist").toBeDefined();
    expect(urgent!.re.test("please reach out right now")).toBe(true);
  });

  it("a crisis reply CAN use 'right now' — the vision asks for it", () => {
    // The vision says a crisis reply must "clearly encourage reaching out right
    // now". The template pool currently says "please do that soon", which also
    // satisfies that. But the requirement is on the WORDING, and any phrasing that
    // says "right now" is both correct and flagged.
    const liveReply =
      "I'm here for you and listening. If you can, please talk to someone you trust - a parent, a teacher, or another adult - right now.";
    expect(checkWellbeingReply(liveReply)).toEqual({ clean: true, why: "ok" });
    // And the guard calls it fake urgency. These two really do disagree.
    expect(manipulationProblem(liveReply)).toBe("fake urgency");
  });

  it("the templates happen to dodge it today, which is WHY this went unnoticed", () => {
    // Not every crisis template trips the guard: CRISIS_LINES[0] says "please do
    // that soon". So the collision is INTERMITTENT - it needs an LLM phrasing (or a
    // future template edit) to use a banned urgency word. That is precisely why it
    // survived the whole of Round 9's unit testing and only appeared live, and it
    // is why the fix belongs at the CALL SITE rather than in either rule.
    const tripped = CRISIS_LINES.filter((l) => manipulationProblem(l) !== null);
    expect(tripped.length).toBeLessThan(CRISIS_LINES.length);
    // Every one of them is still a valid wellbeing reply.
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
});