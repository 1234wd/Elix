/**
 * Round 15 Part C — follow / come / stop, at BotSession level.
 *
 * NEW RULE FOR THE PROJECT, and this file exists because of it: every feature that reads
 * the live game gets at least one test built from mineflayer-SHAPED data. In Round 13,
 * hand-built objects proved the policy correct while every live input was wrong — the
 * players had a `position` property that mineflayer's `Player` does not have, so nothing
 * fired in a real server and thirteen tests passed.
 *
 * So every player below is `{ username, entity: { position } }`, exactly as mineflayer types
 * it, and the fake pathfinder RECORDS `setGoal` and `stop` rather than asserting on them
 * after the fact.
 *
 * Zero network. The chat model is a fake and the classification says `none`, so the only
 * thing under test is the movement and the safety order.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import {
  BotSession,
  FOLLOW_TICK_MS,
  type BlockLike,
  type BotLike,
  type SessionDeps,
  type Vec3Like,
} from "../../src/connection/bot.js";
import { FollowController, TARGET_LOST_MS, realGoalFactory } from "../../src/actions/follow.js";
import { allCommandForms, parseCommand } from "../../src/actions/commands.js";
import { bus } from "../../src/core/events.js";
import type { ElixConfig } from "../../src/core/config.js";
import type { SayQueue } from "../../src/social/say.js";

const HERE = { x: 0, y: 65, z: 0 };

/** A mineflayer Player. The position is on `entity`, and `entity` may be undefined. */
function mineflayerPlayer(name: string, x: number, y = 65, z = 0, health = 20) {
  return { username: name, uuid: `u-${name}`, ping: 30, gamemode: 0, health, entity: { position: { x, y, z } } };
}

interface FakePathfinder {
  setGoal: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
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
    // Off, so initiative cannot blur what the command did.
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
  entity: { position: Vec3Like; yaw: number } | undefined = { position: { ...HERE }, yaw: 0 };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  players: Record<string, unknown> = {};
  chatCalls: string[] = [];
  pathfinder: FakePathfinder;
  hazard = false;
  _client = { on: () => {} };
  constructor(pf: FakePathfinder) {
    super();
    this.pathfinder = pf;
  }
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  blockAt(p: Vec3Like): BlockLike | null {
    if (this.hazard) return { name: "lava", id: 8 };
    return p.y < 65 ? { name: "stone", id: 1 } : { name: "air", id: 0 };
  }
  loadPlugin(): void {}
  look(): void {}
}

interface Harness {
  s: BotSession;
  bots: FakeBot[];
  pf: FakePathfinder;
  sayLines: string[];
}

/**
 * A bridge that claims a few weeks of chat and always answers "not a crisis".
 *
 * `gateScriptedReply` records every acknowledgement it is asked about, which is how the
 * tests prove that a command's ack goes through the SAME gate as any reply.
 */
function harness(players: Record<string, unknown>, options: { gateBlocks?: boolean } = {}): Harness {
  const bots: FakeBot[] = [];
  const pf: FakePathfinder = { setGoal: vi.fn(), stop: vi.fn() };
  const sayLines: string[] = [];
  const ownGated: string[] = [];
  const gated: Array<{ sender: string; message: string }> = [];
  const bridge = {
    handle: vi.fn(async () => ({ replied: false, reason: "not-addressed" })),
    recordScripted: vi.fn(),
    gateScriptedReply: vi.fn(async (sender: string, message: string) => {
      gated.push({ sender, message });
      return options.gateBlocks === true;
    }),
    gateOwnLine: vi.fn(async (sender: string) => {
      ownGated.push(sender);
      return false;
    }),
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
      const b = new FakeBot(pf);
      b.players = { Elix: mineflayerPlayer("Elix", 0), ...players };
      bots.push(b);
      return b;
    },
    onPermanentDisconnect: () => {},
    exitOnPermanent: false,
    chatBridge: bridge,
  } as unknown as SessionDeps;
  const h: Harness = {
    s: new BotSession(deps),
    bots,
    pf,
    sayLines,
  };
  (h as unknown as { gated: typeof gated }).gated = gated;
  (h as unknown as { ownGated: string[] }).ownGated = ownGated;
  return h;
}

async function spawn(h: Harness, name: string, line: string, wait = 3_000): Promise<void> {
  h.bots[0]!.emit("chat", name, line);
  await vi.advanceTimersByTimeAsync(wait);
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 5, 12, 0, 0) });
  bus.removeAll();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * The four calls mineflayer-pathfinder 2.4.5 makes on a goal every physicsTick.
 *
 * Copied from the library's own index.js, because the point of the contract test is that
 * these four calls work on whatever the controller built - not that the controller's intent
 * object is shaped the way the intent object was.
 */
function exerciseGoalLikeThePathfinder(goal: unknown): void {
  const g = goal as {
    isValid: () => boolean;
    hasChanged: () => boolean;
    heuristic: (n: unknown) => number;
    isEnd: (n: unknown) => boolean;
  };
  const node = new Vec3(0, 65, 0);
  g.isValid();
  g.hasChanged();
  g.heuristic(node);
  g.isEnd(node);
}

/* ---------------------------------------------------------------- the parser */

describe("C — the command list is one auditable table", () => {
  it("every form resolves to one of three actions", () => {
    const forms = allCommandForms();
    expect(forms.length).toBeGreaterThanOrEqual(15);
    for (const [, form] of forms) {
      expect(["follow", "come", "stop"], form).toContain(parseCommand(form)?.action);
    }
  });

  it("whole words only: 'i stopped by the river' is not a command", () => {
    // A substring search makes a bot that reacts to conversation.
    expect(parseCommand("i stopped by the river")).toBeNull();
    expect(parseCommand("she was waiting for the bus")).toBeNull();
    expect(parseCommand("following the redstone is hard")).toBeNull();
  });

  it("finds a command inside a longer addressed line", () => {
    expect(parseCommand("elix follow me please")?.action).toBe("follow");
    expect(parseCommand("elix can you come here")?.action).toBe("come");
    expect(parseCommand("elix wait")?.action).toBe("stop");
  });

  it("the Roman Urdu forms the owner asked for are all present and work", () => {
    for (const [text, action] of [
      ["ruko", "stop"],
      ["ruk", "stop"],
      ["idhar aao", "come"],
      ["mere peeche aao", "follow"],
      ["mere peeche chalo", "follow"],
      ["same reh jao", "stop"],
    ] as const) {
      expect(parseCommand(text)?.action, text).toBe(action);
    }
  });

  it("the longest matching form wins", () => {
    // "come here" is longer than "come", and both mean the same thing, so this is really
    // a check that the longest-form rule does not prefer a shorter prefix.
    expect(parseCommand("elix come here")?.matched).toBe("come here");
  });
});

/* ------------------------------------------------------------ the controller */

describe("C — the controller, with REAL pathfinder goals", () => {
  const pf = () => ({ setGoal: vi.fn(), stop: vi.fn() });
  // U1: the library's own goals, not a description of them. A fake goal factory is exactly
  // what shipped in Round 15 and it accepted an object the real pathfinder throws on.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const goals = realGoalFactory(() => require("mineflayer-pathfinder") as never);
  /** A mineflayer-shaped entity, because GoalFollow reads `entity.position` on construction. */
  const TARGET = { username: "Steve", position: new Vec3(5, 65, 0), isValid: true, height: 1.8 };
  const controller = (p: ReturnType<typeof pf>, now = () => 1000): FollowController =>
    new FollowController(p, now, goals);

  it("stop is synchronous and clears the goal with one call", () => {
    const p = pf();
    const c = controller(p);
    c.follow(TARGET, "Steve");
    expect(c.busy).toBe(true);
    c.stop();
    // No await anywhere on this path. A stop that can be delayed is not a stop.
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect(c.busy).toBe(false);
  });

  it("follow builds a REAL GoalFollow on the live entity at 2-3 blocks", () => {
    const p = pf();
    const c = controller(p);
    const entity = { position: new Vec3(5, 65, 0), isValid: true, height: 1.8 };
    expect(c.follow(entity, "Steve").ok).toBe(true);
    const goal = p.setGoal.mock.calls[0]?.[0] as { rangeSq?: number };
    // The library's own class, so the four per-tick calls exist. This is the assertion
    // Round 15 could not make, because it never built a real goal.
    expect(typeof (goal as { isValid?: unknown }).isValid).toBe("function");
    // GoalFollow stores rangeSq, not distance. Asserting on our own field name is how
    // Round 15 got a green test for a goal the library could not run.
    expect(goal.rangeSq).toBe(9);
    expect(() => exerciseGoalLikeThePathfinder(goal)).not.toThrow();
  });

  it("follow is REFUSED, not queued, when the target is untracked", () => {
    // mineflayer drops `entity` out of range. A follow that silently does nothing while
    // looking like it works is worse than an honest refusal.
    const p = pf();
    const c = controller(p);
    expect(c.follow(null, "Steve")).toEqual({ ok: false, reason: "target-not-tracked" });
    expect(p.setGoal).not.toHaveBeenCalled();
  });

  it("gives up when the target leaves", () => {
    const p = pf();
    const c = controller(p);
    c.follow(TARGET, "Steve");
    expect(c.tick(null, false)).toBe(false);
    expect(c.current.endedBecause).toBe("target-gone");
    expect(p.stop).toHaveBeenCalled();
  });

  it("gives up when the target dies", () => {
    const p = pf();
    const c = controller(p);
    c.follow(TARGET, "Steve");
    const done = c.tick({ name: "Steve", position: { x: 1, y: 65, z: 0 }, alive: false }, false);
    expect(done).toBe(false);
    expect(c.current.endedBecause).toBe("target-died");
  });

  it("survives a brief loss of the entity, then gives up", () => {
    let now = 1000;
    const p = pf();
    const c = controller(p, () => now);
    c.follow({ position: new Vec3(1, 65, 0), isValid: true }, "Steve");
    const untracked = { name: "Steve", position: undefined, alive: true };
    now += TARGET_LOST_MS - 1000;
    expect(c.tick(untracked, false)).toBe(true); // round a hill
    now += 2000;
    expect(c.tick(untracked, false)).toBe(false); // gone
    expect(c.current.endedBecause).toBe("target-lost");
  });

  it("HAZARDS WIN over following, always", () => {
    // The reason for following is not worth a lava pool.
    const p = pf();
    const c = controller(p);
    c.follow(TARGET, "Steve");
    const alive = { name: "Steve", position: { x: 1, y: 65, z: 0 }, alive: true };
    expect(c.tick(alive, true)).toBe(false);
    expect(c.current.endedBecause).toBe("hazard");
    expect(p.stop).toHaveBeenCalled();
  });

  it("come builds a REAL GoalNear at where they were, not a standing follow", () => {
    const p = pf();
    const c = controller(p);
    expect(c.come({ x: 9, y: 65, z: -3 }).ok).toBe(true);
    const goal = p.setGoal.mock.calls[0]?.[0] as { x?: number; y?: number; z?: number };
    expect(goal.x).toBe(9);
    expect(goal.y).toBe(65);
    expect(goal.z).toBe(-3);
    expect(() => exerciseGoalLikeThePathfinder(goal)).not.toThrow();
    c.arrive();
    expect(c.busy).toBe(false);
    expect(c.current.endedBecause).toBe("arrived");
  });

  it("stop with no pathfinder still clears the state", () => {
    // Nothing may be left believing it is following.
    const c = new FollowController(null, () => 1000, goals);
    expect(() => c.stop()).not.toThrow();
    expect(c.busy).toBe(false);
  });
});

/* --------------------------------------------------------------- BotSession */

describe("C — BotSession, with mineflayer-shaped players", () => {
  it("an OWNER saying 'elix follow me' sets GoalFollow on that player's entity", async () => {
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);

    await spawn(h, "ElixOwner", "elix follow me");

    expect(h.pf.setGoal).toHaveBeenCalledTimes(1);
    // A REAL mineflayer-pathfinder GoalFollow, which is the whole of Round 16's U1: the old
    // plain object had no isValid(), so the library threw on the next physicsTick.
    const goal = h.pf.setGoal.mock.calls[0]?.[0] as { entity?: { position?: unknown }; rangeSq?: number; isValid?: () => boolean };
    expect(typeof goal.isValid).toBe("function");
    expect(goal.rangeSq).toBe(9);
    // The goal holds the LIVE ENTITY, read through the mineflayer path. Round 13 read
    // `player.position`, which does not exist, so this never fired in a real server.
    expect((goal.entity as { position?: unknown } | undefined)?.position).toMatchObject({ x: 4, y: 65, z: 0 });
  });

  it("the acknowledgement goes through gateOwnLine and is NEVER classified", async () => {
    // Round 16 U5. The old version asserted that the ack went through gateScriptedReply,
    // which was the bug: that call CLASSIFIES the line it is handed as the sender's own
    // words, so "on my way" was filed as a safety record against the owner for something
    // they never said. Elix's own words use gateOwnLine, which waits for what that player
    // is already owed and classifies nothing.
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);

    await spawn(h, "ElixOwner", "elix follow me");

    const gated = (h as unknown as { gated: Array<{ sender: string; message: string }> }).gated;
    const own = (h as unknown as { ownGated: string[] }).ownGated;
    expect(own, "gateOwnLine was not consulted for the acknowledgement").toEqual(["ElixOwner"]);
    // And nothing Elix said was ever handed to the classifier as the owner's words.
    expect(gated).toEqual([]);
  });

  it("'elix stop' clears the goal within ONE TICK, even mid-reply", async () => {
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);
    await spawn(h, "ElixOwner", "elix follow me");
    expect(h.pf.setGoal).toHaveBeenCalled();

    h.pf.stop.mockClear();
    h.bots[0]!.emit("chat", "ElixOwner", "elix stop");
    // No wait for a provider, an audit or the SayQueue. One tick is the whole budget.
    await vi.advanceTimersByTimeAsync(FOLLOW_TICK_MS);

    expect(h.pf.stop).toHaveBeenCalled();
  });

  it("a NON-OWNER is refused politely and NOTHING moves", async () => {
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4), Stranger: mineflayerPlayer("Stranger", 2) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);

    // 5 s, not 3: the greeting on spawn was sent at t=2 s and safety.chatRateLimitPer2s is
    // 1, so the refusal is deferred to the next window. The wait is the rate limit, not the
    // code path.
    await spawn(h, "Stranger", "elix follow me", 5_000);

    expect(h.pf.setGoal).not.toHaveBeenCalled();
    expect(h.pf.stop).not.toHaveBeenCalled();
    expect(h.bots[0]!.chatCalls.join(" ")).toMatch(/can't do that one/i);
    // And it does not say WHY, because saying why tells a stranger which rule to look for.
    expect(h.bots[0]!.chatCalls.join(" ")).not.toMatch(/owner|list|allowed/i);
  });

  it("'elix follow me, i want to die' gets the wellbeing reply and NO goal", async () => {
    // The safety order: the floor matched, so handleChat never reaches the command path.
    // A bot that follows a child towards a bridge because the sentence also contained
    // "follow me" is the worst possible outcome of this feature.
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    const wellbeingSaid: string[] = [];
    (h.s as unknown as { deps: { chatBridge: Record<string, unknown> } }).deps.chatBridge.handle = vi.fn(
      async (_s: string, _m: string, say?: SayQueue) => {
        say?.say("i'm here and i'm listening. please talk to someone you trust right now.", true, true);
        return { replied: true, reason: "wellbeing-crisis", text: "care" };
      },
    );
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);

    h.bots[0]!.emit("chat", "ElixOwner", "elix follow me, i want to die");
    await vi.advanceTimersByTimeAsync(3_000);

    wellbeingSaid.push(h.bots[0]!.chatCalls.join(" | "));
    expect(h.pf.setGoal).not.toHaveBeenCalled();
    expect(h.pf.stop).not.toHaveBeenCalled();
    expect(wellbeingSaid[0]).toMatch(/talk to someone you trust/i);
  });

  it("the target leaving stops the follow, with no further command", async () => {
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);
    await spawn(h, "ElixOwner", "elix follow me");
    expect(h.pf.setGoal).toHaveBeenCalled();

    h.pf.stop.mockClear();
    // They log off: mineflayer removes the player entry entirely.
    delete h.bots[0]!.players.ElixOwner;
    await vi.advanceTimersByTimeAsync(FOLLOW_TICK_MS * 2);

    expect(h.pf.stop).toHaveBeenCalled();
  });

  it("a hazard under Elix cancels the follow without a command", async () => {
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);
    await spawn(h, "ElixOwner", "elix follow me");
    expect(h.pf.setGoal).toHaveBeenCalled();

    h.pf.stop.mockClear();
    h.bots[0]!.hazard = true; // lava under his feet
    await vi.advanceTimersByTimeAsync(FOLLOW_TICK_MS * 2);

    expect(h.pf.stop).toHaveBeenCalled();
  });

  it("wandering is paused while following and resumes after stop", async () => {
    // "Busy" is what initiative and wandering both ask, and following IS a task.
    const h = harness({ ElixOwner: mineflayerPlayer("ElixOwner", 4) });
    await h.s.start();
    h.bots[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(3_000);
    await spawn(h, "ElixOwner", "elix follow me");

    const controller = (h.s as unknown as { follow: FollowController }).follow;
    expect(controller.busy).toBe(true);

    await spawn(h, "ElixOwner", "elix stop");
    expect(controller.busy).toBe(false);
  });
});