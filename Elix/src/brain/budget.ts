/**
 * Token budgeter (B6).
 *
 * Estimates tokens as characters / 4 with a 15% safety margin, so no tokenizer
 * has to be downloaded and no tokenizer drift can make us overshoot a quota.
 *
 * Trimming rules, in order:
 *   1. Never drop a pinned message (the newest turn, open promises).
 *   2. Drop the least important, oldest messages first.
 *   3. Never leave fewer than the system prompt.
 */
import type { ChatMessage } from "./types.js";

/** Rough chars-per-token ratio used across OpenAI-compatible tokenizers. */
export const CHARS_PER_TOKEN = 4;

/** Safety margin so an estimate never under-counts and trips a 429. */
export const ESTIMATE_MARGIN = 1.15;

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * ESTIMATE_MARGIN);
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export interface BudgetResult {
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  dropped: number;
}

/**
 * Trim messages to fit `maxTokens`.
 *
 * Importance is explicit where the caller set it; otherwise a message's default
 * importance falls off with its age, so recent turns survive and old history is
 * what gets dropped.
 */
export function budgetMessages(
  messages: ChatMessage[],
  maxTokens: number,
): BudgetResult {
  const tokensBefore = estimateMessages(messages);
  if (tokensBefore <= maxTokens) {
    return { messages, tokensBefore, tokensAfter: tokensBefore, dropped: 0 };
  }

  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  // Age-based default importance: newest is most important.
  const scored = rest.map((m, i) => ({
    message: m,
    index: i,
    importance: m.importance ?? i,
    pinned: m.pinned === true,
  }));

  // Drop the lowest-importance, oldest, unpinned messages first.
  const dropOrder = [...scored]
    .filter((s) => !s.pinned)
    .sort((a, b) => a.importance - b.importance || a.index - b.index);

  const kept = new Set(scored.map((s) => s.index));
  let running = estimateMessages(system) + estimateMessages(dropOrder.map((s) => s.message));
  let droppedCount = 0;

  for (const candidate of dropOrder) {
    if (running <= maxTokens) break;
    kept.delete(candidate.index);
    running -= estimateTokens(candidate.message.content) + 4;
    droppedCount++;
  }

  const trimmed = [
    ...system,
    ...scored.filter((s) => kept.has(s.index)).map((s) => s.message),
  ];

  return {
    messages: trimmed,
    tokensBefore,
    tokensAfter: estimateMessages(trimmed),
    dropped: droppedCount,
  };
}

/**
 * Normalised cache key: identical prompts within the cache window reuse an
 * answer, which is the single biggest quota saver for repeated small talk.
 */
export function normalizePrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role}:${m.content.trim().toLowerCase().replace(/\s+/g, " ")}`)
    .join("\n");
}

export const CACHE_WINDOW_MS = 10 * 60 * 1000;

export interface CacheEntry {
  value: string;
  at: number;
}

export class ReplyCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly windowMs: number = CACHE_WINDOW_MS,
    private readonly maxEntries = 200,
  ) {}

  get(key: string, now: number): string | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (now - hit.at > this.windowMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: string, now: number): void {
    this.entries.set(key, { value, at: now });
    // Bound the map so a long session does not grow forever.
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Idle-chatter budget: `brain.idleChatterBudgetPerHour` calls per rolling hour.
 * Greetings, combat and movement never consume it — those never reach the brain.
 */
export class IdleBudget {
  private stamps: number[] = [];

  constructor(private readonly perHour: number) {}

  tryConsume(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    if (this.stamps.length >= this.perHour) return false;
    this.stamps.push(now);
    return true;
  }

  get used(): number {
    return this.stamps.length;
  }

  get limit(): number {
    return this.perHour;
  }
}