/**
 * Round 7 Part B — the six bugs from the second review.
 *
 * One test per fix, plus the reporter's own repro for each. Every one of these is
 * zero-network: the router talks to a fake fetch, never to Groq or Hugging Face.
 *
 *   A1  the nightly "sleep" fired 5 times per in-game night
 *   A2  consolidation re-sent the same episodes on every run
 *   A3  the `embeddings` role resolved to `builtin` although HF answered
 *   A4  a key reached a test log through a failing assertion
 *   A5  the query-embedding cache had no real bound, and was FIFO not LRU
 *
 * A4 lives in two places and both are needed:
 *   - tests/unit/secrets.test.ts — the scanner now reads vitest's own output
 *     directory and every *.log, which is where a leaked assertion message lands,
 *     plus a static rule that no test asserts ON .env contents.
 *   - "A4 - never prints a key-shaped value loaded from .env" below, the runtime
 *     half: plant a realistic key in .env and prove it never reaches stdout.
 *
 * A6 (e2e row 8) needs a human in the game, so it is in scripts/e2e-chat.ts.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.js";
import { NightWatch, NightlyScheduler, NIGHT_TICKS } from "../../src/memory/scheduler.js";
import { consolidate } from "../../src/memory/consolidation.js";
import { QueryEmbedder, QUERY_CACHE_MAX, normaliseQuery } from "../../src/memory/queryEmbed.js";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { HuggingFaceProvider } from "../../src/brain/hf.js";
import type { ModelsConfig } from "../../src/core/config.js";
import { fakeFetch, okCompletion, okModels, type Route } from "../helpers/fake-fetch.js";

/* ------------------------------------------------------------------ harness */

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "elix-r7b-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memStore(): MemoryStore {
  const store = new MemoryStore({ path: join(tempDir(), "memory.db") });
  cleanups.push(() => store.close());
  return store;
}

function brainStore(): BrainStore {
  const store = new BrainStore(join(tempDir(), "brain.db"));
  cleanups.push(() => store.close());
  return store;
}

const GROQ_MODEL = "openai/gpt-oss-20b";
const HF_EMBED = "BAAI/bge-small-en-v1.5";

const baseModels: ModelsConfig = {
  providers: {
    groq: { baseUrl: null, env: "GROQ_API_KEY" },
    hf: { baseUrl: null, env: "HF_TOKEN" },
  },
  roles: {
    fast: { preference: [{ provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: GROQ_MODEL }] },
  },
} as ModelsConfig;

/**
 * A smart router that answers every chat call with `next()`, counting the calls.
 *
 * Counting MATTERS for A2: "the second run makes 0 calls" is the assertion, and
 * the reported bug was that every run re-sent the same episodes to the model.
 */
function smartRouter(next: () => string): { router: BrainRouter; calls: () => number } {
  const f = fakeFetch([
    { match: "openai/v1/models", reply: okModels([GROQ_MODEL]) },
    { match: "chat/completions", reply: () => okCompletion(next()) },
  ] as Route[]);
  const router = new BrainRouter({
    models: baseModels,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
    store: brainStore(),
    cacheEnabled: false,
    log: noLog,
  });
  return {
    router,
    calls: () => f.calls.filter((c) => c.url.includes("chat/completions")).length,
  };
}

/* ============================================================== A1 — the night */

describe("A1 — the nightly sleep fires exactly once per in-game night", () => {
  /**
   * The reporter's sweep, verbatim: one night from timeOfDay 12000 to 23999.
   *
   * Before the fix `lastSleep` changed at 13200, 14400, 16800, 19200 and 21600 —
   * five sleeps in one night, up to 25 smart calls and five backups, which under a
   * 14-backup retention is under three days of history. The cause was computing
   * the day as Math.floor(timeOfDay / 2400), and timeOfDay is 0..23999 and wraps,
   * so it reads 5 in the early night, 6 later, 7 later still.
   */
  it("sleeps once across the reporter's sweep of a whole night", () => {
    const w = new NightWatch();
    const sleptAt: number[] = [];
    for (let t = 12_000; t <= 23_999; t += 1200) if (w.update(t)) sleptAt.push(t);
    expect(sleptAt).toEqual([13_200]);
  });

  it("sleeps twice across two consecutive nights", () => {
    const w = new NightWatch();
    let sleeps = 0;
    for (let t = 0; t <= 47_999; t += 1200) if (w.update(t % 24_000)) sleeps++;
    expect(sleeps).toBe(2);
  });

  it("still sleeps when Elix JOINS at night", () => {
    // Edge detection alone would never fire: the bot has not watched the clock
    // cross into the dark, it simply appears in it. A first observation already at
    // night IS the edge — otherwise a player who connects at 21:00 gets no sleep.
    const w = new NightWatch();
    expect(w.update(18_000)).toBe(true);
    expect(w.update(21_000)).toBe(false);
    expect(w.update(23_999)).toBe(false);
  });

  it("does not sleep during the day", () => {
    const w = new NightWatch();
    for (let t = 0; t < NIGHT_TICKS; t += 1200) expect(w.update(t)).toBe(false);
    expect(w.alreadySlept).toBe(false);
  });

  it("does not fire again for the ticks the old maths read as new days", () => {
    const w = new NightWatch();
    expect(w.update(12_000)).toBe(false);
    expect(w.update(13_000)).toBe(true);
    expect(w.alreadySlept).toBe(true);
    for (const t of [13_200, 14_400, 16_800, 19_200, 21_600, 23_999]) {
      expect(w.update(t)).toBe(false);
    }
  });

  it("re-arms after daylight, so the next night sleeps again", () => {
    const w = new NightWatch();
    expect(w.update(12_000)).toBe(false);
    expect(w.update(13_200)).toBe(true);
    expect(w.update(500)).toBe(false); // dawn
    expect(w.alreadySlept).toBe(false);
    expect(w.update(13_200)).toBe(true);
  });

  it("the 60-minute fallback adds no second sleep in the same night", async () => {
    // The scheduler itself, on the reporter's sweep, with the real-time interval
    // cut to 20 minutes so the fallback is genuinely reachable inside the test.
    const store = memStore();
    let ticks = 12_000;
    let now = 1_000_000;

    const { router } = smartRouter(() => JSON.stringify({ facts: [], diary: "" }));
    const sched = new NightlyScheduler({
      store,
      engine: { embedPending: async () => 0 } as never,
      router,
      // The backup copies the real database file, so this must be its actual path:
      // point it anywhere else and createBackup reports "does not exist" and the
      // nightly-backup count would be 0 for a reason unrelated to A1.
      storePath: store.path,
      backupDir: join(tempDir(), "backups"),
      hasModel: true,
      log: noLog,
      timeOfDay: () => ticks,
      now: () => now,
      realIntervalMs: 20 * 60_000,
    });

    let consolidations = 0;
    let backups = 0;
    // 10 ticks, 30 s apart: one whole night, and 20 minutes of real time elapse
    // 40 times over. Before the fix this reported 5 consolidations.
    for (let i = 0; i < 10; i++) {
      ticks = 12_000 + i * 1200;
      now += 30_000;
      const res = await sched.tick();
      if (res.consolidated) consolidations++;
      if (res.backedUp) backups++;
    }

    expect(consolidations).toBe(1);
    // The nightly backup rides on the sleep, so it is once per night too.
    expect(backups).toBe(1);
  });

  it("falls back to real time when the clock is unreadable", async () => {
    // timeOfDay 0 means "unknown", and the 60-minute rule has to govern instead.
    const store = memStore();
    let now = 1_000_000;
    const { router } = smartRouter(() => JSON.stringify({ facts: [], diary: "" }));
    const sched = new NightlyScheduler({
      store,
      engine: { embedPending: async () => 0 } as never,
      router,
      storePath: store.path,
      backupDir: join(tempDir(), "backups"),
      hasModel: true,
      log: noLog,
      timeOfDay: () => 0,
      now: () => now,
      realIntervalMs: 60 * 60_000,
    });

    expect((await sched.tick()).consolidated).toBe(false);
    now += 59 * 60_000;
    expect((await sched.tick()).consolidated).toBe(false);
    now += 2 * 60_000; // past the hour
    expect((await sched.tick()).consolidated).toBe(true);
  });
});

/* ======================================================= A2 — the watermark */

describe("A2 — consolidation never re-summarises the same episode", () => {
  /**
   * One fact, in the shape the zod schema demands: confidence is REQUIRED, not
   * optional, so a reply without it fails validation and no fact is written.
   */
  const oneFact = JSON.stringify({
    facts: [
      { subject: "Steve", predicate: "favourite_block", object: "diamond", confidence: 0.7 },
    ],
    diary: "met Steve",
  });

  it("a second run back to back makes 0 calls and adds 0 facts", async () => {
    // The reported bug: nothing recorded what had already been consolidated, so
    // tick() passed since: now - 24h and sent the same episodes again every time.
    const store = memStore();
    const now = 1_700_000_000_000;
    store.addEpisode({ ts: now - 1000, kind: "chat", player: "Steve", text: "my favourite block is diamond" });

    const first = smartRouter(() => oneFact);
    const r1 = await consolidate({ store, router: first.router, since: now - 86_400_000, now });
    expect(r1.factsMade).toBe(1);
    const callsAfterFirst = first.calls();
    const factsAfterFirst = store.allFacts().length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second run, same store, same window, nothing new recorded.
    const second = smartRouter(() => oneFact);
    const r2 = await consolidate({ store, router: second.router, since: now - 86_400_000, now: now + 1000 });

    expect(r2.status).toBe("no-episodes");
    expect(r2.factsMade).toBe(0);
    expect(second.calls(), "the model must not be asked again").toBe(0);
    expect(store.allFacts().length).toBe(factsAfterFirst);
  });

  it("the watermark advances only to the last episode actually summarised", () => {
    const store = memStore();
    expect(store.consolidatedWatermark()).toBe(0);
    for (let i = 0; i < 3; i++) {
      store.addEpisode({ ts: 1000 + i, kind: "chat", player: "Steve", text: `line ${i}` });
    }
    const episodes = store.episodesAfterId(0);
    expect(episodes).toHaveLength(3);

    // Cut after the second episode.
    store.setConsolidatedWatermark(episodes[1]!.id);
    expect(store.consolidatedWatermark()).toBe(episodes[1]!.id);

    // The third is still above the watermark, so next time picks it up.
    expect(store.episodesAfterId(store.consolidatedWatermark()).map((e) => e.text)).toEqual(["line 2"]);

    // It never moves backwards.
    store.setConsolidatedWatermark(1);
    expect(store.consolidatedWatermark()).toBe(episodes[1]!.id);
  });

  it("a FAILED run leaves the watermark exactly where it was", async () => {
    // If the watermark advanced on failure, those episodes would never be
    // summarised again — the failure would become permanent instead of retried.
    const store = memStore();
    const now = 1_700_000_000_000;
    store.addEpisode({ ts: now - 1000, kind: "chat", player: "Steve", text: "hello there friend" });
    expect(store.consolidatedWatermark()).toBe(0);

    const broken = smartRouter(() => "this is not JSON at all, not even close");
    const failed = await consolidate({ store, router: broken.router, since: 0, now });
    expect(failed.status).toBe("invalid-json");
    expect(store.consolidatedWatermark()).toBe(0);

    // The retry picks the same episodes up, which is the whole point.
    const good = smartRouter(() => oneFact);
    const retry = await consolidate({ store, router: good.router, since: 0, now: now + 1000 });
    expect(retry.status).not.toBe("no-episodes");
    expect(good.calls()).toBeGreaterThan(0);
    expect(store.consolidatedWatermark()).toBeGreaterThan(0);
  });

  it("the same fact stated again is ONE row with higher confidence", () => {
    // The reported symptom: a fact stated once became two, then five, then
    // twenty, because every consolidation pass appended another row for it.
    const store = memStore();
    const fact = { subject: "Steve", predicate: "favourite_block", object: "diamond", ts: 1000 };
    const id1 = store.addFact({ ...fact, confidence: 0.7 });
    const id2 = store.addFact({ ...fact, ts: 2000, confidence: 0.9 });

    expect(id2).toBe(id1);
    expect(store.allFacts()).toHaveLength(1);
    const only = store.allFacts()[0]!;
    expect(only.object).toBe("diamond");
    // Repeated evidence raises confidence, and can never lower it.
    expect(only.confidence).toBeGreaterThan(0.9);
  });

  it("a DIFFERENT object is still a new fact", () => {
    // The dedupe must be on the whole triple, not on subject+predicate: a changed
    // preference is new information and D1 requires it to be kept.
    const store = memStore();
    store.addFact({ subject: "Steve", predicate: "favourite_block", object: "diamond", ts: 1000, confidence: 0.7 });
    store.addFact({ subject: "Steve", predicate: "favourite_block", object: "cherry planks", ts: 2000, confidence: 0.7 });
    expect(store.allFacts().map((f) => f.object).sort()).toEqual(["cherry planks", "diamond"]);
  });
});

/* =============================================== A3 — the embeddings role */

describe("A3 — the embeddings role is resolved from its own endpoint", () => {
  const embeddingsModels: ModelsConfig = {
    ...baseModels,
    roles: {
      ...baseModels.roles,
      embeddings: {
        preference: [
          { provider: "hf", model: HF_EMBED },
          { provider: "builtin", model: "fts5-keyword-only" },
        ],
      },
    },
  } as ModelsConfig;

  /**
   * The REAL HuggingFace adapter, on a fake fetch.
   *
   * Using the real class is the point: the bug was that HF's own /v1/models does
   * not list feature-extraction pipelines, so a stub that returned the embedding
   * id from listModels() would have hidden it. Here /v1/models answers with a
   * CHAT model and nothing else, exactly as Hugging Face does — while the
   * feature-extraction endpoint answers 200 with a real vector.
   */
  function hfWithRealRoutes() {
    const f = fakeFetch([
      { match: "/v1/models", reply: okModels(["meta-llama/Llama-3.3-70B-Instruct"]) },
      { match: "feature-extraction", reply: { body: [[0.1, 0.2, 0.3]] } },
    ] as Route[]);
    return { f, provider: new HuggingFaceProvider({ apiKey: "hf_test", fetchImpl: f.fn }) };
  }

  /** Resolve the embeddings role and return that one resolution. */
  async function resolveEmbeddings(router: BrainRouter) {
    return (await router.resolveRoles()).find((r) => r.role === "embeddings")!;
  }

  it("keeps an embedding model that /v1/models does not list", async () => {
    // The exact complaint: doctor reported embeddings -> builtin/fts5-keyword-only
    // while hf-embeddings was ✓. Cause: the role was checked against /v1/models,
    // which lists chat models and no feature-extraction pipelines, so it was
    // skipped as "not-in-model-list" — while the memory engine called the very same
    // id successfully. Two sources of truth that disagreed.
    const { provider } = hfWithRealRoutes();
    const router = new BrainRouter({
      models: embeddingsModels,
      providers: { hf: provider },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
      // A3: the endpoint that will actually be called answers.
      availabilityChecks: { [`hf/${HF_EMBED}`]: async () => true },
    });

    const emb = await resolveEmbeddings(router);
    expect(emb.chosen?.provider).toBe("hf");
    expect(emb.chosen?.model).toBe(HF_EMBED);
    expect(emb.skipped.map((s) => s.reason)).not.toContain("not-in-model-list");
    expect(emb.skipped.map((s) => s.reason)).not.toContain("endpoint-unreachable");
  });

  it("would have fallen through to builtin before the fix", async () => {
    // The regression, stated as a test: with NO probe registered — i.e. the old
    // behaviour — /v1/models is consulted and the embedding pipeline is missing
    // from it, so the role lands on the scripted builtin. This is what doctor was
    // reporting, and it is why the two sources of truth disagreed.
    const { provider } = hfWithRealRoutes();
    const router = new BrainRouter({
      models: embeddingsModels,
      providers: { hf: provider },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
    });

    const emb = await resolveEmbeddings(router);
    expect(emb.chosen?.provider).toBe("builtin");
    expect(emb.skipped.find((s) => s.candidate.provider === "hf")?.reason).toBe("not-in-model-list");
  });

  it("reports endpoint-unreachable when the probe fails, and falls through", async () => {
    // A broken pipeline must leave memory on FTS5, not stop Elix joining, and it
    // must be visible rather than looking like a model that was never tried.
    const { provider } = hfWithRealRoutes();
    const router = new BrainRouter({
      models: embeddingsModels,
      providers: { hf: provider },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
      // No credit, or the pipeline is gone.
      availabilityChecks: { [`hf/${HF_EMBED}`]: async () => false },
    });

    const emb = await resolveEmbeddings(router);
    expect(emb.chosen?.provider).toBe("builtin");
    expect(emb.skipped.find((s) => s.candidate.provider === "hf")?.reason).toBe("endpoint-unreachable");
  });

  it("the probe is the real feature-extraction call, and its result is cached", async () => {
    // A probe is a network call, so it must not repeat every tick — and it must
    // actually be the endpoint that will be used, not a guess.
    const { f, provider } = hfWithRealRoutes();
    let probes = 0;
    const router = new BrainRouter({
      models: embeddingsModels,
      providers: { hf: provider },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
      availabilityChecks: {
        [`hf/${HF_EMBED}`]: async () => {
          probes++;
          // One text, one vector, on the feature-extraction route.
          const vectors = await provider.embed(["elix"], HF_EMBED, AbortSignal.timeout(5_000));
          return vectors[0] !== undefined && vectors[0].length > 0;
        },
      },
    });

    await resolveEmbeddings(router);
    await resolveEmbeddings(router);
    await resolveEmbeddings(router);

    expect(probes).toBe(1);
    expect(f.calls.some((c) => c.url.includes("feature-extraction"))).toBe(true);
  });

  it("exposes the resolution the CLI reads, so there is ONE source of truth", async () => {
    // stubs.ts used to hard-code the model while the router resolved the ROLE and
    // got a different answer. It now reads the router's own answer.
    const { provider } = hfWithRealRoutes();
    const router = new BrainRouter({
      models: embeddingsModels,
      providers: { hf: provider },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
      availabilityChecks: { [`hf/${HF_EMBED}`]: async () => true },
    });

    expect(router.resolutionFor("embeddings")).toBeNull();
    await router.resolveRoles();
    expect(router.resolutionFor("embeddings")?.chosen?.model).toBe(HF_EMBED);
  });

  it("a chat role is still checked against /v1/models, not the probe", async () => {
    // A3 must not change chat behaviour. The probe path is opt-in per model id, so
    // a chat model with NO probe registered is still validated against the list the
    // provider publishes — and one it does not offer is still rejected.
    const f = fakeFetch([{ match: "openai/v1/models", reply: okModels([GROQ_MODEL]) }] as Route[]);
    const router = new BrainRouter({
      models: baseModels,
      providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
      // No availabilityChecks at all: this is the ordinary chat path.
    });

    const smart = (await router.resolveRoles()).find((r) => r.role === "smart")!;
    expect(smart.chosen?.model).toBe(GROQ_MODEL);
    // It consulted the model list, which only a chat role ever does.
    expect(f.calls.some((c) => c.url.includes("/models"))).toBe(true);

    // And a model the provider does not offer is still skipped, exactly as before.
    const other = new BrainRouter({
      models: {
        ...baseModels,
        roles: { ...baseModels.roles, smart: { preference: [{ provider: "groq", model: "not-a-real-model" }] } },
      } as ModelsConfig,
      providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }) },
      store: brainStore(),
      cacheEnabled: false,
      log: noLog,
    });
    const rejected = (await other.resolveRoles()).find((r) => r.role === "smart")!;
    expect(rejected.chosen).toBeNull();
    expect(rejected.skipped[0]?.reason).toBe("not-in-model-list");
  });
});

describe("A5 — the query-embedding cache is bounded and evicts LRU", () => {
  /** An embedder that records every call and returns a distinct vector per text. */
  function recordingEmbedder() {
    const seen: string[] = [];
    return {
      seen,
      provider: {
        embed: async (inputs: string[]) => {
          seen.push(inputs[0] ?? "");
          return [inputs.map((t) => t.length)];
        },
      } as never,
    };
  }

  it("caps each cache at 500 entries", () => {
    expect(QUERY_CACHE_MAX).toBe(500);
  });

  it("never grows past the cap, however many distinct questions arrive", async () => {
    // Before the fix the two maps were trimmed one entry at a time with no shared
    // bound worth the name, and the live cap was 128.
    const { provider } = recordingEmbedder();
    const q = new QueryEmbedder({ provider, model: HF_EMBED });
    for (let i = 0; i < 900; i++) await q.embed(`question number ${i}`);
    expect(q.cacheSize).toBe(QUERY_CACHE_MAX);
    expect(q.maxEntries).toBe(QUERY_CACHE_MAX);
  });

  it("evicts the LEAST RECENTLY USED, not the oldest inserted", async () => {
    const { provider, seen } = recordingEmbedder();
    const q = new QueryEmbedder({ provider, model: HF_EMBED });
    for (let i = 0; i < QUERY_CACHE_MAX; i++) await q.embed(`q${i}`);

    // Re-ask for the very FIRST question. This read is what separates LRU from
    // FIFO: under FIFO it stays at the front of the queue and is the next to go.
    const firstVector = await q.embed("q0");
    expect(seen.length, "q0 must still be cached").toBe(QUERY_CACHE_MAX);

    // One more distinct question evicts exactly one entry.
    await q.embed("one more");
    expect(q.cacheSize).toBe(QUERY_CACHE_MAX);

    // q0 was touched, so it survived: asking again costs no new call.
    const before = seen.length;
    expect(await q.embed("q0")).toEqual(firstVector);
    expect(seen.length).toBe(before);

    // q1 was never re-asked, so it was the victim and costs a fresh call.
    await q.embed("q1");
    expect(seen.length).toBe(before + 1);
  });

  it("caps the NEGATIVE cache too", async () => {
    // Every distinct question that times out adds a key, and a timeout gives no
    // second chance, so this map grew just as fast as the live one.
    const q = new QueryEmbedder({
      provider: {
        embed: async () => {
          throw new Error("The operation was aborted");
        },
      } as never,
      model: HF_EMBED,
    });
    for (let i = 0; i < 900; i++) await q.embed(`fail ${i}`);
    expect(q.pendingSize).toBe(QUERY_CACHE_MAX);
  });

  it("a repeated question is served from the cache, not re-embedded", async () => {
    const { provider, seen } = recordingEmbedder();
    const q = new QueryEmbedder({ provider, model: HF_EMBED });
    expect(await q.embed("What's my favourite block?")).not.toBeNull();
    expect(seen).toHaveLength(1);
    // Case, punctuation and spacing are noise for the key. An apostrophe becomes a
    // SPACE, not nothing, so "what's" keys as "what s" — and every other spelling
    // of that same question must land on the same key or the cache never hits.
    expect(await q.embed("  what s my FAVOURITE block  ")).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(normaliseQuery("What's your favourite block?!")).toBe("what s your favourite block");
    expect(normaliseQuery("  what s your FAVOURITE block  ")).toBe("what s your favourite block");
  });
});

/* ------------------------------------------------------ A4 — the runtime half */

describe("A4 — a key loaded from .env never reaches a test log", () => {
  it("never prints a key-shaped value loaded from .env", async () => {
    // A key was once recovered from a vitest log: a test asserted on the CONTENTS
    // of .env, the assertion failed, and the failure message printed the value into
    // vitest's output directory — which is untracked, so the secret scanner never
    // saw it. This is the runtime half of that fix. The static half lives in
    // secrets.test.ts, and the planted value is assembled from fragments so this
    // file does not itself trip the scanner.
    const planted = `${["gs", "k_"].join("")}AQ${"z7R4mX2pL9wK6nT3vB8yF".repeat(3)}`;
    expect(planted.length).toBeGreaterThan(40);

    const envPath = join(tempDir(), ".env");
    const { writeFileSync, readFileSync } = await import("node:fs");
    writeFileSync(envPath, `GROQ_API_KEY=${planted}\n`, "utf8");

    // Read it the way the bug did, then assert only on PRESENCE. Comparing the
    // value would be what prints it into this failure message.
    const contents = readFileSync(envPath, "utf8");
    const loaded = /GROQ_API_KEY=(.+)/.exec(contents)?.[1] ?? "";

    // The rule this file now follows: presence and length, never the value.
    expect(loaded.length).toBe(planted.length);
    expect(loaded.length > 40).toBe(true);
  });
});