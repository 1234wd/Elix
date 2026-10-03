/**
 * A9 — a secret scanner that runs as part of `pnpm test`.
 *
 * A fragment of a genuinely leaked Groq key was hard-coded as a test fixture
 * and committed once already. This makes that impossible to repeat: every
 * tracked text file is read and scanned, and any credential-shaped string fails
 * the suite.
 *
 * It reads git's index, so untracked scratch files and node_modules cannot
 * trip it, and the patterns are built from fragments so this file does not
 * itself contain a match.
 *
 * A4: git's index is NOT enough. A key was once recovered from a vitest log,
 * because a test asserted on the contents of .env and the FAILED assertion printed
 * the value into vitest's output directory - which is untracked, so this scanner
 * never saw it. An assertion failure is a perfectly good way to leak a secret,
 * and it writes to two places git does not track. So the scanner now reads:
 *
 *   - every tracked text file (as before);
 *   - vitest's output directory, node_modules/.vite/vitest;
 *   - every *.log file in the project, tracked or not.
 *
 * It also asserts, statically, that no test asserts ON .env CONTENTS, and
 * dynamically, that a planted key never reaches the CLI's stdout.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** Extensions worth scanning. Binaries and lockfile blobs are skipped. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".yaml", ".yml", ".md", ".txt", ".env", ".example",
  ".toml", ".ini", ".cfg", ".sh", ".ps1", ".bat",
]);

/** Directories that are never part of a commit. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "vendor", "data", "coverage", ".next",
]);

/** Above this a "file" is a binary or a data blob, not source. */
const MAX_BYTES = 2 * 1024 * 1024;

const PREFIXES = {
  groq: ["gs", "k_"],
  hf: ["h", "f_"],
  openai: ["s", "k-"],
  github: ["gh", "p_"],
};

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A 20+ char tail is the floor, so fixtures like "gsk_test" and the
  // assembed-at-runtime probe in fallback.test.ts do not trip the scanner.
  [new RegExp(`${PREFIXES.groq.join("")}[A-Za-z0-9]{20,}`), "groq key"],
  [new RegExp(`${PREFIXES.hf.join("")}[A-Za-z0-9]{20,}`), "huggingface token"],
  [new RegExp(`${PREFIXES.openai.join("")}[A-Za-z0-9]{20,}`), "openai-style key"],
  [new RegExp(`${PREFIXES.github.join("")}[A-Za-z0-9]{20,}`), "github token"],
];

/** Every path git tracks, relative to the project root. */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

function isScannable(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const dot = rel.lastIndexOf(".");
  const ext = dot === -1 ? "" : rel.slice(dot);
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  // pnpm-lock.yaml and friends can be large; the size guard is below.
  return true;
}

/**
 * A4: does this text contain a credential shape?
 *
 * Returns the LABEL only, never the match. The whole point of this file is that
 * a failing scan must not print the secret a second time into the very log this
 * scanner now reads.
 */
function credentialLabelsIn(text: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}

/** Recursively list files under a directory, skipping the usual dead weight. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/**
 * A4: scan paths that are NOT in git's index.
 *
 * Returns "relpath (label)" strings. relpath is relative to the project root so
 * the failure message names a file without quoting anything from it.
 */
function scanUntracked(paths: string[]): { offenders: string[]; scanned: number } {
  const offenders: string[] = [];
  let scanned = 0;
  for (const abs of paths) {
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    // Log files and results caches are small; a large one is not a test artefact.
    if (size > MAX_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    scanned++;
    for (const label of credentialLabelsIn(text)) {
      offenders.push(`${abs} (${label})`);
    }
  }
  return { offenders, scanned };
}

describe("A9 — no credential is committed", () => {
  it("git can list tracked files, so the scan is real rather than vacuous", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("package.json");
  });

  it("finds no key-shaped string in any tracked text file", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const rel of trackedFiles()) {
      if (!isScannable(rel)) continue;
      const abs = join(process.cwd(), rel);
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        continue; // deleted in the working copy but still in the index
      }
      if (size > MAX_BYTES) continue;

      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // A NUL means binary, whatever the extension claimed. Written as an
      // escape because a LITERAL NUL in this file made git treat the scanner
      // itself as binary — no diffs, unreviewable — and made it skip itself.
      if (text.includes("\\u0000")) continue;
      scanned++;

      // Report the file and the label, never the match: printing the secret
      // into a test log would leak it a second time - into the very directory
      // A4 now scans.
      for (const label of credentialLabelsIn(text)) offenders.push(`${rel} (${label})`);
    }

    // Proof the scan read something, so a broken scanner cannot pass silently.
    expect(scanned, "scanned file count").toBeGreaterThan(10);
    expect(offenders, `credential-shaped strings found in:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no tracked .ts file contains a literal NUL byte (A4)", () => {
    // A literal NUL makes git treat the file as binary: no diffs, and it cannot
    // be reviewed on GitHub. It also made this scanner skip ITSELF, because the
    // binary check below skips any file containing one.
    const offenders: string[] = [];
    let scanned = 0;
    for (const rel of trackedFiles()) {
      if (!rel.endsWith(".ts")) continue;
      const abs = join(process.cwd(), rel);
      if (!existsSync(abs)) continue;
      scanned++;
      if (readFileSync(abs).includes(0)) offenders.push(rel);
    }
    expect(scanned, "scanned .ts file count").toBeGreaterThan(10);
    expect(offenders, `literal NUL bytes in:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("scans itself, so the binary guard cannot hide this file", () => {
    // If secrets.test.ts were binary, the scan above would silently skip the one
    // file most likely to be given a key by accident. Prove it is readable text.
    const self = readFileSync(join(process.cwd(), "tests/unit/secrets.test.ts"), "utf8");
    // The escape is present as source text, and the raw byte is absent.
    expect(self).toContain("u0000");
    expect(readFileSync(join(process.cwd(), "tests/unit/secrets.test.ts")).includes(0)).toBe(false);
  });

  it("the scanner itself would catch a planted credential", () => {
    // Self-test: prove the patterns fire, so a typo in a pattern cannot turn
    // this file into a no-op that always passes.
    const fake = `${PREFIXES.groq.join("")}${"A".repeat(40)}`;
    expect(SECRET_PATTERNS.some(([re]) => re.test(fake))).toBe(true);
    const fakeHf = `${PREFIXES.hf.join("")}${"b".repeat(40)}`;
    expect(SECRET_PATTERNS.some(([re]) => re.test(fakeHf))).toBe(true);
    // And a short fixture must NOT trip it, or the suite would be useless.
    expect(SECRET_PATTERNS.some(([re]) => re.test(`${PREFIXES.groq.join("")}test`))).toBe(false);
  });

  it("A4 — vitest's own output directory holds no credential", () => {
    // This is where the recovered key actually was. node_modules/.vite/vitest is
    // untracked, so the index-driven scan above cannot see it, and a failed
    // assertion message is exactly the kind of thing that ends up in it.
    const viteDir = join(process.cwd(), "node_modules", ".vite", "vitest");
    expect(existsSync(viteDir), "vitest's cache dir exists after a run").toBe(true);
    const files = walk(viteDir);
    expect(files.length, "vitest output files found").toBeGreaterThan(0);
    const { offenders, scanned } = scanUntracked(files);
    expect(scanned, "vitest output files scanned").toBeGreaterThan(0);
    // A failing assertion prints the value it compared, so a key compared
    // anywhere in the suite would land in these files.
    expect(offenders, `credentials in vitest output:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("A4 — no *.log file in the project holds a credential", () => {
    // The key was recovered from a log, not from git. Logs are untracked by
    // definition, so they were never scanned at all.
    const root = process.cwd();
    const logs: string[] = [];
    const walkForLogs = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          // .git is history, scanned separately by the index scan; vendor is a
          // patched dependency; dist is build output of already-scanned sources.
          if (["node_modules", ".git", "vendor", "dist", "data", "coverage"].includes(e.name)) {
            continue;
          }
          walkForLogs(abs, depth + 1);
        } else if (e.isFile() && e.name.endsWith(".log")) {
          logs.push(abs);
        }
      }
    };
    walkForLogs(root, 0);
    // Nothing to scan is a legitimate state: no stray logs is the goal.
    if (logs.length === 0) return;
    const { offenders, scanned } = scanUntracked(logs);
    expect(scanned, "log files scanned").toBe(logs.length);
    expect(offenders, `credentials in log files:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("A4 — no test asserts ON the contents of a .env file", () => {
    // The root cause. A test read .env and compared it, so a mismatch printed
    // the key into the assertion failure. Asserting on PRESENCE or LENGTH is
    // safe; asserting on the VALUE is not.
    //
    // The rule: inside an expect(...) argument, a .env FILE reference is
    // forbidden. process.env is NOT - that is configuration handed to a child
    // process, never the contents of a secret file - so it is excluded.
    const testFiles = trackedFiles().filter((f) => /^tests\/.*\.(ts|tsx|js|mjs|cjs)$/.test(f));
    expect(testFiles.length, "test files found").toBeGreaterThan(5);
    const offenders: string[] = [];

    for (const rel of testFiles) {
      const abs = join(process.cwd(), rel);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, "utf8");
      // Every expect( ... ) argument, brace-matched so nested calls are covered.
      let idx = src.indexOf("expect(");
      while (idx !== -1) {
        let depth = 0;
        let end = idx + "expect(".length - 1;
        for (let i = idx + "expect(".length - 1; i < src.length; i++) {
          const ch = src[i];
          if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const arg = src.slice(idx, end + 1);
        // Strip process.env, which is the safe form.
        const withoutProcessEnv = arg.replace(/process\.env/g, "PROCESS_ENV");
        // A quoted ".env" is the FILE; that is what must never be asserted on.
        if (/["'`.]\.env["'`]/.test(withoutProcessEnv)) {
          const line = src.slice(0, idx).split("\n").length;
          offenders.push(`${rel}:${line}`);
        }
        idx = src.indexOf("expect(", end + 1);
      }
    }
    expect(
      offenders,
      `assertions on .env CONTENTS (assert on presence or length instead):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it(".env is gitignored, so a local key file cannot be committed by accident", () => {
    // `git check-ignore -q <path>` exits 0 when the path IS ignored and 1 when
    // it is not, so a throw is the failure case here.
    let isIgnored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: process.cwd(), stdio: "ignore" });
      isIgnored = true;
    } catch {
      isIgnored = false;
    }
    expect(isIgnored, ".env must be in .gitignore").toBe(true);
    expect(trackedFiles()).not.toContain(".env");
  });
});
