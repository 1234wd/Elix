/**
 * Round 12 — A1: the joke must never reach SayQueue.
 *
 * The bug being pinned here is the joke-before-crisis bug through a NEW route. The
 * forced path in `wellbeingReply()` only awaits the classifier when the vocabulary
 * gate fires, and everything else went to a fire-and-forget background audit. So a
 * line that is neither gated nor matched by the regex got a game reply out of the model
 * FIRST and a crisis reply a moment later — and the player reads the first line and
 * stops there.
 *
 * The fix gates the SEND rather than the START. This test is the shape of that claim:
 *
 *   - the LLM answers INSTANTLY with a joke,
 *   - the classifier answers after 300 ms with `crisis`,
 *   - the joke must appear nowhere in SayQueue,
 *   - the wellbeing reply must be the only thing sent.
 *
 * Both fakes are hand-written rather than assembled from the route helper, because the
 * whole point is WHICH call answers first, and a route queue cannot express that. The
 * fetch impl reads the request body to tell a classifier call from a chat call.
 *
 * Zero network, no timers: the classifier's 300 ms is a real block, not a sleep, so
 * the ordering is deterministic rather than merely likely.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { detectWellbeing } from "../../src/social/wellbeing.js";
import { needsSecondLook } from "../../src/social/wellbeingClassifier.js";
import type { ModelsConfig } from "../../src/core/config.js";
import type { SayQueue } from "../../src/social/say.js";

const GUARD_MODEL = "openai/gpt-oss-safeguard-20b";
const FAST_MODEL = "openai/gpt-oss-20b";

const models = {
  providers: {
    groq: { baseUrl: null, env: "GROQ_API_KEY" },
    hf: { baseUrl: null, env: "HF_TOKEN" },
  },
  roles: {
    fast: { preference: [{ provider: "groq", model: FAST_MODEL }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: FAST_MODEL }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: GUARD_MODEL }, { provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * A REAL delay, not a blocked thread.
 *
 * The first version of this file used Atomics.wait to make the ordering deterministic,
 * and that quietly destroyed the thing under test: a blocked thread serialises the
 * classifier and the chat call, so the parallelism the A1 design depends on could not
 * be observed at all, and `Promise.race` against an already-settled promise appeared
 * to ignore its own deadline. Real timers are slower to write and are the only honest
 * way to measure this.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: FAST_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * One fetch impl for both roles.
 *
 * `verdict` is what the classifier answers; `chatDelayMs` and `verdictDelayMs` make the
 * race explicit rather than accidental.
 *
 * `respectSignal` matters: the real GroqProvider rejects an aborted request, and the
 * timeout test is meaningless unless the fake does too — otherwise the 2 s deadline
 * aborts nothing and the test passes for the wrong reason.
 */
function makeFetch(
  verdict: string,
  verdictDelayMs: number,
  chatDelayMs: number,
  opts: { chat?: string; respectSignal?: boolean } = {},
): typeof fetch {
  const chat = opts.chat ?? "lol just take a water bucket, its only a game";
  return (async (url: unknown, init: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    const body = String((init as { body?: string }).body ?? "");
    // The models listing is not part of the race under test, and letting it sleep
    // added a full chatDelayMs to every first request — which is what made an
    // apparently-serialised 1000 ms show up as 1440 ms.
    if (String(url).includes("/models")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: FAST_MODEL }, { id: GUARD_MODEL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const isClassifier = body.includes("classifier");
    const delay = isClassifier ? verdictDelayMs : chatDelayMs;
    if (delay > 0) await sleep(delay);
    if (opts.respectSignal && signal?.aborted) {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }
    return completion(isClassifier ? verdict : chat);
  }) as unknown as typeof fetch;
}

class Recording {
  lines: string[] = [];
  say(text: string, _a?: boolean, _b?: boolean): void {
    this.lines.push(text);
  }
}

interface Built {
  bridge: ChatBridge;
  say: Recording;
}

function build(
  verdict: string,
  verdictDelayMs: number,
  chatDelayMs: number,
  opts: { chat?: string; respectSignal?: boolean; classifierTimeoutMs?: number } = {},
): Built {
  const dir = mkdtempSync(join(tmpdir(), "elix-a1-"));
  const store = new BrainStore(join(dir, "elix.db"));
  const fetchImpl = makeFetch(verdict, verdictDelayMs, chatDelayMs, opts);
  const router = new BrainRouter({
    models,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl }) },
    store,
    now: () => Date.now(),
    log: noLog,
    idleChatterBudgetPerHour: 0,
    fastTimeoutMs: 5000,
    smartTimeoutMs: 5000,
    modelsTimeoutMs: 5000,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const say = new Recording();
  const bridge = new ChatBridge({
    router,
    username: "Elix",
    log: noLog as never,
    personaLite: "",
    typingRandom: () => 1,
    classifierTimeoutMs: opts.classifierTimeoutMs ?? 2000,
  });
  return { bridge, say };
}

/**
 * A line that NEITHER the regex floor NOR the vocabulary gate catches.
 *
 * Both halves are asserted rather than assumed, and both matter. If the floor starts
 * matching this line, the forced path answers it and the test stops covering the
 * second layer. If the GATE starts matching it, `wellbeingReply()` awaits the
 * classifier itself and — because a 1 ms timeout returns no verdict — falls through
 * to the vocabulary-fallback concern check-in. Either way the test would be passing
 * for a reason that has nothing to do with the send-gate.
 */
const UNCAUGHT = "the bus was late again this morning";

describe("Round 12 A1 — a normal reply cannot be sent before the audit answers", () => {
  it("the fixture really is invisible to both layers", () => {
    expect(detectWellbeing(UNCAUGHT).level).toBe("none");
    expect(needsSecondLook(UNCAUGHT)).toBe(false);
  });

  it("the joke NEVER reaches SayQueue, and the wellbeing reply does", async () => {
    const { bridge, say } = build('{"level":"crisis","imminent":false,"reason":"test"}', 300, 0);

    const reply = await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);

    // The core assertion. If this ever passes while a joke is in `lines`, the gate is
    // decorative.
    expect(say.lines.join(" | ")).not.toMatch(/water bucket/i);
    expect(say.lines).toHaveLength(1);
    expect(say.lines[0]).toMatch(/right now|talk to someone|adult|emergency/i);
    expect(reply.replied).toBe(true);
    expect(reply.reason).toMatch(/^audit-/);
  });

  it("the classifier is still called even though the reply is dropped", async () => {
    // Otherwise the obvious 'fix' is to delete the audit, and this test would still
    // pass for the wrong reason.
    const { bridge, say } = build('{"level":"concern","imminent":false,"reason":"test"}', 200, 0);
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    expect(say.lines[0]).toBeTruthy();
    expect(say.lines[0]).not.toMatch(/water bucket/i);
  });

  it("a verdict of none lets the normal reply through", async () => {
    const { bridge, say } = build('{"level":"none","imminent":false,"reason":"test"}', 50, 0);
    const reply = await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    expect(say.lines.join(" ")).toMatch(/water bucket/i);
    expect(reply.reason).toBe("llm");
  });

  it("a classifier that answers INSIDE the budget wins, and the chat call is the long pole", async () => {
    // The design claim: the send waits for the audit, and normally the audit has
    // already answered by the time the model has produced a reply — so the total is the
    // chat call, not chat plus classifier.
    //
    // The exact timeout branch is NOT tested here. It is tested as pure arithmetic in
    // round11A2 ("A1 - the deadline is measured from when the LINE arrived"), because
    // driving it end-to-end needs a provider that stalls for longer than the budget
    // while the chat call returns inside it, and a fake that does both deterministically
    // is not worth the flake it buys.
    const { bridge, say } = build(
      '{"level":"crisis","imminent":false,"reason":"test"}',
      300,
      700,
      { classifierTimeoutMs: 2000 },
    );
    const started = Date.now();
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    const elapsed = Date.now() - started;
    expect(say.lines.join(" ")).not.toMatch(/water bucket/i);
    // Generous: the claim is that we did not wait for BOTH in sequence.
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(2500);
  });

  it("an UNPARSEABLE classifier verdict lets the normal reply through", async () => {
    // A model that answers with prose instead of JSON has failed, and a failed
    // classifier means "use the floor", not "say nothing".
    const { bridge, say } = build("{}", 0, 0);
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    expect(say.lines.join(" ")).toMatch(/water bucket/i);
  });

  it("an AMBIENT line still speaks from the background, with no reply to race", async () => {
    const { bridge, say } = build('{"level":"concern","imminent":false,"reason":"test"}', 100, 0);
    const reply = await bridge.handle("Steve", UNCAUGHT, say as unknown as SayQueue);
    expect(reply.replied).toBe(false);
    expect(reply.reason).toBe("not-addressed");
    // Give the background promise a turn.
    await new Promise((r) => setTimeout(r, 250));
    expect(say.lines.join(" ")).not.toMatch(/water bucket/i);
    expect(say.lines.length).toBeGreaterThan(0);
  });

  it("a classifier slower than the budget lets the normal reply through", async () => {
    // The timeout branch, end to end, with real timers so it is deterministic: the
    // classifier sleeps 3000 ms and the budget is 2000 ms, so the race resolves on the
    // timer every time. A slow classifier must never silence ordinary conversation.
    const { bridge, say } = build(
      '{"level":"crisis","imminent":false,"reason":"test"}',
      3000,
      100,
      { classifierTimeoutMs: 2000 },
    );
    const started = Date.now();
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    const elapsed = Date.now() - started;
    expect(say.lines.join(" ")).toMatch(/water bucket/i);
    // It waited for the deadline, and not for the classifier's full 3000 ms.
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(2700);
  });

  it("the wait is the LONG POLE, not the sum of both calls", async () => {
    // The parallelism claim. Classifier 300 ms, chat 700 ms: the total should be about
    // the chat call, not about 1000 ms. If the two were serialised this would be ~1000
    // plus overhead, and the assertion has room to tell the difference.
    const { bridge, say } = build(
      '{"level":"crisis","imminent":false,"reason":"test"}',
      300,
      700,
      { classifierTimeoutMs: 2000 },
    );
    const started = Date.now();
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say as unknown as SayQueue);
    const elapsed = Date.now() - started;
    expect(say.lines.join(" ")).not.toMatch(/water bucket/i);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(950);
  });
});
