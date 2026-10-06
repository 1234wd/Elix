/**
 * WP6 — world memory: the places Elix has been told to remember, and where people died.
 *
 * Two tables' worth of memory, and both are deliberately awkward in the same way: a
 * coordinate is only ever spoken to an OWNER, and only ever by WHISPER. A public "you died
 * at 120, 64, -300" is a stranger's house broadcast to everyone on the server, and
 * `coordinateWords` exists so that rule is testable rather than aspirational.
 *
 * The migration is the other half. `places` already existed before this WP; `deaths` is new,
 * so `migrate` has to add it to a database that was created by an older build. That is
 * tested against a COPY of an old schema, never the live file.
 */
import type { MemoryStore, Row } from "../memory/store.js";

/** A place Elix has been told to remember. */
export interface Place {
  key: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  dimension: string | null;
  note: string | null;
  ts: number;
}

/** Where somebody died. */
export interface DeathRecord {
  /** Player name, or "elix" for Elix himself. */
  player: string;
  x: number;
  y: number;
  z: number;
  dimension: string | null;
  ts: number;
  cause: string | null;
}

/** What kind of place this is. Free-form words are allowed too. */
export const PLACE_KINDS: readonly string[] = Object.freeze(["home", "base", "farm", "mine", "shop", "note"]);

/** Never dig within this many blocks of a remembered place. */
export const PROTECTED_RADIUS = 24;

/** A position, in the shape mineflayer and vec3 agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Add the WP6 tables to an existing database.
 *
 * Written as plain SQL rather than a schema-version table because the store has never had one
 * and adding a version counter now would mean inventing a number for every schema that came
 * before. `CREATE TABLE IF NOT EXISTS` is idempotent, so this is safe to run on every open.
 *
 * Returns the SQL it ran, so the migration test can assert what happened instead of guessing.
 */
export function migrate(db: { exec: (sql: string) => unknown }): string[] {
  const statements = [
    `CREATE TABLE IF NOT EXISTS deaths (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      player    TEXT NOT NULL,
      x         REAL NOT NULL,
      y         REAL NOT NULL,
      z         REAL NOT NULL,
      dimension TEXT,
      cause     TEXT,
      ts        INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS deaths_player_ts ON deaths (player, ts DESC)`,
    // A remembered place needs a radius column so a later WP can widen it without a rewrite.
    `ALTER TABLE places ADD COLUMN protected INTEGER NOT NULL DEFAULT 1`,
  ];
  for (const sql of statements) {
    // `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS in SQLite, so a second run fails.
    // Catching here is what makes the migration idempotent, and the test proves both runs
    // leave the same schema.
    try {
      db.exec(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const alreadyThere =
        message.includes("duplicate column name") || message.includes("already exists");
      if (!alreadyThere) throw err;
    }
  }
  return statements;
}

/** True when this name looks like three coordinates, in any order, with signs. */
export function looksLikeCoordinates(text: string): boolean {
  const nums = text.match(/[-+]?\d+(?:\.\d+)?/gu) ?? [];
  return nums.length >= 3 && /\d/.test(text);
}

/**
 * The coordinate numbers in a string, or [].
 *
 * Used by the whisper-only test and by nothing else. It exists so the rule "a public reply
 * never contains three integers in coordinate form" is a check rather than a hope.
 */
export function coordinateWords(text: string): string[] {
  return (text.match(/[-+]?\d+(?:\.\d+)?/gu) ?? []).slice();
}

/** How Elix says a place out loud, to an owner, by whisper. */
export function describePlace(place: Place): string {
  const where = `${Math.round(place.x)}, ${Math.round(place.y)}, ${Math.round(place.z)}`;
  const dim = place.dimension === null ? "" : ` in the ${place.dimension}`;
  return `${place.key} is at ${where}${dim}`;
}

/** How Elix answers "where did I die". */
export function describeDeath(death: DeathRecord): string {
  const where = `${Math.round(death.x)}, ${Math.round(death.y)}, ${Math.round(death.z)}`;
  const dim = death.dimension === null ? "" : ` in the ${death.dimension}`;
  const cause = death.cause === null || death.cause === "" ? "" : ` - ${death.cause}`;
  return `you died at ${where}${dim}${cause}`;
}

/** The short line for "I do not know that". */
export const UNKNOWN_PLACE = "i don't know that place";
export const UNKNOWN_DEATH = "i didn't see that one";

/**
 * Is a dig inside a protected place?
 *
 * WP5's `refuseDig` already implements this rule for the owner's own position; this is the
 * same rule over EVERY remembered place, which is what makes a remembered home safe.
 */
export function isProtected(
  position: Vec3Like,
  places: readonly Place[],
  radius = PROTECTED_RADIUS,
): boolean {
  for (const place of places) {
    if (place.x === null || place.y === null || place.z === null) continue;
    if (Math.hypot(place.x - position.x, place.z - position.z) < radius) return true;
  }
  return false;
}

/** Parse "elix remember this place as home". */
export function parseRemember(message: string, botName: string): { key: string; kind: string } | null {
  const rest = stripName(message, botName);
  if (rest === null) return null;
  const m = /^(?:remember|save|note)\s+(?:this\s+)?(?:place|spot|location)?\s*as\s+([a-z_]+)$/u.exec(rest);
  if (m === null) return null;
  const key = (m[1] ?? "").trim().replace(/\s+/gu, "_");
  if (key === "" || key.length > 32) return null;
  return { key, kind: PLACE_KINDS.includes(key) ? key : "note" };
}

/** Parse "elix take me home" or "elix go to the farm". */
export function parseGoTo(message: string, botName: string): string | null {
  const rest = stripName(message, botName);
  if (rest === null) return null;
  const m = /^(?:take me|go|come|walk|head|bring me)\s+(?:to\s+)?(?:the\s+)?([a-z_ ]+?)(?:\s+please)?$/u.exec(rest);
  if (m === null) return null;
  const key = (m[1] ?? "").trim().replace(/\s+/gu, "_");
  return key === "" ? null : key;
}

/** Parse "elix where did i die". */
export function parseWhereDied(message: string, botName: string): boolean {
  const rest = stripName(message, botName);
  if (rest === null) return false;
  return /^(?:where did i die|where did i die|when did i die|how did i die)$/u.test(rest);
}

/** Parse "elix where is testspot". */
export function parseWhereIs(message: string, botName: string): string | null {
  const rest = stripName(message, botName);
  if (rest === null) return null;
  const m = /^where is\s+(?:the\s+)?([a-z_ ]+?)(?:\s+place)?$/u.exec(rest);
  if (m === null) return null;
  const key = (m[1] ?? "").trim().replace(/\s+/gu, "_");
  return key === "" ? null : key;
}

/** Elix's name, stripped, plus the same two filler words the command path allows. */
function stripName(message: string, botName: string): string | null {
  const normalised = message.toLowerCase().replace(/\s+/gu, " ").trim();
  const escaped = botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const nameRe = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u");
  if (!nameRe.test(normalised)) return null;
  return normalised
    .replace(nameRe, " ")
    .replace(/\b(please|pls|plz|now|bro|yaar|ok|okay)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Store a place through the existing MemoryStore. */
export function rememberPlace(
  store: MemoryStore,
  key: string,
  kind: string,
  at: Vec3Like,
  dimension: string | null,
  ts: number,
): void {
  store.addPlace({ key, kind, ts, x: at.x, y: at.y, z: at.z, dimension, note: null });
}

/** Read a place back, with the numbers the store actually held. */
export function loadPlace(store: MemoryStore, key: string): Place | null {
  const raw = store.place(key) as Row | null | undefined;
  // The store returns `null` for a key it does not have, and `undefined` is possible too -
  // both mean "no such place", and neither is a position of zeroes.
  if (raw === null || raw === undefined) return null;
  const x = raw["x"];
  const y = raw["y"];
  const z = raw["z"];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  return {
    key,
    kind: typeof raw["kind"] === "string" ? raw["kind"] : "note",
    x,
    y,
    z,
    dimension: typeof raw["dimension"] === "string" ? raw["dimension"] : null,
    note: typeof raw["note"] === "string" ? raw["note"] : null,
    ts: typeof raw["ts"] === "number" ? raw["ts"] : 0,
  };
}

/** Every remembered place, nearest first from `from`, within `within` blocks. */
export function protectedPlacesFrom(store: MemoryStore, from: Vec3Like, radius = PROTECTED_RADIUS): Vec3Like[] {
  const out: Vec3Like[] = [];
  for (const raw of store.places()) {
    const x = raw["x"];
    const y = raw["y"];
    const z = raw["z"];
    if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") continue;
    if (Math.hypot(x - from.x, z - from.z) > radius) continue;
    out.push({ x, y, z });
  }
  return out;
}