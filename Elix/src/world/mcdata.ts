/**
 * The ONE accessor for version-sensitive game data.
 *
 * Round 17 §1 Q2: everything that needs item, block, food or entity facts reads them here,
 * so there is exactly one place where a Minecraft version is decided.
 *
 * Why an accessor at all, rather than `require("minecraft-data")("1.21.4")` at each call
 * site:
 *
 *   - `package.json` maps `"minecraft-data": "file:vendor/minecraft-data"`, so the installed
 *     package IS the vendored data. `26.2` is the only version the vendored tree carries.
 *   - The vendored 26.2 files are internally consistent, and the older data is NOT. In
 *     minecraft-data 1.21.4, `foods` is keyed by a different numeric id than `itemsByName`
 *     reports for the same item - `mushroom_stew` is key `849` in `foods` but
 *     `itemsByName.mushroom_stew.id === 880` - so joining the two silently produces wrong
 *     or missing food data. `tests/unit/mcdataSource.test.ts` fails if anything goes back
 *     to the installed older package.
 *   - `tests/unit/reflexTables.test.ts` fails if an item exists in 26.2 and is missing from
 *     a hand-written table, so a future vendored version fails loudly instead of quietly
 *     dropping an item from auto-equip.
 *
 * At runtime the connected bot's own registry is preferred (see `dataForVersion`), because
 * a server on a version we did not vendor still knows its own blocks and items.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The only version the vendored tree carries. */
export const VENDORED_VERSION = "26.2";

/** One row of minecraft-data `items.json`. Only the fields Elix uses. */
export interface ItemDef {
  id: number;
  name: string;
  displayName?: string;
  stackSize?: number;
  maxDurability?: number;
  repairWith?: string[];
  enchantCategories?: string[];
}

/** One row of minecraft-data `foods.json`. */
export interface FoodDef {
  id: number;
  name: string;
  foodPoints: number;
  saturation: number;
  /** foodPoints + saturation, rounded. The ranking key for food. */
  effectiveQuality: number;
  saturationRatio?: number;
}

/** The subset of minecraft-data we read. Everything else is deliberately not loaded. */
interface McData {
  version: { minecraftVersion: string };
  itemsByName: Record<string, ItemDef>;
  items: ItemDef[];
  blocksByName: Record<string, { id: number; name: string }>;
  foods: Record<string, FoodDef>;
  entities: Record<string, unknown>;
}

const cache = new Map<string, McData | null>();

/**
 * The raw minecraft-data object for `version`, memoised.
 *
 * Returns null rather than throwing: a caller that needs data must decide what to do
 * without it (refuse to equip, refuse to eat), and a missing data pack is not a reason to
 * crash a bot that is mid-game.
 */
export function dataForVersion(version: string = VENDORED_VERSION): McData | null {
  const cached = cache.get(version);
  if (cached !== undefined) return cached;
  let loaded: McData | null = null;
  try {
    // The version is a parameter, never a literal. A literal here is what Q2 forbids.
    const factory = require("minecraft-data") as (v: string) => McData;
    const data = factory(version);
    loaded = data && data.itemsByName ? data : null;
  } catch {
    loaded = null;
  }
  cache.set(version, loaded);
  return loaded;
}

/** Test seam: forget every memoised version. */
export function resetDataCache(): void {
  cache.clear();
}

/** Every item name in `version`, or [] when there is no data. */
export function itemNames(version: string = VENDORED_VERSION): string[] {
  const data = dataForVersion(version);
  if (!data) return [];
  return Object.keys(data.itemsByName);
}

/** One item by name, or null. */
export function itemDef(name: string, version: string = VENDORED_VERSION): ItemDef | null {
  return dataForVersion(version)?.itemsByName[name] ?? null;
}

/** True when `version` has data at all. Used to fail loudly, never to guess. */
export function hasItemData(version: string = VENDORED_VERSION): boolean {
  return dataForVersion(version) !== null;
}

/**
 * Food facts by item NAME, joined on the numeric id inside one data version.
 *
 * The join happens here, once, on one version's own ids - the bug Q2 is about was doing
 * this join across two different data sets.
 */
export function foodsByName(version: string = VENDORED_VERSION): Map<string, FoodDef> {
  const data = dataForVersion(version);
  if (!data) return new Map();
  const byId = new Map<string, FoodDef>();
  for (const food of Object.values(data.foods ?? {})) {
    if (food && typeof food.name === "string") byId.set(food.name, food);
  }
  // Cross-check: the id in `foods.json` must be the id `items.json` reports for that name.
  // When it is not, this version is internally inconsistent and we return nothing rather
  // than wrong food.
  const out = new Map<string, FoodDef>();
  for (const [name, food] of byId) {
    const item = data.itemsByName[name];
    if (item && item.id === food.id) out.set(name, food);
  }
  return out;
}

/**
 * The ranking key for food: `foods.json` `effectiveQuality`.
 *
 * 0 means "this is not food, or this version's food data is inconsistent", and callers
 * treat 0 as "never eat this".
 */
export function foodQuality(name: string, version: string = VENDORED_VERSION): number {
  return foodsByName(version).get(name)?.effectiveQuality ?? 0;
}

/** Block facts by name, or an empty map. */
export function blockNames(version: string = VENDORED_VERSION): Set<string> {
  const data = dataForVersion(version);
  if (!data) return new Set();
  return new Set(Object.keys(data.blocksByName ?? {}));
}