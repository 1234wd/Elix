/**
 * The give/deposit runtime — "elix give me cobblestone" and "elix put your stuff in the chest".
 *
 * `src/skills/give.ts` decides WHETHER. This file does it, and the two facts that matter are:
 *
 *   - the toss goes to the person who ASKED. There is no code path here that hands an item to
 *     anyone else, and `decideGive` already refuses a non-owner before this is ever built;
 *   - the chest is a ONE-WAY DOOR. `window.withdraw` exists in mineflayer's API and this file
 *     never calls it: Elix does not take things out of chests, not even things he could use, and
 *     not even when the chest is full of better tools. `tests/unit/giveWiring.test.ts` fails if
 *     the word "withdraw" ever appears in this file.
 *
 * Arrival is a DISTANCE CHECK on the tick rather than the pathfinder's `goal_reached` event,
 * because `goal_reached` only fires for goals Elix set through the pathfinder plugin and this
 * runner has to behave the same on a build where it does not.
 */
import { GIVE_RANGE, decideGive, isGiveable, type DepositRequest, type GiveRefusal, type GiveRequest, type GiveView } from "./give.js";
import { Vec3 } from "vec3";

/** The mineflayer surface this file uses. Every member is reached through a guard. */
export interface GiveBot {
  entity?: { position: Vec3 } | undefined;
  players?: Record<string, unknown> | undefined;
  toss(itemType: number, metadata: number | null, count: number): Promise<void>;
  openContainer?(block: unknown): Promise<unknown>;
  closeContainer?(window: unknown): Promise<void>;
  blockAt?(pos: Vec3Like): { name?: string } | null;
  findBlocks?(opts: { matching: unknown; maxDistance?: number; count?: number }): unknown;
  pathfinder?: { setGoal(goal: unknown): void; stop(): void } | undefined;
}

/** A chest window. Both methods are optional so a build without one cannot crash the tick. */
export interface GiveContainer {
  deposit?(itemType: number, metadata: number | null, count: number, nbt?: unknown): Promise<void>;
  withdraw?(itemType: number, metadata: number | null, count: number, nbt?: unknown): Promise<void>;
  close?(): Promise<void>;
}

/** A position, in the shape mineflayer and vec3 agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** What the runtime is doing. */
export type GiveOutcome =
  | { kind: "walking"; to: string }
  | { kind: "given"; item: string; count: number; to: string }
  | { kind: "deposited"; stacks: number }
  | { kind: "refused"; reason: GiveRefusal }
  | { kind: "stopped" };

/** What the runtime needs, injected so it never reaches for a loader or a clock. */
export interface GiveDeps {
  bot: GiveBot;
  /** The item id for a name, from the ONE vendored data accessor. */
  itemIdOf: (name: string) => number | null;
  /** The block ids that count as a container Elix may put things into. */
  chestIds: number[];
  /** The library's real goal classes. */
  goals: {
    GoalNear?: new (x: number, y: number, z: number, range: number) => unknown;
    GoalGetToBlock?: new (x: number, y: number, z: number) => unknown;
  };
  /** Says one short line, already gated by the caller. */
  say?: (line: string) => void;
}

/**
 * A player's position from mineflayer's own player map.
 *
 * The asker's OWN record, never "the nearest player": handing an item to the wrong child
 * because somebody else was closer would be the worst bug this file could have.
 */
function positionOf(players: Record<string, unknown> | undefined, name: string): Vec3 | null {
  const player = players?.[name];
  if (player === null || typeof player !== "object") return null;
  const entity = (player as { entity?: unknown }).entity;
  if (entity === null || typeof entity !== "object") return null;
  const position = (entity as { position?: unknown }).position;
  if (position === null || typeof position !== "object") return null;
  const p = position as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return null;
  return new Vec3(p.x, p.y, p.z);
}

/**
 * The stateful give/deposit.
 *
 * One step per tick, like every other runtime in this project, so `stop` lands within 50 ms
 * whatever stage Elix is in.
 */
export class GiveRunner {
  private request: GiveRequest | DepositRequest | null = null;
  private askedBy = "";
  private walked = false;
  private stopping = false;
  private outcome: GiveOutcome = { kind: "stopped" };
  private openChest: unknown = null;

  constructor(private readonly deps: GiveDeps) {}

  /** The last thing that happened, for the log and the tests. */
  get last(): GiveOutcome {
    return this.outcome;
  }

  /** True while Elix is on his way to somebody or busy with a chest. */
  get busy(): boolean {
    return this.request !== null && !this.stopping;
  }

  /**
   * Decide, and start walking when the answer is "toss".
   *
   * `view` carries the owner check and the wellbeing-floor check, both of which have already
   * happened upstream in `decideGive`. Nothing is said and nothing is thrown until the decision
   * is "yes".
   */
  start(request: GiveRequest | DepositRequest, view: GiveView): GiveOutcome {
    const decision = decideGive(view, request);
    if (decision.kind === "refuse") {
      this.request = null;
      this.outcome = { kind: "refused", reason: decision.reason };
      return this.outcome;
    }
    this.request = request;
    this.askedBy = view.askedBy;
    this.walked = false;
    this.stopping = false;
    this.outcome = { kind: "walking", to: view.askedBy };
    if (decision.kind === "toss") {
      // Start walking immediately, so the goal is set on the first tick rather than the second.
      this.walkToAsker();
    }
    return this.outcome;
  }

  /** One tick. */
  async step(): Promise<GiveOutcome> {
    if (this.stopping || this.request === null) return this.outcome;
    if (!("item" in this.request)) {
      const done = await this.depositAll();
      return done;
    }
    const target = positionOf(this.deps.bot.players, this.askedBy);
    if (target === null) {
      this.request = null;
      this.outcome = { kind: "refused", reason: "too-far-from-chest" };
      return this.outcome;
    }
    const me = this.deps.bot.entity?.position ?? new Vec3(0, 64, 0);
    const distance = me.distanceTo(target);
    if (distance > GIVE_RANGE) {
      this.walked = true;
      this.walkToAsker();
      this.outcome = { kind: "walking", to: this.askedBy };
      return this.outcome;
    }
    // Close enough. Hand it over - to the asker, by name, with the count they asked for.
    const item = this.request.item;
    const count = Math.min(this.request.count, this.holding(item));
    if (count <= 0) {
      this.request = null;
      this.outcome = { kind: "refused", reason: "not-in-inventory" };
      return this.outcome;
    }
    const id = this.deps.itemIdOf(item);
    if (id === null || !isGiveable(item)) {
      this.request = null;
      this.outcome = { kind: "refused", reason: "not-in-inventory" };
      return this.outcome;
    }
    try {
      await this.deps.bot.toss(id, null, count);
    } catch {
      this.request = null;
      this.outcome = { kind: "refused", reason: "not-in-inventory" };
      return this.outcome;
    }
    this.request = null;
    this.outcome = { kind: "given", item, count, to: this.askedBy };
    return this.outcome;
  }

  /**
   * Put everything in the nearest chest, then close it.
   *
   * One stack at a time, so a chest that fills up half way through leaves the rest in Elix's
   * inventory rather than vanishing into a failed transfer.
   */
  private async depositAll(): Promise<GiveOutcome> {
    const me = this.deps.bot.entity?.position ?? new Vec3(0, 64, 0);
    const chest = this.chestNear(me);
    if (chest === null) {
      this.request = null;
      this.outcome = { kind: "refused", reason: "chest-too-far" };
      return this.outcome;
    }
    if (this.openChest === null) {
      try {
        this.openChest = await this.deps.bot.openContainer?.(chest);
      } catch {
        this.openChest = null;
      }
    }
    const container = this.openChest as GiveContainer | null;
    if (container === null || typeof container !== "object" || typeof container.deposit !== "function") {
      this.request = null;
      this.outcome = { kind: "refused", reason: "chest-full" };
      return this.outcome;
    }
    let stacks = 0;
    for (const stack of this.stacks()) {
      const id = this.deps.itemIdOf(stack.name);
      if (id === null) continue;
      try {
        await container.deposit(id, null, stack.count, undefined);
        stacks += 1;
      } catch {
        // This stack did not fit. The rest still gets a turn.
      }
    }
    try {
      await container.close?.();
    } catch {
      // A chest left open closes itself on disconnect; that is untidy, not dangerous.
    }
    try {
      await this.deps.bot.closeContainer?.(container);
    } catch {
      // Same.
    }
    this.openChest = null;
    this.request = null;
    this.outcome = stacks > 0 ? { kind: "deposited", stacks } : { kind: "refused", reason: "chest-full" };
    return this.outcome;
  }

  /** The nearest chest, through the real search. */
  private chestNear(from: Vec3): unknown {
    const find = this.deps.bot.findBlocks;
    if (typeof find !== "function" || this.deps.chestIds.length === 0) return null;
    let found: unknown;
    try {
      found = find.call(this.deps.bot, { matching: this.deps.chestIds, maxDistance: 16, count: 1 });
    } catch {
      return null;
    }
    void from;
    if (!Array.isArray(found) || found.length === 0) return null;
    const first = found[0];
    return first !== null && typeof first === "object" ? first : null;
  }

  /** Set the real goal to the asker. Four NUMBERS - `GoalNear` takes no position object. */
  private walkToAsker(): void {
    if (this.walked && this.outcome.kind === "given") return;
    const target = positionOf(this.deps.bot.players, this.askedBy);
    const pathfinder = this.deps.bot.pathfinder;
    if (target === null || pathfinder === undefined) return;
    const { GoalNear } = this.deps.goals;
    try {
      const goal =
        typeof GoalNear === "function"
          ? new GoalNear(target.x, target.y, target.z, 1)
          : new (this.deps.goals.GoalGetToBlock as new (x: number, y: number, z: number) => unknown)(
              target.x,
              target.y,
              target.z,
            );
      pathfinder.setGoal(goal);
    } catch {
      // No goal class available. Elix simply does not walk, and the distance check still
      // decides when he is close enough - so a build with no pathfinder still hands the item
      // over rather than silently keeping it.
    }
  }

  /** How many of an item Elix is holding, through a guard. */
  private holding(name: string): number {
    let total = 0;
    for (const stack of this.stacks()) {
      if (stack.name === name) total += stack.count;
    }
    return total;
  }

  /** Every stack Elix is carrying. */
  private stacks(): Array<{ name: string; count: number }> {
    const inventory = (this.deps.bot as { inventory?: { items?: () => unknown[] } }).inventory;
    if (inventory === undefined || typeof inventory.items !== "function") return [];
    let list: unknown;
    try {
      list = inventory.items();
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const out: Array<{ name: string; count: number }> = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const count = (entry as { count?: unknown }).count;
      if (typeof name === "string" && typeof count === "number") out.push({ name, count });
    }
    return out;
  }

  /** `elix stop`. Synchronous, and it leaves the pathfinder clean. */
  stop(): void {
    this.stopping = true;
    this.request = null;
    this.walked = false;
    this.openChest = null;
    try {
      this.deps.bot.pathfinder?.stop();
    } catch {
      // Already gone.
    }
    this.outcome = { kind: "stopped" };
  }
}
