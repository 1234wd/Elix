/**
 * Round 15 Part C — the command parser.
 *
 * Deterministic only. No model sees any of this, and that is the whole design: "stop"
 * must work when the provider is down, rate-limited, or slow, because the moment someone
 * needs Elix to stop is not a good moment to be waiting on a network call.
 *
 * Two decisions worth stating, because both are the kind that look like features:
 *
 *  - The list lives here, in ONE place, in one flat table. It is not assembled from
 *    config, not generated, not extended at runtime. A command set you cannot read in
 *    one screen is a command set nobody can audit, and this one decides what a stranger
 *    in a public server can make the bot do.
 *  - Roman Urdu forms are here because the OWNER asked for them. They are the same
 *    commands with the same authority rules — `ruko` and "stop" are indistinguishable to
 *    Elix — not a second, weaker vocabulary. An owner-only command in another language
 *    would be exactly the sort of thing that gets missed in an audit.
 *
 * Parsing is exact against a whole word, not a substring search. "i stopped by the river"
 * contains "stop", and a bot that reacts to that is a bot that reacts to conversation.
 */

/** What a line can ask Elix to do. Nothing else is reachable. */
export type ActionName = "follow" | "come" | "stop";

export interface CommandMatch {
  action: ActionName;
  /** The exact words that matched, for the log. Never the rest of the line. */
  matched: string;
}

/**
 * Every command form, in one table.
 *
 * `action` is the ONLY thing a form can produce. There is no free-text argument and no
 * third field, which means no form can ever express "go to block 12 -4 300" or anything
 * else that turns the bot into a remote control for someone who is not the owner.
 *
 * Ordered longest-first inside each group so "mere peeche aao" is tried before any shorter
 * form that might be a prefix of it.
 */
const FORMS: ReadonlyArray<readonly [ActionName, readonly string[]]> = [
  ["follow", ["follow me", "come with me", "follow me please", "stick with me", "tag along", "mere peeche aao", "mere peeche", "peeche aao", "mere saath aao", "saath chalo"]],
  ["come", ["come here", "come to me", "come over here", "idhar aao", "idhar aa", "yahan aao", "yahan aa", "mere paas aao", "mere yahan aao", "aao yahan"]],
  ["stop", ["stop", "stay", "wait", "ruk", "ruko", "ruk jao", "ruk ja", "rukna", "atak jao", "wahi ruko", "yahi ruko", "same reh jao", "jago rehne do"]],
];

/**
 * Normalise a chat line for matching.
 *
 * Lowercased, punctuation removed, whitespace collapsed. Nothing else: no stemming, no
 * fuzzy matching, no Levenshtein. A parser that guesses is a parser that eventually guesses
 * wrong in front of a stranger.
 */
export function normaliseCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The command in a line, or null.
 *
 * Whole-word containment, so "i stopped by the river" is not a stop command. The longest
 * matching form wins, so a line carrying two forms ("follow me and stop") resolves to the
 * more specific one rather than to whichever happens to be listed first.
 *
 * IMPORTANT: this is deliberately NOT a safety boundary. It says what a line *says*, not
 * whether the speaker is allowed to say it. Authorisation is the caller's job, and it
 * happens after the wellbeing check.
 */
export function parseCommand(text: string): CommandMatch | null {
  const normalised = normaliseCommand(text);
  if (normalised.length === 0) return null;

  let best: CommandMatch | null = null;
  for (const [action, forms] of FORMS) {
    for (const form of forms) {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(form)}($|\\s)`, "u");
      if (!pattern.test(normalised)) continue;
      if (!best || form.length > best.matched.length) {
        best = { action, matched: form };
      }
    }
  }
  return best;
}

/** Every form, for the README note and for tests that assert the list has not grown. */
export function allCommandForms(): ReadonlyArray<readonly [ActionName, string]> {
  return FORMS.flatMap(([action, forms]) => forms.map((f): readonly [ActionName, string] => [action, f]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Filler words allowed between Elix's name and the command.
 *
 * Two of them, not twenty. Every filler word is a hole in the whole-intent rule, and the
 * rule exists so that a QUESTION containing "stop" is answered instead of obeyed. "elix how
 * do i stop creepers from blowing up my house" must not become a stop command, and a
 * generous filler list is how that bug comes back.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "please",
  "pls",
  "plz",
  "now",
  "bro",
  "yaar",
  "ok",
  "okay",
]);

/** How many filler words may sit between the name and the command. */
export const MAX_FILLER_WORDS = 2;

/**
 * The command in a line that was ADDRESSED to Elix, or null.
 *
 * This is what `BotSession` uses. `parseCommand` is the raw matcher and will happily find
 * "stop" inside a question, which is correct for its job and wrong for this one.
 *
 * Two rules, both measured in Round 16:
 *
 *  - ADDRESSED ONLY. "wait for me guys" is one player talking to another, and treating it
 *    as a command lets a stranger stop Elix by accident — or on purpose, by typing six
 *    words that look like chat.
 *  - WHOLE INTENT. After removing Elix's name and up to two filler words, what is left must
 *    be EXACTLY a command form. So "elix follow me" is a command and
 *    "elix how do i stop creepers from blowing up my house" is a question.
 *
 * The consequence is that anything not exactly a command goes to the brain as normal chat,
 * which is where a question belongs.
 */
export function parseAddressedCommand(message: string, botName: string): CommandMatch | null {
  const normalised = normaliseCommand(message);
  if (normalised.length === 0) return null;

  // Addressed, as a whole word, case-insensitively. The line has already been lowercased
  // by normaliseCommand, so matching the configured name case-sensitively never matched
  // anything at all — `regex(/(?:^|\s)Elix(?:$|\s)/)` against "elix follow me" is false.
  // Round 16 measured this as "follow me does nothing", which is the safest possible
  // failure and therefore the hardest one to notice.
  const escaped = escapeRegExp(botName.toLowerCase());
  const nameRe = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "iu");
  if (!nameRe.test(normalised)) return null;

  // Strip the name, then up to MAX_FILLER_WORDS leading filler words.
  const withoutName = normalised.replace(nameRe, " ").replace(/\s+/gu, " ").trim();
  const words = withoutName.split(" ").filter(Boolean);
  let i = 0;
  while (i < words.length && i < MAX_FILLER_WORDS && FILLER_WORDS.has(words[i] as string)) i++;
  const remainder = words.slice(i).join(" ");
  if (remainder.length === 0) return null;

  // EXACT match, not containment. This single rule is what keeps
  // "elix stop spamming" from stopping Elix.
  for (const [action, forms] of FORMS) {
    for (const form of forms) {
      if (remainder === form) return { action, matched: form };
    }
  }
  return null;
}

/**
 * How often one player may be told "i can't do that one".
 *
 * Round 16 measured a stranger saying "stop spamming the chat" and being told he cannot,
 * which turns a bot into a thing to poke. Once per ten minutes is enough for the owner to
 * learn and not enough to be a nuisance.
 */
export const REFUSAL_THROTTLE_MS = 10 * 60_000;

/** Per-player refusal throttle. Small enough to hold in a field. */
export class RefusalThrottle {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly windowMs: number = REFUSAL_THROTTLE_MS) {}

  /** True when this player may be refused now; records the refusal. */
  take(player: string, now: number = Date.now()): boolean {
    const last = this.lastAt.get(player);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.lastAt.set(player, now);
    return true;
  }

  /** Has this player been refused inside the window? Read-only, for tests. */
  isThrottled(player: string, now: number = Date.now()): boolean {
    const last = this.lastAt.get(player);
    return last !== undefined && now - last < this.windowMs;
  }

  get size(): number {
    return this.lastAt.size;
  }
}

/**
 * The short acknowledgement for an accepted command.
 *
 * Lowercase, no punctuation, one line. A player who says "come here" in front of three
 * others should not read a paragraph.
 */
export const ACKNOWLEDGEMENTS: Readonly<Record<ActionName, string>> = {
  follow: "on my way",
  come: "coming",
  stop: "ok, stopping",
};

/**
 * The one refusal anyone who is not an owner gets.
 *
 * Short, polite, and it does not explain the rules. "You are not on the owner list" tells
 * a stranger exactly which list to try names from.
 */
export const NOT_AN_OWNER = "i can't do that one, sorry";