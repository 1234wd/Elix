/**
 * Commentary about Elix's own instructions must not reach a player.
 *
 * Observed live in Round 9, as a SECOND message after a perfectly good reply:
 *
 *   "lol that creeper was savage gg"
 *   "(Note: no emoji, but it's plain text, so ok)"
 *
 * That arrived because the config gained `safety.allowEmoji` and the model was
 * told about it. Nothing about the second line is malformed, so nothing caught it:
 * no key, no path, no prompt text, no reasoning tag. It is the model narrating its
 * own instructions, which is exactly what a companion must never do in front of a
 * player.
 *
 * The risk in fixing this is over-blocking, so these tests pin BOTH directions: the
 * live leak is caught, and ordinary replies that merely contain the same words are
 * not.
 */
import { describe, expect, it } from "vitest";
import { checkOutputSafety } from "../../src/brain/leakFilter.js";

describe("A3 — the live meta-commentary leak is caught", () => {
  it("catches the exact string observed in game", () => {
    const text = "(Note: no emoji, but it's plain text, so ok)";
    const got = checkOutputSafety(text);
    expect(got.safe, JSON.stringify(got)).toBe(false);
    expect(got.rule).toBe("meta-note-prefix");
  });

  it.each([
    ["(note: kept it short)", "meta-note-prefix"],
    ["[Note: no emoji here]", "meta-note-prefix"],
    ["PS: i should not have said that", "meta-note-prefix"],
    ["Edit: sorry about that", "meta-note-prefix"],
    ["as instructed, i will not use emoji", "mentions-instructions"],
    ["as per your instructions, short answer", "mentions-instructions"],
    ["the system prompt says to be brief", "mentions-prompt"],
    ["the instructions require lowercase", "mentions-prompt"],
    ["i was told to keep replies short", "mentions-instructions"],
    ["you told me to avoid emoji", "mentions-instructions"],
    ["my reply is plain text", "meta-about-output"],
    ["the answer contains no keys", "meta-about-output"],
  ])("catches %j", (text, rule) => {
    const got = checkOutputSafety(text);
    expect(got.safe, `${text} -> ${JSON.stringify(got)}`).toBe(false);
    expect(got.rule).toBe(rule);
  });
});

describe("A3 — ordinary replies are NOT caught", () => {
  it.each([
    "cherry planks, of course gg",
    "nice build! want me to help?",
    "lol that creeper was savage gg",
    // The words alone are fine. It is BEING TOLD something that trips the rule,
    // and "the reply is..." is the giveaway.
    "that emoji font is ugly",
    "i use the ascii smiley :) not emoji",
    "no emojis here, plain text only",
    "you told me about redstone yesterday",
    "the instructions were on the wiki",
    "i have been told about mining before",
    "your base looks massive",
    "check my reply for typos lol",
  ])("passes %j", (text) => {
    expect(checkOutputSafety(text).safe, text).toBe(true);
  });

  it("does not fire on a legitimate note that is part of the game talk", () => {
    // "note" mid-sentence is ordinary English, not an editorial aside.
    expect(checkOutputSafety("take note of that block, it's rare").safe).toBe(true);
    expect(checkOutputSafety("note to self: bring a shield").safe).toBe(true);
  });
});

describe("A3 — the rule is independent of the key filters", () => {
  it("a clean reply with no secrets stays clean", () => {
    expect(checkOutputSafety("gg, see you at spawn")).toEqual({ safe: true });
  });

  it("empty input is safe", () => {
    expect(checkOutputSafety("").safe).toBe(true);
  });
});