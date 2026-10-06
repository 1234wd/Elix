/**
 * Reflex wiring: the only stateful part of the reflexes.
 *
 * `decide.ts` says what to do; this does it, and it is the one place that can be
 * mid-something. Which means it is also the one place `elix stop` has to reach.
 *
 * Two rules it exists to keep:
 *
 *   - `stop` cancels within one tick and leaves nothing half-running. The tick is 50 ms,
 *     `stop()` is synchronous, and it clears the action AND tells the bot to drop its
 *     control states, so Elix is not still holding a sneak or a look after the stop.
 *   - a reflex that interrupts follow says so, so the caller can resume follow afterwards.
 *     `interruptedFollow` is the flag; forgetting to resume is the caller's bug and is
 *     visible in one property rather than hidden in a callback.
 *
 * Nothing here talks to the owner or to the brain. Progress lines go through the caller,
 * which owns the gates.
 */
import { Vec3 } from "vec3";
import {
  decideReflex,
  type ReflexAction,
  type ReflexName,
  type ReflexView,
  type Vec3Like,
} from "./decide.js";
import type { EquipSlot } from "./tables.js";

/**
 * The part of mineflayer the runner uses.
 *
 * `equip` and `consume` are declared with the shapes mineflayer 4.39.0 actually has:
 * `bot.equip(item, destination)` reads `item.slot` and asserts `destination` is one of
 * its own names; `bot.consume()` eats the HELD item and throws `Food is full` at food 20.
 * `tests/unit/equipContract.test.ts` checks these arguments against the real library.
 */
export interface ReflexBot {
  /** Assemble the current view from mineflayer's own fields. */
  view(): ReflexView;
  /** mineflayer `bot.equip(item, destination)`. */
  equip(item: unknown, destination: EquipSlot): Promise<void>;
  /** mineflayer `bot.consume()` - eats whatever is in hand. */
  consume(): Promise<void>;
  /** Look at a point. Easing and per-tick limits are WP4's job, not this file's. */
  lookAt(target: Vec3): void;
  /** Leave control states: stop sneaking, stop looking up. Called on `stop`. */
  clearControlStates(): void;
  /** Find an item object in the real inventory, so `equip` gets a real Item. */
  findItem(name: string): unknown | null;
}

/** One reflex's decision plus the reflex that made it. */
export interface ReflexTick {
  reflex: ReflexName;
  action: ReflexAction;
}

/** Reasons a run ended, for the log and for tests. */
export type ReflexEndReason = "stopped" | "finished" | "failed";

export class ReflexRunner {
  /** What is running right now, or null. */
  private running: ReflexTick | null = null;

  /** Set by `stop()`; cleared by the next `resume()`. */
  private stopped = false;

  /** True while a reflex other than armour is holding follow off. */
  private holdingFollow = false;

  /** The last thing that ended, for the log. Never cleared by the caller. */
  private lastEnd: { reason: ReflexEndReason; reflex: ReflexName } | null = null;

  constructor(private readonly bot: ReflexBot) {}

  /** The reflex currently running, or null. */
  get current(): ReflexName | null {
    return this.running?.reflex ?? null;
  }

  /** True while anything is mid-action. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** True while a reflex is holding follow off. */
  get interruptedFollow(): boolean {
    return this.holdingFollow;
  }

  /** The last end, for assertions and the log. */
  get endReason(): ReflexEndReason | null {
    return this.lastEnd?.reason ?? null;
  }

  /**
   * One reflex tick: decide, then act.
   *
   * Armour is not treated as an interruption of follow - picking up a better sword while
   * walking somewhere is what Elix should do, not a reason to stop walking.
   */
  async tick(): Promise<ReflexTick> {
    if (this.stopped) return { reflex: "hazards", action: { kind: "none" } };
    const view = this.bot.view();
    const decision = decideReflex(view);
    const { reflex, action } = decision;
    if (action.kind === "none") {
      // Nothing to do. The threat is gone, so follow may resume, and anything stale is
      // cleared so nothing is left half-running.
      this.holdingFollow = false;
      if (this.running !== null) this.finish("finished");
      return { reflex, action };
    }

    this.running = { reflex, action };
    // Everything except armour outranks follow. This tracks the STANDING threat, not the
    // one tick the action was issued on: a creeper four blocks away needs several ticks of
    // backing away, and clearing the flag as soon as the first step was taken would let
    // follow drag Elix straight back into the blast.
    this.holdingFollow = reflex !== "armour" && reflex !== "hazards";

    try {
      await this.perform(reflex, action);
      // A one-shot action is finished the moment it is issued. Swimming, eating and
      // equipping are all "do this now", and leaving `busy` true would block the next
      // reflex forever.
      this.finish("finished");
    } catch (err) {
      this.finish("failed");
      throw err;
    }
    return { reflex, action };
  }

  /** Issue the action. Kept separate so the tests can read what was asked for. */
  private async perform(reflex: ReflexName, action: ReflexAction): Promise<void> {
    switch (action.kind) {
      case "swim-up": {
        // Point the head up and hold the jump key: that is what surfaces in water.
        this.bot.lookAt(new Vec3(this.bot.view().position.x, this.bot.view().position.y + 2, this.bot.view().position.z));
        break;
      }
      case "flee": {
        this.bot.lookAt(action.target);
        break;
      }
      case "eat": {
        // mineflayer eats the HELD item, so the food has to be in hand first.
        const item = this.bot.findItem(action.item);
        if (item === null) return;
        await this.bot.equip(item, "hand");
        await this.bot.consume();
        break;
      }
      case "equip": {
        const item = this.bot.findItem(action.item);
        if (item === null) return;
        await this.bot.equip(item, action.slot);
        break;
      }
      case "none":
        break;
      default:
        void reflex;
        break;
    }
  }

  /**
   * Mark the current action done.
   *
   * Deliberately does NOT clear `holdingFollow`: the danger that raised this reflex is
   * usually still there, and only the next tick's decision - or a stop - may clear it.
   */
  private finish(reason: ReflexEndReason): void {
    if (this.running !== null) this.lastEnd = { reason, reflex: this.running.reflex };
    this.running = null;
  }

  /**
   * `elix stop`. Synchronous, so the caller can rely on it having happened the moment it
   * returns, and it drops control states so nothing is left half-applied.
   */
  stop(): void {
    this.stopped = true;
    this.running = null;
    this.holdingFollow = false;
    try {
      this.bot.clearControlStates();
    } catch {
      // A bot that cannot clear its control states is already gone; do not throw into
      // a stop, which must always complete.
    }
  }

  /** Allow ticks again. The caller decides when - never on a timer Elix does not own. */
  resume(): void {
    this.stopped = false;
  }
}

/** Distance helper, kept here so the caller and the decisions agree on the arithmetic. */
export function distanceXZ(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}