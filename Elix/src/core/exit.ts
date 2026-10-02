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
let drainHandle: NodeJS.Immediate | null = null;
let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

/** The code that was actually committed to. Later calls are ignored. */
let committedCode = 0;

/** How long to let the event loop drain before forcing the process down. */
const FORCE_EXIT_AFTER_MS = 250;

/**
 * Exit with `code` without corrupting the logger's handles.
 *
 * The FIRST call wins. This matters in practice: a second Ctrl+C commits 130,
 * then the first shutdown finishes and asks for 0. If the loop drains before the
 * force-exit timer, `process.exitCode` — not the timer — decides the outcome, so
 * a later `exitCleanly(0)` would have silently downgraded a forced exit to a
 * success. Later calls are ignored (and reported at debug level).
 *
 * @param code 0 = success, 1 = error, 2 = permanent disconnect (e.g. not
 *              whitelisted), 130 = forced by a second Ctrl+C.
 * @returns the code that was committed to — the caller's, if it won.
 */
export function exitCleanly(code: number): number {
  if (scheduled) {
    // Someone already decided. Don't let a later success overwrite a forced
    // exit, or a permanent-disconnect code become 0.
    console.debug(`[exit] ignoring exitCleanly(${code}); already exiting with ${committedCode}`);
    return committedCode;
  }

  scheduled = true;
  committedCode = code;
  process.exitCode = code;

  // Let pending I/O and microtasks finish.
  drainHandle = setImmediate(() => {
    drainHandle = null;
    // If the loop is empty we exit here on our own via exitCode. If something is
    // holding it open, stop waiting — a clean code is better than a hang, and
    // better than an abort from a half-torn-down handle.
    forceExitTimer = setTimeout(() => {
      process.exit(committedCode);
    }, FORCE_EXIT_AFTER_MS);
    forceExitTimer.unref?.();
  });

  return code;
}

/** The code that was committed to, for tests and diagnostics. */
export function committedExitCode(): number {
  return committedCode;
}

/** Test seam: cancel a pending forced exit so the next test starts clean. */
export function resetExitState(): void {
  scheduled = false;
  committedCode = 0;
  if (drainHandle !== null) {
    clearImmediate(drainHandle);
    drainHandle = null;
  }
  if (forceExitTimer !== null) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
}