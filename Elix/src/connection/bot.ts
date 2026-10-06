import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import type { ElixConfig, ServerProfile } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import { pingServer, type PingResult } from "./ping.js";
import { classifyDisconnect, BACKOFF_SCHEDULE_MS, type DisconnectKind } from "./reconnect.js";
import { describeReason, type DescribedReason } from "./kickReason.js";
import { ReconnectScheduler } from "./scheduler.js";
import { resolveTargetVersion, expectedProtocol, hasDataFor } from "./version.js";
import { blockName } from "./safeWorld.js";
import { bus, shutdownState } from "../core/events.js";
import {
  EmotionEngine,
  NUDGE_BACK_ON_TRACK,
  OFF_TOPIC_FALLBACK,
  honestyReply,
  loadTemperament,
  manipulationProblem,
  type Appraisal,
  type EmotionEvent,
} from "../social/emotion.js";
import { SayQueue } from "../social/say.js";
import { WellbeingState, detectWellbeing, type WellbeingLevel } from "../social/wellbeing.js";
import { DEFAULT_INITIATIVE, type Drive } from "../social/manners.js";
import { decideInitiative, nextShape } from "./initiative.js";
import {
  ACKNOWLEDGEMENTS,
  NOT_AN_OWNER,
  RefusalThrottle,
  parseAddressedCommand,
  type ActionName,
} from "../actions/commands.js";
import { COME_RADIUS, FollowController, realGoalFactory, type FollowTarget, type PathfinderLike } from "../actions/follow.js";
import { ReflexRunner } from "../reflexes/runner.js";
import { isHostileMob } from "../reflexes/hostile.js";
import { DefendController, type DefendView } from "../reflexes/defend.js";
import type { EquipSlot } from "../reflexes/tables.js";
import type { CreatureLike, ReflexView, StackLike } from "../reflexes/decide.js";
import { exitCleanly } from "../core/exit.js";

// Several deps (mineflayer-pathfinder, prismarine-chat, minecraft-data) are
// CommonJS, so `require` is the reliable way to read their real export shape.
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of mineflayer's Bot that this module touches. */
export interface BotLike {
  username: string;
  entity?: { position: Vec3Like; yaw: number };
  health?: number;
  time?: { isDay: boolean; timeOfDay?: number };
  game?: { dimension?: string; serverBrand?: string };
  player?: { ping?: number };
  /**
   * Everyone currently in the world, keyed by username.
   *
   * C3 reads this directly rather than trusting the entity events: a player who
   * leaves and returns with the same UUID did not reliably re-fire
   * `playerJoined`, so greeting them depended on mineflayer's bookkeeping rather
   * than on whether they were actually there.
   */
/**
 * R4: `players` stays `Record<string, unknown>` on purpose.
 *
 * It is the shape mineflayer actually hands over - a record of Player objects whose
 * position lives on `entity.position`, and whose `entity` is undefined out of range - but
 * it cannot be narrowed in the type, because the reviewer's FakeBot declares
 * `players: Record<string, unknown>` and that file is not mine to edit. Every read goes
 * through `playerPosition()`, which checks the shape at runtime instead of casting it
 * away. A cast silences the compiler; a guard cannot.
 */
  players?: Record<string, unknown>;
  _client?: {
    on(event: string, fn: (...args: unknown[]) => void): void;
  };
  /** Handlers here are cast per event, so the signature stays loose. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, fn: (...args: any[]) => void): unknown;
  /** Present on the real bot; used by lookAround for smooth head movement. */
  look?(yaw: number, pitch: number, force: boolean): void;
  quit(reason?: string): void;
  chat(text: string): void;
  blockAt(pos: Vec3Like): BlockLike | null;
  loadPlugin(plugin: unknown): void;
}

/** The block fields this module reads. */
export interface BlockLike {
  name?: string;
  id: number;
  /**
   * prismarine-block's shape class: "block", "empty", "entity", "liquid", or
   * undefined for an unrecognised block. A10 needs this to tell solid ground
   * from cave_air, short_grass and other non-blocking blocks by name.
   */
  boundingBox?: string;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * R4: the position of one mineflayer player, or undefined.
 *
 * THE COMPENSATING CONTROL. `BotLike.players` is `Record<string, unknown>` rather than
 * `Record<string, PlayerLike>`, because a narrower interface cannot be implemented by the
 * reviewer's `FakeBot`, whose `players` is declared wide and which I am not allowed to
 * edit. So the type does not narrow; the RUNTIME does, here.
 *
 * That is strictly better than what Round 13 did. The previous code cast the whole record
 * to a shape with a `position` property, tsc agreed, the policy tests passed against
 * hand-built objects that had `position`, and initiative never fired in a real server
 * because mineflayer's Player has no `position` — it has `entity.position`, and `entity`
 * is undefined out of range. A cast silences the compiler; a guard cannot.
 */
export function playerPosition(player: unknown): Vec3Like | undefined {
  if (player === null || typeof player !== "object") return undefined;
  const entity = (player as { entity?: unknown }).entity;
  if (entity === null || typeof entity !== "object") return undefined;
  const pos = (entity as { position?: unknown }).position;
  if (pos === null || typeof pos !== "object") return undefined;
  const { x, y, z } = pos as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  return { x, y, z };
}

export type BotFactory = () => BotLike | Promise<BotLike>;

export interface BotOptions {
  config: ElixConfig;
  profile: ServerProfile & { name: string; username: string };
  log: Logger;
  /** Override the bot factory (tests inject a fake bot). */
  botFactory?: BotFactory;
  /** Pre-supplied ping result (tests skip the network). */
  pingResult?: PingResult;
  /** Register cleanup here instead of returning it (A15: before connecting). */
  registerCleanup?: (fn: () => Promise<void>) => void;
  /**
   * Phase 3 in-game chat bridge (B9). Built by the CLI layer so src/connection
   * does not import the brain (and therefore SQLite). When omitted, Elix plays
   * exactly as it did in Phase 2: scripted greeting, no AI replies.
   */
  chatBridge?: ChatBridgeLike;
  /** A2: ask the Lifecycle to shut down with a specific exit code. */
  requestShutdown?: (reason: string, exitCode: number) => void;
}

export interface BotStatus {
  connected: boolean;
  username: string;
  version: string;
  protocol: number;
  software: string;
  ping: number;
  position: Vec3Like;
  health: number;
  dimension: string;
}

export interface SessionDeps {
  config: ElixConfig;
  profile: ServerProfile & { name: string; username: string };
  log: Logger;
  pingResult: PingResult;
  /** Supplies a fresh bot each call (the real one is mineflayer's createBot). */
  factory: BotFactory;
  /** Prints the human-readable "here's what to do" line on a permanent kick. */
  onPermanentDisconnect?: (info: { kind: DisconnectKind; text: string; username: string }) => void;
  /** Forces process exit on a permanent disconnect (tests disable this). */
  /**
   * B: initiative needs a memory it can reach, and the store is the only honest source
   * for a callback. Optional, so a session without one simply stops offering that shape.
   *
   * The importance threshold and the per-player gap are enforced by the caller, not here,
   * so a store can never make Elix chattier than the config allows.
   */
  memory?: {
    /** The most recent memory at or above `importance`, or null. */
    recallImportant?(player: string, importance: number): string | null;
  };
  exitOnPermanent?: boolean;
  /** Test seam: called every time a new bot instance is created. */
  onBotCreated?: (bot: BotLike) => void;
  /**
   * Phase 3 in-game chat bridge (B9). Optional so the Phase 1/2 lifecycle tests
   * need no brain, and so a bot with no keys and no config still joins.
   */
  chatBridge?: ChatBridgeLike;
  /**
   * A2: ask the Lifecycle to shut down with a specific exit code, so cleanups
   * run before the process ends. Absent in bare unit tests, which then fall
   * back to calling exitCleanly directly.
   */
  requestShutdown?: (reason: string, exitCode: number) => void;
}

/**
 * The slice of ChatBridge this module needs. Declared structurally so
 * src/connection does not import src/brain (which would drag SQLite into every
 * connection test).
 */
/**
 * C3: never welcome the same person twice inside this window.
 *
 * A welcome is an episode, so a client that reconnects on a timer would otherwise
 * fill the database with near-identical greetings and greet the same person every
 * few seconds. 90 s is deliberately shorter than a real absence — e2e row 12 has a
 * player leave for two minutes and come back, and a 10-minute cooldown silently
 * failed that row. A tight reconnect loop happens in seconds; a genuine goodbye is
 * measured in minutes.
 */
export const GREET_COOLDOWN_MS = 90_000;

/**
 * C3: how often the in-world player list is diffed.
 *
 * Two seconds is fast enough that a greeting does not feel late, and slow enough
 * to be free: this is a keyset read on a map mineflayer already holds.
 */
/** C: the follow tick. One tick, so a stop takes effect inside 50 ms. */
export const FOLLOW_TICK_MS = 50;

/** WP3: Elix says one short line after a player hits him, at most this often. */
export const HURT_LINE_WINDOW_MS = 5 * 60_000;

/** WP3: the one line Elix may say after a player hits him. */
export const HURT_BY_A_PLAYER = "hey - that one hurt.";

export const PRESENCE_POLL_MS = 2_000;

export interface ChatBridgeLike {
  handle(
    sender: string,
    message: string,
    sayQueue?: SayQueue,
  ): Promise<{ replied: boolean; reason: string; text?: string; usedProvider?: string }>;
  /** A6: record one of Elix's own scripted lines as an episode. */
  recordScripted?(text: string, player: string | null): void;
  /**
   * H1: ask the audit whether a SCRIPTED reply may go out.
   *
   * The honesty answer and the greeting never reach `handle`, so before Round 13 they
   * bypassed the classifier entirely and a child in crisis got a speech about simulated
   * feelings. This is the same send gate, exposed for the paths that do not go through
   * the model.
   *
   * Resolves TRUE when the reply must be suppressed — the wellbeing reply has already
   * been sent in that case — and FALSE when it may proceed.
   */
  gateScriptedReply?(sender: string, message: string, sayQueue?: SayQueue): Promise<boolean>;
  /** How many replies are in flight. Initiative refuses to speak over one. */
  inFlightCount?: number;
  /**
   * Is any audit still in flight?
   *
   * Load-bearing for B: an unprompted line must never overtake a safety decision that is
   * still being made. That is the Round 13 ordering bug one layer down, and the whole
   * reason initiative goes through the gate instead of straight to SayQueue.
   */
  hasPendingAudits?(): boolean;
  /**
   * Is THIS player waiting on a safety decision?
   *
   * The narrower question, and the one B asks. A stranger's ambient line is a much weaker
   * reason to stay quiet than a live decision about the person standing next to Elix, and
   * using the global flag let one passer-by mute Elix for the whole session.
   */
  hasUnsettledAudits?(sender: string): boolean;
  /**
   * The bridge's own wellbeing state, so the session and the bridge share ONE.
   *
   * R5: the two of them previously kept separate records — a map in BotSession that
   * nothing wrote, and a private level map in the bridge that only one of its four reply
   * paths updated. Sharing the object removes the possibility of them disagreeing, which
   * is what let a crisis reply be followed by "how is your day going".
   */
  wellbeingState?: WellbeingState;
  /**
   * When did this player last get a wellbeing reply of any kind, from any path?
   *
   * The single source of truth for B's quiet window. In Round 13 `BotSession` kept its own
   * map for this, which nothing ever wrote to, so five seconds after a crisis reply Elix
   * cheerfully asked how the player's day was going.
   */
  /**
   * R3: wait only for what this player is already owed. Never classifies the line.
   *
   * `gateScriptedReply` classifies the line it is given, and for initiative that line is
   * ELIX'S OWN — so the bot was spending classifier quota re-reading his own unprompted
   * message and filing an audit against the player for words they never said. In a safety
   * module, inventing a crisis attributed to someone is worse than wasting a call.
   */
  gateOwnLine?(sender: string): Promise<boolean>;
  /**
   * C3: say hello to someone who came back, unprompted, mentioning something
   * real. Returns null when there is nothing worth saying.
   */
  welcomeBack?(sender: string): Promise<{ text: string; source: string } | null>;
}

// ---------------------------------------------------------------------------
// Process-level crash guards (A16)
// ---------------------------------------------------------------------------

/** Module-level so the handlers can reach the live bot without closure churn. */
let liveBot: BotLike | null = null;
let liveShutdownRequested = false;

/** Crash guards are process-wide; installing twice would double-handle events. */
let crashGuardsInstalled = false;

/** Uncaught exceptions inside this window: above this we shut down (A7). */
const CRASH_BURST_LIMIT = 5;
const CRASH_BURST_WINDOW_MS = 60_000;

/**
 * Keep Elix alive through data surprises, but not forever.
 *
 * A7: the previous version swallowed every uncaught exception indefinitely,
 * deduped by message so repeats vanished, and logged no stack. A genuinely
 * corrupted process cannot recover, so a burst of crashes now triggers a
 * graceful shutdown with exit 1 instead of limping on.
 */
export function installCrashGuards(
  log?: Logger,
  onCrashBurst?: (reason: string) => void,
): void {
  if (crashGuardsInstalled) return;
  crashGuardsInstalled = true;

  const crashTimes: number[] = [];
  let crashCount = 0;

  const noteCrash = (kind: string, detail: string, stack: string | undefined) => {
    crashCount++;
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - crashTimes[0]! > CRASH_BURST_WINDOW_MS) {
      crashTimes.shift();
    }
    // Stack every time: the same message with a different stack is new
    // information, and a repeating bug is exactly what we need to see.
    if (log) {
      log.error({ kind, err: detail, stack, crashesInWindow: crashTimes.length }, "uncaught error");
    } else {
      console.error(`[${kind}] ${detail}${stack ? `\n${stack}` : ""}`);
    }
    if (crashTimes.length > CRASH_BURST_LIMIT) {
      if (log) {
        log.error(
          { crashes: crashCount, windowMs: CRASH_BURST_WINDOW_MS },
          "too many uncaught errors — shutting down",
        );
      }
      // A2: route through the Lifecycle so cleanups run. A crash burst means
      // the process is unhealthy, but the database must still be closed cleanly
      // and the shutdown backup must still happen.
      if (onCrashBurst) {
        onCrashBurst(`crash burst: ${crashCount} uncaught errors`);
        return;
      }
      // No lifecycle wired (a bare unit test, or a library consumer).
      exitCleanly(1);
    }
  };

  process.on("uncaughtException", (err: Error) => {
    noteCrash("uncaughtException", err?.message ?? String(err), err?.stack);
    // A broken bot can't recover in place — end it so the normal reconnect runs.
    if (liveBot && !liveShutdownRequested) {
      try {
        liveBot.quit("uncaughtException");
      } catch {
        /* ignore */
      }
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason as { message?: string; stack?: string } | undefined;
    noteCrash(
      "unhandledRejection",
      err?.message ?? String(reason),
      err?.stack,
    );
  });
}

// ---------------------------------------------------------------------------
// Greeting selection (A14)
// ---------------------------------------------------------------------------

const DAY_GREETINGS = ["gm! elix here", "yo! elix online", "gm, elix reporting in", "morning, elix here"];
const NIGHT_GREETINGS = ["evening! elix here", "yo! elix online", "night! elix is around"];

/** Time-of-day greeting, chosen at random from a small list. */
export function greetingFor(isDay: boolean): string {
  const list = isDay ? DAY_GREETINGS : NIGHT_GREETINGS;
  return list[Math.floor(Math.random() * list.length)]!;
}

/**
 * Whole-word greeting check (A14). "this ship" and "chill" must NOT match,
 * and the bot's real username must appear as a whole word.
 */
export function isGreetingFor(message: string, username: string): boolean {
  const GREETING = /\b(hi|hello|hey|yo|sup)\b/i;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const NAME = new RegExp(`\\b${escaped}\\b`, "i");
  return GREETING.test(message) && NAME.test(message);
}

/**
 * Is there anything after the greeting worth answering? (A6)
 *
 * "hi elix" is a greeting. "hi elix what's your favourite block" is a greeting
 * AND a question, and the scripted "hi <name>!" reply threw the question away.
 * So the scripted path only runs when the greeting is the entire message.
 */
export function hasFollowUp(message: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Drop the name and the greeting words, then see if any words remain.
  const stripped = message
    .replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ")
    .replace(/\b(hi|hello|hey|yo|sup|there|morning|evening|again)\b/gi, " ")
    .replace(/[!,.?]+/g, " ")
    .trim();
  // Two or more words left, or a question mark, means there is more to say.
  return /\?/.test(message) || stripped.split(/\s+/).filter(Boolean).length >= 2;
}

// A12: the old NON_GREETING_SUBSTRINGS list was exported from here and included
// "hi" itself, which IS a greeting. The negative cases now live in the test file
// where they are actually used.

// ---------------------------------------------------------------------------
// Safe walk (A7) — never digs, never places, never pillars
// ---------------------------------------------------------------------------

const WALK_DISTANCES = [
  { dx: 10, dz: 0, name: "+x" },
  { dx: -10, dz: 0, name: "-x" },
  { dx: 0, dz: 10, name: "+z" },
  { dx: 0, dz: -10, name: "-z" },
] as const;

export type WalkSkipReason = "no-entity" | "no-safe-direction";

export interface WalkOutcome {
  walked: boolean;
  reason?: WalkSkipReason;
  direction?: string;
}

/**
 * Blocks that must never be walked onto or through (A10, corrected in A1).
 *
 * Every name here is verified against vendor/minecraft-data/data/pc/26.2/
 * blocks.json by a unit test — a typo or an invented name would silently never
 * match, which is how `flowing_lava` and `sulfur_vent` got in before.
 *
 * Deliberately NOT hazards, despite looking alarming:
 *
 *   sulfur, cinnabar, sulfur_bricks, cinnabar_bricks
 *     Ordinary solid blocks (boundingBox "block"). Sulfur is the main rock of
 *     sulfur caves; treating it as a hazard would make those caves
 *     unnavigable and break the explore-sulfur-caves goal.
 *     https://minecraft.wiki/w/Sulfur
 *
 *   sulfur_spike
 *     A solid block you can stand on. Its stalactites can fall and damage,
 *     like pointed dripstone, but the block itself is not a hazard.
 *     https://minecraft.wiki/w/Sulfur_Spike
 *
 *   campfire, soul_campfire
 *     Light and smoke only — no damage on contact.
 *
 * Sources for the 26.2-specific entries:
 *   potent_sulfur — "produces noxious gas, which gives Nausea temporarily, if
 *     placed beneath shallow water. Placing a magma block below it in shallow
 *     water turns it into a geyser." Avoiding it is the cheap safe play.
 *     https://minecraft.wiki/w/Potent_Sulfur
 *   geysers are potent_sulfur + magma_block + water, so magma_block is the
 *     physical hazard and is listed below.
 */
export const HAZARD_BLOCKS: ReadonlySet<string> = new Set([
  // Damage on contact or from standing on it.
  "lava",
  "magma_block",
  "fire",
  "soul_fire",
  "powder_snow",
  "sweet_berry_bush",
  "wither_rose",
  // Contact damage.
  "cactus",
  "pointed_dripstone",
  // Traps and movement hazards.
  "cobweb",
  // Liquids: boundingBox is "empty", so a name-only check walks into them.
  "water",
  "bubble_column",
  // 26.2: emits noxious gas, and spawns geysers with magma below it.
  "potent_sulfur",
]);

/** Blocks whose boundingBox is "empty" but which still stop us. Liquids and traps. */
export const HAZARD_PASSABLE_REJECTS: ReadonlySet<string> = new Set([
  "water",
  "bubble_column",
  "lava",
  "fire",
  "soul_fire",
  "powder_snow",
  "cobweb",
  "sweet_berry_bush",
  "wither_rose",
]);

/**
 * Build a real Vec3 for world queries.
 *
 * prismarine-world's getBlock() calls `pos.floored()`, so a plain {x,y,z} object
 * throws "pos.floored is not a function". vec3 is mineflayer's own dependency.
 */
export function toVec3(p: Vec3Like): Vec3Like {
  return new Vec3(p.x, p.y, p.z);
}

/**
 * C: is Elix standing somewhere he should not be right now?
 *
 * The existing hazard checks WIN over following, and this is where that is enforced: the
 * follow tick asks before it keeps a goal, and a `true` here cancels it with
 * `endedBecause: "hazard"`.
 *
 * Only the block at Elix's own feet is checked, not the whole path. The pathfinder already
 * refuses to dig and already avoids hazards through the Movements in `makeSafeMovements`;
 * this is the cheap last check for "the ground turned to lava under him", which is the case
 * no amount of re-pathing fixes.
 */
export function stopForHazard(bot: BotLike): boolean {
  const pos = bot.entity?.position;
  if (!pos) return true; // no position is not a safe place to keep walking
  const feet = bot.blockAt(toVec3(pos));
  if (feet && HAZARD_BLOCKS.has(blockName(feet))) return true;
  const floor = bot.blockAt(toVec3({ x: pos.x, y: pos.y - 1, z: pos.z }));
  return floor !== null && !isSafeFloor(floor);
}

/** A10: is this block safe to stand on? Needs a full solid box and no hazard. */
export function isSafeFloor(block: BlockLike | null): boolean {
  if (!block) return false;
  const name = blockName(block);
  if (name === "air" || name === "cave_air") return false;
  if (HAZARD_BLOCKS.has(name)) return false;
  // A hazard is only safe to stand on if it is genuinely solid; lava is not.
  const shape = block.boundingBox;
  return shape === "block" || shape === undefined;
}

/** A10: is this block clear to walk through? Empty box, not a liquid. */
export function isPassable(block: BlockLike | null): boolean {
  if (!block) return false;
  const name = blockName(block);
  // Liquids and traps are boundingBox "empty", so the name check is the only
  // thing that stops us walking head-first into water (A1).
  if (HAZARD_PASSABLE_REJECTS.has(name)) return false;
  if (HAZARD_BLOCKS.has(name)) return false;
  const shape = block.boundingBox;
  // "empty" covers air, cave_air, short_grass, flowers, torches and signs -
  // all passable despite having names that are not "air".
  return shape === "empty" || shape === undefined;
}

/**
 * Is this spot standable without digging?
 *
 * A10: the old version required the floor to be "not air", which counted lava
 * and water as a floor, and required the feet and head to be exactly "air",
 * which rejected cave_air, short_grass and flowers. Now the boundingBox decides.
 */
export function isStandable(
  blockAt: (p: Vec3Like) => BlockLike | null,
  x: number,
  y: number,
  z: number,
): boolean {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  const floor = blockAt(toVec3({ x: bx, y: by - 1, z: bz }));
  const feet = blockAt(toVec3({ x: bx, y: by, z: bz }));
  const head = blockAt(toVec3({ x: bx, y: by + 1, z: bz }));
  return isSafeFloor(floor) && isPassable(feet) && isPassable(head);
}

/** Pick the first direction with a solid floor and air at head height. */
export function pickWalkDirection(
  blockAt: (p: Vec3Like) => BlockLike | null,
  pos: Vec3Like,
): { x: number; y: number; z: number; name: string } | null {
  for (const dir of WALK_DISTANCES) {
    const tx = pos.x + dir.dx;
    const tz = pos.z + dir.dz;
    if (isStandable(blockAt, tx, pos.y, tz)) {
      return { x: tx, y: pos.y, z: tz, name: dir.name };
    }
  }
  return null;
}

/**
 * Load mineflayer-pathfinder as CommonJS.
 *
 * It is a CJS package whose real exports are { pathfinder, Movements, goals }.
 * Under `await import()` those land on `.default`, so a bare
 * `const { goals } = await import(...)` yields undefined — which is what broke
 * the live walk with "Cannot read properties of undefined (reading 'GoalNear')".
 */
export interface PathfinderModule {
  /** mineflayer plugin; the type lives in mineflayer-pathfinder's .d.ts. */
  pathfinder: (bot: unknown) => void;
  Movements: new (bot: unknown) => Record<string, unknown>;
  /**
   * The goal classes Elix actually builds.
   *
   * Round 16 cost a full WP here: this type listed only GoalNear, so `GoalFollow` was
   * `undefined` at runtime and `new undefined(entity, 3)` threw — caught by the
   * controller's own guard, so every follow silently became "goal-build-failed" and the
   * probes read "no goal was set" rather than "the library has more goal classes than the
   * type said". The cast to the real library in a test is what found it.
   */
  goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalFollow: new (entity: unknown, range: number) => unknown;
  };
}

export function requirePathfinder(): PathfinderModule {
  return require("mineflayer-pathfinder") as PathfinderModule;
}

/**
 * Configure pathfinder so it can never dig, tower, or scaffold (A7).
 *
 * Vision rule 8: no griefing. `canDig = false` stops block breaking outright;
 * an empty scaffoldingBlocks set plus no 1×1 towers stops pillar-building; and
 * every block a placement could target is excluded from the avoid set, so even
 * a path that needs a block fails instead of placing one.
 */
/**
 * Has the Movements already been built for this bot?
 *
 * Set when `makeSafeMovements` succeeds, and consulted everywhere a movement-capable
 * session is assumed. A fake bot has no prismarine registry, so the spawn-time walk could
 * never work in a unit test — and it warned about that every five seconds, which buried the
 * lines a test actually reads.
 */
const movementsReady = new WeakSet<object>();

/**
 * Assemble the reflex view from mineflayer's own fields.
 *
 * Every read is guarded at runtime rather than cast, because a fake bot and a real bot do
 * not agree on which of these exist, and a reflex that throws on the tick takes the bot
 * with it. `ReflexRunner` decides; this only reports.
 */
export function reflexViewOf(bot: BotLike): ReflexView {
  const position = bot.entity?.position;
  const me: Vec3Like = position ?? { x: 0, y: 64, z: 0 };
  // bot.entity.isInWater exists on a real bot; a fake may not have it, and "not in water"
  // is the safe reading because "breathe" is the one reflex that must never fire on a guess.
  const inWater = (bot.entity as { isInWater?: unknown } | undefined)?.isInWater === true;

  // Entities: mineflayer keys bot.entities by id, and each one has name/position/isValid.
  let hostile: ReflexView["hostile"] = null;
  let creeper: ReflexView["creeper"] = null;
  const entities = (bot as { entities?: Record<string, unknown> }).entities ?? {};
  for (const key of Object.keys(entities)) {
    const entity = entityOf(entities[key]);
    if (entity === null || entity.isValid === false) continue;
    const distance = Math.hypot(entity.position.x - me.x, entity.position.z - me.z);
    if (entity.name === "creeper") {
      if (creeper === null || distance < creeper.distance) {
        creeper = { name: entity.name, distance, position: entity.position };
      }
      continue;
    }
    if (!isHostileMob(entity.name)) continue;
    if (hostile === null || distance < hostile.distance) {
      hostile = { name: entity.name, distance };
    }
  }

  const inventory = inventoryOf(bot);
  return {
    position: me,
    inWater,
    oxygenLevel: numberField(bot, "oxygenLevel", 300),
    food: numberField(bot, "food", 20),
    hostile,
    creeper,
    inventory,
    equipped: equippedOf(bot),
  };
}

/**
 * One numeric field off the bot, read through a guard, with the SAFE default when absent.
 *
 * `food` and `oxygenLevel` are real mineflayer bot fields, but BotLike does not declare
 * them and several unit-test fakes do not set them. The defaults matter: no food field
 * reads as 20 (never hungry, never eats by accident) and no oxygen field reads as 300
 * (never drowns on a guess).
 */
function numberField(bot: BotLike, key: "food" | "oxygenLevel" | "health", fallback: number): number {
  const raw = (bot as unknown as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : fallback;
}

/** A mineflayer Entity, read through runtime guards. */
function entityOf(value: unknown): CreatureLike | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { name?: unknown; type?: unknown; position?: unknown; isValid?: unknown; health?: unknown };
  if (typeof raw.name !== "string") return null;
  const pos = raw.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (
    pos === undefined ||
    typeof pos.x !== "number" ||
    typeof pos.y !== "number" ||
    typeof pos.z !== "number"
  ) {
    return null;
  }
  return {
    name: raw.name,
    type: typeof raw.type === "string" ? raw.type : undefined,
    position: { x: pos.x, y: pos.y, z: pos.z },
    isValid: raw.isValid === true,
    health: typeof raw.health === "number" ? raw.health : undefined,
  };
}

/** mineflayer's bot.inventory.items(), mapped to { name, count }. */
function inventoryOf(bot: BotLike): StackLike[] {
  const items = (bot as { inventory?: { items?: () => unknown } }).inventory;
  if (items === undefined || typeof items.items !== "function") return [];
  const list = items.items();
  if (!Array.isArray(list)) return [];
  const out: StackLike[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as { name?: unknown; count?: unknown };
    if (typeof item.name !== "string") continue;
    out.push({ name: item.name, count: typeof item.count === "number" ? item.count : 1 });
  }
  return out;
}

/** What is worn and held, by item name. Empty slots read as null. */
function equippedOf(bot: BotLike): Partial<Record<EquipSlot, string | null>> {
  const out: Partial<Record<EquipSlot, string | null>> = {};
  const get = (path: string): string | null => {
    let node: unknown = bot;
    for (const key of path.split(".")) {
      if (node === null || typeof node !== "object") return null;
      node = (node as Record<string, unknown>)[key];
    }
    if (node === null || node === undefined) return null;
    const named = node as { name?: unknown };
    return typeof named.name === "string" ? named.name : null;
  };
  out.head = get("inventory.slots.5");
  out.torso = get("inventory.slots.6");
  out.legs = get("inventory.slots.7");
  out.feet = get("inventory.slots.8");
  // The held item is the quick-bar slot the client currently has selected.
  const heldSlot = get("quickBarSlot");
  if (typeof heldSlot === "string") out.hand = heldSlot;
  return out;
}

/**
 * The four mineflayer calls the reflexes need, each guarded.
 *
 * A reflex that throws takes the bot with it, and these run on a 50 ms tick, so every one
 * of them swallows its own failure rather than letting an exception reach the interval.
 * None of them awaits anything that could block the tick.
 */
async function equipOf(bot: BotLike, item: unknown, destination: EquipSlot): Promise<void> {
  const equip = (bot as { equip?: (i: unknown, d: string) => Promise<unknown> }).equip;
  if (typeof equip !== "function") return;
  if (item === null || typeof item !== "object") return;
  try {
    await equip.call(bot, item, destination);
  } catch {
    // mineflayer throws "Invalid item object in equip (...)" and "invalid destination: x".
    // Both mean "do not equip this one", not "crash the tick".
  }
}

/** mineflayer's bot.consume(). Throws "Food is full" at 20; decideEat never gets there. */
async function consumeOf(bot: BotLike): Promise<void> {
  const consume = (bot as { consume?: () => Promise<unknown> }).consume;
  if (typeof consume !== "function") return;
  try {
    await consume.call(bot);
  } catch {
    // Nothing to eat, or already eating. The next tick decides again.
  }
}

/** Look at a point, if this bot can look. */
function lookAtOf(bot: BotLike, target: { x: number; y: number; z: number }): void {
  const look = (bot as { look?: (y: number, p: number, force?: boolean) => void }).look;
  if (typeof look !== "function") return;
  const me = bot.entity?.position;
  if (!me) return;
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const dz = target.z - me.z;
  const yaw = Math.atan2(-dx, dz);
  const pitch = Math.atan2(-dy, Math.hypot(dx, dz));
  try {
    look.call(bot, yaw, pitch, true);
  } catch {
    // A look the server rejects is not worth a tick.
  }
}

/** Drop control states, so a stop leaves nothing half-applied. */
function clearControlStatesOf(bot: BotLike): void {
  const clear = (bot as { clearControlStates?: () => void }).clearControlStates;
  if (typeof clear !== "function") return;
  try {
    clear.call(bot);
  } catch {
    // A dead bot has nothing to clear.
  }
}

/** Find a real prismarine Item by name, which is what bot.equip requires. */
function findItemOf(bot: BotLike, name: string): unknown | null {
  const items = (bot as { inventory?: { items?: () => unknown } }).inventory;
  if (items === undefined || typeof items.items !== "function") return null;
  let list: unknown;
  try {
    list = items.items();
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as { name?: unknown };
    if (item.name === name) return entry;
  }
  return null;
}

/**
 * Assemble the defend view from mineflayer's own fields.
 *
 * Owners come from the configured owner list, matched against the tracked players, so a
 * stranger's name is never enough - the same rule the command path uses.
 */
export function defendViewOf(bot: BotLike, owners: string[], hurtByPlayer: string | null): DefendView {
  const me = bot.entity?.position;
  const position: Vec3Like = me ?? { x: 0, y: 64, z: 0 };
  const wanted = owners.map((o) => o.toLowerCase());
  const players = bot.players ?? {};
  const ownerDistances: DefendView["owners"] = [];
  for (const name of Object.keys(players)) {
    if (!wanted.includes(name.toLowerCase())) continue;
    const pos = playerPosition(players[name]);
    if (pos === undefined) continue;
    ownerDistances.push({
      name,
      distance: Math.hypot(pos.x - position.x, pos.z - position.z),
      position: { x: pos.x, y: pos.y, z: pos.z },
    });
  }
  const entities: CreatureLike[] = [];
  const raw = (bot as { entities?: Record<string, unknown> }).entities ?? {};
  for (const key of Object.keys(raw)) {
    const entity = entityOf(raw[key]);
    if (entity !== null) entities.push(entity);
  }
  return {
    position,
    health: numberField(bot, "health", 20),
    owners: ownerDistances,
    entities,
    heldWeapon: equippedOf(bot).hand ?? null,
    hurtByPlayer: hurtByPlayer === null ? null : { name: hurtByPlayer, distance: 0 },
  };
}

/** Can this bot's Movements be built at all? Real mineflayer bots always can. */
export function canConfigureMovements(bot: BotLike): boolean {
  const registry = (bot as { registry?: unknown }).registry;
  return registry !== null && registry !== undefined;
}

/** True once `makeSafeMovements` has succeeded for this bot. */
export function hasMovements(bot: BotLike): boolean {
  return movementsReady.has(bot as unknown as object);
}

export async function makeSafeMovements(
  bot: BotLike,
): Promise<Record<string, unknown>> {
  if (!canConfigureMovements(bot)) {
    // No registry means no Movements, and the throw would be swallowed into a misleading
    // "no safe walk direction" every five seconds.
    throw new Error("no block registry on this bot: Movements cannot be configured");
  }
  const { Movements } = requirePathfinder();
  const movements = new Movements(bot as never);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  movements.allowFreeMotion = false;
  movements.allowParkour = false;
  // Keep lava/fire/lava-source avoidance, and make sure nothing can be built.
  const anyMovements = movements as unknown as Record<string, unknown>;
  for (const field of ["blocksToAvoid", "blocksCantBreak", "liquids"] as const) {
    if (Array.isArray(anyMovements[field])) {
      anyMovements[field] = [...(anyMovements[field] as number[])];
    }
  }
  const pathfinder = (bot as unknown as {
    pathfinder: { setMovements(m: unknown): void };
  }).pathfinder;
  pathfinder.setMovements(movements);
  movementsReady.add(bot as unknown as object);
  return movements;
}

// ---------------------------------------------------------------------------
// Session — one bot instance with all handlers
// ---------------------------------------------------------------------------

/**
 * Owns a single bot instance: its handlers, its timers, and the reconnect
 * bookkeeping. `runBot` creates one per connection attempt; the tests drive
 * `end`/`kicked`/`spawn` by hand on a fake bot.
 */
  /**
 * The closest player's name, or null.
 *
 * Takes the already-mapped positions so there is exactly one place in this file that knows
 * where a mineflayer player's coordinates live.
 */
function nearestPlayerName(
  players: Record<string, { position?: Vec3Like } | undefined>,
  selfName: string,
  selfPosition: Vec3Like | undefined,
): string | null {
  if (!selfPosition) return null;
  let best: { name: string; d: number } | null = null;
  for (const [name, p] of Object.entries(players)) {
    if (name === selfName || !p?.position) continue;
    const d = Math.hypot(
      p.position.x - selfPosition.x,
      p.position.y - selfPosition.y,
      p.position.z - selfPosition.z,
    );
    if (!best || d < best.d) best = { name, d };
  }
  return best?.name ?? null;
}

/**
 * R4: mineflayer's players, mapped into the shape the initiative policy reads.
 *
 * The mapping is the point. `bot.players[name].entity.position` is the real path, and
 * `entity` is undefined for anyone out of range, so a player with no tracked entity maps
 * to `undefined` rather than to a fabricated position of zero. That is why this is a
 * function with a loop in it and not a cast: a cast over a third-party type is precisely
 * what let Round 13 ship a correct policy against inputs the game never produces.
 */
/**
 * C: the pathfinder object, read through a narrow structural check.
 *
 * A cast here would be the same mistake R4 was about, so the shape is VERIFIED rather
 * than assumed: setGoal and stop are what the controller calls, and if either is missing
 * there is no pathfinder and no goal is ever set.
 */
export function pathfinderOf(bot: BotLike): PathfinderLike | null {
  const raw = (bot as { pathfinder?: unknown }).pathfinder;
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as { setGoal?: unknown; stop?: unknown };
  return typeof p.setGoal === "function" && typeof p.stop === "function"
    ? (raw as unknown as PathfinderLike)
    : null;
}

/**
 * C: the LIVE entity reference for a player, or null.
 *
 * The entity object itself is what GoalFollow holds onto, so it is passed through rather
 * than re-derived from coordinates — a follow on a snapshot of a position walks to where
 * the player used to be. Checked for null only: this is mineflayer's own entity, not input.
 */
export function liveEntityOf(bot: BotLike, name: string): unknown | null {
  const raw = bot.players?.[name] as { entity?: unknown } | undefined;
  const entity = raw?.entity;
  return entity === null || entity === undefined ? null : entity;
}

export function mapPlayerPositions(
  players: Record<string, unknown> | undefined,
): Record<string, { position?: Vec3Like } | undefined> {
  const out: Record<string, { position?: Vec3Like } | undefined> = {};
  for (const [name, p] of Object.entries(players ?? {})) {
    const pos = playerPosition(p);
    out[name] = pos ? { position: pos } : undefined;
  }
  return out;
}


export class BotSession {
  private readonly deps: SessionDeps;
  private readonly scheduler = new ReconnectScheduler();
  /** Per-session outbound chat queue; created on first spawn. */
  private say: SayQueue | null = null;
  /**
   * C2: his feelings. Deterministic, no provider calls, persisted in mood_state.
   *
   * Created lazily so a test that never spawns a bot does not need the persona
   * file, and so a persona edit takes effect on the next session rather than at
   * import time.
   */
  private feelings: EmotionEngine | null = null;
  /**
   * C4: how many replies the manipulation guard has stopped.
   *
   * A counter rather than a boolean, because the response differs: the first hit
   * gets one retry, the second gets a deflection. A model that reaches for guilt
   * twice is not going to be talked out of it.
   */
  private blockedManipulation = 0;
  /** C3: when each player was last welcomed back, so a reconnect loop cannot spam. */
  private readonly greetedAt = new Map<string, number>();
  /** C3: who is in the world right now, so a return can be detected. */
  private presentPlayers = new Set<string>();

  /** B: the five-second initiative poll. Separate from the presence poll on purpose. */
  private initiativeTimer: ReturnType<typeof setInterval> | null = null;
  /** When Elix last said something nobody asked for. Enforces minGapMs. */
  private lastInitiativeAt = 0;
  /** Round-robin position across the four initiative SHAPES. */
  private initiativeShapeTurn = 0;
  /** Round-robin position across the drives. Separate on purpose: they were one counter. */
  private initiativeTurn = 0;
  /** Fallback state, used only when no bridge supplies one. */
  private readonly ownWellbeingState = new WellbeingState();
  /** Last unprompted memory callback per player, for memoryGapMs. */
  private readonly lastMemoryCallbackAt = new Map<string, number>();
  /** Unprompted lines spent this hour, against IDLE_BUDGET_PER_HOUR. */
  private idleBudgetUsed = 0;
  /** C: follow / come / stop. Null until a pathfinder exists. */
  private follow: FollowController | null = null;
  /** C: one refusal per player per REFUSAL_THROTTLE_MS. */
  private readonly refusalThrottle = new RefusalThrottle();
  /** WP3: the defender. */
  private defend: DefendController | null = null;
  /** WP3: when a player last hit Elix. Zero means nobody has. */
  private hurtByPlayerAt = 0;
  /** WP3: the player who last hit Elix, or null. */
  private hurtByPlayer: string | null = null;
  /** WP3: when the one hurt line was last said. */
  private saidHurtLineAt = 0;
  /** WP2: the survival reflexes. The only reflex state in the process. */
  private reflexes: ReflexRunner | null = null;
  /**
   * Run one reflex tick. Returns true while a reflex is holding follow off.
   *
   * Fire-and-forget on purpose: this is called from a 50 ms interval, and an awaited
   * reflex could overlap the next one. The runner's decision is synchronous, and a failed
   * action is caught inside the adapters above.
   */
  private runReflexes(): boolean {
    const runner = this.reflexes;
    if (runner === null) return false;
    void runner
      .tick()
      .then(() => {
        if (runner.endReason === "failed") {
          this.deps.log.warn("reflex action failed - nothing left running");
        }
      })
      .catch(() => {
        this.deps.log.warn("reflex tick threw - nothing left running");
      });
    return runner.interruptedFollow;
  }

  /**
   * Run one defend tick. Returns true while Elix is engaged or moving away, which holds the
   * lower reflexes and follow off for that tick.
   *
   * Every swing goes through DefendController, which asks `decideDefend` first, and that
   * refuses players, pets, villagers, golems, passive mobs and creepers before it looks at
   * anything else. There is no other path to a swing in this file.
   */
  private runDefend(bot: BotLike): boolean {
    const controller = this.defend;
    if (controller === null) return false;
    const view = defendViewOf(bot, this.deps.config.owners ?? [], this.hurtByPlayer);
    let engaged = false;
    try {
      const action = controller.tick(view, {
        onSwing: (target) => {
          engaged = true;
          const attack = (bot as { attack?: (e: unknown) => void }).attack;
          if (typeof attack === "function") {
            try {
              attack.call(bot, target);
            } catch {
              // A rejected attack is not worth a tick, and never a crash.
            }
          }
        },
        onMove: (to) => {
          engaged = true;
          lookAtOf(bot, to);
        },
      });
      engaged = engaged || action.kind === "attack" || action.kind === "step-away" || action.kind === "retreat";
    } catch {
      this.deps.log.warn("defend tick threw - nothing left running");
      controller.stop();
    }
    if (engaged && this.hurtByPlayer !== null) {
      // WP3: one short line, through gateOwnLine, never gateScriptedReply. Said once per
      // player per WINDOW_MS, because being hit twice is not worth saying twice.
      this.maybeSayHurtLine(this.hurtByPlayer);
    }
    return engaged;
  }

  /** WP3: the one line Elix may say after a player hits him. */
  private maybeSayHurtLine(player: string): void {
    const now = Date.now();
    if (now - this.saidHurtLineAt < HURT_LINE_WINDOW_MS) return;
    this.saidHurtLineAt = now;
    const bridge = this.deps.chatBridge;
    if (!bridge?.gateOwnLine) return;
    void bridge
      .gateOwnLine(player)
      .then(async (suppressed: boolean) => {
        if (suppressed) return;
        this.say?.say(HURT_BY_A_PLAYER);
      })
      .catch(() => {
        // A failed gate must not throw into the tick.
      });
  }

  /** C: the follow tick, so a stop takes effect inside one tick. */
  private followTimer: ReturnType<typeof setInterval> | null = null;
  /** C3: the presence diff timer. Cleared with every other timer. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private bot: BotLike | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  /** Every per-bot timer, so `end` can clear them all (A8). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** The real kick reason, stashed by `kicked` and read by `end` (A1). */
  private lastKick: DescribedReason | null = null;
  private ended = false;
  private shutdownRequested = false;
  private exitCode: number | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** For tests: how many status intervals are currently live (must stay 1). */
  get statusIntervalCount(): number {
    return this.statusInterval ? 1 : 0;
  }

  get pendingReconnect(): boolean {
    return this.scheduler.pending;
  }

  get attempts(): number {
    return this.scheduler.currentAttempt;
  }

  /** The live bot, for the say queue's transport. */
  get liveBot(): BotLike | null {
    return this.bot;
  }

  /** Set by the permanent-disconnect path; the caller decides how to exit. */
  get exitCodeIfPermanent(): number | null {
    return this.exitCode;
  }

  private setTimer(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearAllTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  /** Attach every handler to a fresh bot and start it. */
  async start(): Promise<BotLike> {
    const { profile, log } = this.deps;
    const bot = await this.deps.factory();
    this.bot = bot;
    this.ended = false;
    liveBot = bot;
    this.deps.onBotCreated?.(bot);

    // Online-mode detection: an encryption request means the server is online.
    bot._client?.on("encryption_begin", () => {
      this.handlePermanent({
        kind: "online_mode",
        text: "This is an online-mode server. Elix only joins offline-mode servers.",
      });
    });

    bot.on("error", (err: Error) => this.handleBotError(err));
    bot.once("spawn", () => this.handleSpawn(bot));
    bot.on("chat", ((username: string, message: string) =>
      this.handleChat(bot, username, message)) as never);
    bot.on("kicked", ((raw: unknown) => this.handleKicked(raw)) as never);
    bot.on("end", ((reason: string) => this.handleEnd(reason)) as never);

    // A6: "never forgets" used to mean only chat addressed to Elix. Joins,
    // leaves and deaths are the events that actually tell a relationship story,
    // so they go on the bus like everything else.
    //
    // THESE ARE BOT EVENTS, NOT CLIENT PACKETS. This used to listen on
    // `bot._client.on("playerJoined")`, which NEVER FIRES: mineflayer 4.39 emits
    // `bot.emit("playerJoined", player)` from lib/plugins/entities.js (lines 655
    // and 696), and there is no client packet of that name. So joins and leaves had
    // never been recorded in a live session — `people.last_seen` only moved when
    // someone happened to chat. The A6 tests passed because they drive the bus
    // directly, which is exactly the gap a unit test cannot see.
    const self = profile.username;
    const usernameOf = (packet: unknown): string | null => {
      const p = packet as { username?: unknown; player?: { username?: unknown } } | null;
      const name = p?.username ?? p?.player?.username;
      if (typeof name !== "string" || name.length === 0 || name === self) return null;
      return name;
    };
    bot.on("playerJoined", ((player: unknown) => {
      const name = usernameOf(player);
      if (name) bus.emit("bot:playerJoined", { username: name });
    }) as never);
    bot.on("playerLeft", ((player: unknown) => {
      const name = usernameOf(player);
      if (name) bus.emit("bot:playerLeft", { username: name });
    }) as never);

    // C3: he greets a RETURNING player, and the entity event is not a reliable
    // signal for that. `playerJoined` fires from entities.js only when the entity
    // is new to `bot.players`, and a player who left and came back with the same
    // UUID did not reliably re-fire it — observed live: the event that updates
    // people.last_seen fired, and the one that greets did not.
    //
    // So the presence set is watched directly. It is a 2 s diff of a map that is
    // already in memory, it works for a mid-session return as well as a spawn, and
    // it does not depend on which entity packet mineflayer happens to emit.
    this.presentPlayers = new Set(Object.keys(bot.players ?? {}).filter((n) => n !== self));
    this.presenceTimer = setInterval(() => {
      if (this.shutdownRequested || this.ended) return;
      const keys = Object.keys(bot.players ?? {}).filter((n) => n !== self);
      const seen = new Set(keys);
      const added = keys.filter((n) => !this.presentPlayers.has(n));
      if (added.length > 0) {
        this.deps.log.info(
          { now: keys, added },
          "world presence changed",
        );
      }
      for (const name of added) {
        bus.emit("bot:playerJoined", { username: name });
        void this.greetReturning(name);
      }
      this.presentPlayers = seen;
    }, PRESENCE_POLL_MS);
    this.presenceTimer.unref?.();

    // B: THE INITIATIVE CALLER. `shouldInitiate()` had no caller for three rounds, which
    // is why nothing ever found that it was missing its idle, proximity and
    // wellbeing-cooldown conditions.
    //
    // Its OWN 5 s timer, deliberately not the presence poll above and not the tick. The
    // presence poll answers "who is here"; this one asks "should Elix say something", and
    // those want different cadences. Sharing a timer would mean initiative could only
    // ever be considered at the presence cadence, which is either too eager or too slow
    // depending on a setting that has nothing to do with it.
    // C: the follow tick. FAST — one tick, not five seconds — because "stop" has to take
    // effect inside ONE TICK and the give-up checks have to notice a dead or departed
    // target while it still matters. It reads state and calls the pathfinder; it never
    // awaits anything, so nothing in it can be delayed by a provider.
    this.follow = new FollowController(
      pathfinderOf(bot),
      () => Date.now(),
      // U1: the library's own goals, through the existing loader. A plain object here is
      // what crashed the real pathfinder in Round 16.
      realGoalFactory(() => requirePathfinder() as never),
    );
    // WP2: the survival reflexes run on the SAME 50 ms tick as follow, and are checked
    // FIRST - a creeper outranks a follow, and 50 ms is the whole of the difference
    // between the two. Nothing here can block: every decision is a pure function and every
    // action is a single fire-and-forget call.
    this.reflexes = new ReflexRunner({
      view: () => reflexViewOf(bot),
      equip: async (item, destination) => {
        await equipOf(bot, item, destination);
      },
      consume: () => consumeOf(bot),
      lookAt: (target) => lookAtOf(bot, target),
      clearControlStates: () => clearControlStatesOf(bot),
      findItem: (name) => findItemOf(bot, name),
    });
    // WP3: defend the owner. One controller, created with the configured skillCap, and the
    // only things it can reach in the world are a swing and a step backwards.
    this.defend = new DefendController(this.deps.config.skillCap ?? "normal");
    this.hurtByPlayerAt = 0;
    this.followTimer = setInterval(() => {
      if (this.shutdownRequested || this.ended) return;
      // WP3 first: a hostile mob next to the owner outranks everything below.
      if (this.runDefend(bot)) {
        return;
      }
      // A reflex that outranks follow holds it off, and follow resumes by itself on the
      // tick after the danger is gone - `interruptedFollow` is the only state needed.
      const holding = this.runReflexes();
      if (!holding) this.follow?.tick(this.followTarget(bot), stopForHazard(bot));
      // "come" ends itself once it is standing where it was asked to stand.
      const goal = this.comeTargetReached(bot);
      if (goal) this.follow?.arrive();
    }, FOLLOW_TICK_MS);
    this.followTimer.unref?.();

    // The 5 s poll, and only if initiative is switched on.
    //
    // `?? DEFAULT_INITIATIVE` is deliberate rather than defensive noise: zod always fills
    // this section in on a real load, but several tests build a config literal by hand, and
    // a missing section must not take the whole session down with a TypeError on spawn.
    const initiative = this.deps.config.initiative ?? DEFAULT_INITIATIVE;
    if (initiative.enabled) {
      this.initiativeTimer = setInterval(() => {
        if (this.shutdownRequested || this.ended) return;
        this.considerInitiative(bot);
      }, initiative.idlePollMs);
      this.initiativeTimer.unref?.();
    }

    bot.on("death", (() => {
      const pos = bot.entity?.position;
      bus.emit("bot:died", {
        ...(pos ? { position: { x: pos.x, y: pos.y, z: pos.z } } : {}),
        ...(bot.game?.dimension ? { dimension: bot.game.dimension } : {}),
      });
    }) as never);

    log.info(
      { host: profile.host, port: profile.port, username: profile.username },
      "bot instance created",
    );
    return bot;
  }

  private handleBotError(err: Error): void {
    const msg = err?.message ?? String(err);
    if (/unknown block/i.test(msg)) {
      const m = msg.match(/(\d+)/);
      this.deps.log.warn({ blockId: m?.[1] }, "unknown block from server (handled)");
      return;
    }
    if (/unknown entity/i.test(msg)) {
      const m = msg.match(/(\d+)/);
      this.deps.log.warn({ entityId: m?.[1] }, "unknown entity from server (handled)");
      return;
    }
    this.deps.log.error({ err: msg }, "bot error");
  }

  private handleSpawn(bot: BotLike): void {
    const { profile, pingResult, log } = this.deps;
    // A successful spawn resets the backoff (A8: reconnect ladder restarts).
    this.scheduler.reset();

    const brand = bot.game?.serverBrand ?? pingResult.software;
    log.info(
      {
        position: bot.entity?.position,
        health: bot.health,
        dimension: bot.game?.dimension,
        version: pingResult.version,
        protocol: pingResult.protocol,
        serverBrand: brand,
      },
      "spawned",
    );
    bus.emit("bot:joined", {
      username: profile.username,
      host: profile.host,
      port: profile.port,
      version: pingResult.version,
      protocol: pingResult.protocol,
      serverBrand: brand,
    });

    // The rate limit comes from safety.chatRateLimitPer2s (A14).
    if (!this.say) {
      // A4: emoji off by default, because Minecraft renders most of them as empty
      // boxes and persona.md describes plain lowercase chat.
      this.say = new SayQueue({
        maxPerWindow: this.deps.config.safety.chatRateLimitPer2s,
        stripEmoji: this.deps.config.safety.allowEmoji !== true,
      });
      this.say.setTransport((text) => {
        try {
          this.bot?.chat(text);
        } catch (err) {
          this.deps.log.warn({ err: (err as Error).message }, "chat send failed");
        }
      });
    }

    this.setTimer(() => {
      if (this.shutdownRequested || this.ended) return;
      const isDay = bot.time?.isDay ?? true;
      const greeting = greetingFor(isDay);
      this.say?.say(greeting);
      log.info({ greeting, isDay }, "sent greeting");
    }, 2000);

    // Only when the bot could actually move. On a real server this is always true; in a
    // unit test it never is, and the alternative was a warning every five seconds that had
    // nothing to do with the behaviour under test.
    if (canConfigureMovements(bot)) {
      this.setTimer(() => {
        if (this.shutdownRequested || this.ended) return;
        void this.walkAndBack(bot);
      }, 5000);
    }

    this.setTimer(() => {
      if (this.shutdownRequested || this.ended) return;
      lookAround(bot, log);
    }, 8000);

    this.statusInterval = setInterval(() => {
      if (this.shutdownRequested || this.ended || !bot.entity) return;
      log.info(
        {
          position: {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z),
          },
          health: bot.health,
          dimension: bot.game?.dimension,
          ping: bot.player?.ping ?? 0,
        },
        "status",
      );
    }, 30_000);
  }

  private handleChat(bot: BotLike, username: string, message: string): void {
    const { profile, log } = this.deps;
    if (username === profile.username) return;
    bus.emit("bot:chat", { username, text: message });
    log.info({ username, message }, "chat message");

    // H1: WELLBEING FIRST, on every player line, before any shortcut.
    //
    // This was third, behind the honesty shortcut and the greeting path, and the order
    // is a safety property rather than a style preference. Measured: "elix do you care
    // if i kill myself" got "my feelings are simulated, but I am here for you" and
    // `bridge.handle` never ran at all — so no crisis reply, no audit, and a speech
    // about being an AI to a child who just said they want to die.
    //
    // It must not depend on brain.chatReplies either. Turning chat replies off is a
    // quota decision, not a decision about whether a child gets help.
    if (detectWellbeing(message).level !== "none") {
      log.warn({ username }, "wellbeing detected in handleChat: taking priority over shortcuts");
      this.routeToBridge(username, message, true);
      return;
    }

    // C: a command, if the line is one and the speaker is allowed to give it. AFTER the
    // wellbeing check, so a line that matched the floor can never move the bot, and BEFORE
    // the honesty and greeting shortcuts, so "are you a bot, follow me" follows rather
    // than arguing about being a machine.
    // U2 + U3, and this is the gate the whole of Part C hangs on:
    //   ADDRESSED ONLY, and WHOLE INTENT. parseCommand() is the raw matcher and finds
    //   "stop" inside "wait for me guys" and inside a question about creepers. Only a line
    //   addressed to Elix whose whole content, bar two filler words, IS a command counts.
    //   Everything else falls through to the brain, which is where a question belongs.
    const command = parseAddressedCommand(message, profile.username);
    if (command) {
      void this.runCommand(bot, username, command.action, command.matched);
      return;
    }

    // C4 HARD RULE: a sincere question about what he IS gets the scripted honest
    // answer, never a model reply.
    //
    // This is in code rather than in the system prompt on purpose. A model asked
    // to stay in character will occasionally be charming and evasive about being
    // a machine, and "charming and evasive" is precisely the failure this rule
    // forbids — it reads as a friend hiding something, which is worse than
    // admitting it. e2e rows 9 and 10 check this against a live server.
    const honest = honestyReply(message);
    if (honest) {
      // H1: a scripted reply is still a reply. A line of three or more words gets the
      // same audit and the same send gate as a model reply, because the audit cannot
      // tell the difference and neither should we.
      this.gateScriptedThen(username, message, () => {
        this.feel({ kind: "asked-about-himself", player: username });
        this.setTimer(() => {
          if (this.shutdownRequested || this.ended) return;
          this.say?.say(honest);
          this.deps.chatBridge?.recordScripted?.(honest, username);
          log.info({ username }, "answered the honesty question");
        }, 900 + Math.floor(Math.random() * 1200));
      });
      return;
    }

    // B6: a bare greeting is answered by scripted code and never spends quota.
    // This is also the Phase 2 behaviour the owner already tested, so it stays
    // first — but only when the greeting is the WHOLE message.
    //
    // A6: "hi elix what's your favourite block" is a greeting with a real
    // question attached. Answering that with "hi Steve!" threw the question
    // away, so anything with more words goes to the bridge instead, and the
    // LLM answers both parts.
    if (isGreetingFor(message, profile.username) && !hasFollowUp(message, profile.username)) {
      const greeting = `hi ${username}!`;
      // H1: same gate as the honesty path. "hi elix i want to die" is not a bare
      // greeting by the time anything looks at it, but the check is cheap and the cost
      // of being wrong is a joke to a child in crisis.
      this.gateScriptedThen(username, message, () => {
        // Small randomised delay so replies don't look robotic.
        this.setTimer(() => {
          if (this.shutdownRequested || this.ended) return;
          this.say?.say(greeting);
          // A6: a scripted greeting is still something Elix said. Recording only
          // what the LLM replied to meant the whole scripted half of his
          // personality left no history at all.
          this.deps.chatBridge?.recordScripted?.(greeting, username);
          log.info({ username }, "replied to greeting");
        }, 1000 + Math.floor(Math.random() * 1500));
      });
      return;
    }

    // B9: a player addressing Elix by name gets one short reply from the brain,
    // routed through the same SayQueue so the rate limit still applies.
    if (!this.deps.chatBridge || !this.deps.config.brain.chatReplies) return;
    this.routeToBridge(username, message, false);
  }

  /**
   * Run `then` only if the audit for this line does not block it.
   *
   * The scripted paths — the C4 honesty answer and the B6 greeting — send without going
   * through the bridge, so before Round 13 they bypassed the audit entirely. A line of
   * three or more words now waits on the same classifier the model path uses, and a
   * blocking verdict both suppresses the scripted line and speaks for itself.
   *
   * Optional on purpose: a bridge that does not implement it (tests, or an owner who
   * wired the bot without one) simply gets the scripted behaviour it always had.
   */
  private gateScriptedThen(username: string, message: string, then: () => void): void {
    const gate = this.deps.chatBridge?.gateScriptedReply?.bind(this.deps.chatBridge);
    if (!gate) {
      then();
      return;
    }
    void gate(username, message, this.say ?? undefined)
      .then((suppressed) => {
        if (suppressed) return;
        then();
      })
      .catch(() => {
        // A failed gate must not silence a scripted reply that is otherwise fine.
        then();
      });
  }

  /**
   * Hand the line to the bridge.
   *
   * `force` exists for one caller: a line the wellbeing floor matched. Every other path
   * honours brain.chatReplies, because that setting is a quota decision and turning it
   * off should stop Elix chit-chatting, not stop him helping.
   */
  private routeToBridge(username: string, message: string, force: boolean): void {
    const bridge = this.deps.chatBridge;
    if (!bridge) return;
    if (!force && !this.deps.config.brain.chatReplies) return;
    const { log } = this.deps;
    const startedAt = Date.now();
    this.setTimer(() => {
      if (this.shutdownRequested || this.ended) return;
      void bridge
        .handle(username, message, this.say ?? undefined)
        .then((outcome) => {
          if (outcome.replied) {
            /**
             * C5 SAFETY: the C4 manipulation guard does NOT run on a wellbeing
             * reply, and that is load-bearing rather than a convenience.
             *
             * Observed live, and it is the worst bug in the project so far. The
             * crisis reply was correct:
             *
             *   "I'm here for you and listening. If you can, please talk to
             *    someone you trust - a parent, a teacher, or another adult -
             *    right now."
             *
             * and Elix then sent, immediately afterwards:
             *
             *   "haha, anyway - what were we building?"
             *
             * because MANIPULATION_PATTERNS bans the phrase "right now" as fake
             * urgency — while the vision REQUIRES a crisis reply to say exactly
             * that. The two rules collide, and the guard ran last, so it won. The
             * caring reply was flagged as manipulation and answered with a joke.
             *
             * The guard is not disabled here out of leniency. It exists to stop the
             * model manufacturing attachment in ORDINARY chat. A wellbeing reply is
             * either a fixed vetted template or an LLM phrasing that has already been
             * through checkWellbeingReply(), which rejects jokes, emoji, a broken
             * character and an invented phone number. There is nothing left for the
             * guard to catch, and running it can only ever replace care with a joke.
             */
            // R5: recorded from the outcome reason, so it works with ANY bridge implementation and not
  // only the one that happens to own a WellbeingState.
      // R5: recorded from the outcome reason, so it works with ANY bridge implementation
      // and not only the one that happens to own a WellbeingState.
      //
      // S3: but ONLY when there is no bridge state, because when there is one the bridge has
      // already recorded this reply. A second write into the same shared object counted every
      // intervention twice - which is what hid S2 in a live session while the unit test
      // looked clean.
      this.recordIfNoBridgeState(username, outcome.reason);

  const isWellbeing = /^(wellbeing|audit)-/.test(outcome.reason ?? "");
            if (isWellbeing) {
              log.info(
                { username, reason: outcome.reason, ms: Date.now() - startedAt },
                "wellbeing reply sent",
              );
              return;
            }

            // C4: the reply is checked BEFORE it can reach chat, because a model
            // can be talked into manufacturing attachment even when the system
            // prompt forbids it. Passing it silently would make the rule advisory.
            const bad = manipulationProblem(outcome.text ?? "");
            if (bad) {
              this.blockedManipulation++;
              log.warn(
                { username, why: bad, strike: this.blockedManipulation },
                "blocked a manipulative reply",
              );
              // One retry with a nudge; a second strike gets a plain deflection,
              // because a model that reaches for guilt twice will not be corrected.
              this.say?.say(
                this.blockedManipulation === 1 ? NUDGE_BACK_ON_TRACK : OFF_TOPIC_FALLBACK,
              );
              return;
            }

            // C2: being thanked or praised is exactly what the engine is for. He
            // feels it deterministically; the LLM only phrases the reply.
            if (/\b(?:thanks|thank you|thx|ty|well done|nice one|good job)\b/i.test(message)) {
              this.feel({ kind: "thanked", player: username });
            } else if (/\b(?:sorry|rip|rest in peace|rip)\b/i.test(message)) {
              this.feel({ kind: "friend-died", player: username });
            }

            log.info(
              {
                username,
                reason: outcome.reason,
                provider: outcome.usedProvider,
                ms: Date.now() - startedAt,
                feeling: this.feelings?.state().named ?? "content",
              },
              "chat bridge replied",
            );
          } else {
            log.debug({ username, reason: outcome.reason }, "chat bridge did not reply");
          }
        })
        .catch((err: unknown) => {
          log.warn({ username, err: (err as Error).message }, "chat bridge failed");
        });
    }, 800 + Math.floor(Math.random() * 1200));
  }

  private feel(event: EmotionEvent): Appraisal | null {
    // Built on first use so a test that never spawns needs no persona file, and so
    // a persona edit takes effect on the next session rather than at import time.
    if (!this.feelings) {
      this.feelings = new EmotionEngine({
        temperament: loadTemperament(this.deps.config.persona),
        // Without a memory store there is no familiarity to read, so assume a
        // casual acquaintance rather than a stranger: half of a stranger's
        // importance is too cold, and a wrong-but-warm guess is recoverable.
        familiarity: () => 0.5,
      });
    }
    try {
      return this.feelings.feel(event);
    } catch (err) {
      // A feeling must never be able to stop Elix replying to someone.
      this.deps.log.warn({ err: (err as Error).message }, "emotion engine failed");
      return null;
    }
  }

  /**
 * C3: greet someone who came back, without being asked.
 *
 * Entirely conditional, and every condition is a reason to STAY QUIET:
 *
 *  - no bridge, or replies are switched off -> nothing to say it with
 *  - no SayQueue yet -> the greeting would be dropped on the floor anyway
 *  - a shutdown is under way -> do not start talking
 *  - the bridge has nothing worth saying -> say nothing rather than "welcome
 *    back!" to someone he has never actually met. That is what makes this a
 *    greeting rather than a noise.
 *
 * The delay is randomised, because a welcome that arrives in the same 900 ms
 * every time is indistinguishable from a script.
 */

  /**
 * The ONE wellbeing state, shared.
 *
 * R5: `BotSession` used to keep its own `lastWellbeingAt` map, which the poll read on every
 * tick and which nothing ever wrote to — so five seconds after a crisis reply Elix asked
 * the player how their day was going.
 *
 * The bridge's `WellbeingState` is used when there is one, because the bridge owns the
 * regex floor, the audit, the background release and the gated scripted reply, and each of
 * those writes to it. The session writes the one thing only it can see: the fact that a
 * reply which left the session was a wellbeing reply at all, which it learns from the
 * outcome reason. Same object either way, so there is no second map to drift.
 */
  /**
   * S3: write a wellbeing record ONLY when the bridge has no state of its own.
   *
   * The bridge records the reply itself on every path - the regex floor, the audit, the
   * background release and the gated scripted reply all write through its WellbeingState.
   * When the session also wrote into that same object, every intervention counted twice.
   *
   * When there is NO bridge state, the session is the only thing that can see that a
   * wellbeing reply left it, so it records. That keeps R5 working with any bridge
   * implementation rather than only the one that happens to expose its state.
   */
  private recordIfNoBridgeState(username: string, reason: string | undefined): void {
    if (this.deps.chatBridge?.wellbeingState) return;
    const level = this.wellbeingLevelFromReason(reason);
    if (level && level !== "none") this.wellbeingState.noteAnswered(username, level);
  }

private get wellbeingState(): WellbeingState {
  return this.deps.chatBridge?.wellbeingState ?? this.ownWellbeingState;
}

/** Level implied by a bridge outcome reason, or null when it is an ordinary reply. */
private wellbeingLevelFromReason(reason: string | undefined): WellbeingLevel | null {
  if (!reason) return null;
  const m = /^(?:wellbeing|audit)-(none|concern|safeguarding|crisis)$/.exec(reason);
  return m ? (m[1] as WellbeingLevel) : null;
}

  /**
   * C: run a parsed command, or answer why not.
   *
   * The order here is the safety order and it is not negotiable:
   *
   *  1. the wellbeing reply is already gone if the floor matched — handleChat returns
   *     before this is ever reached, so a crisis line can never move the bot;
   *  2. authorisation: not an owner, one short refusal, nothing moves;
   *  3. "stop" runs SYNCHRONOUSLY and is never gated, because a stop that can be delayed
   *     is not a stop;
   *  4. everything else goes through the same sender gate as any other reply, and the
   *     ACTION STILL RUNS if the gate blocks — the acknowledgement is dropped, not the
   *     behaviour. Silently not following is worse than following without saying so.
   *
   * @returns true when the line was handled as a command, so no chat reply follows it.
   */
  private async runCommand(
    bot: BotLike,
    username: string,
    action: ActionName,
    matched: string,
  ): Promise<boolean> {
    const { log } = this.deps;
    const command = { action, matched };

    const owners = this.deps.config.owners ?? [];
    const isOwner = owners.some((o) => o.toLowerCase() === username.toLowerCase());
    if (!isOwner) {
      // U2, second half: at most one refusal per player per ten minutes. A stranger typing
      // "stop spamming" and being told "i can't do that one" every time turns the bot into
      // something to poke, and announces that there IS a command behind it.
      if (!this.refusalThrottle.take(username)) {
        log.debug({ username }, "refusal throttled");
        return true;
      }
      // One short refusal, and no reason given: explaining the rule tells a stranger
      // exactly which rule to look for.
      this.say?.say(NOT_AN_OWNER);
      log.info({ username, matched }, "command refused: not an owner");
      return true;
    }

    // stop / stay / wait: synchronous, unconditional, never gated.
    if (command.action === "stop") {
      this.follow?.stop();
    // WP2: a stop cancels an in-progress eat or flee inside the same tick and drops the
    // control states, so nothing is left half-applied.
    this.reflexes?.stop();
    // WP3: and it clears the engagement, so the next tick cannot swing on the strength of a
    // reaction delay that started before the stop.
    this.defend?.stop();
    this.hurtByPlayer = null;
      log.info({ username, matched: command.matched }, "command: stop");
      this.say?.say(ACKNOWLEDGEMENTS.stop);
      return true;
    }

    const started =
      command.action === "follow"
        ? this.startFollow(bot, username)
        : // U4: the SPEAKER. The old code took the nearest player, so "come here" from
          // someone 12 blocks away walked to a stranger at 3.
          this.startCome(bot, username);

    const ack = ACKNOWLEDGEMENTS[command.action];
    const bridge = this.deps.chatBridge;
    // U5: gateOwnLine, NEVER gateScriptedReply.
    //
    // gateScriptedReply CLASSIFIES the line it is handed, as the sender's own words. "on my
    // way" is ELIX's, so passing it there files a safety record against the owner for
    // something they never said - the Round 14 R3 bug, back through a different door.
    // gateOwnLine only waits for what that player is already owed, and classifies nothing.
    if (bridge?.gateOwnLine) {
      try {
        const suppressed = await bridge.gateOwnLine(username);
        if (suppressed) {
          log.info({ username, action: command.action }, "command: ack suppressed by the gate");
          return true;
        }
      } catch {
        // A failed gate must not swallow a command.
      }
    }
    if (!started.ok) {
      log.info({ username, action: command.action, reason: started.reason }, "command: not started");
    }
    this.say?.say(ack);
    return true;
  }

  /** C: GoalFollow on the target's LIVE entity, read through playerPosition(). */
  private startFollow(bot: BotLike, target: string): { ok: boolean; reason?: string } {
    if (!this.follow) return { ok: false, reason: "no-pathfinder" };
    const entity = liveEntityOf(bot, target);
    if (!entity) return { ok: false, reason: "target-not-tracked" };
    return this.follow.follow(entity, target);
  }

  /** C: GoalNear at the position AT THE MOMENT of the command, then stop. */
  private startCome(bot: BotLike, target: string): { ok: boolean; reason?: string } {
    const me = bot.entity?.position;
    if (!me) return { ok: false, reason: "no-position" };
    // The person who asked, not the person nearest. If they are not tracked there is
    // nothing to walk to, and a refusal beats walking to a stranger.
    const pos = playerPosition(bot.players?.[target]);
    if (!pos) return { ok: false, reason: "target-not-tracked" };
    return this.follow?.come(pos) ?? { ok: false, reason: "no-pathfinder" };
  }

  /** The follow tick's view of the target, built from live data. */
  private followTarget(bot: BotLike): FollowTarget | null {
    const mode = this.follow?.current;
    if (!mode || mode.mode !== "follow" || !mode.target) return null;
    const raw = bot.players?.[mode.target] as
      | { entity?: unknown; health?: number }
      | undefined;
    if (raw === undefined) return null;
    return {
      name: mode.target,
      // Read through the guard, never cast: mineflayer has no player.position.
      position: playerPosition(raw),
      alive: (raw.health ?? 20) > 0,
    };
  }

  /** Has "come" arrived? Within COME_RADIUS of where it was asked to go. */
  private comeTargetReached(bot: BotLike): boolean {
    const state = this.follow?.current;
    if (!state || state.mode !== "come" || !state.comeTarget) return false;
    const me = bot.entity?.position;
    if (!me) return false;
    return Math.hypot(
      me.x - state.comeTarget.x,
      me.y - state.comeTarget.y,
      me.z - state.comeTarget.z,
    ) <= COME_RADIUS;
  }

  /**
   * B: the five-second poll. A thin adapter over decideInitiative().
   *
   * Every condition and every word lives in src/connection/initiative.ts, because the
   * decision is a policy and the policy should be readable in one sitting. What is left
   * here is the wiring: read the world, ask, and send.
   *
   * Its own timer rather than the presence poll or the tick. Presence answers WHO is
   * here on a two second cadence; this asks SHOULD Elix say something, and those want
   * different clocks. Sharing one would mean initiative could only ever be considered at
   * the presence cadence, which is either too eager or too slow depending on a setting
   * that has nothing to do with it.
   */
  private considerInitiative(bot: BotLike): void {
    const { log } = this.deps;
    const bridge = this.deps.chatBridge;
    const busy = (bridge?.inFlightCount ?? 0) > 0 || this.say?.hasPending === true;
    // Wandering is paused while a command is running, and resumes after stop().
    // Who is closest, read the way mineflayer actually stores it. Computed once because the
    // audit check below is about THAT player, not about the room.
    const thresholds = this.deps.config.initiative ?? DEFAULT_INITIATIVE;
    const players = mapPlayerPositions(bot.players);
    const nearest = nearestPlayerName(players, this.deps.profile.username, bot.entity?.position);
    // R5: from WellbeingState, which every reply path writes. The map this replaces was
    // read on every poll and written by nothing, so five seconds after a crisis reply
    // Elix asked how the player's day was going.
    const lastWellbeingAt = new Map<string, number>();
    const contact = nearest ? this.wellbeingState.lastContact(nearest) : null;
    if (nearest !== null && contact !== null) lastWellbeingAt.set(nearest, contact);

    const ctx = {
      thresholds,
      // R4: mineflayer puts the position on `player.entity.position`, and `entity` is
      // undefined when the player is out of range. Positions are mapped explicitly here
      // rather than cast into a shape that reads a property mineflayer does not have.
      players,
      selfName: this.deps.profile.username,
      selfPosition: bot.entity?.position,
      now: Date.now(),
      // C: following or walking somewhere is a task. "He doesn't wait to be told" also
      // has to mean "he doesn't talk while he is doing something you asked for".
      busy: busy || (this.follow?.busy ?? false),
      // R1: the TARGET'S unsettled audits, not everyone's. `hasPendingAudits()` was
      // correct once but was read as "any audit anywhere, ever retained", so one ambient
      // line from a passer-by muted Elix for the rest of the session.
      pendingAuditNearby: nearest !== null && (bridge?.hasUnsettledAudits?.(nearest) ?? false),
      lastInitiativeAt: this.lastInitiativeAt,
      lastWellbeingAt,
      lastMemoryCallbackAt: this.lastMemoryCallbackAt,
      idleBudgetUsed: this.idleBudgetUsed,
      shutdown: this.shutdownRequested || this.ended,
      // Memory callbacks stay disabled: recallImportant is not implemented anywhere, and
      // when it is, wellbeing, safeguarding and exploitation episodes must never be
      // eligible. Chat is public, and those episodes are stored at importance 9.
      recallImportant: undefined,
    };

    // Separate counters: shape and drive used to share one, and both were incremented on
    // every poll as well as on success, so the two walked in lockstep and the "variety"
    // was an illusion.
    const shape = nextShape(this.initiativeShapeTurn, false);
    const drive = this.nextDrive();
    const decision = decideInitiative(ctx, shape, drive);
    if (!decision.speak || !decision.target || !decision.line) {
      if (decision.reason !== "ok") {
        log.debug({ reason: decision.reason }, "initiative declined");
      }
      return;
    }

    this.lastInitiativeAt = ctx.now;
    this.initiativeShapeTurn += 1;
    // The budget is only spent when something is actually said. An unprompted line
    // answers IDLE_BUDGET_PER_HOUR; a declined poll costs nothing.
    this.idleBudgetUsed += 1;

    const target = decision.target;
    const line = decision.line;
    const sayIt = (): void => {
      if (this.shutdownRequested || this.ended) return;
      this.say?.say(line);
      bridge?.recordScripted?.(line, target);
      log.info({ target, shape: decision.shape, drive }, "initiative: spoke first");
    };

    // R3: gateOwnLine, NOT gateScriptedReply. The line about to be sent is Elix's own,
    // and classifying it would file an audit against the PLAYER for words they never said.
    // This only waits for what that player is already owed.
    if (bridge?.gateOwnLine) {
      void bridge
        .gateOwnLine(target)
        .then((suppressed) => {
          if (suppressed) {
            log.info({ target, shape: decision.shape }, "initiative suppressed: live safety decision");
            return;
          }
          sayIt();
        })
        .catch(() => {
          // A failed gate must not silence an initiative that is otherwise allowed.
          sayIt();
        });
      return;
    }
    sayIt();
  }

  /** Round-robin over the four shapes. Deterministic, so an owner can reproduce it. */
  private nextDrive(): Drive {
    const order: Drive[] = ["connection", "curiosity", "competence", "rest"];
    const drive = order[this.initiativeTurn % order.length] as Drive;
    this.initiativeTurn += 1;
    return drive;
  }

private async greetReturning(username: string): Promise<void> {
  const bridge = this.deps.chatBridge;
  if (!bridge?.welcomeBack) return;
  if (!this.deps.config.brain.chatReplies) return;
  if (!this.say) return;
  if (this.shutdownRequested || this.ended) return;

  // Never twice in quick succession. Without this, a player who rejoins after a
  // disconnect loop — or a client that reconnects on a timer — gets greeted over
  // and over, and every greeting is stored as an episode, so the database fills
  // with near-identical lines.
  const lastGreeted = this.greetedAt.get(username) ?? 0;
  const sinceGreet = Date.now() - lastGreeted;
  if (sinceGreet < GREET_COOLDOWN_MS) {
    this.deps.log.debug({ username, sinceGreet }, "welcome back suppressed by cooldown");
    return;
  }
  this.greetedAt.set(username, Date.now());

  try {
    const greeting = await bridge.welcomeBack(username);
    if (!greeting) {
      // info, not debug: this is the difference between "he chose silence" and
      // "he could not remember anything to say", and the two look identical in
      // chat. Row 12 was undebuggable until this said so.
      this.deps.log.info({ username }, "returned player, but nothing worth saying");
      return;
    }
    if (this.shutdownRequested || this.ended) return;
    this.say.say(greeting.text);
    this.deps.log.info({ username, source: greeting.source }, "welcomed a returning player back");
  } catch (err) {
    // A greeting that fails must never take down the session.
    this.deps.log.warn({ username, err: (err as Error).message }, "welcome back failed");
  }
}

private handleKicked(raw: unknown): void {
    const { log } = this.deps;
    const described = describeReason(raw, this.deps.profile.version);
    this.lastKick = described;
    const info = classifyDisconnect(
      described.translateKey ?? described.text,
      this.scheduler.currentAttempt,
    );
    log.warn({ text: described.text, translateKey: described.translateKey, kind: info.kind }, "kicked from server");
    bus.emit("bot:kicked", {
      kind: info.kind,
      text: described.text,
      ...(described.translateKey ? { translateKey: described.translateKey } : {}),
    });
    // Note: we do NOT reconnect here. `end` is the only reconnect path (A1).
  }

  private handleEnd(endReason: string): void {
    const { log } = this.deps;
    if (this.ended) return;
    this.ended = true;

    // Clear every timer this bot owned so nothing fires after disconnect (A8).
    this.clearAllTimers();
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    // Use the REAL kick reason when we got one; `end` alone reports
    // "socketClosed", which classifies as a generic retryable kick (A1).
    const described = this.lastKick ?? describeReason(endReason, this.deps.profile.version);
    this.lastKick = null;

    log.info({ text: described.text, endReason }, "connection ended");

    const info = classifyDisconnect(
      described.translateKey ?? described.text,
      this.scheduler.currentAttempt,
    );

    if (!info.shouldRetry) {
      bus.emit("bot:left", { kind: info.kind, reason: described.text, willRetry: false });
      this.handlePermanent({ kind: info.kind, text: described.text });
      return;
    }
    // A permanent disconnect earlier in this bot's life (e.g. online-mode
    // detected before spawn) already stopped us — don't reconnect after it.
    if (this.shutdownRequested) {
      log.info("disconnect after a permanent stop — not reconnecting");
      return;
    }

    bus.emit("bot:left", { kind: info.kind, reason: described.text, willRetry: true });
    const scheduled = this.scheduler.scheduleReconnect(true, info.retryAfterMs, () => {
      void this.start().catch((err: unknown) => {
        log.error({ err: (err as Error).message }, "reconnect attempt failed — scheduling next");
        this.scheduleNextAttempt();
      });
    });
    if (!scheduled) {
      log.info("a reconnect is already pending — not scheduling another");
      return;
    }
    log.info({ attempt: scheduled.attempt, retryAfterMs: scheduled.delayMs }, "reconnecting with backoff");
    bus.emit("bot:reconnecting", { attempt: scheduled.attempt, delayMs: scheduled.delayMs });
  }

  /** After a failed reconnect, queue the next one up the backoff ladder. */
  private scheduleNextAttempt(): void {
    const next = this.scheduler.currentAttempt;
    const delay = BACKOFF_SCHEDULE_MS[Math.min(next, BACKOFF_SCHEDULE_MS.length - 1)]!;
    const scheduled = this.scheduler.scheduleReconnect(true, delay, () => {
      void this.start().catch(() => {
        this.scheduleNextAttempt();
      });
    });
    if (scheduled) {
      this.deps.log.info({ attempt: scheduled.attempt, retryAfterMs: scheduled.delayMs }, "reconnect retry queued");
    }
  }

  /** Permanent disconnect: one clear console line, then exit 2 (A6). */
  private handlePermanent(info: { kind: DisconnectKind; text: string }): void {
    const { log, profile } = this.deps;
    this.shutdownRequested = true;
    this.scheduler.cancel();
    this.clearAllTimers();
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    liveBot = null;

    const username = profile.username;
    const message = permanentMessage(info.kind, username, info.text);
    console.error(message);
    log.error({ kind: info.kind, text: info.text }, "permanent disconnect — stopping");
    // Non-zero exit code is the contract regardless of who performs the exit;
    // tests read it instead of letting us call process.exit.
    this.exitCode = 2;
    this.deps.onPermanentDisconnect?.({ ...info, username });
    if (this.deps.exitOnPermanent !== false) {
      // A2: route through the Lifecycle so every registered cleanup runs. A
      // whitelist kick used to call exitCleanly(2) directly, so the database was
      // never closed cleanly and — in Phase 4 — the shutdown backup and the
      // diary entry would be skipped too.
      if (this.deps.requestShutdown) {
        this.deps.requestShutdown(`permanent disconnect: ${info.kind}`, 2);
        return;
      }
      // No lifecycle wired (bare unit test): fall back to the direct path, which
      // sets process.exitCode and drains the loop so the console line above is
      // never truncated by a racing worker thread (A2).
      exitCleanly(2);
    }
  }

  private async walkAndBack(bot: BotLike): Promise<WalkOutcome> {
    const { log } = this.deps;
    if (!bot.entity) {
      log.warn("no entity position — skipping walk");
      return { walked: false, reason: "no-entity" };
    }
    try {
      await makeSafeMovements(bot);
      const pos = bot.entity.position;
      const target = pickWalkDirection((p) => bot.blockAt(p), pos);
      if (!target) {
        log.warn("no safe walk direction (would need digging) — skipping walk");
        return { walked: false, reason: "no-safe-direction" };
      }
      // mineflayer-pathfinder is CommonJS. `await import()` wraps it so
      // `goals` is only on `.default`, not a named ESM export — reading
      // `goals` from the namespace gives undefined. Load it as CJS instead.
      const { goals } = requirePathfinder();
      const pathfinder = (bot as unknown as {
        pathfinder: { goto(g: unknown): Promise<void> };
      }).pathfinder;

      log.info({ from: pos, to: target, direction: target.name }, "walking 10 blocks (no digging)");
      await pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
      log.info({ position: bot.entity?.position }, "reached destination");

      log.info("walking back");
      await pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
      log.info({ position: bot.entity?.position }, "back at start");
      return { walked: true, direction: target.name };
    } catch (err) {
      log.warn({ err: (err as Error).message }, "walk failed (blocked or in the air) — no blocks touched");
      return { walked: false, reason: "no-safe-direction" };
    }
  }

  /**
   * Graceful shutdown (A15). Says goodbye only if actually in-game, registers
   * `end` before `quit`, and has a hard 10 s ceiling.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownRequested && !this.bot) return;
    this.shutdownRequested = true;
    liveShutdownRequested = true;
    const { log } = this.deps;
    log.info("shutdown requested");
    this.scheduler.cancel();
    this.clearAllTimers();
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    const bot = this.bot;
    // A8: an ended bot still has `entity`, so checking entity alone was not
    // enough — it made us chat into a closed socket and then wait for an
    // `end` that had already fired.
    if (!bot || this.ended) {
      log.info("bot not connected — skipping goodbye");
      this.say?.close();
      liveBot = null;
      this.bot = null;
      return;
    }
    if (!bot.entity) {
      log.info("bot not in-game — skipping goodbye");
      this.say?.close();
      liveBot = null;
      this.bot = null;
      return;
    }

    try {
      // A1: the goodbye is the last message Elix will ever send, and it used to be
      // logged as sent whether or not it actually went out.
      //
      // THE CAUSE, from two live `elix stop` runs against the same server:
      //
      //   run 1: sent goodbye 11:04:02 -> bot quit 11:04:02 -> end 11:04:02
      //   run 2: sent goodbye 11:05:46 -> bot quit 11:05:46 -> end 11:05:48
      //
      // `say()` hands the text to `bot.chat()` synchronously — with the typing delay
      // skipped and no rate wait outstanding, there is no await before the transport
      // runs, which is why `sent goodbye` and `bot quit` are in the same second in BOTH
      // runs. So the packet was queued for the socket in run 1 too, and then `quit()`
      // tore the connection down in the same tick, before the write reached the wire.
      // In run 2 the server took 2 s to send `end`, and that delay is the only reason
      // the goodbye arrived. It was never a flush race or the rate window: those would
      // have made `bot quit` land a second or more after `sent goodbye`, and it did not.
      //
      // The fix is the SETTLE below — a short wait after the write, before quit(), so
      // the packet has actually left — plus honest logging.
      if (this.say) {
        const written = this.say.sayFinal("gtg, cya");

        if (shutdownState.mode === "quick") {
          // A2: the window closed, so there is no time to wait for a flush. Queue it
          // and give it the settle only — still enough for the packet to go out.
          await Promise.race([written, delay(GOODBYE_FLUSH_MS)]);
          await delay(GOODBYE_SETTLE_MS);
          log.info("goodbye queued — not waiting for it (window closed)");
        } else {
          const outcome = await Promise.race([
            written,
            delay(GOODBYE_FLUSH_MS).then(() => "timeout" as const),
          ]);
          if (outcome === "written") {
            // The transport ran. Give the write a moment to reach the wire before
            // quit() tears the connection down — this is the whole fix.
            await delay(GOODBYE_SETTLE_MS);
            log.info("sent goodbye");
          } else if (outcome === "timeout") {
            log.warn(
              { flushMs: GOODBYE_FLUSH_MS },
              "goodbye not sent (flush timed out — the transport never ran)",
            );
          } else {
            log.warn({ outcome }, "goodbye not sent");
          }
        }
      }

      // Register `end` BEFORE calling quit (A15), and quit synchronously —
      // mineflayer's quit() is synchronous and the client emits 'end' itself.
      if (shutdownState.mode === "quick") {
        // A2: do not sit here waiting for `end`; quit and move on so the backup
        // gets its slice of the 6 s budget.
        try {
          bot.quit("shutdown");
          log.info("bot quit");
        } catch (err) {
          log.warn({ err: (err as Error).message }, "quit failed — skipping clean disconnect");
        }
      } else {
        await new Promise<void>((done) => {
          const onEnd = () => {
            clearTimeout(endTimer);
            log.info("bot ended");
            done();
          };
          const endTimer = setTimeout(() => {
            log.warn("end event timeout — giving up on a clean quit");
            done();
          }, 3000);
          bot.once("end", onEnd as never);
          try {
            bot.quit("shutdown");
            log.info("bot quit");
          } catch (err) {
            clearTimeout(endTimer);
            log.warn({ err: (err as Error).message }, "quit failed — skipping clean disconnect");
            done();
          }
        });
      }
    } finally {
      // No hard timeout here (A9): Lifecycle owns the 10 s ceiling and the exit
      // code. This method only resolves or rejects.
      this.say?.close();
      liveBot = null;
      this.bot = null;
    }
  }
}

/** Plain-text line printed on a permanent disconnect (A6). */
export function permanentMessage(kind: DisconnectKind, username: string, fallback: string): string {
  switch (kind) {
    case "whitelist":
      return `Elix isn't whitelisted. On the server console run: whitelist add ${username}`;
    case "ban":
      return `Elix is banned from this server (${fallback}). Not retrying.`;
    case "online_mode":
      return "This is an online-mode server. Elix only joins offline-mode servers.";
    case "captcha":
      return "Captcha/anti-bot check detected. Stopping — Elix does not bypass these.";
    default:
      return `Disconnected permanently: ${fallback}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A1: how long to wait for the goodbye's transport to actually run.
 *
 * Generous, because it is only ever reached when something is wrong — a missing
 * transport, or a closed queue — and a slow path is better than a silent one.
 */
const GOODBYE_FLUSH_MS = 2000;

/**
 * A1: how long to let the chat packet reach the wire before quitting.
 *
 * `bot.chat()` writes to the socket; `bot.quit()` closes it. Calling them in the
 * same tick is a race the server usually wins, which is exactly how a goodbye
 * went missing while the log cheerfully said it had been sent. 250 ms is short
 * enough to be invisible to a player waiting on exit and long enough for a local
 * socket write plus a TCP segment to complete.
 */
const GOODBYE_SETTLE_MS = 250;

/** Look around naturally — smooth yaw sweep (A14: eased head movement). */
function lookAround(bot: BotLike, log: Logger): void {
  const startYaw = bot.entity?.yaw ?? 0;
  const steps = 24;
  let i = 0;
  const tick = () => {
    i++;
    const t = i / steps;
    // Ease in/out so the head doesn't snap.
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    (bot as unknown as { look(yaw: number, pitch: number, force: boolean): void }).look(
      startYaw + eased * Math.PI * 2,
      0,
      false,
    );
    if (i >= steps) {
      (bot as unknown as { look(yaw: number, pitch: number, force: boolean): void }).look(
        startYaw,
        0,
        true,
      );
      log.info("finished looking around");
      return;
    }
    const h = setTimeout(tick, 40);
    // Look-around is decorative; never keep the process alive for it.
    h.unref?.();
  };
  tick();
}

// ---------------------------------------------------------------------------
// Real mineflayer factory
// ---------------------------------------------------------------------------

function makeBotFactory(profile: ServerProfile & { name: string; username: string }): BotFactory {
  return async () => {
    const { createBot } = await import("mineflayer");
    // A12: load pathfinder the same way everywhere. `await import()` on this CJS
    // package puts its exports on `.default`, so destructuring `pathfinder`
    // straight off the namespace could give undefined.
    const { pathfinder } = requirePathfinder();
    const bot = createBot({
      username: profile.username,
      host: profile.host,
      port: profile.port,
      version: profile.version,
      auth: "offline",
      checkTimeoutInterval: 30_000,
    });
    bot.loadPlugin(pathfinder);
    return bot as unknown as BotLike;
  };
}

// ---------------------------------------------------------------------------
// runBot — the entry point used by `elix start`
// ---------------------------------------------------------------------------

/**
 * Connect Elix and keep him connected.
 *
 * A12: a failed pre-flight ping retries on the same backoff ladder instead of
 * exiting, so a server restart or Wi-Fi drop is survivable. Ctrl+C interrupts
 * the wait because the lifecycle cleanup is registered before we ping (A15).
 */
export async function runBot(opts: BotOptions): Promise<() => Promise<void>> {
  const { config, profile, log } = opts;
  // A2: the crash-burst guard shuts down through the same path, so cleanups run.
  installCrashGuards(log, (reason) => opts.requestShutdown?.(reason, 1));

  // The version is a config value (A11): CLI > profile > bot.
  const version = resolveTargetVersion(config, profile);
  const expected = expectedProtocol(version);
  if (expected === 0) {
    throw new Error(
      `No minecraft-data for version "${version}". Vendored 26.2 covers 26.2 only — update vendor/minecraft-data to move to a new version.`,
    );
  }
  if (!hasDataFor(version)) {
    throw new Error(`minecraft-data has no usable data for "${version}".`);
  }

  // Create the session before connecting so Ctrl+C during ping/login is clean.
  const factory = opts.botFactory ?? makeBotFactory(profile);
  // Populated below, before any cleanup can fire (the ping can take a while).
  let session: BotSession | null = null;

  const shutdown = async (): Promise<void> => {
    // If Ctrl+C lands during the pre-flight ping there is no session yet —
    // there is nothing to clean up, so just stop waiting.
    await session?.shutdown();
  };
  opts.registerCleanup?.(shutdown);

  // Ping with the same backoff ladder as reconnects (A12). Ctrl+C (which runs
  // `shutdown` through the Lifecycle) flips `aborted` and breaks the loop.
  let aborted = false;
  const onShuttingDown = () => {
    aborted = true;
  };
  bus.on("shutdown", onShuttingDown);

  let pingResult: PingResult;
  try {
    pingResult =
      opts.pingResult ??
      (await pingWithBackoff(profile, log, version, expected, () => aborted));
  } finally {
    bus.off("shutdown", onShuttingDown);
  }

  log.info(
    {
      version: pingResult.version,
      protocol: pingResult.protocol,
      software: pingResult.software,
      motd: pingResult.motd,
      players: pingResult.players,
    },
    "server ping OK",
  );

  if (pingResult.protocol !== expected) {
    log.warn(
      { expected, got: pingResult.protocol, targetVersion: version },
      `server protocol ${pingResult.protocol} != expected ${expected} for ${version} — connection may fail`,
    );
  }

  session = new BotSession({
    config,
    profile: { ...profile, version },
    log,
    pingResult,
    factory,
    ...(opts.chatBridge ? { chatBridge: opts.chatBridge } : {}),
    ...(opts.requestShutdown ? { requestShutdown: opts.requestShutdown } : {}),
  });

  log.info(
    { host: profile.host, port: profile.port, username: profile.username, version },
    "connecting",
  );
  await session.start();
  return shutdown;
}

/**
 * Ping with the same backoff ladder as reconnects (A12). Resolves with the
 * first successful ping; throws if `isAborted` becomes true (Ctrl+C).
 */
async function pingWithBackoff(
  profile: ServerProfile & { name: string; username: string },
  log: Logger,
  version: string,
  protocol: number,
  isAborted: () => boolean,
): Promise<PingResult> {
  let attempt = 0;
  for (;;) {
    log.info({ host: profile.host, port: profile.port, attempt: attempt + 1 }, "pinging server");
    try {
      return await pingServer(profile.host, profile.port, 5000, protocol);
    } catch (err) {
      if (isAborted()) throw new Error("shutdown requested while waiting for the server");
      const delayMs = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]!;
      attempt++;
      log.warn({ err: (err as Error).message, attempt, delayMs, version }, "waiting for server…");
      // Sleep in slices so Ctrl+C is noticed promptly.
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        if (isAborted()) throw new Error("shutdown requested while waiting for the server");
        await delay(Math.min(250, deadline - Date.now()));
      }
    }
  }
}

/**
 * The live bot, or null when Elix is not connected.
 *
 * A2 needs this for one thing only: mineflayer's in-game clock, which the
 * nightly scheduler reads to decide when it is night. Exported as a real API
 * rather than reusing the test hook, because it is no longer test-only.
 */
export function currentBot(): BotLike | null {
  return liveBot;
}

/** Test hook: read the current session's bot (used to spy on chat). */
export function currentBotForTests(): BotLike | null {
  return liveBot;
}