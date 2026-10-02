import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A7: the crash guards must not hide crashes forever.
 *
 * The previous version swallowed every uncaughtException indefinitely, deduped
 * by message so repeats vanished, logged no stack, and claimed to be idempotent
 * without being so. Now: every crash is logged with its stack, installing twice
 * is a no-op, and a burst of crashes shuts Elix down with exit 1.
 */

type Listener = (...args: unknown[]) => void;

const EVENTS = ["uncaughtException", "unhandledRejection"] as const;

/** process.listenerCount / listeners, typed for arbitrary event names. */
const proc = process as unknown as {
  listenerCount(event: string): number;
  listeners(event: string): Listener[];
  off(event: string, listener: Listener): void;
};

/** Run `fn` with the process listeners this test installs, then clean up. */
async function withProcessListeners(fn: () => Promise<void> | void): Promise<void> {
  const before = new Map<string, number>(EVENTS.map((e) => [e, proc.listenerCount(e)]));
  try {
    await fn();
  } finally {
    // Remove only the listeners this test added.
    for (const event of EVENTS) {
      const added = proc.listeners(event).slice(before.get(event) ?? 0);
      for (const listener of added) proc.off(event, listener);
    }
  }
}

/** Raise an uncaughtException without letting Node actually die. */
function raise(err: unknown): void {
  // process.emit runs the listeners synchronously; a real throw would bypass us.
  (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
    "uncaughtException",
    err,
    "fake",
  );
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as import("../../src/core/logger.js").Logger;
}

describe("A7 — crash guards", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is idempotent: installing twice adds no second listener", async () => {
    await withProcessListeners(async () => {
      const mod = await import("../../src/connection/bot.js");
      // Fresh module registry so the installed flag starts false.
      const before = process.listenerCount("uncaughtException");
      mod.installCrashGuards();
      const afterFirst = process.listenerCount("uncaughtException");
      mod.installCrashGuards();
      mod.installCrashGuards();
      const afterThird = process.listenerCount("uncaughtException");
      expect(afterFirst).toBe(before + 1);
      expect(afterThird).toBe(afterFirst);
    });
  });

  it("logs every crash with its stack, including repeats of the same message", async () => {
    await withProcessListeners(async () => {
      const mod = await import("../../src/connection/bot.js");
      const log = makeLog();
      mod.installCrashGuards(log);

      const err = new Error("same message");
      raise(err);
      raise(err);
      raise(err);

      // The old version deduped by message, so repeats were invisible.
      const errorCalls = (log.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const uncaught = errorCalls.filter((c) => c[0]?.kind === "uncaughtException");
      expect(uncaught).toHaveLength(3);
      // And a stack is present every time.
      for (const call of uncaught) {
        expect(call[0].stack).toBeTruthy();
        expect(call[0].stack).toContain("Error: same message");
      }
    });
  });

  it("counts crashes in the window", async () => {
    await withProcessListeners(async () => {
      const mod = await import("../../src/connection/bot.js");
      const log = makeLog();
      mod.installCrashGuards(log);
      raise(new Error("boom 1"));
      raise(new Error("boom 2"));
      const calls = (log.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1]![0] as { crashesInWindow?: number };
      expect(last.crashesInWindow).toBe(2);
    });
  });

  it("exits 1 after more than five uncaught errors in the window", async () => {
    await withProcessListeners(async () => {
      const mod = await import("../../src/connection/bot.js");
      const exitMod = await import("../../src/core/exit.js");
      exitMod.resetExitState();
      const log = makeLog();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      try {
        mod.installCrashGuards(log);
        for (let i = 0; i < 6; i++) raise(new Error(`crash ${i}`));

        // A corrupted process must not limp on forever.
        await new Promise((r) => setTimeout(r, 400));
        expect(exitSpy).toHaveBeenCalledWith(1);

        const notes = (log.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
          String(c[1]),
        );
        expect(notes.some((n) => n.includes("too many uncaught errors"))).toBe(true);
      } finally {
        exitSpy.mockRestore();
        process.exitCode = 0;
        exitMod.resetExitState();
      }
    });
  }, 15_000);

  it("handles unhandledRejection as a crash too", async () => {
    await withProcessListeners(async () => {
      const mod = await import("../../src/connection/bot.js");
      const log = makeLog();
      mod.installCrashGuards(log);
      (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
        "unhandledRejection",
        new Error("rejected promise"),
        "fake",
      );
      const calls = (log.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => c[0]?.kind === "unhandledRejection")).toBe(true);
    });
  });
});