/**
 * Round 7, Part A — the memory bugs found by running the engine directly.
 * One test per fix, all zero-network.
 *
 * Each describe block is one bug from the report, and the FIRST test in it is
 * the reproduction of what was actually observed.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, defaultMemoryPath } from "../../src/memory/store.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import { QueryEmbedder, normaliseQuery, QUERY_EMBED_TIMEOUT_MS } from "../../src/memory/queryEmbed.js";
import { WorldRecorder, DUPLICATE_WINDOW_MS, AMBIENT_PER_PLAYER_PER_MIN } from "../../src/memory/recorder.js";
import { NightlyScheduler, NIGHT_TICKS, REAL_MINUTES_MS, EMBED_INTERVAL_MS } from "../../src/memory/scheduler.js";
import { runMemoryShutdown, CONSOLIDATION_BUDGET_MS } from "../../src/memory/shutdown.js";
import { HuggingFaceProvider } from "../../src/brain/hf.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { Lifecycle, SHUTDOWN_TIMEOUT_MS } from "../../src/core/lifecycle.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { checkInputSafety } from "../../src/brain/fallback.js";
import { fakeFetch, okCompletion, okModels, type FakeFetch, type Route } from "../helpers/fake-fetch.js";
import { bus } from "../../src/core/events.js";
import { Memory } from "../../src/memory/retrieval.js";
import type { ModelsConfig } from "../../src/core/config.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "elix-r7-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempStore(): MemoryStore {
  const store = new MemoryStore({ path: join(tempDir(), "elix.db") });
  cleanups.push(() => store.close());
  return store;
}

/** The on-disk path of a store, so a backup test can point at the real file. */
function pathOf(store: MemoryStore): string {
  return store.path;
}

function brainStore(): BrainStore {
  const store = new BrainStore(join(tempDir(), "brain.db"));
  cleanups.push(() => store.close());
  return store;
}

const GROQ_MODEL = "openai/gpt-oss-20b";
const models: ModelsConfig = {
  providers: { groq: { baseUrl: null, env: "GROQ_API_KEY" }, hf: { baseUrl: null, env: "HF_TOKEN" } },
  roles: {
    fast: { preference: [{ provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: GROQ_MODEL }] },
  },
} as ModelsConfig;

function engine(store: MemoryStore, now?: () => number): MemoryEngine {
  return new MemoryEngine({
    store,
    embeddingProvider: null,
    embeddingModel: "BAAI/bge-small-en-v1.5",
    ...(now ? { now } : {}),
  });
}

// ===========================================================================
// A1 — the shutdown ceiling was shorter than the work
// ===========================================================================

describe("A1 — shutdown fits inside the ceiling", () => {
  function hangRoutes(): { f: FakeFetch; chats: () => number } {
    const f = fakeFetch([
      { match: "api.groq.com/openai/v1/models", reply: okModels([GROQ_MODEL]) },
      { match: "chat/completions", reply: { hang: true } },
    ] as Route[]);
    return { f, chats: () => f.callsTo("chat/completions").length };
  }

  it("the Lifecycle ceiling now exceeds the whole shutdown sequence", () => {
    // The bug: a 10 s ceiling against an 8 s consolidation plus a 10 s embedding
    // call. The backup sits between them and never ran.
    expect(SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    expect(CONSOLIDATION_BUDGET_MS).toBe(8_000);
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(CONSOLIDATION_BUDGET_MS * 2);
  });

  it("a hanging consolidation still leaves the backup written and the store closed", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    cleanups.push(() => store.close());
    store.loadVec();
    store.addEpisode({ ts: Date.now(), kind: "chat", player: "Ali", text: "something happened" });

    const { f } = hangRoutes();
    const router = new BrainRouter({
      models,
      providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
      store: brainStore(),
      log: noLog as never,
      cacheEnabled: false,
    });

    const started = Date.now();
    const report = await runMemoryShutdown({
      store,
      engine: engine(store),
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router,
      hasModel: true,
      log: noLog as never,
      // 200 ms stands in for the 8 s, so the test does not take 8 s to prove
      // that a hang is survivable.
      consolidationBudgetMs: 200,
      budgetMs: 5_000,
    });

    // The point of the whole exercise.
    expect(report.consolidation).toBe("skipped-timeout");
    expect(report.backup.path).not.toBeNull();
    expect(existsSync(report.backup.path!)).toBe(true);
    expect(report.backup.bytes).toBeGreaterThan(0);
    expect(report.closed).toBe(true);
    // And it got there inside the budget rather than hanging.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 20_000);

  it("skips consolidation entirely with no provider key, and still backs up", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    cleanups.push(() => store.close());
    store.addEpisode({ ts: Date.now(), kind: "chat", player: "Ali", text: "a line" });

    const f = fakeFetch([] as Route[]);
    const report = await runMemoryShutdown({
      store,
      engine: engine(store),
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: new BrainRouter({
        models,
        providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
        store: brainStore(),
        log: noLog as never,
      }),
      hasModel: false,
      log: noLog as never,
    });
    expect(report.consolidation).toBe("skipped-no-key");
    expect(f.calls).toHaveLength(0);
    // The backup is unconditional. That is the whole contract.
    expect(report.backup.path).not.toBeNull();
    expect(report.closed).toBe(true);
  });

  it("runs in order: consolidation, then backup, then embedding, then close", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    cleanups.push(() => store.close());
    store.addEpisode({ ts: Date.now(), kind: "chat", player: "Ali", text: "we mined iron" });
    const order: string[] = [];
    const spyStore = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "close") return () => order.push("close");
        return Reflect.get(target, prop, recv) as unknown;
      },
    });

    // A successful consolidation so the ordering has something real to wait for.
    const f = fakeFetch([
      { match: "api.groq.com/openai/v1/models", reply: okModels([GROQ_MODEL]) },
      {
        match: "chat/completions",
        reply: okCompletion(JSON.stringify({ facts: [], diaryNote: "ok" })),
      },
    ] as Route[]);
    const report = await runMemoryShutdown({
      store: spyStore,
      engine: engine(store),
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: new BrainRouter({
        models,
        providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
        store: brainStore(),
        log: noLog as never,
        cacheEnabled: false,
      }),
      hasModel: true,
      log: noLog as never,
    });
    expect(report.consolidation).toBe("ok");
    // close() is last, and the backup exists.
    expect(order).toEqual(["close"]);
    expect(report.backup.path).not.toBeNull();
  });

  it("prints a progress line so the waiting is explained", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    cleanups.push(() => store.close());
    const lines: string[] = [];
    const f = fakeFetch([
      { match: "api.groq.com/openai/v1/models", reply: okModels([GROQ_MODEL]) },
      { match: "chat/completions", reply: okCompletion(JSON.stringify({ facts: [], diaryNote: "" })) },
    ] as Route[]);
    await runMemoryShutdown({
      store,
      engine: engine(store),
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: new BrainRouter({
        models,
        providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
        store: brainStore(),
        log: noLog as never,
        cacheEnabled: false,
      }),
      hasModel: true,
      log: noLog as never,
      onProgress: (l) => lines.push(l),
    });
    expect(lines).toContain("saving memories…");
  });

  it("skips the embedding drain when the budget is already spent", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "elix.db");
    const store = new MemoryStore({ path: dbPath });
    cleanups.push(() => store.close());
    store.loadVec();
    store.addEpisode({ ts: Date.now(), kind: "chat", player: "Ali", text: "unembedded" });
    // A 0 ms budget: consolidation is skipped and the drain must be too.
    const report = await runMemoryShutdown({
      store,
      engine: engine(store),
      storePath: dbPath,
      backupDir: join(dir, "backups"),
      router: null,
      hasModel: false,
      log: noLog as never,
      budgetMs: 0,
    });
    expect(report.embed).toBe("skipped-no-budget");
    expect(report.ranOutOfBudget).toBe(true);
    // Even so: the backup happened.
    expect(report.backup.path).not.toBeNull();
  });

  it("a second Ctrl+C still forces 130 mid-shutdown", async () => {
    const codes: number[] = [];
    const lifecycle = new Lifecycle(noLog as never, { exitFn: (c) => codes.push(c) });
    lifecycle.handleSignals();
    lifecycle.onCleanup(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 80));
    lifecycle.removeSignals();
    expect(codes).toContain(130);
  });
});

// ===========================================================================
// A2 — "nightly" was never implemented
// ===========================================================================

describe("A2 — the nightly scheduler actually runs", () => {
  let clock: number;
  let ticks: number;
  beforeEach(() => {
    clock = 1_700_000_000_000;
    ticks = 0;
  });

  function sched(store: MemoryStore, opts: Partial<{ hasModel: boolean }> = {}): {
    scheduler: NightlyScheduler;
    chats: () => number;
    backups: () => string[];
  } {
    const f = fakeFetch([
      { match: "api.groq.com/openai/v1/models", reply: okModels([GROQ_MODEL]) },
      {
        match: "chat/completions",
        reply: () =>
          okCompletion(
            JSON.stringify({
              facts: [{ subject: "ali", predicate: "likes", object: "iron", confidence: 0.8 }],
              diary: "a quiet day",
            }),
          ),
      },
    ] as Route[]);
    const dir = tempDir();
    const router = new BrainRouter({
      models,
      providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
      store: brainStore(),
      log: noLog as never,
      cacheEnabled: false,
    });
    const scheduler = new NightlyScheduler({
      store,
      engine: engine(store, () => clock),
      router,
      storePath: pathOf(store),
      backupDir: join(dir, "backups"),
      hasModel: opts.hasModel ?? true,
      log: noLog as never,
      timeOfDay: () => ticks,
      now: () => clock,
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    return {
      scheduler,
      chats: () => f.callsTo("chat/completions").length,
      backups: () => (existsSync(join(dir, "backups")) ? [dir] : []),
    };
  }

  it("sleeps and backs up when the in-game clock reaches night", async () => {
    const store = tempStore();
    store.addEpisode({ ts: clock, kind: "chat", player: "Ali", text: "we mined iron" });
    const { scheduler, chats } = sched(store);
    // Daytime: nothing.
    ticks = 1_000;
    const day = await scheduler.tick();
    expect(day.consolidated).toBe(false);
    expect(day.backedUp).toBe(false);
    expect(chats()).toBe(0);
    // Night falls.
    ticks = NIGHT_TICKS + 100;
    const night = await scheduler.tick();
    expect(night.consolidated).toBe(true);
    expect(night.backedUp).toBe(true);
    expect(night.factsMade).toBeGreaterThanOrEqual(1);
    expect(chats()).toBeGreaterThan(0);
  });

  it("runs at most once per in-game night, and again the NEXT night", async () => {
    const store = tempStore();
    store.addEpisode({ ts: clock, kind: "chat", player: "Ali", text: "we mined iron" });
    const { scheduler, chats } = sched(store);
    ticks = NIGHT_TICKS + 100;
    await scheduler.tick();
    const after = chats();
    // Twenty more wake-ups in the same night.
    for (let i = 0; i < 20; i++) {
      const r = await scheduler.tick();
      expect(r.consolidated).toBe(false);
    }
    expect(chats()).toBe(after);

    // The old test advanced the clock by 4800 ticks and expected a sleep, which
    // landed on 17900 — still night in real Minecraft. It passed BECAUSE of the
    // bug: Math.floor(17900 / 2400) is 7, and 7 read as a new "day". The night
    // runs 13000..23000, so the next sleep needs a real dawn in between.
    ticks = 1000; // dawn: no sleep, and the night re-arms
    expect((await scheduler.tick()).consolidated).toBe(false);

    ticks = NIGHT_TICKS + 100; // the next night
    const nextNight = await scheduler.tick();
    expect(nextNight.consolidated).toBe(true);
  });

  it("sleeps after 60 real minutes even without a clock", async () => {
    const store = tempStore();
    store.addEpisode({ ts: clock, kind: "chat", player: "Ali", text: "we mined iron" });
    const { scheduler } = sched(store);
    ticks = 0; // never night: no clock data at all
    expect((await scheduler.tick()).consolidated).toBe(false);
    clock += REAL_MINUTES_MS + 1;
    expect((await scheduler.tick()).consolidated).toBe(true);
  });

  it("backs up even when consolidation is skipped for want of a key", async () => {
    const store = tempStore();
    store.addEpisode({ ts: clock, kind: "chat", player: "Ali", text: "a line" });
    const { scheduler } = sched(store, { hasModel: false });
    ticks = NIGHT_TICKS + 1;
    const r = await scheduler.tick();
    expect(r.consolidated).toBe(false);
    // The nightly safety net does not depend on having a model.
    expect(r.backedUp).toBe(true);
  });

  it("drains embeddings on its own interval, not just at startup", async () => {
    const store = tempStore();
    store.loadVec();
    const embeds = fakeFetch([
      {
        match: "feature-extraction",
        reply: {
          status: 200,
          body: JSON.stringify([new Array(384).fill(0.1)]),
        },
      },
    ] as Route[]);
    const dir = tempDir();
    store.addEpisode({ ts: clock, kind: "chat", player: "Ali", text: "needs a vector" });
    const scheduler = new NightlyScheduler({
      store,
      engine: new MemoryEngine({
        store,
        embeddingProvider: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: embeds.fn }),
        embeddingModel: "BAAI/bge-small-en-v1.5",
        now: () => clock,
      }),
      router: null,
      storePath: join(dir, "elix.db"),
      backupDir: join(dir, "backups"),
      hasModel: false,
      log: noLog as never,
      timeOfDay: () => 0,
      now: () => clock,
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    // Too soon: the drain waits for its interval.
    const first = await scheduler.tick();
    expect(first.embedded).toBe(0);
    clock += EMBED_INTERVAL_MS + 1;
    const second = await scheduler.tick();
    expect(second.embedded).toBe(1);
    expect(store.countUnembedded()).toBe(0);
  });

  it("does nothing after stop()", async () => {
    const store = tempStore();
    const { scheduler } = sched(store);
    scheduler.stop();
    ticks = NIGHT_TICKS + 1;
    expect((await scheduler.tick()).consolidated).toBe(false);
  });
});

// ===========================================================================
// A3 — vectors were paid for and never read
// ===========================================================================

describe("A3 — the query is embedded, on a 1.5 s budget", () => {
  const EMB = 384;
  const near = new Array(EMB).fill(0);
  near[0] = 1;
  const far = new Array(EMB).fill(0);
  far[EMB - 1] = 1;

  it("a query with a vector ranks a semantic match that FTS would miss", async () => {
    const store = tempStore();
    store.loadVec();
    const t = 1_700_000_000_000;
    // Semantic pair: "we built a redstone clock" and "what do we use to time things".
    // They share NO keywords, so FTS alone returns nothing for the query.
    // The stored pair and the query share NO keywords, so FTS5 alone returns
    // nothing at all. Only the vector can connect "timekeeping device" to a
    // memory about a mechanism that counts seconds.
    const a = store.addEpisode({
      ts: t,
      kind: "build",
      player: "Ali",
      text: "a mechanism that counts seconds automatically",
    });
    const b = store.addEpisode({
      ts: t,
      kind: "chat",
      player: "Ali",
      text: "a redwood forest at dawn",
    });
    store.markEmbedded(a, near);
    store.markEmbedded(b, far);
    const f = fakeFetch([
      { match: "feature-extraction", reply: { status: 200, body: JSON.stringify([near]) } },
    ] as Route[]);
    const queryEmbedder = new QueryEmbedder({
      provider: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
      model: "BAAI/bge-small-en-v1.5",
      timeoutMs: 1_500,
    });
    const vector = await queryEmbedder.embed("timekeeping device");
    expect(vector).not.toBeNull();
    const results = new Memory(store).search("timekeeping device", vector, { limit: 5, now: t });
    expect(results[0]!.episode.text).toBe("a mechanism that counts seconds automatically");
    expect(results[0]!.source).toBe("vector");
    // The same query with no vector finds nothing at all: that is the bug.
    expect(new Memory(store).search("timekeeping device", null, { now: t })).toHaveLength(0);
  });

  it("defaults to a 1.5 s deadline, not the 10 s episode one", () => {
    expect(QUERY_EMBED_TIMEOUT_MS).toBe(1_500);
  });

  it("times out into null rather than stalling the reply", async () => {
    const f = fakeFetch([{ match: "feature-extraction", reply: { hang: true } }] as Route[]);
    const q = new QueryEmbedder({
      provider: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
      model: "BAAI/bge-small-en-v1.5",
      timeoutMs: 80,
    });
    const began = Date.now();
    expect(await q.embed("anything")).toBeNull();
    expect(Date.now() - began).toBeLessThan(2_000);
  }, 10_000);

  it("caches by normalised text, so a repeat costs nothing", async () => {
    let calls = 0;
    const f = fakeFetch([
      {
        match: "feature-extraction",
        reply: () => {
          calls++;
          return { status: 200, body: JSON.stringify([near]) };
        },
      },
    ] as Route[]);
    const q = new QueryEmbedder({
      provider: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
      model: "BAAI/bge-small-en-v1.5",
    });
await q.embed("what's your favourite block");
    // Same question: case, punctuation, spacing and leading noise removed.
    await q.embed("  WHAT'S your Favourite block?!  ");
    // A genuinely different question is a different cache entry.
    await q.embed("what time is it");
    expect(calls).toBe(2);
    expect(q.cacheSize).toBe(2);
  });

  it("normalises case, punctuation and spacing", () => {
    expect(normaliseQuery("  What's   YOUR favourite Block?! ")).toBe("what s your favourite block");
    expect(normaliseQuery("a b")).toBe("a b");
    expect(normaliseQuery("!!!")).toBe("");
  });

  it("skips the request when HF is disabled or cooling down", async () => {
    const f = fakeFetch([
      { match: "feature-extraction", reply: { status: 200, body: JSON.stringify([near]) } },
    ] as Route[]);
    const provider = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
    // No provider at all.
    expect(await new QueryEmbedder({ provider: null, model: "m" }).embed("x")).toBeNull();
    // Provider present but the gate says no.
    const cooling = new QueryEmbedder({
      provider,
      model: "m",
      isAvailable: () => false,
    });
    expect(await cooling.embed("x")).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("does not retry a question that just timed out", async () => {
    let calls = 0;
    const f = fakeFetch([
      {
        match: "feature-extraction",
        reply: () => {
          calls++;
          return { status: 402, body: "no credit" };
        },
      },
    ] as Route[]);
    const q = new QueryEmbedder({
      provider: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
      model: "m",
    });
    expect(await q.embed("same question")).toBeNull();
    expect(await q.embed("same question")).toBeNull();
    // The second attempt would only have been spent to be refused again.
    expect(calls).toBe(1);
  });

  it("the router can say whether a provider is worth calling", () => {
    const store = brainStore();
    const router = new BrainRouter({
      models,
      providers: {},
      store,
      log: noLog as never,
    });
    // Nothing disabled, nothing cooling down.
    expect(router.isProviderUsable("hf", Date.now())).toBe(true);
  });
});

// ===========================================================================
// A4 — the current message was retrieved as a memory of itself
// ===========================================================================

describe("A4 — the current question is never its own memory", () => {
it("the reported case: the question is not in the block the bridge sent", async () => {
    const store = tempStore();
    const eng = engine(store);
    // Capture the block the bridge HANDS TO THE PROMPT. Asserting on a later
    // independent context() call proved nothing: that call has no idea which
    // question is in flight.
    let sent = "";
    const f = fakeFetch([
      { match: "api.groq.com/openai/v1/models", reply: okModels([GROQ_MODEL]) },
      { match: "chat/completions", reply: okCompletion("cherry planks, obviously") },
    ] as Route[]);
    const bridge = new ChatBridge({
      router: new BrainRouter({
        models,
        providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
        store: brainStore(),
        log: noLog as never,
        cacheEnabled: false,
      }),
      username: "Elix",
      log: noLog as never,
      memory: {
        record: (i) =>
          eng.record({
            text: i.text,
            speaker: i.speaker,
            player: i.player ?? null,
            kind: (i.kind as never) ?? "chat",
          }).id,
        context: (player, query) => {
          sent = eng.context(player, query, null);
          return sent;
        },
        preference: (p, k) => eng.preference(p, k),
        capturePreference: (p, t) => eng.capturePreference(p, t),
      },
    });

    // Ask exactly the reported question.
    const reply = await bridge.handle("Ali", "elix what is my favourite block");
    expect(reply.replied).toBe(true);

    // The question WAS stored — A6 requires that.
    const stored = store.raw().prepare("SELECT text FROM episodes").all() as unknown as Array<{
      text: string;
    }>;
    expect(stored.map((r) => r.text)).toContain("elix what is my favourite block");

    // But the memory block sent with the prompt must NOT quote it back.
    expect(sent).not.toContain("elix what is my favourite block");
  });

  it("excludeEpisodeIds removes this turn's episodes from the block", () => {
    const store = tempStore();
    const id = store.addEpisode({
      ts: 1,
      kind: "chat",
      player: "Ali",
      text: "what is my favourite block",
    });
    store.addEpisode({ ts: 2, kind: "chat", player: "Ali", text: "my favourite clock is redstone" });
    const withIt = engine(store).context("Ali", "what is my favourite block", null);
    expect(withIt).toContain("what is my favourite block");
    const withoutIt = engine(store).context("Ali", "what is my favourite block", null, {
      excludeEpisodeIds: [id],
    });
    expect(withoutIt).not.toContain("what is my favourite block");
    // The other memory still comes through: exclusion is targeted, not a wipe.
    expect(withoutIt).toContain("redstone");
  });

  it("an excluded id is dropped from the vector path too", async () => {
    const store = tempStore();
    store.loadVec();
    const v = new Array(384).fill(0);
    v[0] = 1;
    const id = store.addEpisode({ ts: 1, kind: "chat", player: "Ali", text: "cherry planks" });
    store.markEmbedded(id, v);
    
    const m = new Memory(store);
    expect(m.search("cherry planks", v, { now: 1 })).toHaveLength(1);
    expect(m.search("cherry planks", v, { now: 1, excludeEpisodeIds: [id] })).toHaveLength(0);
  });
});

// ===========================================================================
// A5 — a stale favourite after a change
// ===========================================================================

describe("A5 — a changed preference replaces the old one", () => {
  it("the reported case: preference() returns the LATEST value", () => {
    const store = tempStore();
    const e = engine(store);
    e.capturePreference("Ali", "my favourite block is diamond");
    e.capturePreference("Ali", "my favourite block is cherry planks");
    // The bug returned "diamond".
    expect(e.preference("Ali", "block")).toBe("cherry planks");
  });

  it("the profile line holds ONE value per kind", () => {
    const store = tempStore();
    const e = engine(store);
    e.capturePreference("Ali", "my favourite block is diamond");
    e.capturePreference("Ali", "my favourite block is cherry planks");
    const prefs = store.person("Ali")!.preferences;
    // The bug produced ["block: diamond", "block: cherry planks"].
    expect(prefs).toEqual(["block: cherry planks"]);
  });

  it("the fact history still keeps the old value, linked forward", () => {
    const store = tempStore();
    const e = engine(store);
    e.capturePreference("Ali", "my favourite block is diamond");
    e.capturePreference("Ali", "my favourite block is cherry planks");
    const all = store.raw().prepare("SELECT id, object, superseded_by FROM facts ORDER BY id").all() as unknown as Array<{
      id: number;
      object: string;
      superseded_by: number | null;
    }>;
    expect(all).toHaveLength(2);
    expect(all[0]!.object).toBe("diamond");
    expect(all[0]!.superseded_by).toBe(all[1]!.id);
    expect(store.factsFor("Ali").map((f) => f.object)).toEqual(["cherry planks"]);
  });

  it("different kinds do not clobber each other", () => {
    const store = tempStore();
    const e = engine(store);
    e.capturePreference("Ali", "my favourite block is cherry planks");
    e.capturePreference("Ali", "my favourite food is pizza");
    e.capturePreference("Ali", "my favourite block is dirt");
    expect(store.person("Ali")!.preferences.sort()).toEqual(["block: dirt", "food: pizza"]);
    expect(e.preference("Ali", "block")).toBe("dirt");
    expect(e.preference("Ali", "food")).toBe("pizza");
  });

  it("the value stops at a clause break", () => {
    const store = tempStore();
    const e = engine(store);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["my favourite block is cherry planks and i love it", "cherry planks"],
      ["my favourite block is cherry planks, it's nice", "cherry planks"],
      ["my favourite block is cherry planks.", "cherry planks"],
      ["my favourite block is cherry planks!", "cherry planks"],
      ["my favourite block is cherry planks lol", "cherry planks"],
      ["my favourite block is cherry planks but deepslate is cool", "cherry planks"],
      ["my favourite block is the dirt", "dirt"],
      ["my favourite block is cherry planks", "cherry planks"],
    ];
    for (const [text, want] of cases) {
      expect(e.capturePreference("Ali", text), text).toBe(want);
    }
  });

  it("a line with no preference is left alone", () => {
    const store = tempStore();
    const e = engine(store);
    expect(e.capturePreference("Ali", "the ship is cool")).toBeNull();
    expect(e.capturePreference("Ali", "i favourite nothing")).toBeNull();
  });

  it("preference() falls back to the profile list for a kind with no fact", () => {
    const store = tempStore();
    store.touchPerson("Ali", 1);
    store.setPersonJson("Ali", "preferences", ["food: pizza"]);
    expect(engine(store).preference("Ali", "food")).toBe("pizza");
    expect(engine(store).preference("Ali", "colour")).toBeNull();
  });
});

// ===========================================================================
// A6 — "never forgets" only covered chat addressed to Elix
// ===========================================================================

describe("A6 — everything Elix sees is recorded", () => {
  it("unaddressed chat is stored as ambient", async () => {
    const store = tempStore();
    const e = engine(store);
    const bridge = new ChatBridge({
      router: new BrainRouter({ models, providers: {}, store: brainStore(), log: noLog }),
      username: "Elix",
      log: noLog as never,
      memory: {
        record: (i) => e.record({ text: i.text, speaker: i.speaker, player: i.player ?? null }).id,
        context: () => "",
        preference: () => null,
        capturePreference: () => null,
      },
      recorder: {
        record: (p, t, o) => store.addEpisode({ ts: 1, kind: "ambient", player: p, speaker: "player", text: t, ...(o?.ignoreCaps ? {} : {}) }),
      },
    });
    const r = await bridge.handle("Steve", "this ship is cool");
    expect(r.replied).toBe(false);
    expect(r.reason).toBe("not-addressed");
    // The bug: nothing was stored at all.
    const rows = store.raw().prepare("SELECT kind, text FROM episodes").all() as unknown as Array<{
      kind: string;
      text: string;
    }>;
    expect(rows).toEqual([{ kind: "ambient", text: "this ship is cool" }]);
  });

  it("a scripted line Elix said is an episode too", () => {
    const store = tempStore();
    const e = engine(store);
    const bridge = new ChatBridge({
      router: new BrainRouter({ models, providers: {}, store: brainStore(), log: noLog }),
      username: "Elix",
      log: noLog as never,
      memory: {
        record: (i) => e.record({ text: i.text, speaker: i.speaker, player: i.player ?? null }).id,
        context: () => "",
        preference: () => null,
        capturePreference: () => null,
      },
    });
    bridge.recordScripted("hi ElixTester!", "ElixTester");
    const rows = store.raw().prepare("SELECT speaker, text FROM episodes").all() as unknown as Array<{
      speaker: string;
      text: string;
    }>;
    expect(rows).toEqual([{ speaker: "elix", text: "hi ElixTester!" }]);
  });

  it("a join updates last_seen and records a first meeting", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 1_000 });
    cleanups.push(() => rec.detachAll());
    rec.attach();
    expect(store.person("Ali")).toBeNull();
    bus.emit("bot:playerJoined", { username: "Ali" });
    expect(store.person("Ali")?.firstSeen).toBe(1_000);
    expect(store.person("Ali")?.lastSeen).toBe(1_000);
    // The first meeting is worth an event row.
    const events = store.raw().prepare("SELECT kind, text FROM episodes").all() as unknown as Array<{
      kind: string;
      text: string;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("event");
    expect(events[0]!.text).toContain("Ali");
    // A second join is not a new first meeting.
    bus.emit("bot:playerJoined", { username: "Ali" });
    expect(
      (store.raw().prepare("SELECT count(*) AS c FROM episodes").get() as { c: number }).c,
    ).toBe(1);
  });

  it("a leave updates last_seen", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 500 });
    cleanups.push(() => rec.detachAll());
    store.touchPerson("Ali", 100);
    rec.attach();
    bus.emit("bot:playerLeft", { username: "Ali" });
    expect(store.person("Ali")?.lastSeen).toBe(500);
  });

  it("a death is recorded at importance 8, with its position", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 7 });
    cleanups.push(() => rec.detachAll());
    rec.attach();
    bus.emit("bot:died", { position: { x: 12.4, y: -60, z: 8.1 }, dimension: "overworld" });
    const row = store.raw().prepare("SELECT kind, importance, x, y, z, dimension, speaker FROM episodes").get() as Record<string, unknown>;
    expect(row.kind).toBe("death");
    expect(row.importance).toBe(8);
    expect(row.x).toBeCloseTo(12.4);
    expect(row.dimension).toBe("overworld");
    expect(row.speaker).toBe("elix");
  });

  it("a kick is recorded, using the CLASSIFIED reason and not the raw text", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 9 });
    cleanups.push(() => rec.detachAll());
    rec.attach();
    bus.emit("bot:kicked", { kind: "whitelist", text: "arbitrary server text" });
    const row = store.raw().prepare("SELECT text FROM episodes").get() as { text: string };
    expect(row.text).toContain("whitelist");
    expect(row.text).not.toContain("arbitrary server text");
  });

  it("SPAM: the same text within 30 s is stored once", () => {
    const store = tempStore();
    let now = 1_000;
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => now });
    expect(rec.record("Ali", "haha", { kind: "ambient" })).not.toBeNull();
    now += DUPLICATE_WINDOW_MS - 1;
    expect(rec.record("Ali", "haha", { kind: "ambient" })).toBeNull();
    now += 2;
    // Past the window: stored again.
    expect(rec.record("Ali", "haha", { kind: "ambient" })).not.toBeNull();
    expect(
      (store.raw().prepare("SELECT count(*) AS c FROM episodes").get() as { c: number }).c,
    ).toBe(2);
  });

  it("SPAM: ambient lines are capped per player per minute", () => {
    const store = tempStore();
    let now = 1_000;
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => now });
    let stored = 0;
    for (let i = 0; i < AMBIENT_PER_PLAYER_PER_MIN + 8; i++) {
      if (rec.record("Ali", `line ${i}`, { kind: "ambient" }) !== null) stored++;
    }
    expect(stored).toBe(AMBIENT_PER_PLAYER_PER_MIN);
    now += 61_000;
    if (rec.record("Ali", "later line", { kind: "ambient" }) !== null) stored++;
    expect(stored).toBe(AMBIENT_PER_PLAYER_PER_MIN + 1);
  });

  it("SPAM: a dropped duplicate still counts the player as present", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 42 });
    rec.record("Ali", "haha", { kind: "ambient" });
    store.raw().prepare("UPDATE people SET last_seen = 0 WHERE lower(player) = 'ali'").run();
    expect(rec.record("Ali", "haha", { kind: "ambient" })).toBeNull();
    expect(store.person("Ali")?.lastSeen).toBe(42);
  });

  it("unregistering stops recording", () => {
    const store = tempStore();
    const rec = new WorldRecorder({ store, log: noLog as never, selfName: "Elix", now: () => 1 });
    const off = rec.attach();
    off();
    bus.emit("bot:playerJoined", { username: "Ali" });
    expect(store.person("Ali")).toBeNull();
  });
});

// ===========================================================================
// A7 — promises were stored from unredacted text
// ===========================================================================

describe("A7 — promises are stored redacted", () => {
  it("a promise containing personal info is stored without it", () => {
    const store = tempStore();
    const e = engine(store);
    // A player's address arrives in chat; Elix makes a promise mentioning it.
    const r = e.record({
      text: "i'll bring your keys to 12 Oak Street tomorrow",
      speaker: "elix",
      player: "Ali",
    });
    expect(r.promiseId).toBeDefined();
    const row = store.raw().prepare("SELECT text FROM promises").get() as { text: string };
    // The bug: promises.record() took `input.text`, the one string in engine.ts
    // that never passed through redactPersonalInfo.
    expect(row.text).not.toContain("Oak Street");
    expect(row.text).toContain("[address]");
    expect(row.text).toContain("bring your keys");
  });

  it("the episode and the promise redact identically", () => {
    const store = tempStore();
    const e = engine(store);
    const text = "i promise to email you at kid@example.com every day";
    e.record({ text, speaker: "elix", player: "Ali" });
    const ep = store.raw().prepare("SELECT text FROM episodes").get() as { text: string };
    const pr = store.raw().prepare("SELECT text FROM promises").get() as { text: string };
    expect(pr.text).not.toContain("kid@example.com");
    // No value survives in one and not the other.
    expect(pr.text.includes("kid@example.com")).toBe(ep.text.includes("kid@example.com"));
  });

  it("a player line with personal info still redacts both", () => {
    const store = tempStore();
    const e = engine(store);
    e.record({ text: "call me on 555-123-4567", speaker: "player", player: "Ali" });
    const row = store.raw().prepare("SELECT text FROM episodes").get() as { text: string };
    expect(row.text).not.toMatch(/\d{3}-\d{3}-\d{4}/);
    expect(checkInputSafety(row.text).safe).toBe(true);
  });
});

// ===========================================================================
// Wiring: the memory database lives under the project root
// ===========================================================================

describe("wiring", () => {
  it("the memory database path is still data/elix.db under the root", () => {
    expect(defaultMemoryPath("/tmp/elix")).toBe(join("/tmp/elix", "data", "elix.db"));
  });

  it("backups are written under data/backups", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "data", "backups"), { recursive: true });
    expect(existsSync(join(dir, "data", "backups"))).toBe(true);
  });
});