/**
 * A6 — the process audit's classification.
 *
 * Tested against a SYNTHETIC process table on purpose. The live audit reads
 * whatever Windows thinks is running, so a bug in the rules would otherwise show
 * up as a live run going wrong in the middle of an e2e, which is exactly the
 * failure this script exists to prevent.
 *
 * The rules being pinned down are the Round 8 lesson: the mid-run SIGHUP came from
 * a console host that owned Elix's process group, not from an orphan process.
 */
import { describe, expect, it } from "vitest";
import { classify, type ProcInfo } from "../../scripts/process-audit.js";

/** One row per synthetic process. */
type Row = readonly [pid: number, ppid: number, name: string, command: string];

/** Build a synthetic process table. */
function table(rows: readonly Row[]): ProcInfo[] {
  return rows.map(([pid, ppid, name, command]) => ({ pid, ppid, name, command }));
}

const ELIX: Row = [100, 10, "node.exe", '"C:\\nodejs\\node.exe" "C:\\elix\\dist\\cli\\index.js" start'];
const TOOLING: Row = [200, 10, "tsx.exe", '"C:\\nodejs\\node.exe" scripts\\e2e-chat.ts'];
const ESBUILD: Row = [201, 10, "esbuild.exe", "esbuild.exe --service=0.28.2 --ping"];

describe("A6 — an Elix process is recognised", () => {
  it("finds Elix by its entry point, not merely by being node", () => {
    const { rows } = classify(table([ELIX]), []);
    const elix = rows.filter((r) => r.verdict === "elix");
    expect(elix).toHaveLength(1);
    expect(elix[0]?.pid).toBe(100);
  });

  it("does NOT call an unrelated node process Elix", () => {
    // A bare `node` is not proof of anything; the entry point is.
    const { rows } = classify(table([[100, 10, "node.exe", "node some-other-tool.js"]] as const), []);
    expect(rows.filter((r) => r.verdict === "elix")).toHaveLength(0);
  });

  it("recognises the forward-slash form too", () => {
    const { rows } = classify(
      table([[100, 10, "node.exe", "node /home/me/elix/dist/cli/index.js start"]]),
      [],
    );
    expect(rows.filter((r) => r.verdict === "elix")).toHaveLength(1);
  });
});

describe("A6 — the console wrapper is the SIGHUP class, and is called out", () => {
  const WRAPPED: readonly Row[] = [
    ELIX,
    // cmd.exe -> node(launcher) -> node(elix): a real shell wrapper.
    [300, 1, "cmd.exe", "cmd.exe"],
    [10, 300, "node.exe", "node pnpm.js start"],
  ];

  it("finds the shell that can deliver SIGHUP to Elix", () => {
    const { rows } = classify(table(WRAPPED), []);
    const w = rows.filter((r) => r.verdict === "console-wrapper");
    expect(w).toHaveLength(1);
    expect(w[0]?.pid).toBe(300);
    // And it names the process it could kill.
    expect(w[0]?.wrapsElix).toBe(100);
  });

  it("reports nothing when Elix was started directly, which is the rule", () => {
    // Elix under a plain launcher with no shell in between: the healthy shape.
    const { rows } = classify(table([[100, 10, "node.exe", "node dist/cli/index.js start"], [10, 1, "explorer.exe", "explorer"]]), []);
    expect(rows.filter((r) => r.verdict === "console-wrapper")).toHaveLength(0);
  });

  it("does not flag a shell that has nothing to do with Elix", () => {
    const { rows } = classify(table([ELIX, [300, 1, "cmd.exe", "cmd.exe"], [400, 1, "cmd.exe", "cmd.exe"]]), []);
    // Neither shell is an ancestor of Elix, so neither can signal it.
    expect(rows.filter((r) => r.verdict === "console-wrapper")).toHaveLength(0);
  });

  it("catches a powershell wrapper as well as cmd", () => {
    const { rows } = classify(
      table([[100, 10, "node.exe", "node dist/cli/index.js start"], [300, 1, "powershell.exe", "powershell -Command pnpm start"], [10, 300, "node.exe", "node pnpm.js"]]),
      [],
    );
    expect(rows.filter((r) => r.verdict === "console-wrapper")).toHaveLength(1);
  });
});

describe("A6 — dev tooling is reported separately", () => {
  it("finds tsx and esbuild", () => {
    const { rows } = classify(table([TOOLING, ESBUILD]), []);
    const tooling = rows.filter((r) => r.verdict === "tooling");
    expect(tooling.map((r) => r.pid).sort()).toEqual([200, 201]);
  });

  it("is not confused with Elix", () => {
    const { rows } = classify(table([TOOLING]), []);
    expect(rows.filter((r) => r.verdict === "elix")).toHaveLength(0);
  });
});

describe("A6 — the audit never reports its own toolchain", () => {
  it("ignores every pid it is told to ignore, ancestors and descendants alike", () => {
    // This is the shape of a real `pnpm exec tsx` run: the audit itself is one of
    // these, and the esbuild service is a CHILD of the tsx node rather than an
    // ancestor. Ignoring only the ancestry reported that service every run.
    const own = table([
      [500, 400, "tsx.exe", "tsx scripts\\process-audit.ts"],
      [501, 400, "esbuild.exe", "esbuild.exe --service=0.28.2 --ping"],
      [400, 300, "node.exe", "node pnpm.js exec tsx"],
      [300, 200, "cmd.exe", "cmd.exe"],
      [200, 100, "powershell.exe", "powershell"],
      ELIX,
    ]);
    // The toolchain the helper would return for pid 400's process.
    const { rows } = classify(own, [400, 300, 200, 500, 501]);
    expect(rows.filter((r) => r.verdict === "tooling")).toHaveLength(0);
    // Elix is still found: ignoring our own chain must not blind the audit.
    expect(rows.filter((r) => r.verdict === "elix")).toHaveLength(1);
  });

  it("an empty table produces no findings", () => {
    expect(classify([], []).rows).toHaveLength(0);
  });
});