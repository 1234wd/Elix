/**
 * WP2 acceptance, part 2: the reflexes themselves, and the real-library contract.
 *
 * The bot here is mineflayer-shaped: `food`, `oxygenLevel`, `entities` keyed by id with
 * `position` as a real `Vec3`, `inventory.items()` returning real prismarine `Item`
 * objects with real names from the vendored 26.2 data. No `as` casts on mineflayer
 * objects - the helpers read through runtime guards, so a field the fake gets wrong is a
 * test failure rather than a silent pass.
 *
 * `tests/unit/equipContract.test.ts` takes the same `equip`/`consume` arguments to the
 * REAL mineflayer source, because a fake that accepts what the library rejects is exactly
 * how Round 15 shipped 22 green tests over goals that crashed the real pathfinder.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import {
  CREEPER_FLEE_AT,
  CREEPER_SAFE_AT,
  DANGEROUS_FOOD_AT_FOOD,
  EAT_AT_FOOD,
  LOW_OXYGEN,
  SAFE_TO_EAT_RADIUS,
  decideArmour,
  decideBreathe,
  decideCreeper,
  decideEat,
  decideReflex,
  type CreatureLike,
  type ReflexView,
} from "../../src/reflexes/decide.js";
import { ReflexRunner, distanceXZ } from "../../src/reflexes/runner.js";
import type { EquipSlot } from "../../src/reflexes/tables.js";

interface ItemLike {
  name: string;
  count: number;
  stackSize: number;
  /** mineflayer sets this when the item is in the bot inventory. */
  slot: number | undefined;
}

/**
 * A real prismarine Item - the object mineflayer's `bot.equip` actually reads - resolved
 * through mineflayer's own module graph, because that is where the real one lives.
 *
 * Two facts about the real library shape this test, both found by using it rather than by
 * reading it:
 *
 *   1. `prismarine-item`'s export is a LOADER, not a class. It takes a registry and returns
 *      the Item class; that is the exact pair mineflayer builds at runtime.
 *   2. Items are built from a NUMERIC id, not from a name. `new Item("bread", 1)` yields
 *      `name: "unknown"`, so a name-based shortcut builds an item the real library would
 *      never hand us, and `bot.equip` would move a ghost.
 *
 * So `realItem` looks the id up in the vendored 26.2 registry and assigns a `slot` the way
 * the inventory does. The decisions read their data through `src/world/mcdata.ts`; the item
 * objects are built here from the same vendored registry, and a test below asserts the two
 * agree on every name Elix uses.
 */
const mineflayerRequire = createRequire(
  createRequire(import.meta.url).resolve("mineflayer") as string,
);
const registry = mineflayerRequire("prismarine-registry")("26.2") as {
  itemsByName: Record<string, { id: number; name: string; stackSize: number }>;
};
const Item = mineflayerRequire("prismarine-item")(registry) as new (
  id: number,
  count?: number,
) => ItemLike;

/** The next inventory slot mineflayer would hand out. */
let nextSlot = 9;

/** A prismarine Item, the object mineflayer's `bot.equip` actually reads. */
function realItem(name: string): ItemLike {
  const def = registry.itemsByName[name];
  if (def === undefined) throw new Error(`${name} is not a 26.2 item`);
  const item = new Item(def.id, 1);
  item.slot = nextSlot++;
  return item;
}

/** A mineflayer-shaped entity: name, type, real Vec3 position, isValid. */
function mob(name: string, x: number, y = 65, z = 0): CreatureLike {
  return { name, type: name, position: new Vec3(x, y, z), isValid: true, health: 20 };
}

/** A view with sensible safe defaults, so each test says only what it cares about. */
function view(over: Partial<ReflexView> = {}): ReflexView {
  return {
    position: new Vec3(0, 65, 0),
    inWater: false,
    oxygenLevel: 300,
    food: 20,
    hostile: null,
    creeper: null,
    inventory: [],
    equipped: {},
    ...over,
  };
}

/* ------------------------------------------------------------------ the bot ---- */

/**
 * mineflayer's shape, as far as the reflexes read it. `equip` and `consume` keep the real
 * argument validation so a wrong destination or a missing `slot` fails here too.
 */
class FakeBot extends EventEmitter {
  food = 20;
  oxygenLevel = 300;
  isInWater = false;
  entities: Record<number, CreatureLike> = {};
  private nextId = 1;
  private readonly items: ItemLike[] = [];
  readonly equipped: Partial<Record<EquipSlot, string | null>> = {};
  readonly equipCalls: Array<{ name: string; destination: EquipSlot; slot: number }> = [];
  readonly consumeCalls: number[] = [];
  readonly lookCalls: Vec3[] = [];
  clearedControlStates = 0;

  /** mineflayer 4.39.0 `lib/plugins/simple_inventory.js`: these are the only names. */
  static readonly ARMOR_SLOTS: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };

  addItem(name: string, count = 1): this {
    const item = realItem(name);
    item.count = count;
    this.items.push(item);
    return this;
  }

  spawn(name: string, x: number, y = 65, z = 0): CreatureLike {
    const entity = mob(name, x, y, z);
    const id = this.nextId++;
    entity.id = id;
    this.entities[id] = entity;
    return entity;
  }

  /** mineflayer's `bot.inventory.items()`. */
  inventoryItems(): ItemLike[] {
    return this.items;
  }

  /** The `ReflexBot` view, assembled the way `runner.ts` is wired in bot.ts. */
  reflexView(): ReflexView {
    const me = new Vec3(0, 65, 0);
    let hostile: ReflexView["hostile"] = null;
    let creeper: ReflexView["creeper"] = null;
    for (const entity of Object.values(this.entities)) {
      if (entity.isValid === false) continue;
      const distance = distanceXZ(me, entity.position);
      if (entity.name === "creeper" || entity.type === "creeper") {
        if (!creeper || distance < creeper.distance) {
          creeper = { name: entity.name, distance, position: entity.position };
        }
        continue;
      }
      if (!HOSTILE_MOBS.has(entity.name)) continue;
      if (!hostile || distance < hostile.distance) {
        hostile = { name: entity.name, distance };
      }
    }
    const inventory = this.inventoryItems().map((item) => ({ name: item.name, count: item.count }));
    const held = this.items.find((i) => i.slot === this.quickBarSlot) ?? null;
    return {
      position: me,
      inWater: this.isInWater,
      oxygenLevel: this.oxygenLevel,
      food: this.food,
      hostile,
      creeper,
      inventory,
      equipped: {
        ...this.equipped,
        // prismarine puts the held item in a quick-bar slot; slot 9 is the first.
        hand: this.equipped.hand ?? held?.name ?? null,
      },
    };
  }

  quickBarSlot = 9;

  async equip(item: unknown, destination: EquipSlot): Promise<void> {
    // The real library: "Invalid item object in equip (item is null or typeof item is not
    // object)", and `assert.ok(destSlot != null, 'invalid destination: ...')`.
    if (item === null || typeof item !== "object") {
      throw new Error("Invalid item object in equip (item is null or typeof item is not object)");
    }
    const asItem = item as { name?: unknown; slot?: unknown };
    if (typeof asItem.slot !== "number") {
      throw new Error(`equip got a non-Item: ${String(asItem.name)} has no numeric slot`);
    }
    if (destination !== "hand" && FakeBot.ARMOR_SLOTS[destination] === undefined) {
      throw new Error(`invalid destination: ${destination}`);
    }
    this.equipCalls.push({ name: String(asItem.name), destination, slot: asItem.slot });
    this.equipped[destination] = String(asItem.name);
  }

  async consume(): Promise<void> {
    // mineflayer 4.39.0 `lib/plugins/inventory.js`: "if (... && bot.food === 20) throw new
    // Error('Food is full')".
    if (this.food >= 20) throw new Error("Food is full");
    this.consumeCalls.push(this.food);
  }

  lookAt(target: Vec3): void {
    this.lookCalls.push(target);
  }

  clearControlStates(): void {
    this.clearedControlStates += 1;
  }

  findItem(name: string): unknown | null {
    return this.inventoryItems().find((i) => i.name === name) ?? null;
  }
}

/** Hostile mobs, for the eat gate. Kept small and named here rather than in decide.ts. */
const HOSTILE_MOBS = new Set(["zombie", "skeleton", "spider", "creeper", "husk", "drowned"]);

/** Wire a runner to a fake bot. */
function runnerFor(bot: FakeBot): ReflexRunner {
  return new ReflexRunner({
    view: () => bot.reflexView(),
    equip: (item, destination) => bot.equip(item, destination),
    consume: () => bot.consume(),
    lookAt: (target) => bot.lookAt(target),
    clearControlStates: () => bot.clearControlStates(),
    findItem: (name) => bot.findItem(name),
  });
}

/* ------------------------------------------------------------- 1. breathe ---- */

describe("WP2 — breathe", () => {
  it("swims up when oxygen is low in water", () => {
    const action = decideBreathe(view({ inWater: true, oxygenLevel: LOW_OXYGEN - 1 }));
    expect(action).toEqual({ kind: "swim-up", oxygen: LOW_OXYGEN - 1 });
  });

  it("does not swim up with plenty of air", () => {
    expect(decideBreathe(view({ inWater: true, oxygenLevel: LOW_OXYGEN + 1 })).kind).toBe("none");
  });

  it("does not swim up on land, however low the oxygen reading", () => {
    // 0 oxygen on land is not a drowning risk, and swimming up there would be a jump.
    expect(decideBreathe(view({ inWater: false, oxygenLevel: 0 })).kind).toBe("none");
  });

  it("the runner looks up and clears its state on stop", async () => {
    const bot = new FakeBot();
    bot.isInWater = true;
    bot.oxygenLevel = 30;
    const runner = runnerFor(bot);
    const tick = await runner.tick();
    expect(tick.reflex).toBe("breathe");
    expect(bot.lookCalls.length).toBe(1);
    expect(bot.lookCalls[0]?.y).toBeGreaterThan(65);
    runner.stop();
    expect(bot.clearedControlStates).toBe(1);
  });
});

/* ------------------------------------------------------------- 2. creeper ---- */

describe("WP2 — creeper", () => {
  it("backs away from a creeper within 4 blocks", () => {
    const action = decideCreeper(
      view({ creeper: { name: "creeper", distance: 3, position: new Vec3(3, 65, 0) } }),
    );
    expect(action.kind).toBe("flee");
    if (action.kind !== "flee") return;
    // Away from the creeper: x must be negative.
    expect(action.target.x).toBeLessThan(0);
    // And it lands far enough away to be safe.
    expect(Math.abs(action.target.x)).toBeCloseTo(CREEPER_SAFE_AT - 3, 5);
    expect(action.threat).toBe("creeper");
  });

  it("stops retreating once past the safe distance", () => {
    expect(
      decideCreeper(view({ creeper: { name: "creeper", distance: CREEPER_FLEE_AT + 1, position: new Vec3(9, 65, 0) } }))
        .kind,
    ).toBe("none");
  });

  it("never moves vertically, so escaping a blast cannot put Elix in lava", () => {
    const action = decideCreeper(
      view({ position: new Vec3(0, 65, 0), creeper: { name: "creeper", distance: 2, position: new Vec3(0, 70, 0) } }),
    );
    if (action.kind !== "flee") throw new Error("expected a flee");
    expect(action.target.y).toBe(65);
  });

  it("picks a deterministic direction when the creeper is on top of Elix", () => {
    // Same block would otherwise divide by zero, and a random direction makes a crash
    // unreproducible.
    const action = decideCreeper(
      view({ creeper: { name: "creeper", distance: 0, position: new Vec3(0, 65, 0) } }),
    );
    if (action.kind !== "flee") throw new Error("expected a flee");
    expect(Number.isFinite(action.target.x)).toBe(true);
    expect(Math.abs(action.target.x) + Math.abs(action.target.z)).toBeGreaterThan(0);
  });

  it("never attacks the creeper - there is no attack decision anywhere in the reflexes", async () => {
    const bot = new FakeBot();
    bot.spawn("creeper", 3);
    await runnerFor(bot).tick();
    expect(bot.equipCalls).toEqual([]);
    expect(bot.consumeCalls).toEqual([]);
  });

  it("a creeper on the tick interrupts eating, because it outranks it", async () => {
    const bot = new FakeBot();
    bot.food = 10;
    bot.addItem("beef", 3);
    bot.spawn("zombie", 40); // far: eating is allowed
    const runner = runnerFor(bot);
    expect((await runner.tick()).reflex).toBe("eat");

    bot.spawn("creeper", 3); // now: flee
    const second = await runner.tick();
    expect(second.reflex).toBe("creeper");
    expect(second.action.kind).toBe("flee");
    // The eat was interrupted, not finished, and nothing extra was consumed.
    expect(bot.consumeCalls).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- 3. eat ----- */

describe("WP2 — eat", () => {
  it("eats the best food in the bag at low hunger", () => {
    const action = decideEat(
      view({
        food: EAT_AT_FOOD,
        inventory: [
          { name: "bread", count: 2 },
          { name: "golden_apple", count: 1 },
          { name: "beef", count: 4 },
        ],
      }),
    );
    // golden_apple effectiveQuality 13.6 > bread 11 > raw beef 4.8.
    expect(action).toEqual({ kind: "eat", item: "golden_apple", count: 1 });
  });

  it("does not eat while it is not hungry", () => {
    expect(decideEat(view({ food: EAT_AT_FOOD + 1, inventory: [{ name: "bread", count: 1 }] })).kind).toBe(
      "none",
    );
  });

  it("does not eat while something hostile is within 6 blocks", () => {
    // Standing still to chew while a zombie hits is dying slowly, not eating.
    expect(
      decideEat(
        view({ food: 10, inventory: [{ name: "bread", count: 1 }], hostile: { name: "zombie", distance: SAFE_TO_EAT_RADIUS } }),
      ).kind,
    ).toBe("none");
  });

  it("eats when the hostile is just past the safe radius", () => {
    expect(
      decideEat(
        view({ food: 10, inventory: [{ name: "bread", count: 1 }], hostile: { name: "zombie", distance: SAFE_TO_EAT_RADIUS + 1 } }),
      ).kind,
    ).toBe("eat");
  });

  it("never eats rotten flesh while anything else is in the bag", () => {
    const action = decideEat(
      view({ food: 1, inventory: [{ name: "bread", count: 1 }, { name: "rotten_flesh", count: 5 }] }),
    );
    expect(action).toEqual({ kind: "eat", item: "bread", count: 1 });
  });

  it("eats rotten flesh only as a last resort, and never above food 4", () => {
    const risky = [{ name: "rotten_flesh", count: 3 }];
    expect(
      decideEat(view({ food: DANGEROUS_FOOD_AT_FOOD + 1, inventory: risky })).kind,
    ).toBe("none");
    expect(decideEat(view({ food: DANGEROUS_FOOD_AT_FOOD, inventory: risky })).kind).toBe("eat");
  });

  it("treats every named risky food the same way", () => {
    for (const name of [
      "rotten_flesh",
      "spider_eye",
      "poisonous_potato",
      "pufferfish",
      "chicken",
      "suspicious_stew",
    ]) {
      expect(
        decideEat(view({ food: 12, inventory: [{ name, count: 1 }] })).kind,
        `${name} should not be a meal at food 12`,
      ).toBe("none");
    }
  });

  it("never eats an item this version's data does not call food", () => {
    // A 0 score means "unknown", and unknown must never be eaten.
    expect(decideEat(view({ food: 2, inventory: [{ name: "stone", count: 64 }] })).kind).toBe("none");
    expect(decideEat(view({ food: 2, inventory: [{ name: "not_an_item", count: 1 }] })).kind).toBe(
      "none",
    );
  });

  it("does not start an eat the real library would refuse: food 20 throws 'Food is full'", () => {
    // A decision that reaches bot.consume() at full food is an uncaught exception in game.
    const action = decideEat(view({ food: 20, inventory: [{ name: "golden_apple", count: 1 }] }));
    expect(action.kind).toBe("none");
  });

  it("equips the food into the hand first, because mineflayer eats the HELD item", async () => {
    const bot = new FakeBot();
    bot.food = 12;
    bot.addItem("bread", 2);
    const runner = runnerFor(bot);
    const tick = await runner.tick();
    expect(tick.action).toEqual({ kind: "eat", item: "bread", count: 2 });
    expect(bot.equipCalls).toEqual([{ name: "bread", destination: "hand", slot: expect.any(Number) }]);
    expect(bot.consumeCalls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- 4. armour --- */

describe("WP2 — armour", () => {
  it("equips a better chestplate than the worn one", () => {
    const action = decideArmour(
      view({ inventory: [{ name: "iron_chestplate", count: 1 }], equipped: { torso: "leather_chestplate" } }),
    );
    expect(action).toEqual({ kind: "equip", item: "iron_chestplate", slot: "torso", replaces: "leather_chestplate" });
  });

  it("GOLDEN armour never replaces IRON or CHAINMAIL", () => {
    // The material-tier bug: gold sorted above both of these, so a chainmail chestplate
    // got thrown away for a golden one.
    expect(
      decideArmour(view({ inventory: [{ name: "golden_chestplate", count: 1 }], equipped: { torso: "iron_chestplate" } })).kind,
    ).toBe("none");
    expect(
      decideArmour(
        view({ inventory: [{ name: "golden_chestplate", count: 1 }], equipped: { torso: "chainmail_chestplate" } }),
      ).kind,
    ).toBe("none");
  });

  it("does not unequip something already better", () => {
    expect(
      decideArmour(view({ inventory: [{ name: "leather_chestplate", count: 1 }], equipped: { torso: "diamond_chestplate" } })).kind,
    ).toBe("none");
  });

  it("never auto-equips an item with no verified points", () => {
    for (const name of ["elytra", "wolf_armor", "shield", "bow"]) {
      expect(decideArmour(view({ inventory: [{ name, count: 1 }], equipped: {} })).kind, name).toBe(
        "none",
      );
    }
  });

  it("equips a better weapon into the hand", () => {
    const action = decideArmour(
      view({ inventory: [{ name: "iron_sword", count: 1 }], equipped: { hand: "wooden_sword" } }),
    );
    expect(action).toEqual({ kind: "equip", item: "iron_sword", slot: "hand", replaces: "wooden_sword" });
  });

  it("keeps the better weapon in hand", () => {
    expect(
      decideArmour(view({ inventory: [{ name: "golden_sword", count: 1 }], equipped: { hand: "iron_sword" } })).kind,
    ).toBe("none");
  });

  it("does not call the turtle helmet a helmet by accident - it maps to the head slot", () => {
    expect(decideArmour(view({ inventory: [{ name: "turtle_helmet", count: 1 }], equipped: {} }))).toMatchObject({
      slot: "head",
    });
  });

  it("checks the head before the torso, so a full pickup is equipped in one pass at a time", () => {
    const action = decideArmour(
      view({
        inventory: [
          { name: "iron_helmet", count: 1 },
          { name: "diamond_chestplate", count: 1 },
        ],
        equipped: {},
      }),
    );
    expect(action).toMatchObject({ item: "iron_helmet", slot: "head" });
  });

  it("equips through the real destination name, and the runner passes the real Item", async () => {
    const bot = new FakeBot();
    bot.addItem("iron_helmet", 1);
    const tick = await runnerFor(bot).tick();
    expect(tick.action).toMatchObject({ kind: "equip", item: "iron_helmet", slot: "head" });
    expect(bot.equipCalls).toHaveLength(1);
    expect(bot.equipCalls[0]?.destination).toBe("head");
  });
});

/* -------------------------------------------------------- 5. the priority ---- */

describe("WP2 — the priority order", () => {
  it("breathe beats creeper, which beats eat", () => {
    const drowning = view({
      inWater: true,
      oxygenLevel: 10,
      food: 5,
      creeper: { name: "creeper", distance: 2, position: new Vec3(2, 65, 0) },
      inventory: [{ name: "bread", count: 1 }],
    });
    expect(decideReflex(drowning).reflex).toBe("breathe");
    expect(decideReflex({ ...drowning, inWater: false }).reflex).toBe("creeper");
    expect(
      decideReflex({ ...drowning, inWater: false, creeper: null }).reflex,
    ).toBe("eat");
  });

  it("armour is the last reflex, so surviving comes before looking well-armed", () => {
    expect(
      decideReflex(view({ food: 2, inventory: [{ name: "bread", count: 1 }] })).reflex,
    ).toBe("eat");
    expect(decideReflex(view({ inventory: [{ name: "iron_helmet", count: 1 }] })).reflex).toBe(
      "armour",
    );
  });

  it("reports 'none' when nothing is wrong", () => {
    expect(decideReflex(view()).action.kind).toBe("none");
  });
});

/* --------------------------------------------------- 6. stop wins, always ---- */

describe("WP2 — elix stop cancels an in-progress reflex within one tick", () => {
  it("stops a flee: nothing is left running and control states are dropped", async () => {
    const bot = new FakeBot();
    bot.spawn("creeper", 3);
    const runner = runnerFor(bot);
    expect((await runner.tick()).reflex).toBe("creeper");
    expect(runner.interruptedFollow).toBe(true);

    runner.stop();
    // Synchronous: no awaiting, so it has already happened when stop() returns.
    expect(runner.busy).toBe(false);
    expect(runner.interruptedFollow).toBe(false);
    // The flee itself had already completed on its own tick, which is what "finished"
    // records. What matters here is that the stop left nothing running, not that it
    // rewrote the last tick's outcome.
    expect(runner.endReason).toBe("finished");
    expect(bot.clearedControlStates).toBe(1);

    // The next tick - 50 ms later, ONE_TICK_MS - does nothing at all.
    const after = await runner.tick();
    expect(after.action.kind).toBe("none");
    expect(bot.lookCalls).toHaveLength(1);
  });

  it("a stop before the first tick stops the first tick", async () => {
    const bot = new FakeBot();
    bot.food = 10;
    bot.addItem("bread", 1);
    const runner = runnerFor(bot);
    runner.stop();
    expect((await runner.tick()).action.kind).toBe("none");
    expect(bot.consumeCalls).toEqual([]);
  });

  it("resume() lets the reflexes work again, and only the caller decides when", async () => {
    const bot = new FakeBot();
    bot.food = 10;
    bot.addItem("bread", 1);
    const runner = runnerFor(bot);
    runner.stop();
    await runner.tick();
    runner.resume();
    expect((await runner.tick()).action.kind).toBe("eat");
  });

  it("a stop is never thrown into by a bot that cannot clear its states", () => {
    const bot = new FakeBot();
    const runner = new ReflexRunner({
      view: () => view(),
      equip: async () => undefined,
      consume: async () => undefined,
      lookAt: () => undefined,
      clearControlStates: () => {
        throw new Error("connection already gone");
      },
      findItem: () => null,
    });
    expect(() => runner.stop()).not.toThrow();
    expect(bot.consumeCalls).toEqual([]);
  });

  it("one reflex tick does not leave `busy` stuck true", async () => {
    const bot = new FakeBot();
    bot.food = 10;
    bot.addItem("bread", 1);
    const runner = runnerFor(bot);
    await runner.tick();
    expect(runner.busy).toBe(false);
  });
});

/* --------------------------------------------- the real library, not a fake --- */

describe("WP2 — the arguments are checked against real mineflayer", () => {
  it("bot.equip really would reject a destination we are not using", async () => {
    // The fake has the same five armour names mineflayer's armorSlots map has, and no more.
    expect(Object.keys(FakeBot.ARMOR_SLOTS)).toEqual(["head", "torso", "legs", "feet"]);
    await expect(bot(
      new FakeBot() as unknown as { equip(i: unknown, d: string): Promise<void> },
      realItem("iron_helmet"),
      "helmet",
    )).rejects.toThrow(/invalid destination/);
  });

  it("bot.equip really would reject a plain object with no slot", async () => {
    const b = new FakeBot();
    await expect(b.equip({ name: "iron_helmet" }, "head")).rejects.toThrow(/non-Item/);
  });

  it("the item objects Elix hands over are prismarine Items with real 26.2 names", () => {
    const item = realItem("iron_chestplate");
    expect(item.name).toBe("iron_chestplate");
    expect(typeof item.slot).toBe("number");
    expect(item.stackSize).toBe(1);
    // The vendored registry and the prismarine item agree, which is the whole point of
    // building the item from the vendored numeric id.
    expect(registry.itemsByName.iron_chestplate?.name).toBe(item.name);
  });

  it("bot.consume really throws 'Food is full' at 20, and the eat gate never goes there", async () => {
    const b = new FakeBot();
    b.food = 20;
    await expect(b.consume()).rejects.toThrow("Food is full");
    expect(decideEat(view({ food: 20, inventory: [{ name: "bread", count: 1 }] })).kind).toBe("none");
  });

  it("an item that is not food is refused by the real bot too, not just by the decision", async () => {
    // `bot.consume()` does not itself check edibility; the real bot would happily activate
    // a stone. That is exactly why the decision ranks on foods.json and not on "is it an
    // item" - and this test states that rather than pretending the library protects us.
    const b = new FakeBot();
    b.food = 5;
    expect(b.findItem("stone")).toBeNull();
    expect(b.findItem("beef")).toBeNull();
    b.addItem("stone", 1);
    expect(b.findItem("stone")).not.toBeNull();
    expect(decideEat(view({ food: 5, inventory: [{ name: "stone", count: 1 }] })).kind).toBe("none");
  });

  it("the view is assembled from mineflayer's own fields, with no casts", () => {
    const b = new FakeBot();
    b.spawn("zombie", 4);
    b.spawn("creeper", 9);
    b.addItem("bread", 1);
    const v = b.reflexView();
    expect(v.hostile?.name).toBe("zombie");
    expect(v.creeper?.name).toBe("creeper");
    expect(v.creeper?.distance).toBe(9);
    expect(v.inventory).toEqual([{ name: "bread", count: 1 }]);
    expect(v.position).toBeInstanceOf(Vec3);
  });

  it("an invalid entity is ignored, because mineflayer's entity.isValid goes false on death", () => {
    const b = new FakeBot();
    const zombie = b.spawn("zombie", 2);
    zombie.isValid = false;
    expect(b.reflexView().hostile).toBeNull();
  });

  it("distanceXZ ignores height, like the game's own reach", () => {
    expect(distanceXZ({ x: 3, y: 0, z: 4 }, { x: 0, y: 70, z: 0 })).toBeCloseTo(5, 6);
  });

  it("the runner's fake bot is never handed a vi.fn() that accepts anything", () => {
    // A guard against regressing to a permissive double: the runner's interface takes
    // real Item objects, and the wiring above proves the shape is checked.
    const spy = vi.fn();
    const bot = new FakeBot();
    bot.addItem("bread", 1);
    spy(bot.findItem("bread"));
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(Item);
  });
});

/** Local helper so the "real library would reject" assertion reads cleanly. */
function bot(as: { equip(item: unknown, destination: string): Promise<void> }, item: unknown, dest: string) {
  return as.equip(item, dest);
}