/**
 * Resolve the sqlite driver the STORE uses, without adding it as a direct dependency.
 *
 * `better-sqlite3` is reached through `node:sqlite`'s own resolution the same way the store
 * reaches it, so a test never imports a package the project does not depend on. If the driver
 * cannot be resolved the test FAILS LOUDLY rather than quietly skipping - a migration test
 * that does not run is not a test.
 */
import { createRequire } from "node:module";

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
  };
  close(): void;
}

export type SqliteCtor = new (path: string) => SqliteDatabase;

let cached: SqliteCtor | null = null;

export function resolveDatabaseModule(): SqliteCtor {
  if (cached !== null) return cached;
  const require = createRequire(import.meta.url);
  const candidates = [
    () => (require("better-sqlite3") as { default?: unknown }).default ?? require("better-sqlite3"),
    () => {
      // node:sqlite ships with Node 22+ and is the driver's own fallback.
      const sqlite = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
      return sqlite.DatabaseSync;
    },
  ];
  for (const candidate of candidates) {
    try {
      const ctor = candidate() as SqliteCtor;
      if (typeof ctor === "function") {
        cached = ctor;
        return ctor;
      }
    } catch {
      // try the next one
    }
  }
  throw new Error("no sqlite driver could be resolved: the migration test cannot run");
}
