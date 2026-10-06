/**
 * WP5b — craft. Planks, sticks, a crafting table, and the first wooden and stone tools.
 *
 * Crafting is small on purpose. Every recipe Elix knows is in `CRAFTABLE`, and the module's
 * job is to answer three questions honestly:
 *
 *   1. Can Elix make this at all? Only the items listed, from the vendored 26.2 recipes.
 *   2. Does it need a table? A hand can turn a log into planks and two planks into a stick.
 *      Everything else needs one.
 *   3. Where may the table go? Only on a solid block beside Elix, with air above it, and
 *      never inside anybody's walls - checked by `canPlaceTableHere`.
 *
 * The real recipe data is the source for what an item is made of. `needsTable` is the one
 * piece this file knows that the vendored `recipes.json` does not record, because that file
 * is a simplified shape (`inShape` / `ingredients` / `result`, keyed by result id, with no
 * `requiresTable` flag). It is written out explicitly and named, rather than guessed from a
 * recipe's shape.
 */
import { allItems, dataForVersion } from "../world/mcdata.js";

/** One row of the vendored `recipes.json`. */
interface RawRecipe {
  ingredients?: Array<{ item: number; count?: number } | number> | null;
  inShape?: Array<Array<number | null>> | null;
  result: { id: number; count: number };
}

const RECIPES_VERSION = "26.2";

/** Every item in the vendored 26.2 data, by name. */
function namesById(): Map<number, string> {
  const out = new Map<number, string>();
  for (const item of allItems(RECIPES_VERSION)) out.set(item.id, item.name);
  return out;
}

/** Every 26.2 block name Elix will consider standing a crafting table on. */
const UNSAFE_TO_STAND_ON: ReadonlySet<string> = Object.freeze(
  new Set(["air", "cave_air", "void_air", "water", "lava", "fire", "magma_block", "powder_snow", "nether_portal", "end_portal"]),
);

/** A recipe, with real item NAMES rather than ids. */
export interface CraftRecipe {
  /** The item produced. */
  result: string;
  /** How many it makes. */
  count: number;
  /** Shapeless ingredients, when the recipe is shapeless. */
  shapeless: string[] | null;
  /** The grid, when the recipe is shaped. null is a gap. */
  shape: Array<Array<string | null>> | null;
  /** Whether Elix needs a crafting table for this one. */
  needsTable: boolean;
}

/**
 * What Elix may craft.
 *
 * Every entry is checked against the vendored 26.2 recipes in the tests, so a typo here is a
 * test failure rather than a bot that says "done" and produces nothing.
 */
export const CRAFTABLE: readonly string[] = Object.freeze([
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "cherry_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "wooden_axe",
  "wooden_sword",
  "stone_pickaxe",
  "stone_axe",
  "stone_sword",
]);

/** Items a bare hand can make. Everything else needs a table. */
const HAND_CRAFTABLE: ReadonlySet<string> = Object.freeze(
  new Set(["oak_planks", "spruce_planks", "birch_planks", "jungle_planks", "acacia_planks", "cherry_planks", "dark_oak_planks", "mangrove_planks", "stick"]),
);

/** True when this item needs a crafting table. */
export function needsTable(item: string): boolean {
  return !HAND_CRAFTABLE.has(item);
}

/** True when Elix may craft this at all. */
export function isCraftable(item: string): boolean {
  return CRAFTABLE.includes(item);
}

/** The recipe for an item, from the vendored data, or null when there is none. */
export function recipeFor(item: string): CraftRecipe | null {
  const data = dataForVersion(RECIPES_VERSION);
  if (data === null) return null;
  const byName = namesById();
  const def = data.itemsByName[item];
  if (def === undefined) return null;
  // `recipes.json` is keyed by the RESULT's id, and each key holds an array of recipes.
  const raw = (data as unknown as { recipes?: Record<string, RawRecipe[]> }).recipes?.[
    String(def.id)
  ];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const row = raw[0];
  if (row === undefined) return null;
  const shape =
    Array.isArray(row.inShape) && row.inShape.length > 0
      ? row.inShape.map((line) => line.map((id) => (id === null ? null : (byName.get(id) ?? `id:${id}`))))
      : null;
  const shapeless =
    Array.isArray(row.ingredients) && row.ingredients.length > 0
      ? row.ingredients.map((entry) => {
          if (typeof entry === "number") return byName.get(entry) ?? `id:${entry}`;
          const id = entry?.item;
          return byName.get(id) ?? `id:${id}`;
        })
      : null;
  if (shape === null && shapeless === null) return null;
  return { result: byName.get(row.result.id) ?? item, count: row.result.count, shapeless, shape, needsTable: needsTable(item) };
}

/** Blocks a crafting table must never be placed on. */
export function isUnsafeToStandOn(name: string): boolean {
  return UNSAFE_TO_STAND_ON.has(name);
}

/**
 * May a crafting table go here?
 *
 * Three checks, all of them about not breaking somebody's house: the block underneath has to
 * be solid, the space above has to be free, and Elix has to be able to stand next to it.
 */
export function canPlaceTableHere(standOn: string | null, above: string | null, roomAround: boolean): boolean {
  if (standOn === null || above === null) return false;
  if (isUnsafeToStandOn(standOn)) return false;
  if (!isUnsafeToStandOn(above)) return false; // something is already there
  return roomAround;
}

/** Words a player uses, mapped to the real 26.2 item name. */
export const CRAFT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  planks: "oak_planks",
  plank: "oak_planks",
  sticks: "stick",
  crafting_table: "crafting_table",
  table: "crafting_table",
  pickaxe: "wooden_pickaxe",
  axe: "wooden_axe",
  sword: "wooden_sword",
});

/** A craft request, as parsed from one line. */
export interface CraftRequest {
  item: string;
  count: number;
}

/** Common words, mapped to the real 26.2 item name. */
export function craftRequest(message: string, botName: string): CraftRequest | null {
  const normalised = message.toLowerCase().replace(/\s+/gu, " ").trim();
  const escaped = botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u").test(normalised)) return null;
  let rest = normalised.replace(new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u"), " ").trim();
  rest = rest.replace(/\b(please|pls|plz|now|bro|yaar|ok|okay)\b/gu, " ").replace(/\s+/gu, " ").trim();
  const m = /^(?:craft|make|build|put together)\s+(?:me\s+)?(?:(\d+)\s+)?(?:(?:a|an|some)\s+)?([a-z_ ]+)$/u.exec(rest);
  if (m === null) return null;
  const word = (m[2] ?? "").trim();
  // "stone pickaxe" and "stone_pickaxe" are the same request. Item names use underscores,
  // players do not, so the gap is normalised before the lookup - otherwise the parser
  // silently refuses the most natural way to ask.
  const asItemName = word.replace(/\s+/gu, "_");
  const item = CRAFT_WORDS[word] ?? CRAFT_WORDS[asItemName] ?? asItemName;
  if (!isCraftable(item)) return null;
  const count = Math.max(1, Math.min(64, Number.parseInt(m[1] ?? "1", 10) || 1));
  return { item, count };
}

/** The step a craft run is on. */
export type CraftStep =
  | { kind: "idle" }
  | { kind: "place-table"; at: { x: number; y: number; z: number } }
  | { kind: "crafting"; item: string; count: number; withTable: boolean }
  | { kind: "collect-table" }
  | { kind: "done"; item: string; count: number }
  | { kind: "refused"; reason: CraftRefusal }
  | { kind: "stopped" };

export type CraftRefusal = "not-craftable" | "no-table-spot" | "no-recipe" | "missing-materials";

/** Everything the controller needs, and nothing it does not. */
export interface CraftWorld {
  /** The block under the spot Elix is considering, or null when he cannot see it. */
  blockBelow: { name: string } | null;
  /** The block in the spot itself. */
  blockAbove: { name: string } | null;
  /** Is there room beside Elix to stand while it crafts? */
  roomAround: boolean;
  /** Does Elix have this crafting table already? */
  hasTable: boolean;
  /** Where the table would go, if it has to be placed. Real coordinates, from the caller. */
  spot: { x: number; y: number; z: number };
  /** How many of the ingredient items Elix has, by name. */
  counts: Record<string, number>;
}

/**
 * The whole craft plan, as a pure function.
 *
 * Returning a LIST of steps rather than performing them is what makes the "place the table,
 * craft, pick the table up again" sequence testable without a server, and what makes a stop
 * at step two leave nothing behind: the plan is just data, and the controller only tracks
 * which step it is on.
 */
export function planCraft(request: CraftRequest, world: CraftWorld): { steps: CraftStep[]; refusal: CraftRefusal | null } {
  if (!isCraftable(request.item)) return { steps: [], refusal: "not-craftable" };
  const recipe = recipeFor(request.item);
  if (recipe === null) return { steps: [], refusal: "no-recipe" };

  const steps: CraftStep[] = [];
  const withTable = recipe.needsTable;
  if (withTable) {
    if (!world.hasTable) {
      if (!world.roomAround || !canPlaceTableHere(world.blockBelow?.name ?? null, world.blockAbove?.name ?? null, world.roomAround)) {
        return { steps: [], refusal: "no-table-spot" };
      }
      // The real spot, from the caller. A placeholder here would place a table at the
      // origin, which on a real server is somebody's chest room.
      steps.push({ kind: "place-table", at: { ...world.spot } });
    }
    steps.push({ kind: "crafting", item: request.item, count: request.count, withTable: true });
    // Always put the table back the way it was: Elix does not leave furniture behind.
    if (!world.hasTable) steps.push({ kind: "collect-table" });
  } else {
    steps.push({ kind: "crafting", item: request.item, count: request.count, withTable: false });
  }
  steps.push({ kind: "done", item: request.item, count: request.count });
  return { steps, refusal: null };
}

/**
 * The stateful half: which step, and the stop.
 *
 * No mineflayer reference, for the same reason as WP5a: a synchronous stop is only possible
 * when there is nothing in here to await.
 */
export class CraftController {
  private steps: CraftStep[] = [];
  private at = 0;
  private stopped = false;
  private end: CraftStep = { kind: "idle" };
  /** What this run was asked for, so the terminal step is not a guess. */
  private wanted: { item: string; count: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Where the run has got to. */
  get state(): CraftStep {
    return this.end.kind !== "idle" ? this.end : (this.steps[this.at] ?? { kind: "idle" });
  }

  /** The full plan, so a caller can see what is coming. */
  get plan(): CraftStep[] {
    return [...this.steps];
  }

  /** Load a plan, and remember what it was for. */
  load(
    plan: { steps: CraftStep[]; refusal: CraftRefusal | null },
    wanted: { item: string; count: number },
  ): CraftStep {
    this.stopped = false;
    this.wanted = wanted;
    if (plan.refusal !== null) {
      this.steps = [];
      this.at = 0;
      this.end = { kind: "refused", reason: plan.refusal };
      return this.end;
    }
    this.steps = plan.steps;
    this.at = 0;
    this.end = { kind: "idle" };
    return this.state;
  }

  /** One step forward. Returns the step that was just completed, or null at the end. */
  advance(): CraftStep | null {
    if (this.stopped) return null;
    const current = this.steps[this.at];
    if (current === undefined) return null;
    this.at += 1;
    const next = this.steps[this.at];
    if (next === undefined) {
      // The plan ran out. When the last step WAS the terminal one, use it; otherwise close
      // the run with what was actually asked for, never a placeholder.
      this.end =
        current.kind === "done"
          ? current
          : { kind: "done", item: this.wanted?.item ?? "nothing", count: this.wanted?.count ?? 0 };
      return current;
    }
    return current;
  }

  /** `elix stop`. Synchronous; nothing is left half-done because nothing is held. */
  stop(): CraftStep {
    this.stopped = true;
    this.steps = [];
    this.at = 0;
    this.end = { kind: "stopped" };
    return this.end;
  }

  /** Allow a new craft. The caller decides when. */
  resume(): void {
    this.stopped = false;
    if (this.end.kind === "stopped") this.end = { kind: "idle" };
  }
}