import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  BotSession,
  isGreetingFor,
  greetingFor,
  permanentMessage,
  pickWalkDirection,
  isStandable,
  isSafeFloor,
  isPassable,
  HAZARD_BLOCKS,
  toVec3,
  requirePathfinder,
  type BlockLike,
  type BotLike,
  type Vec3Like,
  type SessionDeps,
} from "../../src/connection/bot.js";
import type { PingResult } from "../../src/connection/ping.js";
import type { ElixConfig } from "../../src/core/config.js";
import { bus } from "../../src/core/events.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal fake bot: an EventEmitter with the fields bot.ts touches. */
class FakeBot extends EventEmitter implements BotLike {
  username = "Elix";
  health = 20;
  entity: { position: Vec3Like; yaw: number } | undefined = {
    position: { x: 0, y: 65, z: 0 },
    yaw: 0,
  };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  chatCalls: string[] = [];
  quitCalls: string[] = [];
  lookCalls: Array<{ yaw: number; pitch: number }> = [];
  _client = { on: () => {} };
  quitCount = 0;
  /** When true, quit() never emits 'end' — used to test the shutdown timeout. */
  silentQuit = false;

  /**
   * mineflayer's client emits 'end' asynchronously after quit(). A microtask
   * keeps this fake faithful without needing the test to advance fake timers.
   */
  quit(reason?: string): void {
    this.quitCount++;
    this.quitCalls.push(reason ?? "");
    if (this.silentQuit) return;
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  blockAt(pos: Vec3Like): BlockLike | null {
    // Default world: solid stone at y<65, air above.
    return pos.y < 65 ? { name: "stone", id: 1 } : { name: "air", id: 0 };
  }
  loadPlugin(): void {}
  look(yaw: number, pitch: number): void {
    this.lookCalls.push({ yaw, pitch });
  }
  /** Test helper: fire the mineflayer events. */
  spawn(): void {
    this.emit("spawn");
  }
  kick(raw: unknown): void {
    this.emit("kicked", raw);
  }
  end(reason = "socketClosed"): void {
    this.emit("end", reason);
  }
}

const PING: PingResult = {
  version: "Paper 26.2",
  protocol: 776,
  software: "Paper",
  motd: "Elix test",
  players: { online: 1, max: 20 },
  raw: {},
};

const CONFIG: ElixConfig = {
  version: 1,
  bot: { username: "Elix", version: "26.2", serverAllowlist: [] },
  server: { profile: "main" },
  profiles: {},
  brain: {
    fastMaxTokens: 1500,
    smartMaxTokens: 4000,
    timeoutsMs: { fast: 6000, smart: 20000 },
    idleChatterBudgetPerHour: 60,
  },
  voice: { enabled: false, textOnlyFallback: true },
  safety: { contentLevel: "kid-safe", chatRateLimitPer2s: 1 },
  persona: "config/persona.md",
  dataDir: "data",
  logLevel: "info",
};

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as import("../../src/core/logger.js").Logger;
}

const PROFILE = {
  name: "main",
  host: "145.241.127.222",
  port: 25565,
  version: "26.2",
  username: "Elix",
};

interface Harness {
  session: BotSession;
  bots: FakeBot[];
  logs: ReturnType<typeof makeLog>;
  permanent: Array<{ kind: string; text: string; username: string }>;
}

function harness(overrides: Partial<SessionDeps> = {}): Harness {
  const bots: FakeBot[] = [];
  const permanent: Array<{ kind: string; text: string; username: string }> = [];
  const logs = makeLog();
  const deps: SessionDeps = {
    config: CONFIG,
    profile: PROFILE,
    log: logs,
    pingResult: PING,
    factory: () => {
      const b = new FakeBot();
      bots.push(b);
      return b;
    },
    onPermanentDisconnect: (info) => permanent.push(info),
    exitOnPermanent: false, // never call process.exit in tests
    ...overrides,
  };
  return { session: new BotSession(deps), bots, logs, permanent };
}

// ---------------------------------------------------------------------------
// A1 — the whitelist/ban reconnect-forever bug
// ---------------------------------------------------------------------------

describe("A1 — permanent kicks must NOT reconnect", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    bus.removeAll();
    h = harness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reconnect after a whitelist kick + end('socketClosed')", async () => {
    await h.session.start();
    const bot = h.bots[0]!;

    bot.kick({ type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } } });
    bot.end("socketClosed");

    // The factory must NEVER be called again, no matter how long we wait.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bots).toHaveLength(1);
    expect(h.session.pendingReconnect).toBe(false);
    expect(h.session.exitCodeIfPermanent).toBe(2);
    expect(h.permanent[0]?.kind).toBe("whitelist");
    expect(h.permanent[0]?.username).toBe("Elix");
  });

  it("does not reconnect after a ban kick", async () => {
    await h.session.start();
    const bot = h.bots[0]!;

    bot.kick({ type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.banned" } } });
    bot.end("socketClosed");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bots).toHaveLength(1);
    expect(h.permanent[0]?.kind).toBe("ban");
  });

  it("does not reconnect after vanilla's 'white-listed' English text", async () => {
    await h.session.start();
    const bot = h.bots[0]!;

    bot.kick({ type: "string", value: "You are not white-listed on this server!" });
    bot.end("socketClosed");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bots).toHaveLength(1);
    expect(h.permanent[0]?.kind).toBe("whitelist");
  });

  it("reconnects EXACTLY once after 'Kicked by an operator', after 5 s", async () => {
    await h.session.start();
    const bot = h.bots[0]!;

    bot.kick({ type: "compound", value: { text: { type: "string", value: "Kicked by an operator" } } });
    bot.end("socketClosed");

    // Nothing yet at 4.9 s.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(h.bots).toHaveLength(1);

    // Exactly one reconnect at 5 s.
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bots).toHaveLength(2);
    expect(h.session.attempts).toBe(1);

    // And no runaway retries afterwards.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bots).toHaveLength(2);
  });

  it("classifies from the kick reason, not the end reason", async () => {
    await h.session.start();
    const bot = h.bots[0]!;

    // 'socketClosed' alone matches no pattern and would be retried as a generic
    // kick — the bug. With lastKick stored it must not retry.
    bot.kick('{"translate":"multiplayer.disconnect.not_whitelisted"}');
    bot.end("socketClosed");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.bots).toHaveLength(1);
  });

  it("reads lastKick only from the bot instance that was kicked (A1)", async () => {
    // Two independent sessions: a whitelist kick in one must not poison the other.
    const whitelisted = harness();
    await whitelisted.session.start();
    whitelisted.bots[0]!.kick({
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
    });
    whitelisted.bots[0]!.end("socketClosed");
    expect(whitelisted.permanent[0]?.kind).toBe("whitelist");

    const other = harness();
    await other.session.start();
    // A bare socketClosed with no kick reason is a network drop → retry.
    other.bots[0]!.end("socketClosed");
    expect(other.permanent).toHaveLength(0);
    expect(other.session.pendingReconnect).toBe(true);
  });

  it("clears lastKick after reading it, so the next end classifies fresh", async () => {
    const h2 = harness();
    await h2.session.start();
    const bot = h2.bots[0]!;
    bot.kick({ type: "compound", value: { text: { type: "string", value: "Kicked by an operator" } } });
    bot.end("socketClosed");
    expect(h2.session.pendingReconnect).toBe(true);

    // Let the reconnect happen, then end the NEW bot with no kick reason.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h2.bots).toHaveLength(2);

    // A fresh bot has no lastKick, so a bare socketClosed is a network drop —
    // a retryable generic kick, never a whitelist stop.
    h2.bots[1]!.end("socketClosed");
    expect(h2.permanent.some((p) => p.kind === "whitelist")).toBe(false);
    expect(h2.session.pendingReconnect).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A8 — timer/interval hygiene across reconnects
// ---------------------------------------------------------------------------

describe("A8 — timers and intervals do not accumulate", () => {
  // describeReason() builds the 26.2 chat registry on first use, which is real
  // CPU work — the default 5 s per-test budget is too tight on a cold cache.
  beforeEach(() => {
    vi.useFakeTimers();
    bus.removeAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps exactly one status interval after 3 reconnects", async () => {
    const h = harness();
    await h.session.start();
    h.bots[0]!.spawn();
    expect(h.session.statusIntervalCount).toBe(1);

    for (let i = 0; i < 3; i++) {
      const current = h.bots[h.bots.length - 1]!;
      current.end("socketClosed");
      // The old interval is cleared the moment the socket closes (A8).
      expect(h.session.statusIntervalCount).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      const next = h.bots[h.bots.length - 1];
      expect(next, `reconnect ${i + 1} must create a new bot`).toBeDefined();
      next!.spawn();
    }

    expect(h.bots).toHaveLength(4);
    // Three old intervals were created and all three were cleared.
    expect(h.session.statusIntervalCount).toBe(1);

    // Shutdown awaits a bounded goodbye flush, so drive the clock while it runs.
    const stopping = h.session.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    expect(h.session.statusIntervalCount).toBe(0);
  }, 20_000);

  it("clears greeting/walk timers when the bot ends before they fire", async () => {
    const h = harness();
    await h.session.start();
    const bot = h.bots[0]!;
    bot.spawn();
    bot.end("socketClosed");
    // Greeting was due at 2 s, walk at 5 s, look at 8 s. None should fire.
    await vi.advanceTimersByTimeAsync(20_000);
    // No chat was sent on the dead bot and no walk was attempted.
    expect(h.logs.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({}),
      "no entity position — skipping walk",
    );
  });

  it("cancels a pending reconnect on shutdown — the factory is never called", async () => {
    const h = harness();
    await h.session.start();
    h.bots[0]!.end("socketClosed");
    expect(h.session.pendingReconnect).toBe(true);

    const stopping = h.session.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bots).toHaveLength(1); // never reconnected
  });

  it("resets the backoff ladder after a successful spawn", async () => {
    const h = harness();
    await h.session.start();

    // Attempt 1 waits the base 5 s.
    h.bots[0]!.end("socketClosed");
    expect(h.session.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h.bots).toHaveLength(2);

    // Attempt 2 waits the next rung, 10 s.
    h.bots[1]!.end("socketClosed");
    expect(h.session.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(h.bots).toHaveLength(2); // still inside the 10 s window
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bots).toHaveLength(3);

    // The third bot spawns successfully → the ladder resets.
    h.bots[2]!.spawn();
    expect(h.session.attempts).toBe(0);

    // Next kick therefore waits the base 5 s again, not 30 s.
    h.bots[2]!.end("socketClosed");
    await vi.advanceTimersByTimeAsync(4_900);
    expect(h.bots).toHaveLength(3); // not yet — still inside the 5 s window
    await vi.advanceTimersByTimeAsync(200);
    expect(h.bots).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// A7 — the walk must never dig or place blocks
// ---------------------------------------------------------------------------

describe("A7 — mineflayer-pathfinder is loaded as CommonJS", () => {
  it("exposes goals and Movements as real named exports", () => {
    // Regression: `await import("mineflayer-pathfinder")` puts the CJS exports
    // on `.default`, so destructuring `goals` gave undefined and the live walk
    // died with "Cannot read properties of undefined (reading 'GoalNear')".
    const pf = requirePathfinder();
    expect(typeof pf.Movements).toBe("function");
    expect(typeof pf.pathfinder).toBe("function");
    expect(pf.goals).toBeDefined();
    expect(typeof pf.goals.GoalNear).toBe("function");
  });

  it("GoalNear is constructible with (x, y, z, range)", () => {
    const { goals } = requirePathfinder();
    const goal = new goals.GoalNear(1, 2, 3, 1) as unknown as { x: number; y: number; z: number };
    expect(goal.x).toBe(1);
    expect(goal.y).toBe(2);
    expect(goal.z).toBe(3);
  });

  it("makeSafeMovements disables digging, towers and scaffolding", async () => {
    const { makeSafeMovements } = await import("../../src/connection/bot.js");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    // Movements' constructor reads the real block registry, so the fake bot needs
    // the genuine minecraft-data (via a prismarine-registry) — not a stub.
    const registry = req("prismarine-registry")("26.2") as unknown as Record<string, unknown>;
    let installed: Record<string, unknown> | null = null;
    const fakeBot = {
      pathfinder: {
        setMovements(m: Record<string, unknown>) {
          installed = m;
        },
      },
      registry,
      blockAt: () => ({ name: "air", id: 0 }),
      entity: { position: { x: 0, y: 65, z: 0 }, yaw: 0 },
      username: "Elix",
    } as never;
    const movements = (await makeSafeMovements(fakeBot)) as unknown as Record<string, unknown>;
    expect(movements.canDig).toBe(false);
    expect(movements.allow1by1towers).toBe(false);
    expect(movements.scafoldingBlocks).toEqual([]);
    expect(movements.allowFreeMotion).toBe(false);
    expect(movements.allowParkour).toBe(false);
    // The instance handed to the bot is the one we configured.
    expect(installed).toBe(movements);
  });
});

describe("A10 — floor and clearance use the bounding box, not the name", () => {
  const air = { name: "air", id: 0, boundingBox: "empty" };
  const caveAir = { name: "cave_air", id: 163, boundingBox: "empty" };
  const stone = { name: "stone", id: 1, boundingBox: "block" };
  const grass = { name: "short_grass", id: 1000, boundingBox: "empty" };
  const lava = { name: "lava", id: 9, boundingBox: "liquid" };
  const water = { name: "water", id: 8, boundingBox: "liquid" };
  const fire = { name: "fire", id: 81, boundingBox: "empty" };
  const magma = { name: "magma_block", id: 262, boundingBox: "block" };
  const sulfur = { name: "sulfur", id: 9000, boundingBox: "block" };
  const flower = { name: "poppy", id: 1001, boundingBox: "empty" };

  /** A flat world with a custom block at one position. */
  function world(floorBlock: BlockLike | null, feetBlock: BlockLike | null = air, headBlock: BlockLike | null = air) {
    return (p: Vec3Like): BlockLike | null => {
      if (p.y < 65) return floorBlock;
      if (p.y === 65) return feetBlock;
      return headBlock;
    };
  }

  it("rejects a lava floor", () => {
    expect(isStandable(world(lava), 0, 65, 0)).toBe(false);
  });

  it("rejects a water floor", () => {
    expect(isStandable(world(water), 0, 65, 0)).toBe(false);
  });

  it("rejects a magma_block floor", () => {
    expect(isStandable(world(magma), 0, 65, 0)).toBe(false);
  });

  it("rejects a sulfur floor (26.2 hazard)", () => {
    expect(isStandable(world(sulfur), 0, 65, 0)).toBe(false);
  });

  it("rejects no floor at all", () => {
    expect(isStandable(world(null), 0, 65, 0)).toBe(false);
  });

  it("accepts cave_air at the feet", () => {
    // The old check required the name to be exactly "air".
    expect(isStandable(world(stone, caveAir), 0, 65, 0)).toBe(true);
  });

  it("accepts short_grass at the feet", () => {
    expect(isStandable(world(stone, grass), 0, 65, 0)).toBe(true);
  });

  it("accepts a flower at the feet", () => {
    expect(isStandable(world(stone, flower), 0, 65, 0)).toBe(true);
  });

  it("accepts cave_air at the head", () => {
    expect(isStandable(world(stone, air, caveAir), 0, 65, 0)).toBe(true);
  });

  it("rejects fire at the feet", () => {
    expect(isStandable(world(stone, fire), 0, 65, 0)).toBe(false);
  });

  it("rejects water at the feet", () => {
    expect(isStandable(world(stone, water), 0, 65, 0)).toBe(false);
  });

  it("rejects a solid block at the head", () => {
    expect(isStandable(world(stone, air, stone), 0, 65, 0)).toBe(false);
  });

  it("treats a block with no boundingBox as solid ground", () => {
    // Unknown blocks report no shape; refusing to walk on them is the safe
    // choice, and we still must not dig.
    const unknown = { name: "mystery_block", id: 31337 };
    expect(isSafeFloor(unknown)).toBe(true);
  });

  it("isSafeFloor and isPassable both refuse every hazard", () => {
    // Whether or not the block is solid, a hazard is never somewhere we walk.
    for (const name of HAZARD_BLOCKS) {
      expect(isSafeFloor({ name, id: 1, boundingBox: "block" }), `floor ${name}`).toBe(false);
      expect(isPassable({ name, id: 1, boundingBox: "empty" }), `clearance ${name}`).toBe(false);
    }
  });

  it("isPassable accepts air, cave_air and plants", () => {
    expect(isPassable(air)).toBe(true);
    expect(isPassable(caveAir)).toBe(true);
    expect(isPassable(grass)).toBe(true);
    expect(isPassable(flower)).toBe(true);
  });

  it("isPassable rejects anything solid", () => {
    expect(isPassable(stone)).toBe(false);
    expect(isPassable({ name: "oak_log", id: 5, boundingBox: "block" })).toBe(false);
  });
});

describe("A7 — safe walk target selection", () => {
  const air = { name: "air", id: 0, boundingBox: "empty" };
  const stone = { name: "stone", id: 1, boundingBox: "block" };

  it("queries the world with real Vec3 objects, not plain {x,y,z}", async () => {
    // Regression: prismarine-world's getBlock() calls pos.floored(), so passing
    // a plain object made the live walk fail with "pos.floored is not a
    // function". These fakes assert what the real world requires.
    const seen: unknown[] = [];
    const blockAt = (p: Vec3Like): BlockLike | null => {
      expect(typeof (p as { floored?: unknown }).floored).toBe("function");
      seen.push(p);
      return p.y < 65 ? stone : air;
    };
    expect(isStandable(blockAt, 0, 65, 0)).toBe(true);
    expect(seen.length).toBe(3);
  });

  it("floors fractional coordinates before querying", () => {
    const seen: Vec3Like[] = [];
    const blockAt = (p: Vec3Like): BlockLike | null => {
      seen.push(p);
      return p.y < 65 ? stone : air;
    };
    isStandable(blockAt, 3.7, 65.9, -8.2);
    expect(seen.map((p) => ({ x: p.x, y: p.y, z: p.z }))).toEqual([
      { x: 3, y: 64, z: -9 },
      { x: 3, y: 65, z: -9 },
      { x: 3, y: 66, z: -9 },
    ]);
  });

  it("toVec3 keeps fractional coordinates and adds floored()", () => {
    const v = toVec3({ x: 1.5, y: 2.5, z: -3.5 });
    expect(v.x).toBe(1.5);
    expect(v.y).toBe(2.5);
    expect(v.z).toBe(-3.5);
    const f = (v as unknown as { floored(): { x: number; y: number; z: number } }).floored();
    expect({ x: f.x, y: f.y, z: f.z }).toEqual({ x: 1, y: 2, z: -4 });
  });

  it("rejects a spot with no floor", () => {
    const blockAt = () => air;
    expect(isStandable(blockAt, 0, 65, 0)).toBe(false);
  });

  it("rejects a spot with a solid block at head height", () => {
    const blockAt = (p: { y: number }) => (p.y < 65 ? stone : p.y === 66 ? stone : air);
    expect(isStandable(blockAt, 0, 65, 0)).toBe(false);
  });

  it("accepts flat ground with clear head", () => {
    const blockAt = (p: { y: number }) => (p.y < 65 ? stone : air);
    expect(isStandable(blockAt, 0, 65, 0)).toBe(true);
  });

  it("picks a direction when the world is flat", () => {
    const blockAt = (p: { y: number }) => (p.y < 65 ? stone : air);
    const target = pickWalkDirection(blockAt, { x: 0, y: 65, z: 0 });
    expect(target).not.toBeNull();
    expect(target!.name).toBe("+x"); // first candidate wins
    expect(target!.x).toBe(10);
  });

  it("returns null when every direction would need digging", () => {
    // Nothing is standable (void all around).
    const blockAt = () => air;
    expect(pickWalkDirection(blockAt, { x: 0, y: 65, z: 0 })).toBeNull();
  });

  it("skips a walled-in direction and picks a clear one", () => {
    // +x is blocked by a wall at x=10; -x is clear.
    const blockAt = (p: { x: number; y: number }) => {
      if (p.y < 65) return stone;
      if (p.x >= 10) return stone; // wall to the +x side
      return air;
    };
    const target = pickWalkDirection(blockAt, { x: 0, y: 65, z: 0 });
    expect(target).not.toBeNull();
    expect(target!.name).toBe("-x");
  });

  it("logs and skips the walk when no safe direction exists", async () => {
    const h = harness();
    const bot = new FakeBot();
    // Void world: nothing standable.
    bot.blockAt = () => ({ name: "air", id: 0 });
    const session = new BotSession({
      ...({ config: CONFIG, profile: PROFILE, log: h.logs, pingResult: PING } as SessionDeps),
      factory: () => bot as unknown as BotLike,
      exitOnPermanent: false,
    });
    const outcome = await (
      session as unknown as {
        walkAndBack(b: BotLike): Promise<{ walked: boolean; reason?: string }>;
      }
    ).walkAndBack(bot as unknown as BotLike);
    expect(outcome.walked).toBe(false);
    expect(outcome.reason).toBe("no-safe-direction");
  });
});

// ---------------------------------------------------------------------------
// A6 — the permanent-disconnect message
// ---------------------------------------------------------------------------

describe("A6 — permanent disconnect messages", () => {
  it("names the real username in the whitelist message", () => {
    const msg = permanentMessage("whitelist", "Elix", "");
    expect(msg).toContain("whitelist add Elix");
    expect(msg.toLowerCase()).toContain("whitelisted");
  });

  it("uses the configured username, not a hard-coded one", () => {
    expect(permanentMessage("whitelist", "Bob", "")).toContain("whitelist add Bob");
  });

  it("has a distinct line per permanent kind", () => {
    expect(permanentMessage("ban", "Elix", "griefing")).toContain("banned");
    expect(permanentMessage("online_mode", "Elix", "")).toContain("online-mode");
    expect(permanentMessage("captcha", "Elix", "")).toContain("Captcha");
    expect(permanentMessage("other", "Elix", "weird")).toContain("weird");
  });
});

// ---------------------------------------------------------------------------
// A14 — greeting detection
// ---------------------------------------------------------------------------

describe("A14 — greeting detection is whole-word only", () => {
  it("matches 'hi elix'", () => {
    expect(isGreetingFor("hi elix", "Elix")).toBe(true);
    expect(isGreetingFor("hey Elix!", "Elix")).toBe(true);
    expect(isGreetingFor("hello elix, you there?", "Elix")).toBe(true);
    expect(isGreetingFor("yo Elix", "Elix")).toBe(true);
    expect(isGreetingFor("sup Elix", "Elix")).toBe(true);
  });

  it("does NOT match substrings of other words", () => {
    // These all contain "hi" as a substring — the old includes() bug.
    expect(isGreetingFor("this ship", "Elix")).toBe(false);
    expect(isGreetingFor("chill out", "Elix")).toBe(false);
    expect(isGreetingFor("which one", "Elix")).toBe(false);
    expect(isGreetingFor("while i was away", "Elix")).toBe(false);
    expect(isGreetingFor("him and her", "Elix")).toBe(false);
  });

  it("requires the bot's real username as a whole word", () => {
    expect(isGreetingFor("hi everyone", "Elix")).toBe(false);
    expect(isGreetingFor("hi Elixir", "Elix")).toBe(false); // Elix inside Elixir
    expect(isGreetingFor("hi my elix", "Elix")).toBe(true);
  });

  it("handles a regex-special username safely", () => {
    // A username like "A.B" must not become a wildcard.
    expect(isGreetingFor("hi A.B", "A.B")).toBe(true);
    expect(isGreetingFor("hi AxB", "A.B")).toBe(false);
  });

  it("is case-insensitive on the username", () => {
    expect(isGreetingFor("HI ELIX", "Elix")).toBe(true);
  });

  it("returns a greeting from the day list at 08:00 and the night list at 22:00", () => {
    // Both lists are non-empty and disjoint in tone; just assert membership.
    const day = greetingFor(true);
    const night = greetingFor(false);
    expect(day.length).toBeGreaterThan(0);
    expect(night.length).toBeGreaterThan(0);
    expect(typeof day).toBe("string");
    expect(typeof night).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// A17 — bus events
// ---------------------------------------------------------------------------

describe("A17 — the bot emits typed bus events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bus.removeAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits bot:joined on spawn with the server brand", async () => {
    const h = harness();
    const seen: unknown[] = [];
    bus.on("bot:joined", (info) => seen.push(info));
    await h.session.start();
    h.bots[0]!.spawn();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ username: "Elix", serverBrand: "Paper", protocol: 776 });
  });

  it("emits bot:chat for every player message but not our own", async () => {
    const h = harness();
    const seen: Array<{ username: string; text: string }> = [];
    bus.on("bot:chat", (m) => seen.push(m));
    await h.session.start();
    const bot = h.bots[0]!;
    bot.emit("chat", "Ali", "hi elix");
    bot.emit("chat", "Elix", "my own message");
    expect(seen).toEqual([{ username: "Ali", text: "hi elix" }]);
  });

  it("emits bot:kicked with the classified kind", async () => {
    const h = harness();
    const seen: Array<{ kind: string }> = [];
    bus.on("bot:kicked", (info) => seen.push({ kind: info.kind }));
    await h.session.start();
    h.bots[0]!.kick({ type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.banned" } } });
    expect(seen).toEqual([{ kind: "ban" }]);
  });

  it("emits bot:left with willRetry false for permanent, true for transient", async () => {
    // Two separate sessions: one permanent stop, one transient drop.
    const permanentRun = harness();
    const transientRun = harness();
    const seen: Array<{ kind: string; willRetry: boolean }> = [];
    bus.on("bot:left", (info) => seen.push({ kind: info.kind, willRetry: info.willRetry }));

    await permanentRun.session.start();
    permanentRun.bots[0]!.kick({
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
    });
    permanentRun.bots[0]!.end("socketClosed");

    await transientRun.session.start();
    transientRun.bots[0]!.kick({
      type: "compound",
      value: { text: { type: "string", value: "Kicked by an operator" } },
    });
    transientRun.bots[0]!.end("socketClosed");

    expect(seen).toEqual([
      { kind: "whitelist", willRetry: false },
      { kind: "kick", willRetry: true },
    ]);
  });

  it("a throwing listener does not break the bot", async () => {
    const h = harness();
    bus.on("bot:chat", () => {
      throw new Error("listener exploded");
    });
    await h.session.start();
    expect(() => h.bots[0]!.emit("chat", "Ali", "hi elix")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A15 — shutdown robustness
// ---------------------------------------------------------------------------

describe("A15 — shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bus.removeAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the goodbye when the bot never spawned", async () => {
    const h = harness();
    await h.session.start();
    const bot = h.bots[0]!;
    bot.entity = undefined; // not in-game
    await h.session.shutdown();
    expect(bot.quitCount).toBe(0);
    expect(h.logs.info).toHaveBeenCalledWith("bot not in-game — skipping goodbye");
  });

  it("does not wait when there is no bot at all", async () => {
    const h = harness();
    const start = Date.now();
    await h.session.shutdown();
    expect(Date.now() - start).toBe(0);
  });

  it("quit()s a live bot and finishes when 'end' arrives", async () => {
    const h = harness();
    await h.session.start();
    const bot = h.bots[0]!;
    bot.spawn();

    const p = h.session.shutdown();
    // Drive the bounded goodbye flush, then the synchronous quit.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bot.quitCount).toBe(1);

    await p;
  });

  it("gives up on a clean quit after 3 s rather than hanging", async () => {
    const h = harness();
    await h.session.start();
    const bot = h.bots[0]!;
    bot.spawn();
    // A server that never answers the quit — shutdown must still resolve.
    bot.silentQuit = true;

    const p = h.session.shutdown();
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(p).resolves.toBeUndefined();
    expect(h.logs.warn).toHaveBeenCalledWith("end event timeout — giving up on a clean quit");
  });
});