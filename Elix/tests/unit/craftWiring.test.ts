/**
 * R18-D acceptance — craft, from a chat line to a real `bot.craft`.
 *
 * The first block of tests is the one that matters most: it reads the INSTALLED mineflayer and
 * asserts the signatures this runtime depends on. Everything below it is a BotSession test that
 * drives "elix craft 4 sticks" to a real `bot.craft(recipe, count, table)` call.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps } from "../../src/connection/bot.js";
import { TOP_FACE, TABLE_ITEM } from "../../src/skills/craftRuntime.js";
import { itemIdOf } from "../../src/world/itemIds.js";
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
  return {
    name,
    id: def.id,
    type: def.id,
    stateId: def.defaultState,
    position: pos,
    boundingBox: "block",
    diggable: true,
  };
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

/**
 * A world with a valid table spot: grass under Elix, air above and beside.
 *
 * `placedTables` records where a table was placed, so `blockAt` starts answering with a real
 * `crafting_table` Block — which is what `bot.craft` must be handed, not coordinates.
 */
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
  /** Every (referenceBlock, faceVector) pair handed to bot.placeBlock. */
  placed: Array<{ support: unknown; face: unknown }> = [];
  /** Every recipe-finder call, in the real argument order. */
  recipeLookups: unknown[][] = [];
  /** Every bot.craft call, in the real argument order. */
  crafted: unknown[][] = [];
  /** What bot.recipesFor answers. Empty by default, so "no materials" is the default. */
  recipes: unknown[] = [];
  placedTables: Vec3[] = [];
  dug: unknown[] = [];
  stopDiggingCalls = 0;
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
    for (const table of this.placedTables) {
      if (table.equals(pos)) return block("crafting_table", pos);
    }
    if (pos.y === 63) return block("grass_block", pos);
    if (pos.y < 63) return block("stone", pos);
    return block("air", pos);
  }
  findBlocks(): unknown[] {
    return [];
  }
  findBlock(): unknown {
    return null;
  }
  async dig(b: unknown): Promise<void> {
    this.dug.push(b);
  }
  stopDigging(): void {
    this.stopDiggingCalls += 1;
  }
  async equip(target: unknown, destination: string): Promise<void> {
    if (destination === "hand") this.heldItem = target;
  }
  /** mineflayer's REAL signature: the item is the HELD one, and the face is a vector. */
  async placeBlock(referenceBlock: unknown, faceVector: unknown): Promise<void> {
    this.placed.push({ support: referenceBlock, face: faceVector });
    const support = referenceBlock as { position: Vec3 };
    const face = faceVector as { x: number; y: number; z: number };
    this.placedTables.push(support.position.plus(new Vec3(face.x, face.y, face.z)));
  }
  /** mineflayer's recipesFor is SYNCHRONOUS and returns an array. */
  recipesFor(...args: unknown[]): unknown[] {
    this.recipeLookups.push(args);
    return this.recipes;
  }
  async craft(...args: unknown[]): Promise<void> {
    this.crafted.push(args);
  }
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

/**
 * The real-library contract, read out of the INSTALLED mineflayer.
 *
 * Every assumption in `craftRuntime.ts` is a guess until this passes. A fake that accepted a
 * different argument order would let a runtime that crashes the real plugin ship green.
 */
describe("R18-D — the installed mineflayer really has the signatures craftRuntime uses", () => {
  const root = createRequire(import.meta.url).resolve("mineflayer/package.json").replace(/package\.json$/u, "");
  const read = (rel: string): string => readFileSync(root + rel, "utf8");

  it("placeBlock takes (referenceBlock, faceVector) - NOT an item", () => {
    const source = read("lib/plugins/place_block.js");
    expect(source, "mineflayer changed bot.placeBlock").toMatch(/async function placeBlock \(referenceBlock, faceVector\)/u);
  });

  it("the placed item is the HELD item, so equip must come first", () => {
    expect(read("lib/plugins/generic_place.js")).toMatch(/bot\.heldItem/u);
  });

  it("recipesFor takes (itemType, metadata, minResultCount, craftingTable)", () => {
    expect(read("lib/plugins/craft.js")).toMatch(
      /function recipesFor \(itemType, metadata, minResultCount, craftingTable\)/u,
    );
  });

  it("recipesFor is SYNCHRONOUS and returns an array", () => {
    const source = read("lib/plugins/craft.js");
    const body = source.slice(source.indexOf("function recipesFor ("));
    // No `async`, and it ends in `return results` rather than a promise.
    expect(body.slice(0, 400)).not.toMatch(/async/u);
    expect(body.slice(0, 900)).toMatch(/return results/u);
  });

  it("craft takes (recipe, count, craftingTable) and THROWS without a needed table", () => {
    const source = read("lib/plugins/craft.js");
    expect(source).toMatch(/async function craft \(recipe, count, craftingTable\)/u);
    expect(source).toMatch(/Recipe requires craftingTable, but one was not supplied/u);
  });

  it("a stale item id would silently break this, so ids come from the vendored data", () => {
    expect(itemIdOf("stick")).toBe(data.itemsByName["stick"]!.id);
    expect(itemIdOf("no_such_item_ever")).toBeNull();
  });
});

describe("R18-D — an owner's craft line reaches bot.craft", () => {
  it("crafts sticks with the real argument order, and never reaches the chat model", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    const recipe = { result: "stick", count: 4, requiresTable: false };
    h.bots[0]!.inventory.stacks = [item("oak_planks", 8, 36)];
    h.bots[0]!.recipes = [recipe];
    await say(h, OWNER, "elix craft 4 sticks");
    expect(h.handled, "the line went to the chat model").not.toContain("elix craft 4 sticks");
    const b = h.bots[0]!;
    expect(b.crafted.length, "no bot.craft call at all").toBeGreaterThan(0);
    // (recipe, count, craftingTable) - the recipe is mineflayer's own object, and sticks need
    // no table, so the third argument is null.
    expect(b.crafted[0]).toEqual([recipe, 4, null]);
    expect(b.recipeLookups[0], "recipesFor got the wrong arguments").toEqual([
      data.itemsByName["stick"]!.id,
      null,
      4,
      null,
    ]);
  });

  it("makes a crafting table IN THE INVENTORY - a 2x2 recipe needs no table", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.inventory.stacks = [item("oak_planks", 8, 36)];
    const recipe = { result: "crafting_table", count: 1, requiresTable: false };
    h.bots[0]!.recipes = [recipe];
    await say(h, OWNER, "elix make a crafting table");
    const b = h.bots[0]!;
    expect(b.crafted.length, "never crafted the table").toBeGreaterThan(0);
    // Verified against the vendored 26.2 data: recipes[crafting_table] is a 2x2 grid, which
    // is the inventory grid. Round 17 had it needing a table, which made this exact line
    // impossible - you cannot place a table you cannot craft.
    expect(b.crafted[0]).toEqual([recipe, 1, null]);
    expect(b.placed, "put furniture on the ground to make furniture").toEqual([]);
  });

  it("hands bot.craft the placed TABLE BLOCK, never coordinates and never the item", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 8, 36), item(TABLE_ITEM, 1, 37)];
    const recipe = { result: "stone_pickaxe", count: 1, requiresTable: true };
    h.bots[0]!.recipes = [recipe];
    await say(h, OWNER, "elix make a wooden pickaxe");
    const b = h.bots[0]!;
    expect(b.crafted.length, "no craft at all").toBeGreaterThan(0);
    const table = b.crafted[0]![2] as { name?: string } | null;
    expect(table, "bot.craft was not given the placed table Block").toMatchObject({ name: "crafting_table" });
    // And the recipe lookup was told about the table too, or requirementsMet would be wrong.
    expect(b.recipeLookups[0]![3]).toMatchObject({ name: "crafting_table" });
    // It was placed against a reference block and a face - the REAL signature, which takes
    // the item from the held slot rather than an argument.
    expect(b.placed.length, "never called bot.placeBlock").toBeGreaterThan(0);
    expect(b.placed[0]!.support).toMatchObject({ name: "grass_block" });
    expect(b.placed[0]!.face).toEqual(TOP_FACE);
    // And Elix does not leave furniture behind: the table goes back in the inventory.
    expect(b.dug.length, "left the crafting table on the ground").toBeGreaterThan(0);
    expect((b.dug[0] as { name?: string }).name).toBe("crafting_table");
  });
});

describe("R18-D — refusals, owners, and stop", () => {
  it("missing materials get ONE honest line and no craft", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.recipes = []; // nothing in the inventory matches any recipe
    await say(h, OWNER, "elix craft 4 sticks");
    const b = h.bots[0]!;
    expect(b.crafted, "crafted something with no recipe").toEqual([]);
    expect(b.chatCalls.join(" ")).toMatch(/ingredients/iu);
  });

  it("no crafting table to place is a refusal, not silence", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.inventory.stacks = [item("cobblestone", 8, 36)]; // no table in the inventory
    h.bots[0]!.recipes = [{ result: "stone_pickaxe", count: 1, requiresTable: true }];
    await say(h, OWNER, "elix make a wooden pickaxe");
    const b = h.bots[0]!;
    expect(b.placed, "placed a table he does not have").toEqual([]);
    expect(b.chatCalls.join(" ")).not.toBe("");
  });

  it("a STRANGER gets the refusal and nothing is crafted", async () => {
    const h = await started({ [STRANGER]: mineflayerPlayer(STRANGER, 4), [OWNER]: mineflayerPlayer(OWNER, 9) });
    h.bots[0]!.recipes = [{ result: "stick", count: 4, requiresTable: false }];
    await say(h, STRANGER, "elix craft 4 sticks");
    expect(h.bots[0]!.crafted).toEqual([]);
    expect(h.bots[0]!.chatCalls.join(" ")).toMatch(/can't do that/iu);
  });

  it("an unaddressed line is not a craft", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.recipes = [{ result: "stick", count: 4, requiresTable: false }];
    await say(h, OWNER, "everyone craft 4 sticks");
    expect(h.bots[0]!.crafted).toEqual([]);
  });

  it("a wellbeing-floor line triggers nothing, even when it reads like a command", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.recipes = [{ result: "stick", count: 4, requiresTable: false }];
    await say(h, OWNER, "elix craft 4 sticks i feel awful about my cat");
    expect(h.bots[0]!.crafted).toEqual([]);
  });

  it("elix stop ends a craft run", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.recipes = [{ result: "stick", count: 4, requiresTable: false }];
    h.bots[0]!.emit("chat", OWNER, "elix craft 4 sticks");
    await vi.advanceTimersByTimeAsync(50);
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bots[0]!.crafted.length, "kept crafting after stop").toBe(1);
  });

  it("progress and refusal lines go through gateOwnLine, never gateScriptedReply", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    h.bots[0]!.recipes = [{ result: "stick", count: 4, requiresTable: false }];
    await say(h, OWNER, "elix craft 4 sticks");
    expect(h.bridge.gateOwnLine, "a craft line went through the wrong gate").toHaveBeenCalled();
    expect(h.bridge.gateScriptedReply, "Elix's own words were filed as the player's").not.toHaveBeenCalled();
  });
});
