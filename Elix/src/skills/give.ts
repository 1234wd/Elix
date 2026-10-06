/**
 * WP5c — give, and put things away.
 *
 * Two small skills with one hard rule between them:
 *
 *   GIVE    "elix give me cobblestone" - walk to the owner who asked and toss it to THEM.
 *           Only to the person who asked. Never to a bystander, never broadcast.
 *   DEPOSIT "elix put your stuff in the chest" - into the nearest chest within 16 blocks.
 *
 * And one absolute prohibition: Elix NEVER WITHDRAWS. Taking a thing out of a chest is how a
 * companion bot eats somebody's meal and laughs about it later. `ALLOWED_CHEST_ACTION` has
 * exactly one value, and `parseChestAction` has no code path that can produce anything else.
 *
 * Everything here is owner-only, addressed, whole-intent, cancellable inside one tick, and
 * refuses to run on a wellbeing-floor line - the caller checks that, and `GIVE_REFUSALS`
 * records what the answers are.
 */
import { allItems, itemDef } from "../world/mcdata.js";

/** How close a chest must be to be used. */
export const CHEST_RANGE = 16;

/** The only chest action there is. Named as a union of one so the compiler helps. */
export type ChestAction = "deposit";

/** What Elix may ever do with a chest. */
export const ALLOWED_CHEST_ACTION: Readonly<ChestAction[]> = Object.freeze(["deposit"]);

/** A give request, as parsed from one line. */
export interface GiveRequest {
  /** The real 26.2 item name. */
  item: string;
  /** How many to hand over. */
  count: number;
}

/** A deposit request. There is nothing to parse - it takes no argument. */
export interface DepositRequest {
  /** What Elix is putting in. Never anything else. */
  action: ChestAction;
}

/** Words a player uses for an item, mapped to the real 26.2 name. */
export const ITEM_WORDS: Readonly<Record<string, string>> = Object.freeze({
  cobble: "cobblestone",
  cobblestone: "cobblestone",
  dirt: "dirt",
  wood: "oak_log",
  log: "oak_log",
  stone: "stone",
  planks: "oak_planks",
  sticks: "stick",
  torch: "torch",
  bread: "bread",
  apple: "apple",
  pickaxe: "wooden_pickaxe",
  axe: "wooden_axe",
  sword: "wooden_sword",
});

/** Normalise "oak log" to "oak_log", the way item names are actually written. */
function asItemName(word: string): string {
  return word.trim().replace(/\s+/gu, "_");
}

/** Strip Elix's name and the two filler words the command path allows. */
function afterName(message: string, botName: string): string | null {
  const normalised = message.toLowerCase().replace(/\s+/gu, " ").trim();
  const escaped = botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const nameRe = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u");
  if (!nameRe.test(normalised)) return null;
  return normalised
    .replace(nameRe, " ")
    .replace(/\b(please|pls|plz|now|bro|yaar|ok|okay)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Parse "elix give me 5 cobblestone".
 *
 * `give me` with nothing after it is NOT a give: it is a shrug, and guessing an item would
 * hand somebody the wrong thing.
 */
export function parseGive(message: string, botName: string): GiveRequest | null {
  const rest = afterName(message, botName);
  if (rest === null) return null;
  const m = /^(?:give|hand|pass)\s+me\s+(?:(\d+)\s+)?(?:the\s+|some\s+|all\s+)?([a-z_ ]+)$/u.exec(rest);
  if (m === null) return null;
  const word = (m[2] ?? "").trim();
  if (word === "") return null;
  const name = asItemName(word);
  const item = ITEM_WORDS[name] ?? name;
  // A real item, or nothing: Elix does not promise things he cannot hand over.
  if (itemDef(item) === null) return null;
  const count = Math.max(1, Math.min(64, Number.parseInt(m[1] ?? "1", 10) || 1));
  return { item, count };
}

/**
 * Parse "elix put your stuff in the chest".
 *
 * The only accepted form. Anything mentioning taking, getting back, retrieving or pulling
 * returns null, because there is no code path that produces a withdrawal.
 */
export function parseChestAction(message: string, botName: string): DepositRequest | null {
  const rest = afterName(message, botName);
  if (rest === null) return null;
  if (/^(?:put|store|deposit|drop)\s+(?:your|the|my)\s+(?:stuff|things|items|everything)\s+(?:in|into)\s+(?:the\s+|a\s+|that\s+)?(?:chest|box|barrel)$/u.test(rest)) {
    return { action: "deposit" };
  }
  return null;
}

/** Why a give or deposit did not happen. */
export type GiveRefusal =
  | "not-an-owner"
  | "no-such-item"
  | "not-in-inventory"
  | "too-far-from-chest"
  | "chest-too-far"
  | "chest-full"
  | "wrong-owner"
  | "wellbeing-floor"
  | "stopped";

/** Short, human answers. None of them explains the rule. */
export const GIVE_REFUSALS: Readonly<Record<GiveRefusal, string>> = Object.freeze({
  "not-an-owner": "i can't do that one",
  "no-such-item": "i don't have that",
  "not-in-inventory": "i don't have that",
  "too-far-from-chest": "there's no chest here",
  "chest-too-far": "that chest is too far",
  "chest-full": "that chest is full",
  "wrong-owner": "that wasn't for me",
  "wellbeing-floor": "i'm here",
  stopped: "ok, stopping",
});

/** Everything the decisions read. */
export interface GiveView {
  /** Who asked. Only this person can be handed anything. */
  askedBy: string;
  /** Is that person an owner? */
  isOwner: boolean;
  /** What Elix has, by item name. */
  counts: Record<string, number>;
  /** Nearest chest within range, or null. */
  chest: { distance: number; canHold: boolean } | null;
  /** Did the wellbeing floor match this line? If so, NOTHING happens. */
  wellbeingFloor: boolean;
}

/**
 * The whole give decision.
 *
 * Three orderings matter and are asserted in the tests:
 *
 *   1. the WELLBEING FLOOR is checked FIRST, before ownership - a line that matches the
 *      floor never triggers an action, whoever said it;
 *   2. OWNERSHIP next, because a stranger gets a refusal rather than Elix's inventory;
 *   3. the ITEM, and for a deposit the CHEST.
 */
export function decideGive(
  view: GiveView,
  request: GiveRequest | DepositRequest,
): { kind: "toss"; item: string; count: number; to: string } | { kind: "deposit" } | { kind: "refuse"; reason: GiveRefusal } {
  if (view.wellbeingFloor) return { kind: "refuse", reason: "wellbeing-floor" };
  if (!view.isOwner) return { kind: "refuse", reason: "not-an-owner" };

  if ("item" in request) {
    const have = view.counts[request.item] ?? 0;
    if (have <= 0) return { kind: "refuse", reason: "not-in-inventory" };
    // To the person who asked. Always. There is no code path here that names anybody else.
    return { kind: "toss", item: request.item, count: Math.min(have, request.count), to: view.askedBy };
  }

  // Deposit. Never withdraw: ALLOWED_CHEST_ACTION has one value and it is not "withdraw".
  if (request.action !== ALLOWED_CHEST_ACTION[0]) return { kind: "refuse", reason: "wrong-owner" };
  const chest = view.chest;
  if (chest === null) return { kind: "refuse", reason: "chest-too-far" };
  if (chest.distance > CHEST_RANGE) return { kind: "refuse", reason: "chest-too-far" };
  if (!chest.canHold) return { kind: "refuse", reason: "chest-full" };
  return { kind: "deposit" };
}

/** Where Elix has to be standing to hand something over. */
export const GIVE_RANGE = 3;

/** The stateful half, so `stop` can complete inside one tick. */
export class GiveController {
  private stopped = false;
  private reason: GiveRefusal | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The last refusal, for the log. */
  get refusal(): GiveRefusal | null {
    return this.reason;
  }

  /** True while a stop is in force. */
  get halted(): boolean {
    return this.stopped;
  }

  /** Record a refusal. */
  note(reason: GiveRefusal): void {
    this.reason = reason;
  }

  /** `elix stop`. Synchronous, and it refuses anything asked for afterwards. */
  stop(): void {
    this.stopped = true;
    this.reason = "stopped";
  }

  /** The caller decides when Elix may act again. */
  resume(): void {
    this.stopped = false;
    this.reason = null;
  }

  /** The short line to send, or null when nothing should be said. */
  line(): string | null {
    return this.reason === null ? null : GIVE_REFUSALS[this.reason];
  }

  /** How long Elix has been up, for the caller's own timing. */
  elapsed(since: number): number {
    return this.now() - since;
  }
}

/** True when this item is something Elix is willing to hand over at all. */
export function isGiveable(item: string): boolean {
  return allItems().some((def) => def.name === item);
}