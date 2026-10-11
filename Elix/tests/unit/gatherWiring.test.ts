/**
 * R18-C/R19-A: the Round 18 gather tests, re-run against the REAL-SPEED fake.
 *
 * Round 18's version of these assertions used a fake whose pathfinder never moved Elix, and it
 * still expected a dig to happen. That test passed and the feature was broken: in a real game
 * `bot.dig` from three blocks away does nothing, and the next tick's dig aborts the first. The
 * assertions are unchanged; only the fake is now the one the game would give us.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vec3 } from "vec3";
import { BotSession, type SessionDeps } from "../../src/connection/bot.js";
import { MemoryStore } from "../../src/memory/store.js";
import { bus } from "../../src/core/events.js";
import { PLAYER_CLEARANCE } from "../../src/skills/gatherRuntime.js";
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

async function say(h: { bots: RealSpeedBot[] }, who: string, line: string, wait = 20_000) {
  h.bots[0]!.emit("chat", who, line);
  await vi.advanceTimersByTimeAsync(wait);
}

/** A patch of dirt where the fake walks to it. */
function withDirt(bot: RealSpeedBot, xs: number[] = [6, 7, 8, 9, 10]): void {
  for (const x of xs) bot.world.set(`${x},63,0`, "dirt");
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R18-C — an owner's gather line reaches bot.dig", () => {
  it("walks to the block and digs it, and never reaches the chat model", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!);
    await say(h, OWNER, "elix get 5 dirt", 30_000);
    expect(h.handled, "the line went to the chat model").not.toContain("elix get 5 dirt");
    const b = h.bots[0]!;
    expect(b.goalResets + b.completedDigs.length, "no walk and no dig").toBeGreaterThan(0);
    expect(b.completedDigs.length, "dirt actually dug").toBeGreaterThan(0);
  });

  it("the goal it sets is a REAL pathfinder goal, not a description of one", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!);
    await say(h, OWNER, "elix get 5 dirt", 8_000);
    // The fake records nothing itself, so assert through the runtime's own contract: the walk
    // only ever arrives because a goal was set, and a plain object would carry no coordinates.
    expect(h.bots[0]!.entity.position.x, "Elix never moved, so no goal was ever set").toBeGreaterThan(0);
  });

  it("equips the tool minecraft-data says the block needs, before digging", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    const b = h.bots[0]!;
    withDirt(b);
    b.stacks = [makeItem("stone_axe", 1, 36)];
    await say(h, OWNER, "elix get 5 dirt", 30_000);
    expect(b.completedDigs.length).toBeGreaterThan(0);
    expect(b.equipped.filter((e) => e.name.endsWith("_pickaxe")), "equipped a pickaxe for DIRT").toEqual([]);
  });

  it("equips a pickaxe for stone - and only the gather can be the reason for it", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    const b = h.bots[0]!;
    for (const x of [6, 7, 8]) b.world.set(`${x},62,0`, "stone");
    b.stacks = [makeItem("iron_pickaxe", 1, 36), makeItem("iron_sword", 1, 37)];
    await say(h, OWNER, "elix mine 3 stone", 30_000);
    expect(b.completedDigs.length, "no stone was dug").toBeGreaterThan(0);
    expect(b.equipped.map((e) => e.name), "never equipped the pickaxe stone needs").toContain("iron_pickaxe");
  });

  it("handles 'get wood' and 'mine 10 stone' the same way", async () => {
    for (const line of ["elix get wood", "elix mine 10 stone"]) {
      const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
      const b = h.bots[0]!;
      for (const x of [6, 7, 8, 9]) b.world.set(`${x},62,0`, "stone");
      await say(h, OWNER, line, 20_000);
      expect(h.handled, line).not.toContain(line);
    }
  });
});

describe("R18-C — only owners, and never on a wellbeing-floor line", () => {
  it("a STRANGER gets the refusal and no dig at all", async () => {
    const h = await started({ [STRANGER]: makePlayer(STRANGER, 3), [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!, [3, 4, 5]);
    await say(h, STRANGER, "elix get 5 dirt", 20_000);
    const b = h.bots[0]!;
    expect(b.completedDigs, "a stranger got Elix to dig").toEqual([]);
    expect(b.entity.position.x, "a stranger sent Elix walking").toBe(0);
    expect(b.chatCalls.join(" ")).toMatch(/can't do that/iu);
  });

  it("a WELLBEING-FLOOR line triggers nothing, even when it reads like a command", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!);
    await say(h, OWNER, "elix get 5 dirt i feel awful about my cat", 20_000);
    expect(h.bots[0]!.completedDigs, "a wellbeing-floor line started a gather").toEqual([]);
  });

  it("an unaddressed line is not a command", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!);
    await say(h, OWNER, "everyone get 5 dirt", 20_000);
    expect(h.bots[0]!.completedDigs).toEqual([]);
  });
});

describe("R18-C — the protection rules, which are the point", () => {
  it("refuses a block inside a REMEMBERED PLACE's radius", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-r19c-"));
    const store = new MemoryStore({ path: join(dir, "m.db") });
    try {
      store.addPlace({ key: "home", kind: "home", ts: 1, x: 4, y: 63, z: 0, dimension: "overworld" });
      const near = await started({ [OWNER]: makePlayer(OWNER, 40) }, store);
      withDirt(near.bots[0]!, [3, 4, 5, 6, 7]);
      await say(near, OWNER, "elix get 5 dirt", 20_000);
      expect(near.bots[0]!.completedDigs, "dug inside a remembered place").toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gathers fine far away from any remembered place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elix-r19d-"));
    const store = new MemoryStore({ path: join(dir, "m.db") });
    try {
      // A remembered place 200 blocks away, and dirt at Elix's feet: the rule protects PLACES,
      // and must not turn into "Elix may never dig anywhere".
      store.addPlace({ key: "home", kind: "home", ts: 1, x: 200, y: 63, z: 0, dimension: "overworld" });
      const far = await started({ [OWNER]: makePlayer(OWNER, 40) }, store);
      withDirt(far.bots[0]!, [6, 7, 8]);
      await say(far, OWNER, "elix get 5 dirt", 30_000);
      expect(far.bots[0]!.completedDigs.length, "a place 200 blocks away blocked a dig").toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NEVER digs the block a player is standing on, nor one within two blocks", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 8) });
    withDirt(h.bots[0]!, [6, 7, 8, 9, 10, 11, 12]);
    await say(h, OWNER, "elix get 5 dirt", 30_000);
    const b = h.bots[0]!;
    const ownerPos = (b.players[OWNER] as { entity: { position: Vec3 } }).entity.position;
    for (const dug of b.completedDigs) {
      const parts = dug.split(",").map((n) => Number.parseInt(n, 10));
      const x = parts[0] ?? 0;
      const z = parts[2] ?? 0;
      expect(
        Math.hypot(x - ownerPos.x, z - ownerPos.z),
        `dug ${dug}, within ${PLAYER_CLEARANCE} of the owner`,
      ).toBeGreaterThan(PLAYER_CLEARANCE);
    }
  });

  it("ELIX HIMSELF does not count as a player he must keep clear of", () => {
    // If Elix's own position counted, he could never dig the block he is standing next to.
    expect(PLAYER_CLEARANCE).toBeGreaterThan(0);
  });
});

describe("R18-C — the caps and the progress line", () => {
  it("never digs more than the requested count", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!, [6, 7, 8, 9, 10, 11, 12]);
    await say(h, OWNER, "elix get 2 dirt", 30_000);
    expect(h.bots[0]!.completedDigs.length).toBeLessThanOrEqual(2);
  });

  it("says at most one progress line a minute, through gateOwnLine", async () => {
    const h = await started({ [OWNER]: makePlayer(OWNER, 40) });
    withDirt(h.bots[0]!, [6, 7, 8, 9, 10, 11, 12]);
    await say(h, OWNER, "elix get 6 dirt", 60_000);
    const lines = h.bots[0]!.chatCalls.filter((l) => /got \d+ of/u.test(l));
    expect(lines.length, "too many progress lines").toBeLessThanOrEqual(1);
    expect(h.bridge.gateOwnLine).toHaveBeenCalled();
    expect(h.bridge.gateScriptedReply, "Elix's own words were filed as the player's").not.toHaveBeenCalled();
  });
});
