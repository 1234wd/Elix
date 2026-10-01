import { bus } from "./events.js";
import type { Logger } from "./logger.js";

/**
 * Graceful shutdown: runs cleanup callbacks in order, emits "shutdown",
 * then exits. Used by Ctrl+C handling in `elix start` (Phase 2+) and
 * testable on its own.
 */
export class Lifecycle {
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private shuttingDown = false;

  constructor(
    private readonly log: Logger,
    private readonly exitFn: (code: number) => void = (code) => process.exit(code),
  ) {}

  /** Register a cleanup callback. Returns an unregister function. */
  onCleanup(fn: () => Promise<void> | void): () => void {
    this.cleanups.push(fn);
    return () => {
      const i = this.cleanups.indexOf(fn);
      if (i >= 0) this.cleanups.splice(i, 1);
    };
  }

  /** Register SIGINT/SIGTERM handlers (idempotent). */
  handleSignals(): void {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        void this.shutdown(`signal ${sig}`);
      });
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info({ reason }, "shutting down");
    bus.emit("shutdown", reason);
    for (const fn of this.cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        this.log.warn({ err }, "cleanup callback failed");
      }
    }
    this.exitFn(0);
  }
}
