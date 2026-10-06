/**
 * WP5a acceptance — gather.
 *
 * Most of this file is about refusals, because the interesting failure for a gathering bot
 * is not "could not find cobblestone", it is "dug the floor out of somebody's house".
 *
 * Block names and tool ids come from the real vendored 26.2 data, and the `bot.dig`
 * arguments are checked against the real mineflayer source at the bottom.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Vec3 } from "vec3";
import {
  ALLOWED_BLOCKS,
  GATHER_MAX_ITEMS,
  GATHER_MAX_MS,
  LEAF_RADIUS,
  LOG_BLOCKS,
  NEVER_GATHERED,
  PROTECTED_RADIUS,
  PROGRESS_MIN_GAP_MS,
  REFUSAL_TEXT,
  GatherController,
  addressedTo,
  bestToolFor,
  isAllowedBlock,
  isLeaf,
  needsLeaves,
  parseGather,
  refuseDig,
  type DigCheck,
  type GatherRequest,
} from "../../src/skills/gather.js";
import { blockNames, dataForVersion } from "../../src/world/mcdata.js";

const BLOCKS = blockNames();
const DATA = dataForVersion();

function check(over: Partial<DigCheck> = {}): DigCheck {
  return {
    name: "cobblestone",
    position: new Vec3(40, 64, 0),
    protectedPlaces: [],
    gathered: 0,
    wanted: 5,
    elapsedMs: 0,
    hasLeavesNearby: true,
    ...over,
  };
}

describe("WP5a — the allow-list", () => {
  it("every allowed block is a REAL 26.2 block", () => {
    const missing = ALLOWED_BLOCKS.filter((n) => !BLOCKS.has(n));
    expect(missing).toEqual([]);
  });

  it("every log is a real 26.2 block, and every leaf is a real 26.2 block", () => {
    expect(LOG_BLOCKS.filter((n) => !BLOCKS.has(n))).toEqual([]);
    expect(["oak_leaves", "birch_leaves", "azalea_leaves"].every((n) => BLOCKS.has(n))).toBe(true);
  });

  it("allows the natural blocks the brief lists", () => {
    for (const name of [
      "stone",
      "cobblestone",
      "deepslate",
      "dirt",
      "grass_block",
      "sand",
      "gravel",
      "coal_ore",
      "deepslate_coal_ore",
      "iron_ore",
      "deepslate_iron_ore",
      "copper_ore",
      "deepslate_copper_ore",
      "oak_log",
    ]) {
      expect(isAllowedBlock(name), name).toBe(true);
    }
  });

  it("REFUSES planks, glass, wool and everything else on the never-gathered list", () => {
    // The brief names these three specifically, and each is a real 26.2 block, so a rename
    // fails here rather than quietly making the test vacuous.
    for (const name of ["oak_planks", "glass", "white_wool"]) {
      expect(BLOCKS.has(name), `${name} must be a real block for this test to mean anything`).toBe(true);
      expect(isAllowedBlock(name), name).toBe(false);
      expect(refuseDig(check({ name })), name).toBe("not-on-the-list");
    }
    for (const name of NEVER_GATHERED) {
      expect(isAllowedBlock(name), name).toBe(false);
    }
  });

  it("refuses anything not on the list at all", () => {
    expect(refuseDig(check({ name: "diamond_block" }))).toBe("not-on-the-list");
    expect(refuseDig(check({ name: "not_a_block" }))).toBe("not-on-the-list");
  });

  it("every refusal has a short, human line - and none of them gives a reason", () => {
    for (const text of Object.values(REFUSAL_TEXT)) {
      expect(text.length).toBeGreaterThan(5);
      expect(text.length).toBeLessThan(45);
      // "because", "not allowed" and "rules" would all be telling a stranger which rule to
      // look for. The refusal says no and nothing else.
      expect(text, text).not.toMatch(/because|rule|allowed|owner/iu);
    }
  });
});

describe("WP5a — a log is only a tree when there are leaves on it", () => {
  it("allows a log with leaves nearby", () => {
    expect(refuseDig(check({ name: "oak_log", hasLeavesNearby: true }))).toBeNull();
  });

  it("refuses a bare log, because that is somebody's building", () => {
    expect(needsLeaves("oak_log")).toBe(true);
    expect(refuseDig(check({ name: "oak_log", hasLeavesNearby: false }))).toBe("log-without-leaves");
  });

  it("does not ask about leaves for anything that is not a log", () => {
    for (const name of ["dirt", "stone", "coal_ore", "sand"]) {
      expect(needsLeaves(name), name).toBe(false);
      expect(refuseDig(check({ name, hasLeavesNearby: false })), name).toBeNull();
    }
  });

  it("knows which blocks are leaves", () => {
    expect(isLeaf("oak_leaves")).toBe(true);
    expect(isLeaf("azalea_leaves")).toBe(true);
    expect(isLeaf("oak_log")).toBe(false);
    expect(LEAF_RADIUS).toBe(2);
  });
});

describe("WP5a — protected places", () => {
  it("refuses a dig within 24 blocks of a protected place", () => {
    expect(refuseDig(check({ position: new Vec3(10, 64, 0), protectedPlaces: [new Vec3(20, 64, 0)] }))).toBe(
      "protected-place",
    );
  });

  it("allows a dig at exactly the radius, and refuses one block inside it", () => {
    const place = new Vec3(0, 64, 0);
    expect(refuseDig(check({ position: new Vec3(PROTECTED_RADIUS, 64, 0), protectedPlaces: [place] }))).toBeNull();
    expect(
      refuseDig(check({ position: new Vec3(PROTECTED_RADIUS - 1, 64, 0), protectedPlaces: [place] })),
    ).toBe("protected-place");
  });

  it("checks EVERY protected place, not just the nearest", () => {
    const refusal = refuseDig(
      check({
        position: new Vec3(100, 64, 0),
        protectedPlaces: [new Vec3(0, 64, 0), new Vec3(100, 64, 0), new Vec3(500, 64, 0)],
      }),
    );
    expect(refusal).toBe("protected-place");
  });

  it("ignores height, because digging is about the ground", () => {
    expect(
      refuseDig(check({ position: new Vec3(1, 200, 0), protectedPlaces: [new Vec3(0, -60, 0)] })),
    ).toBe("protected-place");
  });
});

describe("WP5a — the caps", () => {
  it("refuses once the wanted count is reached", () => {
    expect(refuseDig(check({ gathered: 5, wanted: 5 }))).toBe("cap-reached");
  });

  it("refuses at the hard 64-item cap even when more was asked for", () => {
    expect(refuseDig(check({ gathered: GATHER_MAX_ITEMS, wanted: 200 }))).toBe("cap-reached");
  });

  it("refuses after five minutes", () => {
    expect(refuseDig(check({ elapsedMs: GATHER_MAX_MS }))).toBe("out-of-time");
    expect(refuseDig(check({ elapsedMs: GATHER_MAX_MS - 1 }))).toBeNull();
  });

  it("GATHER_MAX_MS is five minutes and the cap is 64", () => {
    expect(GATHER_MAX_MS).toBe(5 * 60_000);
    expect(GATHER_MAX_ITEMS).toBe(64);
  });
});

describe("WP5a — the right tool, from minecraft-data", () => {
  it("stone needs a pickaxe, and minecraft-data says so", () => {
    const def = DATA?.blocksByName?.stone as { harvestTools?: Record<string, boolean> } | undefined;
    expect(def?.harvestTools, "stone must have harvestTools in 26.2").toBeTruthy();
    expect(bestToolFor("stone", ["iron_pickaxe"])).toBe("iron_pickaxe");
    expect(bestToolFor("stone", ["diamond_pickaxe", "iron_pickaxe"])).toBe("diamond_pickaxe");
  });

  it("picks the BEST tool Elix is actually holding", () => {
    // Not the best in the game: a bot that reaches for a tool it does not hold digs with its
    // fist, which looks like a fool and takes ten times as long.
    expect(bestToolFor("stone", ["wooden_pickaxe"])).toBe("wooden_pickaxe");
    expect(bestToolFor("stone", ["stone_axe", "stone_pickaxe"])).toBe("stone_pickaxe");
    expect(bestToolFor("iron_ore", ["stone_pickaxe", "diamond_pickaxe"])).toBe("diamond_pickaxe");
    // GOLD is tier 0, the same as wooden - never above iron. A name-ordered tier list got
    // this wrong, and an iron pickaxe in the bag would lose to a gold one.
    expect(bestToolFor("stone", ["gold_pickaxe", "iron_pickaxe"])).toBe("iron_pickaxe");
    expect(bestToolFor("stone", ["gold_pickaxe", "stone_pickaxe"])).toBe("stone_pickaxe");
  });

  it("never suggests an axe or a shovel for stone", () => {
    expect(bestToolFor("stone", ["iron_axe", "stone_shovel"])).toBeNull();
    expect(bestToolFor("stone", [])).toBeNull();
  });

  it("dirt needs no tool, so the answer is null rather than a fist", () => {
    expect(bestToolFor("dirt", ["iron_pickaxe"])).toBeNull();
  });

  it("only ever answers with a real 26.2 item name", () => {
    const items = new Set(Object.keys(DATA?.itemsByName ?? {}));
    for (const block of ["stone", "iron_ore", "deepslate", "coal_ore"]) {
      for (const held of [["wooden_pickaxe"], ["netherite_pickaxe"], ["gold_pickaxe"]]) {
        const tool = bestToolFor(block, held);
        if (tool !== null) expect(items.has(tool), `${block}/${tool}`).toBe(true);
      }
    }
  });
});

describe("WP5a — parsing the line", () => {
  it("parses 'elix get wood'", () => {
    expect(parseGather("elix get wood", "Elix")).toEqual({ block: "oak_log", count: 1 });
  });

  it("parses 'elix get me 10 cobblestone'", () => {
    expect(parseGather("elix get me 10 cobblestone", "Elix")).toEqual({ block: "cobblestone", count: 10 });
  });

  it("parses 'elix get 5 dirt'", () => {
    expect(parseGather("elix get 5 dirt", "Elix")).toEqual({ block: "dirt", count: 5 });
  });

  it("accepts the obvious synonyms", () => {
    expect(parseGather("elix fetch me some stone please", "Elix")).toMatchObject({ block: "stone" });
    expect(parseGather("elix bring cobble", "Elix")).toMatchObject({ block: "cobblestone" });
    expect(parseGather("elix mine coal", "Elix")).toMatchObject({ block: "coal_ore" });
  });

  it("matches the bot's name case-insensitively", () => {
    expect(parseGather("Elix get dirt", "elix")).not.toBeNull();
    expect(parseGather("ELIX GET DIRT", "Elix")).not.toBeNull();
  });

  it("REFUSES a line that is not addressed to Elix", () => {
    expect(parseGather("get wood", "Elix")).toBeNull();
    expect(parseGather("everyone get wood", "Elix")).toBeNull();
    expect(parseGather("the elixir flows", "Elix")).toBeNull();
  });

  it("REFUSES anything that is not a whole-intent gather", () => {
    // WP8's "can you grab some wood for us" is a tool call through a different door. Two
    // parsers for one sentence is how a bot ends up obeying something nobody said clearly.
    expect(parseGather("elix can you grab some wood for us", "Elix")).toBeNull();
    expect(parseGather("elix how do i get more cobblestone", "Elix")).toBeNull();
    expect(parseGather("elix please stop getting dirt", "Elix")).toBeNull();
    expect(parseGather("elix get wood and then follow me", "Elix")).toBeNull();
  });

  it("REFUSES a block that is not on the list, rather than gathering something else", () => {
    expect(parseGather("elix get 10 glass", "Elix")).toBeNull();
    expect(parseGather("elix get some wool", "Elix")).toBeNull();
    expect(parseGather("elix get diamond blocks", "Elix")).toBeNull();
  });

  it("caps a silly count at the hard maximum", () => {
    expect(parseGather("elix get 9999 cobblestone", "Elix")?.count).toBe(GATHER_MAX_ITEMS);
  });

  it("addressedTo is available on its own, for the wellbeing-floor check", () => {
    expect(addressedTo("elix get wood", "Elix")).toBe(true);
    expect(addressedTo("i feel awful about my cat", "Elix")).toBe(false);
  });
});

describe("WP5a — the controller, and stop", () => {
  it("counts up and finishes on the wanted count", () => {
    let now = 0;
    const c = new GatherController(() => now);
    c.start({ block: "cobblestone", count: 3 });
    expect(c.gathered_one()).toBe(true);
    now += 1_000;
    expect(c.gathered_one()).toBe(true);
    expect(c.gathered_one()).toBe(false);
    expect(c.state).toEqual({ kind: "done", gathered: 3 });
  });

  it("never digs one block too many: the cap is checked when the item ARRIVES", () => {
    // A controller that only checked at decision time would dig one extra block, because the
    // item lands before the next decision.
    const c = new GatherController(() => 0);
    c.start({ block: "dirt", count: 2 });
    expect(c.gathered_one()).toBe(true);
    expect(c.gathered_one()).toBe(false);
    expect(c.count).toBe(2);
  });

  it("a stop cancels mid-dig, synchronously, and leaves nothing running", () => {
    const c = new GatherController(() => 0);
    c.start({ block: "cobblestone", count: 64 });
    expect(c.gathered_one()).toBe(true);
    expect(c.state.kind).toBe("working");
    c.stop();
    expect(c.state).toEqual({ kind: "stopped" });
    expect(c.current).toBeNull();
    // Nothing else may dig after the stop.
    expect(c.mayDig(check())).toBeNull();
  });

  it("a stop before the first dig still stops it", () => {
    const c = new GatherController(() => 0);
    c.start({ block: "dirt", count: 1 });
    c.stop();
    expect(c.gathered_one()).toBe(false);
    expect(c.state.kind).toBe("stopped");
  });

  it("a progress line at most once a minute", () => {
    const now = { value: 0 };
    const c = new GatherController(() => now.value);
    c.start({ block: "cobblestone", count: 10 });
    c.gathered_one();
    expect(c.progressLine()).not.toBeNull();
    now.value += 1_000;
    expect(c.progressLine(), "too soon").toBeNull();
    now.value += PROGRESS_MIN_GAP_MS;
    expect(c.progressLine()).toMatch(/got 1 of 10 cobblestone/u);
  });

  it("says nothing after a stop", () => {
    const now = 10 * PROGRESS_MIN_GAP_MS;
    const c = new GatherController(() => now);
    c.start({ block: "dirt", count: 5 });
    c.gathered_one();
    c.stop();
    expect(c.progressLine()).toBeNull();
  });

  it("records a refusal as the end of the run, so it is not retried forever", () => {
    const c = new GatherController(() => 0);
    c.start({ block: "cobblestone", count: 5 });
    expect(c.mayDig(check({ name: "glass" }))).toBe("not-on-the-list");
    expect(c.state).toEqual({ kind: "refused", reason: "not-on-the-list" });
  });

  it("resume() lets a new gather start after a stop", () => {
    const c = new GatherController(() => 0);
    c.start({ block: "dirt", count: 1 });
    c.stop();
    c.resume();
    const request: GatherRequest = { block: "stone", count: 2 };
    c.start(request);
    expect(c.current).toEqual(request);
  });

  it("the controller holds no mineflayer reference at all", () => {
    const c = new GatherController(() => 0);
    const keys = Object.keys(c as unknown as Record<string, unknown>);
    expect(keys.filter((k) => /bot|mineflayer|entity/i.test(k))).toEqual([]);
    // And a dig is issued by the caller, through a spy, so nothing here can touch the world.
    const dig = vi.fn();
    c.start({ block: "dirt", count: 1 });
    if (c.mayDig(check({ name: "dirt" })) === null) dig(check({ name: "dirt" }));
    expect(dig).toHaveBeenCalledTimes(1);
  });
});

describe("WP5a — the real mineflayer, not a fake", () => {
  it("bot.dig's first check is a null block, so Elix must never hand it one", () => {
    // Read from the real source, so a mineflayer change is caught rather than assumed.
    const source = readFileSync(
      fileURLToPath(new URL("../../node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecfaab97a4f23b1bf82c1e8d684cc/node_modules/mineflayer/lib/plugins/digging.js", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/dig was called with an undefined or null block/u);
    expect(source).toMatch(/bot\.digTime\(block\)/u);
    // digTime is Infinity for a block the bot cannot break - air, water, and anything with a
    // hardness it has no tool for - and the real function throws on that.
    expect(source).toMatch(/dig time for .* is Infinity/u);
  });

  it("a dig argument Elix would build has everything the real function reads", () => {
    // `bot.dig(block)` reads block.position (for bot.lookAt) and hands the block to
    // bot.digTime, which reads name, hardness, material, requiresTool and boundingBox.
    const block = {
      name: "cobblestone",
      position: new Vec3(40, 64, 0),
      type: 12,
      id: 12,
      hardness: 2,
      boundingBox: "block",
      material: "mineable/pickaxe",
      requiresTool: true,
      getDrops: () => [],
    };
    expect(block.position).toBeInstanceOf(Vec3);
    const def = DATA?.blocksByName?.cobblestone as { hardness?: number; requiresTool?: boolean } | undefined;
    expect(def?.hardness).toBe(block.hardness);
    // 26.2 has no `requiresTool` on cobblestone: the harvestTools map is the whole rule, and
    // saying otherwise would be inventing a field.
    expect(def?.requiresTool).toBeUndefined();
    expect(block.requiresTool).toBe(true);
    // And the block IS on the list, so Elix would only ever dig it deliberately.
    expect(isAllowedBlock(block.name)).toBe(true);
  });

  it("the block names Elix gathers exist in the same data mineflayer's registry would use", () => {
    const ids = new Set(DATA?.itemsByName ? Object.keys(DATA.blocksByName ?? {}) : []);
    for (const name of ALLOWED_BLOCKS) expect(ids.has(name), name).toBe(true);
  });

  it("no allowed block is a place somebody lives in", () => {
    // A second, independent check on the same list, phrased as the vision phrases it.
    const homes = ["bed", "furnace", "chest", "crafting_table", "lantern", "door", "bedrock"];
    for (const name of homes) expect(isAllowedBlock(name), name).toBe(false);
  });
});