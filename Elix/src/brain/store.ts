import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * node:sqlite, loaded through createRequire rather than a static import.
 *
 * A static `import { DatabaseSync } from "node:sqlite"` looks fine and passes
 * tsc, but esbuild strips the `node:` prefix from every builtin it externalises
 * when bundling. That is harmless for fs/path/net — Node resolves those as bare
 * builtins — but there is no bare `sqlite` module, so the built dist/cli/index.js
 * contained `import { DatabaseSync } from "sqlite"` and every command that
 * touched the brain died with ERR_MODULE_NOT_FOUND. Neither `external: ["node:sqlite"]`,
 * `external: [/^node:/]` nor an esbuild `alias` prevents this, because esbuild
 * normalises the specifier to the bare name before all three are applied.
 *
 * `require("node:sqlite")` keeps the prefix, resolves as a builtin, and is the
 * same trick already used for mineflayer-pathfinder, prismarine-chat and pino-pretty.
 */
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

/**
 * SQLite storage for the brain router: usage rows and model cooldowns.
 *
 * Storage choice (B1): Node's built-in `node:sqlite`. No native compile, so
 * there is nothing to build on the user's Windows laptop and no prebuilt-binary
 * / Visual Studio question. Verified on Node 24 / Windows 11:
 *
 *   - WAL mode: `PRAGMA journal_mode` returns "wal"
 *   - sqlite-vec 0.1.9 loads from a prebuilt vec0.dll and runs real KNN:
 *       SELECT vec_version()  -> v0.1.9
 *       SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance
 *
 * Two traps found while spiking, both of which Phase 4 will hit too:
 *
 * 1. `allowExtension` must be passed to the DatabaseSync CONSTRUCTOR. Calling
 *    `db.enableLoadExtension(true)` on a database created without it throws
 *    "Cannot enable extension loading because it was disabled at database
 *    creation."
 * 2. vec0 primary keys must be integers, and node:sqlite binds a JS `number` as
 *    REAL. Passing `1` throws "Only integers are allows for primary key values";
 *    passing `1n` works. Vector rowids must therefore always be BigInt.
 */

export interface UsageRow {
  ts: number;
  provider: string;
  model: string;
  role: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  latencyMs: number;
  outcome: UsageOutcome;
  error?: string;
}

export type UsageOutcome =
  | "ok"
  | "429"
  | "401"
  | "402"
  | "403"
  | "timeout"
  | "abort"
  | "5xx"
  | "network"
  | "fallback"
  | "circuit-open"
  | "no-keys";

export interface CooldownRow {
  provider: string;
  model: string;
  /** Epoch ms until which this model is skipped. */
  until: number;
  reason: string;
  /** True when the provider is disabled until tomorrow (401/402/403). */
  disabledForDay: boolean;
}

/**
 * SQLite has no boolean type, so `disabled_for_day` comes back as 0/1. Reading
 * it as `boolean` without converting produced `0` where callers expected
 * `false`, which made `if (row.disabledForDay)` behave as a truthy check on 0.
 */
interface CooldownRowInt extends Omit<CooldownRow, "disabledForDay"> {
  disabledForDay: number;
}

function toCooldownRow(row: CooldownRowInt): CooldownRow {
  return { ...row, disabledForDay: row.disabledForDay !== 0 };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  provider         TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  role             TEXT    NOT NULL,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  outcome          TEXT    NOT NULL,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);

CREATE TABLE IF NOT EXISTS cooldowns (
  provider         TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  until_ms         INTEGER NOT NULL,
  reason           TEXT    NOT NULL,
  disabled_for_day INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS cooldowns_until ON cooldowns (until_ms);

-- Persisted model discovery so a restart does not re-hit /models.
CREATE TABLE IF NOT EXISTS model_cache (
  provider  TEXT NOT NULL,
  models    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (provider)
);
`;

export class BrainStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // allowExtension must be set here, not via enableLoadExtension() later.
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  /** Load the sqlite-vec extension. Returns false when unavailable (never throws). */
  loadVecExtension(dllPath?: string): { loaded: boolean; version?: string; error?: string } {
    try {
      const path = dllPath ?? this.defaultVecPath();
      if (!path) return { loaded: false, error: "sqlite-vec loadable path not found" };
      this.db.loadExtension(path);
      const row = this.db.prepare("SELECT vec_version() AS v").get() as { v: string };
      return { loaded: true, version: row.v };
    } catch (err) {
      return { loaded: false, error: (err as Error).message };
    }
  }

  private defaultVecPath(): string | null {
    try {
      const vec = require("sqlite-vec") as { getLoadablePath?(): string };
      if (typeof vec.getLoadablePath === "function") return vec.getLoadablePath();
      // Older builds re-export load().
      return (vec as unknown as { loadablePath?: string }).loadablePath ?? null;
    } catch {
      return null;
    }
  }

  // -- usage ---------------------------------------------------------------

  recordUsage(row: UsageRow): void {
    this.db
      .prepare(
        `INSERT INTO usage (ts, provider, model, role, tokens_in, tokens_out,
                            reasoning_tokens, latency_ms, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        row.provider,
        row.model,
        row.role,
        row.tokensIn,
        row.tokensOut,
        row.reasoningTokens,
        row.latencyMs,
        row.outcome,
        row.error ?? null,
      );
  }

  usageSince(since: number): UsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT ts, provider, model, role, tokens_in AS tokensIn, tokens_out AS tokensOut,
                reasoning_tokens AS reasoningTokens, latency_ms AS latencyMs,
                outcome, error
           FROM usage WHERE ts >= ? ORDER BY ts ASC`,
      )
      .all(since) as unknown as UsageRow[];
    return rows;
  }

  // -- cooldowns -----------------------------------------------------------

  /** Rows whose cooldown has not yet expired, plus all same-day disables. */
  activeCooldowns(now: number): CooldownRow[] {
    const rows = this.db
      .prepare(
        `SELECT provider, model, until_ms AS until, reason,
                disabled_for_day AS disabledForDay
           FROM cooldowns WHERE until_ms > ? ORDER BY until_ms ASC`,
      )
      .all(now) as unknown as CooldownRowInt[];
    return rows.map(toCooldownRow);
  }

  /** Every stored row, expired or not — used to prune. */
  allCooldowns(): CooldownRow[] {
    const rows = this.db
      .prepare(
        `SELECT provider, model, until_ms AS until, reason,
                disabled_for_day AS disabledForDay FROM cooldowns`,
      )
      .all() as unknown as CooldownRowInt[];
    return rows.map(toCooldownRow);
  }

  setCooldown(row: CooldownRow): void {
    this.db
      .prepare(
        `INSERT INTO cooldowns (provider, model, until_ms, reason, disabled_for_day)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           until_ms = excluded.until_ms,
           reason = excluded.reason,
           disabled_for_day = excluded.disabled_for_day`,
      )
      .run(row.provider, row.model, row.until, row.reason, row.disabledForDay ? 1 : 0);
  }

  clearCooldown(provider: string, model: string): void {
    this.db.prepare("DELETE FROM cooldowns WHERE provider = ? AND model = ?").run(provider, model);
  }

  /** Drop expired rows so the table does not grow. */
  pruneCooldowns(now: number): number {
    const before = this.allCooldowns().length;
    this.db.prepare("DELETE FROM cooldowns WHERE until_ms <= ? AND disabled_for_day = 0").run(now);
    return before - this.allCooldowns().length;
  }

  // -- model discovery cache ----------------------------------------------

  getCachedModels(provider: string, maxAgeMs: number, now: number): string[] | null {
    const row = this.db
      .prepare("SELECT models, fetched_at AS fetchedAt FROM model_cache WHERE provider = ?")
      .get(provider) as { models: string; fetchedAt: number } | undefined;
    if (!row) return null;
    if (now - row.fetchedAt > maxAgeMs) return null;
    try {
      return JSON.parse(row.models) as string[];
    } catch {
      return null;
    }
  }

  cacheModels(provider: string, models: string[], now: number): void {
    this.db
      .prepare(
        `INSERT INTO model_cache (provider, models, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET models = excluded.models,
                                             fetched_at = excluded.fetched_at`,
      )
      .run(provider, JSON.stringify(models), now);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Default database path, gitignored, resolved from the project root. */
export function defaultDbPath(projectRoot: string): string {
  return resolve(projectRoot, "data", "elix.db");
}