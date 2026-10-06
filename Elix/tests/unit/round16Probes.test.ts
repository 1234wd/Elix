/**
 * Round 16 — reviewer probes against eb30e19 (Part C: follow / come / stop).
 *
 * Every test asserts the WORKING behaviour. On eb30e19 every test except the fixture check
 * FAILS. Do not edit an assertion, delay or timeout. Fix the code.
 *
 *   U1  the goal handed to mineflayer-pathfinder is a plain object. The real library calls
 *       goal.isValid() on the next physicsTick and throws "stateGoal.isValid is not a
 *       function" -> uncaughtException -> Elix quits and reconnects. Six in a minute is a
 *       crash burst. Measured against the real mineflayer-pathfinder 2.4.5 source.
 *   U2  commands are not required to be addressed to Elix: "wait for me guys" stops him,
 *       and a stranger saying "stop spamming" gets "i can't do that one, sorry"
 *   U3  an addressed QUESTION containing a command word is swallowed:
 *       "elix how do i stop creepers from blowing up my house" -> "ok, stopping", no answer
 *   U4  "come here" walks to the NEAREST player, not to the person who asked
 *   U5  the acknowledgement "on my way" is sent to the classifier as if the player said it
 *       (the Round 14 R3 bug again, through gateScriptedReply)
 *
 * Positions are real Vec3s and entities carry `isValid`, because that is what mineflayer
 * hands over and what a real pathfinder goal reads.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { BotSession, type BlockLike, type BotLike, type SessionDeps, type Vec3Like } from "../../src/connection/bot.js";
import { parseCommand, ACKNOWLEDGEMENTS } from "../../src/actions/commands.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig } from "../../src/core/config.js";

/** A mineflayer Player: position on entity, as a Vec3, and a live entity is valid. */
function mineflayerPlayer(name: string, x: number, z = 0) {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: { username: name, position: new Vec3(x, 65, z), isValid: true, height: 1.8 },
  };
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
  owners: ["ElixOwner"],
  skillCap: "normal",
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
} as unknown as ElixConfig;

class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  health = 20;
  entity: { position: Vec3Like; yaw: number } | undefined = { position: new Vec3(0, 65, 0), yaw: 0 };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  players: Record<string, unknown> = {};
  chatCalls: string[] = [];
  pathfinder = { setGoal: vi.fn(), stop: vi.fn() };
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

function harness(players: Record<string, unknown>) {
  const bots: FakeBot[] = [];
  const classified: Array<{ sender: string; message: string }> = [];
  const handled: string[] = [];
  const bridge = {
    handle: vi.fn(async (_sender: string, message: string) => {
      handled.push(message);
      return { replied: false, reason: "not-addressed" };
    }),
    recordScripted: vi.fn(),
    // Classifies `message` as the sender's words, exactly like the real one.
    gateScriptedReply: vi.fn(async (sender: string, message: string) => {
      classified.push({ sender, message });
      return false;
    }),
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
      players: { online: 3, max: 20 },
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
  return { s: new BotSession(deps), bots, classified, handled };
}

async function started(players: Record<string, unknown>) {
  const h = harness(players);
  await h.s.start();
  h.bots[0]!.emit("spawn");
  await vi.advanceTimersByTimeAsync(3_000);
  return h;
}

async function say(h: ReturnType<typeof harness>, who: string, line: string, wait = 4_000) {
  h.bots[0]!.emit("chat", who, line);
  await vi.advanceTimersByTimeAsync(wait);
}

/** What mineflayer-pathfinder 2.4.5 does with a goal on every physicsTick (index.js monitorMovement / path search). */
function exerciseLikeThePathfinder(goal: unknown): void {
  const g = goal as {
    isValid: () => boolean;
    hasChanged: () => boolean;
    heuristic: (n: { x: number; y: number; z: number }) => number;
    isEnd: (n: { x: number; y: number; z: number }) => boolean;
  };
  const node = new Vec3(0, 65, 0);
  g.isValid();
  g.hasChanged();
  g.heuristic(node);
  g.isEnd(node);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 5, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Round 16 probes — Part C against the real libraries", () => {
  it("fixtures", () => {
    expect(parseCommand("wait for me guys")?.action).toBe("stop");
    expect(parseCommand("elix how do i stop creepers from blowing up my house")?.action).toBe("stop");
  });

  it("U1: follow and come hand the pathfinder a goal it can actually run", async () => {
    const h = await started({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await say(h, "ElixOwner", "elix follow me");
    await say(h, "ElixOwner", "elix stop");
    await say(h, "ElixOwner", "elix come here");
    const goals = h.bots[0]!.pathfinder.setGoal.mock.calls.map((c) => c[0]);
    expect(goals.length, "follow and come each set a goal").toBeGreaterThanOrEqual(2);
    for (const goal of goals) expect(() => exerciseLikeThePathfinder(goal)).not.toThrow();
  });

  it("U2: lines NOT addressed to Elix are never commands", async () => {
    const h = await started({ ElixOwner: mineflayerPlayer("ElixOwner", 4), Alex: mineflayerPlayer("Alex", 8) });
    await say(h, "ElixOwner", "elix follow me");
    const stopsBefore = h.bots[0]!.pathfinder.stop.mock.calls.length;
    await say(h, "ElixOwner", "wait for me guys"); // talking to someone else
    await say(h, "Alex", "stop spamming the chat"); // a stranger, not talking to Elix
    expect(h.bots[0]!.pathfinder.stop.mock.calls.length, "Elix stopped following").toBe(stopsBefore);
    const sent = h.bots[0]!.chatCalls.join(" | ");
    expect(sent).not.toMatch(/ok, stopping/);
    expect(sent).not.toMatch(/can't do that one/);
  });

  it("U3: an addressed question that merely contains a command word is answered, not obeyed", async () => {
    const h = await started({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    const q = "elix how do i stop creepers from blowing up my house";
    await say(h, "ElixOwner", q);
    expect(h.handled, "the question reached the brain").toContain(q);
    expect(h.bots[0]!.chatCalls.join(" | ")).not.toMatch(/ok, stopping/);
  });

  it("U4: 'come here' goes to the person who asked, not to whoever is nearest", async () => {
    const h = await started({ ElixOwner: mineflayerPlayer("ElixOwner", 12), Alex: mineflayerPlayer("Alex", 3) });
    await say(h, "ElixOwner", "elix come here");
    const goal = h.bots[0]!.pathfinder.setGoal.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(goal, "a goal was set").toBeDefined();
    // Read the target from either a real GoalNear (x, y, z) or a position field.
    const x = (goal?.x as number | undefined) ?? (goal?.position as { x?: number } | undefined)?.x;
    expect(x, "walked towards the owner at x=12, not Alex at x=3").toBe(12);
  });

  it("U5: Elix's acknowledgement is never classified as the player's words", async () => {
    const h = await started({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await say(h, "ElixOwner", "elix follow me");
    const acks = Object.values(ACKNOWLEDGEMENTS);
    const audited = h.classified.filter((c) => acks.includes(c.message));
    expect(audited, "an acknowledgement was audited as if the owner had said it").toEqual([]);
  });
});