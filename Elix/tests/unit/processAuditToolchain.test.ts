/**
 * A6 — the shell boundary in ownToolchain().
 *
 * These are the two ways the audit can be useless, and both are silent:
 *
 *   - ALWAYS reporting something, so the output stops being read;
 *   - reporting CLEAN while Elix is running, which is the dangerous direction.
 *
 * The second one is what the shell-boundary rule exists for. Launching Elix from a
 * PowerShell and then running the audit from that same PowerShell makes Elix a
 * "descendant" of the audit's own ancestry. Ignoring descendants naively swallowed
 * a live Elix and printed CLEAN.
 */
import { describe, expect, it } from "vitest";
import { ownToolchain, type ProcInfo } from "../../scripts/process-audit.js";

function map(rows: readonly ProcInfo[]): Map<number, ProcInfo> {
  return new Map(rows.map((p) => [p.pid, p]));
}

const NODE = (pid: number, ppid: number, cmd: string): ProcInfo => ({
  pid,
  ppid,
  name: "node.exe",
  command: cmd,
});
const SHELL = (pid: number, ppid: number, name = "powershell.exe"): ProcInfo => ({
  pid,
  ppid,
  name,
  command: name,
});

describe("A6 — ownToolchain stops at a shell", () => {
  it("picks up a CHILD of the runner, which is the esbuild case", () => {
    // self = 500: 500 -> 400 (node) -> 300 (cmd) -> 200 (powershell).
    const procs: ProcInfo[] = [
      NODE(500, 400, "tsx process-audit"),
      NODE(400, 300, "node pnpm.js exec tsx"),
      NODE(401, 500, "esbuild.exe --service=0.28.2 --ping"),
      SHELL(300, 200, "cmd.exe"),
      SHELL(200, 1),
    ];
    const own = ownToolchain(procs, map(procs), 500);
    expect(own).toContain(400);
    expect(own).toContain(401);
  });

  it("does NOT swallow something reached by crossing a shell", () => {
    // Elix was started from this same PowerShell, then the audit ran from it.
    // Naive descendant-ignoring reported a running Elix as CLEAN.
    const procs: ProcInfo[] = [
      NODE(500, 400, "tsx process-audit"),
      NODE(400, 300, "node pnpm.js exec tsx"),
      SHELL(300, 200),
      // Elix hangs off the SAME shell, so it is a sibling branch, not ours.
      NODE(600, 300, "node dist/cli/index.js start"),
    ];
    const own = ownToolchain(procs, map(procs), 500);
    expect(own).toContain(400);
    expect(own).not.toContain(600);
  });

  it("treats a pid that is no longer in the table as a boundary, not as ours", () => {
    // The shell that launched a detached process has usually already exited, so the
    // walk reaches a pid with no entry. It cannot be classified as a shell, and
    // counting it as ours made the audit ignore processes it had no business
    // ignoring.
    const procs: ProcInfo[] = [
      NODE(500, 400, "tsx process-audit"),
      NODE(400, 300, "node pnpm.js exec tsx"),
      SHELL(300, 200),
      // 200 is referenced as a parent but has no entry: it is gone.
      NODE(900, 200, "something under a dead shell"),
    ];
    const own = ownToolchain(procs, map(procs), 500);
    expect(own).not.toContain(200);
    expect(own).not.toContain(900);
    expect(own).toContain(400);
  });

  it("ignores shells in its own chain, so it never reports its own host", () => {
    const procs: ProcInfo[] = [NODE(500, 300, "tsx process-audit"), SHELL(300, 200)];
    const own = ownToolchain(procs, map(procs), 500);
    expect(own).not.toContain(300);
    expect(own).not.toContain(200);
  });

  it("handles an orphaned parent without looping", () => {
    // ppid points at a pid that is not in the table, which is normal: the shell
    // that started a detached process has already exited.
    const procs: ProcInfo[] = [NODE(500, 9999, "tsx process-audit"), NODE(600, 8888, "orphan")];
    expect(() => ownToolchain(procs, map(procs), 500)).not.toThrow();
    expect(ownToolchain(procs, map(procs), 500)).toContain(500);
  });

  it("stops on a self-referential parent rather than hanging", () => {
    const procs: ProcInfo[] = [{ pid: 500, ppid: 500, name: "node.exe", command: "loop" }];
    expect(() => ownToolchain(procs, map(procs), 500)).not.toThrow();
  });
});