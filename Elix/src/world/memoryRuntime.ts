/**
 * The world-memory runtime — "remember this place", "where is X", "take me to X", "where did
 * I die".
 *
 * Two rules decide everything in this file:
 *
 *   1. COORDINATES GO TO OWNERS, BY WHISPER, AND NOWHERE ELSE. Public chat gets a short line
 *      with no numbers in it, because a server full of strangers is not the place a child's
 *      home coordinates get read out. `tests/unit/worldMemoryWiring.test.ts` asserts that no
 *      public line Elix ever sends matches three integers, on every path through here.
 *   2. THE BOOK IS IN MEMORY FIRST. The store is persistence, not truth: a session that has no
 *      store - which is every bare unit test, and a real bot whose data directory has not been
 *      created yet - still remembers what it was told thirty seconds ago. Making the store the
 *      only source would mean "remember this place" silently doing nothing when the database
 *      is missing, which is the exact failure mode Round 18 exists to fix.
 */
import { Vec3 } from "vec3";
import type { DeathRecord, Place } from "./memory.js";
import { UNKNOWN_DEATH, UNKNOWN_PLACE, describeDeath, describePlace, looksLikeCoordinates } from "./memory.js";
import type { MemoryStore } from "../memory/store.js";

/** The mineflayer surface this file uses. Every member is reached through a guard. */
export interface MemoryBot {
  entity?: { position: Vec3 } | undefined;
  game?: { dimension?: string } | undefined;
  /** whisper is the ONLY channel coordinates ever travel on. */
  whisper?(username: string, message: string): void;
  pathfinder?: { setGoal(goal: unknown): void; stop(): void } | undefined;
}

/** What the runtime is doing. */
export type MemoryOutcome =
  | { kind: "remembered"; key: string }
  | { kind: "whispered"; key: string }
  | { kind: "walking"; key: string }
  | { kind: "said"; line: string }
  | { kind: "refused"; reason: string };

/** What the runtime needs, injected so it never reaches for a clock. */
export interface MemoryDeps {
  /** Persistence. Optional, and never the source of truth while the session is running. */
  store: MemoryStore | null;
  /** The real pathfinder goal classes. */
  goals: {
    GoalGetToBlock?: new (x: number, y: number, z: number) => unknown;
    GoalNear?: new (x: number, y: number, z: number, range: number) => unknown;
  };
  now: () => number;
}

/**
 * Places and deaths, for one session.
 *
 * Deliberately not a singleton: two bots in two processes must not share a book, and a test
 * that leaves places behind would then leak into the next test.
 */
export class PlaceBook {
  private readonly places = new Map<string, Place>();
  private readonly deaths: DeathRecord[] = [];

  constructor(private readonly store: MemoryStore | null) {}

  /** Remember a place. The name is normalised, so "Test Spot" and "test spot" are one place. */
  remember(key: string, kind: string, at: { x: number; y: number; z: number }, dimension: string | null, ts: number): Place {
    const name = key.trim().toLowerCase();
    const place: Place = { key: name, kind, x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z), dimension, note: null, ts };
    this.places.set(name, place);
    // Persistence is best-effort: a full disk must not stop Elix remembering a place.
    try {
      this.store?.addPlace({ key: name, kind, ts, x: place.x, y: place.y, z: place.z, dimension, note: null });
    } catch {
      // The in-memory book still has it.
    }
    return place;
  }

  /** A place by name, from memory and then from the store. */
  find(key: string): Place | null {
    const name = key.trim().toLowerCase();
    const here = this.places.get(name);
    if (here !== undefined) return here;
    if (this.store === null) return null;
    try {
      const row = this.store.place(name) as Record<string, unknown> | null | undefined;
      if (row === null || row === undefined) return null;
      const x = row["x"];
      const y = row["y"];
      const z = row["z"];
      if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
      const place: Place = {
        key: name,
        kind: typeof row["kind"] === "string" ? row["kind"] : "note",
        x,
        y,
        z,
        dimension: typeof row["dimension"] === "string" ? row["dimension"] : null,
        note: typeof row["note"] === "string" ? row["note"] : null,
        ts: typeof row["ts"] === "number" ? row["ts"] : 0,
      };
      this.places.set(name, place);
      return place;
    } catch {
      return null;
    }
  }

  /** Every place, for the protection rules. */
  all(): Place[] {
    return [...this.places.values()];
  }

  /** Record a death. Capped, because a creeper farm would otherwise grow the array forever. */
  recordDeath(player: string, at: { x: number; y: number; z: number }, dimension: string | null, ts: number): DeathRecord {
    const record: DeathRecord = {
      player,
      x: Math.floor(at.x),
      y: Math.floor(at.y),
      z: Math.floor(at.z),
      dimension,
      ts,
      cause: null,
    };
    this.deaths.push(record);
    if (this.deaths.length > 20) this.deaths.shift();
    return record;
  }

  /** The most recent death, or null. */
  lastDeath(): DeathRecord | null {
    return this.deaths.length === 0 ? null : (this.deaths[this.deaths.length - 1] ?? null);
  }
}

/**
 * The runtime.
 *
 * Every line that leaves here is checked against the coordinate pattern BEFORE it is said, so a
 * future edit that puts numbers in a public line fails the tests rather than the owner.
 */
export class MemoryRunner {
  private last: MemoryOutcome = { kind: "refused", reason: "idle" };

  constructor(
    private readonly deps: MemoryDeps,
    readonly book: PlaceBook,
  ) {}

  /** The last outcome, for the log and the tests. */
  get outcome(): MemoryOutcome {
    return this.last;
  }

  /** Remember where Elix is standing. */
  rememberHere(bot: MemoryBot, key: string, kind: string, isOwner: boolean): MemoryOutcome {
    const position = bot.entity?.position;
    if (position === undefined) {
      this.last = { kind: "refused", reason: "no-position" };
      return this.last;
    }
    const dimension = typeof bot.game?.dimension === "string" ? bot.game.dimension : null;
    const place = this.book.remember(key, kind, position, dimension, this.deps.now());
    this.last = { kind: "remembered", key: place.key };
    // The confirmation carries no numbers at all, so it is safe in public chat.
    this.say(bot, `ok, i'll remember ${place.key.replace(/_/gu, " ")}`);
    void isOwner;
    return this.last;
  }

  /**
   * Where a place is.
   *
   * An owner gets coordinates BY WHISPER. Everybody else gets nothing useful - and "nothing
   * useful" is enforced by refusing, not by hoping the words are vague enough.
   */
  whereIs(bot: MemoryBot, key: string, isOwner: boolean): MemoryOutcome {
    const place = this.book.find(key);
    if (place === null) {
      this.last = { kind: "said", line: UNKNOWN_PLACE };
      this.say(bot, UNKNOWN_PLACE);
      return this.last;
    }
    if (!isOwner) {
      this.last = { kind: "refused", reason: "not-an-owner" };
      this.say(bot, "i can't share where places are");
      return this.last;
    }
    this.last = { kind: "whispered", key: place.key };
    this.whisper(bot, `${place.key}: ${place.x}, ${place.y}, ${place.z}`);
    this.say(bot, `i've sent you the spot for ${place.key.replace(/_/gu, " ")}`);
    return this.last;
  }

  /** Walk to a remembered place with a REAL goal. */
  goTo(bot: MemoryBot, key: string, isOwner: boolean): MemoryOutcome {
    const place = this.book.find(key);
    if (place === null) {
      this.last = { kind: "said", line: UNKNOWN_PLACE };
      this.say(bot, UNKNOWN_PLACE);
      return this.last;
    }
    if (!isOwner) {
      this.last = { kind: "refused", reason: "not-an-owner" };
      this.say(bot, "i can't share where places are");
      return this.last;
    }
    const goal = this.goalFor(place);
    if (goal === null) {
      this.last = { kind: "refused", reason: "no-pathfinder" };
      this.say(bot, "i can't find a way there right now");
      return this.last;
    }
    try {
      bot.pathfinder?.setGoal(goal);
    } catch {
      this.last = { kind: "refused", reason: "no-pathfinder" };
      return this.last;
    }
    this.last = { kind: "walking", key: place.key };
    this.say(bot, `on my way to ${place.key.replace(/_/gu, " ")}`);
    return this.last;
  }

  /**
   * Where Elix died.
   *
   * The same rule as every other place: an owner is whispered the coordinates, and the public
   * line says only that Elix died and how long ago.
   */
  whereDied(bot: MemoryBot, isOwner: boolean): MemoryOutcome {
    const death = this.book.lastDeath();
    if (death === null) {
      this.last = { kind: "said", line: UNKNOWN_DEATH };
      this.say(bot, UNKNOWN_DEATH);
      return this.last;
    }
    if (!isOwner) {
      this.last = { kind: "refused", reason: "not-an-owner" };
      this.say(bot, "i can't share where places are");
      return this.last;
    }
    this.last = { kind: "whispered", key: death.player };
    this.whisper(bot, `${death.player}: ${death.x}, ${death.y}, ${death.z}`);
    this.say(bot, describeDeath(death));
    return this.last;
  }

  /** The real goal, or null when the pathfinder is not loaded. */
  private goalFor(place: Place): unknown {
    const { GoalGetToBlock, GoalNear } = this.deps.goals;
    try {
      // Three NUMBERS, four NUMBERS. Passing a position object gives NaN coordinates and a
      // pathfinder that walks confidently in a straight line away from the target.
      if (typeof GoalGetToBlock === "function") return new GoalGetToBlock(place.x, place.y, place.z);
      if (typeof GoalNear === "function") return new GoalNear(place.x, place.y, place.z, 1);
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Say something in public chat - but only if it has no coordinates in it.
   *
   * The guard is here rather than at the call sites so a new line cannot bypass it by being
   * added somewhere new.
   */
  private say(bot: MemoryBot, line: string): void {
    if (looksLikeCoordinates(line)) return;
    const chat = (bot as { chat?: (text: string) => void }).chat;
    if (typeof chat === "function") chat.call(bot, line);
  }

  /** Whisper the owner. The only channel a coordinate ever takes. */
  private whisper(bot: MemoryBot, text: string): void {
    if (typeof bot.whisper !== "function") return;
    // The owner is whoever asked; the runner is per-request so the name is fixed at start.
    const to = this.ownerName;
    if (to === null) return;
    bot.whisper(to, text);
  }

  /** The player coordinates are whispered to. Set by the dispatcher before every line. */
  private ownerName: string | null = null;

  /** Tell the runtime who to whisper to. Never a non-owner. */
  setRecipient(name: string | null): void {
    this.ownerName = name;
  }

  /** A public line with no numbers - for the caller. */
  publicLine(place: Place): string {
    return describePlace(place);
  }
}
