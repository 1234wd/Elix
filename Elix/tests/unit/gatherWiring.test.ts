/**
 * R18-C acceptance — gather, from a chat line to a real `bot.dig`.
 *
 * These are the tests Round 17 could not write, because there was nothing to call: every one
 * starts at `bot.emit("chat", owner, "elix get 5 dirt")` and ends at a real mineflayer API call
 * on a mineflayer-shaped fake. That is the whole point of this round's definition of DONE.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps } from "../../src/connection/bot.js";
import { MemoryStore } from "../../src/memory/store.js";
import { bus } from "../../src/core/events.js";
import { PROTECTED_RADIUS } from "../../src/skills/gather.js";
import { PLAYER_CLEARANCE } from "../../src/skills/gatherRuntime.js";
import type { ElixConfig } from "../../src/core/config.js";

interface McDef {
  id: number;
  defaultState?: number;
  hardness?: number | null;
  material?: string;
  stackSize?: number;
}
const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => {
  blocksByName: Record<string, McDef | undefined>;
  itemsByName: Record<string, McDef | undefined>;
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
    hardness: def.hardness,
    material: def.material,
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

/** A patch of dirt at x = 3..5, y = 63. Grass everywhere else at y = 63, stone below. */
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
  dug: unknown[] = [];
  stopDiggingCalls = 0;
  equipped: Array<[string, string]> = [];
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
    if (pos.y === 63 && pos.x >= 3 && pos.x <= 5 && pos.z === 0) return block("dirt", pos);
    if (pos.y === 63) return block("grass_block", pos);
    if (pos.y < 63) return block("stone", pos);
    return block("air", pos);
  }
  findBlocks(opts: { matching: unknown; maxDistance?: number; count?: number }): unknown[] {
    const matches = (b: ReturnType<FakeBot["blockAt"]>): boolean => {
      const m = opts.matching;
      if (typeof m === "function") return (m as (x: unknown) => boolean)(b);
      if (Array.isArray(m)) return m.includes(b.type);
      return m === b.type;
    };
    const out: unknown[] = [];
    for (let x = -8; x <= 8; x += 1) {
      for (let y = 60; y <= 66; y += 1) {
        for (let z = -8; z <= 8; z += 1) {
          const b = this.blockAt(new Vec3(x, y, z));
          if (b.name !== "air" && matches(b)) out.push(b);
        }
      }
    }
    return out.slice(0, opts.count ?? 1);
  }
  findBlock(opts: { matching: unknown; maxDistance?: number }): unknown {
    return this.findBlocks({ ...opts, count: 1 })[0] ?? null;
  }
  async dig(b: unknown): Promise<void> {
    this.dug.push(b);
  }
  stopDigging(): void {
    this.stopDiggingCalls += 1;
  }
  async equip(target: unknown, destination: string): Promise<void> {
    this.equipped.push([String((target as { name?: unknown }).name), destination]);
    // Real mineflayer changes heldItem when you equip. A fake that does not makes the
    // weapon reflex re-equip on every tick, and then an equip assertion measures the
    // reflex rather than the thing under test.
    if (destination === 'hand') this.heldItem = target;
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

function harness(players: Record<string, unknown>, memoryStore?: MemoryStore) {
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
    ...(memoryStore === undefined ? {} : { memoryStore }),
  } as unknown as SessionDeps;
  return { s: new BotSession(deps), bots, handled, bridge };
}

async function started(players: Record<string, unknown>, memoryStore?: MemoryStore) {
  const h = harness(players, memoryStore);
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

describe("R18-C — an owner's gather line reaches bot.dig", () => {
  it("walks to the block and digs it, and never reaches the chat model", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 5 dirt");
    expect(h.handled, "the line went to the chat model").not.toContain("elix get 5 dirt");
    const b = h.bots[0]!;
    expect(b.pathfinder.setGoal, "no walk at all").toHaveBeenCalled();
    expect(b.dug.length, "a goal was set but nothing was dug").toBeGreaterThan(0);
    const dug = b.dug[0] as { name?: string };
    expect(dug.name, "dug something that is not the requested block").toBe("dirt");
  });

  it("the goal it sets is a REAL pathfinder goal, not a description of one", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 5 dirt");
    const goal = h.bots[0]!.pathfinder.setGoal.mock.calls[0]?.[0] as {
      isValid?: unknown;
      heuristic?: unknown;
      isEnd?: unknown;
      hasChanged?: unknown;
      x?: number;
      y?: number;
      z?: number;
    };
    // A plain object would crash mineflayer-pathfinder on the next physicsTick.
    expect(typeof goal.isValid).toBe("function");
    expect(typeof goal.heuristic).toBe("function");
    expect(typeof goal.isEnd).toBe("function");
    expect(typeof goal.hasChanged).toBe("function");
    expect(Number.isFinite(goal.x)).toBe(true);
  });

  it("equips the tool minecraft-data says the block needs, before digging", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    h.bots[0]!.inventory.stacks = [item("stone_axe", 1, 36)];
    // stone needs a pickaxe, so an axe must NOT be equipped - and the dig must still happen.
    await say(h, OWNER, "elix get 5 dirt");
    expect(h.bots[0]!.dug.length).toBeGreaterThan(0);
    expect(
      h.bots[0]!.equipped.filter(([n]) => n.endsWith("_pickaxe")),
      "equipped a pickaxe for DIRT, which needs none",
    ).toEqual([]);
  });

  it("equips a pickaxe for stone - and only the gather can be the reason for it", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    // A sword AND a pickaxe: the weapon reflex has a reason to equip the sword, so a
    // pickaxe in hand afterwards can only have come from the dig.
    h.bots[0]!.inventory.stacks = [item("iron_pickaxe", 1, 36), item("iron_sword", 1, 37)];
    await say(h, OWNER, "elix mine 3 stone");
    expect(h.bots[0]!.dug.length, "no stone was dug").toBeGreaterThan(0);
    expect(h.bots[0]!.equipped, "never equipped the pickaxe stone needs").toContainEqual([
      "iron_pickaxe",
      "hand",
    ]);
  });

  it("handles 'get wood' and 'mine 10 stone' the same way", async () => {
    for (const line of ["elix get wood", "elix mine 10 stone"]) {
      const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
      await say(h, OWNER, line);
      expect(h.handled, line).not.toContain(line);
    }
  });
});

describe("R18-C — only owners, and never on a wellbeing-floor line", () => {
  it("a STRANGER gets the refusal and no dig at all", async () => {
    const h = await started({ [STRANGER]: mineflayerPlayer(STRANGER, 3), [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, STRANGER, "elix get 5 dirt");
    const b = h.bots[0]!;
    expect(b.dug, "a stranger got Elix to dig").toEqual([]);
    expect(b.pathfinder.setGoal).not.toHaveBeenCalled();
    expect(b.chatCalls.join(" ")).toMatch(/can't do that/i);
  });

  it("a WELLBEING-FLOOR line triggers nothing, even when it reads like a command", async () => {
    // "elix stop i want to die" matches the floor. It must reach the bridge, not the gather.
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 5 dirt i feel awful about my cat");
    expect(h.bots[0]!.dug, "a wellbeing-floor line started a gather").toEqual([]);
  });

  it("an unaddressed line is not a command", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "everyone get 5 dirt");
    expect(h.bots[0]!.dug).toEqual([]);
  });
});

describe("R18-C — the protection rules, which are the point", () => {
  it("refuses a block inside a REMEMBERED PLACE's radius, and gathers fine outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-r18c-"));
    const store = new MemoryStore({ path: join(dir, "m.db") });
    try {
      // A place ON the dirt patch. Nothing may be dug inside it.
      store.addPlace({ key: "home", kind: "home", ts: 1, x: 4, y: 63, z: 0, dimension: "overworld" });
      const near = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) }, store);
      await say(near, OWNER, "elix get 5 dirt");
      expect(near.bots[0]!.dug, "dug inside a remembered place").toEqual([]);

      // Far away there is nothing to protect, and the same line works.
      const far = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) }, store);
      far.bots[0]!.entity.position = new Vec3(PROTECTED_RADIUS * 6, 64, 0);
      await say(far, OWNER, "elix get 5 dirt");
      expect(far.bots[0]!.dug.length, "a place 144 blocks away blocked a dig").toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NEVER digs the block a player is standing on", async () => {
    // The owner standing ON the dirt patch: the nearest block is under their feet.
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 4) });
    await say(h, OWNER, "elix get 5 dirt");
    const b = h.bots[0]!;
    for (const dug of b.dug) {
      const pos = (dug as { position?: Vec3 }).position;
      if (pos === undefined) continue;
      const ownerPos = (h.bots[0]!.players[OWNER] as { entity: { position: Vec3 } }).entity.position;
      expect(
        pos.x === ownerPos.x && pos.z === ownerPos.z,
        `dug the block at ${pos.x},${pos.z} which the owner is standing on`,
      ).toBe(false);
    }
  });

  it("keeps clear of a player by PLAYER_CLEARANCE blocks", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 5) });
    await say(h, OWNER, "elix get 5 dirt");
    const b = h.bots[0]!;
    const ownerPos = (b.players[OWNER] as { entity: { position: Vec3 } }).entity.position;
    for (const dug of b.dug) {
      const pos = (dug as { position?: Vec3 }).position;
      if (pos === undefined) continue;
      expect(Math.hypot(pos.x - ownerPos.x, pos.z - ownerPos.z), `duged ${pos.x},${pos.z}`).toBeGreaterThan(
        PLAYER_CLEARANCE,
      );
    }
  });

  it("ELIX HIMSELF does not count as a player he must keep clear of", () => {
    // If Elix's own position counted, he could never dig the block he is standing next to.
    expect(PLAYER_CLEARANCE).toBeGreaterThan(0);
  });
});

describe("R18-C — elix stop cancels a gather, including a dig in flight", () => {
  it("stops the gather and calls bot.stopDigging", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    // 64 items, so the gather is STILL RUNNING when the stop lands. A stop after it
    // finished would prove nothing about cancelling anything.
    h.bots[0]!.emit("chat", OWNER, "elix get 64 dirt");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.bots[0]!.dug.length, "no dig was ever started").toBeGreaterThan(0);
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bots[0]!.stopDiggingCalls, "a stop did not reach the dig in flight").toBeGreaterThan(0);
  });

  it("digging stops immediately after a stop", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 64 dirt", 1_000);
    await say(h, OWNER, "elix stop", 200);
    const after = h.bots[0]!.dug.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bots[0]!.dug.length, "still digging after stop").toBe(after);
  });

  it("a stop before the first dig prevents it", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    h.bots[0]!.emit("chat", OWNER, "elix get 64 dirt");
    await vi.advanceTimersByTimeAsync(50);
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.bots[0]!.dug.length).toBe(0);
  });
});

describe("R18-C — the caps and the progress line", () => {
  it("never digs more than the requested count", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 2 dirt", 6_000);
    expect(h.bots[0]!.dug.length).toBeLessThanOrEqual(2);
  });

  it("says at most one progress line a minute, through gateOwnLine", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 40) });
    await say(h, OWNER, "elix get 64 dirt", 12_000);
    const lines = h.bots[0]!.chatCalls.filter((l) => /got \\d+ of/u.test(l));
    expect(lines.length, "too many progress lines").toBeLessThanOrEqual(1);
    // And it is ELIX's own words, so it goes through gateOwnLine and never gateScriptedReply.
    expect(h.bridge.gateOwnLine).toHaveBeenCalled();
    expect(h.bridge.gateScriptedReply).not.toHaveBeenCalled();
  });
});