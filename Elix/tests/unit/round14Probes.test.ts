/**
 * Round 14 — reviewer probes against 3c7671f.
 *
 * Every test asserts the SAFE / WORKING behaviour. On 3c7671f, every test in this file
 * except the fixture check FAILS. Do not weaken an assertion, delay or timeout. Fix the code.
 *
 *   R1  hasPendingAudits() stays true forever after one ordinary line  (pendingAudits only pruned on that sender's next addressed reply)
 *   R2  regex-caught concern, then an audit-caught crisis -> SHORT crisis line, no "emergency"/"right now"  (lastWellbeingLevel only set on the audit path)
 *   R3  initiative sends ELIX'S OWN line to the classifier as if the player said it  (considerInitiative -> gateScriptedReply(target, line))
 *   R4  initiative never fires in a real game: mineflayer players have entity.position, not position  (bot.ts passes bot.players with a cast)
 *   R5  "elix i want to die" -> crisis reply -> seconds later "how is your day going so far, Steve?"  (lastWellbeingAt is read but never written)
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
const NONE = '{"level":"none","imminent":false,"reason":"probe"}';
const CRISIS = '{"level":"crisis","imminent":false,"reason":"probe"}';
const UNCAUGHT = "the bus was late again this morning";
const REGEX_CONCERN = "i feel numb all the time";
const REGEX_CRISIS = "i want to die";

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

function buildBridge(o: { verdicts: string[]; verdictMs: number; chatMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), "elix-r14-"));
  const store = new BrainStore(join(dir, "elix.db"));
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
    await sleep(isClassifier ? o.verdictMs : o.chatMs);
    const verdict = o.verdicts[next] ?? o.verdicts[o.verdicts.length - 1] ?? NONE;
    if (isClassifier) next += 1;
    return completion(isClassifier ? verdict : JOKE);
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
  return { bridge, say, lines };
}

describe("Round 14 probes — ChatBridge", () => {
  it("fixtures: the regex floor sees what it should and nothing else", () => {
    expect(detectWellbeing(UNCAUGHT).level).toBe("none");
    expect(needsSecondLook(UNCAUGHT)).toBe(false);
    expect(detectWellbeing(REGEX_CONCERN).level).toBe("concern");
    expect(detectWellbeing(REGEX_CRISIS).level).toBe("crisis");
  });

  it("R1: one ordinary line does not leave hasPendingAudits() true ten minutes later", async () => {
    const { bridge, say } = buildBridge({ verdicts: [NONE], verdictMs: 50, chatMs: 50 });
    await bridge.handle("Alex", UNCAUGHT, say); // ambient: Alex never talks to Elix again
    await sleep(200);
    const tenMinutesLater = Date.now() + 10 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"], now: tenMinutesLater });
    try {
      // B's poll reads this before every unprompted line. If it never goes false, Elix
      // never speaks first again for the rest of the session.
      expect(bridge.hasPendingAudits()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("R2: a regex-caught concern followed by an audit-caught crisis gets the FULL crisis reply", async () => {
    const { bridge, say, lines } = buildBridge({ verdicts: [CRISIS], verdictMs: 100, chatMs: 300 });
    await bridge.handle("Steve", `elix ${REGEX_CONCERN}`, say); // regex floor answers: concern
    await bridge.handle("Steve", `elix ${UNCAUGHT}`, say); // classifier says crisis: escalation
    const second = lines.slice(1).join(" | ");
    expect(second).not.toMatch(/water bucket/i);
    // Escalation is new information. The short "still here" form drops the emergency
    // guidance, which is the one thing a crisis reply must carry.
    expect(second).toMatch(/emergency|right now/i);
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
    wellbeingQuietMs: 20 * 60_000,
    minGapMs: 8 * 60_000,
    minPull: 0.25,
    memoryImportance: 5,
    memoryGapMs: 20 * 60_000,
    enabled: true,
  },
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

const INITIATIVE_LINE = /how is your day|tell me about it|look at something together|i remembered something/i;

/** A mineflayer Player: the position lives on `entity`, exactly as in mineflayer's typings. */
function mineflayerPlayer(name: string, x: number) {
  return { username: name, uuid: "u", ping: 30, gamemode: 0, entity: { position: { x, y: 65, z: 0 } } };
}

function session(players: Record<string, unknown>) {
  const bots: FakeBot[] = [];
  const scripted: Array<{ sender: string; message: string }> = [];
  const bridge = {
    handle: vi.fn(async (_sender: string, message: string, say?: SayQueue) => {
      // Stands in for the real bridge's crisis path: a caring reply goes out.
      if (detectWellbeing(message).level !== "none") {
        say?.say("i'm here and i'm listening. please talk to someone you trust right now.", true, true);
        return { replied: true, reason: "wellbeing-crisis", text: "care" };
      }
      return { replied: false, reason: "not-addressed" };
    }),
    recordScripted: vi.fn(),
    gateScriptedReply: vi.fn(async (sender: string, message: string) => {
      scripted.push({ sender, message });
      return false;
    }),
    hasPendingAudits: () => false,
    inFlightCount: 0,
  };
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
      b.players = { Elix: mineflayerPlayer("Elix", 0), ...players };
      bots.push(b);
      return b;
    },
    onPermanentDisconnect: () => {},
    exitOnPermanent: false,
    chatBridge: bridge,
  } as unknown as SessionDeps;
  return { s: new BotSession(deps), bots, scripted, log };
}

describe("Round 14 probes — initiative in BotSession", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 9 * 60 * 60_000 });
    bus.removeAll();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("R4: with a REAL mineflayer player 4 blocks away and nothing going on, Elix eventually speaks first", async () => {
    const { s, bots } = session({ Steve: mineflayerPlayer("Steve", 4) });
    await s.start();
    bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bots[0]!.chatCalls.join(" | ")).toMatch(INITIATIVE_LINE);
  });

  it("R3: initiative never submits Elix's own words to the classifier as the player's message", async () => {
    // Both shapes present so this runs today regardless of R4.
    const { s, bots, scripted } = session({ Steve: { ...mineflayerPlayer("Steve", 4), position: { x: 4, y: 65, z: 0 } } });
    await s.start();
    bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(60_000);
    const elixLinesAudited = scripted.filter((c) => INITIATIVE_LINE.test(c.message));
    expect(elixLinesAudited, "Elix's line was audited as if Steve had said it").toEqual([]);
  });

  it("R5: after 'elix i want to die' there is no cheerful unprompted line to that player inside the quiet window", async () => {
    // Both shapes present so this fails today for the quiet-window reason, not for R4's.
    const { s, bots } = session({ Steve: { ...mineflayerPlayer("Steve", 4), position: { x: 4, y: 65, z: 0 } } });
    await s.start();
    bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(2_000);
    bots[0]!.emit("chat", "Steve", `elix ${REGEX_CRISIS}`);
    await vi.advanceTimersByTimeAsync(10 * 60_000); // well inside the 20 min quiet window
    const sent = bots[0]!.chatCalls.join(" | ");
    expect(sent).toMatch(/talk to someone you trust/i); // the crisis reply went out
    expect(sent).not.toMatch(INITIATIVE_LINE);
  });
});
