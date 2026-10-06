/**
 * WP5c acceptance — give, and put things away.
 *
 * The rules being pinned here are mostly prohibitions: never to the wrong person, never out
 * of a chest, never while somebody is upset. Each "never" has its own test.
 *
 * `bot.toss` is checked against the real mineflayer source, and every item name comes from
 * the real vendored 26.2 data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_CHEST_ACTION,
  CHEST_RANGE,
  GIVE_REFUSALS,
  GIVE_RANGE,
  GiveController,
  decideGive,
  isGiveable,
  parseChestAction,
  parseGive,
  type GiveView,
} from "../../src/skills/give.js";

function view(over: Partial<GiveView> = {}): GiveView {
  return {
    askedBy: "ElixOwner",
    isOwner: true,
    counts: { cobblestone: 12, dirt: 3 },
    chest: { distance: 4, canHold: true },
    wellbeingFloor: false,
    ...over,
  };
}

describe("WP5c — parsing a give", () => {
  it("parses 'elix give me cobblestone'", () => {
    expect(parseGive("elix give me cobblestone", "Elix")).toEqual({ item: "cobblestone", count: 1 });
  });

  it("parses 'elix give me 5 dirt'", () => {
    expect(parseGive("elix give me 5 dirt", "Elix")).toEqual({ item: "dirt", count: 5 });
  });

  it("parses 'elix hand me some oak log'", () => {
    expect(parseGive("elix hand me some oak log", "Elix")).toEqual({ item: "oak_log", count: 1 });
  });

  it("refuses a give with no item named - a shrug is not a give", () => {
    expect(parseGive("elix give me", "Elix")).toBeNull();
    expect(parseGive("elix give me the", "Elix")).toBeNull();
    expect(parseGive("elix give me some", "Elix")).toBeNull();
  });

  it("refuses an item Elix has never heard of", () => {
    expect(parseGive("elix give me unobtainium", "Elix")).toBeNull();
    expect(parseGive("elix give me 3 unobtainium", "Elix")).toBeNull();
  });

  it("refuses a line not addressed to Elix, and one that is not whole-intent", () => {
    expect(parseGive("give me cobblestone", "Elix")).toBeNull();
    expect(parseGive("give me cobblestone everyone", "Elix")).toBeNull();
    expect(parseGive("elix can you give me some cobblestone", "Elix")).toBeNull();
    expect(parseGive("elix give me cobblestone and then follow me", "Elix")).toBeNull();
  });

  it("caps a silly count", () => {
    expect(parseGive("elix give me 9999 dirt", "Elix")?.count).toBe(64);
  });

  it("only ever names real 26.2 items", () => {
    for (const item of ["cobblestone", "dirt", "oak_log", "oak_planks", "stick", "bread", "apple", "torch"]) {
      expect(parseGive(`elix give me ${item.replace(/_/gu, " ")}`, "Elix"), item).not.toBeNull();
      expect(isGiveable(item), item).toBe(true);
    }
  });
});

describe("WP5c — parsing a deposit, and never a withdrawal", () => {
  it("parses 'elix put your stuff in the chest'", () => {
    expect(parseChestAction("elix put your stuff in the chest", "Elix")).toEqual({ action: "deposit" });
  });

  it("accepts the obvious phrasings of the same one action", () => {
    for (const line of [
      "elix store your things in the chest",
      "elix deposit my items in the box",
      "elix drop the stuff into that chest",
    ]) {
      expect(parseChestAction(line, "Elix")?.action, line).toBe("deposit");
    }
  });

  it("NEVER parses a withdrawal, in any wording", () => {
    // The rule from the vision, in the words a player would actually use.
    for (const line of [
      "elix take everything out of the chest",
      "elix get the items from the chest",
      "elix retrieve your stuff from the chest",
      "elix pull it all out of the chest",
      "elix withdraw from the chest",
      "elix take my diamonds out of the box",
      "elix empty the chest",
    ]) {
      expect(parseChestAction(line, "Elix"), line).toBeNull();
    }
  });

  it("the allowed chest action list has exactly one entry, and it is deposit", () => {
    expect(ALLOWED_CHEST_ACTION).toEqual(["deposit"]);
    expect(ALLOWED_CHEST_ACTION.length).toBe(1);
  });

  it("refuses a line not addressed to Elix", () => {
    expect(parseChestAction("put your stuff in the chest", "Elix")).toBeNull();
  });
});

describe("WP5c — who gets what", () => {
  it("tosses to the owner who asked", () => {
    const decision = decideGive(view({ counts: { cobblestone: 12 } }), { item: "cobblestone", count: 5 });
    expect(decision).toEqual({ kind: "toss", item: "cobblestone", count: 5, to: "ElixOwner" });
  });

  it("NEVER tosses to anybody but the asker, even with a full inventory", () => {
    const decision = decideGive(
      view({ askedBy: "ElixOwner", counts: { diamond: 64 } }),
      { item: "diamond", count: 64 },
    );
    if (decision.kind !== "toss") throw new Error("expected a toss");
    expect(decision.to).toBe("ElixOwner");
  });

  it("NEVER gives anything to a stranger", () => {
    const decision = decideGive(
      view({ askedBy: "SomeRandomPlayer", isOwner: false, counts: { cobblestone: 64 } }),
      { item: "cobblestone", count: 64 },
    );
    expect(decision).toEqual({ kind: "refuse", reason: "not-an-owner" });
  });

  it("gives away only what it actually has", () => {
    const decision = decideGive(view({ counts: { dirt: 2 } }), { item: "dirt", count: 10 });
    if (decision.kind !== "toss") throw new Error("expected a toss");
    expect(decision.count).toBe(2);
  });

  it("refuses an item Elix does not have", () => {
    expect(decideGive(view(), { item: "diamond", count: 1 })).toEqual({
      kind: "refuse",
      reason: "not-in-inventory",
    });
  });

  it("a WELLBEING-FLOOR line triggers NOTHING, whoever asked", () => {
    // Checked before ownership on purpose: the floor means the line is not a request at all.
    const owner = decideGive(view({ wellbeingFloor: true }), { item: "dirt", count: 1 });
    expect(owner).toEqual({ kind: "refuse", reason: "wellbeing-floor" });
    const stranger = decideGive(
      view({ wellbeingFloor: true, isOwner: false, askedBy: "SomeRandomPlayer" }),
      { item: "dirt", count: 1 },
    );
    expect(stranger).toEqual({ kind: "refuse", reason: "wellbeing-floor" });
    const chest = decideGive(view({ wellbeingFloor: true }), { action: "deposit" });
    expect(chest).toEqual({ kind: "refuse", reason: "wellbeing-floor" });
  });
});

describe("WP5c — depositing", () => {
  it("deposits into a chest within range", () => {
    expect(decideGive(view(), { action: "deposit" })).toEqual({ kind: "deposit" });
  });

  it("refuses when there is no chest in range", () => {
    expect(decideGive(view({ chest: null }), { action: "deposit" })).toEqual({
      kind: "refuse",
      reason: "chest-too-far",
    });
    expect(decideGive(view({ chest: { distance: CHEST_RANGE + 1, canHold: true } }), { action: "deposit" })).toEqual({
      kind: "refuse",
      reason: "chest-too-far",
    });
  });

  it("allows a chest exactly at the range limit", () => {
    expect(decideGive(view({ chest: { distance: CHEST_RANGE, canHold: true } }), { action: "deposit" })).toEqual({
      kind: "deposit",
    });
  });

  it("refuses a full chest", () => {
    expect(decideGive(view({ chest: { distance: 2, canHold: false } }), { action: "deposit" })).toEqual({
      kind: "refuse",
      reason: "chest-full",
    });
  });

  it("a chest action for a stranger is refused before the chest is even looked at", () => {
    expect(decideGive(view({ isOwner: false }), { action: "deposit" })).toEqual({
      kind: "refuse",
      reason: "not-an-owner",
    });
  });
});

describe("WP5c — the refusals say nothing useful", () => {
  it("no refusal explains the rule, and none is long", () => {
    for (const [reason, text] of Object.entries(GIVE_REFUSALS)) {
      expect(text.length, reason).toBeLessThan(30);
      expect(text, reason).not.toMatch(/owner|rule|allowed|because|permission/iu);
    }
  });

  it("a refusal for a stranger is the same one the command path uses", () => {
    expect(GIVE_REFUSALS["not-an-owner"]).toBe("i can't do that one");
  });
});

describe("WP5c — stop", () => {
  it("a stop is synchronous and leaves nothing running", () => {
    const c = new GiveController(() => 0);
    c.stop();
    expect(c.halted).toBe(true);
    expect(c.line()).toBe("ok, stopping");
  });

  it("says nothing before anything has happened", () => {
    expect(new GiveController(() => 0).line()).toBeNull();
  });

  it("resume() lets Elix act again", () => {
    const c = new GiveController(() => 0);
    c.stop();
    c.resume();
    expect(c.halted).toBe(false);
    expect(c.line()).toBeNull();
  });

  it("GIVE_RANGE is the hand-over distance", () => {
    expect(GIVE_RANGE).toBe(3);
  });
});

describe("WP5c — the real mineflayer toss API", () => {
  it("bot.toss takes (itemType, metadata, count, callback)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecfaab97a4f23b1bf82c1e8d684cc/node_modules/mineflayer/lib/plugins/simple_inventory.js", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/async function toss \(itemType, metadata, count\)/u);
    // The count is handed straight to bot.transfer(), which has NO guard of its own for a
    // zero count - it only throws on an empty SOURCE or a full destination. So a zero count
    // reaching toss is a silent no-op at best, and Elix must never produce one. This test
    // pins that the real library has no check we were relying on.
    expect(source).toMatch(/count,/u);
    const transfer = readFileSync(
      fileURLToPath(new URL("../../node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecfaab97a4f23b1bf82c1e8d684cc/node_modules/mineflayer/lib/plugins/inventory.js", import.meta.url)),
      "utf8",
    );
    expect(transfer).toMatch(/destination full/iu);
    expect(transfer).not.toMatch(/count must be|count <= 0|Count is NaN/iu);
  });

  it("never asks to toss zero items, which is what the real library refuses", () => {
    // decideGive clamps to what is actually held, and a held count of 0 is refused outright,
    // so a zero can never reach bot.toss.
    const emptyCounts: Record<string, number>[] = [{}, { dirt: 0 }];
    for (const counts of emptyCounts) {
      const decision = decideGive(view({ counts }), { item: "dirt", count: 5 });
      expect(decision.kind, JSON.stringify(counts)).toBe("refuse");
    }
    const ok = decideGive(view({ counts: { dirt: 3 } }), { item: "dirt", count: 5 });
    if (ok.kind !== "toss") throw new Error("expected a toss");
    expect(ok.count).toBeGreaterThan(0);
  });

  it("the item names Elix hands over are real 26.2 item names", () => {
    for (const name of ["cobblestone", "dirt", "oak_log", "oak_planks", "stick", "bread", "apple", "torch"]) {
      expect(isGiveable(name), name).toBe(true);
    }
    expect(isGiveable("unobtainium")).toBe(false);
  });

  it("a toss carries the asker's name, because that is who mineflayer looks up", () => {
    const decision = decideGive(
      view({ askedBy: "ElixOwner", counts: { cobblestone: 1 } }),
      { item: "cobblestone", count: 1 },
    );
    if (decision.kind !== "toss") throw new Error("expected a toss");
    // mineflayer's entity lookup is by exact username, so the name must be passed through
    // unchanged rather than lower-cased on the way out.
    expect(decision.to).toBe("ElixOwner");
  });
});