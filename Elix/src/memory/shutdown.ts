/**
 * The shutdown sequence (A1).
 *
 * BUG THIS FIXES: the ceiling was shorter than the work. On Ctrl+C the cleanups
 * ran goodbye -> consolidation -> backup -> embedding drain -> close, but
 * consolidation is a `smart` call with a 20 s router timeout and each embedding
 * request has its own 10 s timeout, while `Lifecycle` force-exited after 10 s.
 * A slow provider therefore killed the process BEFORE the backup was written and
 * before the database was closed — exactly the failure the backup exists to
 * prevent.
 *
 * The order is now explicit and budgeted, in one place:
 *
 *   1. consolidation   hard 8 s budget, skipped entirely with no key
 *   2. backup          ALWAYS, no budget — it is local and fast, and it is the
 *                      thing that must not be skipped
 *   3. embed drain     only if more than 3 s of the budget remain
 *   4. close
 *
 * A second Ctrl+C still force-exits 130, because the ceiling is a ceiling.
 */
import type { MemoryStore } from "./store.js";
import type { MemoryEngine } from "./engine.js";
import { createBackup, type BackupResult } from "./backup.js";
import { consolidate, SHUTDOWN_CALL_CAP, type ConsolidationResult } from "./consolidation.js";
import type { BrainRouter } from "../brain/router.js";

/** The whole sequence's allowance. Comfortably under the Lifecycle ceiling. */
export const SHUTDOWN_BUDGET_MS = 30_000;
/** Consolidation gets at most this long. It is nice-to-have; the backup is not. */
export const CONSOLIDATION_BUDGET_MS = 8_000;
/** The embedding drain only runs with more than this much budget left over. */
export const EMBED_MIN_REMAINING_MS = 3_000;

export interface ShutdownLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface MemoryShutdownDeps {
  store: MemoryStore;
  engine: MemoryEngine;
  storePath: string;
  backupDir: string;
  /** null when the brain is unavailable; consolidation is then skipped. */
  router: BrainRouter | null;
  /** False when no provider key is configured, so no model call is attempted. */
  hasModel: boolean;
  log: ShutdownLog;
  /** Progress line, so the user knows why the process is still running. */
  onProgress?: (line: string) => void;
  budgetMs?: number;
  consolidationBudgetMs?: number;
  /**
   * A2: the CMD window was closed, so Windows gives us about 10 s.
   *
   * Consolidation is a `smart` call and the embedding drain is a 10 s HF call —
   * neither fits. Both are deferred to the next start or the next night, which
   * the A2 watermark makes safe: nothing is lost, it is simply summarised later.
   * The backup is a local file write and is the one thing that must happen now,
   * because a killed process cannot write it afterwards.
   */
  quick?: boolean;
  /** Overridable for tests. */
  now?: () => number;
  /** Overridable for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export interface ShutdownReport {
  consolidation:
    | "ok"
    | "skipped-no-key"
    | "skipped-timeout"
    | "skipped-error"
    | "no-episodes"
    /** A2: the window closed. Deferred to the next start or night. */
    | "skipped-quick";
  consolidationResult?: ConsolidationResult;
  /** True when the backup file exists afterwards. This must always be true. */
  backup: BackupResult;
  embed: "skipped-no-budget" | "skipped-no-provider" | "done";
  embedded: number;
  closed: boolean;
  /** Whether the hard budget ran out before everything finished. */
  ranOutOfBudget: boolean;
  totalMs: number;
}

/**
 * Race a promise against a deadline.
 *
 * `AbortSignal.timeout()` is unref'd, so in a test with nothing else pending the
 * loop drains and the deadline never fires. An explicit timer holds the loop,
 * which is what makes the budget observable in a test at all.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  setTimeoutFn: (fn: () => void, ms: number) => unknown = setTimeout,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  let timer: unknown;
  const timeout = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeoutFn(() => resolve({ ok: false, timedOut: true }), ms);
    // Do not hold the process open on our account.
    (timer as { unref?: () => void })?.unref?.();
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true, value }) as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Run the whole sequence, in order, within the budget.
 *
 * Never throws. A failure at any step is logged and the remaining steps still
 * run, because the backup is more important than whatever came before it.
 */
export async function runMemoryShutdown(deps: MemoryShutdownDeps): Promise<ShutdownReport> {
  const now = deps.now ?? Date.now;
  const budget = deps.budgetMs ?? SHUTDOWN_BUDGET_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const began = now();
  const deadline = began + budget;
  const progress = deps.onProgress ?? (() => undefined);

  const report: ShutdownReport = {
    consolidation: "skipped-no-key",
    backup: { path: null, bytes: 0 },
    embed: "skipped-no-provider",
    embedded: 0,
    closed: false,
    ranOutOfBudget: false,
    totalMs: 0,
  };

  // -- 1. consolidation: nice to have, hard 8 s budget ----------------------
  if (deps.quick) {
    // A2: no time for a model call. Skipped BEFORE the progress line, so
    // "saving memories…" keeps meaning "a call is running".
    report.consolidation = "skipped-quick";
    deps.log.info("window closed — consolidation deferred to the next start");
  } else if (!deps.hasModel || !deps.router) {
    deps.log.info({ reason: "no provider key" }, "shutdown consolidation skipped");
  } else {
    progress("saving memories…");
    const work = (async () => {
      try {
        return await consolidate({
          store: deps.store,
          router: deps.router as BrainRouter,
          since: startOfDay(began),
          // 2, not 1: a cap of 1 leaves no room for the chunk call plus the
          // merge, so the "1 call on shutdown" budget actually made ZERO calls.
          callCap: SHUTDOWN_CALL_CAP + 1,
        });
      } catch (err) {
        deps.log.warn({ err: (err as Error).message }, "shutdown consolidation failed");
        return null;
      }
    })();
    const settled = await withDeadline(
      work,
      deps.consolidationBudgetMs ?? CONSOLIDATION_BUDGET_MS,
      setTimeoutFn,
    );
    if (settled.ok) {
      if (settled.value) {
        report.consolidation = settled.value.status === "no-episodes" ? "no-episodes" : "ok";
        report.consolidationResult = settled.value;
        deps.log.info(
          {
            status: settled.value.status,
            facts: settled.value.factsMade,
            calls: settled.value.calls,
          },
          "shutdown consolidation",
        );
      } else {
        report.consolidation = "skipped-error";
      }
    } else {
      // The point of the budget: move on to the backup rather than hang.
      report.consolidation = "skipped-timeout";
      deps.log.warn(
        { budgetMs: deps.consolidationBudgetMs ?? CONSOLIDATION_BUDGET_MS },
        "shutdown consolidation timed out — backing up anyway",
      );
    }
  }

  // -- 2. backup: ALWAYS ----------------------------------------------------
  // No deadline. It is a local file write, it is the reason this function
  // exists, and cutting it short would defeat the entire exercise.
  try {
    report.backup = createBackup({ dbPath: deps.storePath, backupDir: deps.backupDir });
    deps.log.info(
      { path: report.backup.path, bytes: report.backup.bytes, error: report.backup.error },
      "shutdown backup written",
    );
  } catch (err) {
    deps.log.error(
      { err: (err as Error).message },
      "shutdown backup failed — continuing",
    );
  }

  // -- 3. embedding: only with budget to spare ------------------------------
  const remaining = deadline - now();
  if (deps.quick) {
    // A2: one HF call is 10 s and the whole budget is 6 s. Not a close call.
    report.embed = "skipped-no-budget";
  } else if (remaining <= EMBED_MIN_REMAINING_MS) {
    report.embed = "skipped-no-budget";
    report.ranOutOfBudget = true;
    deps.log.info(
      { remainingMs: remaining },
      "embedding drain skipped — not enough shutdown budget left",
    );
  } else if (deps.engine.embedder.isRunning || !deps.engine.hasEmbeddings) {
    report.embed = "skipped-no-provider";
  } else {
    progress("indexing memories…");
    const settled = await withDeadline(
      deps.engine.embedder.drain(2),
      Math.max(0, deadline - now() - 500),
      setTimeoutFn,
    );
    if (settled.ok) {
      report.embedded = settled.value.embedded;
      report.embed = "done";
      deps.log.info(settled.value, "embedding backfill");
    } else {
      report.ranOutOfBudget = true;
      report.embed = "skipped-no-budget";
      deps.log.warn("embedding backfill timed out — closing anyway");
    }
  }

  // -- 4. close --------------------------------------------------------------
  try {
    deps.store.close();
    report.closed = true;
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, "closing the memory store failed");
  }

  report.totalMs = now() - began;
  return report;
}