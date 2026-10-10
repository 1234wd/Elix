/**
 * R18-F acceptance — world memory, from a chat line to a real `bot.whisper`.
 *
 * The rule these tests exist to protect is a privacy rule: coordinates go to owners, by
 * whisper, and never into public chat. Every test asserts the public channel separately from
 * the whisper channel, because a single assertion on "did he answer" would pass just as well
 * if the answer were a coordinate read out loud.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import { BotSession, type BotLike, type SessionDeps } from "../../src/connection/bot.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig } from "../../src/core/config.js";

const data = (createRequire(import.meta.url)("minecraft-data") as (v: string) => {
  blocksByName: Record<string, { id: number } | undefined>;
  itemsByName: Record<string, { id: number } | undefined>;
})("26.2");

const OWNER = "ElixOwner";
const STRANGER = "NotTheOwner";
const COORDS = /-?\d+\s*,?\s+-?\d+\s*,?\s+-?\d+/;

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
    position: new Vec3(12, 65, -7),
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
  whisper(to: string, text: string): void {
    this.whispers.push({ to, text });
  }
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

/** Every public line Elix has sent, in one string, for the coordinate check. */
function publicLines(b: FakeBot): string[] {
  return b.chatCalls;
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R18-F — remember and where-is are handled, not sent to the model", () => {
  it("an owner's 'remember this place' and 'where is' never reach the chat model", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix where is testspot");
    expect(h.handled).not.toContain("elix remember this place as testspot");
    expect(h.handled).not.toContain("elix where is testspot");
  });

  it("coordinates reach the OWNER by bot.whisper - the only channel they may use", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix where is testspot");
    const b = h.bots[0]!;
    expect(b.whispers.length, "never whispered the coordinates").toBeGreaterThan(0);
    const last = b.whispers[b.whispers.length - 1]!;
    expect(last.to, "whispered to somebody who is not the owner").toBe(OWNER);
    // Elix was at 12, 65, -7 in this world.
    expect(last.text).toMatch(COORDS);
    expect(last.text).toContain("12");
  });

  it("NO public line Elix ever sends contains coordinates", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2), [STRANGER]: mineflayerPlayer(STRANGER, 5) });
    const b = h.bots[0]!;
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix where is testspot");
    await say(h, OWNER, "elix take me to testspot");
    await say(h, STRANGER, "elix where is testspot");
    await say(h, OWNER, "elix where did i die");
    for (const line of publicLines(b)) {
      expect(line, `coordinates in public chat: ${line}`).not.toMatch(COORDS);
    }
  });

  it("a place Elix has never heard of gets no coordinates at all", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix where is atlantis");
    const b = h.bots[0]!;
    expect(b.whispers, "invented coordinates for a place that does not exist").toEqual([]);
    for (const line of publicLines(b)) expect(line).not.toMatch(COORDS);
  });

  it("a STRANGER asking 'where is' gets NOTHING useful - no numbers, in either channel", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2), [STRANGER]: mineflayerPlayer(STRANGER, 5) });
    await say(h, OWNER, "elix remember this place as home");
    const b = h.bots[0]!;
    b.whispers.length = 0;
    await say(h, STRANGER, "elix where is home");
    for (const whisper of b.whispers) {
      expect(whisper.text, "a stranger was whispered the coordinates").not.toMatch(COORDS);
    }
    for (const line of publicLines(b)) expect(line).not.toMatch(COORDS);
    expect(b.whispers.every((w) => w.to === STRANGER && !COORDS.test(w.text))).toBe(true);
  });
});

describe("R18-F — going to a remembered place walks there with a real goal", () => {
  it("'take me to X' sets a real goal with numeric coordinates", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix take me to testspot");
    const b = h.bots[0]!;
    expect(b.pathfinder.setGoal, "never walked to the place").toHaveBeenCalled();
    const goal = b.pathfinder.setGoal.mock.calls.at(-1)?.[0] as {
      isValid?: unknown;
      heuristic?: unknown;
      isEnd?: unknown;
      hasChanged?: unknown;
      x?: number;
      z?: number;
    };
    expect(typeof goal.isValid).toBe("function");
    expect(typeof goal.heuristic).toBe("function");
    expect(typeof goal.isEnd).toBe("function");
    expect(typeof goal.hasChanged).toBe("function");
    expect(Number.isFinite(goal.x), "a NaN coordinate would send Elix walking nowhere").toBe(true);
    expect(goal.x).toBe(12);
  });

  it("'go to X' works the same way", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    await say(h, OWNER, "elix go to testspot");
    expect(h.bots[0]!.pathfinder.setGoal).toHaveBeenCalled();
  });

  it("a STRANGER cannot make Elix walk to a place", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2), [STRANGER]: mineflayerPlayer(STRANGER, 5) });
    await say(h, OWNER, "elix remember this place as home");
    const b = h.bots[0]!;
    b.pathfinder.setGoal.mockClear();
    await say(h, STRANGER, "elix take me to home");
    expect(b.pathfinder.setGoal, "a stranger sent Elix walking").not.toHaveBeenCalled();
  });
});

describe("R18-F — where did i die comes from the real death events", () => {
  it("a real bot 'death' event is recorded and answered with a whisper", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.entity.position = new Vec3(-33, 12, 91);
    b.emit("death");
    b.whispers.length = 0;
    await say(h, OWNER, "elix where did i die");
    expect(b.whispers.length, "the death event was not recorded").toBeGreaterThan(0);
    const last = b.whispers[b.whispers.length - 1]!;
    expect(last.to).toBe(OWNER);
    expect(last.text).toMatch(COORDS);
    expect(last.text).toContain("-33");
    for (const line of publicLines(b)) expect(line).not.toMatch(COORDS);
  });

  it("an entityDead event for a player is recorded too", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.emit("entityDead", { type: "player", position: new Vec3(50, 20, 60), isValid: false });
    b.whispers.length = 0;
    await say(h, OWNER, "elix where did i die");
    expect(b.whispers.at(-1)?.text).toContain("50");
  });

  it("a MOB dying is not a death of Elix's and is not recorded", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.emit("entityDead", { type: "zombie", position: new Vec3(50, 20, 60), isValid: false });
    b.whispers.length = 0;
    await say(h, OWNER, "elix where did i die");
    expect(b.whispers, "a dead zombie answered 'where did i die'").toEqual([]);
  });

  it("with no death at all it says so, and still no coordinates", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix where did i die");
    for (const line of publicLines(h.bots[0]!)) expect(line).not.toMatch(COORDS);
  });
});

describe("R18-F — the same owner rules as every other skill", () => {
  it("an unaddressed line is not a place command", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "everyone remember this place as testspot");
    expect(h.bots[0]!.whispers).toEqual([]);
  });

  it("a wellbeing-floor line triggers nothing, even when it reads like a command", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    const b = h.bots[0]!;
    b.whispers.length = 0;
    await say(h, OWNER, "elix remember this place as testspot i feel awful about my cat");
    expect(b.whispers).toEqual([]);
  });

  it("memory lines are ELIX's own words, so they never go through gateScriptedReply", async () => {
    const h = await started({ [OWNER]: mineflayerPlayer(OWNER, 2) });
    await say(h, OWNER, "elix remember this place as testspot");
    for (const line of h.bots[0]!.chatCalls) expect(line).not.toMatch(COORDS);
    // The public line came from the memory runtime, which writes straight to bot.chat for a
    // line that provably holds no coordinates - never through a reply gate, because it is not
    // a reply to anybody's words. The gateScriptedReply assertion is the important half: it is
    // Elix's OWN line, and filing it as the player's words is the mistake this round is about.
    expect(h.bridge.gateScriptedReply, "Elix's own words were filed as the player's").not.toHaveBeenCalled();
  });
});
