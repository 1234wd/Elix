/**
 * R19-B — every line of `docs/MINEFLAYER_CONTRACTS.md`, checked against the REAL library.
 *
 * A contract file that nothing checks is a comment. Each assertion below reads the installed
 * mineflayer (source text or documented behaviour) and fails if the library ever disagrees, so a
 * version bump that changes an API breaks the build here rather than in a game.
 *
 * The same test also asserts that `tests/helpers/realSpeedBot.ts` obeys every line - a fake that
 * breaks a contract would let the runtime be wrong and still look green, which is exactly how
 * Round 18 shipped.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { RealSpeedBot, mcData } from "../helpers/realSpeedBot.js";

// The SANCTIONED way to reach a real library file (R18-A): resolve the package root and join
// from there. A hand-rolled root plus string concatenation silently produced a path with the
// file separator missing, and two assertions failed on a truncated path that said nothing.
import { mineflayerSourceText } from "./mineflayerPaths.js";

/** The real mineflayer-pathfinder source, resolved the same way. */
function pathfinderSourceText(...parts: string[]): string {
  // `dirname`, never a string replace: stripping "/package.json" takes the path SEPARATOR with
  // it, and the failure that follows is an ENOENT on a path with no file name in it at all.
  const root = dirname(createRequire(import.meta.url).resolve("mineflayer-pathfinder/package.json"));
  return readFileSync(join(root, ...parts), "utf8");
}

const mf = (...parts: string[]): string => mineflayerSourceText(...parts);
const pf = (...parts: string[]): string => pathfinderSourceText(...parts);

describe("R19-B — searching", () => {
  it("findBlocks returns COORDINATES, not blocks", () => {
    expect(mf("docs", "api.md")).toMatch(/the found block coordinates \(not the blocks\)/u);
    expect(mf("lib", "plugins", "blocks.js")).toMatch(/bot\.findBlocks = \(options\)/u);
  });

  it("findBlock returns a Block", () => {
    expect(mf("docs", "api.md")).toMatch(/#### bot\.findBlock\(/u);
  });

  it("the shared fake obeys the line", () => {
    const bot = new RealSpeedBot();
    bot.world.set("3,63,0", "dirt");
    const found = bot.findBlocks({ matching: (b: unknown) => (b as { name?: string }).name === "dirt" });
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(typeof entry.x, "findBlocks must return coordinates, not blocks").toBe("number");
      expect((entry as { name?: unknown }).name).toBeUndefined();
    }
  });

  it("findBlock on the shared fake returns a Block", () => {
    const bot = new RealSpeedBot();
    bot.world.set("3,63,0", "dirt");
    const block = bot.findBlock({ matching: (b: unknown) => (b as { name?: string }).name === "dirt" });
    expect(block?.name).toBe("dirt");
  });
});

describe("R19-B — containers and placement", () => {
  it("openContainer needs a Block or an Entity", () => {
    expect(mf("docs", "api.md")).toMatch(/#### bot\.openContainer\(containerBlock or containerEntity/u);
    expect(mf("lib", "plugins", "chest.js")).toMatch(/async function openContainer \(containerToOpen/u);
  });

  it("the shared fake REJECTS a coordinate, like the real one", async () => {
    const bot = new RealSpeedBot();
    await expect(bot.openContainer({ x: 1, y: 2, z: 3 } as never)).rejects.toThrow(/needs a Block/u);
  });

  it("window.deposit takes (itemType, metadata, count, nbt)", () => {
    expect(mf("docs", "api.md")).toMatch(/window\.deposit\(itemType, metadata, count, nbt\)/u);
  });

  it("placeBlock takes (referenceBlock, faceVector) and places the HELD item", () => {
    expect(mf("lib", "plugins", "place_block.js")).toMatch(/async function placeBlock \(referenceBlock, faceVector\)/u);
    expect(mf("lib", "plugins", "generic_place.js")).toMatch(/bot\.heldItem/u);
  });

  it("the shared fake places the held item, and only that", async () => {
    const bot = new RealSpeedBot();
    const support = bot.blockAt({ x: 1, y: 63, z: 0 });
    await expect(bot.placeBlock(support as never, { x: 0, y: 1, z: 0 })).rejects.toThrow(/No block has been placed/u);
    bot.heldItem = { name: "crafting_table", type: 1, count: 1, slot: 0 };
    await bot.placeBlock(support as never, { x: 0, y: 1, z: 0 });
    expect((bot.blockAt({ x: 1, y: 64, z: 0 }) as { name?: string }).name).toBe("crafting_table");
  });
});

describe("R19-B — digging", () => {
  it("a second dig aborts the one in flight", () => {
    expect(mf("lib", "plugins", "digging.js")).toMatch(/stopDigging\(\)/u);
  });

  it("bot.stopDigging exists", () => {
    expect(mf("lib", "plugins", "digging.js")).toMatch(/stopDigging/u);
  });

  it("the shared fake aborts, and counts the abort", async () => {
    const bot = new RealSpeedBot();
    const block = bot.blockAt({ x: 2, y: 63, z: 0 });
    const first = bot.dig(block as never);
    bot.dig(block as never);
    await expect(first).rejects.toThrow(/Digging aborted/u);
    expect(bot.abortedDigs).toBe(1);
  });

  it("a dig from out of reach is counted as out of reach", () => {
    const bot = new RealSpeedBot();
    bot.world.set("40,63,0", "dirt");
    const far = bot.blockAt({ x: 40, y: 63, z: 0 });
    void bot.dig(far as never).catch(() => {});
    expect(bot.outOfReachDigs, "the fake must measure reach the way mineflayer does").toBe(1);
  });
});

describe("R19-B — pathfinding", () => {
  it("setGoal resets the path and clears the control states", () => {
    expect(pf("index.js")).toMatch(/resetPath\('goal_updated'\)/u);
    expect(pf("index.js")).toMatch(/clearStates/u);
  });

  it("the shared fake counts a goal reset while a walk is in flight", () => {
    const bot = new RealSpeedBot();
    bot.pathfinder.setGoal({ x: 5, y: 64, z: 0 });
    bot.pathfinder.setGoal({ x: 5, y: 64, z: 0 });
    expect(bot.goalResets, "a re-issued goal must reset the walk, or the runtime test is a lie").toBe(1);
  });

  it("GoalNear takes four numbers", () => {
    expect(pf("lib", "goals.js")).toMatch(/class GoalNear extends Goal \{[\s\S]{0,200}constructor \(x, y, z, range\)/u);
  });

  it("GoalGetToBlock takes three numbers", () => {
    expect(pf("lib", "goals.js")).toMatch(/constructor \(x, y, z\)[\s\S]{0,200}Math\.floor/u);
  });
});

describe("R19-B — inventory", () => {
  it("toss takes (itemType, metadata, count) and has no zero guard", () => {
    const source = mf("lib", "plugins", "simple_inventory.js");
    expect(source).toMatch(/async function toss \(itemType, metadata, count\)/u);
    expect(source.slice(source.indexOf("async function toss"), source.indexOf("async function toss") + 700)).not.toMatch(
      /count === 0|!count/u,
    );
  });

  it("equip sets heldItem", async () => {
    const bot = new RealSpeedBot();
    await bot.equip({ name: "stone_axe", type: 1, count: 1, slot: 36 }, "hand");
    expect((bot.heldItem as { name?: string }).name).toBe("stone_axe");
  });
});

describe("R19-B — crafting", () => {
  it("recipesFor is synchronous and returns an array", () => {
    const source = mf("lib", "plugins", "craft.js");
    const body = source.slice(source.indexOf("function recipesFor ("));
    expect(body.slice(0, 400)).not.toMatch(/async/u);
    expect(body.slice(0, 900)).toMatch(/return results/u);
  });

  it("craft throws without a table when the recipe needs one", () => {
    expect(mf("lib", "plugins", "craft.js")).toMatch(/Recipe requires craftingTable, but one was not supplied/u);
  });

  it("the shared fake obeys both lines", async () => {
    const bot = new RealSpeedBot();
    const pickaxe = mcData.itemsByName["wooden_pickaxe"]!;
    expect(bot.recipesFor(pickaxe.id, null, 1, null), "a 3x3 recipe with no table must yield nothing").toEqual([]);
    const [recipe] = bot.recipesFor(pickaxe.id, null, 1, { name: "crafting_table", position: { x: 0, y: 0, z: 0 } });
    await expect(bot.craft(recipe as never, 1, { name: "crafting_table" })).rejects.toThrow(
      /Recipe requires craftingTable/u,
    );
  });

  it("a 2x2 recipe needs no table - crafting_table itself is one", () => {
    const rows = mcData.recipes[mcData.itemsByName["crafting_table"]!.id] as Array<{ inShape?: number[][] }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.inShape).toHaveLength(2);
    expect(rows[0]?.inShape?.[0]).toHaveLength(2);
  });
});

describe("R19-B — living", () => {
  it("oxygenLevel is air / 15, so it is 0-20", () => {
    expect(mf("lib", "plugins", "breath.js")).toMatch(/bot\.oxygenLevel = Math\.round\(metadata\.value \/ 15\)/u);
  });

  it("health and food are 0-20", () => {
    expect(mf("docs", "api.md")).toMatch(/#### bot\.health[\s\S]{0,200}\[0, 20\]/u);
    expect(mf("docs", "api.md")).toMatch(/#### bot\.food[\s\S]{0,200}\[0, 20\]/u);
  });

  it("the shared fake's scales match those lines", () => {
    const bot = new RealSpeedBot();
    expect(bot.health).toBe(20);
    expect(bot.food).toBe(20);
    expect(bot.oxygenLevel).toBe(20);
  });

  it("whisper takes (username, message)", () => {
    expect(mf("docs", "api.md")).toMatch(/#### bot\.whisper\(username, message\)/u);
  });
});

describe("R19-B — the contract file itself", () => {
  const doc = readFileSync("docs/MINEFLAYER_CONTRACTS.md", "utf8");

  it("covers every API the brief names", () => {
    for (const api of [
      "findBlocks",
      "findBlock",
      "openContainer",
      "placeBlock",
      "stopDigging",
      "setGoal",
      "GoalNear",
      "GoalGetToBlock",
      "toss",
      "recipesFor",
      "craft",
      "oxygenLevel",
      "whisper",
    ]) {
      expect(doc, `docs/MINEFLAYER_CONTRACTS.md does not mention ${api}`).toContain(api);
    }
  });

  it("says findBlocks returns coordinates, in as many words", () => {
    expect(doc).toMatch(/findBlocks[\s\S]{0,200}COORDINATES/u);
  });

  it("says placeBlock places the HELD item", () => {
    expect(doc).toMatch(/placeBlock[\s\S]{0,300}holding/u);
  });

  it("says setGoal resets the path", () => {
    expect(doc).toMatch(/setGoal[\s\S]{0,200}[Rr]esets the path/u);
  });
});
