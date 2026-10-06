/**
 * WP3 — protect the owner, humanized.
 *
 * Elix defends an owner who is standing near him. He does not pick fights, he does not
 * chase, and he never swings at anything the good-friend rules forbid. All of that is
 * decided in pure functions here; `DefendController` is the only stateful part.
 *
 * The rules, in the order they are checked:
 *
 *   1. NEVER ATTACKED wins over everything. A player, a pet, a villager, a golem or a
 *      passive mob is never a target, however close it is and however much it hurts.
 *   2. A PLAYER who hits Elix never becomes a target. He steps away and says one short
 *      line through `gateOwnLine`. No retaliation, ever, at any skillCap.
 *   3. A CREEPER is never a target either. WP2's flee owns creepers, and a bot that
 *      punches one converts a survivable situation into a hole in the ground.
 *   4. Hostile mobs only, and only while an owner is within DEFEND_OWNER_RADIUS.
 *   5. At health <= RETREAT_AT, retreat toward the owner instead of attacking.
 *
 * Two timing rules make it read as a person rather than a turret:
 *
 *   - a REACTION DELAY before the first swing, 180-320 ms, varied by skillCap and by a
 *     stable per-target jitter so two identical situations do not play out identically;
 *   - the 1.9+ ATTACK COOLDOWN respected between swings, from the held weapon's real
 *     attack speed. Swinging faster than the server allows is both detectable and
 *     useless.
 *
 * `stop` cancels within one tick and leaves nothing half-running, exactly like WP2's runner.
 */
import { Vec3 } from "vec3";
import { isHostileMob, isNeverAttacked, isPlayerEntity } from "./hostile.js";
import type { CreatureLike, Vec3Like } from "./decide.js";

/** An owner must be this close for Elix to defend them at all. */
export const DEFEND_OWNER_RADIUS = 16;

/** A target must be this close to the owner, or to Elix, to be attacked. */
export const DEFEND_TARGET_RADIUS = 8;

/** Melee reach, generous by a block so a swing is not whiffed at the edge. */
export const ATTACK_RANGE = 3.2;

/** At or below this health, retreat toward the owner instead of fighting. */
export const RETREAT_AT = 6;

/**
 * How hard Elix plays.
 *
 * Written out here rather than imported, because `config.ts` keeps its zod schema private
 * and exports no inferred type for it. `tests/unit/defend.test.ts` asserts these three
 * against the real config enum, so a fourth cap added to the schema fails that test instead
 * of silently falling back to the bare-hand cooldown.
 */
export type SkillCap = "casual" | "normal" | "tryhard";

/** The brief's reaction window, per skillCap. Slower casual, faster tryhard. */
export const REACTION_MS: Readonly<Record<SkillCap, readonly [number, number]>> = Object.freeze({
  casual: [280, 320],
  normal: [230, 290],
  tryhard: [180, 230],
});

/** Extra slack so a jitter can never push a reaction outside the brief's 180-320 ms. */
const JITTER_MS = 20;

/** Longest a reaction may be, whatever the skillCap. The brief's hard ceiling. */
export const REACTION_CEILING_MS = 320;
export const REACTION_FLOOR_MS = 180;

/**
 * Attack speed in attacks per second, by weapon.
 *
 * NOT in minecraft-data - `items.json` carries no attack-speed field, the same gap WP2 hit
 * for armour points. Values read from https://minecraft.wiki/w/Sword, /Axe, /Mace,
 * /Spear, /Trident (accessed 2026-10-06), the same "Attack speed" column WP2's damage table
 * came from. Bare hands are 4.0, which is the game's own value for an empty hand.
 *
 * An unverified weapon is not in this table and falls back to the bare-hand rate, which is
 * the slower and therefore the safer assumption: it means Elix waits longer than he has to
 * rather than swinging into the cooldown.
 */
export const ATTACK_SPEED: Readonly<Record<string, number>> = Object.freeze({
  wooden_sword: 1.6,
  golden_sword: 1.6,
  stone_sword: 1.6,
  copper_sword: 1.6,
  iron_sword: 1.6,
  diamond_sword: 1.6,
  netherite_sword: 1.6,

  wooden_axe: 0.8,
  golden_axe: 1.0,
  stone_axe: 0.8,
  copper_axe: 0.8,
  iron_axe: 0.9,
  diamond_axe: 1.0,
  netherite_axe: 1.0,

  mace: 0.6,
  trident: 1.1,

  wooden_spear: 1.54,
  golden_spear: 1.05,
  stone_spear: 1.33,
  copper_spear: 1.18,
  iron_spear: 1.05,
  diamond_spear: 0.95,
  netherite_spear: 0.87,

  bare_hand: 4.0,
});

/** The 1.9+ cooldown, in milliseconds, for a weapon. */
export function attackCooldownMs(weapon: string | null): number {
  const speed = ATTACK_SPEED[weapon ?? "bare_hand"] ?? ATTACK_SPEED["bare_hand"] ?? 4;
  if (speed <= 0) return Number.POSITIVE_INFINITY;
  return 1000 / speed;
}

/** Everything the decisions can see. */
export interface DefendView {
  position: Vec3Like;
  /** 0-20. mineflayer's `bot.health`. */
  health: number;
  /** Owners and how far each one is, nearest first is not required. */
  owners: Array<{ name: string; distance: number; position: Vec3Like }>;
  /** Every entity in range, mineflayer-shaped. */
  entities: CreatureLike[];
  /** What is in hand, or null. Decides the cooldown. */
  heldWeapon: string | null;
  /** The player who hit Elix most recently, if any. */
  hurtByPlayer: { name: string; distance: number } | null;
}

/** What Elix should do about being attacked or about defending. */
export type DefendAction =
  | { kind: "attack"; target: string; targetId: number | undefined; distance: number }
  | { kind: "retreat"; toward: string }
  | { kind: "step-away"; from: string }
  | { kind: "none" };

/** Horizontal distance, ignoring height, like the game's own reach. */
function distanceXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** An owner close enough to be worth defending. */
export function nearestOwnerInRange(view: DefendView): DefendView["owners"][number] | null {
  let best: DefendView["owners"][number] | null = null;
  for (const owner of view.owners) {
    if (owner.distance > DEFEND_OWNER_RADIUS) continue;
    if (best === null || owner.distance < best.distance) best = owner;
  }
  return best;
}

/**
 * Is this entity a legal target?
 *
 * The good-friend rules are checked FIRST and are absolute, so a hostile-category mob that
 * is somehow also a pet is still never attacked.
 */
export function isLegalTarget(entity: CreatureLike, hurtByPlayerName: string | null): boolean {
  if (isNeverAttacked(entity.name)) return false;
  if (hurtByPlayerName !== null && entity.name === hurtByPlayerName) return false;
  if (isPlayerEntity(entity.name, entity.type)) return false;
  // WP2's flee owns creepers. Punching one is how a bot digs its own grave.
  if (entity.name === "creeper") return false;
  if (!isHostileMob(entity.name)) return false;
  return true;
}

/**
 * The target to attack, or null.
 *
 * A mob qualifies when it is hostile, alive, and within range of the OWNER or of Elix. Both
 * distances matter: a zombie chewing on the owner four blocks away must be answered, and so
 * must one that wandered up to Elix.
 */
export function pickTarget(view: DefendView): CreatureLike | null {
  let best: CreatureLike | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of view.entities) {
    if (entity.isValid === false) continue;
    if (!isLegalTarget(entity, view.hurtByPlayer?.name ?? null)) continue;
    const mine = distanceXZ(view.position, entity.position);
    const owner = nearestOwnerInRange(view);
    const theirs = owner === null ? Number.POSITIVE_INFINITY : distanceXZ(owner.position, entity.position);
    if (mine > DEFEND_TARGET_RADIUS && theirs > DEFEND_TARGET_RADIUS) continue;
    // Nearest to Elix, so Elix does not cross the owner's path to reach a further mob.
    if (mine < bestDistance) {
      bestDistance = mine;
      best = entity;
    }
  }
  return best;
}

/**
 * The whole defend decision.
 *
 * Retreat beats attacking: at health <= RETREAT_AT, backing up toward the owner is worth
 * more than one more hit. Stepping away from a player beats both, because a player who hits
 * Elix is never answered with a swing no matter how low Elix's health is.
 */
export function decideDefend(view: DefendView): DefendAction {
  // A player who hits Elix: never a target, and not even a reason to fight something else
  // while they stand there swinging.
  if (view.hurtByPlayer !== null) {
    return { kind: "step-away", from: view.hurtByPlayer.name };
  }

  const owner = nearestOwnerInRange(view);
  if (owner === null) return { kind: "none" };

  if (view.health <= RETREAT_AT) {
    return { kind: "retreat", toward: owner.name };
  }

  const target = pickTarget(view);
  if (target === null) return { kind: "none" };
  const distance = distanceXZ(view.position, target.position);
  if (distance > ATTACK_RANGE) return { kind: "none" };
  return { kind: "attack", target: target.name, targetId: target.id, distance };
}

/**
 * The reaction delay for this moment, in milliseconds.
 *
 * A stable jitter per target, so the same zombie is met the same way twice while two
 * different zombies are still met differently. Clamped to the brief's 180-320 ms window, so
 * no skillCap and no jitter can push it outside.
 */
export function reactionMs(cap: SkillCap, targetKey: string): number {
  const window = REACTION_MS[cap] ?? REACTION_MS["normal"];
  const span = window[1] - window[0];
  let hash = 0;
  for (let i = 0; i < targetKey.length; i += 1) {
    hash = (hash * 31 + targetKey.charCodeAt(i)) | 0;
  }
  const jitter = Math.abs(hash % (span + 1));
  const chosen = window[0] + jitter;
  // Clamp, and make sure the clamp cannot itself fall outside the brief's window.
  return Math.min(REACTION_CEILING_MS, Math.max(REACTION_FLOOR_MS, chosen + JITTER_MS / 2));
}

/** Where Elix should stand to back away from something, without moving into danger. */
export function retreatTarget(from: Vec3Like, toward: Vec3Like): Vec3 {
  const length = Math.hypot(toward.x - from.x, toward.z - from.z);
  if (length < 1e-6) {
    // Already standing on the owner: back off in a fixed direction rather than dividing by
    // zero, so a retreat is always a real move.
    return new Vec3(from.x + 2, from.y, from.z);
  }
  return new Vec3(toward.x, from.y, toward.z);
}

/**
 * The stateful half of WP3: reaction delay, attack cooldown, and what happens on a stop.
 *
 * Everything here is bookkeeping the pure decisions cannot do. The controller's job is
 * narrow and worth stating: it may SWING and it may MOVE AWAY. It has no code path that can
 * swing at a player, a pet, a villager, a golem, a passive mob or a creeper, because every
 * swing goes through `decideDefend`, which refuses them first.
 */
export class DefendController {
  /** When the current target was first seen, for the reaction delay. */
  private engagedAt: number | null = null;

  /** The internal key of what is being engaged, so a new target restarts the reaction. */
  private engagedWith: string | null = null;

  /** The NAME of what is being engaged, for the log and for tests. */
  private engagedName: string | null = null;

  /** When the last swing happened, for the 1.9+ cooldown. */
  private lastSwingAt: number | null = null;

  private held = false;

  constructor(
    private readonly cap: SkillCap,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True while Elix is engaging something. */
  get engaged(): boolean {
    return this.held;
  }

  /** The name of the mob being engaged, or null. */
  get target(): string | null {
    return this.engagedName;
  }

  /** Milliseconds until the next swing is allowed, 0 when it is allowed now. */
  cooldownRemaining(weapon: string | null, at: number): number {
    if (this.lastSwingAt === null) return 0;
    const elapsed = at - this.lastSwingAt;
    return Math.max(0, attackCooldownMs(weapon) - elapsed);
  }

  /**
   * One defend tick. Returns the action, already filtered by reaction and cooldown.
   *
   * `onSwing` and `onMove` are the only things that touch the world, and both are supplied
   * by the caller, so this file cannot swing at anything on its own.
   */
  tick(
    view: DefendView,
    handlers: { onSwing: (target: CreatureLike) => void; onMove: (to: Vec3) => void },
  ): DefendAction {
    const at = this.now();
    const action = decideDefend(view);

    if (action.kind === "none") {
      this.release();
      return action;
    }
    if (action.kind === "step-away") {
      this.release();
      const player = view.entities.find((e) => e.name === action.from);
      if (player === undefined) return action;
      const away = new Vec3(view.position.x - player.position.x, 0, view.position.z - player.position.z);
      if (away.norm() > 1e-6) handlers.onMove(new Vec3(view.position.x + away.normalize().scale(4).x, view.position.y, view.position.z + away.normalize().scale(4).z));
      return action;
    }
    if (action.kind === "retreat") {
      this.held = false;
      const owner = view.owners.find((o) => o.name === action.toward);
      if (owner !== undefined) handlers.onMove(retreatTarget(view.position, owner.position));
      return action;
    }

    // An attack. Hold it for the reaction delay, then respect the cooldown.
    const key = `${action.targetId ?? action.target}`;
    if (this.engagedWith !== key) {
      this.engagedWith = key;
      this.engagedName = action.target;
      this.engagedAt = at;
    }
    this.held = true;

    if (at - (this.engagedAt ?? at) < reactionMs(this.cap, key)) {
      return { kind: "none" };
    }
    if (this.cooldownRemaining(view.heldWeapon, at) > 0) {
      return { kind: "none" };
    }
    const target = view.entities.find((e) => e.name === action.target);
    if (target === undefined) {
      this.release();
      return { kind: "none" };
    }
    this.lastSwingAt = at;
    handlers.onSwing(target);
    return action;
  }

  /**
   * `elix stop`. Synchronous, and it clears the engagement so the next tick cannot swing on
   * the strength of a reaction delay that started before the stop.
   */
  stop(): void {
    this.release();
    this.lastSwingAt = null;
  }

  private release(): void {
    this.held = false;
    this.engagedWith = null;
    this.engagedName = null;
    this.engagedAt = null;
  }
}