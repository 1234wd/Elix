/**
 * Clean process exit.
 *
 * Every exit path in Elix goes through here. Calling `process.exit()` directly
 * races pino's output flush and, on Windows, can abort with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (-1073740791).
 *
 * The rule: set `process.exitCode`, then let the event loop drain naturally.
 * If something keeps the loop alive (a socket, a timer, a stuck cleanup), force
 * the exit on a short timer so we never hang. The logger is synchronous
 * (pino-pretty with sync:true, or plain JSON), so nothing is lost.
 */

let scheduled = false;
let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
let drainHandle: NodeJS.Immediate | null = null;

/** How long to let the event loop drain before forcing the process down. */
const FORCE_EXIT_AFTER_MS = 250;

/**
 * Exit with `code` without corrupting the logger's handles.
 *
 * @param code 0 = success, 1 = error, 2 = permanent disconnect (e.g. not
 *              whitelisted), 130 = forced by a second Ctrl+C.
 */
export function exitCleanly(code: number): void {
  process.exitCode = code;
  if (scheduled) return;
  scheduled = true;

  // Let pending I/O and microtasks finish.
  drainHandle = setImmediate(() => {
    drainHandle = null;
    // If the loop is empty we exit here on our own via exitCode. If something is
    // holding it open, stop waiting — a clean code is better than a hang, and
    // better than an abort from a half-torn-down handle.
    forceExitTimer = setTimeout(() => {
      process.exit(code);
    }, FORCE_EXIT_AFTER_MS);
    forceExitTimer.unref?.();
  });
}

/** Test seam: cancel a pending forced exit so the next test starts clean. */
export function resetExitState(): void {
  scheduled = false;
  if (drainHandle !== null) {
    clearImmediate(drainHandle);
    drainHandle = null;
  }
  if (forceExitTimer !== null) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
}