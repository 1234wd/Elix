/**
 * Hazard and walking decisions: lava, falls, and where it is safe to step.
 *
 * WP11 - moved out of `bot.ts` verbatim. Not one line of behaviour changed; the only edit is
 * the imports below, and `bot.ts` re-exports every name here so that every existing import
 * path - in `src/` and in all 40-odd test files - keeps working untouched.
 *
 * The rule this file exists to keep honest: mineflayer's shape is read through RUNTIME
 * GUARDS, never through a cast. A fake bot and a real bot do not agree on which fields exist,
 * and these run on a 50 ms tick where a throw takes the bot down.
 */
import { Vec3 } from "vec3";
import { blockName } from "./safeWorld.js";
import type { BlockLike, BotLike, Vec3Like } from "./bot.js";
export const WALK_DISTANCES = [
  { dx: 10, dz: 0, name: "+x" },
  { dx: -10, dz: 0, name: "-x" },
  { dx: 0, dz: 10, name: "+z" },
  { dx: 0, dz: -10, name: "-z" },
] as const;

export type WalkSkipReason = "no-entity" | "no-safe-direction";

export interface WalkOutcome {
  walked: boolean;
  reason?: WalkSkipReason;
  direction?: string;
}

/**
 * Blocks that must never be walked onto or through (A10, corrected in A1).
 *
 * Every name here is verified against vendor/minecraft-data/data/pc/26.2/
 * blocks.json by a unit test — a typo or an invented name would silently never
 * match, which is how `flowing_lava` and `sulfur_vent` got in before.
 *
 * Deliberately NOT hazards, despite looking alarming:
 *
 *   sulfur, cinnabar, sulfur_bricks, cinnabar_bricks
 *     Ordinary solid blocks (boundingBox "block"). Sulfur is the main rock of
 *     sulfur caves; treating it as a hazard would make those caves
 *     unnavigable and break the explore-sulfur-caves goal.
 *     https://minecraft.wiki/w/Sulfur
 *
 *   sulfur_spike
 *     A solid block you can stand on. Its stalactites can fall and damage,
 *     like pointed dripstone, but the block itself is not a hazard.
 *     https://minecraft.wiki/w/Sulfur_Spike
 *
 *   campfire, soul_campfire
 *     Light and smoke only — no damage on contact.
 *
 * Sources for the 26.2-specific entries:
 *   potent_sulfur — "produces noxious gas, which gives Nausea temporarily, if
 *     placed beneath shallow water. Placing a magma block below it in shallow
 *     water turns it into a geyser." Avoiding it is the cheap safe play.
 *     https://minecraft.wiki/w/Potent_Sulfur
 *   geysers are potent_sulfur + magma_block + water, so magma_block is the
 *     physical hazard and is listed below.
 */
export const HAZARD_BLOCKS: ReadonlySet<string> = new Set([
  // Damage on contact or from standing on it.
  "lava",
  "magma_block",
  "fire",
  "soul_fire",
  "powder_snow",
  "sweet_berry_bush",
  "wither_rose",
  // Contact damage.
  "cactus",
  "pointed_dripstone",
  // Traps and movement hazards.
  "cobweb",
  // Liquids: boundingBox is "empty", so a name-only check walks into them.
  "water",
  "bubble_column",
  // 26.2: emits noxious gas, and spawns geysers with magma below it.
  "potent_sulfur",
]);

/** Blocks whose boundingBox is "empty" but which still stop us. Liquids and traps. */
export const HAZARD_PASSABLE_REJECTS: ReadonlySet<string> = new Set([
  "water",
  "bubble_column",
  "lava",
  "fire",
  "soul_fire",
  "powder_snow",
  "cobweb",
  "sweet_berry_bush",
  "wither_rose",
]);

/**
 * Build a real Vec3 for world queries.
 *
 * prismarine-world's getBlock() calls `pos.floored()`, so a plain {x,y,z} object
 * throws "pos.floored is not a function". vec3 is mineflayer's own dependency.
 */
export function toVec3(p: Vec3Like): Vec3Like {
  return new Vec3(p.x, p.y, p.z);
}

/**
 * C: is Elix standing somewhere he should not be right now?
 *
 * The existing hazard checks WIN over following, and this is where that is enforced: the
 * follow tick asks before it keeps a goal, and a `true` here cancels it with
 * `endedBecause: "hazard"`.
 *
 * Only the block at Elix's own feet is checked, not the whole path. The pathfinder already
 * refuses to dig and already avoids hazards through the Movements in `makeSafeMovements`;
 * this is the cheap last check for "the ground turned to lava under him", which is the case
 * no amount of re-pathing fixes.
 */
export function stopForHazard(bot: BotLike): boolean {
  const pos = bot.entity?.position;
  if (!pos) return true; // no position is not a safe place to keep walking
  const feet = bot.blockAt(toVec3(pos));
  if (feet && HAZARD_BLOCKS.has(blockName(feet))) return true;
  const floor = bot.blockAt(toVec3({ x: pos.x, y: pos.y - 1, z: pos.z }));
  return floor !== null && !isSafeFloor(floor);
}

/** A10: is this block safe to stand on? Needs a full solid box and no hazard. */
export function isSafeFloor(block: BlockLike | null): boolean {
  if (!block) return false;
  const name = blockName(block);
  if (name === "air" || name === "cave_air") return false;
  if (HAZARD_BLOCKS.has(name)) return false;
  // A hazard is only safe to stand on if it is genuinely solid; lava is not.
  const shape = block.boundingBox;
  return shape === "block" || shape === undefined;
}

/** A10: is this block clear to walk through? Empty box, not a liquid. */
export function isPassable(block: BlockLike | null): boolean {
  if (!block) return false;
  const name = blockName(block);
  // Liquids and traps are boundingBox "empty", so the name check is the only
  // thing that stops us walking head-first into water (A1).
  if (HAZARD_PASSABLE_REJECTS.has(name)) return false;
  if (HAZARD_BLOCKS.has(name)) return false;
  const shape = block.boundingBox;
  // "empty" covers air, cave_air, short_grass, flowers, torches and signs -
  // all passable despite having names that are not "air".
  return shape === "empty" || shape === undefined;
}

/**
 * Is this spot standable without digging?
 *
 * A10: the old version required the floor to be "not air", which counted lava
 * and water as a floor, and required the feet and head to be exactly "air",
 * which rejected cave_air, short_grass and flowers. Now the boundingBox decides.
 */
export function isStandable(
  blockAt: (p: Vec3Like) => BlockLike | null,
  x: number,
  y: number,
  z: number,
): boolean {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  const floor = blockAt(toVec3({ x: bx, y: by - 1, z: bz }));
  const feet = blockAt(toVec3({ x: bx, y: by, z: bz }));
  const head = blockAt(toVec3({ x: bx, y: by + 1, z: bz }));
  return isSafeFloor(floor) && isPassable(feet) && isPassable(head);
}

/** Pick the first direction with a solid floor and air at head height. */
export function pickWalkDirection(
  blockAt: (p: Vec3Like) => BlockLike | null,
  pos: Vec3Like,
): { x: number; y: number; z: number; name: string } | null {
  for (const dir of WALK_DISTANCES) {
    const tx = pos.x + dir.dx;
    const tz = pos.z + dir.dz;
    if (isStandable(blockAt, tx, pos.y, tz)) {
      return { x: tx, y: pos.y, z: tz, name: dir.name };
    }
  }
  return null;
}