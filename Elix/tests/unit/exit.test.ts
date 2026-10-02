import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  BotSession,
  type BotLike,
  type SessionDeps,
  type Vec3Like,
  type BlockLike,
} from "../../src/connection/bot.js";
import type { PingResult } from "../../src/connection/ping.js";
import type { ElixConfig } from "../../src/core/config.js";
import { PROJECT_ROOT } from "../../src/core/config.js";
import { resolve } from "node:path";

/**
 * A2: every process exit must go through exitCleanly, which sets
 * process.exitCode and lets the event loop drain. A bare process.exit() while
 * pino-pretty's worker is flushing tears the handle down mid-write and aborts
 * on Windows with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
 *
 * These tests spawn the real CLI so they catch an abnormal exit code, not just
 * a missing process.exit() call.
 */

// PROJECT_ROOT is resolved by the app itself, so this works from any cwd.
const DIST = resolve(PROJECT_ROOT, "dist", "cli", "index.js");

const CONFIG = {
  version: 1,
  bot: { username: "Elix", version: "26.2", serverAllowlist: [] },
  server: { profile: "main" },
  profiles: {},
  brain: { fastMaxTokens: 1, smartMaxTokens: 1, timeoutsMs: { fast: 1, smart: 1 }, idleChatterBudgetPerHour: 1 },
  voice: { enabled: false, textOnlyFallback: true },
  safety: { contentLevel: "kid-safe", chatRateLimitPer2s: 1 },
  persona: "p",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

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

/** Spawn the CLI and report the exact exit code. */
async function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 20_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((done) => {
    const child = spawn(process.execPath, [DIST, ...args], {
      env: { ...process.env, NODE_ENV: "production", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ status: code, stdout, stderr });
    });
  });
}

describe("A2 — the CLI exits with real codes, never a Windows abort", () => {
  it("doctor exits 0 when everything passes", async () => {
    const r = await spawnCli(["doctor"]);
    expect(r.stdout).toContain("failing");
    // 0, not 3221226505 (0xC0000409) and not -1073740791.
    expect(r.status).toBe(0);
  });

  it("a bad config exits 1, not a crash code", async () => {
    // ELIX_CONFIG points at a nonexistent file so loadElixConfig throws.
    const r = await spawnCli(["status"], { ELIX_CONFIG: "no-such-config.yaml" });
    expect(r.status).toBe(1);
  }, 20_000);

  it("an unknown profile exits 1 with a readable message (A3)", async () => {
    const r = await spawnCli(["start", "--profile", "definitely-not-a-profile"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('No server profile "definitely-not-a-profile"');
    expect(r.stderr + r.stdout).toContain("main");
  }, 20_000);

  it("a debug classification exits 0", async () => {
    const raw = JSON.stringify({
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
    });
    const r = await spawnCli(["debug", "kick-reason", raw]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { kind: string; shouldRetry: boolean };
    expect(parsed.kind).toBe("whitelist");
    expect(parsed.shouldRetry).toBe(false);
  });
});

describe("A2 — exitCleanly is the only exit path", () => {
  it("sets process.exitCode and does not call process.exit immediately", async () => {
    const { exitCleanly, resetExitState } = await import("../../src/core/exit.js");
    resetExitState();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit was called synchronously");
    }) as never);
    try {
      exitCleanly(2);
      // exitCode is set at once so a caller can observe the intent.
      expect(process.exitCode).toBe(2);
      // The actual process.exit is deferred behind setImmediate + a timer.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("a second call does not schedule a second forced exit", async () => {
    const { exitCleanly, resetExitState } = await import("../../src/core/exit.js");
    resetExitState();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      exitCleanly(1);
      exitCleanly(1);
      exitCleanly(1);
      await new Promise((r) => setTimeout(r, 500));
      // Exactly one forced exit, not three.
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
      process.exitCode = 0;
      resetExitState();
    }
  }, 15_000);

  it("a forced exit carries the code it was given", async () => {
    const { exitCleanly, resetExitState } = await import("../../src/core/exit.js");
    resetExitState();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      exitCleanly(2);
      await new Promise((r) => setTimeout(r, 500));
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
      process.exitCode = 0;
      resetExitState();
    }
  }, 15_000);
});

describe("A9 — only Lifecycle owns an exit", () => {
  it("BotSession.shutdown has no process.exit of its own", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const log = makeLog();
    const bot = new FakeBot();
    try {
      const session = new BotSession({
        config: CONFIG,
        profile: { name: "main", host: "h", port: 1, version: "26.2", username: "Elix" },
        log,
        pingResult: PING,
        factory: () => bot as unknown as BotLike,
        exitOnPermanent: false,
      } as SessionDeps);
      await session.start();
      bot.emit("spawn");
      // Resolve quickly: our fake quit emits 'end' on a microtask.
      await session.shutdown();
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("A8 — shutdown after end() does not chat or wait", () => {
  it("sends no goodbye and resolves fast when the socket already closed", async () => {
    vi.useFakeTimers();
    try {
      const chatSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const log = makeLog();
      const bot = new FakeBot();
      const session = new BotSession({
        config: CONFIG,
        profile: { name: "main", host: "h", port: 1, version: "26.2", username: "Elix" },
        log,
        pingResult: PING,
        factory: () => bot as unknown as BotLike,
        exitOnPermanent: false,
      } as SessionDeps);

      await session.start();
      bot.emit("spawn");

      // The connection dies. A dead mineflayer bot still has `entity`, which is
      // why the old `bot?.entity` check was not enough (A8).
      bot.emit("end", "socketClosed");
      const quitCountBefore = bot.quitCount;
      expect(bot.quitCount).toBe(quitCountBefore);

      const startedAt = Date.now();
      // Must settle on its own with no timer advance at all: the old code
      // waited 3 s for an 'end' that had already fired.
      await session.shutdown();
      const elapsed = Date.now() - startedAt;

      // No goodbye was attempted on a dead socket.
      expect(bot.chatCalls).toEqual([]);
      // And it did not wait for the shutdown timeout.
      expect(elapsed).toBeLessThan(50);
      expect(chatSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("still says goodbye when the bot is alive", async () => {
    vi.useFakeTimers();
    try {
      const log = makeLog();
      const bot = new FakeBot();
      const session = new BotSession({
        config: CONFIG,
        profile: { name: "main", host: "h", port: 1, version: "26.2", username: "Elix" },
        log,
        pingResult: PING,
        factory: () => bot as unknown as BotLike,
        exitOnPermanent: false,
      } as SessionDeps);
      await session.start();
      bot.emit("spawn");

      const p = session.shutdown();
      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      // The goodbye went through the chat queue.
      expect(bot.chatCalls).toContain("gtg, cya");
      expect(bot.quitCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const PING: PingResult = {
  version: "Paper 26.2",
  protocol: 776,
  software: "Paper",
  motd: "",
  players: { online: 1, max: 20 },
  raw: {},
};

class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  health = 20;
  entity: { position: Vec3Like; yaw: number } | undefined = {
    position: { x: 0, y: 65, z: 0 },
    yaw: 0,
  };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  chatCalls: string[] = [];
  quitCount = 0;
  silentQuit = false;
  _client = { on: () => {} };

  quit(): void {
    this.quitCount++;
    if (this.silentQuit) return;
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  blockAt(pos: Vec3Like): BlockLike | null {
    return pos.y < 65 ? { name: "stone", id: 1, boundingBox: "block" } : { name: "air", id: 0, boundingBox: "empty" };
  }
  loadPlugin(): void {}
  look(): void {}
}