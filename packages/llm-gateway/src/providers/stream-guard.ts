import { ApiError } from "../types";

/**
 * Idle watchdog for provider streams.
 *
 * One timer, re-armed on every received chunk, and — the part that matters —
 * LIVE while awaiting the next one. A stream that stops producing bytes
 * without erroring (wedged proxy, dead TCP session, provider brownout) gets
 * aborted after `betweenMs` of silence instead of hanging the CLI until the
 * user gives up and hits Esc. Before the first chunk the allowance is
 * `firstMs` (connection + queue + first-token latency are legitimately slow).
 *
 * The abort is delivered through this watchdog's own controller, with the
 * caller's signal chained in — so `timeoutError()` can tell a watchdog stall
 * (retryable 504 the gateway may retry/fall back on) apart from a user Esc
 * (which the gateway rethrows untouched).
 */
export class IdleWatchdog {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stalledAfterMs = 0;
  /** Pass this to the provider SDK / fetch in place of the caller's signal. */
  readonly signal: AbortSignal;

  constructor(
    private readonly provider: string,
    private readonly callerSignal?: AbortSignal,
    private readonly firstMs = 90_000,
    private readonly betweenMs = 30_000,
  ) {
    this.signal = this.controller.signal;
    if (callerSignal?.aborted) this.controller.abort();
    callerSignal?.addEventListener("abort", () => this.controller.abort());
    this.arm(this.firstMs);
  }

  /** Call once per received chunk: keeps the timer live while awaiting the next. */
  beat(): void {
    this.arm(this.betweenMs);
  }

  /** Stream finished (or errored) — stop the timer. Safe to call twice. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * When the stream died because THIS watchdog fired (and not because the
   * caller aborted), the retryable timeout to throw in place of the SDK's
   * opaque abort error; null otherwise.
   */
  timeoutError(): ApiError | null {
    if (this.stalledAfterMs > 0 && !this.callerSignal?.aborted) {
      return new ApiError({
        status: 504,
        provider: this.provider,
        message: `stream stalled — no data for ${Math.round(this.stalledAfterMs / 1000)}s`,
      });
    }
    return null;
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalledAfterMs = ms;
      this.controller.abort();
    }, ms);
  }
}
