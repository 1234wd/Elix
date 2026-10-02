import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "vendor/**", "scripts/**", "**/*.mjs"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // A1: this project is "type": "module", so a bare `require(...)`,
    // `__dirname` or `__filename` is a runtime ReferenceError — never a
    // TypeScript error. vitest injects its own `require`, which is why unit
    // tests passed while the real CLI produced "[object Object]" for every
    // in-game kick. A local `const require = createRequire(import.meta.url)`
    // shadows the global, so legitimate uses still pass.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "require", message: "Use createRequire(import.meta.url) in an ESM module." },
        { name: "__dirname", message: "ESM has no __dirname; use fileURLToPath(import.meta.url)." },
        { name: "__filename", message: "ESM has no __filename; use fileURLToPath(import.meta.url)." },
      ],
    },
  },
);
