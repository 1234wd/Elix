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
  /**
   * A4: strip emoji before sending. Default TRUE, because most of them render
   * as empty boxes in Minecraft and persona.md describes plain lowercase chat.
   */
  stripEmoji?: boolean;
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

/**
 * Strip everything Minecraft cannot render.
 *
 * Emoji are the default problem: U+1F300 and above is outside the Basic
 * Multilingual Plane, and Minecraft's font has no glyph for most of them, so
 * 🎉 arrives in game as an empty box. Observed live in replies.
 *
 * The variation selector (U+FE0F), zero-width joiner (U+200D) and skin-tone
 * modifiers are removed too: they are invisible on their own and render as
 * tofu when a preceding glyph IS supported, which is the nastier case
 * because it looks fine in a terminal and broken in game.
 *
 * Plain-text faces like :) and :D are untouched, as are accented letters,
 * CJK, and everything else inside the BMP.
 */
export function stripEmoji(text: string): string {
  return (
    text
      // Every pictograph, astral or not, in ONE property class. Hand-written
      // ranges were wrong twice over: they missed blocks, and a range like
      // U+2600-U+27BF reads as a single run of arrows and dingbats, which is
      // what lint calls a misleading character class and is genuinely ambiguous
      // to whoever edits it next.
      .replace(/\p{Extended_Pictographic}/gu, "")
      // Zero-width joiner, variation selectors and text selectors. Invisible on
      // their own, and they turn a supported glyph into a broken one. Written as
      // ALTERNATION, not a character class: U+FE0E and U+FE0F are combining marks,
      // and a class containing combining marks is genuinely ambiguous about
      // whether they combine with what precedes them.
      .replace(/\u200D|\uFE0E|\uFE0F/gu, "")
      // Regional indicators: flag glyphs, which render as stray letter pairs.
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
      // Tidy up whatever the removals left behind.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([,.!?])/g, "$1")
      .trim()
  );
}

/** Result of enqueueing a message. */
export type SayResult = "queued" | "dropped-duplicate" | "dropped-queue-full";

/**
 * Outcome of a FINAL message — the goodbye, the last thing Elix ever says.
 *
 * `written` means the transport was called, i.e. `bot.chat(text)` ran. It does
 * NOT mean the packet reached the server; nothing here can know that. It does
 * mean the message was not silently swallowed by a queue, a dedup window or a
 * timeout — which is what the old code logged unconditionally.
 */
export type FinalSayResult = "written" | "cancelled" | "dropped-duplicate";

interface QueuedMessage {
  text: string;
  skipTypingDelay: boolean;
  /** Priority items (the goodbye) survive the queue cap. */
  priority: boolean;
  /** A final message ignores the sliding rate window — see sayFinal(). */
  bypassRateLimit: boolean;
  /** Final messages only: settled once the transport has been called. */
  settle?: (result: FinalSayResult) => void;
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
      stripEmoji: opts.stripEmoji ?? true,
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
    // A4: strip at the boundary. Every outbound message goes through say()
    // or sayFinal(), so this is the one place that has to know.
    if (this.opts.stripEmoji) text = stripEmoji(text);
    if (text.trim().length === 0) return "dropped-queue-full";
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

    this.queue.push({ text, skipTypingDelay, priority, bypassRateLimit: false });
    this.startDraining();
    return "queued";
  }

  /**
   * The LAST message of the process: the goodbye.
   *
   * Three differences from say(), all because there is nothing after this:
   *
   *  - it BYPASSES the sliding rate window. Being throttled at the one moment a
   *    player is watching for a reply is the worst possible time to be throttled,
   *    and there is no second message for the limit to protect.
   *  - it skips the typing delay, because a goodbye that types itself out slowly
   *    while the player watches is worse than one that just appears.
   *  - it is priority, so the queue cap can never discard it.
   *
   * And it REPORTS. The returned promise settles `written` once the transport
   * has actually been called, `cancelled` if the queue closed first, or
   * `dropped-duplicate` if the dedup window caught it. The caller logs what
   * actually happened rather than assuming it did.
   */
  sayFinal(text: string): Promise<FinalSayResult> {
    if (this.closed) return Promise.resolve("cancelled");
    const now = this.opts.now();
    this.pruneDedup(now);

    const lastSent = this.dedup.get(text);
    if (lastSent !== undefined && now - lastSent < this.opts.dedupWindowMs) {
      this.opts.onDrop?.(text);
      return Promise.resolve("dropped-duplicate");
    }
    this.dedup.set(text, now);

    return new Promise<FinalSayResult>((resolve) => {
      let settled = false;
      const settle = (r: FinalSayResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      // The cap drops the oldest NON-priority item, so a final message is never
      // the victim. If the queue is somehow all-priority and already full, this
      // one still goes in: it is the last thing Elix will ever say.
      if (this.queue.length >= MAX_QUEUE_LENGTH) {
        const victim = this.queue.findIndex((m) => !m.priority);
        if (victim >= 0) {
          const [removed] = this.queue.splice(victim, 1);
          this.droppedByCap++;
          this.opts.onDrop?.(removed!.text);
          removed!.settle?.("cancelled");
        }
      }

      this.queue.push({
        text,
        skipTypingDelay: true,
        priority: true,
        bypassRateLimit: true,
        settle,
      });
      this.startDraining();
    });
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

      // Wait out the sliding rate-limit window. A final message skips it.
      if (!item.bypassRateLimit) {
        const wait = this.timeUntilAllowed();
        if (wait > 0) await this.opts.sleep(wait);
      }

      // Typing delay so the message doesn't appear instantly.
      if (!item.skipTypingDelay) {
        const typingMs = Math.min(item.text.length * this.opts.typingMsPerChar, this.opts.maxTypingMs);
        if (typingMs > 0) await this.opts.sleep(typingMs);
      }

      if (this.closed) {
        item.settle?.("cancelled");
        return;
      }
      const send = this.onSend;
      if (send) {
        send(item.text);
        // Settled AFTER the transport ran, and only then. This is the whole
        // point: the caller can now log what happened, not what it hoped.
        item.settle?.("written");
      } else {
        // No transport means no bot, so nothing could have been sent.
        item.settle?.("cancelled");
      }
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

  /**
   * Stop sending and discard anything pending.
   *
   * Anything still queued is settled as `cancelled`. A final message whose
   * promise never settles would leave the shutdown awaiting forever, which is
   * worse than reporting that the goodbye did not make it.
   */
  close(): void {
    this.closed = true;
    for (const m of this.queue) m.settle?.("cancelled");
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