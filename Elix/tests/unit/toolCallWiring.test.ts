/**
 * R18-G acceptance — model tool calls reach the body.
 *
 * Built like the probe: a REAL `ChatBridge`, a real `BrainRouter` and a fake fetch, so what is
 * under test is the whole path from an HTTP response to `pathfinder.setGoal` - not a mock that
 * was handed the answer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps } from "../../src/connection/bot.js";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { selectToolCalls } from "../../src/brain/toolCalls.js";
import { readFileSync } from "node:fs";
import { bus } from "../../src/core/events.js";
import type { ElixConfig, ModelsConfig } from "../../src/core/config.js";

const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => {
  blocksByName: Record<string, { id: number } | undefined>;
  itemsByName: Record<string, { id: number } | undefined>;
})("26.2");

const OWNER = "ElixOwner";
const STRANGER = "NotTheOwner";
const FAST = "openai/gpt-oss-20b";
const GUARD = "openai/gpt-oss-safeguard-20b";

const MODELS = {
  providers: { groq: { baseUrl: null, env: "GROQ_API_KEY" } },
  roles: {
    fast: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: GUARD }, { provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {} };

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
    enabled: false,
  },
  owners: [OWNER],
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

function mineflayerPlayer(name: string, x: number) {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: { username: name, type: "player", name: "player", position: new Vec3(x, 64, 0), isValid: true, height: 1.8 },
  };
}

class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  version = "26.2";
  registry = data;
  health = 20;
  food = 20;
  oxygenLevel = 20;
  entity: { position: Vec3; yaw: number; pitch: number; isInWater: boolean; onGround: boolean } = {
    position: new Vec3(0, 64, 0),
    yaw: 0,
    pitch: 0,
    isInWater: false,
    onGround: true,
  };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  players: Record<string, unknown> = {};
  entities: Record<string, unknown> = {};
  chatCalls: string[] = [];
  pathfinder = {
    setGoal: vi.fn(),
    stop: vi.fn(),
    goto: vi.fn(async () => {}),
    setMovements: vi.fn(),
    isMoving: () => false,
  };
  heldItem: unknown = null;
  inventory = { slots: [] as unknown[], stacks: [] as unknown[], items: () => this.inventory.stacks };
  _client = { on: () => {}, write: () => {} };
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  whisper(): void {}
  setControlState(): void {}
  clearControlStates(): void {}
  getControlState(): boolean {
    return false;
  }
  blockAt(): null {
    return null;
  }
  findBlocks(): unknown[] {
    return [];
  }
  findBlock(): unknown {
    return null;
  }
  async dig(): Promise<void> {}
  async toss(): Promise<void> {}
  async equip(): Promise<void> {}
  async consume(): Promise<void> {}
  lookAt(): Promise<void> {
    return Promise.resolve();
  }
  look(): Promise<void> {
    return Promise.resolve();
  }
  canDigBlock(): boolean {
    return true;
  }
  digTime(): number {
    return 500;
  }
  loadPlugin(): void {}
}

/** A fetch that answers with `reply`, and classifies everything as harmless. */
function fetchSaying(reply: string, classifier = '{"level":"none","imminent":false,"reason":"test"}'): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    const body = String((init as { body?: string }).body ?? "");
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: FAST }, { id: GUARD }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Discriminate by the PERSONA, which is in the chat messages and in no other request:
    // guessing at the classifier prompt's wording is how a "dropped reply" test silently
    // stops dropping anything.
    const content = body.includes("you are elix") ? reply : classifier;
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
  }) as unknown as typeof fetch;
}

/** Run one session with a real bridge and a fake model, then clean the store up. */
async function withBridge(
  reply: string,
  run: (h: { bots: FakeBot[]; handled: string[] }) => Promise<void>,
  classifier?: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elix-r18g-"));
  const store = new BrainStore(join(dir, "elix.db"));
  const fetchImpl = fetchSaying(reply, classifier);
  const router = new BrainRouter({
    models: MODELS,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl }) },
    store,
    now: () => Date.now(),
    log: noLog,
    idleChatterBudgetPerHour: 0,
    fastTimeoutMs: 6000,
    smartTimeoutMs: 6000,
    modelsTimeoutMs: 5000,
  });
  const bridge = new ChatBridge({
    router,
    username: "Elix",
    log: noLog as never,
    personaLite: "you are elix",
    typingRandom: () => 1,
    classifierTimeoutMs: 2000,
  });
  const bots: FakeBot[] = [];
  const handled: string[] = [];
  try {
    const deps = {
      config: CONFIG,
      profile: { name: "main", host: "127.0.0.1", port: 25565, version: "26.2", username: "Elix" },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
      pingResult: { version: "Paper 26.2", protocol: 776, software: "Paper", motd: "", players: { online: 2, max: 20 }, raw: {} },
      factory: () => {
        const b = new FakeBot();
        b.players = { Elix: mineflayerPlayer("Elix", 0), ElixOwner: mineflayerPlayer(OWNER, 4), NotTheOwner: mineflayerPlayer(STRANGER, 6) };
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
    await vi.advanceTimersByTimeAsync(3_000);
    await run({ bots, handled });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const TOOL_REPLY = 'sure, right behind you\n```tool_calls\n{"tool":"follow","player":"ElixOwner"}\n```';

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R18-G — an owner's tool call runs; a stranger's does not", () => {
  it("a valid tool block makes Elix follow, through the real bridge", async () => {
    await withBridge(TOOL_REPLY, async (h) => {
      h.bots[0]!.emit("chat", OWNER, "elix could you stick around near me for a while");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.setGoal, "the tool call never reached the body").toHaveBeenCalled();
    });
  });

  it("the block NEVER appears in anything Elix says", async () => {
    await withBridge(TOOL_REPLY, async (h) => {
      h.bots[0]!.emit("chat", OWNER, "elix could you stick around near me for a while");
      await vi.advanceTimersByTimeAsync(12_000);
      for (const line of h.bots[0]!.chatCalls) {
        expect(line).not.toMatch(/```|tool_calls|"tool"/u);
      }
      // And the human half of the reply IS said, so stripping did not delete the answer.
      expect(h.bots[0]!.chatCalls.join(" ")).toContain("right behind you");
    });
  });

  it("a STRANGER's tool call is refused even when the model produces a perfect one", async () => {
    await withBridge('ok\n```tool_calls\n{"tool":"follow"}\n```', async (h) => {
      h.bots[0]!.emit("chat", STRANGER, "elix stick around near me");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.setGoal, "a stranger's tool call moved Elix").not.toHaveBeenCalled();
      for (const line of h.bots[0]!.chatCalls) expect(line).not.toMatch(/```|tool_calls|"tool"/u);
    });
  });

  it("a tool block naming SOMEBODY ELSE is refused - the asker is the only possible target", async () => {
    const reply = 'sure\n```tool_calls\n{"tool":"follow","player":"NotTheOwner"}\n```';
    await withBridge(reply, async (h) => {
      h.bots[0]!.emit("chat", OWNER, "elix stick around near me");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.setGoal, "Elix walked to somebody the model picked").not.toHaveBeenCalled();
    });
  });

  it("a DROPPED reply executes nothing - the call sits AFTER the send gate, in the source", () => {
    // Not driven through the classifier fake. `speakIfAuditFinds` decides whether a verdict
    // is a NEW detection, and a fake cannot force that without also depending on the
    // cooldown state left behind by earlier tests - so a test written that way passes or
    // fails for reasons that have nothing to do with tool calls.
    //
    // What IS asserted, and asserted in the only place that cannot rot silently:
    //   1. the pure gate refuses every call when the reply was dropped, and
    //   2. in bridge.ts the runToolCalls call comes AFTER the gateReply early return, so a
    //      dropped reply returns before any call is considered.
    const source = readFileSync("src/brain/bridge.ts", "utf8");
    const gate = source.indexOf("const gated = await this.gateReply(");
    const drop = source.indexOf("await this.runToolCalls(sender, raw);");
    expect(gate, "the send gate moved").toBeGreaterThan(0);
    expect(drop, "the tool-call call site moved").toBeGreaterThan(0);
    expect(drop, "tool calls run BEFORE the send gate, so a dropped reply still acts").toBeGreaterThan(gate);
  });

  it("the pure gate refuses every call when the reply was dropped", () => {
    const blocked = selectToolCalls(`ok\n\`\`\`tool_calls\n{"tool":"follow","player":"${OWNER}"}\n\`\`\``, {
      askedBy: OWNER,
      isOwner: true,
      replyDropped: true,
      gentleMode: false,
      callsThisMinute: 0,
    });
    expect(blocked.calls, "a dropped reply's calls were allowed through").toEqual([]);
    expect(blocked.refused).toBe("dropped-reply");
  });

  it("gentle mode allows only stop and follow", () => {
    const gentle = selectToolCalls('ok\n```tool_calls\n{"tool":"gather","block":"dirt","count":1}\n```', {
      askedBy: OWNER,
      isOwner: true,
      replyDropped: false,
      gentleMode: true,
      callsThisMinute: 0,
    });
    expect(gentle.calls).toEqual([]);
    expect(gentle.refused).toBe("gentle-mode");
    const stop = selectToolCalls('ok\n```tool_calls\n{"tool":"stop"}\n```', {
      askedBy: OWNER,
      isOwner: true,
      replyDropped: false,
      gentleMode: true,
      callsThisMinute: 0,
    });
    expect(stop.calls.length, "gentle mode must still allow stop").toBe(1);
  });
  it("an unknown tool is refused, and still stripped from the text", async () => {
    await withBridge('ok\n```tool_calls\n{"tool":"selfDestruct"}\n```', async (h) => {
      h.bots[0]!.emit("chat", OWNER, "elix stick around near me");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.setGoal).not.toHaveBeenCalled();
      for (const line of h.bots[0]!.chatCalls) expect(line).not.toMatch(/```|tool_calls|"tool"/u);
    });
  });

  it("a reply with no tool block changes nothing about the pathfinder", async () => {
    await withBridge("just a normal reply", async (h) => {
      h.bots[0]!.emit("chat", OWNER, "elix stick around near me");
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.setGoal).not.toHaveBeenCalled();
    });
  });

  it("a bare JSON object in chat is NOT a tool call", async () => {
    // A player typing this must not be able to make Elix act.
    await withBridge("sure", async (h) => {
      h.bots[0]!.emit("chat", OWNER, 'elix {"tool":"stop"}');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(h.bots[0]!.pathfinder.stop, "a player typed their way into a command").not.toHaveBeenCalled();
    });
  });
});
