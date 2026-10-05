/**
 * B: initiative — the decision, and the words.
 *
 * This exists as its own module, separate from `BotSession`, for two reasons.
 *
 * The first is testability. The decision needs a clock, a list of players, positions, an
 * idle budget and three timestamps. Inside `BotSession` that means constructing a fake bot
 * and fake timers to assert a boolean; here it means passing an object literal, and every
 * branch in the table is directly assertable. The Round 8 tests already showed how this
 * goes wrong: `shouldInitiate()` had no caller for three rounds precisely because nothing
 * could exercise it, and reading it afterwards is how the missing idle, proximity and
 * wellbeing-cooldown conditions were found.
 *
 * The second is that the logic is a POLICY, and policy belongs somewhere a reader can
 * check in one sitting. When Elix decides to speak to someone unprompted, this file is the
 * whole answer.
 *
 * The four shapes he can speak in are fixed and named rather than sampled from a template
 * pool. Two self-started things inside `minGapMs` already reads as needy; a bot that also
 * varies its register each time reads as unpredictable, which in a server with children in
 * it is a different problem entirely.
 */
import { shouldInitiate, IDLE_BUDGET_PER_HOUR, type Drive, type InitiativeThresholds } from "../social/manners.js";

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export interface InitiativeContext {
  thresholds: InitiativeThresholds;
  /** Everyone currently online, including Elix. */
  players: Record<string, { position?: Vec } | undefined>;
  selfName: string;
  selfPosition: Vec | undefined;
  now: number;
  /** A reply is in flight, or a SayQueue entry is still typing out. */
  busy: boolean;
  /** Any audit still in flight. Initiative must not overtake a safety decision. */
  pendingAuditNearby: boolean;
  lastInitiativeAt: number;
  /** Last wellbeing reply or check-in, per player. */
  lastWellbeingAt: ReadonlyMap<string, number>;
  lastMemoryCallbackAt: ReadonlyMap<string, number>;
  idleBudgetUsed: number;
  /** Shutting down, or already disconnected. */
  shutdown: boolean;
  /** The memory store, for a callback shape. Optional so a test needs no database. */
  recallImportant?: (player: string, importance: number) => string | null;
}

export type InitiativeShape = "question-about-their-day" | "open-promise" | "memory-callback" | "activity-proposal";

export interface InitiativeDecision {
  speak: boolean;
  /** Which check stopped it, when `speak` is false. The reason is the test. */
  reason:
    | "ok"
    | "disabled"
    | "shutdown"
    | "busy"
    | "nobody-online"
    | "too-far"
    | "audit-pending"
    | "no-budget"
    | "too-soon"
    | "inside-wellbeing-quiet-window"
    | "no-pull"
    | "no-memory";
  target?: string;
  shape?: InitiativeShape;
  line?: string;
  drive?: Drive;
}

/** Straight-line distance, because that is what "within 16 blocks" means to a player. */
export function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The closest player who is not Elix, or null. */
export function nearestPlayer(
  ctx: InitiativeContext,
): { name: string; blocks: number } | null {
  if (!ctx.selfPosition) return null;
  let best: { name: string; blocks: number } | null = null;
  for (const [name, p] of Object.entries(ctx.players)) {
    if (name === ctx.selfName) continue;
    const pos = p?.position;
    if (!pos) continue;
    const blocks = distance(ctx.selfPosition, pos);
    if (!best || blocks < best.blocks) best = { name, blocks };
  }
  return best;
}

/**
 * Every refusal, named.
 *
 * The order is `shouldInitiate`'s order and it is load-bearing: the first match is the
 * reason reported, so a log saying "busy" and a log saying "audit-pending" mean different
 * things operationally, and putting the cheap disqualifiers first keeps the reason stable.
 */
export function decideInitiative(
  ctx: InitiativeContext,
  shape: InitiativeShape,
  drive: Drive,
): InitiativeDecision {
  const t = ctx.thresholds;
  if (t.enabled === false) return { speak: false, reason: "disabled" };
  if (ctx.shutdown) return { speak: false, reason: "shutdown" };

  const nearest = nearestPlayer(ctx);
  if (ctx.busy) return { speak: false, reason: "busy" };
  if (!nearest) return { speak: false, reason: "nobody-online" };
  if (nearest.blocks > t.nearbyBlocks) return { speak: false, reason: "too-far" };
  if (ctx.pendingAuditNearby) return { speak: false, reason: "audit-pending" };

  const budgetRemaining = Math.max(0, IDLE_BUDGET_PER_HOUR - ctx.idleBudgetUsed);
  const lastWellbeing = ctx.lastWellbeingAt.get(nearest.name) ?? null;

  const allowed = shouldInitiate({
    ...t,
    drive,
    pull: INITIATIVE_PULL,
    budgetRemaining,
    now: ctx.now,
    lastInitiativeAt: ctx.lastInitiativeAt,
    busy: false,
    nearestPlayerBlocks: nearest.blocks,
    nearestPlayer: nearest.name,
    lastWellbeingReplyAt: lastWellbeing,
    pendingAuditNearby: false,
  });
  if (!allowed) {
    if (budgetRemaining <= 0) return { speak: false, reason: "no-budget" };
    if (ctx.now - ctx.lastInitiativeAt < t.minGapMs) return { speak: false, reason: "too-soon" };
    if (lastWellbeing !== null && ctx.now - lastWellbeing < t.wellbeingQuietMs) {
      return { speak: false, reason: "inside-wellbeing-quiet-window" };
    }
    return { speak: false, reason: "no-pull" };
  }

  // The memory shape has one extra condition that is not in shouldInitiate, because it is
  // about CONTENT rather than about timing: a callback with nothing to recall would
  // otherwise fall through to a proposal and silently change shape.
  let line: string;
  if (shape === "memory-callback") {
    const memory = ctx.recallImportant?.(nearest.name, t.memoryImportance) ?? null;
    if (!memory) return { speak: false, reason: "no-memory" };
    line = `i remembered something you said before - ${memory}`;
  } else {
    line = INITIATIVE_LINES[shape](nearest.name);
  }

  return { speak: true, reason: "ok", target: nearest.name, shape, line, drive };
}

/**
 * The pull value.
 *
 * A constant rather than anything derived, and the comment matters: there is no model of a
 * drive's strength yet, so a number that looked measured would be a fiction. 0.6 is
 * comfortably over `minPull` (0.25), which is the only thing it has to be.
 */
const INITIATIVE_PULL = 0.6;

/**
 * The four shapes.
 *
 * Short, lowercase, and none of them claims a feeling — C4. An unprompted line that
 * manufactures attachment is worse than one that does it in reply, because nobody asked
 * for that either. And none of them opens with "hey" twice running, which is what makes a
 * round-robin tolerable at all.
 */
export const INITIATIVE_LINES: Readonly<Record<Exclude<InitiativeShape, "memory-callback">, (_target: string) => string>> = {
  "question-about-their-day": (target) => `how is your day going so far, ${target}?`,
  // No name: an open promise is about the thing, not the person, and using the name
  // three lines running starts to sound like a newsletter.
  "open-promise": () =>
    `if you turn up something interesting down there, tell me about it - i like hearing about it.`,
  "activity-proposal": () => `want to look at something together later, or just keep going?`,
};

/** Round-robin over the three non-callback shapes, plus the callback when memory allows. */
export function nextShape(turn: number, hasMemory: boolean): InitiativeShape {
  const order: InitiativeShape[] = hasMemory
    ? ["question-about-their-day", "open-promise", "memory-callback", "activity-proposal"]
    : ["question-about-their-day", "open-promise", "activity-proposal"];
  return order[turn % order.length] as InitiativeShape;
}
