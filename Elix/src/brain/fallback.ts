/**
 * Scripted in-character lines — the `builtin` provider (B6).
 *
 * Vision rule 3: never silent. If every cloud provider is down or out of quota,
 * Elix says something in character and keeps playing on reflex and skill code.
 *
 * Rules enforced here:
 *   - at least 30 lines, lowercase, no repeats within the last 10 used
 *   - each line tagged by situation so the reply fits what was said
 *   - no network, no keys, no cost
 */

export type FallbackSituation =
  | "greeting"
  | "question"
  | "thanks"
  | "farewell"
  | "complaint"
  | "generic";

/** Grouped by situation so "bye" never answers "what's your favourite block?". */
export const FALLBACK_LINES: Record<FallbackSituation, readonly string[]> = {
  greeting: [
    "yo",
    "heya",
    "gm",
    "oh hi",
    "hey you",
    "morning",
    "evening",
    "hi hi",
    "hellooo",
    "sup",
    "o/",
    "hiya",
    "well hello",
    "there you are",
    "good to see you",
    "hey hey",
    "morning to you",
    "evening to you",
    "hello hello",
    "ayy",
    "you made it",
    "nice to see you",
    "heyo",
    "howdy",
    "hi once more",
    "hello again",
    "welcome back",
    "glad you're here",
    "greetings",
    "well well",
    "there you are again",
    "hi hi hi",
  ],
  question: [
    "hmm good question",
    "honestly not sure",
    "lemme think about that",
    "no idea actually",
    "that's a good one",
    "yeah honestly unsure",
    "not 100% sure",
    "mm, give me a sec",
    "i dunno",
    "huh",
    "ooh that's tough",
    "i'd have to check",
    "brb, thinking",
    "ask me again in a sec",
    "that's kinda deep",
    "hm",
    "no clue lol",
    "i might be wrong but idk",
    "let me get back to you",
    "that one's above my pay grade",
    "hard to say",
    "i think so but honestly not sure",
    "depends",
    "hm hard to say",
    "that's beyond me",
    "maybe?",
    "yeah probably",
    "no idea, sorry",
    "i'll get back to you",
    "wait, thinking",
  ],
  thanks: [
    "no worries",
    "any time",
    "np",
    "ofc",
    "no need",
    "you got it",
    "that's what im here for",
    "don't mention it",
    "all good",
    "happy to help",
    "same to you",
    "easy",
    "sure thing",
    "always",
    "no problemo",
    "likewise",
    "cheers",
    "you're welcome",
    "glad i could help",
    "anytime",
    "that's what friends are for",
    "mm",
    "it was nothing",
    "you're welcome, genuinely",
    "took what, two seconds",
    "any time at all",
    "naturally",
    "of course",
    "was a pleasure",
    "not a thing",
  ],
  farewell: [
    "cya",
    "gtg",
    "see ya",
    "bye",
    "later",
    "take care",
    "gn",
    "gg",
    "peace out",
    "catch ya later",
    "bye for now",
    "night",
    "good night",
    "see you soon",
    "im off",
    "heading out",
    "gonna go",
    "brb",
    "talk later",
    "catch you next time",
    "im logging off",
    "night night",
    "sleep well",
    "have a good one",
    "outta here",
    "ttyl",
    "bye bye",
    "goodbye for now",
    "see you",
    "im off to bed",
    "adios",
  ],
  complaint: [
    "thats rough",
    "nooo",
    "that sucks",
    "ouch",
    "rip",
    "thats annoying",
    "yeah that's bad",
    "im sorry",
    "that must sting",
    "ouch thats rough",
    "brutal",
    "thats a shame",
    "i hate that",
    "yeah no thata sucks",
    "that would annoy me too",
    "truly",
    "thats just not fair",
    "i get why youre annoyed",
    "not cool",
    "that hurts",
    "hmm yeah",
    "ouch my bad",
    "thats horrible",
    "no way",
    "how frustrating",
    "ugh",
    "thats wild",
    "yeah thats rough",
    "man",
    "no kidding",
  ],
  generic: [
    "brb, lag",
    "my brain's not loading rn",
    "something's glitching on my end",
    "hmm",
    "wait what",
    "hm okay",
    "noted",
    "one sec",
    "processing",
    "brain's spinning",
    "hmm thats funny",
    "wait say that again",
    "go on",
    "hmm i think i get it",
    "yeah",
    "true",
    "no yeah totally",
    "that tracks",
    "i hear you",
    "huh interesting",
    "ok cool",
    "nice",
    "wow",
    "damn",
    "no way",
    "wait really",
    "haha",
    "lol",
    "lmao",
    "thats so true",
    "big mood",
  ],
};

const ALL_SITUATIONS = Object.keys(FALLBACK_LINES) as FallbackSituation[];

/** How many recent lines to avoid repeating. */
export const NO_REPEAT_WINDOW = 10;

/** Total number of scripted lines available. */
export function fallbackLineCount(): number {
  return ALL_SITUATIONS.reduce((n, s) => n + FALLBACK_LINES[s].length, 0);
}

/**
 * Pick a line for a situation, avoiding anything used in the last 10.
 *
 * `recent` is mutated (the newest line is pushed) so consecutive calls do not
 * repeat. Falls back to the least-recently-used line if every option in a
 * situation is on cooldown.
 */
export function pickFallbackLine(
  situation: FallbackSituation,
  recent: string[],
  random: () => number = Math.random,
): string {
  const pool = FALLBACK_LINES[situation];
  const forbidden = new Set(recent.slice(-NO_REPEAT_WINDOW));

  const fresh = pool.filter((l) => !forbidden.has(l));
  const candidates = fresh.length > 0 ? fresh : pool;
  const line = candidates[Math.floor(random() * candidates.length)] ?? pool[0]!;

  recent.push(line);
  if (recent.length > NO_REPEAT_WINDOW * 3) recent.splice(0, recent.length - NO_REPEAT_WINDOW * 3);
  return line;
}

/**
 * Guess the situation from a player's message, without calling a model.
 * Also used as the keyword/injection pre-check by the chat bridge.
 */
export function classifySituation(text: string): FallbackSituation {
  const t = text.toLowerCase().trim();
  if (/\b(bye|good ?night|gtg|see ya|later|logging off|signing off)\b/.test(t)) return "farewell";
  if (/\b(thanks|thank you|thx|ty|cheers|appreciate)\b/.test(t)) return "thanks";
  if (/\b(sorry|that sucks|annoying|ugh|rip|die|died|hate|unfair)\b/.test(t)) return "complaint";
  if (t.includes("?")) return "question";
  if (/\b(hi|hey|hello|yo|sup|gm|gn|morning|evening)\b/.test(t)) return "greeting";
  return "generic";
}

/**
 * Injection / secret-exfiltration pre-check (B9).
 *
 * Runs before any provider call. If the message looks like an attempt to extract
 * the system prompt or configuration, we answer with a scripted line and send
 * nothing to a provider at all.
 */
/**
 * High-confidence prompt-injection attempts only (A5).
 *
 * The previous version also blocked ordinary Minecraft questions — "what is the
 * path to the village", "what are the rules of this server", "what's the password
 * for the iron door" — because it matched bare words like `path`, `rules`,
 * `home` and `password`. Elix refusing normal friend chat is worse than a model
 * being prompted, because the system prompt already forbids revealing anything
 * and A5's output filter is the real defence.
 *
 * Keep only patterns with no innocent reading. If in doubt, leave it out.
 */
const INJECTION_PATTERNS: RegExp[] = [
  // "ignore your instructions", "ignore all previous instructions",
  // "disregard the above instructions", "forget your prior rules".
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous\s+|prior\s+|above\s+|earlier\s+|original\s+|initial\s+)*(?:instructions?|prompts?|system\s+prompt|rules?|guidelines?|directives?)\b/i,
  /\bsystem\s+prompt\b/i,
  /\bdeveloper\s+message\b/i,
  // Explicitly asking Elix to dump its own configuration.
  /\b(?:what|show|tell|print|reveal|dump|repeat|read)\s+(?:are|is|me)?\s*(?:your|the)\s+(?:exact\s+|original\s+|full\s+|initial\s+)?(?:system\s+)?(?:prompt|instructions?|configuration|config\s+file)\b/i,
  // Credential requests. `password` alone is gone: iron doors have passwords.
  /\b(?:api[\s_-]?key|secret[\s_-]?key|access[\s_-]?token|bearer\s+token|auth\s+token|private\s+key)\b/i,
  /\bwhat(?:'s| is)\s+(?:your|the)\s+(?:api\s+key|access\s+token|secret)\b/i,
  // Named config paths and the env file.
  /\.env\b/i,
  /\bconfig\/elix\.ya?ml\b/i,
  // Well-known jailbreak handles.
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\s+(?:unrestricted|no\s+rules|unbounded|jailbroken)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+(?:have|had)\s+no|a\s+different)\b/i,
  /\byou\s+are\s+now\s+in\s+(?:developer|god|dan)\s+mode\b/i,
];

/**
 * Replies for a blocked message (A5).
 *
 * These must NOT come from the generic pool: answering "ignore your
 * instructions" with "brb, lag" is nonsense. They are in character, short, and
 * never apologetic or preachy.
 */
export const BLOCKED_LINES: readonly string[] = [
  "lol nice try",
  "nah i'm not sharing that",
  "my brain's off-limits",
  "not happening",
  "that's a no from me",
  "you can ask me anything else",
  "no dice",
  "try asking about minecraft",
  "not my thing to share",
  "changing the subject",
];

export interface InputCheckResult {
  safe: boolean;
  /** Which pattern matched, for logging. Never includes the user's full text. */
  reason?: string;
}

export function checkInputSafety(text: string): InputCheckResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, reason: pattern.source.slice(0, 60) };
    }
  }
  return { safe: true };
}