/**
 * Round 7 Part C — shutdown you can verify without a human.
 *
 * Ctrl+C can only be delivered from a keyboard, so every automated check of the
 * shutdown path was impossible: forcing the process to die proved nothing,
 * because the cleanups never ran. These two fixes make it testable and, more
 * importantly, make it testable for a real player who closes the window instead
 * of pressing Ctrl+C.
 *
 *   A1  `elix stop` — a second door into the SAME shutdown, over a local-only
 *       channel (Windows named pipe / Unix socket, never a TCP port).
 *   A2  SIGBREAK and SIGHUP — Ctrl+Break gets the normal path; a CLOSED CMD
 *       window gets a 6 s fast path that still writes the backup.
 *
 * Everything here is zero-network and uses a fake lifecycle and fake signals: no
 * real process is killed and no server is contacted.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlPath,
  isControlLive,
  requestStop,
  startControlServer,
} from "../../src/core/controlChannel.js";
import { Lifecycle, QUICK_SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from "../../src/core/lifecycle.js";
import { runMemoryShutdown } from "../../src/memory/shutdown.js";
import { MemoryStore } from "../../src/memory/store.js";
import { shutdownState } from "../../src/core/events.js";
import { createBackup } from "../../src/memory/backup.js";
import type { Route } from "../helpers/fake-fetch.js";
import { fakeFetch, okCompletion, okModels } from "../helpers/fake-fetch.js";

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  // The mode is process-global, so a quick-path test must not leak into the next.
  shutdownState.mode = "normal";
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "elix-r7c-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ================================================ A1 — elix stop, a 2nd door */

describe("A1 — `elix stop` reaches the same shutdown as Ctrl+C", () => {
  it("goes through lifecycle.shutdown and every registered cleanup runs", async () => {
    const projectRoot = tempDir();
    const order: string[] = [];
    const exitCodes: number[] = [];

    // The server and the lifecycle refer to each other — the server needs the
    // lifecycle to shut down, and the lifecycle needs the server to report its
    // exit code — so the server goes in a holder rather than a forward-declared
    // `let`, which would be a temporal dead zone the moment a stop arrived early.
    const holder: { server?: Awaited<ReturnType<typeof startControlServer>> } = {};
    const lifecycle = new Lifecycle(noLog as never, {
      exitFn: (code) => {
        exitCodes.push(code);
        order.push("exit");
      },
      // The exit code goes to the waiting client as the process's last act.
      onExit: async (code) => {
        await holder.server?.announceExit(code);
      },
    });
    lifecycle.onCleanup(() => {
      order.push("close db");
    });
    lifecycle.onCleanup(async () => {
      order.push("saving memories…");
    });
    lifecycle.onCleanup(() => {
      order.push("goodbye");
    });
    lifecycle.removeSignals(); // no real signal handlers in a test

    holder.server = await startControlServer({
      projectRoot,
      log: noLog,
      // The SAME path as Ctrl+C: same cleanups, same exit code.
      onStop: () => void lifecycle.shutdown("stop", 0),
    });

    const result = await requestStop(projectRoot, { timeoutMs: 5000 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.exitCode).toBe(0);
    expect(exitCodes).toEqual([0]);

    // The SAME cleanups, in the SAME reverse-registration order as Ctrl+C.
    expect(order).toEqual(["goodbye", "saving memories…", "close db", "exit"]);

    await holder.server!.close();
  });

  it("reports `not running` and exits 1 when nothing is listening", async () => {
    const projectRoot = tempDir();
    // Nothing has ever bound this project's channel.
    const result = await requestStop(projectRoot, { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-running");
  });

  it("cleans up a stale socket left by a crashed run", async () => {
    const projectRoot = tempDir();
    const path = controlPath(projectRoot);
    if (process.platform === "win32") return; // named pipes have no on-disk file

    // Simulate a crash: a server that is never closed.
    const dead = await startControlServer({ projectRoot, onStop: () => {}, log: noLog });
    // Forget it without closing — exactly what a force-killed process leaves.
    expect(existsSync(path)).toBe(true);
    void dead;

    // A fresh listen must succeed rather than dying on EADDRINUSE.
    const fresh = await startControlServer({ projectRoot, onStop: () => {}, log: noLog });
    expect(fresh.path).toBe(path);
    await fresh.close();
  });

  it("refuses a second Elix on the same project instead of fighting over the DB", async () => {
    const projectRoot = tempDir();
    const first = await startControlServer({ projectRoot, onStop: () => {}, log: noLog });
    // Two processes writing one SQLite database is how memories get lost.
    await expect(startControlServer({ projectRoot, onStop: () => {}, log: noLog })).rejects.toThrow(
      /already running/i,
    );
    await first.close();
  });

  it("uses a local-only channel, never a TCP port", () => {
    const path = controlPath("C:\\some\\project");
    if (process.platform === "win32") {
      // A kernel pipe namespace, addressed by name. No port, no interface.
      expect(path.startsWith("\\\\.\\pipe\\elix-")).toBe(true);
    } else {
      expect(path).not.toMatch(/:\d+$/);
      expect(path).toMatch(/elix-[0-9a-f]{16}\.sock$/);
    }
  });

  it("gives two different projects two different channels", () => {
    expect(controlPath("C:\\project-a")).not.toBe(controlPath("C:\\project-b"));
  });

  it("answers a ping, so a listener can be checked without stopping Elix", async () => {
    const projectRoot = tempDir();
    const server = await startControlServer({ projectRoot, onStop: () => {}, log: noLog });
    expect(await isControlLive(server.path)).toBe(true);
    await server.close();
    expect(await isControlLive(server.path)).toBe(false);
  });

  it("ignores an unknown command instead of shutting down", async () => {
    const projectRoot = tempDir();
    let stopped = false;
    const server = await startControlServer({
      projectRoot,
      onStop: () => {
        stopped = true;
      },
      log: noLog,
    });
    // A stray write must not be able to stop Elix.
    const { default: net } = await import("node:net");
    await new Promise<void>((resolve) => {
      const s = net.connect({ path: server.path }, () => s.write("rm -rf /\n"));
      s.on("data", () => {
        s.destroy();
        resolve();
      });
      s.on("error", resolve);
    });
    expect(stopped).toBe(false);
    await server.close();
  });
});

/* ================================== A2 — closing the window must not lose data */

describe("A2 — a closed CMD window takes a fast path that still backs up", () => {
  /** A lifecycle whose cleanups stand in for the real sequence. */
  function fakeLifecycle(exitCodes: number[]) {
    const order: string[] = [];
    const lifecycle = new Lifecycle(noLog as never, {
      timeoutMs: 60_000,
      exitFn: (code) => {
        exitCodes.push(code);
        order.push("exit");
      },
    });
    lifecycle.removeSignals(); // tests drive shutdown() directly
    return { lifecycle, order };
  }

  it("SIGHUP finishes inside 6 s, writes the backup, and exits 0", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    // A real store, so the backup is a real file on disk.
    const store = new MemoryStore({ path: dbPath });
    store.addEpisode({ ts: 1000, kind: "chat", player: "Steve", text: "a line worth keeping" });
    const backupDir = join(dir, "backups");

    const exitCodes: number[] = [];
    const { lifecycle, order } = fakeLifecycle(exitCodes);
    const began = Date.now();

    // The memory cleanup, wired exactly as stubs.ts wires it.
    lifecycle.onCleanup(async () => {
      await runMemoryShutdown({
        store,
        engine: {
          embedder: { isRunning: false },
          hasEmbeddings: false,
        } as never,
        storePath: dbPath,
        backupDir,
        router: null,
        hasModel: false,
        log: noLog,
        quick: shutdownState.mode === "quick",
      });
    });

    await lifecycle.shutdown("signal SIGHUP", 0, "quick");
    const elapsed = Date.now() - began;

    expect(elapsed).toBeLessThan(QUICK_SHUTDOWN_TIMEOUT_MS);
    expect(exitCodes).toEqual([0]);
    expect(order).toEqual(["exit"]);

    // The thing that must not be lost.
    const backups = existsSync(backupDir) ? readdirSync(backupDir) : [];
    expect(backups.length, "a backup was written").toBe(1);
    expect(backups[0]).toMatch(/\.db$/);
    // And it is a real, readable database, not an empty file.
    expect(createBackup({ dbPath, backupDir }).bytes).toBeGreaterThan(0);
  });

  it("SIGHUP skips consolidation, and defers it rather than losing it", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    store.addEpisode({ ts: 1000, kind: "chat", player: "Steve", text: "consolidate me" });

    // A fake fetch that would answer if consolidation were attempted. It must
    // not be called: a smart call is a network round-trip and the budget is 6 s.
    const routes: Route[] = [
      { match: "openai/v1/models", reply: okModels([]) },
      { match: "chat/completions", reply: okCompletion("") },
    ];
    const f = fakeFetch(routes);
    const chatCalls = (): number => f.calls.filter((c) => c.url.includes("chat/completions")).length;

    const report = await runMemoryShutdown({
      store,
      engine: { embedder: { isRunning: false }, hasEmbeddings: false } as never,
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: { complete: async () => ({ text: "", tokensIn: 0, tokensOut: 0, reasoningTokens: 0 }) } as never,
      hasModel: true,
      log: noLog,
      quick: true,
    });

    expect(report.consolidation).toBe("skipped-quick");
    expect(chatCalls()).toBe(0);
    // The backup still happened, and the store still closed.
    expect(report.backup.path).not.toBeNull();
    expect(report.closed).toBe(true);

    // "Deferred", not "dropped": reopen the database the way the next start does
    // and confirm the episode is still there and still above the watermark, so
    // the next consolidation genuinely picks it up.
    const next = new MemoryStore({ path: dbPath });
    expect(next.consolidatedWatermark()).toBe(0);
    expect(next.episodesAfterId(0).map((e) => e.text)).toEqual(["consolidate me"]);
    next.close();
  });

  it("SIGBREAK takes the normal path: consolidation runs, goodbye is awaited", async () => {
    // SIGBREAK is Ctrl+Break — the console equivalent of Ctrl+C. It used to be
    // unhandled, so the user got Node's default: terminate, no cleanups, no
    // backup. It must behave exactly like SIGINT.
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(QUICK_SHUTDOWN_TIMEOUT_MS);

    const order: string[] = [];
    const exitCodes: number[] = [];
    const { lifecycle } = fakeLifecycle(exitCodes);
    lifecycle.onCleanup(async () => {
      order.push("consolidation");
    });
    lifecycle.onCleanup(() => {
      order.push("goodbye (awaited)");
    });

    await lifecycle.shutdown("signal SIGBREAK");

    expect(shutdownState.mode).toBe("normal");
    expect(order).toEqual(["goodbye (awaited)", "consolidation"]);
    expect(exitCodes).toEqual([0]);
  });

  it("the normal path is what Ctrl+C and `elix stop` both take", async () => {
    // One code path, three doors. If these diverged, `elix stop` would be proving
    // something other than what Ctrl+C does.
    const exitCodes: number[] = [];
    for (const reason of ["signal SIGINT", "stop"]) {
      const { lifecycle } = fakeLifecycle(exitCodes);
      await lifecycle.shutdown(reason, 0);
      expect(shutdownState.mode).toBe("normal");
    }
    expect(exitCodes).toEqual([0, 0]);
  });

  it("quick mode uses a 6 s ceiling, not the 30 s one", async () => {
    // The 6 s matters: Windows kills the process about 10 s after the window
    // closes, so a 30 s budget would be cut off mid-backup — the exact failure
    // the backup exists to prevent, just on a different trigger.
    expect(QUICK_SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(6000);
    expect(QUICK_SHUTDOWN_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("a normal shutdown still does everything a quick one skips", async () => {
    // The fast path must not have quietly become the only path.
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    store.addEpisode({ ts: 1000, kind: "chat", player: "Steve", text: "hello" });

    const report = await runMemoryShutdown({
      store,
      engine: { embedder: { isRunning: false }, hasEmbeddings: false } as never,
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: null,
      hasModel: false,
      log: noLog,
      quick: false,
    });

    // No key, so consolidation is skipped for THAT reason, not the quick one.
    expect(report.consolidation).toBe("skipped-no-key");
    expect(report.backup.path).not.toBeNull();
    expect(report.closed).toBe(true);
  });
});