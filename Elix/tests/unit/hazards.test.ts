/**
 * A1 — HAZARD_BLOCKS must match the vendored 26.2 block data.
 *
 * Two directions of error were reported:
 *   - invented names that do not exist in 26.2 (flowing_sulfur, sulfur_vent, …)
 *   - ordinary building blocks wrongly listed as hazards (sulfur, cinnabar),
 *     which made Elix refuse to walk anywhere in a sulfur cave
 *
 * These tests load vendor/minecraft-data/data/pc/26.2/blocks.json and assert
 * both, so the list cannot drift away from the data again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HAZARD_BLOCKS,
  HAZARD_PASSABLE_REJECTS,
  isSafeFloor,
  isPassable,
} from "../../src/connection/bot.js";

interface BlockDef {
  name: string;
  boundingBox: string;
  id: number;
}

const BLOCKS: BlockDef[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "vendor/minecraft-data/data/pc/26.2/blocks.json"), "utf8"),
) as BlockDef[];

const BY_NAME = new Map(BLOCKS.map((b) => [b.name, b]));

/** The real block definition from the vendored data, not a hand-made stub. */
function block(name: string): BlockDef {
  const b = BY_NAME.get(name);
  if (!b) throw new Error(`no such block in 26.2 data: ${name}`);
  return b;
}

describe("A1 — every hazard name exists in the vendored 26.2 block data", () => {
  it("loads the real block list (guards against an empty fixture)", () => {
    expect(BLOCKS.length).toBe(1196);
  });

  it("has no invented block names", () => {
    for (const name of HAZARD_BLOCKS) {
      expect(BY_NAME.has(name), `HAZARD_BLOCKS contains "${name}", which is not in 26.2`).toBe(true);
    }
  });

  it("does not list the four names that were reported as invented", () => {
    for (const name of ["flowing_lava", "flowing_sulfur", "sulfur_vent", "cinnabar_block"]) {
      expect(HAZARD_BLOCKS, name).not.toContain(name);
      // And they really are absent from the data, so this is not a naming quibble.
      expect(BY_NAME.has(name), name).toBe(false);
    }
  });

  it("includes the real dangers that were reported missing", () => {
    for (const name of ["cactus", "pointed_dripstone", "cobweb", "water", "bubble_column", "potent_sulfur"]) {
      expect(HAZARD_BLOCKS, name).toContain(name);
    }
  });
});

describe("A1 — sulfur and cinnabar are ordinary rock, not hazards", () => {
  it("does not list sulfur or cinnabar as a hazard", () => {
    expect(HAZARD_BLOCKS).not.toContain("sulfur");
    expect(HAZARD_BLOCKS).not.toContain("cinnabar");
  });

  it("confirms the vendored data really does call them solid blocks", () => {
    for (const name of ["sulfur", "cinnabar", "sulfur_bricks", "cinnabar_bricks", "polished_sulfur"]) {
      expect(BY_NAME.get(name)?.boundingBox, name).toBe("block");
    }
  });

  it("treats a sulfur floor as safe", () => {
    expect(isSafeFloor(block("sulfur"))).toBe(true);
  });

  it("treats a cinnabar_bricks floor as safe", () => {
    expect(isSafeFloor(block("cinnabar_bricks"))).toBe(true);
  });

  it("treats the other sulfur and cinnabar building blocks as safe too", () => {
    for (const name of [
      "sulfur_slab", "sulfur_stairs", "sulfur_bricks", "sulfur_brick_slab",
      "polished_sulfur", "chiseled_sulfur", "cinnabar", "cinnabar_bricks",
      "polished_cinnabar", "chiseled_cinnabar", "cinnabar_wall",
    ]) {
      expect(isSafeFloor(block(name)), name).toBe(true);
    }
  });
});

describe("A1 — solid hazards are still hazards", () => {
  it("treats a cactus floor as unsafe", () => {
    expect(isSafeFloor(block("cactus"))).toBe(false);
  });

  it("treats pointed_dripstone as unsafe", () => {
    expect(isSafeFloor(block("pointed_dripstone"))).toBe(false);
  });

  it("treats magma_block as unsafe", () => {
    expect(isSafeFloor(block("magma_block"))).toBe(false);
  });

  it("treats lava as unsafe (its boundingBox is empty, so only the name saves us)", () => {
    expect(BY_NAME.get("lava")!.boundingBox).toBe("empty");
    expect(isSafeFloor(block("lava"))).toBe(false);
  });

  it("treats potent_sulfur as unsafe — it emits nausea-inducing gas and can erupt", () => {
    // Minecraft Wiki (26.2): potent sulfur "produces noxious gas … Nausea" under
    // shallow water and becomes a geyser where magma is below it.
    // https://minecraft.wiki/wiki/Potent_Sulfur
    expect(isSafeFloor(block("potent_sulfur"))).toBe(false);
  });

  it("treats a sulfur_spike as solid, not a hazard — the fall hazard is overhead", () => {
    // The vendored data says boundingBox "block", so it is legitimate footing.
    // The danger is the ceiling-hanging kind, which is a head-height concern:
    // isPassable rejects it because it is solid.
    expect(BY_NAME.get("sulfur_spike")!.boundingBox).toBe("block");
    expect(isSafeFloor(block("sulfur_spike"))).toBe(true);
    expect(isPassable(block("sulfur_spike"))).toBe(false);
  });
});

describe("A1 — liquids are not passable even though their boundingBox is empty", () => {
  it("confirms those blocks really are boundingBox=empty, which is why a second list is needed", () => {
    // This is the exact reason HAZARD_PASSABLE_REJECTS exists: an empty
    // bounding box means the generic passability check says "walk on through".
    for (const name of ["water", "bubble_column", "cobweb", "fire", "lava"]) {
      expect(BY_NAME.get(name)?.boundingBox, name).toBe("empty");
    }
  });

  it("rejects water and bubble_column as passable", () => {
    expect(isPassable(block("water"))).toBe(false);
    expect(isPassable(block("bubble_column"))).toBe(false);
  });

  it("rejects cobweb and fire as passable", () => {
    expect(isPassable(block("cobweb"))).toBe(false);
    expect(isPassable(block("fire"))).toBe(false);
  });

  it("has water and bubble_column in the passable-rejects list", () => {
    expect(HAZARD_PASSABLE_REJECTS).toContain("water");
    expect(HAZARD_PASSABLE_REJECTS).toContain("bubble_column");
  });

  it("still allows ordinary air, cave_air, grass and torches through", () => {
    for (const name of ["air", "cave_air", "short_grass", "torch", "dandelion"]) {
      if (!BY_NAME.has(name)) continue;
      expect(isPassable(block(name)), name).toBe(true);
    }
  });
});
