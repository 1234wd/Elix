/**
 * R18-I — the wiring audit.
 *
 * Round 18 opened because 370 tests and a whole feature set the running bot could not do:
 * nothing called `bot.dig`, `bot.craft`, `bot.toss` or `bot.whisper`, and `parseGather`,
 * `parseToolCalls`, `NvidiaProvider` and `probeOllama` were used only by their own tests.
 *
 * This test makes that class of bug fail the build. It lists every export in the new modules and
 * fails if one is imported by NOTHING outside its own module. A test is not a caller: the whole
 * point is that a feature only tests exercise is a feature nobody has.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WIRING_ALLOWLIST, AUDITED_DIRECTORIES, AUDITED_FILES } from "./wiring-allowlist.js";

const ROOT = process.cwd();

/** Every .ts file under `src/`, and every test file, as source text. */
function readTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      readTree(full, out);
      continue;
    }
    if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SRC_FILES = readTree(join(ROOT, "src"));
const TEST_FILES = readTree(join(ROOT, "tests"));
const ALL_FILES = [...SRC_FILES, ...TEST_FILES];
const SOURCES = new Map(ALL_FILES.map((f) => [f.replace(/\\/gu, "/"), readFileSync(f, "utf8")]));

/** The files this audit actually inspects. */
function auditedFiles(): string[] {
  const out: string[] = [];
  for (const dir of AUDITED_DIRECTORIES) {
    for (const f of readTree(join(ROOT, dir))) out.push(f);
  }
  for (const f of AUDITED_FILES) out.push(join(ROOT, f));
  return out;
}

/** Exported names in one file: `export function|const|class|let` and `export { a, b }`. */
function exportsOf(source: string): string[] {
  const names = new Set<string>();
  const declared = /^export\s+(?:async\s+)?(?:function|const|let|var|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gmu;
  for (const m of source.matchAll(declared)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  // `export const A = 1, B = 2;` - the second name has no `export` in front of it.
  const multi = /^export\s+(?:const|let|var)\s+([^=;]+)=/gmu;
  for (const m of source.matchAll(multi)) {
    const list = (m[1] ?? "").split(",");
    for (const part of list) {
      const name = part.trim().split(/[:\s]/u)[0] ?? "";
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  const listed = /^export\s*\{([^}]*)\}/gmu;
  for (const m of source.matchAll(listed)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = (part.split(/\s+as\s+/u).pop() ?? "").trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** True when `name` is IMPORTED by this file - not merely mentioned in a comment. */
function imports(source: string, name: string): boolean {
  const patterns = [
    new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`, "u"),
    new RegExp(`import\\s+${name}\\b`, "u"),
    new RegExp(`import\\s+type\\s+${name}\\b`, "u"),
    new RegExp(`import\\([^)]*\\b${name}\\b[^)]*\\)`, "u"),
  ];
  return patterns.some((re) => re.test(source));
}

describe("R18-I — every export has a production caller", () => {
  it("the audited directories exist, so the audit is not silently checking nothing", () => {
    for (const dir of AUDITED_DIRECTORIES) {
      expect(statSync(join(ROOT, dir)).isDirectory(), `${dir} is missing`).toBe(true);
    }
    for (const file of AUDITED_FILES) {
      expect(statSync(join(ROOT, file)).isFile(), `${file} is missing`).toBe(true);
    }
    // A sanity check on the audit itself: it must FIND exports, or it proves nothing.
    const total = auditedFiles().reduce((sum, f) => sum + exportsOf(readFileSync(f, "utf8")).length, 0);
    expect(total, "the audit found no exports at all - it is broken, not passing").toBeGreaterThan(20);
  });

  it("no export is dead code", () => {
    const dead: string[] = [];
    for (const file of auditedFiles()) {
      const key = file.replace(/\\/gu, "/");
      const source = readFileSync(file, "utf8");
      for (const name of exportsOf(source)) {
        if (WIRING_ALLOWLIST[name] !== undefined) continue;
        // A caller may be any OTHER file in src/ or tests/. The file's own text is excluded, so
        // a module that exports something and uses it internally still counts as dead - and
        // that is deliberate: an internal helper should not be exported at all.
        const usedElsewhere = ALL_FILES.some((other) => {
          const otherKey = other.replace(/\\/gu, "/");
          if (otherKey === key) return false;
          const otherSource = SOURCES.get(otherKey);
          return otherSource !== undefined && imports(otherSource, name);
        });
        if (!usedElsewhere) dead.push(`${key.replace(/^.*\/(?:src|tests)\//u, "")}: ${name}`);
      }
    }
    expect(
      dead,
      "these exports are imported by nothing outside their own module. Either wire them up, or " +
        "make them non-exported, or add a one-line reason to tests/unit/wiring-allowlist.ts.",
    ).toEqual([]);
  });

  it("every allow-list entry is actually still needed", () => {
    const deadEntries: string[] = [];
    for (const name of Object.keys(WIRING_ALLOWLIST)) {
      // Proof of life is EITHER still exported by an audited file OR imported by src/.
      // Requiring an import alone would flag every pure constant that exists for its own
      // module and its tests, which is precisely what the allow-list is for.
      const stillExported = auditedFiles().some((f) =>
        new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`, "mu").test(
          readFileSync(f, "utf8"),
        ),
      );
      const importedBySrc = ALL_FILES.some((file) => {
        const key = file.replace(/\\/gu, "/");
        if (!key.includes("/src/")) return false;
        return imports(SOURCES.get(key) ?? "", name);
      });
      if (!stillExported && !importedBySrc) deadEntries.push(name);
    }
    expect(deadEntries, "these allow-list entries are no longer true - delete them").toEqual([]);
  });

  it("every allow-list reason is a real sentence, not a placeholder", () => {
    for (const [name, reason] of Object.entries(WIRING_ALLOWLIST)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
      expect(reason, `${name}'s reason is a placeholder`).not.toMatch(/^(todo|tbd|fixme|xxx)\.?$/iu);
    }
  });
});

describe("R18-I — the specific bug Round 18 was called in for", () => {
  it("bot.dig, bot.craft, bot.toss and bot.whisper all exist in src/ now", () => {
    const all = SRC_FILES.map((f) => SOURCES.get(f.replace(/\\/gu, "/")) ?? "").join("\n");
    for (const call of ["bot.dig", "bot.craft", "bot.toss", "bot.whisper"]) {
      expect(all, `${call} still appears nowhere in src/`).toContain(call);
    }
  });

  it("the parsers and providers Round 18 found unreachable now have production callers", () => {
    // `parseToolCalls` is reached through `selectToolCalls`, which the bridge imports: the
    // capability is wired even though the parse itself is called from inside its own module.
    for (const name of ["parseGather", "parseRemember", "parseWhereIs", "parseGoTo", "parseWhereDied", "selectToolCalls", "probeOllama"]) {
      const used = SRC_FILES.some((f) => {
        const key = f.replace(/\\/gu, "/");
        const source = SOURCES.get(key) ?? "";
        // Imported by a DIFFERENT module than the one that declares it.
        if (key.includes(name === "probeOllama" || name === "selectToolCalls" ? "toolCalls" : "skills/") && source.includes(`export function ${name}`)) {
          return false;
        }
        return imports(source, name);
      });
      expect(used, `${name} is still called by nothing but its own module and tests`).toBe(true);
    }
  });
});
