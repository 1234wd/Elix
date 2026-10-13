/**
 * Sleep, on the R19-A runtime base.
 *
 * The rule is small and the temptation is not: Elix would love to sleep through a creeper, or
 * while the owner is trying to talk to him, or halfway through a dig. So the three refusals are
 * checked EVERY tick, before anything else, and they are refusals rather than delays:
 *
 *   - a hostile mob within `HOSTILE_RADIUS` blocks;
 *   - a follow in progress (`following` is the follow controller's own busy flag);
 *   - any skill mid-flight, including a dig.
 *
 * He sleeps only when ALL of those are false, the night has come, an owner is already in a bed
 * within `OWNER_BED_RANGE`, and there is a FREE bed within `BED_RANGE` of him. He wakes on the
 * server's own `wake` event or at dawn, whichever comes first, and `stop` cancels everything.
 */
import { SkillRuntime, withinReach, type SkillBot, type Vec3Like } from "../skills/runtime.js";

/** Sleep uses the same reach as every other action: close enough to touch it. */
const REACH = 4;

/** How long to wait after `bot.sleep` is refused, before trying again. */
const SLEEP_RETRY_MS = 30_000;

/** How close a hostile mob has to be to keep Elix awake. */
const HOSTILE_RADIUS = 8;

/** How far an owner's bed may be and still count as "the owner is asleep". */
const OWNER_BED_RANGE = 16;

/** How far Elix will walk to find a free bed. */
const BED_RANGE = 16;

/** What the runner is doing. */
export type SleepOutcome =
  | { kind: "waiting"; reason: SleepRefusal }
  | { kind: "walking"; at: Vec3Like }
  | { kind: "asleep"; at: Vec3Like }
  | { kind: "woke"; reason: "wake-event" | "daylight" | "stopped" };

/** Why Elix is not asleep. Each is a rule, so each can be told apart in a log or a test. */
export type SleepRefusal = "sleep-refused" | "daytime" | "hostile-nearby" | "following" | "skill-busy" | "owner-awake" | "no-free-bed";

/** The mineflayer surface this file uses. Every member is read through a guard. */
export interface SleepBot extends SkillBot {
  time?: { isDay: boolean };
  players?: Record<string, unknown>;
  entities?: Record<string, unknown>;
  blockAt(pos: Vec3Like): { name?: string; position?: Vec3Like } | null;
  findBlocks(opts: { matching: unknown; maxDistance?: number; count?: number }): unknown;
  sleep?(block: unknown): Promise<void>;
  /** mineflayer: true while Elix is IN A BED. Nothing may move him until he leaves it. */
  isSleeping?: boolean;
  /**
   * mineflayer: `bot.wake()`. Throws when he is already awake, so every caller guards.
   *
   * This is the call R20-B exists for: before it, the runtime cleared a local flag and Elix
   * stayed in the bed in the game, unable to follow an owner or run from a zombie.
   */
  wake?(): Promise<void>;
  stopDigging?(): void;
}

/** What the caller must tell the runner about the rest of the bot. */
export interface SleepContext {
  /** Is a follow running right now? */
  following: boolean;
  /** Is any skill mid-flight, a dig included? */
  skillBusy: boolean;
  /** Positions of hostile mobs, from the caller's own defender. */
  hostilePositions: Vec3Like[];
  /**
   * The owners who are REALLY asleep.
   *
   * This is the whole of R20-B: the old check was "an owner within sixteen blocks of any
   * bed", which put Elix to bed every night while the owner sat awake next to him. A name is
   * in this set because mineflayer said so, on `entitySleep`, and leaves it on `entityWake`.
   */
  asleepOwners: string[];
  /** Where each owner is standing, so the runner can measure a distance. */
  ownerPositions: Vec3Like[];
  /** The bed block ids, from the one vendored data accessor. */
  bedIds: number[];
}

/** What the runner needs, injected so it never reaches for a clock or a loader. */
export interface SleepDeps {
  bot: SleepBot;
  /** Builds the goal to walk to a block. */
  walkGoal: (position: Vec3Like) => unknown;
  context: () => SleepContext;
  say?: (line: string) => void;
}

/** A search result as a Block, whichever shape the search returned. `findBlocks` returns coordinates. */
function toBlock(entry: unknown, bot: SleepBot): { name?: string; position?: Vec3Like } | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as { name?: unknown; x?: unknown; y?: unknown; z?: unknown; position?: unknown };
  if (typeof record.name === "string" && typeof record.position === "object" && record.position !== null) {
    return entry as { name?: string; position?: Vec3Like };
  }
  const source =
    typeof record.x === "number" && typeof record.y === "number" && typeof record.z === "number"
      ? record
      : (record.position as { x?: unknown; y?: unknown; z?: unknown } | undefined);
  if (source === undefined || source === null || typeof source !== "object") return null;
  if (typeof source.x !== "number" || typeof source.y !== "number" || typeof source.z !== "number") return null;
  try {
    const block = bot.blockAt({ x: source.x, y: source.y, z: source.z });
    return typeof block?.name === "string" ? block : null;
  } catch {
    return null;
  }
}

/** The nearest bed block within range, or null. */
function nearestBed(bot: SleepBot, from: Vec3Like, ids: readonly number[], maxDistance: number): Vec3Like | null {
  const find = bot.findBlocks;
  if (typeof find !== "function" || ids.length === 0) return null;
  let found: unknown;
  try {
    found = find.call(bot, { matching: [...ids], maxDistance, count: 8 });
  } catch {
    return null;
  }
  if (!Array.isArray(found)) return null;
  let best: Vec3Like | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of found) {
    const block = toBlock(entry, bot);
    if (block === null || typeof block.position !== "object" || block.position === null) continue;
    const p = block.position;
    const distance = Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: p.x, y: p.y, z: p.z };
    }
  }
  return best;
}

/**
 * The sleep runner.
 *
 * One step per tick on the shared base, so it cannot stack a second `sleep` on top of a first
 * one and it stops inside 50 ms of an `elix stop`.
 */
export class SleepRunner extends SkillRuntime<SleepOutcome> {
  private asleepAt: Vec3Like | null = null;
  /**
   * When the last `bot.sleep` threw, and when it may be tried again.
   *
   * Without this, a bot refused near a monster retries every 50 ms for ever: 1,200 rejected calls
   * a minute, none of them useful.
   */
  private retryAfter = 0;
  private last: SleepOutcome = { kind: "woke", reason: "stopped" };

  constructor(private readonly deps: SleepDeps) {
    super();
  }

  /** Where Elix is sleeping, or null. */
  get sleepingAt(): Vec3Like | null {
    return this.asleepAt;
  }

  /** The last outcome, for the log and the tests. */
  get outcome(): SleepOutcome {
    return this.last;
  }

  /** The names of the owners who are really asleep, lower-cased. */
  private asleepOwners(): string[] {
    return this.deps.context().asleepOwners.map((n) => n.toLowerCase());
  }

  protected override async step(now = Date.now()): Promise<SleepOutcome> {
    // Waking first: once asleep, every tick checks whether he should still be asleep.
    if (this.asleepAt !== null) return await this.checkStillAsleep();

    const context = this.deps.context();
    const bot = this.deps.bot;

    // The refusals, in the order that keeps Elix alive first.
    const hostile = this.nearestHostile(context.hostilePositions);
    if (hostile !== null) return this.wait("hostile-nearby");
    if (context.skillBusy) return this.wait("skill-busy");
    if (context.following) return this.wait("following");
    if (bot.time?.isDay !== false) return this.wait("daytime");
    // The owner has to be ASLEEP, not merely present: Elix does not go to bed because somebody
    // is standing in the dark. An owner within reach of a bed is treated as being in one.
    // The owner has to be ASLEEP - really asleep, reported by mineflayer's `entitySleep`.
    // Before R20-B this was "an owner near a bed", so Elix climbed into bed every night while
    // the owner sat right next to him, awake, on a public server.
    if (this.asleepOwners().length === 0) return this.wait("owner-awake");

    const me = bot.entity?.position ?? { x: 0, y: 64, z: 0 };
    const bed = nearestBed(bot, me, context.bedIds, BED_RANGE);
    if (bed === null) return this.wait("no-free-bed");

    // ARRIVAL before the sleep, exactly as for every other action on this base.
    if (!withinReach(me, bed, REACH)) {
      this.goToIfChanged(bot, bed, this.deps.walkGoal);
      this.last = { kind: "walking", at: bed };
      return this.last;
    }

    const block = bot.blockAt(bed);
    if (block === null || typeof block.name !== "string") return this.wait("no-free-bed");
    try {
      await bot.sleep?.(block);
    } catch {
      // Refused: monsters nearby, daylight, the bed occupied. Wait SLEEP_RETRY_MS rather than
      // retrying every 50 ms - 1,200 rejected calls a minute is not a retry, it is a loop.
      this.retryAfter = now + SLEEP_RETRY_MS;
      return this.wait("sleep-refused");
    }
    this.retryAfter = 0;
    this.asleepAt = bed;
    this.last = { kind: "asleep", at: bed };
    return this.last;
  }

  /**
   * While asleep: any change in the world, or the sun, and he is UP - out of the bed, in the
   * game, not merely out of this class.
   *
   * Before R20-B this only cleared a local flag. In Minecraft Elix was still lying in the bed
   * with a zombie next to him, unable to follow an owner who said "come here". Clearing a
   * flag is not the same as standing up.
   */
  private async checkStillAsleep(): Promise<SleepOutcome> {
    const context = this.deps.context();
    const bot = this.deps.bot;
    const reason =
      this.nearestHostile(context.hostilePositions) !== null
        ? ("hostile-nearby" as const)
        : context.skillBusy || context.following
          ? ("owner-awake" as const)
          : bot.time?.isDay === true
            ? ("daylight" as const)
            : null;
    if (reason === null) return { kind: "asleep", at: this.asleepAt ?? { x: 0, y: 0, z: 0 } };
    this.asleepAt = null;
    this.clearGoal();
    await this.wakeNow();
    this.last = { kind: "woke", reason: reason === "daylight" ? "daylight" : "wake-event" };
    return this.last;
  }

  /** The closest hostile, or null. */
  private nearestHostile(positions: readonly Vec3Like[]): Vec3Like | null {
    const me = this.deps.bot.entity?.position;
    if (me === undefined) return null;
    for (const hostile of positions) {
      if (Math.hypot(hostile.x - me.x, hostile.y - me.y, hostile.z - me.z) <= HOSTILE_RADIUS) return hostile;
    }
    return null;
  }

  /** A refusal, as an outcome. */
  private wait(reason: SleepRefusal): SleepOutcome {
    this.last = { kind: "waiting", reason };
    return this.last;
  }

  /**
   * Get out of bed, in the GAME.
   *
   * `bot.wake()` is the only thing that moves Elix out of a bed, and it throws when he is
   * already awake - so it is guarded twice: by `bot.isSleeping` and by the catch. This is
   * exported through the session so a command, a tool call or `stop` can use the same call,
   *   rather than each one growing its own half-version.
   */
  async wakeNow(): Promise<boolean> {
    const bot = this.deps.bot;
    if (bot.isSleeping !== true) return false;
    try {
      await bot.wake?.();
    } catch {
      return false;
    }
    this.asleepAt = null;
    this.clearGoal();
    return true;
  }

  /** `elix stop`, and a monster appearing. Both wake Elix. */
  override stop(): void {
    super.stop(this.deps.bot);
    // A stop has to leave nothing half-running, and "half-asleep" is a state. The wake is not
    // awaited here because `stop` is synchronous by contract; the promise settles on its own
    // and the next tick does nothing, because `isStopped` is true.
    void this.wakeNow();
    this.last = { kind: "woke", reason: "stopped" };
  }

  /** The server said the night is over. */
  wake(): SleepOutcome {
    this.asleepAt = null;
    this.clearGoal();
    this.last = { kind: "woke", reason: "wake-event" };
    return this.last;
  }
}
