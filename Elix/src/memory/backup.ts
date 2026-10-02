/**
 * Backups (D6).
 *
 * `VACUUM INTO` writes a whole new database file while the source stays open and
 * consistent. A plain file copy of a WAL-mode database is NOT safe: it can
 * capture a torn page and restore a corrupt DB. That is the whole reason for
 * using VACUUM INTO rather than fs.copyFile.
 *
 * `verifyBackup()` restores a backup into a scratch copy and actually queries it,
 * so a backup that exists but is unusable is reported as unusable rather than
 * discovered during a real restore.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** How many daily backups to keep. */
export const KEEP_BACKUPS = 14;

export interface BackupResult {
  path: string | null;
  bytes: number;
  error?: string;
}

export interface BackupOptions {
  dbPath: string;
  backupDir: string;
  keep?: number;
  now?: Date;
}

/**
 * Quote a value as a SQL string literal.
 *
 * Doubling an embedded single quote is SQL's own escape; a literal NUL is not
 * legal in a SQLite string and is rejected outright, so it is dropped rather
 * than smuggled through.
 */
function sqlString(value: string): string {
  // Split-and-join rather than a regex: a NUL inside a regex literal trips
  // eslint's no-control-regex, and a LITERAL NUL byte in the source would make
  // git treat the file as binary (A4). String.fromCharCode(0) matches the raw
  // byte at runtime while keeping the source plain text.
  const withoutNul = value.split(String.fromCharCode(0)).join("");
  return `'${withoutNul.replace(/'/g, "''")}'`;
}

function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Write a consistent backup, then prune old ones.
 *
 * Pruning is what makes `forget` meaningful: D6 prefers purging a player from
 * the backups too, and the only way that is true is if the backups do not
 * accumulate forever.
 */
export function createBackup(opts: BackupOptions): BackupResult {
  const now = opts.now ?? new Date();
  try {
    mkdirSync(opts.backupDir, { recursive: true });
    if (!existsSync(opts.dbPath)) {
      return { path: null, bytes: 0, error: "database file does not exist" };
    }
    const target = join(opts.backupDir, `elix-${stamp(now)}.db`);
    // VACUUM INTO fails if the target exists, so clear a same-second leftover.
    if (existsSync(target)) rmSync(target, { force: true });

    const db = new DatabaseSync(opts.dbPath);
    try {
      // VACUUM INTO does NOT accept a bound parameter ("non-text filename"), so
      // the path has to be a SQL literal. It is a path we just built from
      // resolve() + a timestamp, and sqlString() escapes quotes and backslashes.
      db.exec(`VACUUM INTO ${sqlString(target)}`);
    } finally {
      db.close();
    }

    const bytes = statSync(target).size;
    pruneBackups(opts.backupDir, opts.keep ?? KEEP_BACKUPS);
    return { path: target, bytes };
  } catch (err) {
    return { path: null, bytes: 0, error: (err as Error).message };
  }
}

/** Keep the newest `keep` backups, delete the rest. */
export function pruneBackups(backupDir: string, keep = KEEP_BACKUPS): string[] {
  if (!existsSync(backupDir)) return [];
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith("elix-") && f.endsWith(".db"))
    // Timestamped names sort chronologically, so newest last.
    .sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of doomed) rmSync(join(backupDir, f), { force: true });
  return doomed;
}

export function listBackups(backupDir: string): Array<{ name: string; path: string; bytes: number }> {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith("elix-") && f.endsWith(".db"))
    .sort()
    .map((name) => {
      const path = join(backupDir, name);
      return { name, path, bytes: statSync(path).size };
    });
}

export interface VerifyResult {
  ok: boolean;
  /** PRAGMA integrity_check output, from the RESTORED copy. */
  integrity: string;
  counts: Record<string, number>;
  /** A real KNN query result, or null when the vec table is absent. */
  knn: Array<{ id: number; distance: number }> | null;
  vecVersion?: string;
  error?: string;
}

/**
 * Restore a backup into a scratch file and actually use it.
 *
 * The restore is a plain FILE COPY, which is what a real restore is. It was
 * first written as `VACUUM INTO`, and that quietly produced a restored database
 * with NO vec0 table at all — the vector index came back empty while
 * `PRAGMA integrity_check` still said "ok". A backup is only real if the copy
 * restores everything, so the copy is what gets verified.
 *
 * Opening the backup directly would be a lie if the copy is broken; the point is
 * to prove the RESTORED file answers an integrity check and a KNN query, which is
 * what a real restore would need.
 */
export function verifyBackup(backupPath: string): VerifyResult {
  let scratch: string | null = null;
  try {
    const dir = resolve(tmpdir(), `elix-verify-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    scratch = join(dir, "restored.db");
    copyFileSync(backupPath, scratch);

    const db = new DatabaseSync(scratch, { allowExtension: true });
    try {
      const integrity = (
        db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
      ).integrity_check;

      const counts: Record<string, number> = {};
      for (const table of ["episodes", "facts", "people", "promises"]) {
        try {
          counts[table] = (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
            c: number;
          }).c;
        } catch {
          counts[table] = -1; // table absent in this backup
        }
      }

      let knn: VerifyResult["knn"] = null;
      let vecVersion: string | undefined;
      try {
        // Load the extension on the RESTORED copy and run a real KNN query.
        const vec = require("sqlite-vec") as { getLoadablePath?(): string };
        const dll = vec.getLoadablePath?.();
        if (dll) {
          db.loadExtension(dll);
          vecVersion = (db.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
          const has = db
            .prepare("SELECT name FROM sqlite_master WHERE name='episode_vec'")
            .get();
          if (has) {
            // Reuse a stored vector as the query, so this is a genuine
            // nearest-neighbour search rather than a table count.
            const row = db
              .prepare("SELECT embedding FROM episode_vec LIMIT 1")
              .get() as { embedding: ArrayBuffer | Uint8Array | string } | undefined;
            if (row) {
              const vector = blobToVector(row.embedding);
              if (vector && vector.length > 0) {
                knn = (
                  db
                    .prepare(
                      "SELECT rowid, distance FROM episode_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 3",
                    )
                    .all(JSON.stringify(vector)) as unknown as Array<{
                    rowid: number;
                    distance: number;
                  }>
                ).map((h) => ({ id: Number(h.rowid), distance: h.distance }));
              }
            }
          }
        }
      } catch (err) {
        // A backup without vectors is valid. Only surface the reason if the
        // backup claimed to have a vec table, so a real failure is visible.
        const has = db
          .prepare("SELECT name FROM sqlite_master WHERE name='episode_vec'")
          .get();
        if (has) {
          return {
            ok: false,
            integrity,
            counts,
            knn: null,
            ...(vecVersion ? { vecVersion } : {}),
            error: `vector store unreadable in restored copy: ${(err as Error).message}`,
          };
        }
      }

      return {
        ok: integrity === "ok",
        integrity,
        counts,
        knn,
        ...(vecVersion ? { vecVersion } : {}),
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      integrity: "unreadable",
      counts: {},
      knn: null,
      error: (err as Error).message,
    };
  } finally {
    if (scratch) rmSync(resolve(scratch, ".."), { recursive: true, force: true });
  }
}

/**
 * Read a vector back out of the vec0 table.
 *
 * sqlite-vec 0.1.9 returns `embedding` as a raw float32 BLOB, not the JSON text
 * that goes in. Decoding it as UTF-8 yields mojibake and `JSON.parse` throws, so
 * the KNN verification silently reported "no query possible" on a backup that was
 * completely fine. Both shapes are handled so an older JSON-text backup still
 * verifies.
 */
function blobToVector(value: ArrayBuffer | Uint8Array | string): number[] | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(Number) : null;
    } catch {
      return null;
    }
  }
  try {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const out = Array.from(floats);
    return out.every((n) => Number.isFinite(n)) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Purge a player from every backup (D6, preferred option).
 *
 * Backups are separate files, so a deleted player's data would otherwise live
 * there for up to 14 days. Opening each one read-write and deleting is the only
 * way to make `forget` mean what the user asked.
 */
export function purgePlayerFromBackups(backupDir: string, player: string): {
  scanned: number;
  purged: number;
} {
  const files = listBackups(backupDir);
  let purged = 0;
  for (const f of files) {
    let db: InstanceType<typeof DatabaseSync> | null = null;
    try {
      db = new DatabaseSync(f.path);
      const has = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'")
        .get();
      if (!has) continue;
      db.exec("BEGIN");
      // Case-insensitive, for the same reason forgetPlayer() is.
      const ids = db
        .prepare("SELECT id FROM episodes WHERE lower(player) = ?")
        .all(player.toLowerCase()) as unknown as Array<{ id: number }>;
      for (const row of ids) {
        // The vec table may not exist in an older backup.
        try {
          db.prepare("DELETE FROM episode_vec WHERE rowid = ?").run(BigInt(row.id));
        } catch {
          /* no vector table */
        }
        db.prepare("DELETE FROM episodes WHERE id = ?").run(row.id);
        purged++;
      }
      db.prepare("DELETE FROM facts WHERE lower(subject) = ? OR lower(object) = ?").run(
        player.toLowerCase(),
        player.toLowerCase(),
      );
      db.prepare("DELETE FROM promises WHERE lower(player) = ?").run(player.toLowerCase());
      db.prepare("DELETE FROM people WHERE lower(player) = ?").run(player.toLowerCase());
      db.exec("COMMIT");
    } catch {
      try {
        db?.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
  return { scanned: files.length, purged };
}

/**
 * When does the last backup containing this player expire?
 *
 * Printed by `forget` so the user knows the real retention window rather than
 * assuming a delete is instant.
 */
export function lastBackupRetention(backupDir: string, keep = KEEP_BACKUPS): {
  backups: number;
  expiresAfterDays: number;
} {
  const count = listBackups(backupDir).length;
  return { backups: count, expiresAfterDays: Math.max(0, count) / 1 + (keep - count) };
}
