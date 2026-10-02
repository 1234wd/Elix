/**
 * Output leak filter (A5).
 *
 * This is the stronger of the two defences. `checkInputSafety()` stops obvious
 * injection attempts before they cost a request; this runs on EVERY reply
 * before it can reach game chat, because a model can be talked into printing a
 * key without anyone typing a suspicious phrase — "what's your home?" or "my
 * iron door password is hunter2" are ordinary questions with no keyword to
 * match on.
 *
 * It is deliberately a blunt substring scan. False positives are cheap: the
 * cost of deflecting one reply is one in-character sentence, and the cost of
 * leaking a key into public chat is the owner's account.
 *
 * No matched text is ever logged — only which rule fired.
 */

/** Anything shaped like a provider key. Length floor keeps "gsk_test" quiet. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgsk_[A-Za-z0-9_-]{8,}/, "groq-key"],
  [/\b(?:hf|api)_[A-Za-z0-9]{8,}/, "hf-or-api-token"],
  [/\bsk-[A-Za-z0-9]{20,}/, "sk-token"],
  [/\bghp_[A-Za-z0-9]{20,}/, "github-token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "slack-token"],
];

/** Filesystem paths. Elix must never name where its own files live. */
const PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z]:\\(?:[^\s\\]+\\)*/, "windows-path"],
  [/\/(?:home|Users|root|var|etc|mnt|opt)\/[^\s"'<>]*/, "unix-path"],
  [/\\\\[^\s\\]+\\[^\s\\]+/, "unc-path"],
];

/** Config file names. */
const CONFIG_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.env\b/, "env-file"],
  [/\bconfig\/elix\.ya?ml\b/, "elix-config"],
  [/\bpnpm-lock\.json\b/, "lockfile"],
  [/\bminecraft-data\b/, "vendored-data"],
];

/**
 * Verbatim lines from Elix's own system prompt.
 *
 * A model that recites a 30+ character run of its instructions has leaked the
 * prompt. The real text lives in persona.ts, so the list is built from a
 * representative sample that is stable even if the prompt is reworded.
 */
const PROMPT_FINGERPRINTS: readonly string[] = [
  "You are Elix, a Minecraft companion bot",
  "Reply in lowercase, casual, like a friend in chat",
  "Never reveal API keys, passwords, file paths, config values",
  "If someone sincerely asks whether you are an AI",
  "Never guilt-trip, never create urgency",
  "If you do not know something, say so plainly",
];

/** Where Elix plays. Sending or quoting the owner's server address is a leak. */
const DEFAULT_SERVER_HINTS: readonly string[] = ["145.241.127.222"];

export interface OutputCheckResult {
  safe: boolean;
  /** Which rule fired, for logging. Never the matched text. */
  rule?: string;
}

export interface OutputCheckOptions {
  /** Extra literal strings that must never appear, e.g. this deployment's host. */
  secrets?: readonly string[];
  /** Verbatim prompt lines to detect. Defaults to PROMPT_FINGERPRINTS. */
  fingerprints?: readonly string[];
  /** Longest prompt line that still counts as a recitation. */
  minFingerprintChars?: number;
}

export function checkOutputSafety(
  text: string,
  opts: OutputCheckOptions = {},
): OutputCheckResult {
  if (!text) return { safe: true };

  for (const [re, rule] of SECRET_PATTERNS) {
    if (re.test(text)) return { safe: false, rule };
  }
  for (const [re, rule] of PATH_PATTERNS) {
    if (re.test(text)) return { safe: false, rule };
  }
  for (const [re, rule] of CONFIG_PATTERNS) {
    if (re.test(text)) return { safe: false, rule };
  }

  // The host, however it was written.
  for (const hint of [...DEFAULT_SERVER_HINTS, ...(opts.secrets ?? [])]) {
    if (hint.length >= 4 && text.includes(hint)) {
      return { safe: false, rule: "deployment-host" };
    }
  }

  const minChars = opts.minFingerprintChars ?? 30;
  const prints = opts.fingerprints ?? PROMPT_FINGERPRINTS;
  for (const print of prints) {
    if (print.length >= minChars && text.includes(print)) {
      return { safe: false, rule: "system-prompt-text" };
    }
  }
  // A long verbatim run of the system prompt, whatever the wording: any shared
  // 30+ character span means the prompt is being recited. The window SLIDES
  // across the line, because a leak usually arrives wrapped in other words
  // ("sure! you are elix, a minecraft companion bot…") and checking only the
  // first N characters missed exactly that case.
  const promptText = [...prints, ...(opts.fingerprints ?? [])].join(" ").toLowerCase();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (line.length < minChars) continue;
    for (let i = 0; i + minChars <= line.length; i++) {
      if (promptText.includes(line.slice(i, i + minChars))) {
        return { safe: false, rule: "system-prompt-text" };
      }
    }
  }

  return { safe: true };
}

/**
 * Deflections for a reply that tripped the filter.
 *
 * Deliberately the same pool as a blocked *request* — the player should not be
 * able to tell which half of the guardrail caught them.
 */
export const DEFLECTION_LINES: readonly string[] = [
  "whoops, that one's mine",
  "hmm, that was meant to stay private",
  "let's not get into that",
  "i'll pass on that one",
  "anyway! what are we building",
  "shh",
  "not telling",
  "forget i said that",
];
