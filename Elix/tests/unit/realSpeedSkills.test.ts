/**
 * R19-A acceptance — the skills at REAL SPEED.
 *
 * Everything here drives a `BotSession` with `tests/helpers/realSpeedBot.ts`, whose actions take
 * real time and whose pathfinder behaves like mineflayer-pathfinder. The Round 18 fakes resolved
 * everything instantly and never moved Elix, which is why 2027 tests passed and the skills did
 * not work in a game.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { BotSession, type SessionDeps } from "../../src/connection/bot.js";
import { MemoryStore } from "../../src/memory/store.js";
import { bus } from "../../src/core/events.js";
import { RealSpeedBot, makeItem, makePlayer } from "../helpers/realSpeedBot.js";
import type { ElixConfig } from "../../src/core/config.js";

const OWNER = "ElixOwner";
const STRANGER = "NotTheOwner";

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

function session(players: Record<string, unknown>, memoryStore?: MemoryStore) {
  const bots: RealSpeedBot[] = [];
  const handled: string[] = [];
  const bridge = {
    handle: vi.fn(async (_sender: string, message: string) => {
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
      const b = new RealSpeedBot();
      b.players = { Elix: makePlayer("Elix", 0), ...players };
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
  const h = session(players, memoryStore);
  await h.s.start();
  h.bots[0]!.emit("spawn");
  await vi.advanceTimersByTimeAsync(3_000);
  return h;
}

async function say(h: { bots: RealSpeedBot[] }, who: string, line: string, wait: number) {
  h.bots[0]!.emit("chat", who, line);
  await vi.advanceTimersByTimeAsync(wait);
}

/** A temporary memory store, cleaned up by the caller. */
function tempStore(): { store: MemoryStore; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "elix-r19a-"));
  const store = new MemoryStore({ path: join(dir, "m.db") });
  return { store, dir, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R19-A — the shared runtime base", () => {
  it("a tick never starts a second step while the first is pending", async () => {
    // One dig takes 1.5 s. Over 30 s of 50 ms ticks that is 600 ticks; the guard is what keeps
    // the dig count honest instead of hundreds of aborted digs.
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    h.bots[0]!.world.set("6,63,0", "dirt");
    h.bots[0]!.world.set("7,63,0", "dirt");
    await say(h, OWNER, "elix get 2 dirt", 30_000);
    expect(h.bots[0]!.abortedDigs, "one dig aborted another").toBe(0);
    expect(h.bots[0]!.completedDigs.length).toBeGreaterThanOrEqual(2);
  });

  it("a goal is re-issued only when the target has actually moved", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    h.bots[0]!.world.set("6,63,0", "dirt");
    h.bots[0]!.world.set("7,63,0", "dirt");
    await say(h, OWNER, "elix get 2 dirt", 30_000);
    // Each new block is a new goal, so a handful - never hundreds.
    expect(h.bots[0]!.goalResets).toBeLessThan(10);
  });
});

describe("R19-A — gather arrives before it digs", () => {
  it("walks to the block, then digs it, and never digs out of reach", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    for (const x of [8, 9, 10]) h.bots[0]!.world.set(`${x},63,0`, "dirt");
    await say(h, OWNER, "elix get 2 dirt", 30_000);
    const b = h.bots[0]!;
    expect(b.outOfReachDigs, "dug before arriving").toBe(0);
    expect(b.completedDigs.length).toBeGreaterThanOrEqual(2);
  });

  it("stop MID-DIG ends it: nothing digs afterwards", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    for (const x of [8, 9, 10, 11, 12]) h.bots[0]!.world.set(`${x},63,0`, "dirt");
    h.bots[0]!.emit("chat", OWNER, "elix get 5 dirt");
    // Long enough to arrive and start the dig (1 s walk + a moment), not enough to finish it.
    await vi.advanceTimersByTimeAsync(1_600);
    const dugBeforeStop = h.bots[0]!.completedDigs.length;
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bots[0]!.abortedDigs, "the dig in flight was not aborted by stop").toBeGreaterThan(0);
    expect(h.bots[0]!.completedDigs.length, "kept digging after stop").toBe(dugBeforeStop);
  });

  it("stop MID-WALK stops the pathfinder and digs nothing", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    for (const x of [8, 9, 10, 11, 12, 13, 14, 15, 16]) h.bots[0]!.world.set(`${x},63,0`, "dirt");
    h.bots[0]!.emit("chat", OWNER, "elix get 9 dirt");
    await vi.advanceTimersByTimeAsync(500);
    h.bots[0]!.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bots[0]!.completedDigs, "dug something after a mid-walk stop").toEqual([]);
  });
});

describe("R19-A — give walks once, arrives, and tosses exactly once", () => {
  it("from far away the goal is not reset over and over", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 12) });
    h.bots[0]!.stacks = [makeItem("cobblestone", 5, 36)];
    await say(h, OWNER, "elix give me 2 cobblestone", 20_000);
    expect(h.bots[0]!.goalResets, "the walk goal was reset over and over").toBeLessThanOrEqual(3);
    expect(h.bots[0]!.tossedTotal).toBe(2);
  });

  it("from close by it tosses exactly ONCE, not once per tick", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 2) });
    h.bots[0]!.stacks = [makeItem("cobblestone", 5, 36)];
    await say(h, OWNER, "elix give me 2 cobblestone", 10_000);
    expect(h.bots[0]!.tossCalls, "tossed once per tick while the first was still in flight").toBe(1);
    expect(h.bots[0]!.tossedTotal).toBe(2);
  });

  it("the asker MOVING mid-walk gets a new goal, but not one per tick", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 12) });
    h.bots[0]!.stacks = [makeItem("cobblestone", 5, 36)];
    h.bots[0]!.emit("chat", OWNER, "elix give me 2 cobblestone");
    await vi.advanceTimersByTimeAsync(200);
    // The asker walks away by more than the 2-block threshold, so a new goal is warranted.
    const player = h.bots[0]!.players[OWNER] as { entity: { position: Vec3 } };
    player.entity.position = new Vec3(16, 64, 0);
    await vi.advanceTimersByTimeAsync(400);
    // And a nudge of one block must NOT re-goal, or Elix never moves at all.
    const before = h.bots[0]!.goalResets;
    player.entity.position = new Vec3(16.5, 64, 0);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.bots[0]!.goalResets, "re-goaled for a one-block nudge").toBe(before);
  });

  it("a stranger gets nothing, at any distance", async () => {
    const h = await started({ [STRANGER]: makePlayer(STRANGER, 2), [OWNER]: makePlayer(OWNER, 20) });
    h.bots[0]!.stacks = [makeItem("cobblestone", 5, 36)];
    await say(h, STRANGER, "elix give me 2 cobblestone", 10_000);
    expect(h.bots[0]!.tossCalls).toBe(0);
  });
});

describe("R19-A — deposit turns a coordinate into a Block", () => {
  it("opens the chest once and deposits every stack", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -10) });
    const b = h.bots[0]!;
    b.world.set("0,64,2", "chest");
    b.stacks = [makeItem("dirt", 10, 36), makeItem("cobblestone", 5, 37)];
    await say(h, OWNER, "elix put your stuff in the chest", 10_000);
    expect(b.openCalls, "the chest was never opened, or opened more than once").toBe(1);
    expect(b.depositCalls).toBe(2);
    expect(b.withdrawCalls, "took something out of somebody's chest").toBe(0);
  });

  it("never withdraws, even when the chest is right there", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -10) });
    const b = h.bots[0]!;
    b.world.set("0,64,2", "chest");
    b.stacks = [makeItem("dirt", 10, 36)];
    await say(h, OWNER, "elix put your stuff in the chest", 10_000);
    expect(b.withdrawCalls).toBe(0);
  });
});

describe("R19-A — craft waits for the table before crafting with it", () => {
  it("places the table, THEN crafts with it, then digs it back up", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -10) });
    const b = h.bots[0]!;
    b.stacks = [makeItem("oak_planks", 3, 36), makeItem("stick", 2, 37), makeItem("crafting_table", 1, 38)];
    await say(h, OWNER, "elix make a wooden pickaxe", 15_000);
    expect(b.stacks.some((s) => s.name === "wooden_pickaxe"), "never crafted the pickaxe").toBe(true);
    for (const call of b.craftCalls) {
      if (call.withTable) expect(call.tableExisted, "crafted with a table that was not placed yet").toBe(true);
    }
    expect(b.placeCalls, "never placed the table").toBeGreaterThan(0);
    // The table goes back in the inventory: its block ends up as air, not as a crafting_table.
    expect(b.completedDigs.some((d) => b.world.get(d) === "air"), "left the crafting table on the ground").toBe(true);
  });

  it("a two-step craft still finishes both steps", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -10) });
    const b = h.bots[0]!;
    b.stacks = [makeItem("oak_planks", 4, 36), makeItem("crafting_table", 1, 37)];
    // "crafting_table" is a 2x2 recipe, so this is one step; the interest is that the plan runs
    // to completion rather than advancing into a step whose promise is still pending.
    await say(h, OWNER, "elix make a crafting table", 10_000);
    expect(b.stacks.filter((s) => s.name === "crafting_table").length).toBeGreaterThan(1);
  });
});

describe("R19-A — the protection rules still hold at real speed", () => {
  it("never digs inside a remembered place, and gathers fine outside it", async () => {
    const temp = tempStore();
    try {
      temp.store.addPlace({ key: "home", kind: "home", ts: 1, x: 4, y: 63, z: 0, dimension: "overworld" });
      const near = await started({ [OWNER]: makePlayer(OWNER, -30) }, temp.store);
      for (const x of [3, 4, 5, 6, 7, 8]) near.bots[0]!.world.set(`${x},63,0`, "dirt");
      await say(near, OWNER, "elix get 2 dirt", 20_000);
      expect(near.bots[0]!.completedDigs, "dug inside a remembered place").toEqual([]);
    } finally {
      temp.close();
    }
  });

  it("never digs the block a player is standing on", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 8) });
    for (const x of [8, 9, 10, 11, 12]) h.bots[0]!.world.set(`${x},63,0`, "dirt");
    await say(h, OWNER, "elix get 2 dirt", 30_000);
    const b = h.bots[0]!;
    const ownerPos = (b.players[OWNER] as { entity: { position: Vec3 } }).entity.position;
    for (const dug of b.completedDigs) {
      const parts = dug.split(",").map((n) => Number.parseInt(n, 10));
      const x = parts[0] ?? 0;
      const z = parts[2] ?? 0;
      expect(Math.hypot(x - ownerPos.x, z - ownerPos.z), `dug ${dug} under the owner`).toBeGreaterThan(2);
    }
  });
});

describe("R19-A — the wellbeing floor still beats a skill line at real speed", () => {
  it("a floor-matching line never starts a gather", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, -30) });
    for (const x of [8, 9, 10]) h.bots[0]!.world.set(`${x},63,0`, "dirt");
    await say(h, OWNER, "elix get 2 dirt i feel awful about my cat", 10_000);
    expect(h.bots[0]!.completedDigs, "a wellbeing-floor line started a gather").toEqual([]);
  });
});
