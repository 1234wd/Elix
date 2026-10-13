import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The line-count ratchet (R20-A).
 *
 * The rule is "no file in `src/` over 800 lines". Getting there is the split, R20-A, and it is
 * still in progress - so this test starts as a RATCHET rather than a wall:
 *
 *   - every file must be at most 800 lines, EXCEPT the ones listed in `CEILINGS`;
 *   - a `CEILINGS` entry holds that file's EXACT current line count, and the file must not grow
 *     past it;
 *   - a split lowers an entry, and a finished split removes it entirely.
 *
 * The point is that the number can only go down. A file that grows by 20 lines fails here even
 * though nothing broke, which is exactly the pressure this round's first half was missing.
 */

/** File path (from `src/`) -> its exact current line count. Each split lowers or removes one. */
export const CEILINGS: Readonly<Record<string, number>> = Object.freeze({
  "connection/bot.ts": 3144,
  "brain/bridge.ts": 1640,
  "memory/store.ts": 1087,
  "brain/router.ts": 1045,
  "social/wellbeing.ts": 981,
  "social/emotion.ts": 813,
});

/** Lines, counted the way `wc -l` counts them. */
function lineCount(text: string): number {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** The number the brief wants every file under. */
export const TARGET = 800;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every source file, as a path relative to `src/` with forward slashes. */
export function sourceFiles(root = "src"): Array<{ path: string; lines: number }> {
  return walk(root).map((f) => ({
    path: relative(root, f).replace(/\\/gu, "/"),
    // The same count `wc -l` gives: a file ending in a newline does not have an extra
    // empty line, and the reviewer's numbers came from there.
    lines: lineCount(readFileSync(f, "utf8")),
  }));
}

describe("file size ratchet", () => {
  const files = sourceFiles();

  it("finds the source tree at all", () => {
    expect(files.length, "no .ts files under src/ - the ratchet is broken, not passing").toBeGreaterThan(20);
  });

  it("no file exceeds its ceiling, and only the listed files have one", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const ceiling = CEILINGS[file.path];
      if (ceiling === undefined) {
        if (file.lines > TARGET) offenders.push(`${file.path} is ${file.lines} lines and has no ceiling entry`);
        continue;
      }
      if (file.lines > ceiling) {
        offenders.push(`${file.path} grew from ${ceiling} to ${file.lines} - a split must lower its ceiling, never raise it`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every ceiling entry names a file that still exists", () => {
    const known = new Set(files.map((f) => f.path));
    const stale = Object.keys(CEILINGS).filter((p) => !known.has(p));
    expect(stale, "a CEILINGS entry names a file that no longer exists - delete the entry").toEqual([]);
  });

  it("a ceiling is only worth having while the file is over the target", () => {
    const pointless: string[] = [];
    for (const file of files) {
      if (CEILINGS[file.path] === undefined) continue;
      if (file.lines <= TARGET) pointless.push(`${file.path} is ${file.lines} lines, under the target - delete its entry`);
    }
    expect(pointless).toEqual([]);
  });
});
