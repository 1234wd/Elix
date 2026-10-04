/**
 * A3 — the router treats leaked reasoning as a FAILED attempt.
 *
 * The detector test proves the string is recognised. This proves the consequence,
 * which is the part that matters: the cascade must move on to the next model
 * rather than returning the leak to the caller.
 *
 * Built on the shared fake-fetch helper, so the responses are the same shape every
 * other router test uses. An earlier hand-rolled HF response had the wrong
 * envelope, so the router fell through to a scripted line and the test looked like
 * a failover bug when it was a fixture bug.
 */
import { describe, expect, it } from "vitest";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { HuggingFaceProvider } from "../../src/brain/hf.js";
import {
  fakeFetch,
  groqHfRoutes,
  okCompletion,
  tempStore,
  type FakeReply,
} from "../helpers/fake-fetch.js";
import type { ModelsConfig } from "../../src/core/config.js";

const noLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
} as unknown as import("../../src/core/logger.js").Logger;

/** The exact string observed arriving in game, and a coherent version of it. */
const DEBRIS = "We have **………..?????..?....????…";
const COHERENT = "We need to answer the user about their favourite block.";

/** The real config shape: providers + roles[].preference, groq first then hf. */
function modelsConfig(): ModelsConfig {
  // These exact model names matter: resolveRole() checks each candidate against
  // the provider's /v1/models listing, and the fake routes only advertise
  // "openai/gpt-oss-20b" and "meta-llama/Llama-3.3-70B-Instruct". Naming anything
  // else makes hf get skipped as unknown-model, which looks exactly like the
  // failover not working.
  const preference = [
    { provider: "groq" as const, model: "openai/gpt-oss-20b" },
    { provider: "hf" as const, model: "meta-llama/Llama-3.3-70B-Instruct" },
    { provider: "builtin" as const, model: "scripted" },
  ];
  return {
    providers: {
      groq: { baseUrl: null, env: "GROQ_API_KEY" },
      hf: { baseUrl: null, env: "HF_TOKEN" },
    },
    roles: { fast: { preference }, smart: { preference } },
  } as unknown as ModelsConfig;
}

function harness(
  groqReply: FakeReply,
  hfReply: FakeReply = okCompletion("a normal answer"),
  cacheEnabled = false,
) {
  const tmp = tempStore();
  const f = fakeFetch(groqHfRoutes(groqReply, hfReply));
  const router = new BrainRouter({
    models: modelsConfig(),
    providers: {
      groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl: f.fn }),
      hf: new HuggingFaceProvider({ apiKey: "hf-test", fetchImpl: f.fn }),
    },
    store: tmp.store,
    now: () => Date.now(),
    log: noLog,
    cacheEnabled,
  });
  return { router, store: tmp.store as BrainStore, close: tmp.close, calls: f.calls };
}

const ask = (router: BrainRouter, content = "what's your favourite block?") =>
  router.complete({
    messages: [{ role: "user", content }],
    role: "fast" as const,
    bypassIdleBudget: true,
    source: "chat-reply",
  });

describe("A3 — leaked reasoning fails the attempt over", () => {
  it("the observed debris is discarded and the next model answers", async () => {
    const h = harness(okCompletion(DEBRIS), okCompletion("cherry planks, obviously"));
    try {
      const res = await ask(h.router);
      // The leak is NOT what comes back.
      expect(res.text).not.toContain("We have");
      expect(res.fromFallback).toBe(false);
      expect(res.provider).toBe("hf");

      // And the discarded attempt is on the record, so this is observable rather
      // than silent.
      const rows = h.store.usageSince(0);
      expect(rows.map((r) => `${r.provider}/${r.outcome}`)).toContain("groq/network");
      expect(rows.find((r) => r.provider === "groq")?.error ?? "").toContain("leaked reasoning");
    } finally {
      h.close();
    }
  });

  it("a COHERENT leak is discarded too — this is the case that got through", async () => {
    const h = harness(okCompletion(COHERENT), okCompletion("cherry planks, obviously"));
    try {
      const res = await ask(h.router);
      expect(res.text).not.toBe(COHERENT);
      expect(res.text).toBe("cherry planks, obviously");
      expect(h.store.usageSince(0).find((r) => r.provider === "groq")?.error ?? "").toContain(
        "leaked reasoning",
      );
    } finally {
      h.close();
    }
  });

  it("a normal reply from the first model is NOT discarded", async () => {
    const h = harness(okCompletion("cherry planks, obviously"));
    try {
      const res = await ask(h.router);
      expect(res.text).toBe("cherry planks, obviously");
      expect(res.provider).toBe("groq");
      // Exactly one attempt: no failover at all.
      const groq = h.store.usageSince(0).filter((r) => r.provider === "groq");
      expect(groq).toHaveLength(1);
      expect(groq[0]?.error ?? "").toBe("");
    } finally {
      h.close();
    }
  });

  it("the leak is never cached, so the next message does not replay it", async () => {
    // Cache ON is the dangerous configuration: a cached leak would be served to
    // every later player who asks the same thing.
    const h = harness(okCompletion(COHERENT), okCompletion("cherry planks, obviously"), true);
    try {
      const first = await ask(h.router);
      expect(first.text).toBe("cherry planks, obviously");

      // The SECOND identical question is a cache hit — and it must be a hit on
      // hf's answer, not on groq's leak. Exactly one groq attempt in total proves
      // the leak was never written to the cache.
      const second = await ask(h.router, "what's your favourite block?");
      expect(second.text).toBe("cherry planks, obviously");
      const groq = h.store.usageSince(0).filter((r) => r.provider === "groq");
      expect(groq).toHaveLength(1);
      expect(groq[0]?.error ?? "").toContain("leaked reasoning");

      // A DIFFERENT question is a cache miss, so groq is asked again and leaks
      // again — and is again discarded.
      const third = await ask(h.router, "what about wool?");
      expect(third.text).not.toContain("We need to");
      const groqAfter = h.store.usageSince(0).filter((r) => r.provider === "groq");
      expect(groqAfter).toHaveLength(2);
      for (const row of groqAfter) expect(row.error ?? "").toContain("leaked reasoning");
    } finally {
      h.close();
    }
  });

  it("when EVERY model leaks, the caller gets a scripted line — not the leak", async () => {
    // The last resort still must not be the analysis.
    const h = harness(okCompletion(COHERENT), okCompletion(COHERENT));
    try {
      const res = await ask(h.router);
      expect(res.text).not.toContain("We need to");
      expect(res.fromFallback).toBe(true);
    } finally {
      h.close();
    }
  });
});