/**
 * The embedding backfill (D1, and the Phase 3 plan's "embed once").
 *
 * Free Hugging Face credit is about $0.10 a month, so a memory is embedded
 * EXACTLY ONCE and the vector is stored forever. There is no re-embedding path
 * in this file on purpose.
 *
 * Failure is not loss. A batch that fails leaves its rows with
 * `embedded_model IS NULL`; they are retried on a later pass, and retrieval
 * works through FTS5 in the meantime. That is why `episodes` is written first
 * and the vector is filled in afterwards, never the other way round.
 */
import type { MemoryStore } from "./store.js";
import type { HuggingFaceProvider } from "../brain/hf.js";

/** Text sent for embedding. Speaker and a little context, not the whole row. */
export function embeddingText(text: string, speaker: string, player: string | null): string {
  const who = speaker === "elix" ? "Elix said" : `${player ?? "someone"} said`;
  return `${who}: ${text}`;
}

export interface BackfillResult {
  attempted: number;
  embedded: number;
  failed: number;
  /** Why the batch failed, if it did. Never a key. */
  error?: string;
  /** True when the model was not configured at all. */
  skipped?: boolean;
}

export interface EmbedderOptions {
  store: MemoryStore;
  provider: HuggingFaceProvider | null;
  model: string;
  /** HF returns at most 16 texts per call comfortably; batching is per-call. */
  batchSize?: number;
  /** Above this many queued rows per pass, stop and let the next pass do more. */
  maxPerPass?: number;
  signal?: AbortSignal;
}

export class Embedder {
  private readonly opts: EmbedderOptions;
  private running = false;

  constructor(opts: EmbedderOptions) {
    this.opts = opts;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Embed the next batch of un-embedded episodes.
   *
   * Never throws: a failed batch is a logged, retried-later condition, and the
   * memory is already safe in SQLite either way.
   */
  async backfill(): Promise<BackfillResult> {
    const { store, provider, model } = this.opts;
    if (!provider) {
      // No HF key: retrieval is FTS5-only. Reported, not an error.
      return { attempted: 0, embedded: 0, failed: 0, skipped: true };
    }
    if (this.running) {
      // One pass at a time, so a slow provider never overlaps itself.
      return { attempted: 0, embedded: 0, failed: 0, skipped: true };
    }

    const batchSize = this.opts.batchSize ?? 16;
    const maxPerPass = this.opts.maxPerPass ?? 64;
    const pending = store.unembedded(Math.min(batchSize, maxPerPass));
    if (pending.length === 0) {
      return { attempted: 0, embedded: 0, failed: 0 };
    }

    this.running = true;
    try {
      const inputs = pending.map((e) => embeddingText(e.text, e.speaker, e.player));
      const vectors = await provider.embed(inputs, model, this.opts.signal);

      if (vectors.length !== pending.length) {
        return {
          attempted: pending.length,
          embedded: 0,
          failed: pending.length,
          error: `expected ${pending.length} vectors, got ${vectors.length}`,
        };
      }

      let embedded = 0;
      let failed = 0;
      for (let i = 0; i < pending.length; i++) {
        try {
          store.markEmbedded(pending[i]!.id, vectors[i]!);
          embedded++;
        } catch (err) {
          // One bad vector must not lose the others.
          failed++;
          void err;
        }
      }
      return { attempted: pending.length, embedded, failed };
    } catch (err) {
      // Timeout, 402, 429, network: all leave the rows unembedded for later.
      return {
        attempted: pending.length,
        embedded: 0,
        failed: pending.length,
        error: (err as Error).message.slice(0, 200),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Run passes until nothing is left or the per-pass cap is hit.
   *
   * Bounded on purpose: an unbounded drain would make shutdown slow, and the
   * whole point of embedding once is that it is a background chore, not a
   * blocking step.
   */
  async drain(maxPasses = 4): Promise<BackfillResult> {
    const total: BackfillResult = { attempted: 0, embedded: 0, failed: 0 };
    for (let i = 0; i < maxPasses; i++) {
      const r = await this.backfill();
      total.attempted += r.attempted;
      total.embedded += r.embedded;
      total.failed += r.failed;
      if (r.skipped || r.attempted === 0) break;
      if (r.failed > 0) break; // a failing provider will fail again
    }
    return total;
  }
}
