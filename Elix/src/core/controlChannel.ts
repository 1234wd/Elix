/**
 * The local control channel (A1) — how `elix stop` reaches a running Elix.
 *
 * WHY THIS EXISTS: Ctrl+C can only be delivered by a human at a keyboard. Every
 * automated check of the shutdown path — a test, a script, an agent — was
 * therefore unable to prove that the goodbye, the consolidation, the backup and
 * the database close actually happen. Forcing the process to die proved nothing:
 * the cleanups never ran. So there is now a second door into the SAME shutdown.
 *
 * It is deliberately NOT a TCP port. A port open on 0.0.0.0 would let anything on
 * the network tell Elix to quit, and Elix runs on a game server that is by
 * definition reachable by strangers. These are local-only:
 *
 *   - Windows: a named pipe, `\\.\pipe\elix-<hash>`. Kernel-namespaced, no port.
 *   - Linux/macOS: a Unix domain socket in the temp directory, which cannot be
 *     bound to an interface and is not reachable over the network at all.
 *
 * The hash is of PROJECT_ROOT, so two checkouts on one machine get two separate
 * channels and `elix stop` only ever stops the copy you are standing in.
 *
 * There is no authentication and no secret, and that is fine: the threat is a
 * stranger on the internet, and neither mechanism is reachable from one. Anyone
 * who can open a local pipe can already kill the process outright.
 */
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

/** How long `elix stop` waits for the running process to finish its shutdown. */
export const STOP_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Where the control channel lives for a given project.
 *
 * Exported so `elix stop` and `elix start` cannot disagree about the name, which
 * would present as "Elix is not running" while Elix is happily playing.
 */
export function controlPath(projectRoot: string): string {
  // The resolved path, so C:\elix and C:\elix\. and a symlinked checkout all
  // land on one channel rather than three.
  const hash = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\elix-${hash}`;
  // In tmpdir, not the project: Unix socket paths are capped at ~108 characters
  // by the kernel, and a deep checkout would fail to bind.
  return join(tmpdir(), `elix-${hash}.sock`);
}

/**
 * Is something already listening on this channel?
 *
 * Used for two different questions, which is why it is separate from
 * `removeStale`: "is Elix running?" and "is this just a leftover file?" must not
 * be answered by the same code, or a crashed run would look alive and a live run
 * would look dead.
 */
export function isControlLive(path: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path });
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    // ENOENT (nothing there) and ECONNREFUSED (file left by a crash) both mean
    // the same thing here: nobody is listening.
    socket.once("error", () => finish(false));
  });
}

/**
 * Delete a channel left behind by a crashed or force-killed run.
 *
 * Returns true when something was removed. A live channel is NEVER removed — it
 * is not stale, and unlinking it would leave the running server invisible while
 * it still holds the pipe.
 */
export async function removeStaleControl(path: string): Promise<boolean> {
  if (process.platform === "win32") {
    // A Windows named pipe has no on-disk file: the kernel destroys it when the
    // last handle closes, so a crash leaves nothing behind. Binding an existing
    // name only fails if a server is genuinely alive, which isControlLive
    // answers before we ever get here.
    return false;
  }
  if (!existsSync(path)) return false;
  if (await isControlLive(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- the server */

export interface ControlLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface ControlServerOptions {
  projectRoot: string;
  /**
   * Begin the shutdown. Must NOT await the whole thing — it is called from a
   * socket event, and the shutdown ends the process.
   */
  onStop: () => void;
  /**
   * Called with the exit code immediately before the process exits, so a waiting
   * `elix stop` can report the real number instead of guessing.
   */
  onExit?: (code: number) => void | Promise<void>;
  log?: ControlLog;
}

export interface ControlServer {
  path: string;
  /**
   * Write the exit code to every waiting `elix stop` and end those sockets.
   *
   * This is deliberately separate from `close()`: closing destroys the sockets
   * unread, so a client blocked on the answer would hang until its own timeout and
   * then report a shutdown that actually succeeded as a failure.
   */
  announceExit(code: number): Promise<void>;
  /** Remove the channel. Idempotent. */
  close(): Promise<void>;
}

/**
 * Start listening for `elix stop`.
 *
 * Rejects if another Elix is already listening on this project's channel, rather
 * than silently becoming a second process fighting over the same database.
 */
export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const path = controlPath(opts.projectRoot);

  if (await isControlLive(path)) {
    throw new Error(
      `Elix is already running for this project (control channel ${path} is in use). ` +
        `Run "elix stop" first, or start the other copy from its own folder.`,
    );
  }
  await removeStaleControl(path);

  // Sockets we have answered but not yet finished shutting down. They are kept
  // open on purpose: the exit code is written here as the process's last act.
  const waiting = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const command = buf.slice(0, nl).trim();

      if (command === "ping") {
        socket.end("pong\n");
        return;
      }
      if (command !== "stop") {
        socket.end("err unknown command\n");
        return;
      }

      opts.log?.info({ path }, "stop requested over the control channel");
      // Acknowledge first, so the client knows it was heard and can report
      // "stopping" rather than sitting in silence while consolidation runs.
      socket.write("ok\n");
      waiting.add(socket);
      socket.once("close", () => waiting.delete(socket));
      opts.onStop();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    path,
    async announceExit(code: number): Promise<void> {
      // `end(payload)` flushes before closing, so the code cannot be truncated by
      // the process exiting a moment later.
      const pending = [...waiting];
      waiting.clear();
      await Promise.all(
        pending.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.end(`${code}\n`, () => resolve());
              // Never let a wedged socket hold the shutdown open.
              const t = setTimeout(() => {
                s.destroy();
                resolve();
              }, 500);
              t.unref?.();
            }),
        ),
      );
    },
    async close(): Promise<void> {
      for (const s of waiting) s.destroy();
      waiting.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeStaleControl(path);
    },
  };
}

/* --------------------------------------------------------------- the client */

export type StopResult =
  | { ok: true; exitCode: number; path: string }
  | { ok: false; reason: "not-running"; path: string }
  | { ok: false; reason: "no-response"; path: string };

/**
 * Ask a running Elix to stop, and wait for it to report its exit code.
 *
 * Resolves `not-running` rather than throwing when there is nothing there, so
 * the caller can print one clear line and exit 1 rather than a stack trace.
 */
export async function requestStop(
  projectRoot: string,
  opts: { timeoutMs?: number } = {},
): Promise<StopResult> {
  const path = controlPath(projectRoot);
  const timeoutMs = opts.timeoutMs ?? STOP_REQUEST_TIMEOUT_MS;

  return new Promise<StopResult>((resolve) => {
    let settled = false;
    const finish = (r: StopResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };

    const socket = net.connect({ path });
    let buf = "";
    socket.setEncoding("utf8");

    const timer = setTimeout(() => finish({ ok: false, reason: "no-response", path }), timeoutMs);
    timer.unref?.();

    socket.once("connect", () => socket.write("stop\n"));
    // ENOENT: nothing was ever there. ECONNREFUSED: a socket file survived a
    // crash. Both mean "Elix is not running", which is the answer the user wants.
    socket.once("error", () => finish({ ok: false, reason: "not-running", path }));
    socket.on("data", (chunk: string) => {
      buf += chunk;
    });
    // The server ends the socket as its final act, just before exiting, so EOF
    // means the shutdown really finished rather than merely being requested.
    socket.once("end", () => {
      const lines = buf.split("\n").map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      const code = last !== undefined && /^\d+$/.test(last) ? Number.parseInt(last, 10) : 0;
      finish({ ok: true, exitCode: code, path });
    });
  });
}