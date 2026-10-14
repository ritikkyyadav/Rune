// ─── Was the machine asleep? ───
//
// A laptop that sleeps mid-request comes back to a dead socket, and until
// R2 of docs/program/rune-reliability-plan-20261014.md the loop read that as
// the provider failing: the error spent one of the run's few consecutive
// errors, and the outage clock kept running while nobody was there, so a lid
// closed over a long run ended it `provider_lost`. The record shows exactly
// that on 12 October: the lid closed at 01:21 IST, and the run's five "Unable
// to connect" failures all fell inside the two dark wakes that followed
// (01:25:25–01:25:36 and 01:31:15–01:31:21, `pmset -g log`) — a few seconds
// of running with no network, each spending the run's error budget. Claude
// Code names the case ("Connection lost while your computer was asleep") and
// re-sends without counting it.
//
// How it knows: a timer ticks every second, and a timer does not fire while
// the process is suspended — the machine asleep, or the process stopped. A
// tick that finds the wall clock far beyond one period lived through a gap it
// did not run in, and records it. That holds whichever clock the runtime's
// `performance.now()` uses, and whether or not that clock pauses in sleep.
// A starved event loop can register as a gap too; all a gap buys is a re-send
// that does not count against the run, and those are bounded.

/** The tick period. */
const TICK_MS = 1_000;
/** A gap this far beyond one tick is a suspension, not a late timer. */
const GAP_MS = 5_000;
/** Gaps older than this are forgotten. A request is never this long. */
const KEEP_MS = 24 * 60 * 60_000;

/** What the loop asks of the clock. */
export interface SuspendProbe {
  /** Milliseconds of suspension that ended after `sinceWallMs` (epoch ms). */
  suspendedSince(sinceWallMs: number): number;
  /** When the last suspension ended (epoch ms), or null when none was seen. */
  lastWakeAt(): number | null;
}

export class SuspendClock implements SuspendProbe {
  private readonly now: () => number;
  private last: number;
  private gaps: Array<{ at: number; ms: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * `start: false` builds a clock that only moves when `tick` is called —
   * for a test that drives time itself.
   */
  constructor(opts: { start?: boolean; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.last = this.now();
    if (opts.start !== false) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      // Never the reason a process stays alive.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** One tick: record the gap since the last one when it was a suspension. */
  tick(at: number = this.now()): void {
    const gap = at - this.last - TICK_MS;
    if (gap > GAP_MS) this.gaps.push({ at, ms: gap });
    this.last = at;
    while (this.gaps.length > 0 && this.gaps[0]!.at < at - KEEP_MS) this.gaps.shift();
  }

  suspendedSince(sinceWallMs: number): number {
    // Tick first, so a gap that ended a moment ago — the machine just woke and
    // the failure is the first thing this process noticed — is counted.
    this.tick();
    let total = 0;
    for (const g of this.gaps) if (g.at > sinceWallMs) total += g.ms;
    return total;
  }

  lastWakeAt(): number | null {
    this.tick();
    return this.gaps.at(-1)?.at ?? null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let shared: SuspendClock | null = null;

/** The one clock a process shares, started on first use. */
export function sharedSuspendClock(): SuspendClock {
  shared ??= new SuspendClock();
  return shared;
}
