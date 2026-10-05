/**
 * Round 15 — reviewer probes against 3fe9023.
 *
 * Every test asserts the SAFE / CORRECT behaviour. On 3fe9023, every test except the
 * fixture check FAILS. Do not edit an assertion, delay or timeout. Fix the code.
 *
 *   S1  gentle mode ends after 60 s; a joke is allowed 90 s after a crisis reply   (GENTLE_MODE_MS = 60_000, its comment says "matching the crisis cooldown", which is 10 min)
 *   S2  an ESCALATED crisis reply is never recorded                                (`escalation || noteWellbeingAnswered(...)` short-circuits the write, twice)
 *   S3  every wellbeing reply is recorded twice in the shared WellbeingState        (BotSession also calls noteAnswered from the outcome reason)
 *   S4  a crisis answered through gateScriptedReply is never stamped, so the next line gets a template again
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
import { honestyReply } from "../../src/social/emotion.js";
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
const MODEL_REPLY = "glad you did. i'm around if you want to keep talking";
const NONE = '{"level":"none","imminent":false,"reason":"probe"}';
const CRISIS = '{"level":"crisis","imminent":false,"reason":"probe"}';
const UNCAUGHT_1 = "the bus was late again this morning";
const HONESTY_UNCAUGHT = "are you real? the bus was late again this morning";
const THANKS = "thanks, i talked to my mom";
const GENTLE = /GENTLE MODE IS ON/;
const MINUTE = 60_000;

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
  vi.useRealTimers();
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

/** chatBodies: the request bodies of ordinary chat replies (buildChatMessages), in order. */
function buildBridge(o: { verdicts: string[]; verdictMs: number; chatMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), "elix-r15-"));
  const store = new BrainStore(join(dir, "elix.db"));
  const chatBodies: string[] = [];
  let next = 0;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const body = String((init as { body?: string }).body ?? "");
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: FAST }, { id: GUARD }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const isClassifier = body.includes("classifier");
    if (!isClassifier && body.includes("You are talking to")) chatBodies.push(body);
    if (o.verdictMs > 0 || o.chatMs > 0) await sleep(isClassifier ? o.verdictMs : o.chatMs);
    const verdict = o.verdicts[next] ?? o.verdicts[o.verdicts.length - 1] ?? NONE;
    if (isClassifier) next += 1;
    return completion(isClassifier ? verdict : MODEL_REPLY);
  }) as unknown as typeof fetch;
  const router = new BrainRouter({
    models,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl }) },
    store,
    now: () => Date.now(),
    log: noLog,
    idleChatterBudgetPerHour: 0,
    fastTimeoutMs: 6000,
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
  return { bridge, say, lines, chatBodies };
}

describe("Round 15 probes — ChatBridge", () => {
  it("fixtures", () => {
    for (const l of [UNCAUGHT_1, THANKS]) {
      expect(detectWellbeing(l).level, l).toBe("none");
      expect(needsSecondLook(l), l).toBe(false);
    }
    expect(detectWellbeing(HONESTY_UNCAUGHT).level).toBe("none");
    expect(honestyReply(HONESTY_UNCAUGHT)).not.toBeNull();
    expect(detectWellbeing("i feel numb all the time").level).toBe("concern");
    expect(detectWellbeing("i want to die").level).toBe("crisis");
  });

  it("S1: 90 s and 5 min after a crisis reply, ordinary chat is still answered in gentle mode", async () => {
    const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const { bridge, say, chatBodies } = buildBridge({ verdicts: [NONE], verdictMs: 0, chatMs: 0 });
    await bridge.handle("Steve", "elix i want to die", say); // regex crisis -> crisis reply
    vi.setSystemTime(T0 + 90_000);
    await bridge.handle("Steve", "elix can we build a house now", say);
    vi.setSystemTime(T0 + 5 * MINUTE);
    await bridge.handle("Steve", "elix where did we leave the diamonds", say);
    expect(chatBodies, "two ordinary replies were generated").toHaveLength(2);
    expect(chatBodies[0], "+90 s").toMatch(GENTLE);
    expect(chatBodies[1], "+5 min").toMatch(GENTLE);
  }, 10_000);

  it("S2: an escalated crisis reply is recorded like any other wellbeing reply", async () => {
    const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    const { bridge, say } = buildBridge({ verdicts: [NONE], verdictMs: 0, chatMs: 0 });
    await bridge.handle("Steve", "elix i feel numb all the time", say); // regex concern at T0
    vi.setSystemTime(T0 + 9 * MINUTE); // inside the 10-minute cooldown
    await bridge.handle("Steve", "elix i want to die", say); // regex crisis: an ESCALATION
    // The quiet window and gentle mode are measured from the LAST contact. If the crisis
    // reply is not recorded, both are measured from the concern reply nine minutes earlier.
    expect(bridge.lastWellbeingContact("Steve")).toBe(T0 + 9 * MINUTE);
    expect(bridge.wellbeingState.interventions).toBe(2);
  }, 10_000);

  it("S4: after a crisis answered through gateScriptedReply, the next line is not answered with a template", async () => {
    const { bridge, say } = buildBridge({ verdicts: [CRISIS, NONE], verdictMs: 100, chatMs: 100 });
    const suppressed = await bridge.gateScriptedReply("Steve", HONESTY_UNCAUGHT, say);
    expect(suppressed).toBe(true); // the crisis reply went out instead of the honesty line
    await sleep(200);
    const next = await bridge.handle("Steve", `elix ${THANKS}`, say);
    expect(next.reason, `got ${JSON.stringify(next.text)}`).toBe("llm");
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
  players: Record<string, unknown> = {};
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
  initiative: {
    idlePollMs: 5000,
    nearbyBlocks: 16,
    wellbeingQuietMs: 20 * MINUTE,
    minGapMs: 8 * MINUTE,
    minPull: 0.25,
    memoryImportance: 5,
    memoryGapMs: 20 * MINUTE,
    enabled: false,
  },
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

describe("Round 15 probes — BotSession with the REAL ChatBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 5, 12, 0, 0) });
    bus.removeAll();
  });

  it("S3: one crisis reply is recorded once, not twice", async () => {
    const { bridge } = buildBridge({ verdicts: [NONE], verdictMs: 0, chatMs: 0 });
    const bots: FakeBot[] = [];
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
        players: { online: 2, max: 20 },
        raw: {},
      },
      factory: () => {
        const b = new FakeBot();
        bots.push(b);
        return b;
      },
      onPermanentDisconnect: () => {},
      exitOnPermanent: false,
      chatBridge: bridge,
    } as unknown as SessionDeps;
    const s = new BotSession(deps);
    await s.start();
    bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(2_000);
    bots[0]!.emit("chat", "Steve", "elix i want to die");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bots[0]!.chatCalls.join(" | ")).toMatch(/talk to|trusted|emergency/i);
    expect(bridge.wellbeingState.interventions).toBe(1);
  });
});