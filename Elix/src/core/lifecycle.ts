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
  /** Hard ceiling for the entire shutdown (default 10 s). */
  timeoutMs?: number;
  /** Overridable for tests. */
  exitFn?: (code: number) => void;
}

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
  private onShutdownBegin: (() => void) | null = null;

  constructor(log: Logger, opts: LifecycleOptions = {}) {
    this.log = log;
    // exitCleanly drains the logger first, so a shutdown never crashes with
    // UV_HANDLE_CLOSING the way a bare process.exit() did (A2).
    this.exitFn = opts.exitFn ?? exitCleanly;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
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
   * Resolve once shutdown begins (A1).
   *
   * `elix start` must not return when the bot connects — that is when play
   * begins, not when it ends. The action awaits this so the process stays
   * alive, and so the `finally` block that closes the brain can only run after
   * the cleanup registered with onCleanup has already run.
   *
   * Resolves on the FIRST shutdown only, so a second Ctrl+C (force exit 130)
   * is unaffected.
   */
  waitForShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const p = new Promise<void>((resolve) => {
      this.onShutdownBegin = resolve;
    });
    this.shutdownPromise = p;
    return p;
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownStarted = true;
    // Wake anything blocked in waitForShutdown() BEFORE the cleanups run, so
    // it can observe ordering without racing the goodbye.
    this.onShutdownBegin?.();
    this.log.info({ reason }, "shutting down");
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
      this.exitFn(0);
    }
  }
}