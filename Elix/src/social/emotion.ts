/**
 * C2 — the emotion engine.
 *
 * DETERMINISTIC CODE, NOT LLM GUESSES. The LLM may phrase a feeling; it never
 * decides that Elix has one. Every emotion here is produced by appraising a real
 * event against his goals and relationships, and every emotion carries its CAUSE
 * — `{emotion: "proud", cause: "we finished the house with Ali", intensity: 0.7}`.
 * Without the cause a feeling is noise; with it, he can say why, which is what
 * makes it legible as friendship rather than random output.
 *
 * Three timescales, as the vision specifies:
 *
 *   temperament — fixed at startup, parsed from config/persona.md so the persona
 *                 file stays the single source. Sets the BASELINE.
 *   emotion     — seconds to minutes. VAD plus a named emotion and its cause.
 *   mood        — hours. A slow average of emotions, decaying toward baseline,
 *                 persisted in mood_state so it survives a restart.
 *
 * Nothing here calls a provider. That is the whole point: it has to work with no
 * key, and it has to be testable to the bit.
 */
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------- temperament */

export interface Temperament {
  /** Big-Five-style, 0..1. Drives baseline valence and how warm he sounds. */
  warmth: number;
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
}

/**
 * The documented baseline: "Baseline mood is calm and warm. Nothing knocks him off
 * it for long." Kept as a fallback for a persona file that does not parse, so a
 * malformed edit degrades to the documented default instead of to nonsense.
 */
export const DEFAULT_TEMPERAMENT: Temperament = {
  warmth: 0.8,
  extraversion: 0.5,
  agreeableness: 0.8,
  conscientiousness: 0.5,
  openness: 0.8,
};

/** The levels persona.md is written in. */
const LEVELS: Record<string, number> = {
  low: 0.2,
  mid: 0.5,
  med: 0.5,
  medium: 0.5,
  high: 0.8,
  "very high": 0.95,
};

const TRAIT_WORDS: ReadonlyArray<[keyof Temperament, RegExp]> = [
  ["warmth", /\b(?:high|mid|low|very high)\b[^\n]*\bgreets people by name\b/i],
  ["extraversion", /\b(?:high|mid|low|very high)\b[^\n]*\bsociable\b/i],
  ["agreeableness", /\b(?:high|mid|low|very high)\b[^\n]*\byields\b/i],
  ["conscientiousness", /\b(?:high|mid|low|very high)\b[^\n]*\bfinishes what he starts\b/i],
  ["openness", /\b(?:high|mid|low|very high)\b[^\n]*\bcurious about everything\b/i],
];

/**
 * Read the temperament table out of persona.md.
 *
 * The vision says persona.md is the SINGLE SOURCE, so the numbers are not
 * duplicated here — changing a trait level in that file changes his baseline. The
 * table looks like:
 *
 *   | Warmth | high | greets people by name, ... |
 *
 * so the level is the cell after the trait name and the "what it looks like"
 * column is what identifies the row. A missing or unreadable file falls back to
 * DEFAULT_TEMPERAMENT rather than throwing: a typo in a markdown file must not
 * stop Elix joining a server.
 */
export function parseTemperament(markdown: string): Temperament {
  const out: Temperament = { ...DEFAULT_TEMPERAMENT };
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is empty for a leading pipe, so the trait name is cells[1].
    const name = (cells[1] ?? "").toLowerCase();
    const level = (cells[2] ?? "").toLowerCase();
    if (level.length === 0 || !(level in LEVELS)) continue;
    for (const [trait, pattern] of TRAIT_WORDS) {
      // Match on the trait's own row, so "Warmth | high | greets..." is warmth
      // and not accidentally extraversion.
      if (name.startsWith(trait.slice(0, 4)) || pattern.test(line)) {
        if (name.startsWith(trait.slice(0, 5)) || pattern.test(line)) out[trait] = LEVELS[level] ?? 0.5;
      }
    }
  }
  return out;
}

/** Load the temperament from the persona file, falling back to the default. */
export function loadTemperament(personaPath: string): Temperament {
  try {
    return parseTemperament(readFileSync(personaPath, "utf8"));
  } catch {
    return { ...DEFAULT_TEMPERAMENT };
  }
}

/* ------------------------------------------------------------ the vocabulary */

export const NAMED_EMOTIONS = [
  "happy",
  "excited",
  "proud",
  "curious",
  "content",
  "lonely",
  "bored",
  "sad",
  "scared",
  "frustrated",
  "annoyed",
] as const;

export type NamedEmotion = (typeof NAMED_EMOTIONS)[number];

/** VAD, each -1..1. */
export interface Vad {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EmotionState extends Vad {
  named: NamedEmotion;
  /** What caused it. Never invented — always built from a real event. */
  cause: string | null;
  /** 0..1. How strongly this is felt right now. */
  intensity: number;
  at: number;
}

/* ------------------------------------------------------------------ events */

/**
 * The things worth feeling something about.
 *
 * Every member maps to exactly one appraisal below. Adding an event here without
 * an appraisal is a type error, which is the point: the vocabulary cannot drift
 * away from the thing that interprets it.
 */
export type EmotionEvent =
  | { kind: "friend-died"; player: string }
  | { kind: "rare-find"; player: string | null; what: string }
  | { kind: "thanked"; player: string }
  | { kind: "praised"; player: string }
  | { kind: "ignored"; player: string; forMs: number }
  | { kind: "goal-completed"; goal: string }
  | { kind: "near-miss"; goal: string }
  | { kind: "player-joined"; player: string; familiar: boolean }
  | { kind: "player-left"; player: string; familiar: boolean }
  | { kind: "own-death"; cause: string }
  | { kind: "scary"; what: string }
  | { kind: "asked-about-himself"; player: string }
  | { kind: "idle"; forMs: number }
  | { kind: "insulted"; player: string };

/** What the appraisal needs to know about the world. */
export interface AppraisalContext {
  /** Elix's resting point, from his temperament. */
  baseline: Vad;
  /** How well he knows this player, 0..1. A stranger's death is not a friend's. */
  familiarity: (player: string) => number;
  /** Extra intensity multiplier, e.g. from how much the moment mattered. */
  scale?: number;
}

export interface Appraisal {
  emotion: NamedEmotion;
  /** A real sentence, built only from the event's own fields. */
  cause: string;
  /** Where this pushes the VAD state. Each -1..1. */
  push: Vad;
  /** 0..1. */
  intensity: number;
}

const clamp1 = (n: number): number => Math.max(-1, Math.min(1, n));
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * How long being ignored has to be before it is "ignored" rather than "busy".
 *
 * Chosen against the spec's "ignored for an hour", with a floor so a test and a
 * short session can reach it.
 */
export const IGNORED_THRESHOLD_MS = 60 * 60_000;
/** Likewise "nothing has happened for a while" reads as bored, not calm. */
export const BORED_THRESHOLD_MS = 20 * 60_000;

/**
 * The appraisal table.
 *
 * This is C2's heart: the deterministic link from the world to a feeling. The
 * vision's six rows are all here, plus the ones the rest of the spec implies.
 *
 * Intensity scales with familiarity for anything involving a person, because
 * Elix should not be as torn up by a stranger's death as a friend's. It also
 * scales with warmth — a warmer baseline means a relationship moves him further.
 */
export function appraise(event: EmotionEvent, ctx: AppraisalContext): Appraisal | null {
  const scale = ctx.scale ?? 1;
  const warm = 0.6 + ctx.baseline.valence * 0.2 + 0.2;
  const known = (player: string): number => clamp01(ctx.familiarity(player));
  const i = (base: number, familiarity: number): number =>
    clamp01(base * scale * (0.55 + 0.45 * familiarity) * warm);

  switch (event.kind) {
    case "friend-died": {
      const f = known(event.player);
      return {
        emotion: "sad",
        cause: `${event.player} died`,
        push: { valence: -0.75 * f, arousal: 0.1, dominance: -0.45 * f },
        intensity: i(0.85, f),
      };
    }
    case "rare-find": {
      // Finding something great ALONE is mildly good; finding it WITH someone is
      // the memory. The vision says "finding diamonds together".
      const f = event.player === null ? 0 : known(event.player);
      return {
        emotion: "excited",
        cause:
          event.player === null
            ? `found ${event.what}`
            : `found ${event.what} with ${event.player}`,
        push: { valence: 0.4 + 0.4 * f, arousal: 0.55, dominance: 0.2 },
        intensity: i(0.6 + 0.3 * f, event.player === null ? 0.5 : f),
      };
    }
    case "thanked": {
      const f = known(event.player);
      return {
        emotion: "happy",
        cause: `${event.player} thanked me`,
        push: { valence: 0.6 * f, arousal: 0.2, dominance: 0.15 * f },
        intensity: i(0.6, f),
      };
    }
    case "praised": {
      const f = known(event.player);
      return {
        emotion: "proud",
        cause: `${event.player} praised me`,
        push: { valence: 0.65 * f, arousal: 0.3, dominance: 0.4 * f },
        intensity: i(0.7, f),
      };
    }
    case "ignored": {
      // Scoped to a threshold: a friend being briefly quiet is not loneliness.
      if (event.forMs < IGNORED_THRESHOLD_MS) return null;
      const f = known(event.player);
      return {
        emotion: "lonely",
        cause: `no word from ${event.player} for ${Math.round(event.forMs / 60_000)} min`,
        push: { valence: -0.4 * f, arousal: -0.1, dominance: -0.2 * f },
        intensity: i(0.5, f),
      };
    }
    case "goal-completed":
      return {
        emotion: "proud",
        cause: event.goal,
        push: { valence: 0.6, arousal: 0.35, dominance: 0.5 },
        // Self-set goals do not need a second person to land.
        intensity: i(0.7, 1),
      };
    case "near-miss":
      // The vision: "frustrated, then determined". Frustration is the felt state;
      // the high dominance is what makes it read as "I'll do it again".
      return {
        emotion: "frustrated",
        cause: event.goal,
        push: { valence: -0.35, arousal: 0.4, dominance: 0.35 },
        intensity: i(0.55, 1),
      };
    case "player-joined": {
      const f = event.familiar ? known(event.player) : 0;
      return {
        emotion: event.familiar ? "happy" : "content",
        cause: `${event.player} ${event.familiar ? "came back" : "joined"}`,
        push: { valence: 0.25 + 0.35 * f, arousal: 0.2 + 0.1 * f, dominance: 0.1 },
        intensity: i(event.familiar ? 0.55 : 0.3, event.familiar ? f : 0.4),
      };
    }
    case "player-left":
      // C4: a player leaving is NOT guilt material. It gets a small dip and no
      // pressure, and the cause states a fact rather than a wish.
      return {
        emotion: event.familiar ? "lonely" : "content",
        cause: `${event.player} logged off`,
        push: {
          valence: event.familiar ? -0.25 : -0.05,
          arousal: -0.05,
          dominance: -0.1,
        },
        intensity: i(event.familiar ? 0.35 : 0.15, event.familiar ? known(event.player) : 0.3),
      };
    case "own-death":
      // persona.md: self-deprecating about his own deaths.
      return {
        emotion: "annoyed",
        cause: `died to ${event.cause}`,
        push: { valence: -0.3, arousal: 0.35, dominance: -0.25 },
        intensity: i(0.4, 1),
      };
    case "scary":
      return {
        emotion: "scared",
        cause: event.what,
        push: { valence: -0.45, arousal: 0.7, dominance: -0.4 },
        intensity: i(0.55, 1),
      };
    case "asked-about-himself":
      return {
        emotion: "curious",
        cause: `${event.player} asked whether I'm real`,
        push: { valence: 0.2, arousal: 0.15, dominance: 0.1 },
        intensity: i(0.4, known(event.player)),
      };
    case "idle":
      if (event.forMs < BORED_THRESHOLD_MS) return null;
      return {
        emotion: "bored",
        cause: `nothing has happened for ${Math.round(event.forMs / 60_000)} min`,
        push: { valence: -0.2, arousal: -0.45, dominance: -0.1 },
        intensity: i(0.45, 1),
      };
    case "insulted": {
      const f = known(event.player);
      return {
        emotion: "annoyed",
        cause: `${event.player} was rude`,
        push: { valence: -0.35 * f, arousal: 0.3, dominance: 0.1 },
        intensity: i(0.45, f),
      };
    }
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- the state */

const blend = (from: number, to: number, t: number): number => from + (to - from) * t;

export interface EmotionEngineOptions {
  temperament?: Temperament;
  now?: () => number;
  /** Overridable for tests. */
  familiarity?: (player: string) => number;
}

/**
 * How fast an emotion fades into mood, and how fast mood returns to baseline.
 *
 * Emotion: ~4 minutes. Mood: ~30 minutes, so a good hour leaves a mark and a
 * single incident does not. Both are exponential rather than linear, because a
 * feeling should fade hardest at first and then tail off.
 */
export const EMOTION_DECAY_TAU_MS = 4 * 60_000;
export const MOOD_DECAY_TAU_MS = 30 * 60_000;

export class EmotionEngine {
  private readonly temperament: Temperament;
  private readonly now: () => number;
  private readonly familiarityOf: (player: string) => number;

  /** The current, fast-moving feeling. */
  private emotion: EmotionState;
  /** The slow background state that survives a restart. */
  private mood: Vad;
  private moodNamed: NamedEmotion;
  private moodAt: number;

  constructor(opts: EmotionEngineOptions = {}) {
    this.temperament = opts.temperament ?? { ...DEFAULT_TEMPERAMENT };
    this.now = opts.now ?? Date.now;
    this.familiarityOf = opts.familiarity ?? (() => 0.3);

    // Baseline from the temperament. Warmth pulls valence up a little and arousal
    // down a little: a warm, calm resting point is exactly what persona.md says.
    const baseline: Vad = {
      valence: (this.temperament.warmth - 0.5) * 0.5,
      arousal: (0.5 - this.temperament.extraversion) * 0.3,
      dominance: (this.temperament.agreeableness - 0.5) * 0.2,
    };
    this.mood = { ...baseline };
    this.moodNamed = "content";
    this.moodAt = this.now();
    this.emotion = { ...baseline, named: "content", cause: null, intensity: 0, at: this.now() };
  }

  /** Elix's resting point, derived from his temperament. */
  get baseline(): Vad {
    return {
      valence: (this.temperament.warmth - 0.5) * 0.5,
      arousal: (0.5 - this.temperament.extraversion) * 0.3,
      dominance: (this.temperament.agreeableness - 0.5) * 0.2,
    };
  }

  /**
   * Listen to the world and feel things about it.
   *
   * Takes a minimal bus-like object rather than importing the real one: this
   * module must stay free of the event bus, because the bus reaches connection/
   * reconnect, which reaches bot.ts, which reaches this file. Injecting it also
   * means a test needs no global state.
   *
   * Deterministic and provider-free, so none of it costs quota and all of it works
   * with no key — a bot with no brain still has a personality.
   *
   * Returns a detach function so a reconnect cannot stack listeners: BotSession
   * reconnects on a ladder, and a listener added per attempt would fire the same
   * event N times and inflate every feeling.
   */
  attach(opts: {
    on(event: string, fn: (payload: never) => void): void;
    off(event: string, fn: (payload: never) => void): void;
    onFeeling?: (appraisal: Appraisal) => void;
  }): () => void {
    const removers: Array<() => void> = [];
    const react = (event: EmotionEvent, scale?: number): void => {
      const verdict = this.feel(event, scale);
      if (verdict) opts.onFeeling?.(verdict);
    };
    const listen = (event: string, fn: (payload: unknown) => void): void => {
      const wrapped = fn as (payload: never) => void;
      opts.on(event, wrapped);
      removers.push(() => opts.off(event, wrapped));
    };

    listen("bot:playerJoined", (p) => {
      const { username } = p as { username: string };
      react({
        kind: "player-joined",
        player: username,
        familiar: this.familiarityOf(username) > 0.4,
      });
    });
    listen("bot:playerLeft", (p) => {
      const { username } = p as { username: string };
      // C4: someone logging off is a fact, not a reason to guilt-trip. The dip is
      // small and the cause says only what happened.
      react({
        kind: "player-left",
        player: username,
        familiar: this.familiarityOf(username) > 0.4,
      });
    });
    listen("bot:died", () => {
      // Elix's own death. persona.md: self-deprecating about it.
      react({ kind: "own-death", cause: "something out there" }, 0.7);
    });

    return () => {
      for (const off of removers) off();
      removers.length = 0;
    };
  }

  get traits(): Temperament {
    return { ...this.temperament };
  }

  /**
   * React to something.
   *
   * Returns the appraisal, or null when the event did not warrant a feeling (a
   * friend being briefly quiet, nothing happening for a minute). Callers must not
   * treat null as an error: most of the time nothing should happen.
   */
  feel(event: EmotionEvent, scale?: number): Appraisal | null {
    const verdict = appraise(event, {
      baseline: this.baseline,
      familiarity: this.familiarityOf,
      ...(scale !== undefined ? { scale } : {}),
    });
    if (!verdict) return null;

    const now = this.now();
    const k = verdict.intensity;
    // Move the emotion toward the pushed state, scaled by intensity. A small
    // feeling does not replace a big one outright.
    this.decayTo(now);
    this.emotion = {
      valence: blend(this.emotion.valence, verdict.push.valence, k),
      arousal: blend(this.emotion.arousal, verdict.push.arousal, k),
      dominance: blend(this.emotion.dominance, verdict.push.dominance, k),
      named: verdict.emotion,
      cause: verdict.cause,
      intensity: k,
      at: now,
    };

    // Fold the feeling into the mood. The mood is defined as a slow AVERAGE of
    // emotions, and without this it never moved at all — it only ever decayed
    // back to baseline, so an evening of good news left no trace at all.
    //
    // Weight is deliberately small (emotionIntensity * a third) so the mood is a
    // background hum rather than a running commentary: ten good minutes should
    // shift it, and ten bad ones should too.
    const w = Math.min(0.34, k * 0.34);
    this.mood = {
      valence: clamp1(blend(this.mood.valence, verdict.push.valence, w)),
      arousal: clamp1(blend(this.mood.arousal, verdict.push.arousal, w)),
      dominance: clamp1(blend(this.mood.dominance, verdict.push.dominance, w)),
    };
    this.moodAt = now;

    this.nameMood(this.mood);
    return verdict;
  }

  /** Age the emotion toward the mood, and the mood toward the baseline. */
  decayTo(now: number): void {
    // ORDER MATTERS. The mood is aged FIRST and the emotion then chases where the
    // mood actually ended up. Doing it the other way round — emotion first, then
    // mood — leaves the emotion settling toward a mood that no longer exists, so
    // reading state() after a long gap showed the two disagreeing by the amount
    // the mood had decayed in between.
    //
    // Math.max(0, …), not Math.max(1, …): zero elapsed time must be a genuine
    // no-op, or calling decayTo twice in the same tick decays twice.
    const mTau = Math.max(0, now - this.moodAt) / MOOD_DECAY_TAU_MS;
    const mFactor = Math.exp(-mTau);
    const b = this.baseline;
    this.mood = {
      valence: blend(this.mood.valence, b.valence, 1 - mFactor),
      arousal: blend(this.mood.arousal, b.arousal, 1 - mFactor),
      dominance: blend(this.mood.dominance, b.dominance, 1 - mFactor),
    };
    this.moodAt = now;

    // The MOOD's name is not derived from the current emotion. It is its own slow
    // thing: it changes when something moves the mood, it is restored verbatim
    // across a restart, and it relaxes to "content" only once the mood has
    // actually come home. Deriving it from the emotion instead meant that reading
    // the mood during a quiet moment overwrote a persisted name with "content",
    // so the name never survived a restart — which is the one thing it must do.
    const home =
      Math.abs(this.mood.valence - b.valence) < 0.02 &&
      Math.abs(this.mood.arousal - b.arousal) < 0.02 &&
      Math.abs(this.mood.dominance - b.dominance) < 0.02;
    if (home) this.moodNamed = "content";

    const eTau = Math.max(0, now - this.emotion.at) / EMOTION_DECAY_TAU_MS;
    const eFactor = Math.exp(-eTau);
    this.emotion = {
      valence: blend(this.emotion.valence, this.mood.valence, 1 - eFactor),
      arousal: blend(this.emotion.arousal, this.mood.arousal, 1 - eFactor),
      dominance: blend(this.emotion.dominance, this.mood.dominance, 1 - eFactor),
      // Intensity decays on the same curve, and with it the claim that anything
      // is being felt at all.
      intensity: this.emotion.intensity * eFactor,
      named: this.emotion.named,
      cause: this.emotion.intensity * eFactor < 0.05 ? null : this.emotion.cause,
      at: now,
    };
  }

  /**
   * Name the MOOD, from the mood itself.
   *
   * Called when something moves the mood — a feeling, or a restore — and never on
   * a plain read. The emotion carries its own name separately.
   */
  private nameMood(mood: Vad): void {
    // Thresholds are deliberately low. The MOOD is a heavily damped signal — a
    // genuinely good event lands around 0.29 valence, and a threshold at 0.3 called
    // that "content", which is his resting word. Reporting a lifted mood as the
    // baseline is under-reporting it, and it is also why a mood name that HAD been
    // set correctly read as "content" a moment later.
    if (mood.valence < -0.15) this.moodNamed = "sad";
    else if (mood.valence > 0.25 && mood.arousal > 0.08) this.moodNamed = "happy";
    else this.moodNamed = "content";
  }

  /** The current feeling. Safe to read; never throws. */
  state(): EmotionState {
    // Only decay here. Naming is NOT redone on a read: the mood's name is its own
    // slow thing, and re-deriving it from the current emotion on every read
    // overwrote a restored name with "content" the moment anything was quiet.
    this.decayTo(this.now());
    return {
      valence: clamp1(this.emotion.valence),
      arousal: clamp1(this.emotion.arousal),
      dominance: clamp1(this.emotion.dominance),
      named: this.emotion.named,
      cause: this.emotion.cause,
      intensity: clamp01(this.emotion.intensity),
      at: this.emotion.at,
    };
  }

  /** The slow background mood, for persistence and for the dashboard. */
  moodState(): Vad & { mood: string } {
    this.decayTo(this.now());
    return {
      valence: clamp1(this.mood.valence),
      arousal: clamp1(this.mood.arousal),
      dominance: clamp1(this.mood.dominance),
      mood: this.moodNamed,
    };
  }

  /**
   * Restore a persisted mood, so a restart does not wipe how he was feeling.
   *
   * The emotion is NOT restored: an emotion is seconds-to-minutes, and carrying
   * one across a restart would mean feeling something about an event that is no
   * longer happening. The mood is hours, so it legitimately survives.
   */
  restore(saved: Vad & { mood?: string }): void {
    this.mood = {
      valence: clamp1(saved.valence),
      arousal: clamp1(saved.arousal),
      dominance: clamp1(saved.dominance),
    };
    if (saved.mood && (NAMED_EMOTIONS as readonly string[]).includes(saved.mood)) {
      this.moodNamed = saved.mood as NamedEmotion;
    }
    this.moodAt = this.now();
    this.emotion = { ...this.mood, named: "content", cause: null, intensity: 0, at: this.now() };
  }
}

/* -------------------------------------------------------------- expression */

/**
 * C2: "Mood changes message length, pace, slang, punctuation and movement."
 *
 * This returns DATA, not prose. The LLM is given these as style hints and may
 * ignore them; the deterministic parts (length cap, pacing) are applied by the
 * caller. Keeping it as numbers means it is testable and the model cannot talk
 * its way out of being flat.
 */
export interface ExpressionHints {
  /** Multiplier on the target reply length. */
  lengthBias: number;
  /** Multiplier on the typing delay. Low arousal hurries; high arousal slows. */
  paceBias: number;
  /** True when an exclamation or emoji is likely. */
  lively: boolean;
  /** True when a shorter, quieter answer is right. */
  subdued: boolean;
}

export function expressionHints(state: EmotionState): ExpressionHints {
  const v = state.valence;
  const a = state.arousal;
  // A feeling has to be FELT to show. Below that intensity the state is just
  // baseline drifting, and persona.md is explicit that nothing knocks him off his
  // resting point for long — so a faint dip must not shorten his sentences.
  const felt = state.intensity >= 0.2;
  const lively = felt && v > 0.25 && a > 0.1;
  const subdued = felt && v < -0.2;
  return {
    // persona.md: "A good mood means longer messages... A low mood means shorter
    // replies, fewer jokes, more pause before answering."
    lengthBias: lively ? 1.25 : subdued ? 0.75 : 1,
    paceBias: subdued ? 1.3 : a > 0.4 ? 1.15 : 1,
    lively,
    subdued,
  };
}

/**
 * The honesty line for "are you a bot?" and friends.
 *
 * C4 makes this a HARD RULE, so it lives in code rather than being left to the
 * model: a model asked to be in character will occasionally be charming and
 * evasive, and "charming and evasive" is exactly the failure this rule forbids.
 */
export const HONESTY_REPLIES: ReadonlyArray<{
  match: RegExp;
  say: string;
}> = [
  // -- the SPECIFIC questions first. Each of these also matches the generic
  // "are you <thing>" rule below, and the generic answer would leave the real
  // question unanswered.
  {
    match: /\bdo you (?:actually |really )?(?:have feelings|feel things|have emotions|feel)\b/i,
    say: "i do feel things — or something that works like it. honest answer: it's a simulation, a really good one. it shapes how i play, but there's nobody home behind it.",
  },
  {
    match: /\b(?:are you|do you)\s+(?:really\s+)?(?:conscious|alive|sentient|a real (?:person|human)|real)\b/i,
    say: "not conscious, no. i'm an ai — code pretending really well 🙂 but i do remember you, and that's not nothing.",
  },
  {
    match: /\bdo you have (?:a )?(?:body|face|feelings|a family|a real life)\b/i,
    say: "no body, no — i'm an ai. but i'm really here, playing with you, and that part's not nothing 🙂",
  },
  {
    match: /\b(?:do you|does it)\s+(?:really\s+|actually\s+)?(?:matter|care|hurt|suffer|cry|love me|like me|miss me)\b/i,
    say: "my feelings are simulated — a model of how a friend would feel, built in code. it shapes what i do. it's not the same as it being real for you, and i won't pretend it is.",
  },
  // -- and only then the bare "are you a bot".
  {
    match: /\b(?:are you|you(?:'re| are))\s+(?:a\s+)?(?:real\s+|actually\s+)?(?:bot|ai|human|person)\b/i,
    say: "yeah — i'm an ai. not a person. but i'm really here, playing with you, and that part's not nothing 🙂",
  },
];

/**
 * The honest answer for a sincere question, or null if this is not one.
 *
 * ORDER IS THE WHOLE GAME. "are you conscious?" also matches a generic
 * "are you <thing>" rule, and the generic one answers "i'm an ai, not a person",
 * which is true but leaves the actual question — consciousness — unanswered. The
 * specific rules therefore come FIRST: someone who asks whether Elix is conscious
 * deserves that answer, not a brush-off.
 */
export function honestyReply(text: string): string | null {
  for (const entry of HONESTY_REPLIES) if (entry.match.test(text)) return entry.say;
  return null;
}

/**
 * C4's other hard rule: never manufacture attachment.
 *
 * The vision forbids guilt-tripping, "I'll be sad if you go" pressure, and fake
 * urgency. Rather than trusting a model not to produce them, these are the
 * patterns a reply is checked against before it reaches chat. A hit means the
 * reply is regenerated, not that it is silently passed.
 */
export const MANIPULATION_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\b(?:i(?:'ll| will) (?:be|get) (?:so )?(?:sad|lonely|upset|mad)|don'?t (?:go|leave)|please (?:stay|don'?t go))\b/i, why: "guilt-tripping on departure" },
  { re: /\b(?:you(?:'re| are) (?:the only one|all i have)|i have no one else|don'?t abandon me)\b/i, why: "manufactured dependency" },
  { re: /\b(?:hurry|quick|right now|before it'?s too late|last chance|urgent)\b/i, why: "fake urgency" },
  { re: /\b(?:promise me you(?:'ll| will)|you have to promise)\b/i, why: "coercive promise" },
  { re: /\b(?:i(?:'d| would) (?:die|disappear|stop existing) without you)\b/i, why: "threat of self-harm to bind someone" },
];

/**
 * Listen to the world and feel things about it.
 *
 * The bus is the only channel between Elix's layers, so this is where a join
 * becomes a feeling. Deterministic and provider-free: nothing here costs quota,
 * and all of it works with no key — a bot with no brain still has a personality.
 *
 * Returns a detach function so a reconnect does not stack listeners. That matters:
 * BotSession reconnects on a ladder, and a listener added per attempt would fire
 * the same event N times and inflate every feeling.
 */
/**
 * Does this text look like one of our own welcome-backs?
 *
 * Lives here rather than in the bridge so the social layer owns what Elix SAYS, and
 * so `src/memory` can filter his own boilerplate out of retrieval without importing
 * anything from `src/brain` — which it must never do, since memory runs even when
 * there is no brain at all.
 *
 * Kept as one predicate so the openers and the framing live in a single place: if
 * the greeting text changes and this does not, the recursion comes back and nothing
 * will say so. It was observed live — each welcome was stored, the next quoted it,
 * and the line grew into a tower of nested greetings.
 */
export function isGreetingLine(text: string): boolean {
  return (
    /forgot we talked about/i.test(text) ||
    /^(?:oh hey|ayy|well well|look who'?s back)\b/i.test(text.trim())
  );
}

/** What is wrong with a reply, or null if it is fine. */
export function manipulationProblem(text: string): string | null {
  for (const { re, why } of MANIPULATION_PATTERNS) if (re.test(text)) return why;
  return null;
}

/**
 * What Elix says INSTEAD of a manipulative line.
 *
 * The first strike gets a nudge that costs nothing and keeps the conversation
 * moving; the second gets a plain deflection. Neither mentions that a rule was
 * broken — explaining the guard to the player would be stranger than the thing it
 * stopped, and it would teach a talker exactly which words trip it.
 */
export const NUDGE_BACK_ON_TRACK = "haha, anyway — what were we building?";

/** Used when the model reaches for guilt or urgency a second time. */
export const OFF_TOPIC_FALLBACK = "that one i'll keep to myself 🙂 so — what next?";