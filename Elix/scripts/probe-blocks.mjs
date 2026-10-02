import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const blocksPath = join(process.cwd(), "vendor", "minecraft-data", "data", "pc", "26.2", "blocks.json");
const blocks = JSON.parse(readFileSync(blocksPath, "utf8"));

const names = new Set(blocks.map((b) => b.name));
const byName = new Map(blocks.map((b) => [b.name, b]));

const CANDIDATES = process.argv.slice(2);
const out = [];
for (const n of CANDIDATES) {
  const b = byName.get(n);
  out.push({
    name: n,
    exists: names.has(n),
    boundingBox: b?.boundingBox ?? null,
    solid: b?.solid ?? null,
  });
}
console.log(JSON.stringify({ totalBlocks: names.size, results: out }, null, 2));
void require;