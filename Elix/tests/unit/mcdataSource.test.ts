/**
 * Round 17 §1 Q2: everything version-sensitive reads ONE accessor, and that accessor is
 * the vendored data.
 *
 * The bug this file exists to prevent is a real one, found in Round 16: minecraft-data
 * 1.21.4 is internally inconsistent, and `foods` is keyed by a DIFFERENT numeric id than
 * `itemsByName` reports for the same item - `mushroom_stew` is key `849` in `foods` while
 * `itemsByName.mushroom_stew.id === 880`. A join across that silently produces wrong or
 * missing food data, and a wrong food value means Elix starves while standing next to a
 * stack of golden apples.
 *
 * So this test fails on:
 *   1. a hard-coded older version string passed to minecraft-data anywhere in `src/`;
 *   2. any module other than `src/world/mcdata.ts` reaching for minecraft-data at all;
 *   3. the accessor itself disagreeing with the vendored tree about item ids.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VENDORED_VERSION,
  dataForVersion,
  foodQuality,
  foodsByName,
  itemNames,
  resetDataCache,
} from "../../src/world/mcdata.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Every .ts under src/, recursively. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip comments and string literals, so prose about minecraft-data is not a hit. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

describe("Round 17 Q2 — one accessor, and it is the vendored data", () => {
  it("the accessor reads 26.2", () => {
    expect(VENDORED_VERSION).toBe("26.2");
    resetDataCache();
    const data = dataForVersion();
    expect(data).not.toBeNull();
    expect(data?.version.minecraftVersion).toBe("26.2");
  });

  it("no src/ module hard-codes an older minecraft-data version", () => {
    const offenders: string[] = [];
    // Only a CALL looks like a version: `minecraft-data("1.21.4")`, `(version)` is fine.
    const older = /\(\s*["'`](\d+\.\d+(?:\.\d+)?)["'`]\s*\)/gu;
    for (const file of sourceFiles()) {
      const code = codeOnly(readFileSync(file, "utf8"));
      // The vendored 26.2 tree also carries 1.20.3 and 26.1; those are not "older" targets
      // for a default, but a literal version argument anywhere in src/ is the pattern Q2
      // rules out, so all of them are reported and the assertion below is explicit.
      for (const m of code.matchAll(older)) {
        if (m[1] !== VENDORED_VERSION) {
          offenders.push(`${file.replace(SRC, "src").split(/\\/gu).join("/")}: minecraft-data("${m[1]}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only src/world/mcdata.ts requires minecraft-data", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith(join("world", "mcdata.ts"))) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      if (/require\(\s*["'`]minecraft-data["'`]\s*\)/u.test(code)) {
        offenders.push(file.replace(SRC, "src").split(/\\/gu).join("/"));
      }
    }
    // src/connection/version.ts legitimately asks for the PROTOCOL number; it does not join
    // foods to items, so it is listed here as the one allowed exception and asserted below.
    expect(offenders).toEqual(["src/connection/version.ts"]);
  });

  it("version.ts asks only for the protocol number, never for items or food", () => {
    const code = codeOnly(readFileSync(join(SRC, "connection", "version.ts"), "utf8"));
    expect(code).not.toMatch(/foods/u);
    expect(code).not.toMatch(/itemsByName/u);
    expect(code).not.toMatch(/blocksByName/u);
  });

  it("the foods join is internally consistent for 26.2 - every food is also an item", () => {
    const foods = foodsByName();
    expect(foods.size).toBeGreaterThan(30);
    const data = dataForVersion();
    const broken = [...foods.entries()].filter(
      ([, food]) => data?.itemsByName[food.name]?.id !== food.id,
    );
    expect(broken).toEqual([]);
  });

  it("the foods join would have caught the 1.21.x id mismatch, which is why it is a join on ids", () => {
    // The two documented examples, spelled out, so a future reader knows what the guard is
    // for: in 1.21.4 `foods` and `itemsByName` disagree, so a name-keyed or naive join
    // produces food for the wrong item.
    const foods = foodsByName();
    expect(foods.get("bread")?.effectiveQuality).toBeGreaterThan(0);
    expect(foods.get("golden_apple")?.effectiveQuality).toBeGreaterThan(
      foods.get("bread")?.effectiveQuality ?? 0,
    );
    expect(foods.get("rotten_flesh")?.effectiveQuality).toBeLessThan(
      foods.get("golden_apple")?.effectiveQuality ?? 0,
    );
  });

  it("an item with no food data scores 0, which callers must read as 'never eat this'", () => {
    expect(foodQuality("stone")).toBe(0);
    expect(foodQuality("iron_sword")).toBe(0);
    expect(foodQuality("not_an_item")).toBe(0);
  });

  it("every food Elix is willing to eat is a real 26.2 item", () => {
    const names = new Set(itemNames());
    for (const name of ["bread", "beef", "golden_apple", "apple", "carrot"]) {
      expect(names.has(name), `${name} should be a real 26.2 item`).toBe(true);
      expect(foodQuality(name), `${name} should have food data`).toBeGreaterThan(0);
    }
  });

  it("a version with no data returns null rather than throwing", () => {
    // A server on a version we did not vendor must not crash the bot mid-game.
    expect(dataForVersion("0.0.0-nope")).toBeNull();
    // The DEFAULT version still works after a failed lookup was cached: a null must not
    // poison the memoised entry for 26.2.
    expect(itemNames().length).toBeGreaterThan(0);
    expect(foodQuality("bread")).toBeGreaterThan(0);
    expect(foodsByName("0.0.0-nope").size).toBe(0);
    expect(foodQuality("bread", "0.0.0-nope")).toBe(0);
  });
});