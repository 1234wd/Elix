/**
 * Round 15 Part C — the follow / come / stop controller.
 *
 * The rules, and why each is the way it is:
 *
 *  - `stop` is SYNCHRONOUS and unconditional. It clears the goal inside one tick, never
 *    awaits an LLM, an audit or the SayQueue, and is never gated. The moment a child
 *    needs a bot to stop is exactly the moment the provider is down or the safety
 *    classifier is thinking. A stop that can be delayed is not a stop.
 *
 *  - `follow` uses GoalFollow on the target's live entity, so it does not recompute a
 *    path every second, and it re-reads the entity through `playerPosition()` rather than
 *    casting — mineflayer has no `player.position`, which is what stopped Round 13's
 *    initiative from ever firing in a real server.
 *
 *  - it gives up on its own: target gone, target dead, or no tracked entity for ten
 *    seconds. A follow that never ends is a bot that walks into the sea.
 *
 *  - HAZARDS WIN. `stopForHazard()` is checked before every re-goal, because the reason
 *    Elix exists is not to follow a child into lava.
 *
 * All of that is state kept here rather than in `BotSession`, because `BotSession` is
 * already 1,932 lines and this logic is worth reading on its own.
 */

/** The two- to three-block band `follow` aims for. */
export const FOLLOW_DISTANCE = 3;

/** `come` walks to within this many blocks of where the player was when they asked. */
export const COME_RADIUS = 2;

/**
 * How long a follow survives without a tracked target entity.
 *
 * Ten seconds, because mineflayer drops the entity reference when a player leaves render
 * distance and rebuilds it on return. Giving up instantly would stop following someone who
 * walked round a hill; giving up after a minute would follow them off the edge of the map.
 */
export const TARGET_LOST_MS = 10_000;

/** One tick. `stop` must complete inside this. */
export const ONE_TICK_MS = 50;

export type FollowMode = "follow" | "come" | null;

export interface FollowTarget {
  name: string;
  /** Read through the entity, never cast. Undefined when out of range. */
  position: { x: number; y: number; z: number } | undefined;
  /** Present only while mineflayer tracks them, and null when they die. */
  alive: boolean;
}

/**
 * The narrow pathfinder surface this needs.
 *
 * Declared here rather than importing mineflayer-pathfinder's types, because the tests use
 * a fake and the real plugin is loaded at runtime. Two methods, both of which exist on the
 * real object.
 */
export interface PathfinderLike {
  setGoal(goal: unknown): void;
  stop(): void;
}

export interface FollowState {
  mode: FollowMode;
  target: string | null;
  /** When the target last had a tracked entity. Null while none. */
  lastSeenAt: number | null;
  /** Where `come` was told to go: the position at the moment of the command. */
  comeTarget: { x: number; y: number; z: number } | null;
  /** Why the last follow ended, for the log and for tests. */
  endedBecause: string | null;
}

function freshState(): FollowState {
  return {
    mode: null,
    target: null,
    lastSeenAt: null,
    comeTarget: null,
    endedBecause: null,
  };
}

export class FollowController {
  private state: FollowState = freshState();

  constructor(
    private readonly pathfinder: PathfinderLike | null,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): FollowState {
    return this.state;
  }

  /** Is anything moving right now? Initiative and wandering both ask this. */
  get busy(): boolean {
    return this.state.mode !== null;
  }

  /**
   * Stop, unconditionally and synchronously.
   *
   * No await anywhere on this path, which is the point. `pathfinder.stop()` is the one
   * call, and if the pathfinder is missing the state is still cleared so nothing believes
   * it is following.
   */
  stop(): void {
    this.pathfinder?.stop();
    this.state = { ...freshState(), endedBecause: "command" };
  }

  /**
   * Begin following a player.
   *
   * The goal is GoalFollow on the LIVE entity, so it keeps up without a path recompute
   * per tick, and it needs the target tracked at the moment of the command — a follow
   * with no entity is refused rather than queued, because it would be a follow that
   * silently does nothing while looking like it works.
   */
  follow(entity: unknown, targetName: string): { ok: boolean; reason?: string } {
    const goal = this.followGoal(entity);
    if (!goal) return { ok: false, reason: "target-not-tracked" };
    this.pathfinder?.setGoal(goal);
    this.state = {
      mode: "follow",
      target: targetName,
      lastSeenAt: this.now(),
      comeTarget: null,
      endedBecause: null,
    };
    return { ok: true };
  }

  /**
   * Walk to where the player is RIGHT NOW and then stop.
   *
   * Deliberately not a follow: `come` is a single journey to the position at the moment
   * of the command, not a standing arrangement. Someone who says "come here" and then runs
   * away should not be followed.
   */
  come(position: { x: number; y: number; z: number }): { ok: boolean } {
    this.pathfinder?.setGoal({ kind: "near", position, radius: COME_RADIUS });
    this.state = {
      mode: "come",
      target: null,
      lastSeenAt: this.now(),
      comeTarget: position,
      endedBecause: null,
    };
    return { ok: true };
  }

  /**
   * Called every tick while following.
   *
   * Three ways to give up, and all three are needed: the player left, they died, or they
   * have been untracked for ten seconds.
   *
   * @returns true while still following.
   */
  tick(target: FollowTarget | null, hazard: boolean): boolean {
    const now = this.now();
    if (this.state.mode === "follow") {
      if (hazard) {
        // Hazards win, always. The reason for following is not worth a lava pool.
        this.stop();
        this.state.endedBecause = "hazard";
        return false;
      }
      if (!target) {
        this.stop();
        this.state.endedBecause = "target-gone";
        return false;
      }
      if (!target.alive) {
        this.stop();
        this.state.endedBecause = "target-died";
        return false;
      }
      if (!target.position) {
        if (this.state.lastSeenAt === null || now - this.state.lastSeenAt > TARGET_LOST_MS) {
          this.stop();
          this.state.endedBecause = "target-lost";
          return false;
        }
        return true;
      }
      this.state.lastSeenAt = now;
      return true;
    }
    if (this.state.mode === "come") {
      if (hazard) {
        this.stop();
        this.state.endedBecause = "hazard";
        return false;
      }
      // `come` ends on arrival; the caller reports arrival, so there is nothing to do here
      // but stay busy until then.
      return true;
    }
    return false;
  }

  /** `come` has arrived. */
  arrive(): void {
    if (this.state.mode !== "come") return;
    this.stop();
    this.state.endedBecause = "arrived";
  }

  /**
   * Build a GoalFollow for a live entity.
   *
   * Exported so the tests can assert the goal's SHAPE without a pathfinder, and so there
   * is exactly one place that knows what a follow goal looks like.
   */
  followGoal(entity: unknown): { kind: "follow"; entity: unknown; distance: number } | null {
    if (entity === null || entity === undefined) return null;
    return { kind: "follow", entity, distance: FOLLOW_DISTANCE };
  }
}

