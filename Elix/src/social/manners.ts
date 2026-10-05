/**
 * C3 — multiplayer manners, initiative, and when Elix speaks unprompted.
 *
 * Three questions this file answers, all deterministically:
 *
 *   1. SHOULD I SPEAK?   A companion that talks over people is worse than one that
 *                        is quiet. Vision rule 8: reply when addressed, or when it
 *                        is naturally his place to.
 *   2. MAY I START SOMETHING?  C3: "he does not wait to be told what to do", but
 *                        only within the idle budget, and never to fill silence
 *                        that is not his to fill.
 *   3. IS THIS ALLOWED TO LEAVE MY MOUTH?  C4's manipulation rules, re-checked
 *                        here where the decision is made.
 *
 * No provider calls. Every gate is a pure function of local state.
 */

/** Why Elix spoke, or stayed quiet. Used by tests and by the dashboard. */
export type SpeechDecision =
  | { speak: true; reason: "addressed" | "question-to-him" | "ambient-allowed"; chance: number }
  | { speak: false; reason: "not-addressed" | "too-recent" | "budget-spent" | "group-too-busy" | "low-chance" };

export interface MannersOptions {
  /** Elix's own name, so "elix ..." counts as addressed. */
  username: string;
  /** Extraversion, 0..1. Mid in persona.md: sociable but not loud. */
  extraversion: number;
  /** Idle chatter still allowed this hour. The budget is the hard ceiling. */
  budgetRemaining: number;
  /** When he last said anything unprompted. */
  lastSpokeAt: number;
  now: number;
  /** How many players are in the world, including Elix. */
  playersOnline: number;
  /** Overridable for tests. */
  random?: () => number;
}

/**
 * Vision rule 9: idle chatter is capped per hour, so the budget is checked before
 * anything else. A cap that can be exceeded by being helpful is not a cap.
 */
export const IDLE_BUDGET_PER_HOUR = 60;

/**
 * Never say two unprompted things inside this window.
 *
 * Deliberately larger than the chat rate limit (2 s): the rate limit exists to
 * protect the server, this one exists so Elix does not monologue.
 */
export const AMBIENT_MIN_GAP_MS = 4 * 60_000;

/**
 * In a busy room, be quieter.
 *
 * Extraversion is already the main dial, but a crowd is its own thing: three
 * people talking means Elix is a third party, and third parties butt in less.
 */
export function ambientChance(opts: MannersOptions): number {
  const base = 0.12 + opts.extraversion * 0.18; // mid extraversion -> ~0.21
  // Halve it for each person beyond Elix and one other, down to a quarter.
  const crowd = Math.max(1, opts.playersOnline - 2);
  return Math.max(0.02, base / crowd);
}

/**
 * Should Elix say something in response to this line?
 *
 * `addressed` is the caller's own detection (isAddressedToElix) — this function
 * does the manners on top of it, so the rules live in one place.
 */
export function shouldSpeak(
  message: string,
  opts: MannersOptions,
  addressed: boolean,
): SpeechDecision {
  const rand = opts.random ?? Math.random;

  if (addressed) {
    // Budget only caps IDLE chatter. Being spoken to directly always gets an
    // answer — refusing to answer someone who said your name is worse than
    // spending a call.
    return { speak: true, reason: "addressed", chance: 1 };
  }

  // A question aimed at nobody in particular can still be his to answer, but only
  // when he is not mid-conversation and there is room.
  const isQuestion = /\?\s*$/.test(message.trim());
  if (isQuestion && opts.budgetRemaining > 0 && opts.now - opts.lastSpokeAt > 30_000) {
    const chance = ambientChance(opts);
    if (rand() < chance) return { speak: true, reason: "question-to-him", chance };
  }

  if (opts.budgetRemaining <= 0) return { speak: false, reason: "budget-spent" };
  if (opts.playersOnline >= 6) return { speak: false, reason: "group-too-busy" };
  if (opts.now - opts.lastSpokeAt < AMBIENT_MIN_GAP_MS) return { speak: false, reason: "too-recent" };

  const chance = ambientChance(opts);
  if (rand() >= chance) return { speak: false, reason: "low-chance" };
  return { speak: true, reason: "ambient-allowed", chance };
}

/* ----------------------------------------------------------------- drives */

export type Drive = "connection" | "curiosity" | "competence" | "safety" | "rest";

/**
 * C3: "connection, curiosity, competence, safety, rest — these generate his own
 * goals when he's idle."
 *
 * Ordered by how naturally they arise. Connection first because a companion who
 * ignores the person who is there is not a companion; rest last because it is the
 * background condition, not an impulse.
 */
export const DRIVES: readonly Drive[] = [
  "connection",
  "curiosity",
  "competence",
  "safety",
  "rest",
];

/**
 * B: every threshold the initiative logic measures, in one place.
 *
 * A structural copy of the `initiative` config section rather than an import of it, so
 * this module stays free of config loading (and therefore usable from a bare unit test
 * with no schema and no files). `initiativeDefaultsFrom` exists so the caller can prove
 * the two agree instead of assuming it.
 */
export interface InitiativeThresholds {
  idlePollMs: number;
  nearbyBlocks: number;
  wellbeingQuietMs: number;
  minGapMs: number;
  minPull: number;
  memoryImportance: number;
  memoryGapMs: number;
  enabled: boolean;
}

/** The shipped defaults. Kept in step with `initiativeSchema` by a test. */
export const DEFAULT_INITIATIVE: InitiativeThresholds = {
  idlePollMs: 5_000,
  nearbyBlocks: 16,
  wellbeingQuietMs: 20 * 60_000,
  minGapMs: 8 * 60_000,
  minPull: 0.25,
  memoryImportance: 5,
  memoryGapMs: 20 * 60_000,
  enabled: true,
};

export interface InitiativeOptions extends InitiativeThresholds {
  drive: Drive;
  /** 0..1. How strongly the drive is currently pulling. */
  pull: number;
  budgetRemaining: number;
  now: number;
  lastInitiativeAt: number;

  /**
   * Is Elix busy? A running skill or a reply in flight.
   *
   * Checked before everything else, because "he doesn't wait to be told" also has to mean
   * "he doesn't talk over himself".
   */
  busy: boolean;
  /** Distance to the nearest player, or null when nobody is online. */
  nearestPlayerBlocks: number | null;
  /** When this player last got a wellbeing reply or a check-in, or null. */
  lastWellbeingReplyAt: number | null;
  /** Which player the nearest one is, so the wellbeing window can be per player. */
  nearestPlayer: string | null;
  /** Is any audit for a nearby player still in flight? */
  pendingAuditNearby: boolean;
}

/** Two self-started things inside this window reads as needy, not autonomous. */
export const INITIATIVE_MIN_GAP_MS = DEFAULT_INITIATIVE.minGapMs;

/**
 * May Elix start something on his own?
 *
 * The idle budget is a ceiling, not the whole decision, and three conditions were missing
 * until Round 13 because the only caller never existed to expose them:
 *
 *  - IDLE. Without it, initiative fires on top of a reply he is already writing.
 *  - SOMEONE NEARBY. He speaks to people, not to an empty server.
 *  - NO RECENT WELLBEING CONTACT with that person. After a check-in, the kind thing is
 *    silence; twenty seconds later is pressure, and after a crisis it is worse.
 *  - NO AUDIT IN FLIGHT for a nearby player. If a safety check is mid-decision, an
 *    unprompted line can overtake it — which is precisely the ordering bug Round 13 spent
 *    a round on, one layer down.
 *
 * The order is cheapest-and-most-disqualifying first, and every check is a plain
 * comparison so the whole decision is testable without a clock, a bot or a database.
 */
export function shouldInitiate(opts: InitiativeOptions): boolean {
  if (!opts.enabled) return false;
  if (opts.busy) return false;
  if (opts.nearestPlayerBlocks === null) return false;
  if (opts.nearestPlayerBlocks > opts.nearbyBlocks) return false;
  if (opts.pendingAuditNearby) return false;
  if (opts.budgetRemaining <= 0) return false;
  if (opts.now - opts.lastInitiativeAt < opts.minGapMs) return false;
  if (
    opts.lastWellbeingReplyAt !== null &&
    opts.now - opts.lastWellbeingReplyAt < opts.wellbeingQuietMs
  ) {
    return false;
  }
  // Pull has to actually be pulling. A drive at 0.1 is not a reason to speak.
  return opts.pull > opts.minPull;
}

/**
 * What a drive produces, as a short goal phrase.
 *
 * These are GOALS, not lines. He acts on them (or an LLM turns them into
 * something to say), and they never contain a claim about his own feelings — C4.
 */
export const DRIVE_GOALS: Readonly<Record<Drive, readonly string[]>> = {
  connection: ["ask how their day was", "check in on someone who went quiet"],
  curiosity: ["go look at that noise", "find out what biome that is"],
  competence: ["finish the thing he started", "sort the chests"],
  safety: ["get some daylight", "put a torch down before it gets dark"],
  rest: ["sit somewhere for a bit", "stop rushing around"],
};

/** Pick a goal for a drive. Deterministic given the index, so tests can assert. */
export function goalFor(drive: Drive, index: number): string {
  const list = DRIVE_GOALS[drive];
  return list[index % list.length] ?? list[0] ?? "";
}

/* ------------------------------------------------------------- wellbeing */

/**
 * C4: "encourages real-life friends and breaks. Kid-safe by default."
 *
 * Detected from what a player said, and handed to the model as a HINT rather than
 * a script — the wording should still sound like Elix. Only the decision to
 * encourage is deterministic.
 */
export interface WellbeingHint {
  encourageBreaks: boolean;
  kidSafe: boolean;
}

const TIRED_WORDS =
  /\b(?:tired|exhausted|sleepy|been up (?:all night|late)|need a break|going to bed|goodnight|good night|can't focus|stressed|burnt out)\b/i;
const LATE_NIGHT_WORDS = /\b(?:cant sleep|can't sleep|up at \d|3 ?am|4 ?am|5 ?am|insomnia)\b/i;

export function wellbeingHint(text: string, contentLevel: string): WellbeingHint {
  const tired = TIRED_WORDS.test(text);
  const late = LATE_NIGHT_WORDS.test(text);
  return {
    // Only nudge a break when they have actually signalled one, or when it is
    // implausibly late and they are still here. Encouraging breaks unprompted,
    // repeatedly, is nagging.
    encourageBreaks: tired || late,
    kidSafe: contentLevel === "kid-safe",
  };
}