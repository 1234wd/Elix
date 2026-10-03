/**
 * Query embeddings (A3).
 *
 * BUG THIS FIXES: `stubs.ts` called `engine.context(player, query, null)`, so
 * cosine was always 0 and live retrieval was FTS-only — while HF credit was spent
 * embedding every episode. Either use the vectors or stop paying for them; this
 * is the part that makes the vectors count.
 *
 * Three constraints, all of them budget-related:
 *
 *  - 1.5 s, not the 10 s episode deadline. This runs on the reply path, between
 *    the player asking and Elix answering, and a slow embedder must not become a
 *    slow reply. On timeout it returns null and retrieval falls back to FTS.
 *  - Cached by normalised text. Players repeat themselves ("hey elix", "thanks
 *    elix", the same question twice), and a cache hit costs nothing.
 *  - Skipped entirely when there is no HF key or the provider is cooling down.
 *
 * A null result is the normal, expected outcome. It never throws.
 */
import type { HuggingFaceProvider } from "../brain/hf.js";

/** The reply-path deadline. Deliberately much shorter than the episode one. */
export const QUERY_EMBED_TIMEOUT_MS = 1_500;

/** Cached results live this long. Long enough for a repeated greeting. */
export const QUERY_CACHE_TTL_MS = 10 * 60_000;

/** Bounded so a long session cannot grow this without limit. */
export const QUERY_CACHE_MAX = 128;

export interface QueryEmbedderOptions {
  provider: HuggingFaceProvider | null;
  model: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Optional gate: false means "cooling down", so do not even try. */
  isAvailable?: () => boolean;
  /** Overridable for tests. */
  now?: () => number;
  onError?: (message: string) => void;
}

/**
 * Reduce a question to a cache key.
 *
 * Case, punctuation and spacing are all noise: "What's your favourite block?!",
 * "whats your favourite block" and "  what s your FAVOURITE block  " are the
 * same question as far as the player is concerned.
 */
export function normaliseQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class QueryEmbedder {
  private readonly opts: QueryEmbedderOptions;
  /** key -> { vector, at }. Insertion-ordered, so the oldest is first. */
  private readonly cache = new Map<string, { vector: number[]; at: number }>();
  /** Negative cache: a text that timed out is not retried for this long. */
  private readonly misses = new Map<string, number>();
  /** One request at a time, so a burst of questions cannot fan out. */
  private inFlight: Promise<number[] | null> | null = null;

  constructor(opts: QueryEmbedderOptions) {
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get pendingSize(): number {
    return this.misses.size;
  }

  /** True when a query could be embedded right now. */
  get available(): boolean {
    if (!this.opts.provider) return false;
    return this.opts.isAvailable ? this.opts.isAvailable() : true;
  }

  clear(): void {
    this.cache.clear();
    this.misses.clear();
  }

  /**
   * Embed one query. Returns null when it could not be done cheaply, which the
   * caller treats as "use FTS5".
   */
  async embed(text: string): Promise<number[] | null> {
    const key = normaliseQuery(text);
    if (key.length === 0) return null;

    // No provider, or cooling down: no request at all.
    if (!this.available) return null;

    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.opts.cacheTtlMs ?? QUERY_CACHE_TTL_MS)) {
      return hit.vector;
    }
    // A recent miss (timeout, 429, 402) is a miss: do not hammer it.
    const miss = this.misses.get(key);
    if (miss !== undefined && now - miss < (this.opts.cacheTtlMs ?? QUERY_CACHE_TTL_MS)) {
      return null;
    }

    // Collapse concurrent identical questions onto one request.
    const work = (async (): Promise<number[] | null> => {
      const deadline = AbortSignal.timeout(this.opts.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS);
      try {
        const vectors = await this.opts.provider!.embed(
          [text.slice(0, 2000)],
          this.opts.model,
          deadline,
        );
        const v = vectors[0];
        if (!v || v.length === 0) {
          this.rememberMiss(key);
          return null;
        }
        this.store(key, v);
        return v;
      } catch (err) {
        // A timeout is the expected failure here, not an incident.
        this.rememberMiss(key);
        this.opts.onError?.((err as Error).message.slice(0, 120));
        return null;
      }
    })();

    this.inFlight = work;
    try {
      return await work;
    } finally {
      if (this.inFlight === work) this.inFlight = null;
    }
  }

  private rememberMiss(key: string): void {
    this.misses.set(key, this.now());
    if (this.misses.size > QUERY_CACHE_MAX) {
      const oldest = this.misses.keys().next();
      if (!oldest.done) this.misses.delete(oldest.value);
    }
  }

  private store(key: string, vector: number[]): void {
    this.cache.delete(key);
    this.cache.set(key, { vector, at: this.now() });
    while (this.cache.size > QUERY_CACHE_MAX) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}