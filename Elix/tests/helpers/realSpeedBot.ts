/**
 * The ONE real-speed fake for skill tests.
 *
 * Round 18 shipped skill tests whose fakes resolved `dig`, `toss`, `openContainer`, `placeBlock`
 * and `craft` in the same microtask, and whose pathfinder never moved Elix. Every one of those
 * tests passed, and every one of those features was broken in a real game.
 *
 * This helper keeps the two properties that matter, both verified against the installed
 * mineflayer (see `tests/unit/mineflayerContracts.test.ts`):
 *
 *   - **Actions take time.** `dig` 1.5 s, `equip` 50 ms, `toss` 300 ms, `openContainer` 300 ms,
 *     `placeBlock` 400 ms, `craft` 300 ms. A runtime that assumes otherwise is caught here.
 *   - **`setGoal` restarts the walk.** mineflayer-pathfinder calls `resetPath('goal_updated')`
 *     and clears the control states on every `setGoal`, so a runtime that re-goals on a 50 ms
 *     tick never arrives. Elix walks 1 block/second and only when the goal is left alone.
 *   - **`dig` aborts a running dig**, like `lib/plugins/digging.js`.
 *   - **`findBlocks` returns Vec3 coordinates**, not blocks. `openContainer` rejects anything that
 *     is not a Block, exactly as mineflayer would.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import type { BlockLike, BotLike, Vec3Like } from "../../src/connection/bot.js";

interface McDef {
  id: number;
  defaultState?: number;
  hardness?: number | null;
  stackSize?: number;
}
export interface McData {
  blocksByName: Record<string, McDef | undefined>;
  itemsByName: Record<string, McDef | undefined>;
  items: Record<number, { name: string } | undefined>;
  /** Keyed by RESULT NUMERIC ID, several rows per key - not by item name. */
  recipes: Record<number, Array<{ inShape?: number[][]; result?: { id: number; count: number } }>>;
}

export const mcData = (createRequire(import.meta.url)("minecraft-data") as (v: string) => McData)("26.2");

/** How long a walk takes, in fake-timer milliseconds. */
export const WALK_MS = 1_000;
/** How long a dig takes. */
export const DIG_MS = 1_500;
/** mineflayer's own reach, used by the fake to decide whether a dig was in range. */
export const REACH = 5;

const key = (p: Vec3Like): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** A prismarine-shaped item. */
export function makeItem(name: string, count: number, slot: number): {
  name: string;
  type: number;
  count: number;
  slot: number;
  metadata: number;
  stackSize: number;
} {
  const def = mcData.itemsByName[name]!;
  return { name, type: def.id, count, slot, metadata: 0, stackSize: def.stackSize ?? 64 };
}

/** A mineflayer-shaped player. */
export function makePlayer(name: string, x: number, y = 64, z = 0): Record<string, unknown> {
  return {
    username: name,
    uuid: `u-${name}`,
    ping: 30,
    gamemode: 0,
    entity: {
      username: name,
      type: "player",
      name: "player",
      position: new Vec3(x, y, z),
      isValid: true,
      height: 1.8,
    },
  };
}

/** Every measurement the tests assert on. */
export interface RealSpeedMeasurements {
  completedDigs: string[];
  abortedDigs: number;
  outOfReachDigs: number;
  goalResets: number;
  tossCalls: number;
  tossedTotal: number;
  openCalls: number;
  depositCalls: number;
  withdrawCalls: number;
  placeCalls: number;
  craftCalls: Array<{ withTable: boolean; tableExisted: boolean }>;
  equipped: Array<{ name: string; destination: string }>;
  chatCalls: string[];
  whispers: Array<{ to: string; text: string }>;
  controlStates: Array<[string, boolean]>;
}

/**
 * A mineflayer Block, plus the two fields the search APIs actually use.
 *
 * `BlockLike` is the narrow shape the session declares; a real prismarine Block also carries
 * `type` (the numeric id `findBlocks` matches against) and `position`. Tests need both, so
 * the fake returns the wider shape and satisfies the narrow one.
 */
export interface TestBlock extends BlockLike {
  type: number;
  position: Vec3;
  stateId?: number;
  diggable?: boolean;
  hardness?: number | null;
}

export class RealSpeedBot extends EventEmitter implements BotLike {
  username = "Elix";
  version = "26.2";
  registry = mcData;
  health = 20;
  food = 20;
  oxygenLevel = 20;
  entity: { position: Vec3; yaw: number; pitch: number; isInWater: boolean; onGround: boolean; height: number } = {
    position: new Vec3(0, 64, 0),
    yaw: 0,
    pitch: 0,
    isInWater: false,
    onGround: true,
    height: 1.8,
  };
  time = { isDay: true };
  game = { dimension: "overworld", serverBrand: "Paper" };
  player = { ping: 30 };
  players: Record<string, unknown> = {};
  entities: Record<string, unknown> = {};
  heldItem: unknown = null;
  /** Terrain that differs from the default: grass at y=63, stone below, air above. */
  world = new Map<string, string>();
  stacks: ReturnType<typeof makeItem>[] = [];
  inventory = { slots: [] as unknown[], items: () => this.stacks };

  completedDigs: string[] = [];
  abortedDigs = 0;
  outOfReachDigs = 0;
  goalResets = 0;
  tossCalls = 0;
  tossedTotal = 0;
  openCalls = 0;
  depositCalls = 0;
  withdrawCalls = 0;
  placeCalls = 0;
  craftCalls: Array<{ withTable: boolean; tableExisted: boolean }> = [];
  equipped: Array<{ name: string; destination: string }> = [];
  chatCalls: string[] = [];
  whispers: Array<{ to: string; text: string }> = [];
  controlStates: Array<[string, boolean]> = [];

  private walk: ReturnType<typeof setTimeout> | null = null;
  private digTimer: ReturnType<typeof setTimeout> | null = null;
  private digReject: ((e: Error) => void) | null = null;

  pathfinder = {
    setGoal: (goal: unknown): void => {
      if (this.walk !== null) {
        clearTimeout(this.walk);
        this.goalResets += 1;
      }
      this.walk = null;
      if (goal === null || goal === undefined) return;
      const g = goal as { x?: number; y?: number; z?: number; entity?: { position: Vec3 } };
      const target =
        typeof g.x === "number" && typeof g.y === "number" && typeof g.z === "number"
          ? new Vec3(g.x, g.y, g.z)
          : g.entity?.position;
      if (target === undefined) return;
      this.walk = setTimeout(() => {
        this.walk = null;
        this.entity.position = new Vec3(Math.floor(target.x) - 1, 64, Math.floor(target.z));
        this.emit("goal_reached", goal);
      }, WALK_MS);
    },
    stop: (): void => {
      if (this.walk !== null) clearTimeout(this.walk);
      this.walk = null;
    },
    isMoving: (): boolean => this.walk !== null,
    setMovements: (): void => {},
    goto: async (): Promise<void> => {},
  };

  private block(name: string, pos: Vec3): TestBlock {
    const def = mcData.blocksByName[name]!;
    return {
      name,
      id: def.id,
      type: def.id,
      stateId: def.defaultState,
      position: pos,
      boundingBox: name === "air" ? "empty" : "block",
      diggable: name !== "air",
      hardness: def.hardness,
    };
  }

  blockAt(p: Vec3Like): TestBlock | null {
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const override = this.world.get(key(pos));
    if (override !== undefined) return this.block(override, pos);
    if (pos.y === 63) return this.block("grass_block", pos);
    if (pos.y < 63) return this.block("stone", pos);
    return this.block("air", pos);
  }

  /** COORDINATES, not blocks. This is the real API and the mistake it causes is silent. */
  findBlocks(opts: { matching: unknown; count?: number; maxDistance?: number }): Vec3[] {
    const out: Vec3[] = [];
    const m = opts.matching;
    const matches = (b: TestBlock): boolean => {
      if (typeof m === "function") return (m as (x: unknown) => boolean)(b);
      if (Array.isArray(m)) return m.includes(b.type);
      return m === b.type;
    };
    for (let x = -16; x <= 16; x += 1) {
      for (let y = 60; y <= 66; y += 1) {
        for (let z = -8; z <= 8; z += 1) {
          const b = this.blockAt(new Vec3(x, y, z));
          if (b === null || b.position === undefined) continue;
          const name = b.name;
          // Skip the DEFAULT landscape only. A block the test placed into `world` is terrain
          // the test chose, and it must be findable even when its name happens to be `stone`.
          if (this.world.get(key(b.position)) === undefined) {
            if (name === "air" || name === "grass_block" || name === "stone") continue;
          }
          if (matches(b)) out.push(b.position as Vec3);
        }
      }
    }
    const from = this.entity.position;
    out.sort((a, b) => a.distanceTo(from) - b.distanceTo(from));
    return out.slice(0, opts.count ?? 1);
  }

  /** A BLOCK, unlike findBlocks. The asymmetry is the trap. */
  findBlock(opts: { matching: unknown; maxDistance?: number }): TestBlock | null {
    const p = this.findBlocks({ ...opts, count: 1 })[0];
    return p === undefined ? null : this.blockAt(p);
  }

  dig(b: { position: Vec3 } | null): Promise<void> {
    if (b === null || b === undefined) {
      return Promise.reject(new Error("dig was called with an undefined or null block"));
    }
    if (this.digTimer !== null) this.stopDigging();
    const eye = this.entity.position.offset(0, 1.62, 0);
    if (eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > REACH) this.outOfReachDigs += 1;
    return new Promise<void>((resolve, reject) => {
      this.digReject = reject;
      this.digTimer = setTimeout(() => {
        this.digTimer = null;
        this.digReject = null;
        this.world.set(key(b.position), "air");
        this.completedDigs.push(key(b.position));
        resolve();
      }, DIG_MS);
    });
  }

  stopDigging(): void {
    if (this.digTimer === null) return;
    clearTimeout(this.digTimer);
    this.digTimer = null;
    this.abortedDigs += 1;
    const reject = this.digReject;
    this.digReject = null;
    reject?.(new Error("Digging aborted"));
  }

  async equip(target: unknown, destination: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    const name = (target as { name?: unknown } | null)?.name;
    this.equipped.push({ name: typeof name === "string" ? name : "?", destination });
    if (destination === "hand") this.heldItem = target;
  }

  async toss(itemType: number, _metadata: number | null, count: number | null): Promise<void> {
    this.tossCalls += 1;
    await new Promise((r) => setTimeout(r, 300));
    const stack = this.stacks.find((s) => s.type === itemType);
    if (stack === undefined) throw new Error("not in inventory");
    const n = Math.min(count ?? stack.count, stack.count);
    stack.count -= n;
    this.tossedTotal += n;
    this.stacks = this.stacks.filter((s) => s.count > 0);
  }

  async openContainer(b: unknown): Promise<unknown> {
    const candidate = b as { name?: unknown; position?: unknown } | null;
    if (candidate === null || typeof candidate.name !== "string" || typeof candidate.position !== "object") {
      throw new Error("openContainer needs a Block, got " + JSON.stringify(b));
    }
    this.openCalls += 1;
    await new Promise((r) => setTimeout(r, 300));
    return {
      deposit: async (itemType: number): Promise<void> => {
        this.depositCalls += 1;
        await new Promise((r) => setTimeout(r, 100));
        this.stacks = this.stacks.filter((s) => s.type !== itemType);
      },
      withdraw: async (): Promise<void> => {
        this.withdrawCalls += 1;
      },
      close: (): void => {},
    };
  }

  async placeBlock(reference: { position: Vec3 }, face: Vec3Like): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
    this.placeCalls += 1;
    const held = this.heldItem as { name?: string } | null;
    if (held?.name !== "crafting_table") throw new Error("No block has been placed");
    this.world.set(key(reference.position.offset(face.x, face.y, face.z)), "crafting_table");
  }

  recipesFor(itemType: number, _metadata: unknown, _min: unknown, table: unknown): unknown[] {
    const name = mcData.items[itemType]?.name ?? "";
    const needsTable = !["oak_planks", "stick", "crafting_table"].includes(name);
    if (needsTable && (table === null || table === undefined)) return [];
    return [{ result: { id: itemType, count: 1 }, requiresTable: needsTable }];
  }

  async craft(
    recipe: { result: { id: number }; requiresTable: boolean },
    count: number,
    table: unknown,
  ): Promise<void> {
    const tableBlock = table as { position?: Vec3 } | null;
    const tableExisted =
      tableBlock?.position !== undefined && this.world.get(key(tableBlock.position)) === "crafting_table";
    this.craftCalls.push({ withTable: table !== null && table !== undefined, tableExisted });
    await new Promise((r) => setTimeout(r, 300));
    if (recipe.requiresTable && !tableExisted) {
      throw new Error("Recipe requires craftingTable, but one was not supplied");
    }
    const name = mcData.items[recipe.result.id]?.name ?? "unknown";
    this.stacks.push(makeItem(name, count, 40 + this.stacks.length));
  }

  _client = { on: (): void => {}, write: (): void => {} };
  quit(): void {
    queueMicrotask(() => this.emit("end", "socketClosed"));
  }
  chat(text: string): void {
    this.chatCalls.push(text);
  }
  whisper(to: string, text: string): void {
    this.whispers.push({ to, text });
  }
  setControlState(control: string, state: boolean): void {
    this.controlStates.push([control, state]);
  }
  clearControlStates(): void {}
  getControlState(): boolean {
    return false;
  }
  lookAt(): Promise<void> {
    return Promise.resolve();
  }
  look(): Promise<void> {
    return Promise.resolve();
  }
  canDigBlock(): boolean {
    return true;
  }
  digTime(): number {
    return DIG_MS;
  }
  loadPlugin(): void {}
}
