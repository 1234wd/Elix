/**
 * B10 — the brain router, with zero network access.
 *
 * One test per required case. Every fetch is fake, so the whole file is
 * deterministic and offline.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { HuggingFaceProvider, hfEmbeddingsUrl, hfRouterRoot, HF_CHAT_URL } from "../../src/brain/hf.js";
import { CACHE_WINDOW_MS } from "../../src/brain/budget.js";
import {
  fakeFetch,
  groqHfRoutes,
  okCompletion,
  okCompletionWithBudget,
  okModels,
  errorReply,
  fakeClock,
  type FakeFetch,
  type FakeReply,
  type Route,
} from "../helpers/fake-fetch.js";
import type { ModelsConfig } from "../../src/core/config.js";

const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_SMART = "moonshotai/kimi-k2-instruct";
const HF_MODEL = "meta-llama/Llama-3.3-70B-Instruct";

function modelsConfig(overrides: Partial<ModelsConfig> = {}): ModelsConfig {
  return {
    providers: {
      groq: { baseUrl: null, env: "GROQ_API_KEY" },
      hf: { baseUrl: null, env: "HF_TOKEN" },
    },
    roles: {
      fast: {
        preference: [
          { provider: "groq", model: GROQ_MODEL },
          { provider: "hf", model: HF_MODEL },
          { provider: "builtin", model: "scripted" },
        ],
      },
      smart: {
        preference: [
          { provider: "groq", model: GROQ_SMART },
          { provider: "builtin", model: "scripted" },
        ],
      },
    },
    ...overrides,
  } as ModelsConfig;
}

/** A silent logger, so router warnings never pollute test output. */
const noLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface Harness {
  router: BrainRouter;
  store: BrainStore;
  fetch: FakeFetch;
  clock: ReturnType<typeof fakeClock>;
  close(): void;
}

const openHarnesses: Array<() => void> = [];
afterEach(() => {
  while (openHarnesses.length > 0) openHarnesses.pop()!();
});

function harness(opts: {
  routes?: Route[];
  withGroq?: boolean;
  withHf?: boolean;
  idleBudget?: number;
  cacheEnabled?: boolean;
  models?: ModelsConfig;
  warnings?: string[];
  storePath?: string;
} = {}): Harness {
  const clock = fakeClock();
  const routes = opts.routes ?? groqHfRoutes(okCompletion("groq answer"), okCompletion("hf answer"));
  const f = fakeFetch(routes);
  const providers: Record<string, GroqProvider | HuggingFaceProvider> = {};
  if (opts.withGroq !== false) {
    providers.groq = new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn });
  }
  if (opts.withHf !== false) {
    providers.hf = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
  }

  let dir: string | null = null;
  let dbPath = opts.storePath;
  if (!dbPath) {
    dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    dbPath = join(dir, "elix.db");
  }
  const store = new BrainStore(dbPath);

  const router = new BrainRouter({
    models: opts.models ?? modelsConfig(),
    providers,
    store,
    now: clock.now,
    fastMaxTokens: 1500,
    smartMaxTokens: 4000,
    idleChatterBudgetPerHour: opts.idleBudget ?? 60,
    log: opts.warnings
      ? {
          ...noLog,
          // Capture both the payload and the message, so a test can assert on
          // either (pino's signature is (obj, msg)).
          warn: (o: unknown, msg?: string) =>
            opts.warnings!.push(`${msg ?? ""} ${JSON.stringify(o)}`),
        }
      : noLog,
    ...(opts.cacheEnabled !== undefined ? { cacheEnabled: opts.cacheEnabled } : {}),
  });

  const h: Harness = {
    router,
    store,
    fetch: f,
    clock,
    close() {
      store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  openHarnesses.push(h.close);
  return h;
}

const ask = (h: Harness, text: string, role: "fast" | "smart" = "fast") =>
  h.router.complete({
    messages: [{ role: "user", content: text }],
    role,
    bypassIdleBudget: true,
  });

// ---------------------------------------------------------------------------

describe("B2 — model discovery and role resolution", () => {
  it("resolves every role to the first available entry in models.yaml and logs role -> model", async () => {
    const h = harness();
    const resolved = await h.router.resolveRoles();
    expect(resolved.map((r) => `${r.role} → ${r.chosen?.provider}/${r.chosen?.model}`)).toEqual([
      `fast → groq/${GROQ_MODEL}`,
      `smart → groq/${GROQ_SMART}`,
    ]);
  });

  it("calls each provider's /models once and caches it for 6 hours", async () => {
    const h = harness();
    await h.router.resolveRoles();
    expect(h.fetch.callsTo("/models").map((c) => new URL(c.url).host).sort()).toEqual([
      "api.groq.com",
      "router.huggingface.co",
    ]);

    // A second resolve, and a call in between, must not re-fetch.
    await ask(h, "hello there");
    await h.router.resolveRoles();
    expect(h.fetch.callsTo("/models")).toHaveLength(2);
  });

  it("skips a configured model the provider does not offer", async () => {
    const h = harness({
      routes: [
        { match: "api.groq.com/openai/v1/models", reply: okModels(["some/other-model"]) },
        { match: "router.huggingface.co/v1/models", reply: okModels([HF_MODEL]) },
        { match: "router.huggingface.co/v1/chat/completions", reply: okCompletion("from hf") },
      ],
    });
    const r = await h.router.resolveRole("fast", modelsConfig().roles.fast.preference);
    expect(r.chosen).toEqual({ provider: "hf", model: HF_MODEL });
    expect(r.skipped).toContainEqual({
      candidate: { provider: "groq", model: GROQ_MODEL },
      reason: "not-in-model-list",
    });
  });

  it("marks a role as no-key when that provider has no key", async () => {
    const h = harness({ withGroq: false });
    const r = await h.router.resolveRole("fast", modelsConfig().roles.fast.preference);
    expect(r.skipped).toContainEqual({
      candidate: { provider: "groq", model: GROQ_MODEL },
      reason: "no-key",
    });
    expect(r.chosen).toEqual({ provider: "hf", model: HF_MODEL });
  });

  it("falls back to configured ids when /models is unreachable, instead of failing the role", async () => {
    const h = harness({
      routes: [
        { match: "/models", reply: { throws: new Error("network down") } },
        { match: "api.groq.com/openai/v1/chat/completions", reply: okCompletion("still works") },
      ],
    });
    const r = await h.router.resolveRole("fast", modelsConfig().roles.fast.preference);
    expect(r.chosen).toEqual({ provider: "groq", model: GROQ_MODEL });
  });
});

describe("B3 — failover order", () => {
  it("goes groq → hf → builtin when both providers fail", async () => {
    const h = harness({
      routes: groqHfRoutes(errorReply(500, "groq exploded"), errorReply(503, "hf exploded")),
    });
    const res = await ask(h, "hello there");
    expect(res.fromFallback).toBe(true);
    expect(res.provider).toBe("builtin");
    expect(h.fetch.callsTo("api.groq.com/openai/v1/chat/completions")).toHaveLength(1);
    expect(h.fetch.callsTo("router.huggingface.co/v1/chat/completions")).toHaveLength(1);
  });

  it("stops at the first provider that answers", async () => {
    const h = harness();
    const res = await ask(h, "hello there");
    expect(res.text).toBe("groq answer");
    expect(res.provider).toBe("groq");
    expect(h.fetch.callsTo("router.huggingface.co/v1/chat")).toHaveLength(0);
  });

  it("falls straight to builtin when no provider has a key", async () => {
    const h = harness({ withGroq: false, withHf: false });
    const res = await ask(h, "hello there");
    expect(res.fromFallback).toBe(true);
    expect(res.model).toBe("scripted");
    expect(h.fetch.calls).toHaveLength(0);
  });
});

describe("B3 — proactive skip on low remaining tokens", () => {
  it("skips a model whose remaining tokens are below the estimated prompt size", async () => {
    const h = harness({
      routes: groqHfRoutes(
        [okCompletionWithBudget("first", 5), okCompletionWithBudget("second", 5)],
        okCompletion("hf answers"),
      ),
    });
    // First call reports only 5 remaining tokens.
    await ask(h, "short question");
    const afterFirst = h.fetch.callsTo("api.groq.com/openai/v1/chat/completions").length;

    // Second prompt is long, so 5 remaining tokens cannot cover it.
    const res = await ask(h, "x".repeat(400));
    expect(res.provider).toBe("hf");
    expect(h.fetch.callsTo("api.groq.com/openai/v1/chat/completions")).toHaveLength(afterFirst);
  });

  it("does not skip while the remaining tokens still cover the prompt", async () => {
    const h = harness({
      routes: groqHfRoutes(
        [okCompletionWithBudget("first", 900), okCompletion("second, still groq")],
        okCompletion("hf answers"),
      ),
    });
    await ask(h, "short question");
    const res = await ask(h, "x".repeat(400));
    expect(res.provider).toBe("groq");
    expect(res.text).toBe("second, still groq");
  });
});

describe("B3 — 429 cooldown, then return to Groq", () => {
  it("cools a rate-limited model until its reset, fails over, and comes back afterwards", async () => {
    const h = harness({
      routes: groqHfRoutes(
        [
          errorReply(429, "Rate limit reached", { "retry-after": "2", "x-ratelimit-reset-tokens": "2s" }),
          okCompletion("groq is back"),
        ],
        okCompletion("hf answers while groq cools"),
      ),
    });

    const first = await ask(h, "hello there");
    expect(first.provider).toBe("hf");

    const cooldowns = h.store.activeCooldowns(h.clock.now());
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]).toMatchObject({ provider: "groq", model: GROQ_MODEL });

    // Still cooling: groq is not called again.
    const before = h.fetch.callsTo("api.groq.com/openai/v1/chat/completions").length;
    const second = await ask(h, "another question");
    expect(second.provider).toBe("hf");
    expect(h.fetch.callsTo("api.groq.com/openai/v1/chat/completions")).toHaveLength(before);

    // Cooldown expires: the next call tries Groq first again.
    h.clock.advance(3_000);
    const third = await ask(h, "after the cooldown");
    expect(third.provider).toBe("groq");
    expect(third.text).toBe("groq is back");
  });
});

describe("B3 — daily limit vs per-minute limit", () => {
  it("cools a per-minute 429 for seconds, not for a day", async () => {
    const h = harness({
      routes: groqHfRoutes(
        errorReply(429, "Rate limit reached for model", { "retry-after": "8" }),
        okCompletion("hf"),
      ),
    });
    await ask(h, "hi");
    const rows = h.store.activeCooldowns(h.clock.now());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disabledForDay).toBe(false);
    expect(rows[0]!.until - h.clock.now()).toBeLessThanOrEqual(8_000);
    expect(h.router.disabledProviders()).toHaveLength(0);
  });

  it("disables only the offending model when the body names a daily quota (A7)", async () => {
    const h = harness({
      routes: groqHfRoutes(
        errorReply(429, "Rate limit reached: 1000 requests per day exceeded"),
        okCompletion("hf answers"),
      ),
    });
    const res = await ask(h, "hi");
    expect(res.provider).toBe("hf");
    // A7: Groq's limits are per model, so the whole provider is NOT disabled.
    expect(h.router.disabledProviders()).toEqual([]);
    const off = h.router.disabledModels();
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ provider: "groq", model: GROQ_MODEL });
    expect(off[0]!.reason).toMatch(/daily limit/);
    // A daily allowance resets at the next UTC midnight, not in 24 h.
    const midnight = new Date(h.clock.now());
    midnight.setUTCHours(24, 0, 0, 0);
    expect(off[0]!.until).toBe(midnight.getTime());
  });
});

describe("B3 — 401/402/403 disable the provider for the day", () => {
  // 401/403 are auth failures; 402 is a payment/credit problem. All three are
  // provider-wide, because the ACCOUNT is the problem, not the model (A7).
  for (const [status, reason] of [
    [401, "auth 401"],
    [402, "payment required 402"],
    [403, "auth 403"],
  ] as const) {
    it(`disables groq for the day on a ${status} and skips it without a request`, async () => {
      const h = harness({
        routes: groqHfRoutes(errorReply(status, `status ${status}`), okCompletion("hf answers")),
      });
      const res = await ask(h, "hi");
      expect(res.provider).toBe("hf");
      expect(h.router.disabledProviders()).toEqual([
        expect.objectContaining({ provider: "groq", reason }),
      ]);

      const before = h.fetch.callsTo("api.groq.com").length;
      await ask(h, "second question");
      expect(h.fetch.callsTo("api.groq.com")).toHaveLength(before);
    });
  }

  it("disables hf for the day on a credits/quota error and logs a warning", async () => {
    const warnings: string[] = [];
    const h = harness({
      withGroq: false,
      warnings,
      routes: groqHfRoutes(
        okCompletion("unused"),
        errorReply(402, "Insufficient credits to run this model"),
      ),
    });
    const res = await ask(h, "hi");
    expect(res.fromFallback).toBe(true);
    expect(h.router.disabledProviders()).toEqual([
      expect.objectContaining({ provider: "hf", reason: "out of credit/quota" }),
    ]);
    expect(warnings.join("\n")).toMatch(/disabled for the day/);
  });
});

describe("B3 — circuit breaker", () => {
  it("opens after three consecutive failures and half-closes after 60s", async () => {
    const h = harness({
      routes: groqHfRoutes(
        [
          errorReply(500, "boom"),
          errorReply(500, "boom"),
          errorReply(500, "boom"),
          okCompletion("groq recovered"),
        ],
        okCompletion("hf"),
      ),
    });
    for (let i = 0; i < 3; i++) {
      await ask(h, `question number ${i}`);
    }

    // Fourth call: the breaker is open, so groq is skipped without a request.
    const before = h.fetch.callsTo("api.groq.com/openai/v1/chat/completions").length;
    const fourth = await ask(h, "question four");
    expect(fourth.provider).toBe("hf");
    expect(h.fetch.callsTo("api.groq.com/openai/v1/chat/completions")).toHaveLength(before);

    // After 60s the breaker half-closes and groq is tried again.
    h.clock.advance(60_001);
    const fifth = await ask(h, "question five");
    expect(fifth.provider).toBe("groq");
    expect(fifth.text).toBe("groq recovered");
  });
});

describe("B7 — timeout and abort", () => {
  it("treats a provider timeout as a failure and fails over to the next provider", async () => {
    const h = harness({
      routes: groqHfRoutes(
        { throws: Object.assign(new Error("timed out"), { name: "TimeoutError" }) },
        okCompletion("hf answers"),
      ),
    });
    const res = await ask(h, "hi");
    expect(res.provider).toBe("hf");
    const outcomes = h.store.usageSince(0).map((r) => `${r.provider}/${r.outcome}`);
    expect(outcomes).toContain("groq/timeout");
  });

  it("makes no network request at all when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const res = await h.router.complete({
      messages: [{ role: "user", content: "hi" }],
      role: "fast",
      signal: controller.signal,
      bypassIdleBudget: true,
    });
    expect(res.fromFallback).toBe(true);
    expect(res.fallbackReason).toBe("aborted before dispatch");
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("does not wait on the network when the signal aborts mid-call", async () => {
    const h = harness({
      routes: groqHfRoutes({ hang: true }, okCompletion("hf answers")),
    });
    const controller = new AbortController();
    const promise = h.router.complete({
      messages: [{ role: "user", content: "hi" }],
      role: "fast",
      signal: controller.signal,
      bypassIdleBudget: true,
    });
    setTimeout(() => controller.abort(), 5);
    const res = await promise;
    // Shutdown wins: a scripted line, and no claim that a provider answered.
    expect(res.fromFallback).toBe(true);
    expect(res.provider).toBe("builtin");
  });
});

describe("B4 — reasoning models", () => {
  it("sends include_reasoning:false for gpt-oss, never reasoning_format (A4)", async () => {
    const h = harness();
    await ask(h, "what is two plus two");
    const call = h.fetch.callsTo("api.groq.com/openai/v1/chat/completions")[0]!;
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("low");
    // Groq's docs: reasoning_format is NOT supported for gpt-oss.
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_format).toBeUndefined();
    // Reasoning tokens count against max_completion_tokens, not max_tokens.
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(512);
  });

  it("never returns reasoning text to the caller, only the final answer", async () => {
    const h = harness({
      routes: groqHfRoutes(
        {
          status: 200,
          body: JSON.stringify({
            choices: [
              {
                message: {
                  reasoning:
                    "Step 1: the user greeted me. Step 2: reply in lowercase. Step 3: say hi.",
                  content: "hey, how's it going",
                },
              },
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 60,
              completion_tokens_details: { reasoning_tokens: 51 },
            },
          }),
        },
        okCompletion("unused"),
      ),
    });
    const res = await ask(h, "hi elix");
    expect(res.text).toBe("hey, how's it going");
    expect(res.text).not.toMatch(/step 1/i);
    // Reasoning tokens are still counted, because they burn quota.
    expect(res.reasoningTokens).toBe(51);
  });

  it("strips inline <think> blocks even when the provider ignores the parameter", async () => {
    const h = harness({
      routes: groqHfRoutes(okCompletion("<think>internal chain of thought</think>here's the real answer"), okCompletion("x")),
    });
    const res = await ask(h, "hi");
    expect(res.text).toBe("here's the real answer");
    expect(res.text).not.toMatch(/internal chain/i);
  });

  it("strips an unclosed <think> left by a truncated stream", async () => {
    const h = harness({
      routes: groqHfRoutes(okCompletion("all good so far <think>and then the stream died"), okCompletion("x")),
    });
    const res = await ask(h, "hi");
    expect(res.text).toBe("all good so far");
  });
});

describe("B6 — cache", () => {
  it("returns the cached answer for an identical normalized prompt within 10 minutes", async () => {
    const h = harness();
    const first = await ask(h, "What is a redstone lamp?");
    expect(first.text).toBe("groq answer");
    const callsAfterFirst = h.fetch.callsTo("chat/completions").length;

    // Different casing and whitespace must still hit the cache.
    const second = await ask(h, "  what is a   redstone lamp? ");
    expect(second.text).toBe("groq answer");
    expect(h.fetch.callsTo("chat/completions")).toHaveLength(callsAfterFirst);
  });

  it("misses the cache after the 10 minute window", async () => {
    const h = harness({
      routes: groqHfRoutes([okCompletion("first"), okCompletion("second")], okCompletion("hf")),
    });
    expect((await ask(h, "same question")).text).toBe("first");
    h.clock.advance(CACHE_WINDOW_MS + 1);
    expect((await ask(h, "same question")).text).toBe("second");
  });
});

describe("B6 — idle chatter budget", () => {
  it("stops calling models once idleChatterBudgetPerHour is used up", async () => {
    const h = harness({ idleBudget: 2, routes: groqHfRoutes([okCompletion("a"), okCompletion("b")], okCompletion("hf")) });
    const chatter = (n: number) =>
      h.router.complete({ messages: [{ role: "user", content: `idle chatter ${n}` }], role: "fast" });

    expect((await chatter(1)).fromFallback).toBe(false);
    expect((await chatter(2)).fromFallback).toBe(false);
    const third = await chatter(3);
    expect(third.fromFallback).toBe(true);
    expect(third.fallbackReason).toBe("idle budget exhausted");
    expect(h.fetch.callsTo("chat/completions")).toHaveLength(2);

    // An hour later the budget refills.
    h.clock.advance(3_600_001);
    expect((await chatter(4)).fromFallback).toBe(false);
  });

  it("lets a priority call bypass the idle budget", async () => {
    const h = harness({ idleBudget: 0 });
    const res = await h.router.complete({
      messages: [{ role: "user", content: "important question" }],
      role: "fast",
      bypassIdleBudget: true,
    });
    expect(res.fromFallback).toBe(false);
    expect(res.text).toBe("groq answer");
  });
});

describe("B8 — usage rows", () => {
  it("writes a row per attempt with provider, model, role, tokens, latency and outcome", async () => {
    const h = harness();
    await ask(h, "hi");
    const rows = h.store.usageSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "groq",
      model: GROQ_MODEL,
      role: "fast",
      tokensIn: 42,
      tokensOut: 7,
      reasoningTokens: 0,
      outcome: "ok",
    });
    expect(typeof rows[0]!.latencyMs).toBe("number");
    expect(rows[0]!.ts).toBeGreaterThan(0);
  });

  it("records a 429 row per provider and a fallback row when everything is exhausted", async () => {
    const h = harness({
      routes: groqHfRoutes(
        errorReply(429, "Rate limit reached", { "retry-after": "30" }),
        errorReply(429, "quota exceeded per day"),
      ),
    });
    await ask(h, "hi");
    const outcomes = h.store.usageSince(0).map((r) => `${r.provider}/${r.outcome}`);
    expect(outcomes).toEqual(["groq/429", "hf/429", "builtin/fallback"]);
  });

  it("records the smart role separately from the fast role", async () => {
    const h = harness();
    await ask(h, "quick thing", "fast");
    await ask(h, "a much deeper question", "smart");
    expect(h.store.usageSince(0).map((r) => r.role)).toEqual(["fast", "smart"]);
    expect(h.store.usageSince(0).map((r) => r.model)).toEqual([GROQ_MODEL, GROQ_SMART]);
  });
});

describe("B3 — cooldowns survive a restart", () => {
  it("still skips a rate-limited model after the process restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const dbPath = join(dir, "elix.db");
    const clock = fakeClock();
    const opened: BrainStore[] = [];

    const buildRouter = (f: FakeFetch) => {
      const store = new BrainStore(dbPath);
      opened.push(store);
      return new BrainRouter({
        models: modelsConfig(),
        providers: {
          groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }),
          hf: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
        },
        store,
        now: clock.now,
        log: noLog,
      });
    };

    // Process 1: groq gets a 429 with a 60 s reset.
    const f1 = fakeFetch(
      groqHfRoutes(errorReply(429, "Rate limit reached", { "retry-after": "60" }), okCompletion("hf")),
    );
    const r1 = buildRouter(f1);
    expect(
      (
        await r1.complete({
          messages: [{ role: "user", content: "hi" }],
          role: "fast",
          bypassIdleBudget: true,
        })
      ).provider,
    ).toBe("hf");

    clock.advance(5_000);

    // Process 2: a brand new router on the same database must not re-hit groq.
    const f2 = fakeFetch(groqHfRoutes(okCompletion("groq should not be called"), okCompletion("hf answers")));
    const r2 = buildRouter(f2);
    const res = await r2.complete({
      messages: [{ role: "user", content: "another question" }],
      role: "fast",
      bypassIdleBudget: true,
    });
    expect(res.provider).toBe("hf");
    expect(f2.callsTo("api.groq.com/v1/chat")).toHaveLength(0);

    // And the same-day disable survives too.
    const verifier = new BrainStore(dbPath);
    opened.push(verifier);
    const persisted = verifier.activeCooldowns(clock.now());
    expect(persisted.map((r) => `${r.provider}/${r.model}`)).toContain(`groq/${GROQ_MODEL}`);
    // Booleans come back as booleans, not SQLite's 0/1.
    expect(typeof persisted[0]!.disabledForDay).toBe("boolean");

    for (const s of opened) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("B5 — Hugging Face URL construction (A3)", () => {
  it("encodes each path segment separately so the owner prefix keeps a real slash", () => {
    // The bug: encodeURIComponent("BAAI/bge-small-en-v1.5") gives
    // "BAAI%2Fbge-small-en-v1.5" and the router 404s on that.
    expect(hfEmbeddingsUrl("BAAI/bge-small-en-v1.5")).toBe(
      "https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction",
    );
  });

  it("never emits an encoded slash inside a model id", () => {
    const url = hfEmbeddingsUrl("BAAI/bge-small-en-v1.5");
    expect(url).not.toContain("%2F");
    expect(url).not.toContain("%2f");
  });

  it("still encodes characters that genuinely need it", () => {
    expect(hfEmbeddingsUrl("owner/model with space")).toContain("model%20with%20space");
  });

  it("normalises a base URL written with a trailing /v1", () => {
    // config/models.yaml ships "https://router.huggingface.co/v1"; appending
    // to that produced /v1/v1/chat/completions and /v1/hf-inference/...
    expect(hfRouterRoot("https://router.huggingface.co/v1")).toBe("https://router.huggingface.co");
    expect(hfRouterRoot("https://router.huggingface.co/")).toBe("https://router.huggingface.co");
    expect(hfRouterRoot("https://router.huggingface.co")).toBe("https://router.huggingface.co");
  });

  it("builds the chat URL from the router root, not the /v1 prefix", () => {
    expect(HF_CHAT_URL).toBe("https://router.huggingface.co/v1/chat/completions");
  });

  it("posts embeddings to the feature-extraction route with no /v1", async () => {
    const f = fakeFetch([
      { match: "feature-extraction", reply: { status: 200, body: "[[0.1,0.2,0.3]]" } },
    ]);
    const p = new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn });
    const vectors = await p.embed(["hello"], "BAAI/bge-small-en-v1.5");
    expect(f.calls[0]!.url).toBe(
      "https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction",
    );
    expect(vectors[0]).toHaveLength(3);
  });

  it("honours a base URL configured with /v1 without doubling the prefix", async () => {
    const f = fakeFetch([{ match: "/v1/chat/completions", reply: okCompletion("ok from hf") }]);
    const p = new HuggingFaceProvider({
      apiKey: "hf-test",
      baseUrl: "https://router.huggingface.co/v1",
      fetchImpl: f.fn,
    });
    await p.complete({ messages: [{ role: "user", content: "hi" }], role: "fast" }, HF_MODEL);
    expect(f.calls[0]!.url).toBe("https://router.huggingface.co/v1/chat/completions");
  });
});

describe("B1 — store", () => {
  it("opens a database in WAL mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const second = new BrainStore(join(dir, "elix.db"));
    const mode = (
      second as unknown as { db: { prepare: (s: string) => { get(): unknown } } }
    ).db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    store.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the sqlite-vec extension and reports its version", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const res = store.loadVecExtension();
    expect(res.loaded).toBe(true);
    expect(res.version).toMatch(/^v0\./);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prunes expired cooldowns but keeps same-day disables", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const now = Date.now();
    store.setCooldown({ provider: "groq", model: "a", until: now - 1000, reason: "old", disabledForDay: false });
    store.setCooldown({ provider: "groq", model: "b", until: now + 60_000, reason: "live", disabledForDay: false });
    store.setCooldown({ provider: "hf", model: "c", until: now + 60_000, reason: "auth", disabledForDay: true });
    expect(store.pruneCooldowns(now)).toBe(1);
    expect(store.activeCooldowns(now).map((r) => r.model).sort()).toEqual(["b", "c"]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the model cache with a 6 h expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const now = Date.now();
    store.cacheModels("groq", ["a", "b"], now);
    expect(store.getCachedModels("groq", 6 * 60 * 60 * 1000, now)).toEqual(["a", "b"]);
    expect(store.getCachedModels("groq", 6 * 60 * 60 * 1000, now + 6 * 60 * 60 * 1000 + 1)).toBeNull();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps usage rows queryable by timestamp range", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
    const store = new BrainStore(join(dir, "elix.db"));
    store.recordUsage({
      ts: 1000, provider: "groq", model: "a", role: "fast",
      tokensIn: 1, tokensOut: 2, reasoningTokens: 3, latencyMs: 4, outcome: "ok",
    });
    store.recordUsage({
      ts: 2000, provider: "hf", model: "b", role: "smart",
      tokensIn: 5, tokensOut: 6, reasoningTokens: 7, latencyMs: 8, outcome: "429", error: "slow down",
    });
    expect(store.usageSince(0)).toHaveLength(2);
    expect(store.usageSince(1500)).toHaveLength(1);
    expect(store.usageSince(1500)[0]).toMatchObject({ provider: "hf", error: "slow down" });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("B1 — a scripted line is always available", () => {
  it("never returns an empty string, even with no keys and no network", async () => {
    const h = harness({ withGroq: false, withHf: false });
    for (let i = 0; i < 5; i++) {
      const res = await ask(h, "anything at all?");
      expect(res.text.trim().length).toBeGreaterThan(0);
    }
  });
});

// Keep the unused-import checker honest about FakeReply, which the route type
// references in helper signatures above.
export type { FakeReply };
