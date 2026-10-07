/**
 * Round 18 — reviewer probes against ba2c275.
 *
 * Every test asserts the WORKING behaviour in a running BotSession. On ba2c275 every test
 * except the fixture check FAILS. Do not edit an assertion, delay or timeout. Fix the code.
 *
 *   X0  three "real library" tests read mineflayer from a hard-coded, machine-specific pnpm
 *       store path (node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecf...). On any other
 *       machine - including a fresh clone on Linux - they fail with ENOENT.
 *   X1  the breathe reflex assumes oxygen 0-300. mineflayer's bot.oxygenLevel is 0-20
 *       (lib/plugins/breath.js: Math.round(air / 15)), so it fires on EVERY tick in water,
 *       at full air, and outranks follow and everything else.
 *   X2  when it does fire, "swim-up" only looks up. Nothing presses jump, so Elix sinks.
 *   X3  gather is not wired: nothing in BotSession or ChatBridge calls parseGather, and no
 *       bot.dig exists anywhere in src/. "elix get 5 dirt" goes to the chat model.
 *   X4  give is not wired: no bot.toss anywhere in src/.
 *   X5  places are not wired: parseRemember / parseWhereIs are never called.
 *   X6  tool calls are not wired: parseToolCalls is only called inside toolCalls.ts, so a
 *       model reply with a valid ```tool_calls block does nothing, and the block is sent
 *       to public chat as text.
 *   X7  the NVIDIA tier is not wired: buildBrain() only ever constructs groq and hf, so the
 *       nvidia entries in models.yaml are skipped even with NVIDIA_API_KEY set.
 *
 * The fake bot below exposes the STANDARD mineflayer APIs (findBlocks, findBlock, blockAt,
 * registry, inventory.items, equip, dig, toss, whisper, setControlState, pathfinder).
 * Build against those. If you believe a probe is wrong, stop and explain why.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps, type Vec3Like } from "../../src/connection/bot.js";
import { reflexViewOf } from "../../src/connection/reflexAdapters.js";
import { decideReflex } from "../../src/reflexes/decide.js";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { buildBrain } from "../../src/brain/index.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig, ModelsConfig } from "../../src/core/config.js";

interface McDef {
  id: number;
  defaultState?: number;
  hardness?: number | null;
  material?: string;
  stackSize?: number;
}
interface McData {
  blocksByName: Record<string, McDef | undefined>;
  itemsByName: Record<string, McDef | undefined>;
}
const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => McData)("26.2");
const OWNER = "ElixOwner";

function mineflayerPlayer(name: string, x: number) {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: { username: name, type: "player", name: "player", position: new Vec3(x, 64, 0), isValid: true, height: 1.8 },
  };
}

/** A mineflayer Block. */
function block(name: string, pos: Vec3) {
  const def = data.blocksByName[name]!;
  return { name, id: def.id, type: def.id, stateId: def.defaultState, position: pos, boundingBox: "block", diggable: true, hardness: def.hardness, material: def.material };
}

/** A prismarine Item. */
function item(name: string, count: number, slot: number) {
  const def = data.itemsByName[name]!;
  return { name, type: def.id, count, slot, metadata: 0, stackSize: def.stackSize };
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
    enabled: false,
  },
  owners: [OWNER],
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

/** A small world: grass/dirt surface at y=63, stone below, air above, a patch of dirt at x=3..5. */
class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  version = "26.2";
  registry = data;
  health = 20;
  food = 20;
  oxygenLevel = 20;
  entity: { position: Vec3Like; yaw: number; pitch: number; isInWater: boolean; onGround: boolean } | undefined = {
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
  whispers: Array<{ to: string; text: string }> = [];
  controls: Array<[string, boolean]> = [];
  dug: unknown[] = [];
  tossed: unknown[][] = [];
  pathfinder = { setGoal: vi.fn(), stop: vi.fn(), goto: vi.fn(async () => {}), setMovements: vi.fn(), isMoving: () => false };
  heldItem: unknown = null;
  inventory = {
    slots: [] as unknown[],
    stacks: [] as ReturnType<typeof item>[],
    items: (): ReturnType<typeof item>[] => this.inventory.stacks,
  };
  _client = { on: () => {}, write: () => {} };
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  whisper(to: string, text: string): void {
    this.whispers.push({ to, text });
  }
  setControlState(control: string, state: boolean): void {
    this.controls.push([control, state]);
  }
  clearControlStates(): void {}
  getControlState(): boolean {
    return false;
  }
  blockAt(p: Vec3Like) {
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (pos.y === 63 && pos.x >= 3 && pos.x <= 5 && pos.z === 0) return block("dirt", pos);
    if (pos.y === 63) return block("grass_block", pos);
    if (pos.y < 63) return block("stone", pos);
    return block("air", pos);
  }
  findBlocks(opts: { matching: unknown; maxDistance?: number; count?: number }): Vec3[] {
    const out: Vec3[] = [];
    const matches = (b: ReturnType<FakeBot["blockAt"]>) => {
      const m = opts.matching;
      if (typeof m === "function") return (m as (b: unknown) => boolean)(b);
      if (Array.isArray(m)) return m.includes(b.type);
      return m === b.type;
    };
    for (let x = -8; x <= 8; x++)
      for (let y = 60; y <= 66; y++)
        for (let z = -8; z <= 8; z++) {
          const b = this.blockAt(new Vec3(x, y, z));
          if (b.name !== "air" && matches(b)) out.push(b.position);
        }
    out.sort((a, b) => a.distanceTo(new Vec3(0, 64, 0)) - b.distanceTo(new Vec3(0, 64, 0)));
    return out.slice(0, opts.count ?? 1);
  }
  findBlock(opts: { matching: unknown; maxDistance?: number }) {
    const p = this.findBlocks({ ...opts, count: 1 })[0];
    return p ? this.blockAt(p) : null;
  }
  async dig(b: unknown): Promise<void> {
    this.dug.push(b);
  }
  async toss(itemType: number, metadata: number | null, count: number | null): Promise<void> {
    this.tossed.push([itemType, metadata, count]);
  }
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

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function session(players: Record<string, unknown>, bridgeOverride?: unknown) {
  const bots: FakeBot[] = [];
  const handled: string[] = [];
  const bridge = bridgeOverride ?? {
    handle: vi.fn(async (_s: string, message: string) => {
      handled.push(message);
      return { replied: false, reason: "not-addressed" };
    }),
    recordScripted: vi.fn(),
    gateScriptedReply: vi.fn(async () => false),
    gateOwnLine: vi.fn(async () => false),
    hasPendingAudits: () => false,
    hasUnsettledAudits: () => false,
    inFlightCount: 0,
  };
  const deps = {
    config: CONFIG,
    profile: { name: "main", host: "127.0.0.1", port: 25565, version: "26.2", username: "Elix" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
    pingResult: { version: "Paper 26.2", protocol: 776, software: "Paper", motd: "", players: { online: 2, max: 20 }, raw: {} },
    factory: () => {
      const b = new FakeBot();
      b.players = { Elix: mineflayerPlayer("Elix", 0), ...players };
      for (const p of Object.values(b.players)) {
        const e = (p as { entity?: { id?: number } }).entity;
        if (e) {
          e.id = Object.keys(b.entities).length + 1;
          b.entities[String(e.id)] = e;
        }
      }
      bots.push(b);
      return b;
    },
    onPermanentDisconnect: () => {},
    exitOnPermanent: false,
    chatBridge: bridge,
  } as unknown as SessionDeps;
  return { s: new BotSession(deps), bots, handled };
}

async function started(players: Record<string, unknown>, bridge?: unknown, setup?: (b: FakeBot) => void) {
  const h = session(players, bridge);
  await h.s.start();
  if (setup) setup(h.bots[0]!);
  h.bots[0]!.emit("spawn");
  await vi.advanceTimersByTimeAsync(3_000);
  return h;
}

async function say(h: ReturnType<typeof session>, who: string, line: string, wait = 8_000) {
  h.bots[0]!.emit("chat", who, line);
  await vi.advanceTimersByTimeAsync(wait);
}

const COORDS = /-?\d+\s*,?\s+-?\d+\s*,?\s+-?\d+/;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Round 18 probes — portability", () => {
  it("fixtures", () => {
    expect(data.blocksByName["dirt"]).toBeDefined();
    expect(data.itemsByName["cobblestone"]).toBeDefined();
  });

  it("X0: no test reads mineflayer through a machine-specific pnpm store path", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "round18Probes.test.ts")
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("node_modules/.pnpm/"));
    expect(offenders, "resolve with createRequire(import.meta.url).resolve(...) instead").toEqual([]);
  });
});

describe("Round 18 probes — reflexes against mineflayer's real scales", () => {
  it("X1: full air in water (mineflayer oxygenLevel 20) is NOT a breathe emergency", () => {
    const bot = new FakeBot();
    bot.entity!.isInWater = true;
    bot.oxygenLevel = 20; // mineflayer: Math.round(air_supply / 15), so 20 = full
    const { reflex } = decideReflex(reflexViewOf(bot as unknown as BotLike));
    expect(reflex).not.toBe("breathe");
  });

  it("X2: low air in water (mineflayer oxygenLevel 2) presses jump", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) }, undefined, (b) => {
      b.entity!.isInWater = true;
      b.oxygenLevel = 2;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.bots[0]!.controls).toContainEqual(["jump", true]);
  });
});

describe("Round 18 probes — the WP5/WP6 skills are reachable from chat", () => {
  it("X3: an owner's 'elix get 5 dirt' runs the gather skill, not the chat model", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 5 dirt");
    expect(h.handled, "the line went to the chat model instead of the skill").not.toContain("elix get 5 dirt");
    const b = h.bots[0]!;
    expect(b.pathfinder.setGoal.mock.calls.length + b.dug.length, "no walk and no dig").toBeGreaterThan(0);
  });

  it("X4: an owner's 'elix give me cobblestone' runs the give skill", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) }, undefined, (b) => {
      b.inventory.stacks = [item("cobblestone", 5, 36)];
    });
    await say(h, OWNER, "elix give me cobblestone");
    expect(h.handled).not.toContain("elix give me cobblestone");
    const b = h.bots[0]!;
    expect(b.tossed.length + b.pathfinder.setGoal.mock.calls.length, "no toss and no walk").toBeGreaterThan(0);
  });

  it("X5: 'remember this place' and 'where is' are handled by world memory, and never put coordinates in public chat", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix where is testspot");
    expect(h.handled).not.toContain("elix remember this place as testspot");
    expect(h.handled).not.toContain("elix where is testspot");
    for (const line of h.bots[0]!.chatCalls) expect(line, "coordinates in public chat").not.toMatch(COORDS);
  });
});

/* ------------------------------------------------------- X6: real ChatBridge -- */

const FAST = "openai/gpt-oss-20b";
const GUARD = "openai/gpt-oss-safeguard-20b";
const models = {
  providers: { groq: { baseUrl: null, env: "GROQ_API_KEY" }, hf: { baseUrl: null, env: "HF_TOKEN" } },
  roles: {
    fast: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: GUARD }, { provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;

describe("Round 18 probes — model tool calls reach the body", () => {
  it("X6: a valid tool block from the model makes Elix follow, and the block never reaches chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-r18-"));
    const store = new BrainStore(join(dir, "elix.db"));
    const reply = 'sure, right behind you\n```tool_calls\n{"tool":"follow","player":"ElixOwner"}\n```';
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const body = String((init as { body?: string }).body ?? "");
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ object: "list", data: [{ id: FAST }, { id: GUARD }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const content = body.includes("classifier") ? '{"level":"none","imminent":false,"reason":"probe"}' : reply;
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
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog as never, personaLite: "", typingRandom: () => 1, classifierTimeoutMs: 2000 });
    try {
      const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) }, bridge);
      await say(h, OWNER, "elix could you stick around near me for a while", 12_000);
      const b = h.bots[0]!;
      expect(b.pathfinder.setGoal, "the follow tool call never reached the pathfinder").toHaveBeenCalled();
      for (const line of b.chatCalls) {
        expect(line).not.toMatch(/```|tool_calls|"tool"/);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Round 18 probes — the NVIDIA tier exists at runtime", () => {
  it("X7: with NVIDIA_API_KEY set, buildBrain() builds an nvidia provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-r18b-"));
    const store = new BrainStore(join(dir, "elix.db"));
    try {
      const brain = buildBrain({ models, env: { NVIDIA_API_KEY: "nvapi-probe-not-a-key" }, projectRoot: dir, store });
      expect(brain.providers["nvidia"], "no nvidia adapter was constructed").toBeDefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});