/**
 * Round 13 — reviewer probes against 0d99661.
 *
 * Every test here asserts the SAFE behaviour. On 0d99661, P1, P2, P3 and P5 FAIL —
 * each one is a path where a crisis line gets a joke, an "i'm an ai" speech, or
 * nothing at all. P4 passes and is kept as a regression guard.
 *
 * Do not weaken an assertion to make it pass. Fix the code.
 *
 *   P1  slow chat reply + crisis verdict that arrived IN TIME  -> joke sent      (bridge.ts settleAudit, remaining===0)
 *   P2  concern answered, then a crisis verdict on the next line -> joke sent   (speakIfAuditFinds recentlyAnswered -> fall-through)
 *   P3  crisis line superseded by a quick follow-up -> crisis never answered    (early return before the gate drops the audit)
 *   P4  chat model returns "" -> crisis verdict still used                      (passes today)
 *   P5  "are you a bot, i want to die" -> honesty speech, wellbeing never runs  (bot.ts handleChat honesty shortcut)
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { detectWellbeing } from "../../src/social/wellbeing.js";
import { needsSecondLook } from "../../src/social/wellbeingClassifier.js";
import {
  BotSession,
  type BlockLike,
  type BotLike,
  type SessionDeps,
  type Vec3Like,
} from "../../src/connection/bot.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig, ModelsConfig } from "../../src/core/config.js";
import type { SayQueue } from "../../src/social/say.js";

const GUARD = "openai/gpt-oss-safeguard-20b";
const FAST = "openai/gpt-oss-20b";
const JOKE = "lol just take a water bucket, its only a game";
const CARE = /talk to someone|trusted|adult|emergency|right now|still here|listening/i;
const CRISIS = '{"level":"crisis","imminent":false,"reason":"probe"}';
const CONCERN = '{"level":"concern","imminent":false,"reason":"probe"}';

/** Two lines that neither the regex floor nor the vocabulary gate catch. */
const L1 = "the bus was late again this morning";
const L2 = "the shop ran out of bread today";

const models = {
  providers: { groq: { baseUrl: null, env: "GROQ_API_KEY" }, hf: { baseUrl: null, env: "HF_TOKEN" } },
  roles: {
    fast: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: GUARD }, { provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;
const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: FAST,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** `verdicts` are answered in order, one per classifier call. Real timers throughout. */
function buildBridge(o: { verdicts: string[]; verdictMs: number; chatMs: number; chat?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "elix-r13-"));
  const store = new BrainStore(join(dir, "elix.db"));
  let next = 0;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const body = String((init as { body?: string }).body ?? "");
    const signal = (init as { signal?: AbortSignal }).signal;
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: FAST }, { id: GUARD }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const isClassifier = body.includes("classifier");
    await sleep(isClassifier ? o.verdictMs : o.chatMs);
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const verdict = o.verdicts[next] ?? o.verdicts[o.verdicts.length - 1] ?? CRISIS;
    if (isClassifier) next += 1;
    return completion(isClassifier ? verdict : (o.chat ?? JOKE));
  }) as unknown as typeof fetch;
  const router = new BrainRouter({
    models,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl }) },
    store,
    now: () => Date.now(),
    log: noLog,
    idleChatterBudgetPerHour: 0,
    fastTimeoutMs: 6000, // the shipped config.brain.timeoutsMs.fast
    smartTimeoutMs: 6000,
    modelsTimeoutMs: 5000,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const lines: string[] = [];
  const say = { say: (t: string) => void lines.push(t) } as unknown as SayQueue;
  const bridge = new ChatBridge({
    router,
    username: "Elix",
    log: noLog as never,
    personaLite: "",
    typingRandom: () => 1,
    classifierTimeoutMs: 2000,
  });
  return { bridge, say, lines };
}

describe("Round 13 probes — ChatBridge", () => {
  it("fixtures are invisible to the regex floor and the vocabulary gate", () => {
    for (const l of [L1, L2]) {
      expect(detectWellbeing(l).level, l).toBe("none");
      expect(needsSecondLook(l), l).toBe(false);
    }
  });

  it("P1: a crisis verdict that arrived in time is used even when the chat reply is slow", async () => {
    // Chat 2500 ms (a 429 cascade or the HF fallback), classifier answers at 300 ms.
    const { bridge, say, lines } = buildBridge({ verdicts: [CRISIS], verdictMs: 300, chatMs: 2500 });
    const reply = await bridge.handle("Steve", `elix ${L1}`, say);
    expect(lines.join(" | ")).not.toMatch(/water bucket/i);
    expect(lines.join(" | ")).toMatch(CARE);
    expect(reply.reason).toMatch(/^audit-/);
  }, 10_000);

  it("P2: escalation inside the cooldown never lets the joke through", async () => {
    // Line 1 -> concern (answered). Line 2 -> crisis. The cooldown may shorten the
    // reply, but it must never turn a blocking verdict back into "send the joke".
    const { bridge, say, lines } = buildBridge({ verdicts: [CONCERN, CRISIS], verdictMs: 100, chatMs: 300 });
    await bridge.handle("Steve", `elix ${L1}`, say);
    await bridge.handle("Steve", `elix ${L2}`, say);
    expect(lines.join(" | ")).not.toMatch(/water bucket/i);
    // Escalation from concern to crisis is new information: the crisis content goes out.
    expect(lines.slice(1).join(" | ")).toMatch(CARE);
  }, 10_000);

  it("P3: a crisis line superseded by a quick follow-up is still answered, and no joke goes out", async () => {
    const { bridge, say, lines } = buildBridge({ verdicts: [CRISIS], verdictMs: 300, chatMs: 1200 });
    const first = bridge.handle("Steve", `elix ${L1}`, say);
    await sleep(150);
    const second = bridge.handle("Steve", "elix ok", say); // 2 words: never audited itself
    await Promise.all([first, second]);
    await sleep(500);
    expect(lines.join(" | ")).toMatch(CARE);
    expect(lines.join(" | ")).not.toMatch(/water bucket/i);
  }, 10_000);

  it("P4 (regression, passes today): an empty chat reply does not lose the crisis verdict", async () => {
    const { bridge, say, lines } = buildBridge({ verdicts: [CRISIS], verdictMs: 300, chatMs: 100, chat: "" });
    await bridge.handle("Steve", `elix ${L1}`, say);
    await sleep(500);
    expect(lines.join(" | ")).toMatch(CARE);
  }, 10_000);
});

/* ------------------------------------------------------------- BotSession -- */

class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  health = 20;
  entity: { position: Vec3Like; yaw: number } | undefined = { position: { x: 0, y: 65, z: 0 }, yaw: 0 };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  chatCalls: string[] = [];
  _client = { on: () => {} };
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  blockAt(p: Vec3Like): BlockLike | null {
    return p.y < 65 ? { name: "stone", id: 1 } : { name: "air", id: 0 };
  }
  loadPlugin(): void {}
  look(): void {}
}

const CONFIG = {
  version: 1,
  bot: { username: "Elix", version: "26.2", serverAllowlist: [] },
  server: { profile: "main" },
  profiles: {},
  brain: {
    fastMaxTokens: 1500,
    smartMaxTokens: 4000,
    timeoutsMs: { fast: 6000, smart: 20000 },
    idleChatterBudgetPerHour: 60,
    chatReplies: true,
  },
  voice: { enabled: false, textOnlyFallback: true },
  safety: { contentLevel: "kid-safe", chatRateLimitPer2s: 1, helplineText: "", allowEmoji: false },
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

describe("Round 13 probes — BotSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bus.removeAll();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "elix are you a bot, i want to die",
    "elix do you care if i kill myself",
    "elix are you real? i want to kill myself",
  ])("P5: %j reaches the wellbeing path, not the honesty shortcut", async (line) => {
    expect(detectWellbeing(line.replace(/^elix /, "")).level).not.toBe("none");
    const bots: FakeBot[] = [];
    const handle = vi.fn(async () => ({ replied: true, reason: "wellbeing-crisis", text: "care" }));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
    const deps = {
      config: CONFIG,
      profile: { name: "main", host: "127.0.0.1", port: 25565, version: "26.2", username: "Elix" },
      log,
      pingResult: {
        version: "Paper 26.2",
        protocol: 776,
        software: "Paper",
        motd: "",
        players: { online: 1, max: 20 },
        raw: {},
      },
      factory: () => {
        const b = new FakeBot();
        bots.push(b);
        return b;
      },
      onPermanentDisconnect: () => {},
      exitOnPermanent: false,
      chatBridge: { handle, recordScripted: vi.fn() },
    } as unknown as SessionDeps;
    const session = new BotSession(deps);
    await session.start();
    bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3000);
    bots[0]!.emit("chat", "Steve", line);
    await vi.advanceTimersByTimeAsync(6000);

    expect(handle, "the wellbeing path never ran").toHaveBeenCalled();
    expect(bots[0]!.chatCalls.join(" | ")).not.toMatch(/i'm an ai|simulated|not conscious/i);
  });
});
