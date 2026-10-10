/**
 * The gather runtime — the half of "elix get 5 dirt" that touches the world.
 *
 * `src/skills/gather.ts` decides WHAT is allowed. This file does it, and it is the first code
 * in the project that actually removes a block from somebody's world, so the rules that
 * matter here are all about restraint:
 *
 *   - only a block on the allow-list, and never a log without leaves on it;
 *   - never inside a REMEMBERED PLACE's radius. Round 17 protected the OWNER's surroundings,
 *     which meant "get me some dirt" refused to work while the owner was watching - the exact
 *     thing they asked for. Places protect places now;
 *   - never the block a player is standing ON, nor anything within two blocks of a player.
 *     Digging the floor out from under somebody is unforgivable and irreversible;
 *   - the best tool minecraft-data says the block needs, equipped before the dig;
 *   - a hard cap of 64 items and five minutes, and `stop` cancels even a dig already in flight.
 *
 * Every mineflayer call is reached through a runtime guard, because these run on the 50 ms
 * tick and a throw there takes the bot down.
 */
import { Vec3 } from "vec3";
import {
  GATHER_MAX_ITEMS,
  GATHER_MAX_MS,
  PROGRESS_MIN_GAP_MS,
  isAllowedBlock,
  needsLeaves,
  type GatherRequest,
} from "./gather.js";
import { bestToolFor } from "./gather.js";

/** The mineflayer surface this file uses. Every member is read through a guard. */
export interface GatherBot {
  findBlocks(opts: {
    matching: number | number[] | ((block: unknown) => boolean);
    maxDistance?: number;
    count?: number;
  }): unknown;
  blockAt(pos: Vec3Like): { name?: string } | null;
  entity?: { position: Vec3Like } | undefined;
  players?: Record<string, unknown>;
  inventory?: { items?: () => unknown[] } | undefined;
  equip(item: unknown, destination: string): Promise<void>;
  dig(block: unknown): Promise<void>;
  stopDigging?(): void;
  pathfinder?: { setGoal(goal: unknown): void; stop(): void } | undefined;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Never dig within this many blocks of another player. */
export const PLAYER_CLEARANCE = 2;

/** How far away Elix looks for a block at all. */
export const SEARCH_RADIUS = 32;

/** Blocks Elix will not dig, whatever the allow-list says. */
export const UNDIGGABLE = new Set(["air", "cave_air", "void_air", "water", "lava", "bedrock", "fire"]);

/** A remembered place, as far as this file cares. */
export interface ProtectedPlace {
  x: number;
  y: number;
  z: number;
}

/**
 * The refusal reasons, with the rule each one names.
 *
 * Returned rather than a boolean so the caller can say something honest and the tests can say
 * WHICH rule fired, instead of "it did not dig" with no explanation.
 */
export type GatherRefusal =
  | "not-on-the-list"
  | "log-without-leaves"
  | "protected-place"
  | "player-standing-there"
  | "too-near-a-player"
  | "none-found"
  | "cap-reached"
  | "out-of-time"
  | "stopped";

/** The block name for an id, via a caller-supplied lookup. */
export type NameOf = (id: number) => string | null;

/** The block id for a name. */
export type IdOf = (name: string) => number | null;

/** Where Elix is, and who is near enough to matter. */
export interface GatherWorld {
  position: Vec3Like;
  /** Every other player's position. Elix himself is NOT in this list. */
  playerPositions: Vec3Like[];
  /** Every remembered place. */
  protectedPlaces: ProtectedPlace[];
  /** Radius around a remembered place. */
  protectedRadius: number;
}

/** True when Elix is standing on, or within PLAYER_CLEARANCE of, somebody else's block. */
export function playerTooClose(target: Vec3Like, world: GatherWorld): boolean {
  for (const player of world.playerPositions) {
    const distance = Math.hypot(player.x - target.x, player.z - target.z);
    // Same column, or the block somebody is standing on.
    if (player.x === target.x && player.z === target.z) return true;
    // Less-than-OR-EQUAL, not less-than: a block exactly two away is inside a two-block
    // radius, and the brief's wording is the one the owner reads. Getting this boundary
    // wrong the other way is the kind of thing you only learn from a hole in a floor.
    if (distance <= PLAYER_CLEARANCE) return true;
  }
  return false;
}

/** True when the target is inside a remembered place's radius. */
export function insideProtectedPlace(target: Vec3Like, world: GatherWorld): boolean {
  for (const place of world.protectedPlaces) {
    if (Math.hypot(place.x - target.x, place.z - target.z) < world.protectedRadius) return true;
  }
  return false;
}

/**
 * A matcher for `bot.findBlocks`.
 *
 * The name check happens HERE rather than after the search, because `findBlocks` scans a chunk
 * and the cheap rejection is "is this a block Elix would ever dig" - not "is this near a
 * player", which needs positions this function does not have yet.
 */
export function diggableMatcher(nameOf: NameOf, allowed: ReadonlySet<string>): (block: unknown) => boolean {
  return (block: unknown): boolean => {
    if (block === null || typeof block !== "object") return false;
    const raw = block as { name?: unknown; type?: unknown };
    const name = typeof raw.name === "string" ? raw.name : typeof raw.type === "number" ? nameOf(raw.type) : null;
    if (name === null || !allowed.has(name)) return false;
    return !UNDIGGABLE.has(name);
  };
}

/**
 * Every candidate position, nearest first, as `Vec3`.
 *
 * Real mineflayer's `findBlocks` returns Block objects; some fakes and some versions return
 * positions. Both are handled here so no caller has to know which it got.
 */
export function candidatePositions(found: unknown, blockAt: (p: Vec3Like) => { name?: string } | null): Vec3[] {
  if (!Array.isArray(found)) return [];
  const out: Vec3[] = [];
  for (const entry of found) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as { position?: unknown; x?: unknown; y?: unknown; z?: unknown };
    if (raw.position !== undefined && raw.position !== null && typeof raw.position === "object") {
      const p = raw.position as { x?: unknown; y?: unknown; z?: unknown };
      if (typeof p.x === "number" && typeof p.y === "number" && typeof p.z === "number") {
        out.push(new Vec3(p.x, p.y, p.z));
      }
      continue;
    }
    if (typeof raw.x === "number" && typeof raw.y === "number" && typeof raw.z === "number") {
      out.push(new Vec3(raw.x, raw.y, raw.z));
    }
  }
  void blockAt;
  return out;
}

/** What the runner is doing right now. */
export type GatherTick =
  | { kind: "walk-to"; at: Vec3; block: string }
  | { kind: "dig"; at: Vec3; block: string }
  | { kind: "done"; gathered: number }
  | { kind: "refused"; reason: GatherRefusal };

/** Everything the runner needs from the world, injected so it stays testable. */
export interface GatherDeps {
  bot: GatherBot;
  /** The library's real goal classes, for `GoalGetToBlock`. */
  goals: { GoalGetToBlock?: new (position: Vec3Like) => unknown };
  nameOf: NameOf;
  idOf: IdOf;
  now: () => number;
  /** Builds the goal to walk to a block. Injected so the runner never reaches for a loader. */
  walkGoal: (position: Vec3Like) => unknown;
  /** Says one short line, already gated by the caller. */
  say?: (line: string) => void;
}

/**
 * The stateful gather.
 *
 * One step per tick: find, walk, dig, repeat. `stop()` is synchronous and calls
 * `bot.stopDigging()`, because "stop wins within one tick" is a promise about the dig
 * already in flight and not just about the next decision.
 */
export class GatherRunner {
  private request: GatherRequest | null = null;
  private gathered = 0;
  private startedAt = 0;
  private stopped = false;
  private lastLineAt = -PROGRESS_MIN_GAP_MS;
  private target: Vec3 | null = null;
  private targetName: string | null = null;
  private outcome: GatherTick | null = null;

  /** The rule that turned down every candidate, when the search found nothing legal. */
  private refusal: GatherRefusal | null = null;
  private world: GatherWorld = {
    position: { x: 0, y: 64, z: 0 },
    playerPositions: [],
    protectedPlaces: [],
    protectedRadius: 24,
  };
  /** Whether the drop-collection walk has started, so Elix does not dig and never collects. */
  private collecting = false;

  constructor(private readonly deps: GatherDeps) {}

  /** What Elix is doing, for the log and the tests. */
  get last(): GatherTick | null {
    return this.outcome;
  }

  /** How many have been gathered. */
  get count(): number {
    return this.gathered;
  }

  /** True while a gather is running. */
  get busy(): boolean {
    return this.request !== null && !this.stopped;
  }

  /** Start. Refuses immediately if the block is not on the allow-list at all. */
  start(request: GatherRequest, world: GatherWorld, now: number): void {
    this.stopped = false;
    this.outcome = null;
    this.gathered = 0;
    this.collecting = false;
    this.target = null;
    this.targetName = null;
    this.world = world;
    this.refusal = null;
    this.startedAt = now;
    if (!isAllowedBlock(request.block)) {
      this.request = null;
      this.outcome = { kind: "refused", reason: "not-on-the-list" };
      return;
    }
    this.request = request;
  }

  /**
   * One tick.
   *
   * The sequence is deliberately find -> walk -> dig -> collect, and each stage is one tick,
   * so a `stop` between any two stages leaves nothing half-done and the pathfinder is never
   * retasked mid-swing.
   */
  async step(now: number): Promise<GatherTick | null> {
    if (this.stopped || this.request === null) return this.outcome;

    // Caps first: an out-of-time gather stops before it starts the next dig.
    if (this.gathered >= this.request.count || this.gathered >= GATHER_MAX_ITEMS) {
      this.outcome = { kind: "done", gathered: this.gathered };
      this.request = null;
      return this.outcome;
    }
    if (now - this.startedAt >= GATHER_MAX_MS) {
      this.outcome = { kind: "refused", reason: "out-of-time" };
      this.request = null;
      return this.outcome;
    }

    // Nothing chosen yet: find a block, then refuse for a RULE, not for "nothing nearby".
    if (!this.collecting && this.target === null) {
      const found = this.findOne();
      if (found === null) {
        // A rule turned it down, and that is worth reporting as itself: "protected-place"
        // tells the owner WHY nothing happened, which "none-found" does not.
        this.outcome = { kind: "refused", reason: this.refusal ?? "none-found" };
        this.request = null;
        return this.outcome;
      }
      this.refusal = null;
      this.target = found.position;
      this.targetName = found.name;
      this.outcome = { kind: "walk-to", at: found.position, block: found.name };
      this.deps.bot.pathfinder?.setGoal(this.deps.walkGoal(found.position));
      return this.outcome;
    }

    // Arrived (or close enough): equip the right tool, then dig.
    if (!this.collecting && this.target !== null) {
      const blockName = this.targetName ?? "unknown";
      const position = this.target;
      const tool = this.bestToolFor(blockName);
      if (tool !== null) {
        const item = this.findItem(tool);
        if (item !== null) {
          try {
            await this.deps.bot.equip(item, "hand");
          } catch {
            // A refused equip is not a reason to abandon the dig; dig with bare hands.
          }
        }
      }
      const block = this.deps.bot.blockAt(position);
      this.outcome = { kind: "dig", at: position, block: blockName };
      try {
        await this.deps.bot.dig(block);
      } catch {
        this.outcome = { kind: "refused", reason: "none-found" };
        this.request = null;
        return this.outcome;
      }
      this.gathered += 1;
      this.target = null;
      this.targetName = null;
      // Go and stand on the drop. The next tick walks there, then we look for the next block.
      this.collecting = true;
      const drop = new Vec3(position.x, position.y, position.z);
      this.deps.bot.pathfinder?.setGoal(this.deps.walkGoal(drop));
      this.maybeSay(now);
      return this.outcome;
    }

    // Collected: back to hunting.
    this.collecting = false;
    return this.step(now);
  }

  /** Search once, applying every rule to every candidate, nearest first. */
  private findOne(): { position: Vec3; name: string } | null {
    const blockName = this.request?.block;
    if (blockName === undefined) return null;
    const id = this.deps.idOf(blockName);
    if (id === null) return null;
    const mine = this.deps.bot.entity?.position ?? this.world.position;
    let found: unknown;
    try {
      found = this.deps.bot.findBlocks({
        matching: diggableMatcher(this.deps.nameOf, new Set([blockName])),
        maxDistance: SEARCH_RADIUS,
        count: 24,
      });
    } catch {
      return null;
    }
    const positions = candidatePositions(found, (p) => this.deps.bot.blockAt(p));
    positions.sort((a, b) => a.distanceTo(new Vec3(mine.x, mine.y, mine.z)) - b.distanceTo(new Vec3(mine.x, mine.y, mine.z)));
    for (const position of positions) {
      const here = this.deps.bot.blockAt(position);
      const name = here?.name ?? blockName;
      if (!isAllowedBlock(name)) continue;
      // A log needs leaves on it, or it is somebody's building. The caller supplies that
      // answer through the block lookup; without one, a log is refused.
      if (needsLeaves(name) && !this.hasLeavesNear(position)) continue;
      if (playerTooClose(position, { ...this.world, position: mine })) {
        this.refusal = "too-near-a-player";
        continue;
      }
      if (insideProtectedPlace(position, { ...this.world, position: mine })) {
        this.refusal = "protected-place";
        continue;
      }
      return { position, name };
    }
    return null;
  }

  /** Leaves within two blocks, read off the real block lookup. */
  private hasLeavesNear(position: Vec3): boolean {
    const leaves = [
      new Vec3(position.x + 2, position.y + 2, position.z),
      new Vec3(position.x - 2, position.y + 2, position.z),
      new Vec3(position.x, position.y + 2, position.z + 2),
      new Vec3(position.x, position.y + 2, position.z - 2),
      new Vec3(position.x + 2, position.y, position.z),
      new Vec3(position.x, position.y + 3, position.z),
    ];
    for (const at of leaves) {
      const name = this.deps.bot.blockAt(at)?.name;
      if (typeof name === "string" && name.endsWith("_leaves")) return true;
    }
    return false;
  }

  /** The best tool Elix is actually holding for this block, or null. */
  private bestToolFor(blockName: string): string | null {
    const held = this.inventoryNames();
    return bestToolFor(blockName, held);
  }

  /** Every item name in the inventory, through a guard. */
  private inventoryNames(): string[] {
    const inventory = this.deps.bot.inventory;
    if (inventory === undefined || typeof inventory.items !== "function") return [];
    let list: unknown;
    try {
      list = inventory.items();
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") out.push(name);
    }
    return out;
  }

  /** A real inventory item by name, which is what `bot.equip` requires. */
  private findItem(name: string): unknown | null {
    const inventory = this.deps.bot.inventory;
    if (inventory === undefined || typeof inventory.items !== "function") return null;
    let list: unknown;
    try {
      list = inventory.items();
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      if ((entry as { name?: unknown }).name === name) return entry;
    }
    return null;
  }

  /** At most one progress line a minute, and never after a stop. */
  private maybeSay(now: number): void {
    if (this.stopped || this.request === null) return;
    if (now - this.lastLineAt < PROGRESS_MIN_GAP_MS) return;
    this.lastLineAt = now;
    const label = (this.request.block ?? "").replace(/_/gu, " ");
    this.deps.say?.(`got ${this.gathered} of ${this.request.count} ${label}`);
  }

  /**
   * `elix stop`. Synchronous, and it reaches the dig IN FLIGHT - `bot.stopDigging()` - because
   * a stop that only cleared Elix's plan would leave him mining after the owner said stop.
   */
  stop(): void {
    this.stopped = true;
    this.request = null;
    this.target = null;
    this.targetName = null;
    this.collecting = false;
    try {
      this.deps.bot.stopDigging?.();
    } catch {
      // A bot that cannot stop digging is already gone.
    }
    try {
      this.deps.bot.pathfinder?.stop();
    } catch {
      // Same.
    }
    this.outcome = { kind: "refused", reason: "stopped" };
  }

  /** The caller decides when Elix may act again. */
  resume(): void {
    this.stopped = false;
    if (this.outcome?.kind === "refused" && this.outcome.reason === "stopped") this.outcome = null;
  }
}

/** Every other player's position, from mineflayer's own player map. Elix is excluded. */
export function otherPlayerPositions(
  players: Record<string, unknown> | undefined,
  selfName: string,
): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (const [name, value] of Object.entries(players ?? {})) {
    if (name === selfName) continue;
    if (value === null || typeof value !== "object") continue;
    const entity = (value as { entity?: unknown }).entity;
    if (entity === null || typeof entity !== "object") continue;
    const position = (entity as { position?: unknown }).position;
    if (position === null || typeof position !== "object") continue;
    const p = position as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") continue;
    out.push({ x: p.x, y: p.y, z: p.z });
  }
  return out;
}