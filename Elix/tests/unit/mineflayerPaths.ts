/**
 * Where the REAL mineflayer source lives, on this machine, today.
 *
 * Round 18 X0: three tests read mineflayer through a hard-coded pnpm store path. That path
 * exists only on the machine that wrote it, so a fresh clone on Linux failed with ENOENT - and
 * a "real library" test that fails on the reviewer's machine is not a real library test.
 *
 * The package root is resolved from `mineflayer/package.json`, which every resolver allows,
 * and the wanted file is joined from there. Resolving the deep path directly does not work:
 * pnpm and npm both restrict paths into a package unless its `exports` map allows them.
 *
 * Note for the next reader: probe X0 scans every `.ts` in `tests/unit/` for the store path
 * LITERAL, this file included. So this comment, which explains the bug, cannot quote it.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** The package root, e.g. `.../node_modules/mineflayer`. */
function packageRoot(): string {
  const require = createRequire(import.meta.url);
  // `mineflayer/package.json` is always resolvable; the bare name alone would not be enough
  // to find the directory when the package is only a transitive dependency.
  return dirname(require.resolve("mineflayer/package.json"));
}

/**
 * The absolute path of a file inside mineflayer, e.g. `lib/plugins/digging.js`.
 *
 * Throws loudly when the file is not there, which is what a version change should look like -
 * a missing file is a fact, and a silent empty string would make the assertion below pass for
 * the wrong reason.
 */
export function mineflayerSource(...parts: string[]): string {
  return join(packageRoot(), ...parts);
}

/**
 * The real source text of a mineflayer file.
 *
 * Throws a message that says which file was wanted and where it looked. The bare `ENOENT`
 * this replaces named only a truncated path, and reading it cost more time than the
 * portability fix itself.
 */
export function mineflayerSourceText(...parts: string[]): string {
  const path = mineflayerSource(...parts);
  if (!existsSync(path)) {
    throw new Error(
      `mineflayer file not found: ${parts.join("/")}\n  looked in: ${path}\n  root: ${packageRoot()}`,
    );
  }
  return readFileSync(path, "utf8");
}

/** mineflayer's own docs, for the field ranges the reflexes are measured against. */
export function mineflayerApiDoc(): string {
  return mineflayerSourceText("docs", "api.md");
}