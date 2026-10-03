import type { Logger } from "./logger.js";
import { bus } from "./events.js";
import { exitCleanly } from "./exit.js";

/**
 * Graceful shutdown: runs cleanup callbacks in reverse registration order,
 * emits "shutdown", then exits.
 *
 * Vision rule 10: Ctrl+C → "gtg, cya" → memory consolidation → DB closed →
 * no orphan node processes. So cleanups are awaited, a second Ctrl+C force-exits
 * with 130, and the whole thing has a hard ceiling. Lifecycle is the ONLY place
 * that owns an exit — BotSession.shutdown resolves or rejects and never exits.
 */

export interface LifecycleOptions {
  /**
   * Hard ceiling for the entire shutdown (default 30 s).
   *
   * A1: this was 10 s, which was shorter than the work itself. Shutdown does a
   * goodbye (1.5-4.5 s), a consolidation pass (its own 8 s budget) and an
   * embedding drain (10 s HF calls), so a slow provider used to trip the ceiling
   * and the process was killed BEFORE the backup was written and before the
   * database was closed — exactly the failure the backup exists to prevent. The
   * ceiling now has to exceed the sum of the work it is a backstop for.
   */
  timeoutMs?: number;
  /** Overridable for tests. */
  exitFn?: (code: number) => void;
}

/** The default ceiling. Generous enough to hold the whole shutdown sequence. */
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export class Lifecycle {
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private readonly log: Logger;
  private readonly exitFn: (code: number) => void;
  private readonly timeoutMs: number;
  private shuttingDown = false;
  private signalsRegistered = false;
  private signalHandlers = new Map<NodeJS.Signals, () => void>();
  /** A1: set once shutdown begins, and the promise waitForShutdown() hands out. */
  private shutdownStarted = false;
  private shutdownPromise: Promise<void> | null = null;
  /** Fired after EVERY cleanup has completed (A1). */
  private onShutdownComplete: (() => void) | null = null;

  constructor(log: Logger, opts: LifecycleOptions = {}) {
    this.log = log;
    // exitCleanly drains the logger first, so a shutdown never crashes with
    // UV_HANDLE_CLOSING the way a bare process.exit() did (A2).
    this.exitFn = opts.exitFn ?? exitCleanly;
    this.timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  }

  /** Register a cleanup callback. Returns an unregister function. */
  onCleanup(fn: () => Promise<void> | void): () => void {
    this.cleanups.push(fn);
    return () => {
      const i = this.cleanups.indexOf(fn);
      if (i >= 0) this.cleanups.splice(i, 1);
    };
  }

  /**
   * Register SIGINT/SIGTERM handlers. Idempotent (A15) — calling it twice does
   * not double-register, which previously fired shutdown twice.
   *
   * The second Ctrl+C force-exits with 130 (the conventional 128+SIGINT code).
   */
  handleSignals(): void {
    if (this.signalsRegistered) return;
    this.signalsRegistered = true;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        if (this.shuttingDown) {
          this.log.warn({ sig }, "second signal — force exiting with 130");
          this.exitFn(130);
          return;
        }
        void this.shutdown(`signal ${sig}`);
      };
      this.signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }
  }

  /** Remove signal handlers (tests, or after shutdown completes). */
  removeSignals(): void {
    for (const [sig, handler] of this.signalHandlers) process.off(sig, handler);
    this.signalHandlers.clear();
    this.signalsRegistered = false;
  }

  /**
   * Resolve once shutdown has FINISHED, not when it begins (A1).
   *
   * `elix start` must not return when the bot connects — that is when play
   * begins, not when it ends. The action awaits this so the process stays
   * alive, and the `finally` block that closes the brain only runs after every
   * cleanup has completed.
   *
   * The distinction matters in Phase 4: the shutdown backup and the
   * consolidation pass live in the brain cleanup, and both need the database
   * open. Resolving at the START of shutdown let the brain's `finally` close the
   * store in parallel with those cleanups, so they would hit a closed database.
   *
   * Resolves on the FIRST shutdown only, so a second Ctrl+C (force exit 130)
   * is unaffected.
   */
  waitForShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const p = new Promise<void>((resolve) => {
      this.onShutdownComplete = resolve;
    });
    this.shutdownPromise = p;
    return p;
  }

  /**
   * A2: `exitCode` lets a caller choose the process exit status.
   *
   * A permanent disconnect used to call exitCleanly() directly, so no cleanup
   * ran and the database was never closed cleanly. It now comes through here
   * with code 2. A second Ctrl+C still force-exits 130 regardless.
   */
  async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownStarted = true;
    this.log.info({ reason, exitCode }, "shutting down");
    bus.emit("shutdown", reason);

    // Hard ceiling: if a cleanup hangs, we still exit. This is the single
    // timeout that matters — BotSession has none (A9).
    const hardTimeout = setTimeout(() => {
      this.log.warn({ timeoutMs: this.timeoutMs }, "shutdown hard timeout — forcing exit");
      this.exitFn(1);
    }, this.timeoutMs);

    try {
      // Copy before reversing — `reverse()` mutates in place (A15).
      for (const fn of [...this.cleanups].reverse()) {
        try {
          await fn();
        } catch (err) {
          this.log.warn({ err: (err as Error).message }, "cleanup callback failed");
        }
      }
      this.log.info("cleanups complete");
    } finally {
      clearTimeout(hardTimeout);
      this.removeSignals();
      this.exitFn(exitCode);
    }

    // A1: only now is it safe for a caller to close the database.
    this.onShutdownComplete?.();
  }
}