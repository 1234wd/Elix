/**
 * Reconnect scheduler — encapsulates the "one disconnect = one reconnect" rule.
 *
 * Pure logic, no mineflayer: the bot factory calls `scheduleReconnect` from the
 * "end" handler only. `cancel` is called on shutdown. Unit-testable in isolation.
 */

export interface ScheduleResult {
  /** Whether a reconnect was scheduled */
  scheduled: boolean;
  /** Which attempt number this is (1-based) */
  attempt: number;
  /** Milliseconds until the reconnect fires */
  delayMs: number;
}

export class ReconnectScheduler {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  /**
   * Schedule a reconnect if the disconnect is retryable.
   * Returns null if the disconnect is permanent (ban/whitelist/etc) or if
   * a reconnect is already pending.
   */
  scheduleReconnect(
    shouldRetry: boolean,
    retryAfterMs: number,
    reconnectFn: () => void,
  ): ScheduleResult | null {
    if (this.cancelled) return null;
    if (!shouldRetry) return null;
    if (this.timer !== null) return null; // already pending — refuse

    this.attempt++;
    const attempt = this.attempt;
    const delayMs = retryAfterMs;

    this.timer = setTimeout(() => {
      this.timer = null; // clear before firing so a new one can be scheduled
      if (!this.cancelled) {
        reconnectFn();
      }
    }, delayMs);

    return { scheduled: true, attempt, delayMs };
  }

  /** Cancel any pending reconnect (called on shutdown). */
  cancel(): void {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Forget the backoff ladder after a successful spawn, so the next kick starts
   * at 5 s again. A pending timer is deliberately NOT cancelled — the
   * connection is live right now.
   */
  reset(): void {
    this.attempt = 0;
  }

  /** Whether a reconnect is currently pending. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Current attempt count (for testing). */
  get currentAttempt(): number {
    return this.attempt;
  }
}
