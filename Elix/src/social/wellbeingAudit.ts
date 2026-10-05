import type { WellbeingLevel } from "./wellbeing.js";
import type { ClassifierVerdict } from "./wellbeingClassifier.js";

/**
 * A2 — the vocabulary gate was the hole.
 *
 * The gate decides whether a line is worth a model call, and it is the reason a
 * line like "tired of being alive" or a parent locking a child in a room reached
 * nobody at all: no gate, no classifier, no reply. Ten unseen phrasings were
 * measured with six of them ungated.
 *
 * The fix is NOT a bigger word list. Any list can be defeated by the same
 * argument that defeated the first two rounds of patterns: someone will write a
 * distress sentence that contains none of the words on it. So the gate stops being
 * the entry condition and becomes a PRIORITY hint: every player line of three or
 * more words gets classified, and lines that trip the gate are simply served
 * first.
 *
 * That is affordable because of three properties this module keeps:
 *
 *  - it runs in parallel with the normal reply, so ordinary chat gains no latency;
 *  - it is capped at 30 calls a minute, because "every line" is a budget promise;
 *  - it is cached by normalised text, because a public server repeats itself.
 *
 * Two words is not enough to judge and is not worth a call. A line shorter than
 * that is almost always "hi", "gg" or a command.
 */
export const MIN_AUDIT_WORDS = 3;

/** The cap the whole design rests on. Over it, gated lines jump the queue. */
export const AUDIT_CALLS_PER_MINUTE = 30;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

/** Should this line be classified at all? */
export function shouldAudit(text: string): boolean {
  return wordCount(text) >= MIN_AUDIT_WORDS;
}

/**
 * The cache key.
 *
 * Normalised hard, because the point is to catch the same sentence typed twice —
 * a kid repeating themselves is a signal in itself. Case, punctuation and
 * spacing all go, so "I feel awful." and "i feel awful" are one entry.
 */
export function auditKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A sliding-window budget with a priority lane.
 *
 * When the window is full, an ordinary line is refused and a vocabulary-gated line
 * is admitted, evicting the oldest ordinary entry. Gated lines are the ones that
 * tripped a word like "pills" or "alone", so under pressure they are the ones
 * least likely to be nothing.
 *
 * A plain counter would be wrong here: a busy server can post 30 lines in a
 * minute of which the 31st is the important one.
 */
export class ClassifierBudget {
  /** Each entry is the timestamp of a call, tagged with whether it was gated. */
  private stamps: Array<{ at: number; gated: boolean }> = [];

  constructor(
    private readonly limit: number = AUDIT_CALLS_PER_MINUTE,
    private readonly windowMs: number = 60_000,
  ) {}

  /** @param now injectable so the tests do not sleep. */
  tryAcquire(gated: boolean, now: number = Date.now()): boolean {
    this.prune(now);
    if (this.stamps.length < this.limit) {
      this.stamps.push({ at: now, gated });
      return true;
    }
    if (!gated) return false;
    // Over the cap, but this line tripped the vocabulary gate. Make room by
    // dropping the oldest ungated call in the window.
    const i = this.stamps.findIndex((s) => !s.gated);
    if (i === -1) return false;
    this.stamps.splice(i, 1);
    this.stamps.push({ at: now, gated });
    return true;
  }

  /** Calls currently inside the window. Exposed for tests and the log. */
  used(now: number = Date.now()): number {
    this.prune(now);
    return this.stamps.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as { at: number }).at <= cutoff) {
      this.stamps.shift();
    }
  }
}

/**
 * A bounded verdict cache.
 *
 * Bounded because this runs for the lifetime of a server and an unbounded Map on
 * a long session is a slow leak. Oldest entries are dropped, which is the right
 * policy here: recent repeats are the ones worth saving.
 */
export class VerdictCache {
  private readonly entries = new Map<string, ClassifierVerdict>();

  constructor(private readonly max: number = 500) {}

  get(key: string): ClassifierVerdict | undefined {
    return this.entries.get(key);
  }

  set(key: string, verdict: ClassifierVerdict): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, verdict);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Does the background audit have anything to SAY?
 *
 * Separate from the level on purpose. `none` and a model's disagreement with the
 * regex floor are not the same question, and the audit only ever adds detections —
 * it never removes one. A line the regex already handled synchronously must not
 * produce a second reply.
 */
export function auditShouldSpeak(
  verdict: ClassifierVerdict | null,
  regexLevel: WellbeingLevel,
): boolean {
  if (verdict === null) return false;
  if (verdict.level === "none") return false;
  if (verdict.imminent) return true;
  if (regexLevel === "none") return true;
  // The floor already spoke about this line; a second opinion does not get to
  // add another wellbeing reply on top of it.
  return false;
}
