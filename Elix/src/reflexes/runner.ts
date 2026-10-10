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
  /**
   * mineflayer's bot.setControlState. Swimming up REQUIRES holding jump - looking up is not
   * swimming up, and the first version of this only looked, so Elix sank while appearing to
   * do something about it.
   */
  setControlState(control: string, state: boolean): void;
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

/**
 * How many ticks the jump key is held while swimming up. At 50 ms a tick that is 400 ms,
 * long enough to break the surface from ordinary depths and short enough that Elix is not
 * bunny-hopping along the sea bed if the water is shallow.
 */
const JUMP_HOLD_TICKS = 8;

export class ReflexRunner {
  /** What is running right now, or null. */
  private running: ReflexTick | null = null;

  /** Ticks of held jump left, so the key is released again. */
  private jumpTicksLeft = 0;

  /** What THIS tick decided about follow, read by the caller before the action completes. */
  private pendingHoldingFollow = false;

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

  /**
   * True while a reflex is holding follow off.
   *
   * Reads the value THIS tick settled, falling back to the last completed one, so a caller
   * that asks synchronously after calling `tick()` gets the current answer and not the
   * previous tick's.
   */
  get interruptedFollow(): boolean {
    return this.pendingHoldingFollow || this.holdingFollow;
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
  /**
   * One reflex tick: decide SYNCHRONOUSLY, then act.
   *
   * The decision half used to be inside the async body, which made
   * `interruptedFollow` a flag that the caller read one tick LATE - `runReflexes` does
   * `void runner.tick()` and immediately asks whether follow is being held off, and it was
   * always being told about the previous tick. Now `holdingFollow` is settled before the
   * first await, so the caller reads the truth about THIS tick.
   */
  async tick(): Promise<ReflexTick> {
    if (this.stopped) return { reflex: "hazards", action: { kind: "none" } };
    // Release the jump key as soon as the swim is over. This runs FIRST, before the decision,
    // so a stop mid-swim cannot leave jump held.
    if (this.jumpTicksLeft > 0) {
      this.jumpTicksLeft -= 1;
      if (this.jumpTicksLeft === 0) this.bot.setControlState("jump", false);
    }
    const view = this.bot.view();
    const decision = decideReflex(view);
    const { reflex, action } = decision;
    // Settled before any await, on purpose - see the doc comment above.
    this.pendingHoldingFollow = reflex !== "armour" && reflex !== "hazards" && action.kind !== "none";
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
        // Looking up is NOT swimming up. Holding jump while looking up is what actually
        // surfaces in water - the first version of this only looked, so Elix sank while
        // appearing to do something about it.
        const me = this.bot.view().position;
        this.bot.lookAt(new Vec3(me.x, me.y + 2, me.z));
        this.bot.setControlState("jump", true);
        // Hold it briefly, then let go: a jump key held forever is Elix bunny-hopping along
        // the sea bed and skipping every other reflex.
        this.jumpTicksLeft = JUMP_HOLD_TICKS;
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
    // Both flags, not one. `interruptedFollow` reads either, so clearing only the completed
    // one would leave a stopped runner still claiming it is holding follow off - which stops
    // nothing, but reports something false, and a report that can be wrong is worse.
    this.pendingHoldingFollow = false;
    // Never leave jump held. A stop that releases the control states but not the key Elix is
    // physically holding leaves him jumping in place with nothing driving him.
    if (this.jumpTicksLeft > 0) {
      this.jumpTicksLeft = 0;
      try {
        this.bot.setControlState("jump", false);
      } catch {
        // A bot that cannot release its controls is already gone.
      }
    }
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