import type { Logger } from "./logger.js";
import { bus } from "./events.js";

/**
 * Graceful shutdown: runs cleanup callbacks in reverse registration order,
 * emits "shutdown", then exits.
 *
 * Vision rule 10: Ctrl+C → "gtg, cya" → memory consolidation → DB closed →
 * no orphan node processes. So cleanups are awaited, a second Ctrl+C force-exits
 * with 130, and the whole thing has a hard 10 s ceiling.
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

  constructor(log: Logger, opts: LifecycleOptions = {}) {
    this.log = log;
    this.exitFn = opts.exitFn ?? ((code) => process.exit(code));
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

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info({ reason }, "shutting down");
    bus.emit("shutdown", reason);

    // Hard ceiling: if a cleanup hangs, we still exit (A15).
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