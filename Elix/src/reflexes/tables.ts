/**
 * Armour points and melee damage, from the Minecraft Wiki.
 *
 * These numbers are NOT in minecraft-data. `items.json` carries only `enchantCategories`,
 * `repairWith` and `maxDurability` - no armour points, no attack damage - so an explicit,
 * sourced table is the honest way to rank what Elix picks up.
 *
 * SOURCES (fetched with the web tool, accessed 2026-10-06):
 *   Armour points  https://minecraft.wiki/w/Armor      section "Statistics" (per-piece tables)
 *   Sword damage   https://minecraft.wiki/w/Sword     section "Java Edition", row "Attack damage"
 *   Axe damage     https://minecraft.wiki/w/Axe       section "Unenchanted", column "Attack damage"
 *   Mace damage    https://minecraft.wiki/w/Mace      section "Unenchanted normal attack"
 *   Spear damage   https://minecraft.wiki/w/Spear     section "Unenchanted jab attack"
 *   Trident damage https://minecraft.wiki/w/Trident   section "Unenchanted", row "Melee"
 *
 * Two rules keep this table honest:
 *
 *   1. NO GUESSED NUMBERS. An item whose value could not be read off the wiki is absent
 *      here, and an absent item is never auto-equipped (see `armorPointsFor` /
 *      `meleeDamageFor`, which return null rather than 0). `tests/unit/reflexTables.test.ts`
 *      fails if a 26.2 armour or melee item is missing, so a future item is a loud test
 *      failure and a decision for the owner - never a silent 0.
 *
 *   2. THE WIKI'S OWN TOTALS CROSS-CHECK THESE VALUES. `FULL_SET_ARMOR` is what the same
 *      page lists for a complete set, and `tests/unit/reflexTables.test.ts` asserts the
 *      four pieces sum to it. Copper 2+4+3+1 = 10, gold 2+5+3+1 = 11, chainmail 12,
 *      iron 15, diamond 20, netherite 20 - all of which match the page, which is also how
 *      we know gold is genuinely weaker than chainmail and iron.
 */
import type { ItemDef } from "../world/mcdata.js";

/** Where Elix equips a piece, using mineflayer's own destination names. */
export type EquipSlot = "head" | "torso" | "legs" | "feet" | "hand";

/** Which item name maps to which slot, from the item's own name suffix. */
const SLOT_BY_SUFFIX: ReadonlyArray<readonly [RegExp, EquipSlot]> = [
  [/_helmet$/u, "head"],
  [/_chestplate$/u, "torso"],
  [/_leggings$/u, "legs"],
  [/_boots$/u, "feet"],
];

/**
 * Armour points per piece, and armour toughness.
 *
 * Verified against https://minecraft.wiki/w/Armor (accessed 2026-10-06), the per-piece
 * tables under "Statistics".
 */
export const ARMOR_POINTS: Readonly<Record<string, { points: number; toughness: number }>> =
  Object.freeze({
    leather_helmet: { points: 1, toughness: 0 },
    leather_chestplate: { points: 3, toughness: 0 },
    leather_leggings: { points: 2, toughness: 0 },
    leather_boots: { points: 1, toughness: 0 },
    // Copper is new in 1.21.9 and IS documented on that page (full set = 10).
    copper_helmet: { points: 2, toughness: 0 },
    copper_chestplate: { points: 4, toughness: 0 },
    copper_leggings: { points: 3, toughness: 0 },
    copper_boots: { points: 1, toughness: 0 },
    golden_helmet: { points: 2, toughness: 0 },
    golden_chestplate: { points: 5, toughness: 0 },
    golden_leggings: { points: 3, toughness: 0 },
    golden_boots: { points: 1, toughness: 0 },
    chainmail_helmet: { points: 2, toughness: 0 },
    chainmail_chestplate: { points: 5, toughness: 0 },
    chainmail_leggings: { points: 4, toughness: 0 },
    chainmail_boots: { points: 1, toughness: 0 },
    iron_helmet: { points: 2, toughness: 0 },
    iron_chestplate: { points: 6, toughness: 0 },
    iron_leggings: { points: 5, toughness: 0 },
    iron_boots: { points: 2, toughness: 0 },
    diamond_helmet: { points: 3, toughness: 2 },
    diamond_chestplate: { points: 8, toughness: 2 },
    diamond_leggings: { points: 6, toughness: 2 },
    diamond_boots: { points: 3, toughness: 2 },
    netherite_helmet: { points: 3, toughness: 3 },
    netherite_chestplate: { points: 8, toughness: 3 },
    netherite_leggings: { points: 6, toughness: 3 },
    netherite_boots: { points: 3, toughness: 3 },
    // "The turtle shell ... is between iron and diamond, having equal armor points"
    turtle_helmet: { points: 2, toughness: 0 },
  });

/**
 * What the same wiki page lists for a COMPLETE set. Used as a cross-check, never as a
 * source: if the four pieces stop summing to these, a value above was mistyped.
 */
export const FULL_SET_ARMOR: Readonly<Record<string, number>> = Object.freeze({
  leather: 7,
  copper: 10,
  golden: 11,
  chainmail: 12,
  iron: 15,
  diamond: 20,
  netherite: 20,
});

/**
 * Melee attack damage, unenchanted, no critical.
 *
 * Verified against the pages listed at the top of this file (accessed 2026-10-06):
 *   swords, in the page's own column order Wooden, Golden, Stone, Copper, Iron, Diamond,
 *   Netherite: 4, 4, 5, 5, 6, 7, 8
 *   axes: wooden 7, golden 7, stone 9, copper 9, iron 9, diamond 9, netherite 10
 *   mace 6; trident 9 melee
 *   spears (jab): wooden 1, golden 1, stone 2, copper 2, iron 3, diamond 4, netherite 5
 */
export const MELEE_DAMAGE: Readonly<Record<string, number>> = Object.freeze({
  wooden_sword: 4,
  golden_sword: 4,
  stone_sword: 5,
  copper_sword: 5,
  iron_sword: 6,
  diamond_sword: 7,
  netherite_sword: 8,

  wooden_axe: 7,
  golden_axe: 7,
  stone_axe: 9,
  copper_axe: 9,
  iron_axe: 9,
  diamond_axe: 9,
  netherite_axe: 10,

  mace: 6,

  wooden_spear: 1,
  golden_spear: 1,
  stone_spear: 2,
  copper_spear: 2,
  iron_spear: 3,
  diamond_spear: 4,
  netherite_spear: 5,

  trident: 9,
});

/** Armour points for one item, or null when the item is not verified armour. */
export function armorPointsFor(name: string): number | null {
  const found = ARMOR_POINTS[name];
  return found === undefined ? null : found.points;
}

/** Armour toughness for one item, or null. */
export function armorToughnessFor(name: string): number | null {
  const found = ARMOR_POINTS[name];
  return found === undefined ? null : found.toughness;
}

/** Melee attack damage for one item, or null when the item is not a verified weapon. */
export function meleeDamageFor(name: string): number | null {
  const found = MELEE_DAMAGE[name];
  return found === undefined ? null : found;
}

/** Which slot this item belongs in, or null when it is not verified armour. */
export function armorSlotFor(name: string): EquipSlot | null {
  if (ARMOR_POINTS[name] === undefined) return null;
  for (const [suffix, slot] of SLOT_BY_SUFFIX) {
    if (suffix.test(name)) return slot;
  }
  // The turtle helmet is the one item whose name does not end in _helmet.
  return name === "turtle_helmet" ? "head" : null;
}

/** True when this item is a weapon Elix may hold. */
export function isMeleeWeapon(name: string): boolean {
  return MELEE_DAMAGE[name] !== undefined;
}

/**
 * Comparison key for armour in one slot: points first, toughness as the tie-break.
 *
 * Gold and chainmail both give 2 points in the helmet slot, and so does a turtle helmet,
 * so a pure "points" comparison cannot order them. Points then toughness still cannot
 * separate gold from chainmail, which is why the test for gold-never-beats-iron is a
 * point comparison against real pieces rather than a tier guess.
 */
export function armorRank(name: string): number | null {
  const found = ARMOR_POINTS[name];
  return found === undefined ? null : found.points * 1000 + found.toughness;
}

/**
 * Every armour item and melee item in the vendored 26.2 `items.json`.
 *
 * Detection is by NAME SHAPE, not by `enchantCategories`, because the categories are not
 * a reliable equipment test: in 26.2 `iron_helmet` is tagged `head_armor` but
 * `diamond_chestplate` carries only `equippable`, `armor`, `durability`, `vanishing` -
 * no `chest_armor` at all. So a category-based completeness test would have skipped every
 * chestplate in the game and reported green.
 */
export function armorAndMeleeItemNames(
  allItemNames: readonly string[],
): { armor: string[]; melee: string[] } {
  const armor: string[] = [];
  const melee: string[] = [];
  for (const name of allItemNames) {
    if (/_helmet$|_chestplate$|_leggings$|_boots$/u.test(name)) armor.push(name);
    if (/_sword$|_axe$|_mace$|_spear$/u.test(name) || name === "mace") melee.push(name);
  }
  if (allItemNames.includes("trident")) melee.push("trident");
  return { armor, melee };
}

/** The item's own name, when the runtime value really is an item-ish object. */
export function itemNameOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const named = value as { name?: unknown };
  return typeof named.name === "string" ? named.name : null;
}

/** True when `item` is the vendored 26.2 item of that name. Used by the tests, not the reflex. */
export function isVendoredItem(item: ItemDef | null, name: string): boolean {
  return item !== null && item.name === name;
}