import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // The 26.2 vendored data is large; building the chat registry on first use
    // is real CPU work, so the default 5 s per-test budget is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
