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
export type SayResult = "queued" | "dropped-duplicate" | "dropped-queue-full";

interface QueuedMessage {
  text: string;
  skipTypingDelay: boolean;
  /** Priority items (the goodbye) survive the queue cap. */
  priority: boolean;
}

/**
 * Hard cap on the outbound queue (A11).
 *
 * The rate limit means 1 message per 2 s, so an unbounded backlog would be
 * minutes of stale replies. When full, the oldest non-priority item is dropped —
 * priority items (the shutdown goodbye) are never discarded.
 */
export const MAX_QUEUE_LENGTH = 5;

export class SayQueue {
  private readonly opts: Required<Omit<SayOptions, "onDrop">> & Pick<SayOptions, "onDrop">;
  private readonly queue: Array<QueuedMessage> = [];
  /** Timestamps of recent sends, used for the sliding rate-limit window. */
  private recentSends: number[] = [];
  private readonly dedup = new Map<string, number>();
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private closed = false;
  private droppedByCap = 0;

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
   * `priority` items are never dropped by the queue cap.
   */
  say(text: string, skipTypingDelay = false, priority = false): SayResult {
    if (this.closed) return "dropped-duplicate";
    const now = this.opts.now();

    // A11: prune the dedup map. Without this it grew for the whole session —
    // a 6-hour run leaked one entry per distinct message ever sent.
    this.pruneDedup(now);

    const lastSent = this.dedup.get(text);
    if (lastSent !== undefined && now - lastSent < this.opts.dedupWindowMs) {
      this.opts.onDrop?.(text);
      return "dropped-duplicate";
    }
    // Reserve the dedup slot now so two identical calls in a row don't both queue.
    this.dedup.set(text, now);

    // A11: cap the backlog. Drop the oldest non-priority item so fresh messages
    // (which are more relevant) are not stuck behind minutes of stale replies.
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      const victim = this.queue.findIndex((m) => !m.priority);
      if (victim >= 0) {
        const [removed] = this.queue.splice(victim, 1);
        this.droppedByCap++;
        this.opts.onDrop?.(removed!.text);
      } else if (!priority) {
        // Every queued item is priority — refuse this one instead.
        this.droppedByCap++;
        this.opts.onDrop?.(text);
        return "dropped-queue-full";
      }
    }

    this.queue.push({ text, skipTypingDelay, priority });
    this.startDraining();
    return "queued";
  }

  /** Drop dedup entries older than the dedup window. */
  private pruneDedup(now: number): void {
    for (const [key, at] of this.dedup) {
      if (now - at >= this.opts.dedupWindowMs) this.dedup.delete(key);
    }
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

  /** Test helper: how many messages the queue cap has discarded (A11). */
  get dropped(): number {
    return this.droppedByCap;
  }

  /** Test helper: size of the dedup map, to prove it does not leak (A11). */
  get dedupSize(): number {
    return this.dedup.size;
  }
}

// A12: the process-wide singleton (initSayQueue / say / flushSayQueue /
// closeSayQueue) was removed. It carried module-level mutable state that made
// the queue untestable and forced an indirection through botRegistry.ts to break
// an import cycle. BotSession owns one SayQueue per session instead.