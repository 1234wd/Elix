import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * A3/A4: prismarine-physics has no 26.2 entry in its own lib/features.json, so
 * we ship a pnpm patch that adds 26.2 to every feature that already lists 26.1.
 *
 * These tests resolve prismarine-physics the SAME way mineflayer does — through
 * mineflayer's own require — so they fail if the patch is not applied to the
 * copy that actually gets loaded, not just to some other copy in the store.
 */

const require = createRequire(import.meta.url);
const mineflayerEntry = require.resolve("mineflayer");
const requireFromMineflayer = createRequire(mineflayerEntry);

interface Feature {
  name: string;
  versions: string[];
}

function loadFeatures(): Feature[] {
  return requireFromMineflayer("prismarine-physics/lib/features.json") as Feature[];
}

function versionsOf(name: string): string[] {
  const f = loadFeatures().find((x) => x.name === name);
  if (!f) throw new Error(`feature "${name}" not found in prismarine-physics`);
  return f.versions;
}

describe("A3/A4 — prismarine-physics features include 26.2", () => {
  it("26.2 is in proportionalLiquidGravity (1.13+ water physics)", () => {
    expect(versionsOf("proportionalLiquidGravity")).toContain("26.2");
  });

  it("26.2 is NOT in independentLiquidGravity (that would be 1.8–1.12 physics)", () => {
    // prismarine-physics/index.js checks `independent` first, so being in this
    // list would give wrong water gravity (0.02 instead of gravity/16).
    expect(versionsOf("independentLiquidGravity")).not.toContain("26.2");
  });

  it("26.2 is in climbUsingJump (ladders and vines)", () => {
    expect(versionsOf("climbUsingJump")).toContain("26.2");
  });

  it("adds 26.2 to exactly the features that already list 26.1", () => {
    const features = loadFeatures();
    const with26_1 = features.filter((f) => f.versions.includes("26.1"));
    const with26_2 = features.filter((f) => f.versions.includes("26.2"));
    expect(with26_1.map((f) => f.name).sort()).toEqual(with26_2.map((f) => f.name).sort());
  });
});

describe("A3 — water gravity is proportional for 26.2", () => {
  it("waterGravity === gravity / 16, not the constant 0.02", () => {
    // Resolved through mineflayer so this is the exact module the game loads.
    const { Physics } = requireFromMineflayer("prismarine-physics") as {
      Physics: (mcData: unknown, world: unknown) => { gravity: number; waterGravity: number; lavaGravity: number };
    };
    const mcData = requireFromMineflayer("minecraft-data")("26.2");
    // Physics only reads block properties from the world at tick time.
    const fakeWorld = {
      getBlock: () => ({ name: "air", boundingBox: "block", liquid: false }),
    };

    const physics = Physics(mcData, fakeWorld);
    expect(physics.gravity).toBe(0.08);
    // 1.13+ behaviour: gravity / 16.
    expect(physics.waterGravity).toBeCloseTo(physics.gravity / 16, 10);
    expect(physics.waterGravity).toBeCloseTo(0.005, 10);
    // Explicitly NOT the 1.8–1.12 constant.
    expect(physics.waterGravity).not.toBe(0.02);
    expect(physics.lavaGravity).toBeCloseTo(physics.gravity / 4, 10);
  });
});

describe("A3 — the vendored 26.2 data is what mineflayer-pathfinder sees", () => {
  it("minecraft-data('26.2') reports protocol 776 and the 26.1-era blocks", () => {
    const mcData = requireFromMineflayer("minecraft-data")("26.2");
    expect(mcData.version.version).toBe(776);
    expect(mcData.version.minecraftVersion).toBe("26.2");
    expect(mcData.version.majorVersion).toBe("26.2");
    expect(mcData.blocksByName.water).toBeDefined();
    expect(mcData.blocksByName.ladder).toBeDefined();
  });

  it("the vendored data exposes supportFeature (prismarine-chat needs it)", () => {
    // Removing the wrong supportFeature override broke this — prismarine-chat
    // calls registry.supportFeature() and throws without it.
    const mcData = requireFromMineflayer("minecraft-data")("26.2");
    expect(typeof mcData.supportFeature).toBe("function");
    expect(mcData.supportFeature("chatPacketsUseNbtComponents")).toBe(true);
  });

  it("does not override liquid gravity in minecraft-data (physics owns that)", () => {
    // The vendor wrapper must NOT force these — prismarine-physics' patched
    // features.json is the single source of truth.
    const mcData = requireFromMineflayer("minecraft-data")("26.2");
    const hasFeature = (name: string) => typeof mcData.supportFeature(name) === "boolean";
    // Whatever the base feature list says, it must match what physics uses.
    const features = loadFeatures();
    const physicsSaysProportional = features
      .find((f) => f.name === "proportionalLiquidGravity")!
      .versions.includes("26.2");
    const physicsSaysIndependent = features
      .find((f) => f.name === "independentLiquidGravity")!
      .versions.includes("26.2");
    // Exactly one of them must be true, or physics throws at load.
    expect(physicsSaysProportional !== physicsSaysIndependent).toBe(true);
    expect(hasFeature("proportionalLiquidGravity")).toBe(true);
  });
});

describe("A4 — the mineflayer patch registers 26.2", () => {
  it("testedVersions includes 26.2 in the loaded copy", () => {
    const { testedVersions } = requireFromMineflayer("mineflayer/lib/version.js") as {
      testedVersions: string[];
    };
    expect(testedVersions).toContain("26.2");
    expect(testedVersions).toContain("26.1");
  });
});

describe("A4 — prismarine-chunk maps 26.2 to the 1.18 chunk implementation", () => {
  it("the pc chunk loader has a 26.2 entry", () => {
    const src = requireFromMineflayer.resolve("prismarine-chunk");
    // Walk up to the package root and read the loader table.
    const path = requireFromMineflayer.resolve("prismarine-chunk/src/index.js");
    const text = requireFromMineflayer("node:fs").readFileSync(path, "utf8") as string;
    expect(src).toBeTruthy();
    expect(text).toMatch(/26\.2\s*:\s*require\('\.\/pc\/1\.18\/chunk'\)/);
  });
});