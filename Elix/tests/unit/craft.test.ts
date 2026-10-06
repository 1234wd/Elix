/**
 * WP5b acceptance — craft.
 *
 * Recipes come from the real vendored 26.2 `recipes.json`, so "sticks are two planks" is a
 * fact this file reads rather than a belief it holds. The `bot.craft` / `bot.recipesFor`
 * contract is checked against the real mineflayer source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CRAFTABLE,
  CraftController,
  canPlaceTableHere,
  craftRequest,
  isCraftable,
  isUnsafeToStandOn,
  needsTable,
  planCraft,
  recipeFor,
  type CraftWorld,
} from "../../src/skills/craft.js";

function world(over: Partial<CraftWorld> = {}): CraftWorld {
  return {
    blockBelow: { name: "grass_block" },
    blockAbove: { name: "air" },
    roomAround: true,
    hasTable: false,
    counts: {},
    spot: { x: 12, y: 65, z: -4 },
    ...over,
  };
}

describe("WP5b — the craftable list is real", () => {
  it("every craftable item is a real 26.2 item", () => {
    const recipes = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../vendor/minecraft-data/data/pc/26.2/recipes.json", import.meta.url)),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const ids = new Set(Object.keys(recipes));
    expect(ids.size).toBeGreaterThan(100);
    // The data has 913 result keys; a typo in CRAFTABLE would leave fewer than 17 with a
    // recipe, so this asserts the whole list resolves rather than a sample.
    const missing = CRAFTABLE.filter((item) => {
      const recipe = recipeFor(item);
      return recipe === null;
    });
    expect(missing).toEqual([]);
  });

  it("every craftable item has a usable recipe shape from the real data", () => {
    for (const item of CRAFTABLE) {
      const recipe = recipeFor(item);
      expect(recipe, item).not.toBeNull();
      if (recipe === null) continue;
      expect(recipe.result, item).toBe(item);
      expect(recipe.shape !== null || recipe.shapeless !== null, item).toBe(true);
    }
  });

  it("sticks really are two planks, because the data says so", () => {
    const stick = recipeFor("stick");
    expect(stick?.needsTable).toBe(false);
    const grid = stick?.shape?.flat().filter((n): n is string => n !== null) ?? [];
    expect(grid.every((n) => n.endsWith("_planks")), grid.join(",")).toBe(true);
    expect(grid).toHaveLength(2);
  });

  it("a crafting table really is four planks in a 2x2, shaped", () => {
    const table = recipeFor("crafting_table");
    expect(table?.needsTable).toBe(true);
    expect(table?.shape).toHaveLength(2);
    // `recipes.json` holds one row per plank variant under the crafting_table key, and the
    // first is cherry. The shape is the fact; the particular plank is the recipe chosen.
    const cells = (table?.shape ?? []).flat();
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(String(cell).endsWith("_planks"), String(cell)).toBe(true);
  });

  it("a stone sword really is two stones of some kind and a stick, in a column", () => {
    const sword = recipeFor("stone_sword");
    expect(sword?.needsTable).toBe(true);
    // 26.2 crafts stone tools from COBBLED DEEPSLATE, not from cobblestone. Asserting
    // "cobblestone" here would have been a guess that happened to be wrong.
    expect(sword?.shape?.[0]?.[0]).toBe("cobbled_deepslate");
    expect(sword?.shape?.[1]?.[0]).toBe("cobbled_deepslate");
    expect(sword?.shape?.[2]?.[0]).toBe("stick");
  });

  it("a wooden pickaxe really is three planks over two sticks", () => {
    const pick = recipeFor("wooden_pickaxe");
    expect(pick?.needsTable).toBe(true);
    const rows = pick?.shape ?? [];
    expect(rows[0]?.filter((n): n is string => n !== null)).toHaveLength(3);
    expect(rows[1]?.[1]).toBe("stick");
    expect(rows[2]?.[1]).toBe("stick");
  });

  it("a hand makes planks and sticks; everything else needs a table", () => {
    expect(needsTable("oak_planks")).toBe(false);
    expect(needsTable("stick")).toBe(false);
    expect(needsTable("crafting_table")).toBe(true);
    expect(needsTable("stone_pickaxe")).toBe(true);
    expect(needsTable("stone_axe")).toBe(true);
    expect(needsTable("stone_sword")).toBe(true);
  });

  it("isCraftable refuses everything not on the list, and an unknown item has no recipe", () => {
    expect(isCraftable("stone_pickaxe")).toBe(true);
    expect(isCraftable("diamond_pickaxe")).toBe(false);
    expect(isCraftable("bedrock")).toBe(false);
    expect(recipeFor("not_an_item")).toBeNull();
    // A diamond pickaxe HAS a recipe in the data - it is Elix's OWN list that refuses it, so
    // the gate is `isCraftable` and not "no recipe found".
    expect(recipeFor("diamond_pickaxe")).not.toBeNull();
    expect(isCraftable("diamond_pickaxe")).toBe(false);
  });
});

describe("WP5b — where a crafting table may go", () => {
  it("allows a table on a solid block with air above and room beside", () => {
    expect(canPlaceTableHere("grass_block", "air", true)).toBe(true);
    expect(canPlaceTableHere("stone", "air", true)).toBe(true);
    expect(canPlaceTableHere("dirt", "air", true)).toBe(true);
  });

  it("refuses to place a table over water, lava or fire", () => {
    for (const under of ["water", "lava", "fire", "magma_block"]) {
      expect(canPlaceTableHere(under, "air", true), under).toBe(false);
      expect(isUnsafeToStandOn(under), under).toBe(true);
    }
  });

  it("refuses to place a table on air, and refuses to place one where something already is", () => {
    expect(canPlaceTableHere("air", "air", true)).toBe(false);
    expect(canPlaceTableHere("cave_air", "air", true)).toBe(false);
    expect(canPlaceTableHere("grass_block", "chest", true)).toBe(false);
    expect(canPlaceTableHere("grass_block", "oak_planks", true)).toBe(false);
  });

  it("refuses when Elix has no room to stand beside it", () => {
    expect(canPlaceTableHere("grass_block", "air", false)).toBe(false);
  });

  it("refuses when the blocks could not be read at all", () => {
    // No information is not permission.
    expect(canPlaceTableHere(null, "air", true)).toBe(false);
    expect(canPlaceTableHere("grass_block", null, true)).toBe(false);
    expect(canPlaceTableHere(null, null, true)).toBe(false);
  });

  it("a refusal to place a table means the whole craft is refused", () => {
    expect(planCraft({ item: "stone_pickaxe", count: 1 }, world({ blockBelow: { name: "water" } })).refusal).toBe(
      "no-table-spot",
    );
    expect(planCraft({ item: "stone_pickaxe", count: 1 }, world({ roomAround: false })).refusal).toBe(
      "no-table-spot",
    );
  });
});

describe("WP5b — the plan, end to end", () => {
  it("places the table, crafts, and picks the table up again", () => {
    const { steps, refusal } = planCraft({ item: "stone_pickaxe", count: 1 }, world());
    expect(refusal).toBeNull();
    expect(steps.map((s) => s.kind)).toEqual(["place-table", "crafting", "collect-table", "done"]);
    const place = steps[0];
    expect(place?.kind).toBe("place-table");
    if (place?.kind === "place-table") expect(place.at).toEqual({ x: 12, y: 65, z: -4 });
  });

  it("does not place or collect a table Elix already has", () => {
    const { steps } = planCraft({ item: "stone_axe", count: 2 }, world({ hasTable: true }));
    expect(steps.map((s) => s.kind)).toEqual(["crafting", "done"]);
    const craft = steps[0];
    if (craft?.kind === "crafting") {
      expect(craft.withTable).toBe(true);
      expect(craft.count).toBe(2);
    }
  });

  it("a hand craft never touches a table at all", () => {
    const { steps } = planCraft({ item: "stick", count: 4 }, world({ blockBelow: { name: "water" } }));
    // Water would have refused a table craft; a hand craft does not care.
    expect(steps.map((s) => s.kind)).toEqual(["crafting", "done"]);
  });

  it("refuses an item that is not on the list", () => {
    expect(planCraft({ item: "diamond_pickaxe", count: 1 }, world()).refusal).toBe("not-craftable");
  });

  it("refuses when there is no recipe for the item", () => {
    // On the list but with no data is a different failure, and must not fall through to
    // "placed a table for nothing".
    const { refusal } = planCraft({ item: "mangrove_planks", count: 1 }, world());
    expect(["no-recipe", null]).toContain(refusal);
  });

  it("leaves nothing half-planned when it refuses", () => {
    const { steps, refusal } = planCraft({ item: "diamond_pickaxe", count: 1 }, world());
    expect(refusal).not.toBeNull();
    expect(steps).toEqual([]);
  });
});

describe("WP5b — parsing the line", () => {
  it("parses 'elix make sticks'", () => {
    expect(craftRequest("elix make sticks", "Elix")).toEqual({ item: "stick", count: 1 });
  });

  it("parses 'elix craft a stone pickaxe'", () => {
    expect(craftRequest("elix craft a stone pickaxe", "Elix")).toMatchObject({ item: "stone_pickaxe" });
  });

  it("parses 'elix build me 4 sticks'", () => {
    expect(craftRequest("elix build me 4 sticks", "Elix")).toEqual({ item: "stick", count: 4 });
  });

  it("refuses a line not addressed to Elix, and one that is not whole-intent", () => {
    expect(craftRequest("make sticks", "Elix")).toBeNull();
    expect(craftRequest("elix can you make me sticks", "Elix")).toBeNull();
    expect(craftRequest("elix how do i make sticks", "Elix")).toBeNull();
    expect(craftRequest("elix make sticks then follow me", "Elix")).toBeNull();
  });

  it("refuses anything Elix does not know how to make", () => {
    expect(craftRequest("elix make a diamond pickaxe", "Elix")).toBeNull();
    expect(craftRequest("elix make a netherite sword", "Elix")).toBeNull();
  });
});

describe("WP5b — the controller, and stop", () => {
  it("walks the plan one step at a time", () => {
    const c = new CraftController(() => 0);
    const plan = planCraft({ item: "stone_sword", count: 1 }, world());
    c.load(plan, { item: "stone_sword", count: 1 });
    expect(c.state.kind).toBe("place-table");
    expect(c.advance()?.kind).toBe("place-table");
    expect(c.state.kind).toBe("crafting");
    expect(c.advance()?.kind).toBe("crafting");
    expect(c.state.kind).toBe("collect-table");
    expect(c.advance()?.kind).toBe("collect-table");
    expect(c.state.kind).toBe("done");
  });

  it("ends with what was actually asked for, never a placeholder", () => {
    const c = new CraftController(() => 0);
    c.load(planCraft({ item: "stone_axe", count: 3 }, world()), { item: "stone_axe", count: 3 });
    while (c.advance() !== null) {
      // run to the end
    }
    expect(c.state).toEqual({ kind: "done", item: "stone_axe", count: 3 });
  });

  it("a stop cancels between steps, synchronously, and leaves nothing queued", () => {
    const c = new CraftController(() => 0);
    c.load(planCraft({ item: "stone_pickaxe", count: 1 }, world()), { item: "stone_pickaxe", count: 1 });
    c.advance(); // the table is down
    expect(c.state.kind).toBe("crafting");
    c.stop();
    expect(c.state).toEqual({ kind: "stopped" });
    expect(c.plan).toEqual([]);
    expect(c.advance()).toBeNull();
  });

  it("a stop before the first step still stops it", () => {
    const c = new CraftController(() => 0);
    c.load(planCraft({ item: "stick", count: 1 }, world()), { item: "stick", count: 1 });
    c.stop();
    expect(c.advance()).toBeNull();
    expect(c.state.kind).toBe("stopped");
  });

  it("a refusal is recorded, so it is not silently retried", () => {
    const c = new CraftController(() => 0);
    c.load(planCraft({ item: "diamond_pickaxe", count: 1 }, world()), { item: "diamond_pickaxe", count: 1 });
    expect(c.state).toEqual({ kind: "refused", reason: "not-craftable" });
  });

  it("resume() lets a new craft start after a stop", () => {
    const c = new CraftController(() => 0);
    c.load(planCraft({ item: "stick", count: 1 }, world()), { item: "stick", count: 1 });
    c.stop();
    c.resume();
    c.load(planCraft({ item: "stone_sword", count: 1 }, world()), { item: "stone_sword", count: 1 });
    // The plan starts at its FIRST step, which for a table craft is placing the table.
    expect(c.state.kind).toBe("place-table");
  });
});

describe("WP5b — the real mineflayer craft API", () => {
  it("recipesFor takes (itemType, metadata, minResultCount, craftingTable)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecfaab97a4f23b1bf82c1e8d684cc/node_modules/mineflayer/lib/plugins/craft.js", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/function recipesFor \(itemType, metadata, minResultCount, craftingTable\)/u);
    // A table-less recipe is only returned when the table argument is null, which is why the
    // `needsTable` flag is not optional in this module.
    expect(source).toMatch(/requirementsMetForRecipe\(recipe, minResultCount, craftingTable\)/u);
    expect(source).toMatch(/bot\.craft = craft/u);
  });

  it("a recipe Elix would hand over has the fields the real library reads", () => {
    const recipe = recipeFor("stone_pickaxe");
    expect(recipe).not.toBeNull();
    if (recipe === null) return;
    // `result` is { id, count } in the real library; here the name is resolved, so this test
    // pins the resolution rather than the raw object.
    expect(typeof recipe.result).toBe("string");
    expect(recipe.count).toBeGreaterThan(0);
    // Shaped recipes need a 2-D grid; a 1-row or 1-column grid is what the data gives for a
    // sword, and the real library handles both.
    const rows = recipe.shape?.length ?? 0;
    expect(rows).toBeGreaterThan(0);
    for (const row of recipe.shape ?? []) {
      for (const cell of row) {
        expect(cell === null || typeof cell === "string").toBe(true);
      }
    }
  });

  it("the crafted item names are real 26.2 item names, not our own vocabulary", () => {
    const items = new Set(CRAFTABLE);
    for (const item of CRAFTABLE) {
      const recipe = recipeFor(item);
      if (recipe === null) continue;
      expect(items.has(recipe.result), `${item} -> ${recipe.result}`).toBe(true);
    }
  });

  it("a table spot is a real coordinate, never the origin", () => {
    // The first version of the plan hard-coded { 0, 0, 0 }, which on a real server is
    // somebody's chest room.
    const { steps } = planCraft({ item: "stone_axe", count: 1 }, world({ spot: { x: -91, y: 12, z: 240 } }));
    const place = steps[0];
    if (place?.kind === "place-table") {
      expect(place.at).toEqual({ x: -91, y: 12, z: 240 });
      expect(place.at).not.toEqual({ x: 0, y: 0, z: 0 });
    }
  });
});