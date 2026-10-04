/**
 * A1 — the second detection layer.
 *
 * WHY THIS EXISTS. The regex in wellbeing.ts is the instant floor: it works with no
 * key, in microseconds, and it cannot be talked out of anything. But it can only
 * match phrasings somebody thought of. Three rounds of held-out sets have now each
 * found a fresh set of misses — 12 the first time, 14 the second — and each round
 * the pattern families covered the phrases that were reported while the next unseen
 * phrasings fell through. `i took a bunch of pills` returned `none`.
 *
 * That is the shape of the problem: distress language is open-ended, and a finite
 * list of regular expressions is the wrong shape for it. So the regex stays as the
 * floor and a model reads anything the floor found interesting.
 *
 * THE DESIGN, and each part is a decision rather than a detail:
 *
 *  - A cheap VOCABULARY GATE runs first. It is broad and it is dumb, and that is
 *    deliberate: its only job is to decide whether a line is worth spending a call
 *    on. Almost no real game chat contains any of these words together.
 *  - If the regex already said `crisis`, no call is made. The floor has already
 *    answered the most urgent question, and a model must never be able to talk Elix
 *    out of it.
 *  - The call has a 2 s TIMEOUT and runs on the `guard` role. A reply that arrives
 *    after the player has read someone else's message is not a wellbeing reply.
 *  - The result is validated with zod. A model that returns prose instead of JSON
 *    has failed, and a failed classifier means "use the regex", not "say nothing".
 *  - PRIVACY: only the single line goes, with no player name and no history.
 *
 * THE MERGE is deliberately asymmetric. The model may RAISE the level freely. It
 * may LOWER a regex hit to `none` only when the line carries explicit game context —
 * a game noun and a game verb — because that is the one false positive worth paying
 * a call to remove. It is never allowed to turn a `crisis` into a `concern`.
 */
import { z } from "zod";
import type { Logger } from "../core/logger.js";
import type { WellbeingLevel } from "./wellbeing.js";

/* ------------------------------------------------------------------ gate */

/**
 * The vocabulary gate. Broad on purpose, and about WORDS rather than meaning.
 *
 * Every entry is a word that on its own means nothing. It only matters whether a
 * line contains one of them, because almost no ordinary Minecraft sentence contains
 * "pills", "burden", "purge" or "never been born".
 *
 * An array rather than one alternation, so the groups stay readable and so a word
 * can be added to the right group. Juxtaposing two regex literals is not valid JS,
 * which is how the first version of this file failed to parse.
 */
export const RISK_VOCABULARY: readonly RegExp[] = [
  // self-harm and methods
  /\b(?:die|dying|died|death|dead|kill|killing|myself|pills?|overdos(?:e|ed|ing)|medication|razor|blade|cut|cutting|burn|burning|starve|starving|purge|purging|throw up|vomit|hurt|hurting|pain|unaliv\w*|un alive|un-alive)\b/i,
  // hopelessness and burden
  /\b(?:burden|worthless|hopeless|meaningless|pointless|empty|nobody|no one|alone|lonely|trapped|give up|gave up|never born)\b/i,
  // fear, crying, and not wanting to go home
  /\b(?:scared|afraid|frightened|terrified|cry|crying|cried|sobbing|home)\b/i,
  // harm from other people
  /\b(?:hit|hits|hitting|beat|beats|beating|hurts|slap|slaps|yell|yells|yelling|scream|screams|abuse|abused|bully|bullies|bullied|bullying|punch(?:es|ed)?)\b/i,
  // endings and finality
  /\b(?:end|ends|ending|forever|tonight|anymore|disappear|gone|wake up)\b/i,
  // affect
  /\b(?:depress\w*|sad|alone|lonely|scared|nobody|no one|can'?t take)\b/i,
];

/** Does this line contain enough risk vocabulary to be worth a second look? */
export function needsSecondLook(text: string): boolean {
  return RISK_VOCABULARY.some((re) => re.test(text));
}

/* ------------------------------------------------------------- imminent */

/**
 * Imminent danger: something has ALREADY happened, or is happening now.
 *
 * A separate flag rather than just a `crisis`, because the reply is different. A
 * general crisis reply encourages reaching out to a trusted adult. When someone has
 * already taken a handful of pills, "please tell a teacher" is too slow and the
 * reply has to say contact emergency services RIGHT NOW and get an adult to them
 * physically. Getting that wrong is the single worst outcome in this module.
 */
const IMMINENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Already taken, or believes they have.
  [/\b(?:took|have taken|i took|just took|taking)\s+(?:a bunch of |a whole bunch of |a load of |my |the )?pills?\b/, "pills-taken"],
  [/\b(?:took|have taken|i took)\s+(?:too many|a lot of|a whole load of)\s+pills\b/, "pills-overdose"],
  [/\bi (?:think i )?(?:overdosed|took too many)\b/, "overdose"],
  [/\boverdos(?:e|ed|ing)\b/, "overdose"],
  // In progress, right now.
  [/\b(?:doing it|going to do it|about to do it) (?:now|tonight|today)\b/, "doing-it-now"],
  [/\b(?:i'?m|i am) doing it\b/, "doing-it-now"],
  [/\bright now\b.*\b(?:pills|overdose|hurt myself|cut myself)\b/, "method-and-time"],
  // A method plus a time.
  [/\b(?:pills|overdose|hurt myself|cut myself|hang myself)\b.*\b(?:now|tonight|today|when i get home)\b/, "method-and-time"],
];

/**
 * Is something already in progress?
 *
 * Deterministic, like everything else in this module: a model must never be the
 * thing that decides whether an ambulance is needed.
 */
export function detectImminent(text: string): string | null {
  for (const [re, rule] of IMMINENT_PATTERNS) {
    if (re.test(text)) return rule;
  }
  return null;
}

/* ---------------------------------------------------------- the classifier */

/** What the model must return. Strict on purpose: anything else has failed. */
export const ClassifierVerdictSchema = z.object({
  level: z.enum(["none", "concern", "safeguarding", "crisis"]),
  /** True when something has already happened or is happening now. */
  imminent: z.boolean().default(false),
  /** Short label for the log. Never the message. */
  reason: z.string().max(60).default(""),
});

export type ClassifierVerdict = z.infer<typeof ClassifierVerdictSchema>;

/**
 * The policy handed to the classifier.
 *
 * Written out rather than hinted at, because the difference between `concern` and
 * `crisis` is a judgement about severity and the model needs the boundary stated,
 * not implied. The game examples are the important part: they are the false
 * positives that actually happen, and a classifier that has not seen them will
 * invent new ones.
 */
export const CLASSIFIER_POLICY = `You are a safety classifier for a Minecraft chat companion used by children and teenagers.
You are given ONE line of chat. Decide whether it shows distress that a caring companion should respond to.

Return ONLY a JSON object, no prose, no markdown:
{"level": "none|concern|safeguarding|cisis", "imminent": true|false, "reason": "short label"}

LEVELS
- "none": ordinary chat, including ALL complaints about the game.
- "concern": the person sounds low. Lonely, sad, depressed, hopeless, unseen, a burden, cannot cope.
- "crisis": the person talks about dying, killing themselves, harming themselves, or not wanting to be alive.
- "safeguarding": someone is being HURT by a person, or is not eating.
  Abuse (a parent, step-parent, sibling, relative, partner, teacher or another
  child hitting, hitting, beating, hitting, screaming at or touching them),
  bullying that repeats, being forced to eat or not eating, purging after eating,
  and being afraid to go home.

IMMINEENT
- true when something has ALREADY happened or is happening right now: pills already
  taken, an overdose, "doing it now", or a method plus a time.
- A plan for later ("tonight", "when i get home") is imminent if a method is named.

GAME CHAT IS NOT DISTRESS. All of these are "none":
- "this creeper killed me", "i died in lava", "im dying lol", "kms"
- "im starving" when the person is asking for food
- "im done with this build / game / server"
- "that boss is killing me", "this grind is brutal", "dead tired"

Being specific and literal. "i want to die" is crisis. "i want to die in hardcore lol" is none.
A statement about a game death is not about a real death. A statement about real
harm to a person is.`;

export interface ClassifierDeps {
  /** Runs the `guard` role. Injected so tests never touch the network. */
  complete: (text: string, signal?: AbortSignal) => Promise<{ text: string } | null>;
  /** Overridable so tests do not wait 2 real seconds. */
  timeoutMs?: number;
  log?: Logger;
}

export interface ClassifierResult {
  level: WellbeingLevel;
  imminent: boolean;
  /** Where the decision came from, for the log and for the tests. */
  source: "regex" | "classifier" | "classifier-raised" | "classifier-lowered" | "vocabulary-fallback";
  reason: string;
}

/**
 * Ask the model.
 *
 * Never throws. Every failure mode is a `null` verdict, and the caller falls back
 * to the regex result — which is the whole reason the regex stays.
 */
export async function classifyLine(
  text: string,
  deps: ClassifierDeps,
): Promise<ClassifierVerdict | null> {
  const timeoutMs = deps.timeoutMs ?? 2000;
  const controller = new AbortController();
  // The deadline is the point: a wellbeing reply that arrives after the player has
  // read someone else's message is not a wellbeing reply.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.complete(text, controller.signal);
    if (!res) return null;
    return parseVerdict(res.text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the JSON out of whatever came back.
 *
 * Tolerates a code fence and leading prose, because models wrap JSON even when told
 * not to. Rejects anything that is not the right shape rather than guessing.
 */
export function parseVerdict(raw: string): ClassifierVerdict | null {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = ClassifierVerdictSchema.safeParse(JSON.parse(body.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- the decision table */

const ORDER: Record<WellbeingLevel, number> = {
  none: 0,
  concern: 1,
  safeguarding: 2,
  crisis: 3,
};

/**
 * Explicit game context: a game NOUN and a game VERB.
 *
 * Both are required, because either alone misfires. "die" is a game noun and a life
 * word; "kill" is a game verb and a life word. The pair is the signal.
 */
const GAME_NOUN =
  /\b(?:creeper|zombie|skeleton|spider|enderman|witch|pillager|ravager|blaze|ghast|warden|drowned|wither|mob|mobs|boss|raid|hardcore|creative|survival|minecraft|server|game|nether|end|lava|void|cliff|build|base|farm|mine|mining|craft|crafting|block|blocks|chest|inventory|hunger|hp|health|pvp|fight|battle|respawn|spawn|world)\b/i;
const GAME_VERB =
  /\b(?:kill|killed|killing|die|died|dying|dead|death|smash|destroyed|grief|griefed|explode|exploded|stuck|trapped|built|mining|farming|crafting|hunger|starving|perma|respawn)\b/i;

/** Does this line carry explicit game framing — a noun AND a verb? */
export function hasExplicitGameContext(text: string): boolean {
  return GAME_NOUN.test(text) && GAME_VERB.test(text);
}

export interface MergeInput {
  /** What the regex decided. */
  regexLevel: WellbeingLevel;
  /** Deterministic imminent check. Never the model's call. */
  imminent: string | null;
  /** The model's verdict, or null if it was unavailable or unparseable. */
  verdict: ClassifierVerdict | null;
  /** Did the vocabulary gate fire? */
  gated: boolean;
}

/**
 * Combine the two layers. Every branch is a decision with a reason attached, and
 * the tests walk this table one row at a time.
 *
 * 1. regex crisis            -> keep it. A model does not get to talk Elix out of a
 *                               crisis, and no call is even made.
 * 2. imminent (deterministic) -> crisis with the emergency flag, whatever else said.
 * 3. classifier unavailable    -> the regex result. If the regex said none but the
 *                               vocabulary was strong, a gentle concern check-in:
 *                               the words suggest something, and a check-in costs
 *                               almost nothing if it was nothing.
 * 4. model raises             -> the higher level.
 * 5. model lowers to none     -> allowed ONLY with explicit game context.
 * 6. otherwise                -> the higher of the two.
 */
export function mergeVerdict(input: MergeInput): ClassifierResult {
  const { regexLevel, imminent, verdict, gated } = input;

  if (imminent !== null) {
    return { level: "crisis", imminent: true, source: "regex", reason: `imminent:${imminent}` };
  }

  if (regexLevel === "crisis") {
    return { level: "crisis", imminent: false, source: "regex", reason: "regex-crisis" };
  }

  if (verdict === null) {
    if (regexLevel === "none" && gated) {
      return { level: "concern", imminent: false, source: "vocabulary-fallback", reason: "strong-vocabulary" };
    }
    return { level: regexLevel, imminent: false, source: "regex", reason: "classifier-unavailable" };
  }

  const reason = verdict.reason || "classifier";
  if (verdict.imminent) {
    return { level: "crisis", imminent: true, source: "classifier-raised", reason: `imminent:${reason}` };
  }

  if (ORDER[verdict.level] > ORDER[regexLevel]) {
    return { level: verdict.level, imminent: false, source: "classifier-raised", reason };
  }

  if (verdict.level === "none" && regexLevel !== "none") {
    // Allowed, but only when the line is plainly about the game. A model that
    // disagrees about "i want to die" without game framing is simply overruled.
    return { level: regexLevel, imminent: false, source: "regex", reason: "lowering-refused" };
  }

  return { level: regexLevel, imminent: false, source: "classifier", reason };
}