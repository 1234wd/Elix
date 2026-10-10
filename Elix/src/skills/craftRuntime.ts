/**
 * The craft runtime — the half of "elix craft 4 sticks" that touches the world.
 *
 * Three facts about mineflayer's real API drive the whole shape of this file, and all three
 * were read out of the installed library rather than assumed (see `tests/unit/craftWiring.test.ts`,
 * which fails if the library ever disagrees):
 *
 *   1. `bot.placeBlock(referenceBlock, faceVector)` does NOT take the item. It places whatever
 *      Elix is HOLDING, against a reference block and a face. So placing a table is
 *      equip-then-place, and forgetting the equip is the classic "nothing happened" bug.
 *   2. `bot.recipesFor(itemType, metadata, minResultCount, craftingTable)` is SYNCHRONOUS and
 *      returns an array. `await` on it is harmless but hides the shape; a fake that returned a
 *      promise would let a broken caller pass.
 *   3. `bot.craft(recipe, count, craftingTable)` THROWS `'Recipe requires craftingTable'` when the
 *      recipe needs one and the argument is null. The table argument is the placed Block, not
 *      the item and not the coordinates.
 *
 * The recipe object handed to `bot.craft` is mineflayer's own, from `bot.recipesFor` - never
 * minecraft-data's, which has a different shape entirely and would be rejected by the real
 * library while passing every fake.
 */
import { Vec3 } from "vec3";
import { CraftController, planCraft, type CraftRequest, type CraftStep, type CraftWorld } from "./craft.js";

/** The mineflayer surface this file uses. Every member is read through a guard. */
export interface CraftBot {
  equip(item: unknown, destination: string): Promise<void>;
  placeBlock(referenceBlock: unknown, faceVector: unknown): Promise<void>;
  recipesFor(
    itemType: number,
    metadata: number | null,
    minResultCount: number,
    craftingTable: unknown,
  ): unknown;
  craft(recipe: unknown, count: number, craftingTable: unknown): Promise<void>;
  blockAt(pos: { x: number; y: number; z: number }): { name?: string } | null;
  dig(block: unknown): Promise<void>;
  entity?: { position: { x: number; y: number; z: number } } | undefined;
  inventory?: { items?: () => unknown[] } | undefined;
}

/** The one face vector a table is ever placed on: the top of the block below it. */
export const TOP_FACE: Readonly<{ x: number; y: number; z: number }> = Object.freeze({ x: 0, y: 1, z: 0 });

/** The item a crafting table is. */
export const TABLE_ITEM = "crafting_table";

/** What the runtime is doing. */
export type CraftOutcome =
  | { kind: "running"; step: CraftStep }
  | { kind: "done"; item: string; count: number }
  | { kind: "refused"; reason: string }
  | { kind: "stopped" };

/** What the runtime needs, injected so it never reaches for a loader or a clock. */
export interface CraftDeps {
  bot: CraftBot;
  /** The item id for a name, from the ONE vendored data accessor. */
  itemIdOf: (name: string) => number | null;
  /** The item Elix is holding by name, or null. */
  itemNamed: (name: string) => unknown | null;
  /** Says one short line, already gated by the caller. */
  say?: (line: string) => void;
}

/** Why a craft did not happen, in words the owner can read. */
export const CRAFT_REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "not-craftable": "i don't know how to make that",
  "no-table-spot": "nowhere here to put a crafting table",
  "no-recipe": "there's no recipe for that in this version",
  "missing-materials": "i'm missing the ingredients for that",
  "no-items": "i don't have any of that",
});

/**
 * The stateful craft.
 *
 * One plan step per tick, exactly like the gather: a stop between any two steps leaves nothing
 * half-done, and the table is never left behind because "collect-table" is a step in the plan
 * rather than a promise made afterwards.
 */
export class CraftRunner {
  private readonly controller = new CraftController();
  private request: CraftRequest | null = null;
  private tableBlock: unknown = null;
  private placed = false;
  private said = false;

  constructor(private readonly deps: CraftDeps) {}

  /** The step in progress, for the log and the tests. */
  get step(): CraftStep {
    return this.controller.state;
  }

  /** True while a craft is running. */
  get busy(): boolean {
    return this.request !== null;
  }

  /**
   * Plan and load.
   *
   * A refusal is loaded like any other outcome so the caller has ONE place to read the reason,
   * rather than a plan function that returned null in some branches and a refusal in others.
   */
  start(request: CraftRequest, world: CraftWorld, existingTable: unknown = null): CraftStep {
    this.request = request;
    // A table somebody already put down is not Elix's to place or to dig up. The plan's
    // `collect-table` step only appears when `hasTable` is false, so handing the Block here
    // is what keeps "use the table in the shed" from becoming "steal the table in the shed".
    this.tableBlock = existingTable;
    this.placed = false;
    this.said = false;
    this.controller.resume();
    const step = this.controller.load(planCraft(request, world), request);
    if (step.kind === "refused") {
      this.request = null;
      this.sayOnce(CRAFT_REFUSAL_TEXT[step.reason] ?? "i can't make that");
    }
    return step;
  }

  /** One plan step. Never throws into the tick: a failure here is a refusal, not a crash. */
  async run(): Promise<CraftOutcome> {
    if (this.request === null) return { kind: "stopped" };
    const step = this.controller.advance();
    if (step === null) return { kind: "stopped" };

    switch (step.kind) {
      case "place-table": {
        const placed = await this.placeTable(step.at);
        if (!placed) return this.refuse("no-table-spot");
        return { kind: "running", step };
      }
      case "crafting": {
        const result = await this.craft(step.item, step.count, step.withTable);
        if (typeof result === "string") return this.refuse(result);
        return { kind: "running", step };
      }
      case "collect-table": {
        await this.collectTable();
        return { kind: "running", step };
      }
      case "done": {
        this.request = null;
        this.sayOnce(`made ${step.count} ${step.item.replace(/_/gu, " ")}`);
        return { kind: "done", item: step.item, count: step.count };
      }
      case "refused": {
        return this.refuse(step.reason);
      }
      case "stopped": {
        this.request = null;
        return { kind: "stopped" };
      }
      default: {
        return { kind: "running", step };
      }
    }
  }

  /**
   * Place the table: equip it FIRST, because placeBlock places the held item, then place it on
   * the top face of the block below the spot.
   *
   * Returns false when Elix does not have a table at all, which is a refusal rather than a
   * silent no-op - "nothing happened" is the worst possible answer.
   */
  private async placeTable(at: { x: number; y: number; z: number }): Promise<boolean> {
    const table = this.deps.itemNamed(TABLE_ITEM);
    if (table === null) return false;
    const support = this.deps.bot.blockAt(new Vec3(at.x, at.y - 1, at.z));
    if (support === null) return false;
    try {
      await this.deps.bot.equip(table, "hand");
      await this.deps.bot.placeBlock(support, TOP_FACE);
    } catch {
      return false;
    }
    this.placed = true;
    // The table is now a real Block at the spot. `bot.craft` wants the Block, and a Block is
    // only a Block once the server has told us about it.
    this.tableBlock = this.deps.bot.blockAt(new Vec3(at.x, at.y, at.z));
    return true;
  }

  /**
   * `recipesFor` then `craft`, with the real argument order.
   *
   * No recipe means missing materials, and that gets ONE honest line - never a craft attempt
   * with a null recipe, and never silence.
   */
  private async craft(item: string, count: number, withTable: boolean): Promise<true | string> {
    const id = this.deps.itemIdOf(item);
    if (id === null) return "not-craftable";
    const table = withTable ? this.tableBlock : null;
    if (withTable && table === null) return "no-table-spot";

    let recipes: unknown;
    try {
      recipes = this.deps.bot.recipesFor(id, null, count, table);
    } catch {
      return "missing-materials";
    }
    const list = Array.isArray(recipes) ? recipes : [];
    if (list.length === 0) return "missing-materials";
    try {
      await this.deps.bot.craft(list[0], count, table);
    } catch {
      return "missing-materials";
    }
    return true;
  }

  /**
   * Put the table back the way Elix found it.
   *
   * `bot.dig` on the table Block, not a toss: the table is a placed block, and picking it up by
   * digging it is the only way the item ever comes back.
   */
  private async collectTable(): Promise<void> {
    if (!this.placed || this.tableBlock === null) return;
    try {
      await this.deps.bot.dig(this.tableBlock);
    } catch {
      // A table Elix cannot reach stays where it is. That is untidy, not dangerous, and the
      // alternative - refusing to craft at all - is worse for the owner.
    }
    this.tableBlock = null;
    this.placed = false;
  }

  /** Close the run with a reason, and say it once. */
  private refuse(reason: string): CraftOutcome {
    this.request = null;
    this.sayOnce(CRAFT_REFUSAL_TEXT[reason] ?? "i can't make that");
    return { kind: "refused", reason };
  }

  /** Exactly one line per craft run. */
  private sayOnce(line: string): void {
    if (this.said) return;
    this.said = true;
    this.deps.say?.(line);
  }

  /** `elix stop`. Synchronous, and it leaves nothing running. */
  stop(): void {
    this.request = null;
    this.tableBlock = null;
    this.placed = false;
    this.controller.stop();
  }
}

/** Every item name in the inventory, through a guard. */
export function inventoryItemNames(bot: CraftBot): string[] {
  const inventory = bot.inventory;
  if (inventory === undefined || typeof inventory.items !== "function") return [];
  let list: unknown;
  try {
    list = inventory.items();
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") out.push(name);
  }
  return out;
}
