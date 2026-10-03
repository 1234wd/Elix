/**
 * Importance (D2) and personal-info redaction (D4).
 *
 * Both are pure functions, called on the write path. Neither spends quota: an LLM
 * call per episode would be absurd for something that decides what gets
 * retrieved, and the rules below are stable enough to be worth testing.
 *
 * Consolidation MAY adjust these scores in its nightly batch, but the value here
 * is the default at write time and is never wrong, only coarse.
 */
import type { EpisodeKind, Speaker } from "./store.js";

/** Base score by episode kind. */
const KIND_SCORE: Record<EpisodeKind, number> = {
  promise: 9,
  death: 8,
  event: 6,
  build: 6,
  trade: 6,
  reflect: 5,
  chat: 4,
  emotion: 4,
  move: 2,
  // A6: a line Elix overheard. It is the majority of a public server's chat and
  // must not outrank a direct conversation just for being numerous.
  ambient: 2,
};

/** A first meeting with a player is a `chat` episode, but it is not forgettable. */
const FIRST_MEETING_BONUS = 4;

/** Words that mark a line as something a person would expect to be remembered. */
const MEMORY_WORDS: readonly string[] = [
  "remember",
  "birthday",
  "promise",
  "favourite",
  "favorite",
  "don't forget",
  "dont forget",
  "my name is",
  "i like",
  "i love",
  "i hate",
  "call me",
];

const KEYWORD_BONUS = 2;

/** Clamp to the 0..10 range the retrieval scorer expects. */
function clamp(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n * 100) / 100));
}

export interface ImportanceInput {
  kind: EpisodeKind;
  text: string;
  speaker: Speaker;
  player: string | null;
  /** True when this is the first time we have seen this player. */
  isFirstMeeting?: boolean;
  /** Set by the promise detector, so a detected promise always scores 9. */
  isPromise?: boolean;
}

/**
 * Score an episode 0..10 at write time.
 *
 * promise 9, death 8, first meeting 8, achievement/build 6, direct chat 4,
 * ambient chat 2, plus 2 for a memory keyword.
 */
export function scoreImportance(input: ImportanceInput): number {
  let score = KIND_SCORE[input.kind] ?? 2;

  // Ambient chat: present but not addressed to Elix, so it is worth less.
  if (input.kind === "chat" && input.speaker === "player") {
    const addressed = /\belix\b/i.test(input.text);
    score = addressed ? 4 : 2;
  }

  if (input.isPromise) score = Math.max(score, 9);
  if (input.isFirstMeeting) score = Math.max(score, FIRST_MEETING_BONUS + 4);

  const lower = input.text.toLowerCase();
  if (MEMORY_WORDS.some((w) => lower.includes(w))) score += KEYWORD_BONUS;

  return clamp(score);
}

// ---------------------------------------------------------------------------
// D4 — personal info is redacted at write time
// ---------------------------------------------------------------------------

/**
 * Patterns removed before an episode is stored.
 *
 * This is kid-safe-by-default plus a privacy measure: a child's phone number,
 * home address or school name has no business in a log file, a vector index, or
 * a prompt sent to a cloud model. Redaction happens BEFORE storage, so the value
 * never reaches disk, never gets embedded, and cannot be retrieved later.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Email addresses.
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[email]"],
  // Phone numbers, including the spaced and dashed forms.
  [/\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"],
  // Street addresses: a number then a street word then a type.
  [
    /\b\d{1,5}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd|way|close|place|terrace)\b\.?/gi,
    "[address]",
  ],
  // "I live at 12 Oak Street" — the number-first pattern misses a leading clause.
  [/\b(?:i live (?:at|on)|my address is|we live at)\b[^\n.!?]{4,60}/gi, "[address]"],
  // A real name paired with a school. The `i` flag is REQUIRED, not decorative:
  // without it `(?:school|…)` never matches the capitalised "School" in real
  // sentences and the rule silently never fires.
  [/\bmy name is ([A-Z][a-z]{1,20}) and i go to ([A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3})\s+(?:school|college|academy|high ?school)\b/gi, "[name+school]"],
  [/\bi (?:go|attend) ([A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3})\s+(?:school|college|academy|high ?school)\b/gi, "[school]"],
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
  /** Which pattern kinds fired, for the log. Never the matched text. */
  kinds: string[];
}

const REDACTION_LABELS = ["email", "phone", "address", "home-address", "name+school", "school"] as const;

/**
 * Remove personal info from a line before it is stored.
 *
 * The text is stored redacted. There is no encrypted-at-rest copy, because the
 * point is that the value is never persisted, not that it is hard to read.
 */
export function redactPersonalInfo(input: string): RedactionResult {
  let text = input;
  const kinds: string[] = [];
  REDACTIONS.forEach(([pattern, replacement], i) => {
    if (pattern.test(text)) {
      kinds.push(REDACTION_LABELS[i] ?? `rule-${i}`);
      // Reset lastIndex: these are global regexes reused across calls.
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
      pattern.lastIndex = 0;
    }
  });
  return { text, redacted: kinds.length > 0, kinds };
}
