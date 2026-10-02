import { describe, it, expect, vi } from "vitest";
import { bus } from "../../src/core/events.js";
import { Lifecycle } from "../../src/core/lifecycle.js";

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => fakeLogger,
} as never;

describe("typed event bus", () => {
  it("delivers emitted events to subscribers", () => {
    const fn = vi.fn();
    bus.on("bot:joined", fn);
    bus.emit("bot:joined", {
      username: "Elix",
      host: "127.0.0.1",
      port: 25565,
      version: "26.2",
      protocol: 776,
      serverBrand: "Paper",
    });
    expect(fn).toHaveBeenCalledWith({
      username: "Elix",
      host: "127.0.0.1",
      port: 25565,
      version: "26.2",
      protocol: 776,
      serverBrand: "Paper",
    });
    bus.off("bot:joined", fn);
  });

  it("stops delivery after off()", () => {
    const fn = vi.fn();
    bus.on("bot:chat", fn);
    bus.off("bot:chat", fn);
    bus.emit("bot:chat", { username: "Ali", text: "hi" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener from other listeners", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bus.on("bot:chat", bad);
    bus.on("bot:chat", good);
    expect(() => bus.emit("bot:chat", { username: "Ali", text: "hi" })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
    bus.off("bot:chat", bad);
    bus.off("bot:chat", good);
  });
});

describe("Lifecycle", () => {
  it("runs cleanups in reverse order, emits shutdown, exits once", async () => {
    const order: string[] = [];
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });

    lc.onCleanup(() => {
      order.push("first");
    });
    lc.onCleanup(() => {
      order.push("second");
    });

    const shutdownSeen = vi.fn();
    bus.on("shutdown", shutdownSeen);

    await lc.shutdown("test");
    expect(order).toEqual(["second", "first"]);
    expect(shutdownSeen).toHaveBeenCalledWith("test");
    expect(exitFn).toHaveBeenCalledOnce();

    // Second shutdown is a no-op (no double cleanup, no double exit).
    await lc.shutdown("again");
    expect(exitFn).toHaveBeenCalledOnce();
    bus.off("shutdown", shutdownSeen);
  });

  it("awaits async cleanups, and runs them in reverse registration order", async () => {
    const order: string[] = [];
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });
    // Registered first → runs last.
    lc.onCleanup(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("async-registered-first");
    });
    // Registered second → runs first.
    lc.onCleanup(() => {
      order.push("sync-registered-second");
    });
    await lc.shutdown("test");
    expect(order).toEqual(["sync-registered-second", "async-registered-first"]);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("keeps going when a cleanup throws", async () => {
    const ran: string[] = [];
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });
    lc.onCleanup(() => {
      ran.push("first");
    });
    lc.onCleanup(() => {
      throw new Error("cleanup exploded");
    });
    await lc.shutdown("test");
    expect(ran).toEqual(["first"]);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it("does not mutate the cleanup array when reversing (A15)", async () => {
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });
    const order: string[] = [];
    lc.onCleanup(() => {
      order.push("a");
    });
    lc.onCleanup(() => {
      order.push("b");
    });
    await lc.shutdown("test");
    expect(order).toEqual(["b", "a"]);
    // Registering after shutdown must still work — proves the array is intact.
    const unregister = lc.onCleanup(() => {
      order.push("c");
    });
    expect(typeof unregister).toBe("function");
    unregister();
  });

  it("handleSignals is idempotent (A15)", () => {
    const lc = new Lifecycle(fakeLogger, { exitFn: vi.fn() });
    const before = process.listenerCount("SIGINT");
    lc.handleSignals();
    lc.handleSignals();
    lc.handleSignals();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    lc.removeSignals();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("a second signal force-exits with 130 (A15)", async () => {
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });
    // Lifecycle is the only component that owns an exit (A9).
    lc.handleSignals();
    // A cleanup that defers keeps the first shutdown in flight long enough for
    // the second Ctrl+C to land.
    let release = (): void => {};
    lc.onCleanup(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );

    const p = lc.shutdown("first");
    expect(exitFn).not.toHaveBeenCalled();

    // Second Ctrl+C while the first shutdown is still running.
    process.emit("SIGINT");
    expect(exitFn).toHaveBeenCalledWith(130);

    release();
    await p;
    lc.removeSignals();
  });

  it("exits non-zero if a cleanup hangs past the hard timeout", async () => {
    vi.useFakeTimers();
    try {
      const exitFn = vi.fn();
      const lc = new Lifecycle(fakeLogger, { exitFn, timeoutMs: 5000 });
      lc.onCleanup(() => new Promise<void>(() => {})); // never resolves
      void lc.shutdown("hang");
      await vi.advanceTimersByTimeAsync(5001);
      expect(exitFn).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unregister removes a cleanup before it runs", async () => {
    const ran: string[] = [];
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, { exitFn });
    const unregister = lc.onCleanup(() => {
      ran.push("gone");
    });
    lc.onCleanup(() => {
      ran.push("kept");
    });
    unregister();
    await lc.shutdown("test");
    expect(ran).toEqual(["kept"]);
  });
});