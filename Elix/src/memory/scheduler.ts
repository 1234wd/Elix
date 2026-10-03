/**
 * The nightly scheduler (A2).
 *
 * BUG THIS FIXES: consolidation, backups and the embedding backfill were only
 * ever called at startup and on shutdown. "Nightly" was a claim in the docs with
 * no code behind it: nothing ran per in-game day, and a new episode stayed
 * unembedded for the whole session, so semantic retrieval had nothing to match
 * against even when HF credit was available.
 *
 * Triggers, all bounded:
 *
 *  - consolidation (cap 5 calls) plus a backup when the in-game clock crosses
 *    into night (timeOfDay >= 13000), OR after 60 real minutes, whichever comes
 *    first. At most once per in-game day.
 *  - an embedding drain every 2 minutes while HF is available.
 *
 * Nothing here is on the reply path. A tick that fails is logged and the next
 * tick still runs; the scheduler is a background chore, not a dependency.
 */
import type { MemoryStore } from "./store.js";
import type { MemoryEngine } from "./engine.js";
import { createBackup } from "./backup.js";
import { consolidate, NIGHT_CALL_CAP, type ConsolidationResult } from "./consolidation.js";
import type { BrainRouter } from "../brain/router.js";

/** In-game tick count at which it is night. Vanilla: 13000. */
export const NIGHT_TICKS = 13_000;
/** Fallback real-time interval, so a server with no time updates still sleeps. */
export const REAL_MINUTES_MS = 60 * 60_000;
/** How often the embedding drain runs. */
export const EMBED_INTERVAL_MS = 2 * 60_000;
/** How often the scheduler wakes at all. */
export const TICK_INTERVAL_MS = 30_000;

export interface SchedulerLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface SchedulerOptions {
  store: MemoryStore;
  engine: MemoryEngine;
  router: BrainRouter | null;
  storePath: string;
  backupDir: string;
  /** False with no provider key: skip consolidation, keep embedding off too. */
  hasModel: boolean;
  log: SchedulerLog;
  /** Elixir's in-game clock. 0 means "unknown" and never triggers the night. */
  timeOfDay?: () => number;
  /** Overridable for tests. */
  now?: () => number;
  /** Overridable for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  embedIntervalMs?: number;
  realIntervalMs?: number;
  tickIntervalMs?: number;
}

export interface TickResult {
  /** Whether the sleep+backup ran on this tick. */
  consolidated: boolean;
  consolidatedStatus?: ConsolidationResult["status"];
  factsMade: number;
  backedUp: boolean;
  embedded: number;
  /** Set when something failed; the scheduler keeps running regardless. */
  error?: string;
}

export class NightlyScheduler {
  private readonly opts: SchedulerOptions;
  private handle: unknown = null;
  /**
   * When the session started.
   *
   * The real-time fallback is measured from HERE, not from "the first tick".
   * Measuring from the first tick made `shouldSleep()` true on tick one — the
   * elapsed time came out Infinity — so a fresh session consolidated immediately
   * and "after 60 minutes" never meant anything.
   */
  private readonly startedAt: number;
  private lastSleepAt: number | null = null;
  /** Seeded at construction so the first drain waits out the interval. */
  private lastEmbedAt: number | null;
  private lastNightTick = -1;
  private running = false;
  private stopped = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.startedAt = this.now();
    // The CLI runs a startup drain of its own, so draining again on tick one is
    // pure cost with nothing new to embed.
    this.lastEmbedAt = this.startedAt;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastSleep(): number | null {
    return this.lastSleepAt;
  }

  get lastEmbed(): number | null {
    return this.lastEmbedAt;
  }

  /** Start the background loop. Idempotent. */
  start(): void {
    if (this.handle !== null) return;
    this.stopped = false;
    const setIntervalFn = this.opts.setIntervalFn ?? setInterval;
    const ms = this.opts.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.handle = setIntervalFn(() => {
      void this.tick();
    }, ms);
    (this.handle as { unref?: () => void })?.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle === null) return;
    const clear = this.opts.clearIntervalFn ?? clearInterval;
    clear(this.handle as ReturnType<typeof setInterval>);
    this.handle = null;
  }

  /**
   * Is it night, and have we not already slept for this day?
   *
   * "Once per in-game day" is keyed on the in-game day number, not the wall
   * clock, so crossing midnight twice in one session sleeps twice — which is
   * correct — while twenty wake-ups in one night sleep once.
   */
  private shouldSleep(now: number): boolean {
    const ticks = this.opts.timeOfDay?.() ?? 0;
    // From the session start, so a fresh boot does not sleep on its first tick.
    const realElapsed = now - (this.lastSleepAt ?? this.startedAt);
    if (realElapsed >= (this.opts.realIntervalMs ?? REAL_MINUTES_MS)) return true;
    if (ticks < NIGHT_TICKS) return false;
    const day = Math.floor(ticks / 2400);
    return day !== this.lastNightTick;
  }

  private shouldEmbed(now: number): boolean {
    if (!this.opts.engine.hasEmbeddings) return false;
    if (this.opts.engine.unembeddedCount === 0) return false;
    return (
      this.lastEmbedAt === null ||
      now - this.lastEmbedAt >= (this.opts.embedIntervalMs ?? EMBED_INTERVAL_MS)
    );
  }

  /**
   * One pass. Exported through `tick()` so a test can drive it with a fake clock
   * and a fake in-game time instead of waiting an hour.
   */
  async tick(): Promise<TickResult> {
    const result: TickResult = {
      consolidated: false,
      factsMade: 0,
      backedUp: false,
      embedded: 0,
    };
    if (this.stopped || this.running) return result;
    this.running = true;
    const now = this.now();
    try {
      // -- sleep + backup ---------------------------------------------------
      if (this.shouldSleep(now)) {
        this.lastSleepAt = now;
        const ticks = this.opts.timeOfDay?.() ?? 0;
        if (ticks >= NIGHT_TICKS) this.lastNightTick = Math.floor(ticks / 2400);

        if (!this.opts.hasModel || !this.opts.router) {
          this.opts.log.info("sleep skipped — no provider key");
        } else {
          try {
            const consolidated = await consolidate({
              store: this.opts.store,
              router: this.opts.router as BrainRouter,
              since: now - (this.opts.realIntervalMs ?? REAL_MINUTES_MS) * 24,
              callCap: NIGHT_CALL_CAP,
              now,
            });
            result.consolidated = true;
            result.consolidatedStatus = consolidated.status;
            result.factsMade = consolidated.factsMade;
            this.opts.log.info(
              {
                status: consolidated.status,
                facts: consolidated.factsMade,
                calls: consolidated.calls,
                deferred: consolidated.deferred,
              },
              "sleep",
            );
          } catch (err) {
            result.error = (err as Error).message.slice(0, 200);
            this.opts.log.warn({ err: result.error }, "sleep failed");
          }
        }

        // The backup runs with the sleep, even when consolidation was skipped or
        // failed: this is the nightly safety net.
        try {
          const backup = createBackup({
            dbPath: this.opts.storePath,
            backupDir: this.opts.backupDir,
          });
          result.backedUp = backup.path !== null;
          this.opts.log.info(
            { path: backup.path, bytes: backup.bytes, error: backup.error },
            "nightly backup",
          );
        } catch (err) {
          result.error = (err as Error).message.slice(0, 200);
          this.opts.log.warn({ err: result.error }, "nightly backup failed");
        }
      }

      // -- embedding drain ---------------------------------------------------
      if (this.shouldEmbed(now)) {
        this.lastEmbedAt = now;
        try {
          const drain = await this.opts.engine.embedder.backfill();
          result.embedded = drain.embedded;
          if (drain.embedded > 0) this.opts.log.info(drain, "embedded new memories");
        } catch (err) {
          result.error = (err as Error).message.slice(0, 200);
          this.opts.log.warn({ err: result.error }, "embedding drain failed");
        }
      }
    } finally {
      this.running = false;
    }
    return result;
  }
}