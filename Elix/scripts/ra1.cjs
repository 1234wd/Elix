const fs = require("node:fs");
const BOT = "src/connection/bot.ts";
const OUT = "src/connection/skillDispatch.ts";

const src = fs.readFileSync(BOT, "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");

/** Find `  private NAME(` / `  NAME(` and return {start, end} line indexes of the whole member. */
function memberRange(pattern) {
  const start = lines.findIndex((l) => pattern.test(l));
  if (start < 0) throw new Error("not found: " + pattern);
  // Walk back over the doc comment directly above.
  let first = start;
  while (first > 0) {
    const prev = (lines[first - 1] ?? "").trim();
    if (prev.startsWith("*") || prev.startsWith("/**") || prev.startsWith("//")) first -= 1;
    else break;
  }
  // Walk forward until braces balance.
  let depth = 0;
  let seen = false;
  let last = start;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") { depth += 1; seen = true; }
      else if (ch === "}") depth -= 1;
    }
    if (seen && depth <= 0) { last = i; break; }
  }
  return { first, last, text: lines.slice(first, last + 1).join("\n") };
}

const METHODS = [
  /^  private runGather\(\): boolean \{/,
  /^  private watchDeaths\(bot: BotLike\): void \{/,
  /^  private dispatchMemory\(bot: BotLike, username: string, message: string\): boolean \{/,
  /^  private runToolCall\(bot: BotLike, call: ToolCall, askedBy: string\): void \{/,
  /^  private runGive\(\): boolean \{/,
  /^  private dispatchGive\(bot: BotLike, username: string, message: string\): boolean \{/,
  /^  private runCraft\(\): boolean \{/,
  /^  private dispatchCraft\(bot: BotLike, username: string, message: string\): boolean \{/,
  /^  private dispatchGather\(bot: BotLike, username: string, message: string\): boolean \{/,
  /^  private sleepContext\(bot: BotLike\): SleepContext \{/,
  /^  private runSleep\(\): void \{/,
];

const FOUNDERS = [
  /^function chestViewOf\(/,
  /^function foundPosition\(/,
  /^function findPlacedTable\(/,
  /^function chestBlockIds\(/,
  /^function bedBlockIds\(/,
  /^function hostilePositionsOf\(/,
  /^function pathfinderGoals\(/,
  /^function namedBlock\(/,
];

const CONSTS = [/^const TOOL_COMMAND: Readonly/, /^const BED_BLOCK_NAMES = \[/, /^const CHEST_BLOCK_NAMES = \[/];

// --- collect every block we are moving, with its exact line range -----------------------
const moves = [];
for (const p of METHODS) moves.push({ ...memberRange(p), kind: "method" });
for (const p of FOUNDERS) moves.push({ ...memberRange(p), kind: "function" });
for (const p of CONSTS) {
  const start = lines.findIndex((l) => p.test(l));
  if (start < 0) throw new Error("const not found: " + p);
  let last = start;
  while (last + 1 < lines.length && !(lines[last] ?? "").endsWith(";") && !(lines[last] ?? "").endsWith("];")) last += 1;
  // walk back over the doc comment
  let first = start;
  while (first > 0 && ((lines[first - 1] ?? "").trim().startsWith("*") || (lines[first - 1] ?? "").trim().startsWith("//"))) first -= 1;
  moves.push({ first, last, text: lines.slice(first, last + 1).join("\n"), kind: "const" });
}

// --- remove them from bot.ts, and collect them for the new file -------------------------
moves.sort((a, b) => b.first - a.first);
const collected = [];
for (const m of moves) {
  collected.push({ text: m.text, kind: m.kind, at: m.first });
  lines.splice(m.first, m.last - m.first + 1);
  // Swallow one blank line the removal leaves behind.
  if (lines[m.first] === "" && lines[m.first - 1] === "") lines.splice(m.first, 1);
}
fs.writeFileSync(BOT, lines.join("\n"), "utf8");

// --- convert the bodies ----------------------------------------------------------------
function convert(text, kind) {
  let t = text;
  if (kind === "method") t = t.replace(/^  private /mu, "  ");
  t = t.split("this.deps.log.").join("this.ctx.log.");
  t = t.split("this.log.").join("this.ctx.log.");
  t = t.split("this.deps.config.").join("this.ctx.config.");
  t = t.split("this.deps.profile.").join("this.ctx.profile.");
  t = t.split("this.deps.chatBridge").join("this.ctx.chatBridge");
  t = t.split("this.say?.say(").join("this.ctx.say(");
  t = t.split("this.ownLine(").join("this.ctx.ownLine(");
  t = t.split("this.memory ??").join("this.ctx.memory ?");
  t = t.split("this.walkGoalTo(").join("this.ctx.walkGoalTo(");
  t = t.split("this.follow?.busy === true").join("this.ctx.following()");
  return t;
}

collected.sort((a, b) => a.at - b.at);
const body = collected.map((c) => convert(c.text, c.kind)).join("\n\n");

const header = `/**
 * The skill dispatch: gather, craft, give, deposit, world memory, tool calls and sleep.
 *
 * Extracted from \`bot.ts\` with no behaviour change (R20-A1). It was the largest block in that
 * file and it reads the session through a NARROW interface rather than through \`this\`, which is
 * the point: every one of these skills takes the same four things from the session - the config,
 * the owner list, a way to say one gated line, and the real goal builder - and nothing else.
 *
 * A method that moved verbatim but now reaches the session through \`ctx\`, so there is one place
 * to look when a skill cannot reach what it needs.
 */
import { Vec3 } from "vec3";
import { GatherRunner, otherPlayerPositions, type GatherBot, type GatherWorld } from "../skills/gatherRuntime.js";
import { CraftRunner, inventoryItemNames, TABLE_ITEM, type CraftBot } from "../skills/craftRuntime.js";
import { GiveRunner, type GiveBot } from "../skills/giveRuntime.js";
import { parseGather, PROTECTED_RADIUS } from "../skills/gather.js";
import { craftRequest } from "../skills/craft.js";
import { parseGive, parseChestAction, GIVE_REFUSALS, CHEST_RANGE } from "../skills/give.js";
import { MemoryRunner, PlaceBook, type MemoryBot } from "../world/memoryRuntime.js";
import { parseRemember, parseWhereIs, parseGoTo, parseWhereDied } from "../world/memory.js";
import { itemIdOf } from "../world/itemIds.js";
import { blockIdOf } from "../world/blockIds.js";
import { SleepRunner, type SleepBot, type SleepContext } from "../reflexes/sleep.js";
import { isHostileMob } from "../reflexes/hostile.js";
import type { ToolCall } from "../brain/toolCalls.js";
import type { MemoryStore } from "../memory/store.js";
import type { ElixConfig } from "../core/config.js";
import type { BotLike, ChatBridgeLike, Vec3Like } from "./bot.js";
import { playerPosition, requirePathfinder, NOT_AN_OWNER } from "./bot.js";

/** Everything a skill may reach on the session. Nothing else crosses this line. */
export interface SkillContext {
  config: ElixConfig;
  profile: { username: string };
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  chatBridge: ChatBridgeLike | undefined;
  /** Says one line in public chat. Already gated by the caller. */
  say(text: string): void;
  /** Says one line that is ELIX's own words, through gateOwnLine. */
  ownLine(player: string, line: string): void;
  /** The place book, for the protectedRadius rule. Null means "no store". */
  memory: MemoryStore | null;
  /** The real library's goal builder. */
  walkGoalTo(position: Vec3Like): unknown;
  /** Is a follow running right now? */
  following(): boolean;
}

/**
 * Owns the four skill runtimes and the world book.
 *
 * One object rather than six fields on the session, because "which skill is running" is a
 * question with one answer and six answers is six chances to forget one.
 */
export class SkillDispatch {
  /** R18-C: the gather runtime, created per request. */
  private gather: GatherRunner | null = null;
  /** R18-D: the craft runtime, created per request. */
  private craft: CraftRunner | null = null;
  /** R18-E: the give/deposit runtime, created per request. */
  private give: GiveRunner | null = null;
  /** R19-E: the sleep runner. Created with the bot, like every other runtime. */
  private sleep: SleepRunner | null = null;
  /** R19-E/R18-F: the place book and the runner that answers questions about it. */
  readonly memoryRunner: MemoryRunner;

  constructor(private readonly ctx: SkillContext) {
    this.memoryRunner = new MemoryRunner(
      { store: ctx.memory, goals: pathfinderGoals(), now: () => Date.now() },
      new PlaceBook(ctx.memory),
    );
  }

  /** The place book, for the session's own \`protectedRadius\` rule. */
  get book(): PlaceBook {
    return this.memoryRunner.book;
  }

  /** R18-C: the world the gather rules read. */
  gatherWorldOf(bot: BotLike): GatherWorld {
    const me = bot.entity?.position;
    const position: Vec3Like = me ?? { x: 0, y: 64, z: 0 };
    const places = this.book.all();
    return {
      position: { x: position.x, y: position.y, z: position.z },
      playerPositions: otherPlayerPositions(bot.players, bot.username ?? ""),
      protectedPlaces: places.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      protectedRadius: PROTECTED_RADIUS,
    };
  }

  /** True while any skill holds the body. */
  get busy(): boolean {
    return this.gather !== null || this.craft !== null || this.give !== null;
  }

  /** \`elix stop\`: every runtime, nothing half-running. */
  stopAll(): void {
    this.gather?.stop();
    this.gather = null;
    this.craft?.stop();
    this.craft = null;
    this.give?.stop();
    this.give = null;
    this.sleep?.stop();
    this.sleep = null;
  }

  /** The sleep runner, created with the bot and bound to the server's own \`wake\` event. */
  attachSleep(bot: BotLike, onWake: () => void): void {
    this.sleep = new SleepRunner({
      bot: bot as unknown as SleepBot,
      walkGoal: (position) => this.ctx.walkGoalTo(position),
      context: (): SleepContext => this.sleepContext(bot),
    });
    const on = (bot as { on?: (event: string, fn: () => void) => void }).on;
    if (typeof on === "function") on.call(bot, "wake", onWake);
  }

  /** The session's real goal builder, for the runtimes that need one. */
  get walkGoal() {
    return (position: Vec3Like): unknown => this.ctx.walkGoalTo(position);
  }

`;

const footer = `
}

export { gatheredBedsNeverExported };
`;

fs.writeFileSync(OUT, header + body + "\n}\n", "utf8");
console.log("bot.ts now " + lines.length + " lines; skillDispatch.ts written");
