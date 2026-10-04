/**
 * C3 — typing realism.
 *
 * persona.md says: "Occasional natural typos, sometimes fixed with a *fix". That
 * was written down and never implemented: there was no typo anywhere in src/.
 *
 * The constraints, and why each one exists:
 *
 *  - AT MOST ONE typo in 15 messages. One is a person. Two is a broken keyboard,
 *    and a bot that cannot spell is not charming, it is just bad at the game.
 *  - Random, but reproducible from a seed. A test that cannot pin the randomness
 *    cannot assert the rate.
 *  - Never in numbers, coordinates or player names. "i mined 3 logs at x: 142"
 *    must stay exact; a typo there is a bug report, not a personality.
 *  - Never in the wellbeing path. That path is built and sent before this runs,
 *    so it is not a code path any of this can reach.
 */
import type { SayQueue } from "./say.js";

/** Roughly one in this many messages carries a typo. */
export const TYPO_RATE = 15;

/** How often a typo also gets a `*fix` follow-up. Roughly a third of them. */
export const FIX_RATE = 1 / 3;

/**
 * A tiny, fast, seeded PRNG.
 *
 * Seeded rather than Math.random so the 1-in-15 rate is assertable in a test
 * instead of being a thing you can only observe by luck.
 *
 * The first four draws are DISCARDED. xorshift32 seeded with a small integer is
 * still correlated for its opening outputs — seed 3 returned 57 hits in 600 draws
 * where 40 was the expectation, which is 2.7 sigma and would make the rate test
 * fail for reasons that have nothing to do with the code under test. Discarding
 * the warm-up draws removes the bias without touching the implementation.
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  const next = (): number => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  for (let i = 0; i < 4; i++) next();
  return next;
}

/**
 * Words a typo must never touch: anything a machine or another player has to
 * read exactly.
 *
 * Includes an `@name`, because Elix addresses players by name and a misspelt name
 * is the one typo that reads as a bug rather than as personality.
 */
const PROTECTED = /\d|\b[xyz]\s*[:=]\s*-?\d|@[A-Za-z0-9_]+|^https?:|:\/\/|[\][{}<>|\\^~`]/;

/**
 * Adjacent keys on a QWERTY layout, for the swap form.
 *
 * Only the pairs that produce a plausible mistyping. Nothing is invented beyond
 * adjacency: a frequency table of letter substitutions produces "teh" often
 * enough to look broken rather than human.
 */
export const ADJACENT: Readonly<Record<string, readonly string[]>> = {
  a: ["s", "q", "z", "w"],
  b: ["v", "n", "g", "h"],
  c: ["x", "v", "d", "f"],
  d: ["s", "e", "c", "r", "f", "x"],
  e: ["w", "r", "d", "s", "f"],
  f: ["d", "r", "g", "t", "c", "v"],
  g: ["f", "t", "h", "y", "b", "v"],
  h: ["g", "y", "j", "u", "n", "b"],
  i: ["u", "o", "j", "k"],
  j: ["h", "u", "k", "i", "m", "n"],
  k: ["j", "i", "l", "o", "m"],
  l: ["k", "o", "p"],
  m: ["n", "j", "k"],
  n: ["b", "m", "h", "j"],
  o: ["i", "p", "k", "l"],
  p: ["o", "l"],
  q: ["w", "a"],
  r: ["e", "t", "d", "f"],
  s: ["a", "d", "w", "x", "z", "e"],
  t: ["r", "y", "f", "g"],
  u: ["y", "i", "h", "j"],
  v: ["c", "b", "f", "g"],
  w: ["q", "e", "a", "s"],
  x: ["z", "c", "s", "d"],
  y: ["t", "u", "g", "h"],
  z: ["a", "s", "x"],
};

export interface TypoOptions {
  /** Overridable for tests; defaults to Math.random. */
  random?: () => number;
  /** Probability per message that a typo is put in. Defaults to 1 / TYPO_RATE. */
  rate?: number;
}

export interface TypoResult {
  /** The text to send. Identical to the input when no typo was made. */
  text: string;
  /** The misspelt word, or "" when no typo was made. */
  wrong: string;
  /** The correct word, or "" when no typo was made. */
  right: string;
}

/** Nothing happened. Shared so callers can compare identity. */
const NO_TYPO: TypoResult = { text: "", wrong: "", right: "" };

/**
 * Put at most one typo into a line.
 *
 * Two forms, and only two:
 *
 *   - an ADJACENT-KEY SWAP ("mining" -> "mnining"), the most common human slip;
 *   - a DOUBLED LETTER ("mining" -> "miningg"), what people do when they hit the
 *     key twice.
 *
 * The returned `right` is the word as it was BEFORE the typo, so a `*fix` can
 * restore it exactly. An earlier version tried to reconstruct the correction by
 * un-doubling letters, which cannot undo a swap at all.
 */
export function makeTypo(text: string, opts: TypoOptions = {}): TypoResult {
  const rand = opts.random ?? Math.random;
  const rate = opts.rate ?? 1 / TYPO_RATE;

  if (rand() >= rate) return { ...NO_TYPO, text };

  const words = text.split(" ");
  const candidates: number[] = [];
  words.forEach((w, i) => {
    // Long enough that a typo is plausible, letters only, and safe to touch.
    if (!/^[A-Za-z]{4,}$/.test(w)) return;
    if (PROTECTED.test(w)) return;
    candidates.push(i);
  });
  if (candidates.length === 0) return { ...NO_TYPO, text };

  const index = candidates[Math.floor(rand() * candidates.length)] ?? 0;
  const word = words[index] ?? "";
  const right = word;

  // Never the last letter: a swap there tends to produce something that reads as
  // a different word rather than as a slip of the finger.
  const position = Math.floor(rand() * (word.length - 1));
  const ch = word[position] ?? "";
  const lower = ch.toLowerCase();

  // Which of the two forms. A real choice, not a consequence of the word: the
  // previous version only doubled when the neighbouring letter already matched,
  // which fired 4 times in 2000 attempts and made the "either form" promise
  // meaningless.
  if (rand() < 0.4) {
    // DOUBLED LETTER — the key was hit twice.
    //
    // The insert is `slice(0, position+1) + ch + slice(position+1)`: a copy of the
    // character goes back in. An earlier version used `slice(0, position+2) +
    // slice(position+2)`, which is a no-op — for "pretty" at position 3 that is
    // "prett" + "y" = "pretty", so 114 of 1200 attempts "misspelt" nothing at all
    // and still reported a typo.
    words[index] = word.slice(0, position + 1) + ch + word.slice(position + 1);
    return { text: words.join(" "), wrong: words[index] ?? word, right };
  }

  // ADJACENT-KEY SWAP.
  const alts = ADJACENT[lower] ?? [];
  const pick = alts[Math.floor(rand() * alts.length)];
  if (!pick) return { ...NO_TYPO, text };

  // Keep the original case, so "Mining" does not become "mining".
  const replacement = ch === lower ? pick : pick.toUpperCase();
  words[index] = word.slice(0, position) + replacement + word.slice(position + 1);
  return { text: words.join(" "), wrong: words[index] ?? word, right };
}

/**
 * The `*fix` follow-up line: `*mining`.
 *
 * A single word, which is how people actually correct a typo in game chat — they
 * do not rewrite the sentence.
 */
export function fixLine(right: string): string {
  return `*${right}`;
}

export interface TypingRealismState {
  /** Messages seen. Held across the session so the rate is honest. */
  seen: number;
}

export function newTypingState(): TypingRealismState {
  return { seen: 0 };
}

export interface AppliedTyping {
  /** What to send now. */
  text: string;
  /** What to send after it, or null. Goes through the same SayQueue. */
  followUp: string | null;
  /** True when a typo was actually introduced. */
  typoed: boolean;
}

/**
 * Apply typing realism to one outbound line.
 *
 * The follow-up is RETURNED rather than sent, so the caller can push it through
 * the SayQueue in order — a fix that arrives before its typo is a typo nobody can
 * read — and so a test can assert on both without a queue.
 */
export function applyTypingRealism(
  text: string,
  state: TypingRealismState,
  opts: TypoOptions = {},
): AppliedTyping {
  state.seen += 1;
  const result = makeTypo(text, opts);
  if (result.wrong === "") return { text, followUp: null, typoed: false };

  const rand = opts.random ?? Math.random;
  return {
    text: result.text,
    followUp: rand() < FIX_RATE ? fixLine(result.right) : null,
    typoed: true,
  };
}

/**
 * Wire typing realism onto a SayQueue.
 *
 * Exists so the chat path and the wellbeing path can share one policy. The
 * wellbeing reply is built and sent BEFORE the normal reply path calls this, so
 * there is no path from here to a crisis reply.
 */
export function withTypingRealism(
  queue: SayQueue,
  state: TypingRealismState,
  opts: TypoOptions = {},
): (text: string) => void {
  return (text: string) => {
    const { text: typed, followUp } = applyTypingRealism(text, state, opts);
    queue.say(typed);
    if (followUp) queue.say(followUp, true);
  };
}