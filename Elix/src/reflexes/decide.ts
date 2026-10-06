/**
 * Survival reflexes — the decisions, with nothing in them.
 *
 * Every function here is pure: it reads a view of the world and returns what Elix should
 * do about it. No mineflayer, no timers, no logging, no `bot`. That is what makes the
 * reflexes testable without a server and what makes the priority order in `decideReflex`
 * readable in one place.
 *
 * Priority is fixed and total, highest first:
 *
 *   1. breathe  - oxygen running out in water
 *   2. creeper  - a creeper about to go off
 *   3. hazards  - lava and falls (decided in bot.ts, which already owns block reads)
 *   4. eat      - food running out, when nothing is about to kill Elix
 *   5. armour   - pick up what was just collected
 *
 * A higher reflex interrupts a lower one AND interrupts follow or a skill. Follow resumes
 * afterwards if it was active - `runner.ts` owns that, because resuming is state, not a
 * decision.
 *
 * Nothing here talks to the owner. `stop` cancels through `runner.ts`, which is the only
 * thing that holds state.
 */
import { Vec3 } from "vec3";
import { foodQuality } from "../world/mcdata.js";
import { armorPointsFor, armorRank, armorSlotFor, meleeDamageFor, type EquipSlot } from "./tables.js";

/** A position, in the shape mineflayer and `vec3` agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Mineflayer-Entity-shaped, minus anything the decision does not read. */
export interface CreatureLike {
  /** mineflayer entity id; -1 until the server assigns one. */
  id?: number;
  name: string;
  /** Present on mineflayer entities; absent on some fake players. */
  type?: string;
  position: Vec3Like;
  isValid?: boolean;
  health?: number;
}

/** One stack in the inventory. Counts are stack sizes, not slots. */
export interface StackLike {
  name: string;
  count: number;
}

/** What the reflexes can see. Assembled by `runner.ts` from the real bot. */
export interface ReflexView {
  position: Vec3Like;
  inWater: boolean;
  /** 0-300 while breathing, and 300 at full air. mineflayer's `bot.oxygenLevel`. */
  oxygenLevel: number;
  /** 0-20. mineflayer's `bot.food`. */
  food: number;
  /** Nearest hostile mob, with its distance already computed. */
  hostile: { name: string; distance: number } | null;
  /** Nearest creeper and where it is, for the flee direction. */
  creeper: { name: string; distance: number; position: Vec3Like } | null;
  inventory: StackLike[];
  /** What is worn and held, by item name; null or absent means the slot is empty. */
  equipped: Partial<Record<EquipSlot, string | null>>;
}

/** What Elix should do, right now, about survival. */
export type ReflexAction =
  | { kind: "swim-up"; oxygen: number }
  | { kind: "flee"; from: string; distance: number; target: Vec3; threat: string }
  | { kind: "eat"; item: string; count: number }
  | { kind: "equip"; item: string; slot: EquipSlot; replaces: string | null }
  | { kind: "none" };

/** Which reflex produced a decision. */
export type ReflexName = "breathe" | "creeper" | "hazards" | "eat" | "armour";

/** Oxygen at or below this, while in water, means swim up. Of 300. */
export const LOW_OXYGEN = 120;

/** A creeper this close starts a retreat. */
export const CREEPER_FLEE_AT = 4;

/** How far from a creeper Elix stops retreating. */
export const CREEPER_SAFE_AT = 7;

/** Food at or below this, and nothing dangerous nearby, starts eating. */
export const EAT_AT_FOOD = 14;

/** With no hostile closer than this, eating is safe. */
export const SAFE_TO_EAT_RADIUS = 6;

/**
 * Food at or below this, and nothing else in the bag, allows the risky food below.
 *
 * Rotting flesh will not kill Elix outright, but eating it while starving is how a bad
 * night becomes a dead bot, so it is a last resort and not a routine meal.
 */
export const DANGEROUS_FOOD_AT_FOOD = 4;

/**
 * Food Elix will not eat while there is anything else.
 *
 * Names are the vendored 26.2 item names. `chicken` is raw chicken - there is no
 * `raw_chicken` item in the game.
 */
export const RISKY_FOOD: ReadonlySet<string> = Object.freeze(
  new Set([
    "rotten_flesh",
    "spider_eye",
    "poisonous_potato",
    "pufferfish",
    "chicken",
    "suspicious_stew",
  ]),
);

/** True when the entity name is a creeper, without a hard-coded mob list elsewhere. */
export function isCreeper(entity: CreatureLike): boolean {
  return entity.name === "creeper" || entity.type === "creeper";
}

/** 1. breathe: oxygen running out, in water. Nothing else gets a look in. */
export function decideBreathe(view: ReflexView): ReflexAction {
  if (!view.inWater) return { kind: "none" };
  if (view.oxygenLevel > LOW_OXYGEN) return { kind: "none" };
  return { kind: "swim-up", oxygen: view.oxygenLevel };
}

/**
 * 2. creeper: back away to CREEPER_SAFE_AT.
 *
 * Never a melee and never a fight - a creeper is only ever a direction to leave.
 */
export function decideCreeper(view: ReflexView): ReflexAction {
  const creeper = view.creeper;
  if (!creeper) return { kind: "none" };
  if (creeper.distance > CREEPER_FLEE_AT) return { kind: "none" };
  // Away from the creeper, in the horizontal plane, so Elix does not swim into lava or
  // drop off a cliff escaping a blast. Vertical movement is the hazard reflex's job.
  const away = new Vec3(view.position.x - creeper.position.x, 0, view.position.z - creeper.position.z);
  if (away.norm() < 1e-9) {
    // Same block: pick one deterministic direction rather than a random one, so a test can
    // assert it and a crash is reproducible.
    away.set(1, 0, 0);
  }
  away.normalize().scale(CREEPER_SAFE_AT - creeper.distance);
  return {
    kind: "flee",
    from: creeper.name,
    distance: creeper.distance,
    threat: "creeper",
    target: new Vec3(view.position.x + away.x, view.position.y, view.position.z + away.z),
  };
}

/**
 * 4. eat: the best food in the bag, ranked by `foods.json` `effectiveQuality`.
 *
 * Three gates, all of which must pass:
 *   - food at or below EAT_AT_FOOD;
 *   - nothing hostile within SAFE_TO_EAT_RADIUS (standing still to chew while a zombie
 *     hits Elix is not eating, it is dying slowly);
 *   - not already full, which is also mineflayer's own precondition - `bot.consume()`
 *     throws `Food is full` at food 20.
 *
 * Risky food only below DANGEROUS_FOOD_AT_FOOD and only when nothing else is edible.
 */
export function decideEat(view: ReflexView, version?: string): ReflexAction {
  if (view.food > EAT_AT_FOOD) return { kind: "none" };
  // The real library throws "Food is full" at 20, so never start an eat we cannot finish.
  if (view.food >= 20) return { kind: "none" };
  const hostile = view.hostile;
  if (hostile && hostile.distance <= SAFE_TO_EAT_RADIUS) return { kind: "none" };

  const safe = bestFood(view, version, false);
  if (safe) return { kind: "eat", item: safe.name, count: safe.count };
  if (view.food <= DANGEROUS_FOOD_AT_FOOD) {
    const risky = bestFood(view, version, true);
    if (risky) return { kind: "eat", item: risky.name, count: risky.count };
  }
  return { kind: "none" };
}

/** Highest `effectiveQuality` in the bag, optionally only from the risky list. */
function bestFood(
  view: ReflexView,
  version: string | undefined,
  wantRisky: boolean,
): StackLike | null {
  let best: StackLike | null = null;
  let bestScore = -1;
  for (const stack of view.inventory) {
    if (!stack || stack.count <= 0) continue;
    const risky = RISKY_FOOD.has(stack.name);
    if (risky !== wantRisky) continue;
    const score = version === undefined ? foodQuality(stack.name) : foodQuality(stack.name, version);
    // 0 means "this version's data says it is not food" - never eat on a 0.
    if (score <= 0) continue;
    if (score > bestScore) {
      bestScore = score;
      best = stack;
    }
  }
  return best;
}

/**
 * 5. armour: equip something better than what is worn or held.
 *
 * Never unequips: if the held weapon already out-damages the candidate, the decision is
 * `none` and the item stays in the bag. An item absent from the tables has no verified
 * points or damage, so it is never equipped - not at 0, not at all.
 */
export function decideArmour(view: ReflexView): ReflexAction {
  for (const slot of ARMOUR_SLOTS) {
    const worn = view.equipped[slot] ?? null;
    const wornRank = worn === null ? -1 : (armorRank(worn) ?? -1);
    let bestName: string | null = null;
    let bestRank = wornRank;
    let bestPoints = worn === null ? -1 : (armorPointsFor(worn) ?? -1);
    for (const stack of view.inventory) {
      if (!stack || stack.count <= 0) continue;
      const itemSlot = armorSlotFor(stack.name);
      if (itemSlot !== slot) continue;
      const points = armorPointsFor(stack.name);
      if (points === null) continue; // unverified: never auto-equip
      const rank = armorRank(stack.name);
      if (rank === null || rank <= bestRank) continue;
      bestName = stack.name;
      bestRank = rank;
      bestPoints = points;
    }
    if (bestName !== null) {
      return { kind: "equip", item: bestName, slot, replaces: worn };
    }
    void bestPoints;
  }
  // The weapon is the one slot where the ranking key is damage, not points.
  const held = view.equipped.hand ?? null;
  const heldDamage = held === null ? -1 : (meleeDamageFor(held) ?? -1);
  let bestWeapon: string | null = null;
  let bestDamage = heldDamage;
  for (const stack of view.inventory) {
    if (!stack || stack.count <= 0) continue;
    const damage = meleeDamageFor(stack.name);
    if (damage === null) continue;
    if (damage > bestDamage) {
      bestWeapon = stack.name;
      bestDamage = damage;
    }
  }
  if (bestWeapon !== null) {
    return { kind: "equip", item: bestWeapon, slot: "hand", replaces: held };
  }
  return { kind: "none" };
}

/** Armour slots, in the order they are checked. Helmet first: it protects the head. */
export const ARMOUR_SLOTS: readonly EquipSlot[] = Object.freeze(["head", "torso", "legs", "feet"]);

/**
 * The whole reflex ladder, in order.
 *
 * `hazards` has no decision function here: lava and falls need block reads that bot.ts
 * already owns (`stopForHazard`), and duplicating them would give two answers to one
 * question. It is placed in the order so anything inserted before it keeps its priority.
 */
export function decideReflex(view: ReflexView): { reflex: ReflexName; action: ReflexAction } {
  const breathe = decideBreathe(view);
  if (breathe.kind !== "none") return { reflex: "breathe", action: breathe };

  const creeper = decideCreeper(view);
  if (creeper.kind !== "none") return { reflex: "creeper", action: creeper };

  // hazards: decided in bot.ts, which is the only place that can read blocks.

  const eat = decideEat(view);
  if (eat.kind !== "none") return { reflex: "eat", action: eat };

  const armour = decideArmour(view);
  if (armour.kind !== "none") return { reflex: "armour", action: armour };

  return { reflex: "hazards", action: { kind: "none" } };
}