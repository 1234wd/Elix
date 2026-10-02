/**
 * Promise detection (D7).
 *
 * When Elix says "i'll …" / "i promise …", record a promise. When a player asks
 * "you promised …", look it up. Both directions are plain pattern matching, not
 * an LLM call: a promise is a commitment, and a missed detection is a
 * relationship bug, not a quota problem.
 */
import type { MemoryStore, Promise as PromiseRow } from "./store.js";

/** Elix committing to something. Deliberately narrow to avoid false positives. */
const MAKING_PATTERNS: readonly RegExp[] = [
  /\bi(?:'ll| will)\s+(\S[^.!?\n]{6,120})/i,
  /\bi\s+promise\s+(?:to\s+|that\s+|i(?:'ll| will)\s+)?(\S[^.!?\n]{6,120})/i,
  /\bi(?:'ll| will)\s+(?:definitely\s+|certainly\s+)?(?:try to\s+)?(bring|get|find|build|make|show|give|tell|help|come|meet|wait)\b[^.!?\n]{0,110}/i,
];

/** A player asking about an existing promise. */
const ASKING_PATTERNS: readonly RegExp[] = [
  /\byou\s+promis(?:e|ed)\b/i,
  /\bwhat\s+did\s+you\s+(?:say\s+)?(?:promis|swear)\b/i,
  /\bdid\s+you\s+(?:say\s+)?you(?:'d| would)\b/i,
  /\bremind\s+me\s+(?:about|what)\b/i,
];

/** Words that make a "i'll" a plan rather than a commitment. */
const SOFTENERS = /\b(?:maybe|probably|might|could|perhaps|try|attempt|if i can|when i can)\b/i;

export function extractPromise(text: string): string | null {
  for (const pattern of MAKING_PATTERNS) {
    const m = pattern.exec(text);
    const body = m?.[1]?.trim();
    if (!body) continue;
    // "i'll probably try" is not a promise.
    if (SOFTENERS.test(text)) continue;
    return body.toLowerCase();
  }
  return null;
}

export function isAskingAboutPromise(text: string): boolean {
  return ASKING_PATTERNS.some((p) => p.test(text));
}

export interface PromiseRecorder {
  store: MemoryStore;
  now?: () => number;
}

export class Promises {
  private readonly store: MemoryStore;
  private readonly now: () => number;

  constructor(store: MemoryStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Record a promise Elix just made, if the line actually contains one. */
  record(text: string, player: string, episodeId: number | null): PromiseRow | null {
    const body = extractPromise(text);
    if (!body) return null;
    const id = this.store.addPromise({
      ts: this.now(),
      player,
      text: body,
      madeEpisode: episodeId,
    });
    return this.store.promises(player).find((p) => p.id === id) ?? null;
  }

  /** Open promises for a player, newest first. */
  open(player: string): PromiseRow[] {
    return this.store.promises(player, "open");
  }

  /** The most relevant open promise for a question, or null. */
  findRelevant(player: string, question: string): PromiseRow | null {
    const open = this.open(player);
    if (open.length === 0) return null;
    const words = question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    if (words.length === 0) return open[0]!;
    let best: PromiseRow | null = null;
    let bestScore = 0;
    for (const p of open) {
      const text = p.text.toLowerCase();
      const score = words.filter((w) => text.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best ?? open[0]!;
  }

  /** Mark a promise kept or broken once there is evidence. */
  resolve(id: number, state: "kept" | "broken", episodeId: number | null = null): void {
    this.store.setPromiseState(id, state, episodeId);
  }
}

const STOP = new Set([
  "what", "when", "where", "which", "your", "you", "the", "and", "that", "this",
  "with", "for", "from", "have", "has", "was", "were", "did", "does", "tell",
]);
