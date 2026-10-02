import { defineConfig } from "tsup";

/**
 * Build output must be dist/cli/index.js so PROJECT_ROOT (resolved as two
 * levels up from this file) still lands on the project root — config/, vendor/,
 * patches/ and .env all live there. Changing the output depth would silently
 * break path resolution from any cwd.
 */
export default defineConfig({
  entry: { "cli/index": "src/cli/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  // Bundling none of the dependencies: the vendored minecraft-data package and
  // the pnpm-patched mineflayer stack must be resolved from node_modules at
  // runtime, not inlined.
  bundle: true,
  splitting: false,
  shims: false,
  external: [
    "mineflayer",
    "mineflayer-pathfinder",
    "minecraft-data",
    "prismarine-chat",
    "prismarine-physics",
    "prismarine-chunk",
    "vec3",
    "prismarine-nbt",
    "prismarine-registry",
    "minecraft-protocol",
    "dotenv",
    "pino",
    "pino-pretty",
    "zod",
    "js-yaml",
    "commander",
    "ffmpeg-static",
    // node:sqlite is loaded via createRequire, not a static import, because
    // esbuild strips the `node:` prefix from externals and there is no bare
    // `sqlite` module for Node to resolve. See src/brain/store.ts.
    /^node:/,
  ],
});