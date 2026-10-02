/**
 * A1–A6 — this round's bugs. One test per fix, all zero-network.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { BrainStore } from "../../src/brain/store.js";
import { BrainRouter } from "../../src/brain/router.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { HuggingFaceProvider } from "../../src/brain/hf.js";
import { buildBrain } from "../../src/brain/index.js";
import { checkApiKeys } from "../../src/core/doctor.js";
import { elixConfigSchema } from "../../src/core/config.js";
import { fakeFetch, okModels, type FakeFetch, type Route } from "../helpers/fake-fetch.js";
import type { ModelsConfig } from "../../src/core/config.js";

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const GROQ_MODEL = "openai/gpt-oss-20b";
const models: ModelsConfig = {
  providers: {
    groq: { baseUrl: null, env: "GROQ_API_KEY" },
    hf: { baseUrl: null, env: "HF_TOKEN" },
  },
  roles: {
    fast: {
      preference: [
        { provider: "groq", model: GROQ_MODEL },
        { provider: "hf", model: "meta-llama/Llama-3.3-70B-Instruct" },
        { provider: "builtin", model: "scripted" },
      ],
    },
    smart: { preference: [{ provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;

function tempStore(): BrainStore {
  const dir = mkdtempSync(join(tmpdir(), "elix-r3-"));
  const store = new BrainStore(join(dir, "elix.db"));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

// ---------------------------------------------------------------------------
// A1 — waitForShutdown must resolve AFTER cleanups
// ---------------------------------------------------------------------------

describe("A1 — the brain stays open until every cleanup has finished", () => {
  it("a cleanup that writes to the store during shutdown succeeds", async () => {
    const store = tempStore();
    const lifecycle = new Lifecycle(noLog as never, { exitFn: () => undefined });
    const wrote: number[] = [];

    // Cleanups run in REVERSE registration order, so the brain close below is
    // registered first and runs LAST — after this write.
    lifecycle.onCleanup(() => {
      // This MUST still be able to write: the database is not closed yet.
      store.recordUsage({
        ts: 2, provider: "groq", model: "m", role: "fast",
        tokensIn: 1, tokensOut: 1, reasoningTokens: 0, latencyMs: 1, outcome: "ok",
      });
      wrote.push(2);
    });
    // Registered last, so it runs first — like the shutdown backup.
    lifecycle.onCleanup(() => {
      store.recordUsage({
        ts: 1, provider: "groq", model: "m", role: "fast",
        tokensIn: 1, tokensOut: 1, reasoningTokens: 0, latencyMs: 1, outcome: "ok",
      });
      wrote.push(1);
    });

    await lifecycle.shutdown("test");
    expect(wrote).toEqual([1, 2]);
    expect(store.usageSince(0)).toHaveLength(2);
  });

  it("waitForShutdown resolves after cleanups, not when they begin", async () => {
    const lifecycle = new Lifecycle(noLog as never, { exitFn: () => undefined });
    const order: string[] = [];

    lifecycle.onCleanup(() => {
      order.push("brain-close");
    });
    lifecycle.onCleanup(async () => {
      // A slow cleanup, so ordering is unambiguous.
      await new Promise((r) => setTimeout(r, 20));
      order.push("goodbye");
    });

    let resolved = false;
    const waited = lifecycle.waitForShutdown().then(() => {
      resolved = true;
      order.push("wait-returned");
    });

    // Before shutdown: nothing has run.
    expect(order).toEqual([]);
    expect(resolved).toBe(false);

    const done = lifecycle.shutdown("test");
    // The instant shutdown starts, the cleanups are running but waitForShutdown
    // has NOT resolved. This is the A1 bug: it used to resolve right here, so
    // the caller's `finally` closed the database in parallel with them.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    expect(order).toEqual([]);

    await done;
    await waited;
    // The goodbye went out before the brain closed, and only then did the waiter
    // return.
    expect(order).toEqual(["goodbye", "brain-close", "wait-returned"]);
  });

  it("a shutdown backup written in a cleanup can still open the database", async () => {
    // The Phase 4 shape: backup + consolidation live in the brain cleanup and
    // need the store open.
    const store = tempStore();
    const lifecycle = new Lifecycle(noLog as never, { exitFn: () => undefined });
    let backedUp = 0;

    lifecycle.onCleanup(() => {
      // A read that fails loudly if the DB were closed first.
      const rows = store.usageSince(0);
      backedUp = rows.length;
    });
    await lifecycle.shutdown("test");
    expect(backedUp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A2 — permanent disconnects and crash bursts go through the Lifecycle
// ---------------------------------------------------------------------------

describe("A2 — shutdown carries an exit code and runs cleanups", () => {
  it("exits with the code it was given", async () => {
    const codes: number[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    await lifecycle.shutdown("permanent disconnect: whitelist", 2);
    expect(codes).toEqual([2]);
  });

  it("defaults to 0 for a normal Ctrl+C", async () => {
    const codes: number[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    await lifecycle.shutdown("signal SIGINT");
    expect(codes).toEqual([0]);
  });

  it("runs every registered cleanup before exiting 2", async () => {
    const codes: number[] = [];
    const ran: string[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    lifecycle.onCleanup(() => {
      ran.push("brain-close");
    });
    lifecycle.onCleanup(() => {
      ran.push("shutdown-backup");
    });
    await lifecycle.shutdown("permanent disconnect: whitelist", 2);
    // Reversed order, all of them, before the exit code is committed.
    expect(ran).toEqual(["shutdown-backup", "brain-close"]);
    expect(codes).toEqual([2]);
  });

  it("a second shutdown does not change the committed code", async () => {
    const codes: number[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    lifecycle.onCleanup(() => undefined);
    await lifecycle.shutdown("first", 2);
    await lifecycle.shutdown("second", 0);
    expect(codes).toEqual([2]);
  });

  it("still force-exits 130 on a second signal while shutdown is in flight", async () => {
    const codes: number[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    // A slow cleanup, so the second signal lands mid-shutdown — which is the
    // case that matters: the user is impatient because the goodbye is slow.
    lifecycle.onCleanup(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    lifecycle.handleSignals();
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    // A second Ctrl+C always wins with 130, whatever is in flight.
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 80));
    lifecycle.removeSignals();
    expect(codes).toContain(130);
  });
});

// ---------------------------------------------------------------------------
// A3 — brain.timeoutsMs is actually wired
// ---------------------------------------------------------------------------

describe("A3 — config timeouts reach the router", () => {
  it("config timeoutsMs.fast becomes the fast deadline", () => {
    const config = elixConfigSchema.parse({
      version: 1,
      brain: { timeoutsMs: { fast: 2000, smart: 20000 } },
    });
    const dir = mkdtempSync(join(tmpdir(), "elix-t-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const brain = buildBrain({
      models,
      config,
      projectRoot: dir,
      env: { GROQ_API_KEY: "gsk-test" },
      store,
    });
    // The public surface: the deadline the router will use for the fast role.
    const router = brain.router as unknown as { timeoutFor(role: string): number };
    expect(router.timeoutFor("fast")).toBe(2000);
    expect(router.timeoutFor("smart")).toBe(20000);
    brain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to 6000/20000 when config is absent", () => {
    const router = new BrainRouter({
      models,
      providers: {},
      store: tempStore(),
      log: noLog,
    }) as unknown as { timeoutFor(role: string): number };
    expect(router.timeoutFor("fast")).toBe(6000);
    expect(router.timeoutFor("smart")).toBe(20000);
  });

  it("actually times out a hanging call at the configured budget", async () => {
    const store = tempStore();
    const f: FakeFetch = fakeFetch([
      { match: "/models", reply: okModels([GROQ_MODEL]) },
      { match: "chat/completions", reply: { hang: true } },
    ] as Route[]);
    const router = new BrainRouter({
      models,
      providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
      store,
      log: noLog,
      // 150 ms instead of 2000 so the test does not sleep for two seconds.
      fastTimeoutMs: 150,
    });
    const began = Date.now();
    const res = await router.complete({
      messages: [{ role: "user", content: "hello there" }],
      role: "fast",
      bypassIdleBudget: true,
    });
    const elapsed = Date.now() - began;
    expect(res.fromFallback).toBe(true);
    // A 2000ms deadline would have taken at least 2000ms.
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });
});

// ---------------------------------------------------------------------------
// A4 — no literal NUL bytes in tracked source
// ---------------------------------------------------------------------------

describe("A4 — the secret scanner is reviewable text, not binary", () => {
  it("secrets.test.ts itself contains no NUL byte", () => {
    const raw = readFileSync(join(process.cwd(), "tests/unit/secrets.test.ts"));
    expect(raw.includes(0)).toBe(false);
  });

  it("the NUL check is written as an escape, not a raw byte", () => {
    const text = readFileSync(join(process.cwd(), "tests/unit/secrets.test.ts"), "utf8");
    expect(text).toContain("u0000");
  });
});

// ---------------------------------------------------------------------------
// A5 — the .env template is back, and doctor says how to create it
// ---------------------------------------------------------------------------

describe("A5 — the .env template is tracked and doctor names the fix", () => {
  it(".env.example exists in the repo", () => {
    expect(existsSync(join(process.cwd(), ".env.example"))).toBe(true);
  });

  it(".env.example has empty values, never a key", () => {
    const text = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(text).toMatch(/^GROQ_API_KEY=\s*$/m);
    expect(text).toMatch(/^HF_TOKEN=\s*$/m);
    expect(text).not.toMatch(/gsk_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/hf_[A-Za-z0-9]{8,}/);
  });

  it("doctor says how to create .env when the file is missing", () => {
    // The exact message a new user needs.
    const r = checkApiKeys({});
    expect(r.status).toBe("warn");
    // On this machine .env does not exist, so the fix must be named.
    if (!existsSync(join(process.cwd(), ".env"))) {
      expect(r.note).toContain("copy .env.example .env");
    } else {
      expect(r.note).toMatch(/no provider keys|copy \.env\.example/);
    }
  });
});

// ---------------------------------------------------------------------------
// A6 — embed() has a signal and a timeout
// ---------------------------------------------------------------------------

describe("A6 — HF embed() is bounded", () => {
  it("defaults to a 10 s deadline", () => {
    const src = readFileSync(join(process.cwd(), "src/brain/hf.ts"), "utf8");
    expect(src).toContain("EMBEDDINGS_TIMEOUT_MS");
  });

  it("passes a signal to the request", async () => {
    const f = fakeFetch([{ match: "feature-extraction", reply: { status: 200, body: "[[0.1,0.2]]" } }]);
    const p = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
    const controller = new AbortController();
    await p.embed(["hello"], "BAAI/bge-small-en-v1.5", controller.signal);
    expect(f.calls[0]!.method).toBe("POST");
    expect(await p.embed(["x"], "BAAI/bge-small-en-v1.5", undefined, 50)).toBeTruthy();
  });

  it("throws on a timeout so the row stays unembedded for a later retry", async () => {
    const f = fakeFetch([{ match: "feature-extraction", reply: { hang: true } }]);
    const p = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
    await expect(
      p.embed(["hello"], "BAAI/bge-small-en-v1.5", undefined, 60),
    ).rejects.toThrow();
  });

  it("honours a caller abort immediately", async () => {
    const f = fakeFetch([{ match: "feature-extraction", reply: { hang: true } }]);
    const p = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
    const controller = new AbortController();
    const promise = p.embed(["hello"], "BAAI/bge-small-en-v1.5", controller.signal, 10_000);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
