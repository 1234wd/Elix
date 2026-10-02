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
import { bus } from "../core/events.js";
import { SayQueue } from "../social/say.js";
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
  time?: { isDay: boolean };
  game?: { dimension?: string; serverBrand?: string };
  player?: { ping?: number };
  _client?: { on(event: string, fn: () => void): void };
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
  exitOnPermanent?: boolean;
  /** Test seam: called every time a new bot instance is created. */
  onBotCreated?: (bot: BotLike) => void;
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
export function installCrashGuards(log?: Logger): void {
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
 * Blocks that must never be walked onto or through (A10).
 *
 * The 26.2 sulfur hazards come from the master brief: sulfur caves are the main
 * late-game danger, so sulfur and cinnabar-adjacent blocks are treated as lethal
 * even where the block itself is not obviously on fire.
 */
export const HAZARD_BLOCKS: ReadonlySet<string> = new Set([
  "lava",
  "flowing_lava",
  "magma_block",
  "fire",
  "soul_fire",
  "campfire",
  "soul_campfire",
  "powder_snow",
  "sweet_berry_bush",
  "wither_rose",
  "sulfur",
  "flowing_sulfur",
  "sulfur_spike",
  "sulfur_vent",
  "cinnabar",
  "cinnabar_block",
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
  // Every hazard is refused at body height too, whatever its bounding box.
  if (HAZARD_BLOCKS.has(blockName(block))) return false;
  const shape = block.boundingBox;
  // "empty" covers air, cave_air, short_grass, flowers, torches and signs —
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
  goals: { GoalNear: new (x: number, y: number, z: number, range: number) => unknown };
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
export async function makeSafeMovements(
  bot: BotLike,
): Promise<Record<string, unknown>> {
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
export class BotSession {
  private readonly deps: SessionDeps;
  private readonly scheduler = new ReconnectScheduler();
  /** Per-session outbound chat queue; created on first spawn. */
  private say: SayQueue | null = null;
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
      this.say = new SayQueue({ maxPerWindow: this.deps.config.safety.chatRateLimitPer2s });
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

    this.setTimer(() => {
      if (this.shutdownRequested || this.ended) return;
      void this.walkAndBack(bot);
    }, 5000);

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

    if (!isGreetingFor(message, profile.username)) return;
    // Small randomised delay so replies don't look robotic.
    this.setTimer(() => {
      if (this.shutdownRequested || this.ended) return;
      this.say?.say(`hi ${username}!`);
      log.info({ username }, "replied to greeting");
    }, 1000 + Math.floor(Math.random() * 1500));
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
      // exitCleanly sets process.exitCode and drains the loop, so the console
      // line above is never truncated by a racing worker thread (A2).
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
      // Goodbye goes through the queue (rate limit) but skips the typing delay.
      // Bounded so a 2 s rate-limit window can't eat the whole budget.
      if (this.say) {
        this.say.say("gtg, cya", true);
        await Promise.race([this.say.flush(), delay(1500)]);
        log.info("sent goodbye");
      }

      // Register `end` BEFORE calling quit (A15), and quit synchronously —
      // mineflayer's quit() is synchronous and the client emits 'end' itself.
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
  installCrashGuards(log);

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

/** Test hook: read the current session's bot (used to spy on chat). */
export function currentBotForTests(): BotLike | null {
  return liveBot;
}