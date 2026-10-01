import { describe, it, expect, vi } from "vitest";
import { bus } from "../../src/core/events.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { elixConfigSchema } from "../../src/core/config.js";

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
    bus.emit("bot:joined", { username: "Elix", host: "127.0.0.1", port: 25565 });
    expect(fn).toHaveBeenCalledWith({ username: "Elix", host: "127.0.0.1", port: 25565 });
    bus.off("bot:joined", fn);
  });

  it("stops delivery after off()", () => {
    const fn = vi.fn();
    bus.on("bot:chat", fn);
    bus.off("bot:chat", fn);
    bus.emit("bot:chat", { username: "Ali", text: "hi" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Lifecycle", () => {
  it("runs cleanups in reverse order, emits shutdown, exits once", async () => {
    const config = elixConfigSchema.parse({ version: 1 });
    const order: string[] = [];
    const exitFn = vi.fn();
    const lc = new Lifecycle(fakeLogger, exitFn);

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
    void config;
  });
});
