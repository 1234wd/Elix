/**
 * Round 19 — reviewer probes against 8807eb8: the skills at REAL SPEED.
 *
 * Every test asserts the WORKING behaviour. On 8807eb8 every test except the fixture check
 * FAILS. Do not edit an assertion, delay or timeout. Fix the code.
 *
 * The Round 18 fakes resolve dig / toss / openContainer / placeBlock / craft in the same
 * microtask, and the fake pathfinder never moves. The real ones take hundreds of ms to
 * seconds, and the real mineflayer-pathfinder CLEARS the path and the control states on
 * every setGoal (index.js resetPath('goal_updated'), clearStates = true). This fake bot
 * keeps those two properties:
 *
 *   - every action takes real (fake-timer) time;
 *   - dig() while a dig is running ABORTS the first one with "Digging aborted",
 *     exactly like mineflayer lib/plugins/digging.js line 127;
 *   - setGoal() restarts the walk; Elix only arrives if the goal is left alone for 1 s.
 *
 * What fails on 8807eb8, and why:
 *
 *   Z1  gather: step() runs every 50 ms with no in-flight guard and no arrival check. It
 *       digs 50 ms after setting the walk goal - out of reach - and the next tick's dig
 *       aborts the first, which ends the gather. Nothing is ever gathered.
 *   Z2  give (asker 12 blocks away): walkToAsker() calls setGoal on every 50 ms tick, so the
 *       real pathfinder never gets to move. Elix never arrives; nothing is given.
 *   Z3  give (asker close): toss() is re-entered while the first toss is awaited, so the
 *       owner gets the item several times.
 *   Z4  deposit: never starts. bot.findBlocks returns COORDINATES (mineflayer docs/api.md:
 *       "the found block coordinates (not the blocks)"), but chestViewOf() reads
 *       found[0].position - always undefined - so every chest is "too far". Behind that,
 *       GiveRunner.chestNear() hands that Vec3 to openContainer(), which needs a Block, and
 *       openContainer() is re-entered on every 50 ms tick while the first open is awaited.
 *   Z5  craft: run() advances the plan synchronously each tick, so "crafting" starts while
 *       "place-table" is still awaiting placeBlock, finds no table, and refuses.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { BotSession, type BotLike, type SessionDeps, type Vec3Like } from "../../src/connection/bot.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig } from "../../src/core/config.js";

interface McDef {
  id: number;
  defaultState?: number;
  hardness?: number | null;
  stackSize?: number;
}
interface McData {
  blocksByName: Record<string, McDef | undefined>;
  itemsByName: Record<string, McDef | undefined>;
  items: Record<number, { name: string } | undefined>;
}
const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => McData)("26.2");
const OWNER = "ElixOwner";
const WALK_MS = 1_000;
const DIG_MS = 1_500;
const REACH = 5;

const key = (p: Vec3Like) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function player(name: string, x: number) {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: { username: name, type: "player", name: "player", position: new Vec3(x, 64, 0), isValid: true, height: 1.8 },
  };
}

function item(name: string, count: number, slot: number) {
  const def = data.itemsByName[name]!;
  return { name, type: def.id, count, slot, metadata: 0, stackSize: def.stackSize ?? 64 };
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

/** A bot whose actions take real time, and whose pathfinder behaves like mineflayer-pathfinder. */
class SlowBot extends EventEmitter implements BotLike {
  username = "Elix";
  version = "26.2";
  registry = data;
  health = 20;
  food = 20;
  oxygenLevel = 20;
  entity: { position: Vec3; yaw: number; pitch: number; isInWater: boolean; onGround: boolean; height: number } = {
    position: new Vec3(0, 64, 0),
    yaw: 0,
    pitch: 0,
    isInWater: false,
    onGround: true,
    height: 1.8,
  };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  players: Record<string, unknown> = {};
  entities: Record<string, unknown> = {};
  chatCalls: string[] = [];
  heldItem: unknown = null;
  /** Blocks that differ from the default terrain. "air" removes a block. */
  world = new Map<string, string>();
  stacks: ReturnType<typeof item>[] = [];
  inventory = { slots: [] as unknown[], items: () => this.stacks };

  // --- measurements -------------------------------------------------------------------
  completedDigs: string[] = [];
  abortedDigs = 0;
  outOfReachDigs = 0;
  goalResets = 0;
  tossCalls = 0;
  tossedTotal = 0;
  openCalls = 0;
  depositCalls = 0;
  withdrawCalls = 0;
  placeDoneAt: number | null = null;
  craftCalls: Array<{ withTable: boolean; tableExisted: boolean }> = [];

  // --- the pathfinder ------------------------------------------------------------------
  private walk: ReturnType<typeof setTimeout> | null = null;
  private currentGoal: unknown = null;
  pathfinder = {
    setGoal: (goal: unknown) => {
      if (this.walk !== null) {
        clearTimeout(this.walk);
        this.goalResets += 1; // mineflayer-pathfinder: resetPath + clearControlStates
      }
      this.walk = null;
      this.currentGoal = goal;
      if (goal === null || goal === undefined) return;
      const g = goal as { x?: number; y?: number; z?: number; entity?: { position: Vec3 } };
      const target =
        typeof g.x === "number" && typeof g.y === "number" && typeof g.z === "number"
          ? new Vec3(g.x, g.y, g.z)
          : g.entity?.position;
      if (target === undefined) return;
      this.walk = setTimeout(() => {
        this.walk = null;
        this.entity.position = new Vec3(Math.floor(target.x) - 1, 64, Math.floor(target.z));
        this.emit("goal_reached", goal);
      }, WALK_MS);
    },
    stop: () => {
      if (this.walk !== null) clearTimeout(this.walk);
      this.walk = null;
      this.currentGoal = null;
    },
    isMoving: () => this.walk !== null,
    setMovements: () => {},
    goto: async () => {},
    get goal() {
      return null;
    },
  };

  // --- the world -----------------------------------------------------------------------
  private block(name: string, pos: Vec3) {
    const def = data.blocksByName[name]!;
    return { name, id: def.id, type: def.id, stateId: def.defaultState, position: pos, boundingBox: name === "air" ? "empty" : "block", diggable: name !== "air", hardness: def.hardness };
  }
  blockAt(p: Vec3Like) {
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const override = this.world.get(key(pos));
    if (override !== undefined) return this.block(override, pos);
    if (pos.y === 63) return this.block("grass_block", pos);
    if (pos.y < 63) return this.block("stone", pos);
    return this.block("air", pos);
  }
  findBlocks(opts: { matching: unknown; maxDistance?: number; count?: number; point?: Vec3 }): Vec3[] {
    const out: Vec3[] = [];
    const m = opts.matching;
    const matches = (b: ReturnType<SlowBot["blockAt"]>) =>
      typeof m === "function" ? (m as (b: unknown) => boolean)(b) : Array.isArray(m) ? m.includes(b.type) : m === b.type;
    for (let x = -14; x <= 14; x++)
      for (let y = 62; y <= 65; y++)
        for (let z = -4; z <= 4; z++) {
          const b = this.blockAt(new Vec3(x, y, z));
          if (b.name !== "air" && b.name !== "grass_block" && b.name !== "stone" && matches(b)) out.push(b.position);
        }
    const from = this.entity.position;
    out.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));
    return out.slice(0, opts.count ?? 1);
  }
  findBlock(opts: { matching: unknown; maxDistance?: number }) {
    const p = this.findBlocks({ ...opts, count: 1 })[0];
    return p ? this.blockAt(p) : null;
  }

  // --- actions that take time ------------------------------------------------------------
  private digTimer: ReturnType<typeof setTimeout> | null = null;
  private digReject: ((e: Error) => void) | null = null;
  dig(b: { position: Vec3 } | null): Promise<void> {
    if (b === null || b === undefined) return Promise.reject(new Error("dig was called with an undefined or null block"));
    // mineflayer digging.js: a new dig while digging calls stopDigging() on the old one.
    if (this.digTimer !== null) this.stopDigging();
    const eye = this.entity.position.offset(0, 1.62, 0);
    if (eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > REACH) this.outOfReachDigs += 1;
    return new Promise<void>((resolve, reject) => {
      this.digReject = reject;
      this.digTimer = setTimeout(() => {
        this.digTimer = null;
        this.digReject = null;
        this.world.set(key(b.position), "air");
        this.completedDigs.push(key(b.position));
        resolve();
      }, DIG_MS);
    });
  }
  stopDigging(): void {
    if (this.digTimer === null) return;
    clearTimeout(this.digTimer);
    this.digTimer = null;
    this.abortedDigs += 1;
    const reject = this.digReject;
    this.digReject = null;
    reject?.(new Error("Digging aborted"));
  }
  async equip(i: unknown): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    this.heldItem = i;
  }
  async toss(itemType: number, _meta: number | null, count: number | null): Promise<void> {
    this.tossCalls += 1;
    await new Promise((r) => setTimeout(r, 300));
    const stack = this.stacks.find((s) => s.type === itemType);
    if (!stack) throw new Error("not in inventory");
    const n = Math.min(count ?? stack.count, stack.count);
    stack.count -= n;
    this.tossedTotal += n;
    this.stacks = this.stacks.filter((s) => s.count > 0);
  }
  async openContainer(b: unknown) {
    // mineflayer: "The block instance to open". bot.findBlocks returns COORDINATES, not
    // blocks (docs/api.md), so a Vec3 here is the classic mistake.
    const blockLike = b as { name?: unknown; position?: unknown } | null;
    if (blockLike === null || typeof blockLike.name !== "string" || typeof blockLike.position !== "object") {
      throw new Error("openContainer needs a Block, got " + JSON.stringify(b));
    }
    this.openCalls += 1;
    await new Promise((r) => setTimeout(r, 300));
    return {
      deposit: async (itemType: number) => {
        this.depositCalls += 1;
        await new Promise((r) => setTimeout(r, 100));
        this.stacks = this.stacks.filter((s) => s.type !== itemType);
      },
      withdraw: async () => {
        this.withdrawCalls += 1;
      },
      close: () => {},
    };
  }
  async placeBlock(ref: { position: Vec3 }, face: Vec3Like): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
    const held = this.heldItem as { name?: string } | null;
    if (held?.name !== "crafting_table") throw new Error("No block has been placed");
    this.world.set(key(ref.position.offset(face.x, face.y, face.z)), "crafting_table");
    this.placeDoneAt = Date.now();
  }
  recipesFor(itemType: number, _meta: unknown, _min: unknown, table: unknown) {
    const name = data.items[itemType]?.name ?? "";
    const needsTable = !["oak_planks", "stick", "crafting_table"].includes(name);
    if (needsTable && (table === null || table === undefined)) return [];
    return [{ result: { id: itemType, count: 1 }, requiresTable: needsTable }];
  }
  async craft(recipe: { result: { id: number }; requiresTable: boolean }, count: number, table: unknown): Promise<void> {
    const tableBlock = table as { position?: Vec3 } | null;
    const tableExisted = tableBlock?.position !== undefined && this.world.get(key(tableBlock.position)) === "crafting_table";
    this.craftCalls.push({ withTable: table !== null && table !== undefined, tableExisted });
    await new Promise((r) => setTimeout(r, 300));
    if (recipe.requiresTable && !tableExisted) throw new Error("Recipe requires craftingTable, but one was not supplied");
    const name = data.items[recipe.result.id]?.name ?? "unknown";
    this.stacks.push(item(name, count, 40 + this.stacks.length));
  }

  // --- the rest ---------------------------------------------------------------------------
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
    return DIG_MS;
  }
  loadPlugin(): void {}
}

async function started(ownerX: number, setup: (b: SlowBot) => void) {
  const bots: SlowBot[] = [];
  const bridge = {
    handle: vi.fn(async () => ({ replied: false, reason: "not-addressed" })),
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
      const b = new SlowBot();
      b.players = { Elix: player("Elix", 0), [OWNER]: player(OWNER, ownerX) };
      let id = 1;
      for (const p of Object.values(b.players)) {
        const e = (p as { entity: { id?: number } }).entity;
        e.id = id;
        b.entities[String(id)] = e;
        id += 1;
      }
      setup(b);
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
  return { s, bot: bots[0]! };
}

async function owner(h: { bot: SlowBot }, line: string, wait: number) {
  h.bot.emit("chat", OWNER, line);
  await vi.advanceTimersByTimeAsync(wait);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Round 19 probes — skills at real speed", () => {
  it("fixtures", () => {
    expect(data.blocksByName["dirt"]).toBeDefined();
    expect(data.itemsByName["wooden_pickaxe"]).toBeDefined();
  });

  it("Z1: 'elix get 2 dirt' walks there first, never digs out of reach, never aborts its own dig, and gets 2", async () => {
    const h = await started(-30, (b) => {
      for (const x of [8, 9, 10]) b.world.set(`${x},63,0`, "dirt");
    });
    await owner(h, "elix get 2 dirt", 30_000);
    expect(h.bot.outOfReachDigs, "dug before arriving").toBe(0);
    expect(h.bot.abortedDigs, "a new dig aborted the one in progress").toBe(0);
    expect(h.bot.completedDigs.length, "dirt actually dug").toBeGreaterThanOrEqual(2);
  });

  it("Z2: 'elix give me 2 cobblestone' from 12 blocks away: Elix gets there and tosses exactly 2", async () => {
    const h = await started(12, (b) => {
      b.stacks = [item("cobblestone", 5, 36)];
    });
    await owner(h, "elix give me 2 cobblestone", 20_000);
    expect(h.bot.goalResets, "the walk goal was reset over and over").toBeLessThanOrEqual(3);
    expect(h.bot.tossedTotal).toBe(2);
  });

  it("Z3: 'elix give me 2 cobblestone' from 2 blocks away tosses exactly once", async () => {
    const h = await started(2, (b) => {
      b.stacks = [item("cobblestone", 5, 36)];
    });
    await owner(h, "elix give me 2 cobblestone", 10_000);
    expect(h.bot.tossCalls).toBe(1);
    expect(h.bot.tossedTotal).toBe(2);
  });

  it("Z4: 'elix put your stuff in the chest' opens the chest once and never withdraws", async () => {
    const h = await started(-10, (b) => {
      b.world.set("0,64,2", "chest");
      b.stacks = [item("dirt", 10, 36), item("cobblestone", 5, 37)];
    });
    await owner(h, "elix put your stuff in the chest", 10_000);
    expect(h.bot.openCalls).toBe(1);
    expect(h.bot.withdrawCalls).toBe(0);
    expect(h.bot.depositCalls).toBe(2);
  });

  it("Z5: 'elix make a wooden pickaxe' places the table BEFORE crafting with it, and crafts", async () => {
    const h = await started(-10, (b) => {
      b.stacks = [item("oak_planks", 3, 36), item("stick", 2, 37), item("crafting_table", 1, 38)];
    });
    await owner(h, "elix make a wooden pickaxe", 15_000);
    const withTable = h.bot.craftCalls.filter((c) => c.withTable);
    expect(withTable.length, "never crafted with a table").toBeGreaterThan(0);
    for (const c of withTable) expect(c.tableExisted, "crafted with a table that was not placed yet").toBe(true);
    expect(h.bot.stacks.some((s) => s.name === "wooden_pickaxe")).toBe(true);
  });
});
