/**
 * Memory storage (Phase 4, D1).
 *
 * One file, one class, one database. Everything the brain needs to remember
 * lives here: episodes, facts, people, places, self, promises and mood state.
 *
 * Design rules from VISION C1, all enforced below:
 *
 *  - APPEND-ONLY. A row is never updated in place except to fill in an embedding
 *    and to mark a fact superseded. A changed fact gets a NEW row; the old one
 *    keeps its text and points at its successor via `superseded_by`. That is why
 *    "Ali likes diamonds" becoming "Ali likes sulfur" adds history instead of
 *    erasing it.
 *  - The only deletion is `forgetPlayer()`, and it is a privacy requirement.
 *  - A VECTOR IS STORED IN ONE PLACE ONLY: the `episode_vec` vec0 virtual
 *    table. There is deliberately no BLOB column. `embedded_model` on episodes
 *    records which model produced each vector, and a dimension mismatch is
 *    logged and left FTS-only rather than silently corrupting the index.
 *  - An embedding failure never loses the memory. The row is written with
 *    `embedding IS NULL` and backfilled later; retrieval works through FTS5 in
 *    the meantime.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// node:sqlite via createRequire: esbuild strips the `node:` prefix from a static
// import, and there is no bare `sqlite` module. See src/brain/store.ts.
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type Db = InstanceType<typeof DatabaseSync>;

/** The meta key holding the consolidation watermark (A2). */
const WATERMARK_KEY = "consolidated_episode_id";

/** Who said it. Elix's own lines are episodes too, so he remembers what he said. */
export type Speaker = "player" | "elix";

export type EpisodeKind =
  /** A line Elix heard but was not part of (A6). Quiet by design. */
  | "ambient"
  | "chat"
  | "death"
  | "build"
  | "trade"
  | "event"
  | "move"
  | "emotion"
  | "reflect"
  | "promise";

export interface Episode {
  id: number;
  ts: number;
  kind: EpisodeKind;
  player: string | null;
  speaker: Speaker;
  text: string;
  meta: string | null;
  importance: number;
  emotion: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
  server: string | null;
  /** Which model produced the vector, or null when not embedded yet. */
  embeddedModel: string | null;
  /** Redaction hits removed at write time (D4). */
  redacted: boolean;
}

export interface Fact {
  id: number;
  ts: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceEpisode: number | null;
  /** The newer fact that replaced this one, if any. Never a text overwrite. */
  supersededBy: number | null;
  validUntil: number | null;
}

export interface Promise {
  id: number;
  ts: number;
  player: string;
  text: string;
  state: "open" | "kept" | "broken";
  madeEpisode: number | null;
  keptEpisode: number | null;
}

export interface Person {
  player: string;
  firstSeen: number;
  lastSeen: number;
  familiarity: number;
  affection: number;
  trust: number;
  aliases: string[];
  insideJokes: string[];
  preferences: string[];
  birthday: string | null;
  lastGreeted: number | null;
  promiseCount: number;
}

export interface MoodState {
  valence: number;
  arousal: number;
  dominance: number;
  mood: string;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  kind            TEXT    NOT NULL,
  player          TEXT,
  speaker         TEXT    NOT NULL DEFAULT 'player',
  text            TEXT    NOT NULL,
  meta            TEXT,
  importance      REAL    NOT NULL DEFAULT 2,
  emotion         TEXT,
  x               REAL,
  y               REAL,
  z               REAL,
  dimension       TEXT,
  server          TEXT,
  embedded_model  TEXT,
  redacted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodes_ts    ON episodes (ts);
CREATE INDEX IF NOT EXISTS episodes_player ON episodes (player);
CREATE INDEX IF NOT EXISTS episodes_kind   ON episodes (kind);
CREATE INDEX IF NOT EXISTS episodes_unembedded ON episodes (id) WHERE embedded_model IS NULL;

CREATE TABLE IF NOT EXISTS facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  subject         TEXT    NOT NULL,
  predicate       TEXT    NOT NULL,
  object          TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 0.5,
  source_episode  INTEGER,
  superseded_by   INTEGER,
  valid_until     INTEGER
);
CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject, predicate);

CREATE TABLE IF NOT EXISTS people (
  player        TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  familiarity   REAL NOT NULL DEFAULT 0,
  affection     REAL NOT NULL DEFAULT 0.2,
  trust         REAL NOT NULL DEFAULT 0.2,
  aliases       TEXT NOT NULL DEFAULT '[]',
  inside_jokes  TEXT NOT NULL DEFAULT '[]',
  preferences   TEXT NOT NULL DEFAULT '[]',
  birthday      TEXT,
  last_greeted  INTEGER,
  promise_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS places (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL DEFAULT 'note',
  x REAL, y REAL, z REAL,
  dimension TEXT,
  note      TEXT,
  ts        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS self (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promises (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  player       TEXT NOT NULL,
  text         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open',
  made_episode INTEGER,
  kept_episode INTEGER
);
CREATE INDEX IF NOT EXISTS promises_player ON promises (player, state);

CREATE TABLE IF NOT EXISTS mood_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  valence    REAL NOT NULL DEFAULT 0,
  arousal    REAL NOT NULL DEFAULT 0,
  dominance  REAL NOT NULL DEFAULT 0,
  mood       TEXT NOT NULL DEFAULT 'calm',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  episodes   INTEGER NOT NULL,
  facts_made INTEGER NOT NULL DEFAULT 0,
  diary      TEXT,
  status     TEXT NOT NULL DEFAULT 'ok'
);

-- A2: the highest episode id already sent to consolidation. Without it every
-- run re-sent the same episodes: duplicate facts, repeated diary entries, and
-- the same smart quota spent again. Advanced ONLY after validated writes.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Keyword search. Always available, so a memory is never unreachable because an
-- embedding failed.
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  text, content='episodes', content_rowid='id', tokenize='porter'
);
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episode_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episode_fts(episode_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF text ON episodes BEGIN
  INSERT INTO episode_fts(episode_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO episode_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

/**
 * The vector table is created separately because vec0's dimension is fixed at
 * table-creation time, and it may not be loadable at all.
 */
const VEC_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS episode_vec USING vec0(embedding float[384]);
`;

/** One row, with the columns this store does not model left untyped. */
export type Row = Record<string, unknown>;

export interface MemoryStoreOptions {
  path: string;
  /** vec0 dimension. Must match the embedding model, forever. */
  dimensions?: number;
  /** The embedding model id whose dimension this database was built for. */
  embeddingModel?: string;
}

export class MemoryStore {
  private readonly db: Db;
  private vecLoaded = false;
  /** Where this database lives. Backups, the CLI and the scheduler all need it. */
  readonly path: string;
  readonly dimensions: number;
  readonly embeddingModel: string;

  constructor(opts: MemoryStoreOptions) {
    mkdirSync(dirname(opts.path), { recursive: true });
    this.path = opts.path;
    this.dimensions = opts.dimensions ?? 384;
    this.embeddingModel = opts.embeddingModel ?? "BAAI/bge-small-en-v1.5";
    this.db = new DatabaseSync(opts.path, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** Load sqlite-vec. Never throws: retrieval falls back to FTS5. */
  loadVec(): { loaded: boolean; version?: string; error?: string } {
    try {
      const vec = require("sqlite-vec") as { getLoadablePath?(): string };
      const path = vec.getLoadablePath?.();
      if (!path) return { loaded: false, error: "sqlite-vec path not found" };
      this.db.loadExtension(path);
      const existing = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_vec'")
        .get() as { name: string } | undefined;
      if (existing) {
        // A dimension mismatch must never mix vector spaces. readVecInfo() does
        // NOT check `vecLoaded` — asking vecInfo() here returned null every time
        // (it is only populated once loading succeeds) and the check was dead.
        const info = this.readVecInfo();
        if (info && info.dimensions !== this.dimensions) {
          return {
            loaded: false,
            error:
              `vector table is ${info.dimensions}-d but the configured model ` +
              `${this.embeddingModel} is ${this.dimensions}-d; those spaces cannot be mixed`,
          };
        }
        this.vecLoaded = true;
        return { loaded: true, version: this.vecVersion() };
      }
      this.db.exec(VEC_SCHEMA);
      this.vecLoaded = true;
      return { loaded: true, version: this.vecVersion() };
    } catch (err) {
      return { loaded: false, error: (err as Error).message };
    }
  }

  get hasVectors(): boolean {
    return this.vecLoaded;
  }

  private vecVersion(): string | undefined {
    try {
      return (this.db.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
    } catch {
      return undefined;
    }
  }

  /** Dimension and row count of the vec table. Works before `vecLoaded` is set. */
  private readVecInfo(): { dimensions: number; rows: number } | null {
    try {
      const ddl = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE name='episode_vec'")
        .get() as { sql: string } | undefined;
      const m = /float\[(\d+)\]/.exec(ddl?.sql ?? "");
      const rows = (
        this.db.prepare("SELECT count(*) AS c FROM episode_vec").get() as { c: number }
      ).c;
      return { dimensions: m ? Number.parseInt(m[1]!, 10) : 0, rows };
    } catch {
      return null;
    }
  }

  /** Dimension of the existing vec0 table, or null when there is none. */
  vecInfo(): { dimensions: number; rows: number } | null {
    if (!this.vecLoaded) return null;
    return this.readVecInfo();
  }

  // -- episodes ------------------------------------------------------------

  addEpisode(e: {
    ts: number;
    kind: EpisodeKind;
    player?: string | null;
    speaker?: Speaker;
    text: string;
    meta?: string | null;
    importance?: number;
    emotion?: string | null;
    x?: number | null;
    y?: number | null;
    z?: number | null;
    dimension?: string | null;
    server?: string | null;
    redacted?: boolean;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO episodes
           (ts, kind, player, speaker, text, meta, importance, emotion,
            x, y, z, dimension, server, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ts,
        e.kind,
        e.player ?? null,
        e.speaker ?? "player",
        e.text,
        e.meta ?? null,
        e.importance ?? 2,
        e.emotion ?? null,
        e.x ?? null,
        e.y ?? null,
        e.z ?? null,
        e.dimension ?? null,
        e.server ?? null,
        e.redacted ? 1 : 0,
      );
    return Number(info.lastInsertRowid);
  }

  episode(id: number): Episode | null {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapEpisode(row) : null;
  }

  episodesSince(since: number, limit = 500): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE ts >= ? ORDER BY ts ASC LIMIT ?")
      .all(since, limit) as unknown as Record<string, unknown>[];
    return rows.map(mapEpisode);
  }

  /** Episodes with no vector yet — the backfill worklist. */
  unembedded(limit = 16): Episode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM episodes WHERE embedded_model IS NULL ORDER BY id ASC LIMIT ?",
      )
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map(mapEpisode);
  }

  countUnembedded(): number {
    return (
      this.db.prepare("SELECT count(*) AS c FROM episodes WHERE embedded_model IS NULL").get() as {
        c: number;
      }
    ).c;
  }

  /** Store a vector and mark the episode embedded, in one transaction. */
  markEmbedded(id: number, vector: number[]): void {
    if (!this.vecLoaded) throw new Error("vector table is not loaded");
    if (vector.length !== this.dimensions) {
      throw new Error(
        `embedding is ${vector.length}-d, expected ${this.dimensions}`,
      );
    }
    this.db.exec("BEGIN");
    try {
      // vec0 rowids must be integers and node:sqlite binds a JS number as REAL,
      // so the id is passed as a BigInt.
      this.db
        .prepare("INSERT INTO episode_vec(rowid, embedding) VALUES (?, ?)")
        .run(BigInt(id), JSON.stringify(vector));
      this.db
        .prepare("UPDATE episodes SET embedded_model = ? WHERE id = ?")
        .run(this.embeddingModel, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // -- consolidation watermark (A2) ---------------------------------------

  /**
   * The highest episode id already consolidated.
   *
   * 0 when nothing has been. The nightly pass and the shutdown pass both read and
   * write this, so a day is summarised once no matter how many times Elix is
   * restarted, or how many nights pass.
   */
  consolidatedWatermark(): number {
    const v = this.getMeta(WATERMARK_KEY);
    const n = v === null ? 0 : Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Advance the watermark.
   *
   * Called only after the facts and diary have committed, and only up to the
   * last episode that was actually summarised — a capped run leaves the deferred
   * episodes for the next night.
   */
  setConsolidatedWatermark(id: number): void {
    if (id > this.consolidatedWatermark()) this.setMeta(WATERMARK_KEY, String(id));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Episodes strictly above the watermark, oldest first. */
  episodesAfterId(id: number, limit = 400): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(id, limit) as unknown as Record<string, unknown>[];
    return rows.map(mapEpisode);
  }

  /** The largest episode id in the table, or 0. */
  maxEpisodeId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM episodes").get() as {
      m: number;
    };
    return row.m;
  }

  /** D2/D5: consolidation may adjust a score after the fact. */
  setImportance(id: number, importance: number): void {
    this.db
      .prepare("UPDATE episodes SET importance = ? WHERE id = ?")
      .run(Math.max(0, Math.min(10, importance)), id);
  }

  // -- facts ---------------------------------------------------------------

  addFact(f: {
    ts: number;
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
    sourceEpisode?: number | null;
  }): number {
    // A2: the SAME subject + predicate + object again is a CONFIRMATION, not a new
    // fact. Without this every consolidation pass added another row, so a fact
    // stated once became two, then five, then twenty.
    //
    // This has to run BEFORE the insert. Checking afterwards finds the row that
    // was just written and leaves it behind, which is the very duplicate this is
    // meant to prevent — the fact count still grew, only the returned id was old.
    const same = this.db
      .prepare(
        `SELECT id, confidence FROM facts
          WHERE subject = ? AND predicate = ? AND object = ?
            AND superseded_by IS NULL AND valid_until IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(f.subject, f.predicate, f.object) as
      | { id: number; confidence: number }
      | undefined;
    if (same) {
      // Repeated evidence raises confidence, and can never lower it.
      const bumped = Math.min(1, Math.max(same.confidence, f.confidence ?? 0) + 0.02);
      this.db
        .prepare("UPDATE facts SET confidence = ?, ts = ? WHERE id = ?")
        .run(bumped, f.ts, same.id);
      return same.id;
    }

    const info = this.db
      .prepare(
        `INSERT INTO facts (ts, subject, predicate, object, confidence, source_episode)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(f.ts, f.subject, f.predicate, f.object, f.confidence ?? 0.5, f.sourceEpisode ?? null);
    const id = Number(info.lastInsertRowid);

    // D1: a changed fact KEEPS its history. The old row's text is never updated;
    // it is only linked forward to the new one.
    //
    // The prior row is found by subject + predicate with a DIFFERENT object —
    // matching on the same object (as this first did) can only ever find a
    // duplicate, never the fact it actually supersedes, so "Ali likes diamonds"
    // changing to "cherry planks" left BOTH live and retrieval contradicted
    // itself.
    const prior = this.db
      .prepare(
        `SELECT id FROM facts
          WHERE subject = ? AND predicate = ? AND object <> ?
            AND superseded_by IS NULL AND valid_until IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(f.subject, f.predicate, f.object) as { id: number } | undefined;
    if (prior) {
      this.db
        .prepare("UPDATE facts SET superseded_by = ?, valid_until = ? WHERE id = ?")
        .run(id, f.ts, prior.id);
    }
    return id;
  }

  fact(id: number): Fact | null {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapFact(row) : null;
  }

  /** Live facts for a subject, oldest first. Superseded rows are excluded. */
  factsFor(subject: string, limit = 20): Fact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM facts
          WHERE subject = ? AND superseded_by IS NULL AND valid_until IS NULL
          ORDER BY id ASC LIMIT ?`,
      )
      .all(subject, limit) as unknown as Record<string, unknown>[];
    return rows.map(mapFact);
  }

  allFacts(limit = 200): Fact[] {
    const rows = this.db
      .prepare("SELECT * FROM facts ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map(mapFact);
  }

  // -- people --------------------------------------------------------------

  touchPerson(player: string, now: number): Person {
    const existing = this.person(player);
    if (!existing) {
      this.db
        .prepare("INSERT INTO people (player, first_seen, last_seen) VALUES (?, ?, ?)")
        .run(player, now, now);
      return this.person(player)!;
    }
    this.db.prepare("UPDATE people SET last_seen = ? WHERE player = ?").run(now, player);
    return this.person(player)!;
  }

  person(player: string): Person | null {
    const row = this.db.prepare("SELECT * FROM people WHERE player = ?").get(player) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPerson(row) : null;
  }

  bumpRelation(
    player: string,
    deltas: { familiarity?: number; affection?: number; trust?: number },
    now: number = Date.now(),
  ): void {
    // `now` is a parameter, not Date.now() inline. With a fake clock in tests —
    // and the recorder uses one — the previous version stamped `last_seen` with
    // real time, so a join recorded at t=1000 came back with last_seen set to
    // "now" instead.
    this.touchPerson(player, now);
    this.db
      .prepare(
        `UPDATE people SET
           familiarity = MIN(1.0, MAX(0.0, familiarity + ?)),
           affection   = MIN(1.0, MAX(0.0, affection   + ?)),
           trust       = MIN(1.0, MAX(0.0, trust       + ?))
         WHERE player = ?`,
      )
      .run(deltas.familiarity ?? 0, deltas.affection ?? 0, deltas.trust ?? 0, player);
  }

  setPersonJson(
    player: string,
    field: "aliases" | "insideJokes" | "preferences",
    value: string[],
  ): void {
    this.touchPerson(player, Date.now());
    this.db
      .prepare(`UPDATE people SET ${field} = ? WHERE player = ?`)
      .run(JSON.stringify(value), player);
  }

  setBirthday(player: string, birthday: string | null): void {
    this.touchPerson(player, Date.now());
    this.db.prepare("UPDATE people SET birthday = ? WHERE player = ?").run(birthday, player);
  }

  markGreeted(player: string, now: number): void {
    this.touchPerson(player, now);
    this.db.prepare("UPDATE people SET last_greeted = ? WHERE player = ?").run(now, player);
  }

  allPeople(): Person[] {
    const rows = this.db
      .prepare("SELECT * FROM people ORDER BY last_seen DESC")
      .all() as unknown as Record<string, unknown>[];
    return rows.map(mapPerson);
  }

  // -- promises ------------------------------------------------------------

  addPromise(p: { ts: number; player: string; text: string; madeEpisode?: number | null }): number {
    const info = this.db
      .prepare(
        "INSERT INTO promises (ts, player, text, made_episode) VALUES (?, ?, ?, ?)",
      )
      .run(p.ts, p.player, p.text, p.madeEpisode ?? null);
    // touchPerson creates the row if it is new, so the increment has to come
    // after it or it would update zero rows for a first-time player.
    this.touchPerson(p.player, p.ts);
    this.db
      .prepare("UPDATE people SET promise_count = promise_count + 1 WHERE player = ?")
      .run(p.player);
    return Number(info.lastInsertRowid);
  }

  setPromiseState(
    id: number,
    state: Promise["state"],
    keptEpisode: number | null = null,
  ): void {
    this.db
      .prepare("UPDATE promises SET state = ?, kept_episode = ? WHERE id = ?")
      .run(state, keptEpisode, id);
  }

  promises(player: string, state?: Promise["state"]): Promise[] {
    const rows = (
      state
        ? this.db
            .prepare("SELECT * FROM promises WHERE player = ? AND state = ? ORDER BY id DESC")
            .all(player, state)
        : this.db.prepare("SELECT * FROM promises WHERE player = ? ORDER BY id DESC").all(player)
    ) as unknown as Record<string, unknown>[];
    return rows.map(mapPromise);
  }

  countPromises(state?: Promise["state"]): number {
    const row = (
      state
        ? this.db.prepare("SELECT count(*) AS c FROM promises WHERE state = ?").get(state)
        : this.db.prepare("SELECT count(*) AS c FROM promises").get()
    ) as { c: number };
    return row.c;
  }

  // -- places and self -----------------------------------------------------

  addPlace(p: {
    key: string;
    kind: string;
    ts: number;
    x?: number | null;
    y?: number | null;
    z?: number | null;
    dimension?: string | null;
    note?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO places (key, kind, ts, x, y, z, dimension, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           kind = excluded.kind, ts = excluded.ts, x = excluded.x, y = excluded.y,
           z = excluded.z, dimension = excluded.dimension, note = excluded.note`,
      )
      .run(p.key, p.kind, p.ts, p.x ?? null, p.y ?? null, p.z ?? null, p.dimension ?? null, p.note ?? null);
  }

  /**
   * Every remembered place.
   *
   * WP6 needs this because WP5's protected radius has to consider ALL of them, not just the
   * one somebody happened to name. Returns raw rows; `src/world/memory.ts` reads them
   * through guards, because a place with null coordinates is legal in this schema.
   */
  places(): Row[] {
    return this.db.prepare("SELECT * FROM places ORDER BY ts DESC").all() as Row[];
  }

  /** Where somebody last died, or null. */
  lastDeath(player: string): Row | null {
    const row = this.db
      .prepare("SELECT * FROM deaths WHERE player = ? ORDER BY ts DESC LIMIT 1")
      .get(player) as Row | undefined;
    return row ?? null;
  }

  /** Every death for a player, newest first. */
  deaths(player: string, limit = 5): Row[] {
    return this.db
      .prepare("SELECT * FROM deaths WHERE player = ? ORDER BY ts DESC LIMIT ?")
      .all(player, limit) as Row[];
  }

  /** Record where somebody died. */
  addDeath(d: {
    player: string;
    x: number;
    y: number;
    z: number;
    dimension?: string | null;
    cause?: string | null;
    ts: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO deaths (player, x, y, z, dimension, cause, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.player, d.x, d.y, d.z, d.dimension ?? null, d.cause ?? null, d.ts);
  }

  /** How many deaths are remembered, for a player or in total. */
  deathCount(player?: string): number {
    const row =
      player === undefined
        ? (this.db.prepare("SELECT COUNT(*) AS n FROM deaths").get() as { n: number })
        : (this.db.prepare("SELECT COUNT(*) AS n FROM deaths WHERE player = ?").get(player) as { n: number });
    return row?.n ?? 0;
  }

  place(key: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM places WHERE key = ?").get(key) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  addSelf(kind: string, text: string, ts = Date.now()): number {
    const info = this.db
      .prepare("INSERT INTO self (ts, kind, text) VALUES (?, ?, ?)")
      .run(ts, kind, text);
    return Number(info.lastInsertRowid);
  }

  recentSelf(limit = 10): Array<{ id: number; ts: number; kind: string; text: string }> {
    const rows = this.db
      .prepare("SELECT * FROM self ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<{ id: number; ts: number; kind: string; text: string }>;
    return rows;
  }

  // -- mood ----------------------------------------------------------------

  /** One row, persisted across restarts. Phase 5 drives this. */
  mood(): MoodState {
    const row = this.db.prepare("SELECT * FROM mood_state WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      this.db
        .prepare(
          "INSERT INTO mood_state (id, valence, arousal, dominance, mood, updated_at) VALUES (1, 0, 0, 0, 'calm', ?)",
        )
        .run(Date.now());
      return { valence: 0, arousal: 0, dominance: 0, mood: "calm", updatedAt: Date.now() };
    }
    return {
      valence: Number(row.valence),
      arousal: Number(row.arousal),
      dominance: Number(row.dominance),
      mood: String(row.mood),
      updatedAt: Number(row.updated_at),
    };
  }

  setMood(m: Partial<Omit<MoodState, "updatedAt">>, now = Date.now()): MoodState {
    const cur = this.mood();
    const next: MoodState = {
      valence: m.valence ?? cur.valence,
      arousal: m.arousal ?? cur.arousal,
      dominance: m.dominance ?? cur.dominance,
      mood: m.mood ?? cur.mood,
      updatedAt: now,
    };
    this.db
      .prepare(
        `UPDATE mood_state SET valence = ?, arousal = ?, dominance = ?, mood = ?, updated_at = ?
          WHERE id = 1`,
      )
      .run(next.valence, next.arousal, next.dominance, next.mood, next.updatedAt);
    return next;
  }

  // -- consolidation log ---------------------------------------------------

  logConsolidation(entry: {
    ts: number;
    episodes: number;
    factsMade: number;
    diary?: string | null;
    status?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO consolidation_log (ts, episodes, facts_made, diary, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entry.ts, entry.episodes, entry.factsMade, entry.diary ?? null, entry.status ?? "ok");
  }

  lastConsolidation(): { ts: number; episodes: number; factsMade: number; diary: string | null; status: string } | null {
    const row = this.db
      .prepare("SELECT * FROM consolidation_log ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row
      ? {
          ts: Number(row.ts),
          episodes: Number(row.episodes),
          factsMade: Number(row.facts_made),
          diary: (row.diary as string | null) ?? null,
          status: String(row.status),
        }
      : null;
  }

  // -- stats ---------------------------------------------------------------

  stats(): Record<string, number> {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      episodes: one("SELECT count(*) AS c FROM episodes"),
      facts: one("SELECT count(*) AS c FROM facts"),
      liveFacts: one(
        "SELECT count(*) AS c FROM facts WHERE superseded_by IS NULL AND valid_until IS NULL",
      ),
      people: one("SELECT count(*) AS c FROM people"),
      places: one("SELECT count(*) AS c FROM places"),
      self: one("SELECT count(*) AS c FROM self"),
      promises: one("SELECT count(*) AS c FROM promises"),
      openPromises: one("SELECT count(*) AS c FROM promises WHERE state = 'open'"),
      unembedded: this.countUnembedded(),
      consolidations: one("SELECT count(*) AS c FROM consolidation_log"),
    };
  }

  // -- deletion (privacy) --------------------------------------------------

  /**
   * D6: remove a player's data from EVERY table, including FTS and vectors.
   *
   * This is the only code in the project that deletes anything, and it exists
   * because it is a privacy requirement. Returns a per-table count so the CLI
   * can tell the user exactly what went.
   *
   * Every comparison is CASE-INSENSITIVE. Minecraft usernames are not case
   * sensitive, Elix stores the name however the player typed it, and
   * consolidation lowercases subjects — so `subject = ?` silently missed rows it
   * had to delete. That is the one thing in this project that must never miss.
   */
  forgetPlayer(player: string): Record<string, number> {
    const want = player.toLowerCase();
    // The player's own lines, plus any of Elix's replies that name them. Elix's
    // replies carry the player in `meta`, so a case-insensitive substring match is
    // the honest way to find them.
    const ids = this.db
      .prepare(
        `SELECT id FROM episodes
          WHERE lower(player) = ?
             OR (speaker = 'elix' AND lower(IFNULL(meta, '')) LIKE ?)`,
      )
      .all(want, `%${want}%`) as unknown as Array<{ id: number }>;
    const episodeIds = ids.map((r) => r.id);

    const removed: Record<string, number> = {
      episodes: 0,
      vectors: 0,
      facts: 0,
      promises: 0,
      people: 0,
      places: 0,
    };

    this.db.exec("BEGIN");
    try {
      for (const id of episodeIds) {
        if (this.vecLoaded) {
          try {
            this.db.prepare("DELETE FROM episode_vec WHERE rowid = ?").run(BigInt(id));
            removed.vectors!++;
          } catch {
            /* a row with no vector is fine */
          }
        }
        // The FTS delete trigger fires on the episodes delete, so no manual work.
        this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
        removed.episodes!++;
      }
      // A fact about this player, either as subject or as the object.
      const facts = this.db
        .prepare("SELECT id FROM facts WHERE lower(subject) = ? OR lower(object) = ?")
        .all(want, want) as unknown as Array<{ id: number }>;
      for (const f of facts) {
        this.db.prepare("DELETE FROM facts WHERE id = ?").run(f.id);
        removed.facts!++;
      }
      const promises = this.db
        .prepare("SELECT id FROM promises WHERE lower(player) = ?")
        .all(want) as unknown as Array<{ id: number }>;
      for (const p of promises) {
        this.db.prepare("DELETE FROM promises WHERE id = ?").run(p.id);
        removed.promises!++;
      }
      this.db.prepare("DELETE FROM people WHERE lower(player) = ?").run(want);
      removed.people = 1;
      this.db.prepare("DELETE FROM places WHERE lower(key) = ?").run(`player:${want}`);
      removed.places = 1;
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return removed;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** Escape hatch for backups and tests. */
  raw(): Db {
    return this.db;
  }
}

// -- row mappers ------------------------------------------------------------

function mapEpisode(r: Record<string, unknown>): Episode {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    kind: String(r.kind) as EpisodeKind,
    player: (r.player as string | null) ?? null,
    speaker: String(r.speaker) as Speaker,
    text: String(r.text),
    meta: (r.meta as string | null) ?? null,
    importance: Number(r.importance),
    emotion: (r.emotion as string | null) ?? null,
    x: r.x === null ? null : Number(r.x),
    y: r.y === null ? null : Number(r.y),
    z: r.z === null ? null : Number(r.z),
    dimension: (r.dimension as string | null) ?? null,
    server: (r.server as string | null) ?? null,
    embeddedModel: (r.embedded_model as string | null) ?? null,
    redacted: Number(r.redacted) !== 0,
  };
}

function mapFact(r: Record<string, unknown>): Fact {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    subject: String(r.subject),
    predicate: String(r.predicate),
    object: String(r.object),
    confidence: Number(r.confidence),
    sourceEpisode: r.source_episode === null ? null : Number(r.source_episode),
    supersededBy: r.superseded_by === null ? null : Number(r.superseded_by),
    validUntil: r.valid_until === null ? null : Number(r.valid_until),
  };
}

function mapPromise(r: Record<string, unknown>): Promise {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    player: String(r.player),
    text: String(r.text),
    state: String(r.state) as Promise["state"],
    madeEpisode: r.made_episode === null ? null : Number(r.made_episode),
    keptEpisode: r.kept_episode === null ? null : Number(r.kept_episode),
  };
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapPerson(r: Record<string, unknown>): Person {
  return {
    player: String(r.player),
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    familiarity: Number(r.familiarity),
    affection: Number(r.affection),
    trust: Number(r.trust),
    aliases: parseJsonArray(r.aliases),
    insideJokes: parseJsonArray(r.inside_jokes),
    preferences: parseJsonArray(r.preferences),
    birthday: (r.birthday as string | null) ?? null,
    lastGreeted: r.last_greeted === null ? null : Number(r.last_greeted),
    promiseCount: Number(r.promise_count),
  };
}

export function defaultMemoryPath(projectRoot: string): string {
  return join(projectRoot, "data", "elix.db");
}
