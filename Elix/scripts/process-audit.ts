/**
 * A6 — process audit: prove no launcher survives a round.
 *
 * WHY THIS EXISTS. During Round 8 a stray background launcher produced a real
 * SIGHUP part-way through a live e2e run. Elix's SIGHUP fast path fired (see
 * `window closed - quick save` in src/core/lifecycle.ts), the bot saved and exited
 * 0 in the middle of the test, and row 8 looked like a memory failure. Telling a
 * shutdown apart from a memory bug cost real time.
 *
 * THE MECHANISM, and it is not mysterious. src/core/lifecycle.ts documents that
 * SIGHUP is what Node reports when a CMD window is CLOSED — not when a process is
 * killed. So whatever sent it had to be a **console host that owned Elix's process
 * group**. That is a `cmd.exe` or `powershell.exe` wrapper, not an orphan node or
 * tsx process, and it is why the rule for live runs is to start the node process
 * directly and never wrap it in a shell.
 *
 * The audit therefore distinguishes three things, because they mean different
 * things:
 *
 *   elix            a node process running dist/cli/index.js — expected during a
 *                   live run, and the ONLY node process that should exist.
 *   console-wrapper a cmd/powershell above an Elix process — the SIGHUP class.
 *   tooling         tsx / ts-node / esbuild — fine while developing, but they must
 *                   not be running during a live e2e, and they never should
 *                   survive a round.
 *
 * It deliberately ignores its OWN ancestor chain. Run through `pnpm exec tsx`,
 * this script is itself under a powershell -> cmd -> node -> node -> esbuild
 * chain, and an audit that reports its own launcher on every run is an audit
 * nobody reads.
 *
 * Usage:
 *   pnpm audit            report only, exit 0
 *   pnpm audit --strict   exit 1 if an Elix or console-wrapper is found
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  command: string;
}

const ELIX_NAMES = new Set(["node.exe"]);
const TOOLING_NAMES = new Set(["tsx.exe", "ts-node.exe", "npx.exe", "bun.exe", "deno.exe", "esbuild.exe"]);
const SHELL_NAMES = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "pwsh_ise.exe"]);

/** What identifies Elix itself, as opposed to any node process at all. */
const ELIX_MARKERS = ["dist\\cli\\index.js", "dist/cli/index.js", "cli/index.js start", "cli\\index.js start"];

export type Verdict = "elix" | "console-wrapper" | "tooling";

export interface AuditRow {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  verdict: Verdict;
  /** For a console-wrapper: the Elix process it can deliver SIGHUP to. */
  wrapsElix?: number;
}

export interface AuditReport {
  rows: AuditRow[];
  /** PIDs ignored because they belong to this run's own toolchain. */
  ignoredSelf: number[];
}

function listProcesses(): ProcInfo[] {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | " +
        "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  const parsed: unknown = JSON.parse(out);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  return rows.map((r) => {
    const o = r as {
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string;
      CommandLine?: string | null;
    };
    return {
      pid: o.ProcessId ?? 0,
      ppid: o.ParentProcessId ?? 0,
      name: o.Name ?? "",
      command: o.CommandLine ?? "",
    };
  });
}

/**
 * This audit's own toolchain: the runner chain and whatever it spawned, stopping
 * at a SHELL boundary.
 *
 * Two rules learned the hard way here:
 *
 *  1. Ignoring only the ancestry left the esbuild language service reported on
 *     every run. It is a CHILD of the tsx node process, not an ancestor, so it has
 *     to be picked up as a descendant — otherwise the audit always reports
 *     something, which is how an audit stops being read.
 *
 *  2. Ignoring descendants without stopping at a shell swallowed REAL findings.
 *     Launching Elix from a PowerShell and then running the audit from that same
 *     PowerShell makes Elix a "descendant" of the audit's own ancestry — so a
 *     live, running Elix was reported as CLEAN. That is the worst possible failure
 *     for this script. A shell is a HOST, not part of the toolchain: anything
 *     reached by crossing a shell belongs to whoever opened that shell, not to us.
 *
 * So: walk up from here, then flood-fill downwards through non-shell processes
 * only. Shells themselves are never auto-ignored, because a shell that really does
 * sit above a running Elix is a true positive — that is exactly the SIGHUP class.
 */
export function ownToolchain(
  procs: ProcInfo[],
  byPid: Map<number, ProcInfo>,
  /** Overridable so the boundary rule can be tested without patching process.pid. */
  selfPid: number = process.pid,
): number[] {
  const isShell = (pid: number): boolean => {
    const p = byPid.get(pid);
    return p !== undefined && SHELL_NAMES.has(p.name.toLowerCase());
  };

  // Ancestors of this process.
  //
  // Only pids that are actually IN the table count. The walk reads a ppid from one
  // level and then looks up the next, so a pid that no longer exists — which is
  // completely normal, since the shell that launched a detached process has often
  // already exited — was being collected as a chain member. An unknown pid cannot
  // be classified as a shell, so it was treated as ours: a dead parent ended up
  // inside ownToolchain(), and the audit ignored processes it had no business
  // ignoring.
  const chain: number[] = [];
  let pid: number | undefined = selfPid;
  for (let depth = 0; depth < 24 && pid !== undefined && pid !== 0; depth++) {
    if (chain.includes(pid)) break;
    const info = byPid.get(pid);
    if (info === undefined && pid !== selfPid) break;
    chain.push(pid);
    pid = info?.ppid;
  }

  // Downwards from every non-shell link, never crossing a shell.
  const own = new Set<number>();
  const queue: number[] = [];
  for (const p of chain) {
    if (isShell(p)) continue;
    if (!own.has(p)) {
      own.add(p);
      queue.push(p);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of procs) {
      if (child.ppid !== current) continue;
      if (own.has(child.pid)) continue;
      if (isShell(child.pid)) continue; // host boundary: not ours
      own.add(child.pid);
      queue.push(child.pid);
    }
  }

  return [...own];
}

function isElix(p: ProcInfo): boolean {
  if (!ELIX_NAMES.has(p.name.toLowerCase())) return false;
  const cmd = p.command.toLowerCase();
  return ELIX_MARKERS.some((m) => cmd.includes(m.toLowerCase()));
}

export function audit(): AuditReport {
  const procs = listProcesses();
  return classify(procs, ownToolchain(procs, new Map(procs.map((p) => [p.pid, p]))));
}

/**
 * The classification, with no process table of its own.
 *
 * Split out so it can be tested against a SYNTHETIC table. The real thing reads
 * whatever Windows thinks is running, which means a bug in the rules shows up as
 * a live run going wrong rather than as a failing test.
 */
export function classify(procs: ProcInfo[], ignoredSelf: number[]): AuditReport {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rows: AuditRow[] = [];

  // Elix itself.
  for (const p of procs) {
    if (ignoredSelf.includes(p.pid)) continue;
    if (isElix(p)) {
      rows.push({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        command: p.command.slice(0, 170),
        verdict: "elix",
      });
    }
  }

  // Console hosts ABOVE an Elix process: the SIGHUP class.
  //
  // The walk goes UP from Elix, not down from the shell. The first version walked
  // down from each shell looking for Elix, which never finds anything: the shell
  // is the ancestor, so walking its own parent chain walks away from Elix. That bug
  // made this report zero wrappers ever — i.e. it reported "all clear" during
  // precisely the situation it exists to catch.
  const wrapperSeen = new Set<number>();
  for (const elixProc of procs) {
    if (ignoredSelf.includes(elixProc.pid)) continue;
    if (!isElix(elixProc)) continue;
    let pid: number | undefined = elixProc.ppid;
    for (let depth = 0; depth < 24 && pid !== undefined && pid !== 0; depth++) {
      const parent: ProcInfo | undefined = byPid.get(pid);
      if (parent === undefined) break;
      if (SHELL_NAMES.has(parent.name.toLowerCase()) && !ignoredSelf.includes(parent.pid)) {
        if (!wrapperSeen.has(parent.pid)) {
          wrapperSeen.add(parent.pid);
          rows.push({
            pid: parent.pid,
            ppid: parent.ppid,
            name: parent.name,
            command: parent.command.slice(0, 170),
            verdict: "console-wrapper",
            wrapsElix: elixProc.pid,
          });
        }
      }
      pid = parent.ppid;
    }
  }

  // Dev tooling. Harmless in itself, but it must not outlive a round.
  for (const p of procs) {
    if (ignoredSelf.includes(p.pid)) continue;
    if (!TOOLING_NAMES.has(p.name.toLowerCase())) continue;
    // Elix is already reported above; do not also list it as tooling.
    if (isElix(p)) continue;
    rows.push({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      command: p.command.slice(0, 170),
      verdict: "tooling",
    });
  }

  return { rows, ignoredSelf };
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const { rows, ignoredSelf } = audit();
  const elix = rows.filter((r) => r.verdict === "elix");
  const wrappers = rows.filter((r) => r.verdict === "console-wrapper");
  const tooling = rows.filter((r) => r.verdict === "tooling");

  console.log("=".repeat(78));
  console.log("A6 PROCESS AUDIT");
  console.log("=".repeat(78));

  if (rows.length === 0) {
    console.log("CLEAN — nothing of ours is running.");
  } else {
    for (const r of rows) {
      const note = r.wrapsElix !== undefined ? `  (wraps Elix pid ${r.wrapsElix})` : "";
      console.log(`  [${r.verdict}] pid ${r.pid} ppid ${r.ppid}  ${r.name}${note}`);
      console.log(`      ${r.command}`);
    }
  }

  console.log("");
  console.log(`  Elix:      ${elix.length}`);
  console.log(`  Wrapper:   ${wrappers.length}`);
  console.log(`  Tooling:   ${tooling.length}`);
  console.log(`  Ignored (this audit's own launcher chain): ${ignoredSelf.length} process(es)`);
  console.log("");

  if (wrappers.length > 0) {
    console.log("A CONSOLE WRAPPER sits above Elix. That is the SIGHUP class:");
    console.log("closing it takes Elix down mid-run, which is what made row 8 look like");
    console.log("a memory failure in Round 8. Launch node directly instead:");
    console.log("  Start-Process node -ArgumentList dist/cli/index.js,start ...");
    console.log("");
  }
  if (tooling.length > 0) {
    console.log("Dev tooling is still running. It must not outlive a round, and it must");
    console.log("not be running during a live e2e.");
    console.log("");
  }
  if (rows.length === 0) {
    console.log("Expected end state of a round: nothing of ours running.");
    console.log("During a live run: exactly one node.exe on dist/cli/index.js, with no");
    console.log("cmd.exe or powershell.exe above it in the tree.");
  }

  if (strict && (elix.length > 0 || wrappers.length > 0)) process.exit(1);
}

if (process.argv[1] !== undefined && basename(process.argv[1]).includes("process-audit")) {
  main();
}