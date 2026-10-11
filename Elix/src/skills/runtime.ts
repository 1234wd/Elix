/**
 * The base every skill runtime sits on.
 *
 * Round 18 built four skill runtimes that all worked - against fakes whose promises resolved in
 * the same microtask and whose pathfinder never moved. Against a real server they did nothing,
 * for one shared reason: **a tick that runs every 50 ms assumes every action finishes instantly.**
 *
 * The real facts, all of them verified against the installed mineflayer in
 * `tests/unit/mineflayerContracts.test.ts`:
 *
 *   - `bot.dig` takes seconds. Calling it again while one is running ABORTS the first one
 *     (`lib/plugins/digging.js`), so a 50 ms tick digs, re-digs, and throws away its own work.
 *   - `pathfinder.setGoal` RESETS the path and clears the control states
 *     (`lib/index.js` `resetPath('goal_updated')`). Calling it every tick means Elix never
 *     takes a step: the walk is cancelled 20 times a second.
 *   - Nothing is in reach until Elix has ARRIVED. A dig started 50 ms after the goal is set
 *     happens from wherever Elix was standing.
 *
 * So every runtime gets the same three rules, and this file is the only place they live:
 *
 *   1. **One step in flight.** A tick that finds a step pending does nothing at all.
 *   2. **Arrive before acting.** Distance to the target is checked on the tick, not assumed.
 *   3. **A goal is issued when it CHANGES**, and a moving target only counts as changed once it
 *      has moved `GOAL_MOVE_THRESHOLD` blocks.
 */
import { Vec3 } from "vec3";

/** How close Elix must be before a dig, a place or a container is in reach. */
const REACH = 4;

/** A moving target is re-goaled only once it has moved this far. */
const GOAL_MOVE_THRESHOLD = 2;

/** The mineflayer surface every runtime needs. Read through guards, never assumed. */
export interface SkillBot {
  entity?: { position: Vec3Like } | undefined;
  pathfinder?: { setGoal(goal: unknown): void; stop(): void } | undefined;
  stopDigging?(): void;
}

/** A position, in the shape mineflayer and vec3 agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A goal builder, so the base never has to know which goal class a skill wants. */
export type GoalBuilder = (target: Vec3Like) => unknown;

/**
 * Distance the way a player experiences it.
 *
 * Eye height matters: Elix's eyes are 1.62 blocks up, so a block at his feet is ~2.1 away, not 1.
 * Using a flat 3D distance from the feet makes "in reach" wrong at exactly the moment it
 * matters - the block he is standing next to.
 */
function eyeOf(position: Vec3Like): Vec3 {
  return new Vec3(position.x, position.y + 1.62, position.z);
}

/** Eye-to-block-centre distance, which is what mineflayer's own reach check uses. */
function reachDistance(from: Vec3Like, blockAt: Vec3Like): number {
  return eyeOf(from).distanceTo(new Vec3(blockAt.x + 0.5, blockAt.y + 0.5, blockAt.z + 0.5));
}

/** True when the block is close enough to dig, open or place. */
export function withinReach(from: Vec3Like, blockAt: Vec3Like, reach: number = REACH): boolean {
  return reachDistance(from, blockAt) <= reach;
}

/** Ground distance, for "is this person next to me" questions. */
export function horizontalDistance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The shared base.
 *
 * `tick` is the ONLY way a runtime is driven. It refuses to start a second step while one is
 * pending, and that single rule is what turns "the tick kills my own dig" into "the tick waits".
 */
export abstract class SkillRuntime<T> {
  private pending: Promise<unknown> | null = null;
  private stopped = false;
  private lastGoal: Vec3 | null = null;

  /** The one step a runtime performs per tick. Must not assume any timing. */
  protected abstract step(now: number): Promise<T>;

  /**
   * Run one tick.
   *
   * Returns true when a step was STARTED, false when the runtime is busy or stopped. The outcome
   * arrives through `onDone`, because by the time a real `dig` resolves, several ticks have gone
   * by and returning it synchronously would be a lie about when it happened.
   */
  tick(now: number, onDone: (outcome: T | null, failed: boolean) => void): boolean {
    if (this.stopped) return false;
    if (this.pending !== null) return false;
    this.pending = this.step(now)
      .then(
        (outcome) => {
          onDone(outcome, false);
          return outcome;
        },
        () => {
          onDone(null, true);
          return null;
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return true;
  }

  /** True while a step is pending. A tick must do nothing at all while this holds. */
  get busy(): boolean {
    return !this.stopped && this.pending !== null;
  }

  /** True after `stop()` until `resume()`. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Send Elix to a target, but only when the goal has actually changed.
   *
   * This is the single most important method in the file. `setGoal` resets the path, so calling
   * it on a 50 ms tick cancels the walk 20 times a second and Elix stands still forever. A
   * static target is therefore goaled exactly once; a moving one (the asker) is re-goaled only
   * after it has moved `GOAL_MOVE_THRESHOLD` blocks.
   */
  protected goToIfChanged(bot: SkillBot, target: Vec3Like, build: GoalBuilder): boolean {
    const pathfinder = bot.pathfinder;
    if (pathfinder === undefined) return false;
    if (this.lastGoal !== null && horizontalDistance(this.lastGoal, target) <= GOAL_MOVE_THRESHOLD) {
      // Same place, as far as the pathfinder is concerned. Saying it again would reset the
      // path and clear the control states, and Elix would never arrive.
      this.lastGoal = new Vec3(target.x, target.y, target.z);
      return false;
    }
    let goal: unknown;
    try {
      goal = build(target);
    } catch {
      return false;
    }
    if (goal === null || goal === undefined) return false;
    try {
      pathfinder.setGoal(goal);
    } catch {
      return false;
    }
    this.lastGoal = new Vec3(target.x, target.y, target.z);
    return true;
  }

  /** Forget the current goal, so the next `goToIfChanged` really does issue a new one. */
  protected clearGoal(): void {
    this.lastGoal = null;
  }

  /**
   * `elix stop`: nothing starts again, the pathfinder is stopped, and any dig in flight is
   * aborted rather than left to finish on its own.
   */
  stop(bot?: SkillBot): void {
    this.stopped = true;
    this.clearGoal();
    try {
      bot?.stopDigging?.();
    } catch {
      // A bot that cannot stop digging is already gone.
    }
    try {
      bot?.pathfinder?.stop();
    } catch {
      // Same.
    }
    this.pending = null;
  }

  /** Allow the runtime to start again. The caller decides when. */
  resume(): void {
    this.stopped = false;
    this.pending = null;
  }
}
