/**
 * Outbound chat queue — rate limiting, typing delay, and dedup.
 *
 * Vision rule 8: max 1 message per `safety.chatRateLimitPer2s` window.
 * Vision rule 9: typing delay of ~40–70 ms/char (capped ~3 s) so messages
 * don't appear instantly. Identical text inside the dedup window is dropped.
 *
 * Every `bot.chat` call goes through this. The shutdown goodbye may skip the
 * typing delay but still goes through the queue/rate limit.
 */

export interface SayOptions {
  /** Max messages per `rateWindowMs` (from safety.chatRateLimitPer2s). */
  maxPerWindow?: number;
  /** Window the rate limit applies over (2 s by default). */
  rateWindowMs?: number;
  /** Typing ms per character (mid-point of 40–70). */
  typingMsPerChar?: number;
  /** Hard cap on typing delay. */
  maxTypingMs?: number;
  /** Identical text inside this window is dropped. */
  dedupWindowMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Notified when a message is dropped by the dedup window. */
  onDrop?: (text: string) => void;
}

export interface SayDefaults {
  maxPerWindow: number;
  rateWindowMs: number;
  typingMsPerChar: number;
  maxTypingMs: number;
  dedupWindowMs: number;
}

export const SAY_DEFAULTS: SayDefaults = {
  maxPerWindow: 1,
  rateWindowMs: 2000,
  typingMsPerChar: 55,
  maxTypingMs: 3000,
  dedupWindowMs: 10_000,
};

/** Result of enqueueing a message. */
export type SayResult = "queued" | "dropped-duplicate";

export class SayQueue {
  private readonly opts: Required<Omit<SayOptions, "onDrop">> & Pick<SayOptions, "onDrop">;
  private readonly queue: Array<{ text: string; skipTypingDelay: boolean }> = [];
  /** Timestamps of recent sends, used for the sliding rate-limit window. */
  private recentSends: number[] = [];
  private readonly dedup = new Map<string, number>();
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: SayOptions = {}) {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.opts = {
      maxPerWindow: opts.maxPerWindow ?? SAY_DEFAULTS.maxPerWindow,
      rateWindowMs: opts.rateWindowMs ?? SAY_DEFAULTS.rateWindowMs,
      typingMsPerChar: opts.typingMsPerChar ?? SAY_DEFAULTS.typingMsPerChar,
      maxTypingMs: opts.maxTypingMs ?? SAY_DEFAULTS.maxTypingMs,
      dedupWindowMs: opts.dedupWindowMs ?? SAY_DEFAULTS.dedupWindowMs,
      onDrop: opts.onDrop,
      now,
      sleep,
    };
  }

  /** Minimum gap between two sends, from maxPerWindow/rateWindowMs. */
  get minIntervalMs(): number {
    return this.opts.rateWindowMs / Math.max(1, this.opts.maxPerWindow);
  }

  /**
   * Enqueue an outbound message.
   * `skipTypingDelay` still respects the rate limit and dedup window.
   */
  say(text: string, skipTypingDelay = false): SayResult {
    if (this.closed) return "dropped-duplicate";
    const now = this.opts.now();

    const lastSent = this.dedup.get(text);
    if (lastSent !== undefined && now - lastSent < this.opts.dedupWindowMs) {
      this.opts.onDrop?.(text);
      return "dropped-duplicate";
    }
    // Reserve the dedup slot now so two identical calls in a row don't both queue.
    this.dedup.set(text, now);

    this.queue.push({ text, skipTypingDelay });
    this.startDraining();
    return "queued";
  }

  private startDraining(): void {
    if (this.draining) return;
    this.draining = true;
    this.idle = this.drain().finally(() => {
      this.draining = false;
      // A message enqueued during the final microtask still gets sent.
      if (this.queue.length > 0 && !this.closed) this.startDraining();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const item = this.queue.shift()!;

      // Wait out the sliding rate-limit window.
      const wait = this.timeUntilAllowed();
      if (wait > 0) await this.opts.sleep(wait);

      // Typing delay so the message doesn't appear instantly.
      if (!item.skipTypingDelay) {
        const typingMs = Math.min(item.text.length * this.opts.typingMsPerChar, this.opts.maxTypingMs);
        if (typingMs > 0) await this.opts.sleep(typingMs);
      }

      if (this.closed) return;
      const send = this.onSend;
      if (send) send(item.text);
      const now = this.opts.now();
      this.recentSends.push(now);
      this.recentSends = this.recentSends.filter((t) => now - t < this.opts.rateWindowMs);
    }
  }

  /** Milliseconds until the next send is allowed under the rate limit. */
  timeUntilAllowed(): number {
    const now = this.opts.now();
    this.recentSends = this.recentSends.filter((t) => now - t < this.opts.rateWindowMs);
    if (this.recentSends.length < this.opts.maxPerWindow) return 0;
    const oldest = this.recentSends[0]!;
    return Math.max(0, this.opts.rateWindowMs - (now - oldest));
  }

  /** Waits for everything currently queued to be sent. */
  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      await this.idle;
      await this.opts.sleep(0);
    }
  }

  /** Stop sending and discard anything pending. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.dedup.clear();
  }

  /** Actual chat transport. Replaced by bot.ts so this module has no mineflayer import. */
  private onSend: ((text: string) => void) | null = null;

  setTransport(fn: (text: string) => void): void {
    this.onSend = fn;
  }

  /** Test helper: number of messages still waiting. */
  get pending(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton used by bot.ts
// ---------------------------------------------------------------------------

let singleton: SayQueue | null = null;

/** Create/configure the shared queue. Called once from bot.ts with config values. */
export function initSayQueue(opts: SayOptions): SayQueue {
  singleton = new SayQueue(opts);
  return singleton;
}

/** Enqueue on the shared queue. No-op (with a warning) if not initialised yet. */
export function say(text: string, skipTypingDelay = false): SayResult {
  if (!singleton) {
    console.error("[say] queue not initialised — message dropped:", text);
    return "dropped-duplicate";
  }
  return singleton.say(text, skipTypingDelay);
}

/** Wait for the shared queue to drain (used before quitting so "gtg, cya" lands). */
export async function flushSayQueue(): Promise<void> {
  await singleton?.flush();
}

/** Close the shared queue. */
export function closeSayQueue(): void {
  singleton?.close();
  singleton = null;
}