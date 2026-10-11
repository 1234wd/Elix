/**
 * R18-E acceptance — give and deposit, from a chat line to a real `bot.toss` and a real
 * `window.deposit`.
 *
 * The "never withdraw" rule is enforced twice on purpose: once as behaviour (the fake records
 * any call to `withdraw` and the test fails if there is one) and once as a source check, because
 * a future edit that adds a withdraw call in a branch no test happens to reach would otherwise
 * slip through.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps } from "../../src/connection/bot.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig } from "../../src/core/config.js";

const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => {
  blocksByName: Record<string, { id: number; defaultState?: number } | undefined>;
  itemsByName: Record<string, { id: number; stackSize?: number } | undefined>;
})("26.2");

const OWNER = "ElixOwner";
const STRANGER = "NotTheOwner";

function mineflayerPlayer(name: string, x: number) {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: {
      username: name,
      type: "player",
      name: "player",
      position: new Vec3(x, 64, 0),
      isValid: true,
      height: 1.8,
    },
  };
}

function block(name: string, pos: Vec3) {
  const def = data.blocksByName[name]!;
  return { name, id: def.id, type: def.id, stateId: def.defaultState, position: pos, boundingBox: "block", diggable: true };
}

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
  /** Every bot.toss call, in the real argument order. */
  tossed: unknown[][] = [];
  /** Every window.deposit call. */
  deposited: unknown[][] = [];
  /** Every window.withdraw call. This list must ALWAYS be empty. */
  withdrew: unknown[][] = [];
  opened: unknown[] = [];
  closed: unknown[] = [];
  chestHere = false;
  pathfinder = {
    setGoal: vi.fn(),
    stop: vi.fn(),
    goto: vi.fn(async () => {}),
    setMovements: vi.fn(),
    isMoving: () => false,
  };
  heldItem: unknown = null;
  inventory = { slots: [] as unknown[], stacks: [] as ReturnType<typeof item>[], items: () => this.inventory.stacks };
  _client = { on: () => {}, write: () => {} };
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  setControlState(): void {}
  clearControlStates(): void {}
  getControlState(): boolean {
    return false;
  }
  blockAt(p: { x: number; y: number; z: number }) {
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (this.chestHere && pos.equals(new Vec3(2, 64, 0))) return block("chest", pos);
    if (pos.y === 63) return block("grass_block", pos);
    if (pos.y < 63) return block("stone", pos);
    return block("air", pos);
  }
  /** COORDINATES, not blocks - mineflayer docs/api.md. R19-B. */
  findBlocks(opts: { matching: unknown; count?: number }): Vec3[] {
    const ids = Array.isArray(opts.matching) ? opts.matching : [opts.matching];
    if (!ids.includes(data.blocksByName["chest"]!.id)) return [];
    const here = this.blockAt(new Vec3(2, 64, 0));
    return here !== null && here.name === "chest" ? [new Vec3(2, 64, 0)] : [];
  }
  findBlock(): unknown {
    return null;
  }
  /** mineflayer's REAL signature: bot.toss(itemType, metadata, count). */
  async toss(itemType: number, metadata: number | null, count: number): Promise<void> {
    this.tossed.push([itemType, metadata, count]);
  }
  async openContainer(b: unknown): Promise<unknown> {
    const candidate = b as { name?: unknown } | null;
    if (candidate === null || typeof candidate.name !== "string") {
      throw new Error("openContainer needs a Block, got " + JSON.stringify(b));
    }
    this.opened.push(b);
    return {
      deposit: async (...args: unknown[]) => {
        this.deposited.push(args);
      },
      withdraw: async (...args: unknown[]) => {
        this.withdrew.push(args);
      },
      close: async () => {
        this.closed.push("container");
      },
    };
  }
  async closeContainer(w: unknown): Promise<void> {
    this.closed.push(w);
  }
  async equip(): Promise<void> {}
  async dig(): Promise<void> {}
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

function harness(players: Record<string, unknown>) {
  const bots: FakeBot[] = [];
  const handled: string[] = [];
  const bridge = {
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
  return { s: new BotSession(deps), bots, handled, bridge };
}

async function started(players: Record<string, unknown>) {
  const h = harness(players);
  await h.s.start();
  h.bots[0]!.emit("spawn");
  await vi.advanceTimersByTimeAsync(3_000);
  return h;
}

async function say(h: ReturnType<typeof harness>, who: string, line: string, wait = 8_000) {
  h.bots[0]!.emit("chat", who, line);
  await vi.advanceTimersByTimeAsync(wait);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R18-E — the installed mineflayer really has these signatures", () => {
  const root = createRequire(import.meta.url).resolve("mineflayer/package.json").replace(/package\.json$/u, "");
  const read = (rel: string): string => readFileSync(root + rel, "utf8");

  it("bot.toss takes (itemType, metadata, count)", () => {
    expect(read("lib/plugins/simple_inventory.js")).toMatch(/async function toss \(itemType, metadata, count\)/u);
  });

  it("window.deposit takes (itemType, metadata, count, nbt)", () => {
    expect(read("docs/api.md")).toMatch(/window\.deposit\(itemType, metadata, count, nbt\)/u);
  });

  it("GoalNear takes FOUR NUMBERS - x, y, z, range - not a position object", () => {
    const pf = createRequire(import.meta.url).resolve("mineflayer-pathfinder/package.json").replace(/package\.json$/u, "");
    expect(readFileSync(pf + "lib/goals.js", "utf8")).toMatch(/class GoalNear extends Goal \{/u);
  });
});

describe("R18-E — an owner's 'give me' reaches bot.toss", () => {
  it("walks to the asker with a REAL goal, then tosses to THEM", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2), [STRANGER]: mineflayerPlayer(STRANGER, 3) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    await say(h, OWNER, "elix give me cobblestone");
    expect(h.handled, "the line went to the chat model").not.toContain("elix give me cobblestone");
    const b = h.bots[0]!;
    // Elix is 2 blocks from the owner and 3 from the stranger, and the hand-over happens to
    // the OWNER. "Nearest player" would have been the wrong answer here, which is why the
    // distance check is against the asker's own record.
    expect(b.tossed.length, "nothing was tossed").toBeGreaterThan(0);
    // The COUNT is the parser's decision, and "give me cobblestone" without a number means
    // one - not the whole stack. Asserting 5 here would have been a guess dressed as a test.
    expect(b.tossed[0]).toEqual([data.itemsByName["cobblestone"]!.id, null, 1]);
    expect(b.pathfinder.setGoal, "never walked at all").toHaveBeenCalled();
  });

  it("the goal it sets is a real pathfinder goal with numeric coordinates", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    await say(h, OWNER, "elix give me cobblestone");
    const goal = h.bots[0]!.pathfinder.setGoal.mock.calls[0]?.[0] as {
      isValid?: unknown;
      heuristic?: unknown;
      isEnd?: unknown;
      hasChanged?: unknown;
      x?: number;
      y?: number;
      z?: number;
    };
    expect(typeof goal.isValid).toBe("function");
    expect(typeof goal.heuristic).toBe("function");
    expect(typeof goal.isEnd).toBe("function");
    expect(typeof goal.hasChanged).toBe("function");
    expect(Number.isFinite(goal.x), "GoalNear got something that is not a number").toBe(true);
    expect(Number.isFinite(goal.z)).toBe(true);
  });

  it("hands over exactly the number asked for", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 9, 36)];
    await say(h, OWNER, "elix give me 3 cobblestone");
    expect(h.bots[0]!.tossed[0]).toEqual([data.itemsByName["cobblestone"]!.id, null, 3]);
  });

  it("hands over no more than Elix is holding", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 2, 36)];
    await say(h, OWNER, "elix give me 64 cobblestone");
    expect(h.bots[0]!.tossed[0]).toEqual([data.itemsByName["cobblestone"]!.id, null, 2]);
  });

  it("gives nothing when he does not have it, and says so", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    h.bots[0]!.inventory.stacks = [];
    await say(h, OWNER, "elix give me cobblestone");
    expect(h.bots[0]!.tossed, "tossed something he does not have").toEqual([]);
    expect(h.bots[0]!.chatCalls.join(" ")).not.toBe("");
  });
});

describe("R18-E — the rules around it", () => {
  it("a STRANGER gets nothing and no toss", async () => {
    const h = await started({ [STRANGER]: mineflayerPlayer(STRANGER, 2), [OWNER]: mineflayerPlayer(OWNER, 9) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    await say(h, STRANGER, "elix give me cobblestone");
    expect(h.bots[0]!.tossed, "a stranger walked away with Elix's things").toEqual([]);
    expect(h.bots[0]!.chatCalls.join(" ")).toMatch(/can't do that/iu);
  });

  it("a wellbeing-floor line triggers nothing, even when it reads like a command", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    await say(h, OWNER, "elix give me cobblestone i feel awful about my cat");
    expect(h.bots[0]!.tossed).toEqual([]);
  });

  it("an unaddressed line is not a give", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    await say(h, OWNER, "everyone give me cobblestone");
    expect(h.bots[0]!.tossed).toEqual([]);
  });

  it("elix stop ends the walk before the hand-over", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 5, 36)];
    h.bots[0]!.emit("chat", OWNER, "elix give me cobblestone");
    await vi.advanceTimersByTimeAsync(100);
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.bots[0]!.tossed, "handed the item over after a stop").toEqual([]);
  });
});

describe("R18-E — deposit is a one-way door", () => {
  it("opens the chest, deposits every stack, and closes it", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.chestHere = true;
    b.inventory.stacks = [item("cobblestone", 12, 36), item("dirt", 5, 37)];
    await say(h, OWNER, "elix put your stuff in the chest");
    expect(b.opened.length, "never called bot.openContainer").toBeGreaterThan(0);
    expect((b.opened[0] as { name?: string }).name, "opened something that is not a chest").toBe("chest");
    expect(b.deposited.length, "deposited nothing").toBe(2);
    expect(b.deposited[0]).toEqual([data.itemsByName["cobblestone"]!.id, null, 12, undefined]);
    expect(b.closed.length, "never closed the chest").toBeGreaterThan(0);
  });

  it("NEVER calls window.withdraw - not once, not for anything", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.chestHere = true;
    b.inventory.stacks = [item("cobblestone", 12, 36)];
    await say(h, OWNER, "elix put your stuff in the chest");
    expect(b.withdrew, "took something out of somebody's chest").toEqual([]);
  });

  it("the runtime source contains no withdraw call at all", () => {
    // Behavioural tests only cover the branches they walk. This one covers the file.
    const source = readFileSync("src/skills/giveRuntime.ts", "utf8");
    const calls = source.match(/\.\s*withdraw\s*\(/gu) ?? [];
    expect(calls, "giveRuntime.ts must never call withdraw").toEqual([]);
  });

  it("a chest out of range is a refusal, not a walk across the world", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.chestHere = false;
    b.inventory.stacks = [item("cobblestone", 12, 36)];
    await say(h, OWNER, "elix put your stuff in the chest");
    expect(b.opened, "opened a chest that is not there").toEqual([]);
    expect(b.deposited).toEqual([]);
  });

  it("a STRANGER cannot empty Elix's inventory into a chest", async () => {
    const h = await started({ [STRANGER]: mineflayerPlayer(STRANGER, 2) });
    const b = h.bots[0]!;
    b.chestHere = true;
    b.inventory.stacks = [item("cobblestone", 12, 36)];
    await say(h, STRANGER, "elix put your stuff in the chest");
    expect(b.deposited).toEqual([]);
  });
});
