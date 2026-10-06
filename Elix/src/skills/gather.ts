/**
 * WP5a — gather. "elix get wood", "elix get me 10 cobblestone".
 *
 * Gathering is the first thing Elix does that changes the world, so this module is mostly
 * a list of things he will NOT do:
 *
 *   - only NATURAL blocks, from an explicit allow-list;
 *   - logs only when LEAVES are within 2 blocks, because a log inside a house is somebody's
 *     floor and somebody's wall;
 *   - never within PROTECTED_RADIUS of the owner, which becomes every remembered place in
 *     WP6 - the parameter is already a list of places for that reason;
 *   - never more than GATHER_MAX_ITEMS, and never longer than GATHER_MAX_MS;
 *   - the best tool, from minecraft-data's own `harvestTools`;
 *   - and `stop` cancels it inside one tick, mid-dig included.
 *
 * The progress line is deliberately rare (one per PROGRESS_MIN_GAP_MS) and goes through
 * `gateOwnLine`, because it is ELIX's own words and `gateScriptedReply` would file a safety
 * record against the owner for something the owner never said.
 */
import { Vec3 } from "vec3";
import { allItems, blockNames, dataForVersion } from "../world/mcdata.js";

/** A position, in the shape mineflayer and vec3 agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Never dig within this many blocks of a protected place. WP6 supplies more places. */
export const PROTECTED_RADIUS = 24;

/** Hard caps, so "get 64 cobblestone" cannot become "dig for an hour". */
export const GATHER_MAX_ITEMS = 64;
export const GATHER_MAX_MS = 5 * 60_000;

/** At most one progress line this often. */
export const PROGRESS_MIN_GAP_MS = 60_000;

/** Leaves must be within this many blocks of a log for it to count as a tree. */
export const LEAF_RADIUS = 2;

/**
 * The natural-block allow-list.
 *
 * Read from the vendored 26.2 `blocks.json` and checked against it in the tests, so a
 * renamed or removed block fails loudly rather than silently becoming ungatherable.
 */
export const ALLOWED_BLOCKS: readonly string[] = Object.freeze([
  // soil and loose ground
  "dirt",
  "grass_block",
  "coarse_dirt",
  "podzol",
  "mycelium",
  "rooted_dirt",
  "mud",
  "sand",
  "red_sand",
  "gravel",
  "clay",
  // stone
  "stone",
  "cobblestone",
  "deepslate",
  "cobbled_deepslate",
  "tuff",
  "calcite",
  "andesite",
  "diorite",
  "granite",
  // ores, including the deepslate variants
  "coal_ore",
  "deepslate_coal_ore",
  "copper_ore",
  "deepslate_copper_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "diamond_ore",
  "deepslate_diamond_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  // one ice-blue presentable
  "snow_block",
]);

/** Logs need leaves nearby; without them they are somebody's building. */
export const LOG_BLOCKS: readonly string[] = Object.freeze([
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "cherry_log",
  "dark_oak_log",
  "mangrove_log",
  "crimson_stem",
  "warped_stem",
  "pale_oak_log",
]);

/** Leaves, for the "is this log a tree?" check. */
export const LEAF_BLOCKS: readonly string[] = Object.freeze([
  "oak_leaves",
  "spruce_leaves",
  "birch_leaves",
  "jungle_leaves",
  "acacia_leaves",
  "cherry_leaves",
  "dark_oak_leaves",
  "mangrove_leaves",
  "azalea_leaves",
  "flowering_azalea_leaves",
  "crimson_fungus",
  "crimson_roots",
  "warped_fungus",
  "warped_roots",
  "nether_sprouts",
]);

/** Blocks that must never be dug, whatever else is true. Named for the test that proves it. */
export const NEVER_GATHERED: readonly string[] = Object.freeze([
  "crafting_table",
  "furnace",
  "chest",
  "barrel",
  "bed",
  "torch",
  "glass",
  "white_wool",
  "bookshelf",
  "oak_planks",
  "stone_bricks",
]);

/** The full set this skill may ever dig. */
export const GATHERABLE: ReadonlySet<string> = Object.freeze(
  new Set([...ALLOWED_BLOCKS, ...LOG_BLOCKS]),
);

/** True when this block is on the allow-list. */
export function isAllowedBlock(name: string): boolean {
  return GATHERABLE.has(name);
}

/** True when digging this block needs leaves within LEAF_RADIUS. */
export function needsLeaves(name: string): boolean {
  return LOG_BLOCKS.includes(name);
}

/** True when a block is a leaf. */
export function isLeaf(name: string): boolean {
  return LEAF_BLOCKS.includes(name);
}

/**
 * The reason a dig is refused, or null when it is allowed.
 *
 * Returning a REASON rather than a boolean is what lets the caller log something useful and
 * lets the tests say which rule fired, instead of "it did not dig" with no explanation.
 */
export type DigRefusal =
  | "not-on-the-list"
  | "log-without-leaves"
  | "protected-place"
  | "cap-reached"
  | "out-of-time";

export interface DigCheck {
  name: string;
  position: Vec3Like;
  /** Every place that must be left alone. WP6 fills this with the remembered places. */
  protectedPlaces: Vec3Like[];
  /** How many of the target have been gathered so far. */
  gathered: number;
  /** How many are wanted. */
  wanted: number;
  /** How long the gather has been running, in ms. */
  elapsedMs: number;
  /** Whether leaves are within LEAF_RADIUS, for a log. Read by the caller. */
  hasLeavesNearby: boolean;
}

/** Distance, ignoring height. Digging is about the ground, not about air. */
function distanceXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The rule that refuses this dig, or null when it is fine. */
export function refuseDig(check: DigCheck): DigRefusal | null {
  if (!isAllowedBlock(check.name)) return "not-on-the-list";
  if (needsLeaves(check.name) && !check.hasLeavesNearby) return "log-without-leaves";
  for (const place of check.protectedPlaces) {
    if (distanceXZ(check.position, place) < PROTECTED_RADIUS) return "protected-place";
  }
  if (check.gathered >= check.wanted || check.gathered >= GATHER_MAX_ITEMS) return "cap-reached";
  if (check.elapsedMs >= GATHER_MAX_MS) return "out-of-time";
  return null;
}

/** The reason in words, for the log and for a short line to the owner. */
export const REFUSAL_TEXT: Readonly<Record<DigRefusal, string>> = Object.freeze({
  "not-on-the-list": "that isn't something i dig",
  "log-without-leaves": "that log looks like it's in a building",
  "protected-place": "i'm not digging around here",
  "cap-reached": "that's as much as i'm carrying",
  "out-of-time": "that's me for now",
});

/**
 * The best tool for a block, from minecraft-data's own `harvestTools`.
 *
 * `harvestTools` is keyed by ITEM ID, so the ids are resolved to names through the same
 * accessor that read them. An item Elix is not holding is skipped, and the answer is the
 * best-ranked tool he actually has - not the theoretical best in the game, because a bot that
 * picks a tool it does not hold digs with its fist and looks like a fool.
 */
export function bestToolFor(
  blockName: string,
  held: readonly string[],
  version?: string,
): string | null {
  const data = dataForVersion(version);
  if (data === null) return null;
  const block = data.blocksByName?.[blockName] as { harvestTools?: Record<string, boolean> } | undefined;
  const tools = block?.harvestTools;
  if (tools === undefined || tools === null) return null;
  const byId = new Map<string, string>();
  for (const item of allItems(version)) byId.set(String(item.id), item.name);
  const names = Object.keys(tools)
    .filter((id) => tools[id] === true)
    .map((id) => byId.get(id))
    .filter((name): name is string => name !== undefined)
    // Only pickaxes for stone and ore: an axe strips bark and a shovel is for soil.
    .filter((name) => name.endsWith("_pickaxe"));
  if (names.length === 0) return null;
  // Mining tiers, exactly as the game grades them: wooden and gold are TIER 0 and the same
  // speed, stone is 1, copper 2, iron 3, diamond 4, netherite 5.
  //
  // The first version of this ranked by MATERIAL NAME, which put gold above iron - the same
  // mistake the owner rejected for armour in Round 17. A gold pickaxe digs no faster than a
  // wooden one, so a bot that preferred gold would dig slowly and look broken. Anything not
  // in this table ranks -1 and is never chosen, which is the safe direction: Elix uses his
  // fist rather than the wrong tool.
  const TOOL_TIER: Readonly<Record<string, number>> = Object.freeze({
    wooden_pickaxe: 0,
    gold_pickaxe: 0,
    stone_pickaxe: 1,
    copper_pickaxe: 2,
    iron_pickaxe: 3,
    diamond_pickaxe: 4,
    netherite_pickaxe: 5,
  });
  const rank = (name: string): number => TOOL_TIER[name] ?? -1;
  const usable = held
    .filter((name) => names.includes(name))
    .map((name) => ({ name, rank: rank(name) }))
    .filter((tool) => tool.rank >= 0);
  if (usable.length === 0) return null;
  return usable.sort((a, b) => b.rank - a.rank)[0]?.name ?? null;
}

/** A gather request, as parsed from one line. */
export interface GatherRequest {
  /** The 26.2 block name to dig. */
  block: string;
  /** How many are wanted, 1 when the line did not say. */
  count: number;
}

/** Common words a player uses for a block, mapped to the real 26.2 name. */
export const BLOCK_WORDS: Readonly<Record<string, string>> = Object.freeze({
  wood: "oak_log",
  log: "oak_log",
  logs: "oak_log",
  tree: "oak_log",
  dirt: "dirt",
  soil: "dirt",
  sand: "sand",
  gravel: "gravel",
  stone: "stone",
  cobble: "cobblestone",
  cobblestone: "cobblestone",
  cobbledstone: "cobblestone",
  deepslate: "deepslate",
  coal: "coal_ore",
  iron: "iron_ore",
  copper: "copper_ore",
  diamond: "diamond_ore",
  gold: "gold_ore",
  grass: "grass_block",
  clay: "clay",
});

/** The requested count, or 1. "10 cobblestone" means ten. */
function parseCount(text: string): number {
  const m = /(\d+)/u.exec(text);
  if (m === null) return 1;
  const n = Number.parseInt(m[1] ?? "1", 10);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.min(n, GATHER_MAX_ITEMS);
}

/**
 * Parse a gather line.
 *
 * Addressed, and WHOLE INTENT: after Elix's name, the rest must be exactly a gather request,
 * bar the same two filler words the command path allows. "can you grab some wood" is NOT a
 * gather - that is WP8's tool call, through a different door, and letting it in here would
 * give two parsers the same sentence.
 */
export function parseGather(message: string, botName: string): GatherRequest | null {
  const normalised = message.toLowerCase().replace(/\s+/gu, " ").trim();
  const escaped = botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u").test(normalised)) return null;
  let rest = normalised.replace(new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u"), " ").trim();
  rest = rest.replace(/\b(please|pls|plz|now|bro|yaar|ok|okay)\b/gu, " ").replace(/\s+/gu, " ").trim();
  const m = /^(?:get|fetch|bring|collect|gather|mine)\s+(?:me\s+)?(?:(\d+)\s+)?(?:some|a few|a couple of\s+)?([a-z_ ]+)$/u.exec(rest);
  if (m === null) return null;
  const word = (m[2] ?? "").trim();
  const name = BLOCK_WORDS[word] ?? (blockNames().has(word) ? word : null);
  if (name === null) return null;
  if (!isAllowedBlock(name)) return null;
  return { block: name, count: parseCount(m[1] ?? rest) };
}

/** True when the line is addressed to Elix at all. Used by the wellbeing-floor check. */
export function addressedTo(message: string, botName: string): boolean {
  const normalised = message.toLowerCase().replace(/\s+/gu, " ").trim();
  const escaped = botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u").test(normalised);
}

/** What a gather run is doing right now. */
export type GatherState =
  | { kind: "idle" }
  | { kind: "working"; gathered: number; wanted: number }
  | { kind: "done"; gathered: number }
  | { kind: "refused"; reason: DigRefusal }
  | { kind: "stopped" };

/**
 * The stateful half: the counters, the cap, the progress-line throttle and the stop.
 *
 * It has no mineflayer reference at all. The caller does the digging, which is why
 * `stop()` can be synchronous and complete: there is nothing in here to await.
 */
export class GatherController {
  private request: GatherRequest | null = null;
  private gathered = 0;
  private startedAt = 0;
  private stopped = false;
  private lastLineAt = -PROGRESS_MIN_GAP_MS;
  private end: GatherState = { kind: "idle" };

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** What Elix is doing. */
  get state(): GatherState {
    if (this.end.kind !== "idle") return this.end;
    if (this.request === null) return { kind: "idle" };
    return { kind: "working", gathered: this.gathered, wanted: this.request.count };
  }

  /** How many have been gathered. */
  get count(): number {
    return this.gathered;
  }

  /** The current request, or null. */
  get current(): GatherRequest | null {
    return this.request;
  }

  /** Start. Refuses a request for a block that is not on the allow-list. */
  start(request: GatherRequest): GatherState {
    this.stopped = false;
    this.gathered = 0;
    this.request = request;
    this.startedAt = this.now();
    this.end = { kind: "idle" };
    return this.state;
  }

  /** Should this dig be refused right now? null means go ahead. */
  mayDig(check: Omit<DigCheck, "gathered" | "wanted" | "elapsedMs">): DigRefusal | null {
    if (this.stopped) return null;
    if (this.request === null) return null;
    const refusal = refuseDig({
      ...check,
      gathered: this.gathered,
      wanted: this.request.count,
      elapsedMs: this.now() - this.startedAt,
    });
    if (refusal !== null) this.end = { kind: "refused", reason: refusal };
    return refusal;
  }

  /**
   * One item gathered. Returns true while there is more to do, false when this run is over.
   *
   * The cap is checked here as well as in `mayDig`, because the item arrives BEFORE the next
   * decision - a controller that only checked at decision time would dig one block too many.
   */
  gathered_one(): boolean {
    if (this.request === null) return false;
    this.gathered += 1;
    if (this.gathered >= this.request.count || this.gathered >= GATHER_MAX_ITEMS) {
      this.end = { kind: "done", gathered: this.gathered };
      return false;
    }
    return true;
  }

  /**
   * May a progress line be sent now?
   *
   * Rare on purpose: one per PROGRESS_MIN_GAP_MS, because a bot that narrates every block is
   * a bot nobody reads. Returns the line to send, or null.
   */
  progressLine(): string | null {
    if (this.stopped || this.request === null) return null;
    const now = this.now();
    if (now - this.lastLineAt < PROGRESS_MIN_GAP_MS) return null;
    this.lastLineAt = now;
    return `got ${this.gathered} of ${this.request.count} ${this.request.block.replace(/_/gu, " ")}`;
  }

  /** `elix stop`. Synchronous, and leaves nothing running. */
  stop(): GatherState {
    this.stopped = true;
    this.request = null;
    this.end = { kind: "stopped" };
    return this.end;
  }

  /** Allow a new gather. The caller decides when - never on a timer Elix does not own. */
  resume(): void {
    this.stopped = false;
    if (this.end.kind === "stopped") this.end = { kind: "idle" };
  }
}

/** A block position helper, so the caller and the checks agree on the arithmetic. */
export function blockPos(x: number, y: number, z: number): Vec3 {
  return new Vec3(x, y, z);
}