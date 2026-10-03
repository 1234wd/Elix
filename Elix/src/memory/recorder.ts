/**
 * The world recorder (A6).
 *
 * BUG THIS FIXES: `ChatBridge.handle()` returned early on
 * `!isAddressedToElix(...)` and only recorded what got past that check, so the
 * "never forgets" promise covered a fraction of what actually happened. Never
 * stored: unaddressed chat, Elix's own scripted greetings, players joining and
 * leaving, and Elix dying. Those are exactly the events that make a relationship
 * legible — the player who shows up every night, the death he complains about.
 *
 * This class is where the OTHER sources are recorded. Chat that reaches the
 * bridge is the bridge's job; bus events are this class's job.
 *
 * Spam control, because a public server can produce a hundred lines a minute:
 *
 *  - the same player sending the same text within 30 s is stored ONCE
 *  - ambient lines are capped per player per minute, with a global cap as well
 *
 * Caps drop silently rather than erroring: a dropped line is a missing ambient
 * detail, never a failed reply.
 */
import { bus } from "../core/events.js";
import type { MemoryStore, EpisodeKind } from "./store.js";

/** Same text from the same player inside this window is stored once. */
export const DUPLICATE_WINDOW_MS = 30_000;
/** Ambient lines per player per minute. */
export const AMBIENT_PER_PLAYER_PER_MIN = 12;
/** Ambient lines across all players per minute. */
export const AMBIENT_GLOBAL_PER_MIN = 40;
export const RATE_WINDOW_MS = 60_000;

export interface RecorderLog {
  info(o: unknown, m?: string): void;
  warn(o: unknown, m?: string): void;
  debug(o: unknown, m?: string): void;
}

export interface RecorderDeps {
  store: MemoryStore;
  log: RecorderLog;
  /** Elixir's own name, so he never records his own lines as a player's. */
  selfName: string;
  /** Overridable for tests. */
  now?: () => number;
}

export interface RecordOptions {
  kind?: EpisodeKind;
  meta?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  dimension?: string | null;
  server?: string | null;
  /** Bypass the ambient caps. Direct chat still passes the duplicate check. */
  ignoreCaps?: boolean;
}

export class WorldRecorder {
  private readonly deps: RecorderDeps;
  /** player -> Map<text, timestamp> for the duplicate window. */
  private readonly recent = new Map<string, Map<string, number>>();
  /** player -> [timestamps] inside the rate window. */
  private readonly ambientPerPlayer = new Map<string, number[]>();
  private ambientGlobal: number[] = [];
  private detached: Array<() => void> = [];

  constructor(deps: RecorderDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Is this line a repeat of one already stored inside the window?
   *
   * A repeat still updates `last_seen` — someone repeating themselves is more
   * engaged than someone silent, not less.
   */
  isDuplicate(player: string, text: string): boolean {
    const now = this.now();
    let seen = this.recent.get(player);
    if (!seen) {
      seen = new Map();
      this.recent.set(player, seen);
    }
    // Trim the map so a long session does not grow it without bound.
    for (const [text_, at] of seen) {
      if (now - at > DUPLICATE_WINDOW_MS) seen.delete(text_);
    }
    return seen.has(text);
  }

  private allowAmbient(player: string): boolean {
    const now = this.now();
    const window = (list: number[]): number[] => {
      const kept = list.filter((t) => now - t < RATE_WINDOW_MS);
      return kept;
    };
    this.ambientGlobal = window(this.ambientGlobal);
    const mine = window(this.ambientPerPlayer.get(player) ?? []);
    this.ambientPerPlayer.set(player, mine);
    if (this.ambientGlobal.length >= AMBIENT_GLOBAL_PER_MIN) return false;
    if (mine.length >= AMBIENT_PER_PLAYER_PER_MIN) return false;
    mine.push(now);
    this.ambientGlobal.push(now);
    return true;
  }

  /** Record one line. Returns the new episode id, or null if it was dropped. */
  record(
    player: string | null,
    text: string,
    opts: RecordOptions = {},
  ): number | null {
    const kind = opts.kind ?? "chat";
    const isAmbient = kind === "ambient";
    try {
      if (isAmbient && !opts.ignoreCaps && !this.allowAmbient(player ?? "-")) return null;
      if (player && this.isDuplicate(player, text)) {
        this.deps.store.touchPerson(player, this.now());
        return null;
      }
      const ts = this.now();
      const id = this.deps.store.addEpisode({
        ts,
        kind,
        player,
        // Ambient lines are things Elix overheard, so "player" is who said it.
        speaker: "player",
        text,
        meta: opts.meta ?? null,
        x: opts.x ?? null,
        y: opts.y ?? null,
        z: opts.z ?? null,
        dimension: opts.dimension ?? null,
        server: opts.server ?? null,
        // Ambient is deliberately quiet; the scorer would give a plain chat line
        // a 2 and a direct one a 4, and "did someone say something" is neither.
        importance: isAmbient ? 2 : undefined,
      });
      if (player) {
        this.deps.store.touchPerson(player, ts);
        this.recent.get(player)?.set(text, ts);
      }
      return id;
    } catch (err) {
      this.deps.log.debug({ err: (err as Error).message }, "world recorder write failed");
      return null;
    }
  }

  /**
   * Subscribe to the bus. Returns an unsubscribe function.
   *
   * Every handler is defensive: a bus listener that throws would be caught by the
   * bus, but it would also be logged as a failure, and a memory hiccup is not a
   * failure worth logging at error level.
   */
  attach(): () => void {
    const guard = <A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) => {
      return (...args: A) => {
        try {
          fn(...args);
        } catch (err) {
          this.deps.log.debug({ err: (err as Error).message }, "world recorder handler failed");
        }
      };
    };

    const onJoin = guard((p: { username: string }) => {
      const known = this.deps.store.person(p.username) !== null;
      this.deps.store.touchPerson(p.username, this.now());
      if (!known) {
        // A first meeting is an event in its own right, worth remembering as one.
        this.record(p.username, `${p.username} joined the server`, {
          kind: "event",
          ignoreCaps: true,
        });
        // Meeting someone builds familiarity faster than talking to them does.
        this.deps.store.bumpRelation(
          p.username,
          { familiarity: 0.05, trust: 0.01 },
          this.now(),
        );
      }
    });

    const onLeave = guard((p: { username: string }) => {
      // last_seen is the point of a leave event; touchPerson writes it.
      this.deps.store.touchPerson(p.username, this.now());
    });

    const onDeath = guard((info: { position?: { x: number; y: number; z: number }; dimension?: string }) => {
      const where = info.position
        ? ` (${Math.round(info.position.x)}, ${Math.round(info.position.y)}, ${Math.round(info.position.z)})`
        : "";
      this.deps.store.addEpisode({
        ts: this.now(),
        // A death is the highest-value thing that can happen to Elix short of a
        // promise, and the scorer already rates `death` an 8.
        kind: "death",
        player: null,
        speaker: "elix",
        text: `Elix died${where}`,
        x: info.position?.x ?? null,
        y: info.position?.y ?? null,
        z: info.position?.z ?? null,
        dimension: info.dimension ?? null,
        importance: 8,
      });
    });

    const onKicked = guard((info: { kind: string; text: string }) => {
      this.deps.store.addEpisode({
        ts: this.now(),
        kind: "event",
        player: null,
        speaker: "elix",
        // The classified kind, not the raw server text: the raw text can be
        // arbitrary and must not become a memory.
        text: `Elix was kicked (${info.kind})`,
        meta: JSON.stringify({ kind: info.kind }),
        importance: 6,
      });
    });

    const onLeft = guard((info: { kind: string; willRetry: boolean }) => {
      this.deps.store.addEpisode({
        ts: this.now(),
        kind: "event",
        player: null,
        speaker: "elix",
        text: info.willRetry ? `Elix lost the connection (${info.kind})` : `Elix left (${info.kind})`,
        meta: JSON.stringify({ kind: info.kind, willRetry: info.willRetry }),
        importance: 3,
      });
    });

    bus.on("bot:playerJoined", onJoin);
    bus.on("bot:playerLeft", onLeave);
    bus.on("bot:died", onDeath);
    bus.on("bot:kicked", onKicked);
    bus.on("bot:left", onLeft);

    const detach = (): void => {
      bus.off("bot:playerJoined", onJoin);
      bus.off("bot:playerLeft", onLeave);
      bus.off("bot:died", onDeath);
      bus.off("bot:kicked", onKicked);
      bus.off("bot:left", onLeft);
    };
    this.detached.push(detach);
    return detach;
  }

  /** Unsubscribe everything this instance attached. */
  detachAll(): void {
    for (const fn of this.detached.splice(0)) fn();
  }
}