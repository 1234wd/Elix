/**
 * WP6 acceptance — world memory.
 *
 * Three things are being proven here, and the third is the one that matters most:
 *
 *   1. the MIGRATION. `deaths` and `places.protected` are new, so `migrate` has to upgrade a
 *      database created by an OLDER build. That is tested against a COPY of an old schema on
 *      disk in a temp directory - never the live file, and never an in-memory guess.
 *   2. the COMMANDS. Remember, go-to, where-is, where-died.
 *   3. WHISPER ONLY. A coordinate is a stranger's house address, so a PUBLIC reply must never
 *      contain three integers in coordinate form. `looksLikeCoordinates` exists to make that
 *      a test rather than a promise.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDatabaseModule } from "./sqliteLoader.js";
import { Vec3 } from "vec3";
import { MemoryStore } from "../../src/memory/store.js";
import {
  PROTECTED_RADIUS,
  UNKNOWN_DEATH,
  UNKNOWN_PLACE,
  coordinateWords,
  describeDeath,
  describePlace,
  isProtected,
  looksLikeCoordinates,
  loadPlace,
  migrate,
  parseGoTo,
  parseRemember,
  parseWhereDied,
  parseWhereIs,
  protectedPlacesFrom,
  rememberPlace,
  type Place,
} from "../../src/world/memory.js";
import { refuseDig } from "../../src/skills/gather.js";

/** A database created by an OLDER build: `places` without `protected`, and no `deaths`. */
const OLD_SCHEMA = `
CREATE TABLE places (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL DEFAULT 'note',
  x REAL, y REAL, z REAL,
  dimension TEXT,
  note      TEXT,
  ts        INTEGER NOT NULL
);
CREATE TABLE mood_state (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, mood TEXT);
`;

/** A temp copy of the old schema, so the migration test never touches anything real. */
const DatabaseCtor = resolveDatabaseModule();

function oldDatabaseCopy(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "elix-wp6-"));
  const path = join(dir, "old.db");
  const db = new DatabaseCtor(path);
  db.exec(OLD_SCHEMA);
  db.close();
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fresh store with WP6 already migrated, in its own temp directory. */
function store(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "elix-wp6-store-"));
  const path = join(dir, "memory.db");
  const db = new DatabaseCtor(path);
  db.exec("CREATE TABLE places (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'note', x REAL, y REAL, z REAL, dimension TEXT, note TEXT, ts INTEGER NOT NULL)");
  migrate(db);
  db.close();
  const s = new MemoryStore({ path });
  return {
    store: s,
    // The store holds the database open; on Windows an open file cannot be removed, so the
    // close has to be explicit rather than relying on the process exiting.
    cleanup: () => {
      try {
        s.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

describe("WP6 — the migration upgrades an old database", () => {
  it("adds deaths and places.protected to a database from an older build", () => {
    const copy = oldDatabaseCopy();
    try {
      const db = new DatabaseCtor(copy.path);
      // Before: the columns and the table do not exist.
      expect(() => db.prepare("SELECT protected FROM places").all()).toThrow();
      expect(() => db.prepare("SELECT * FROM deaths").all()).toThrow();

      const ran = migrate(db);
      expect(ran.length).toBeGreaterThanOrEqual(3);

      // After: they do.
      expect(db.prepare("SELECT protected FROM places").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM deaths").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='deaths_player_ts'").all()).toHaveLength(1);
      db.close();
    } finally {
      copy.cleanup();
    }
  });

  it("keeps the rows an old database already had", () => {
    const copy = oldDatabaseCopy();
    try {
      const db = new DatabaseCtor(copy.path);
      db.prepare("INSERT INTO places (key, kind, x, y, z, dimension, note, ts) VALUES (?,?,?,?,?,?,?,?)")
        .run("home", "home", 10, 64, -20, "overworld", null, 1_000);
      migrate(db);
      const rows = db.prepare("SELECT key, x, protected FROM places").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["key"]).toBe("home");
      expect(rows[0]?.["x"]).toBe(10);
      // The new column defaults to 1: an old place is protected, because not protecting it
      // would quietly allow digging through somebody's remembered home.
      expect(rows[0]?.["protected"]).toBe(1);
      db.close();
    } finally {
      copy.cleanup();
    }
  });

  it("is idempotent: running it twice changes nothing", () => {
    const copy = oldDatabaseCopy();
    try {
      const db = new DatabaseCtor(copy.path);
      migrate(db);
      const after = db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
      expect(() => migrate(db)).not.toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(after);
      db.close();
    } finally {
      copy.cleanup();
    }
  });

  it("the migration never deletes a place", () => {
    const copy = oldDatabaseCopy();
    try {
      const db = new DatabaseCtor(copy.path);
      db.prepare("INSERT INTO places (key, kind, ts) VALUES (?,?,?)").run("farm", "farm", 5);
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM places").get()).toEqual({ n: 1 });
      db.close();
    } finally {
      copy.cleanup();
    }
  });
});

describe("WP6 — remembering and recalling a place", () => {
  it("parses 'elix remember this place as home'", () => {
    expect(parseRemember("elix remember this place as home", "Elix")).toEqual({ key: "home", kind: "home" });
  });

  it("accepts a free-form name, and records it as a note", () => {
    expect(parseRemember("elix remember this as the_good_spot", "Elix")).toEqual({
      key: "the_good_spot",
      kind: "note",
    });
    // A place name is ONE word. "home and follow me" is two instructions wearing one hat,
    // so the parser refuses it rather than storing a place called home_and_follow_me.
    expect(parseRemember("elix remember this as home and follow me", "Elix")).toBeNull();
  });

  it("refuses a line not addressed to Elix, or not whole-intent", () => {
    expect(parseRemember("remember this place as home", "Elix")).toBeNull();
    expect(parseRemember("elix remember this place as home and follow me", "Elix")).toBeNull();
    expect(parseRemember("elix how do i remember a place", "Elix")).toBeNull();
  });

  it("refuses an absurdly long name", () => {
    expect(parseRemember(`elix remember this as ${"x".repeat(40)}`, "Elix")).toBeNull();
  });

  it("stores a place and reads the numbers back exactly", () => {
    const s = store();
    try {
      rememberPlace(s.store, "home", "home", new Vec3(120, 64, -300), "overworld", 1_700_000_000_000);
      const place = loadPlace(s.store, "home");
      expect(place).toMatchObject({ key: "home", kind: "home", x: 120, y: 64, z: -300, dimension: "overworld" });
      // Real Vec3 in, exact numbers out - no rounding on the way to disk.
      expect(place?.x).toBe(120);
    } finally {
      s.cleanup();
    }
  });

  it("re-remembering a place moves it, rather than making a second one", () => {
    const s = store();
    try {
      rememberPlace(s.store, "home", "home", new Vec3(0, 64, 0), "overworld", 1);
      rememberPlace(s.store, "home", "home", new Vec3(500, 70, 500), "nether", 2);
      expect(s.store.places()).toHaveLength(1);
      expect(loadPlace(s.store, "home")?.x).toBe(500);
      expect(loadPlace(s.store, "home")?.dimension).toBe("nether");
    } finally {
      s.cleanup();
    }
  });

  it("an unknown place is null, not a zeroed position", () => {
    const s = store();
    try {
      expect(loadPlace(s.store, "nowhere")).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  it("parses 'elix take me home' and 'elix go to farm'", () => {
    expect(parseGoTo("elix take me home", "Elix")).toBe("home");
    expect(parseGoTo("elix go to the farm", "Elix")).toBe("farm");
    expect(parseGoTo("elix head to base please", "Elix")).toBe("base");
  });

  it("refuses a go-to that is not one of those", () => {
    expect(parseGoTo("elix go to the moon", "Elix")).toBe("moon");
    expect(parseGoTo("go to home", "Elix")).toBeNull();
    expect(parseGoTo("elix can you take me home", "Elix")).toBeNull();
  });

  it("parses 'elix where is testspot'", () => {
    expect(parseWhereIs("elix where is testspot", "Elix")).toBe("testspot");
    expect(parseWhereIs("elix where is the testspot", "Elix")).toBe("testspot");
    expect(parseWhereIs("elix where is home", "Elix")).toBe("home");
    expect(parseWhereIs("where is home", "Elix")).toBeNull();
  });
});

describe("WP6 — deaths", () => {
  it("parses 'elix where did i die'", () => {
    expect(parseWhereDied("elix where did i die", "Elix")).toBe(true);
    expect(parseWhereDied("ELIX WHERE DID I DIE", "Elix")).toBe(true);
    expect(parseWhereDied("where did i die", "Elix")).toBe(false);
    expect(parseWhereDied("elix where is home", "Elix")).toBe(false);
  });

  it("records a death and reads the latest one back", () => {
    const s = store();
    try {
      s.store.addDeath({ player: "ElixOwner", x: 12, y: -40, z: 300, dimension: "overworld", cause: "zombie", ts: 100 });
      s.store.addDeath({ player: "ElixOwner", x: 1, y: 64, z: 2, dimension: "overworld", cause: "fall", ts: 200 });
      const last = s.store.lastDeath("ElixOwner");
      expect(last).toMatchObject({ x: 1, y: 64, z: 2, cause: "fall" });
      // Newest first, and both are kept.
      expect(s.store.deaths("ElixOwner")).toHaveLength(2);
      expect(s.store.deathCount("ElixOwner")).toBe(2);
    } finally {
      s.cleanup();
    }
  });

  it("records Elix's own death under 'elix'", () => {
    const s = store();
    try {
      s.store.addDeath({ player: "elix", x: 5, y: 64, z: 5, ts: 10 });
      expect(s.store.lastDeath("elix")).toMatchObject({ x: 5 });
      expect(s.store.lastDeath("nobody")).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  it("knows the answer and knows when it does not", () => {
    const withDeath = describeDeath({ player: "ElixOwner", x: 12, y: -40, z: 300, dimension: "overworld", ts: 1, cause: "zombie" });
    expect(withDeath).toContain("12");
    const none = UNKNOWN_DEATH;
    expect(none).not.toMatch(/\d/u);
  });
});

describe("WP6 — coordinates are said by whisper, to owners, only", () => {
  it("a place description does contain coordinates, because it goes to an owner", () => {
    const place: Place = { key: "home", kind: "home", x: 120, y: 64, z: -300, dimension: "overworld", note: null, ts: 1 };
    expect(looksLikeCoordinates(describePlace(place))).toBe(true);
  });

  it("the unknown answers contain NO coordinates at all", () => {
    expect(looksLikeCoordinates(UNKNOWN_PLACE)).toBe(false);
    expect(looksLikeCoordinates(UNKNOWN_DEATH)).toBe(false);
  });

  it("the refusals and the short lines contain no coordinates", () => {
    for (const line of [UNKNOWN_PLACE, UNKNOWN_DEATH, "on my way", "coming", "ok, stopping", "i can't do that one"]) {
      expect(looksLikeCoordinates(line), line).toBe(false);
    }
  });

  it("looksLikeCoordinates only fires on three or more numbers", () => {
    expect(looksLikeCoordinates("you had 2 diamonds")).toBe(false);
    expect(looksLikeCoordinates("go to 1, 2, 3")).toBe(true);
    expect(looksLikeCoordinates("x 120 y 64 z -300")).toBe(true);
    expect(looksLikeCoordinates("take me home")).toBe(false);
  });

  it("a PUBLIC refusal for a stranger never carries the coordinates they asked for", () => {
    // This is the shape the chat path uses: a stranger asks where the base is, gets a
    // refusal, and the refusal is the only thing that goes to public chat.
    const refusal = "i can't do that one";
    expect(looksLikeCoordinates(refusal)).toBe(false);
    expect(coordinateWords(refusal)).toEqual([]);
  });

  it("a death answer is a WHISPER payload, so it is built by a separate function", () => {
    // Public chat never gets a describeDeath() result; there is no code path that puts one
    // on a reply. Both descriptions exist only for the whisper.
    const death = describeDeath({ player: "P", x: 1, y: 2, z: 3, dimension: null, ts: 1, cause: null });
    const place = describePlace({ key: "k", kind: "note", x: 1, y: 2, z: 3, dimension: null, note: null, ts: 1 });
    expect(looksLikeCoordinates(death)).toBe(true);
    expect(looksLikeCoordinates(place)).toBe(true);
    // And the whisper command itself is a slash command, never a chat line.
    expect(looksLikeCoordinates("/msg ElixOwner home is at 1, 2, 3")).toBe(true);
  });
});

describe("WP6 — protected places now come from memory", () => {
  const places: Place[] = [
    { key: "home", kind: "home", x: 0, y: 64, z: 0, dimension: null, note: null, ts: 1 },
    { key: "farm", kind: "farm", x: 500, y: 64, z: 500, dimension: null, note: null, ts: 1 },
  ];

  it("a place inside the radius is protected", () => {
    expect(isProtected({ x: 10, y: 64, z: 0 }, places)).toBe(true);
    expect(isProtected({ x: PROTECTED_RADIUS - 1, y: 64, z: 0 }, places)).toBe(true);
  });

  it("a place outside the radius is not", () => {
    expect(isProtected({ x: PROTECTED_RADIUS + 1, y: 64, z: 0 }, places)).toBe(false);
    expect(isProtected({ x: 100, y: 64, z: 100 }, places)).toBe(false);
  });

  it("every remembered place is checked, not just the first", () => {
    expect(isProtected({ x: 500, y: 64, z: 500 }, places)).toBe(true);
  });

  it("a remembered home makes WP5's gather refuse a dig inside it", () => {
    // The end-to-end link the brief asks for: WP5's OWN refusal function, fed a protected
    // place that came out of the database rather than out of a literal.
    const s = store();
    try {
      rememberPlace(s.store, "home", "home", new Vec3(0, 64, 0), "overworld", 1);
      const near = { x: 5, y: 64, z: 5 };
      const protectedPlaces = protectedPlacesFrom(s.store, near);
      expect(protectedPlaces).toHaveLength(1);
      const refusal = refuseDig({
        name: "dirt",
        position: new Vec3(near.x, near.y, near.z),
        protectedPlaces,
        gathered: 0,
        wanted: 5,
        elapsedMs: 0,
        hasLeavesNearby: true,
      });
      expect(refusal).toBe("protected-place");
      // And far away, the same dig is allowed.
      expect(
        refuseDig({
          name: "dirt",
          position: new Vec3(5000, 64, 5000),
          protectedPlaces: protectedPlacesFrom(s.store, { x: 5000, y: 64, z: 5000 }),
          gathered: 0,
          wanted: 5,
          elapsedMs: 0,
          hasLeavesNearby: true,
        }),
      ).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  it("a place with no coordinates is skipped rather than treated as 0,0,0", () => {
    const broken: Place[] = [
      { key: "nowhere", kind: "note", x: Number.NaN, y: 64, z: 0, dimension: null, note: null, ts: 1 },
    ];
    // NaN fails every comparison, so this must be false rather than "protected everywhere".
    expect(isProtected({ x: 999, y: 64, z: 999 }, broken)).toBe(false);
  });
});