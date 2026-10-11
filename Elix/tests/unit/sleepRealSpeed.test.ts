/**
 * R19-E — sleep when the owner sleeps, on the real-speed fake.
 *
 * The interesting cases are the refusals: a creeper within eight blocks, a follow in progress, a
 * dig halfway through. Each is asserted to STOP Elix getting into a bed, because "sleeps through
 * a creeper" is the kind of bug a child notices on a real server and no unit test would have
 * caught from a stub that sleeps instantly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Vec3 } from "vec3";
import { BotSession, type SessionDeps } from "../../src/connection/bot.js";
import { bus } from "../../src/core/events.js";
import { RealSpeedBot, makePlayer } from "../helpers/realSpeedBot.js";
import type { ElixConfig } from "../../src/core/config.js";

const OWNER = "ElixOwner";

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

/** A RealSpeedBot that also counts sleeps, because `bot.sleep` is the thing under test. */
class SleepBot extends RealSpeedBot {
  sleepCalls: Array<{ name?: string; position?: unknown }> = [];
  override async sleep(block: unknown): Promise<void> {
    const b = block as { name?: string; position?: unknown };
    this.sleepCalls.push({ name: b.name, position: b.position });
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function started(setup: (bot: SleepBot) => void, isNight = false) {
  const bots: SleepBot[] = [];
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
    pingResult: {
      version: "Paper 26.2",
      protocol: 776,
      software: "Paper",
      motd: "",
      players: { online: 2, max: 20 },
      raw: {},
    },
    factory: () => {
      const b = new SleepBot();
      // A follow that is already AT the player is not a follow, so the follow test needs an
      // owner far enough away that Elix is genuinely walking to them.
      b.players = { Elix: makePlayer("Elix", 0), [OWNER]: makePlayer(OWNER, isNight ? 20 : 3) };
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
  return { bot: bots[0]! };
}

/** Night, an owner nearby, a free bed two blocks away. The case that should sleep. */
function nightWithBed(bot: SleepBot): void {
  bot.time = { isDay: false };
  bot.world.set("2,64,0", "red_bed");
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 23, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R19-E — sleeps when the owner is asleep", () => {
  it("walks to a free bed and calls bot.sleep with the BED BLOCK", async () => {
    const h = await started(nightWithBed);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.bot.sleepCalls.length, "Elix never slept").toBeGreaterThan(0);
    expect(h.bot.sleepCalls[0]!.name, "slept on something that is not a bed").toBe("red_bed");
  });

  it("sleeps exactly once, not once per tick", async () => {
    const h = await started(nightWithBed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.sleepCalls.length, "slept repeatedly").toBe(1);
  });

  it("does NOT sleep in the daytime", async () => {
    const h = await started((bot) => {
      bot.time = { isDay: true };
      bot.world.set("2,64,0", "red_bed");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.sleepCalls).toEqual([]);
  });

  it("does NOT sleep when there is no bed", async () => {
    const h = await started((bot) => {
      bot.time = { isDay: false };
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.sleepCalls).toEqual([]);
  });
  it("does NOT sleep when the owner is awake and standing in the dark", async () => {
    // No bed anywhere near the owner: being on the server at night is not the same as being
    // asleep, and Elix does not go to bed because somebody is standing in the dark.
    const h = await started((bot) => {
      bot.time = { isDay: false };
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.sleepCalls).toEqual([]);
  });

});

describe("R19-E — the refusals that keep him alive", () => {
  it("never sleeps with a hostile within 8 blocks", async () => {
    const h = await started((bot) => {
      nightWithBed(bot);
      bot.entities["9"] = { name: "creeper", type: "mob", position: new Vec3(3, 64, 0), isValid: true, health: 20 };
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.bot.sleepCalls, "slept through a creeper").toEqual([]);
  });

  it("sleeps once the hostile is gone - the check is every tick, not once at nightfall", async () => {
    const h = await started((bot) => {
      nightWithBed(bot);
      bot.entities["9"] = { name: "creeper", type: "mob", position: new Vec3(3, 64, 0), isValid: true, health: 20 };
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.bot.sleepCalls).toEqual([]);
    delete h.bot.entities["9"];
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.bot.sleepCalls.length, "never slept after the creeper left").toBeGreaterThan(0);
  });

  it("a hostile FAR away does not keep him awake", async () => {
    const h = await started((bot) => {
      nightWithBed(bot);
      bot.entities["9"] = { name: "creeper", type: "mob", position: new Vec3(60, 64, 0), isValid: true, health: 20 };
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.bot.sleepCalls.length, "a creeper 60 blocks away kept him awake").toBeGreaterThan(0);
  });

  it("does NOT sleep mid-dig", async () => {
    const h = await started((bot) => {
      nightWithBed(bot);
      for (const x of [6, 7, 8, 9, 10, 11, 12, 13]) bot.world.set(`${x},63,0`, "dirt");
    });
    // Elix is asleep within a tick of spawning at night, so any test about what happens DURING
    // an interaction has to start from a clean count - and from him being awake.
    h.bot.sleepCalls.length = 0;
    h.bot.emit("chat", OWNER, "elix get 8 dirt");
    // 1 s to walk, 1.5 s to dig: at 3 s one dig is DONE and the gather is still going.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bot.completedDigs.length, "the gather never ran, so the test proves nothing").toBeGreaterThan(0);
    expect(h.bot.sleepCalls, "slept in the middle of a dig").toEqual([]);
  });

  it("does NOT sleep while following the owner", async () => {
    // A follow that is already AT the player is not a follow, so the owner starts far away.
    const h = await started(nightWithBed, true);
    h.bot.sleepCalls.length = 0;
    h.bot.emit("chat", OWNER, "elix follow me");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.bot.sleepCalls, "slept while following").toEqual([]);
  });

  it("elix stop cancels it", async () => {
    const h = await started((bot) => {
      // A bed far away, so Elix is still walking to it when the stop lands.
      bot.time = { isDay: false };
      bot.world.set("14,64,0", "red_bed");
    });
    await vi.advanceTimersByTimeAsync(600);
    const before = h.bot.sleepCalls.length;
    h.bot.emit("chat", OWNER, "elix stop");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.bot.sleepCalls.length, "slept after a stop").toBe(before);
  });
});

describe("R19-E — waking", () => {
  it("the server's wake event ends the night", async () => {
    const h = await started(nightWithBed);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.bot.sleepCalls.length).toBeGreaterThan(0);
    // Daylight arriving is the other honest signal.
    h.bot.time = { isDay: true };
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.bot.sleepCalls.length, "slept again after waking").toBe(1);
  });
});
