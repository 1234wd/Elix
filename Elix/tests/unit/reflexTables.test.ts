/**
 * WP2 acceptance, part 1: the tables.
 *
 * Two of these tests exist to fail loudly on a future Minecraft version, which is the
 * whole reason the tables are hand-written:
 *
 *   - COMPLETENESS. Every armour and melee item in the vendored 26.2 `items.json` must
 *     appear in `ARMOR_POINTS` / `MELEE_DAMAGE`. A missing entry is a decision for the
 *     owner ("verify it or leave it out of auto-equip"), never a silent 0.
 *   - THE WIKI'S OWN TOTALS. The four pieces of each set must sum to the full-set figure
 *     the same wiki page publishes. That is what catches a mistyped number, and it is
 *     also what proves gold really is weaker than chainmail and iron.
 *
 * Every item name below is read from the vendored data, not typed from memory, so a
 * renamed item fails here instead of in game.
 */
import { describe, expect, it } from "vitest";
import {
  ARMOR_POINTS,
  FULL_SET_ARMOR,
  MELEE_DAMAGE,
  armorAndMeleeItemNames,
  armorPointsFor,
  armorSlotFor,
  meleeDamageFor,
} from "../../src/reflexes/tables.js";
import { itemNames } from "../../src/world/mcdata.js";

const NAMES = itemNames();
const { armor, melee } = armorAndMeleeItemNames(NAMES);

describe("WP2 — the verified tables cover vendored 26.2 exactly", () => {
  it("found the data, so the completeness checks below mean something", () => {
    expect(NAMES.length).toBeGreaterThan(500);
    expect(armor.length).toBe(29);
    expect(melee.length).toBe(23);
  });

  it("EVERY armour item in 26.2 has verified points, or is listed for the owner", () => {
    const missing = armor.filter((name) => armorPointsFor(name) === null);
    // If this fails, the missing names are printed so the owner can decide. Elix never
    // guesses a number.
    expect(missing).toEqual([]);
  });

  it("EVERY melee item in 26.2 has verified damage, or is listed for the owner", () => {
    const missing = melee.filter((name) => meleeDamageFor(name) === null);
    expect(missing).toEqual([]);
  });

  it("every verified armour piece maps to a real equip slot", () => {
    const bad = Object.keys(ARMOR_POINTS).filter((name) => armorSlotFor(name) === null);
    expect(bad).toEqual([]);
  });

  it("the four pieces of each set sum to the wiki's own full-set figure", () => {
    // https://minecraft.wiki/w/Armor (accessed 2026-10-06), "Statistics" -> "Full sets".
    for (const [material, total] of Object.entries(FULL_SET_ARMOR)) {
      const pieces = ["helmet", "chestplate", "leggings", "boots"].map(
        (piece) => armorPointsFor(`${material}_${piece}`),
      );
      expect(pieces.every((p): p is number => p !== null), `${material} set is incomplete`).toBe(
        true,
      );
      const sum = (pieces as number[]).reduce((a, b) => a + b, 0);
      expect(sum, `${material} set sums to ${sum}, wiki says ${total}`).toBe(total);
    }
  });

  it("GOLDEN armour never outranks IRON or CHAINMAIL, because it is not better", () => {
    // The bug this guards: a material-tier guess ranked gold above both of these, so Elix
    // would have thrown away a chainmail chestplate for a golden one.
    const pairs: Array<[string, string]> = [
      ["golden_helmet", "iron_helmet"],
      ["golden_chestplate", "iron_chestplate"],
      ["golden_leggings", "iron_leggings"],
      ["golden_boots", "iron_boots"],
      ["golden_chestplate", "chainmail_chestplate"],
      ["golden_leggings", "chainmail_leggings"],
    ];
    for (const [gold, other] of pairs) {
      const g = armorPointsFor(gold) ?? -1;
      const o = armorPointsFor(other) ?? -1;
      expect(g, `${gold} (${g}) must not beat ${other} (${o})`).toBeLessThanOrEqual(o);
    }
  });

  it("a golden sword and a golden axe never out-damage their iron equivalents", () => {
    expect(meleeDamageFor("golden_sword")).toBeLessThanOrEqual(meleeDamageFor("iron_sword") ?? 0);
    expect(meleeDamageFor("golden_axe")).toBeLessThanOrEqual(meleeDamageFor("iron_axe") ?? 0);
  });

  it("the trident and the mace are in the table, because they are both melee", () => {
    expect(melee).toContain("trident");
    expect(melee).toContain("mace");
    expect(meleeDamageFor("trident")).toBe(9);
    expect(meleeDamageFor("mace")).toBe(6);
  });

  it("an unverified item is absent, not zero", () => {
    // Returning 0 for "unknown" would make an unknown item lose every comparison and look
    // verified. Null is the honest answer.
    expect(armorPointsFor("elytra")).toBeNull();
    expect(armorPointsFor("wolf_armor")).toBeNull();
    expect(armorPointsFor("not_a_real_item")).toBeNull();
    expect(meleeDamageFor("bow")).toBeNull();
    expect(meleeDamageFor("shield")).toBeNull();
  });

  it("no verified melee item is also verified armour, and the reverse", () => {
    const both = Object.keys(ARMOR_POINTS).filter((n) => MELEE_DAMAGE[n] !== undefined);
    expect(both).toEqual([]);
    const weaponsAsArmour = Object.keys(MELEE_DAMAGE).filter((n) => ARMOR_POINTS[n] !== undefined);
    expect(weaponsAsArmour).toEqual([]);
  });

  it("every table key is a real 26.2 item, so nothing is dead weight", () => {
    const known = new Set(NAMES);
    expect(Object.keys(ARMOR_POINTS).filter((n) => !known.has(n))).toEqual([]);
    expect(Object.keys(MELEE_DAMAGE).filter((n) => !known.has(n))).toEqual([]);
  });
});