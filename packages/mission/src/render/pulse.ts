// ─── Gear · the pulse ───
// A spinner is an animation pretending to be a status. It turns at exactly the same
// rate whether a tool is streaming a hundred kilobytes a second or has been wedged
// since you went for coffee — it is the one element of a CLI whose whole job is to
// prove the process is alive, and the one element that cannot tell you when it isn't.
//
// The pulse is one cell, eight levels, driven by the operation's *actual* output:
// bytes on stdout, tokens, tool callbacks. It rises when data arrives and falls when
// it doesn't, and when the process stops the pulse stops — the row stops counting and
// starts saying `quiet 6s` instead. A flat pulse is information. A turning spinner
// never was.

/** Eight levels. The block ramp is Ambiguous-width, so it has an ASCII twin. */
export const PULSE_BLOCKS = "▁▂▃▄▅▆▇█";
export const PULSE_ASCII = "_..--==#";

export const LEVELS = 8;

export interface PulseOptions {
  /** how fast an idle pulse decays toward flat */
  halfLifeMs?: number;
  /** the rate that pins the top of the ramp, in bytes/sec */
  ceilingBytesPerSec?: number;
  /** silence past this reads as *quiet* rather than *slow* */
  quietAfterMs?: number;
}

/**
 * An exponentially-weighted rate meter with a log-scaled 8-level output. Log-scaled
 * because the interesting range spans a keystroke-per-second to a megabyte-per-second
 * and a linear ramp would sit pinned at either end for most real work.
 */
export class Pulse {
  private rate = 0; // bytes/sec, smoothed
  private lastSample: number;
  private lastArrival: number;
  private readonly halfLife: number;
  private readonly ceiling: number;
  private readonly quietAfter: number;

  constructor(now: number, opts: PulseOptions = {}) {
    this.lastSample = now;
    this.lastArrival = now;
    this.halfLife = opts.halfLifeMs ?? 600;
    this.ceiling = opts.ceilingBytesPerSec ?? 256 * 1024;
    this.quietAfter = opts.quietAfterMs ?? 3000;
  }

  /** Report output. `bytes` may be 0 — a callback with no payload still counts as life. */
  sample(bytes: number, now: number): void {
    // Measure the interval *before* decaying: decay() advances `lastSample` to `now`,
    // so reading it afterwards would make every gap look like one millisecond and
    // every trickle look like a flood.
    const dt = Math.max(1, now - this.lastSample) / 1000;
    this.decay(now);
    this.rate += bytes / dt;
    this.lastArrival = now;
  }

  private decay(now: number): void {
    const dt = now - this.lastSample;
    if (dt <= 0) return;
    this.rate *= Math.pow(0.5, dt / this.halfLife);
    this.lastSample = now;
  }

  /** 0–7. Zero means nothing has arrived recently, and zero is a fact worth printing. */
  level(now: number): number {
    // The guarantee is structural, not a consequence of the decay constant: once the
    // output has stopped for longer than the quiet threshold, the pulse is flat. An
    // exponential curve alone would leave a residue that keeps twitching at a process
    // which has been wedged for a minute — which is the exact lie a spinner tells.
    if (this.isQuiet(now)) return 0;
    this.decay(now);
    if (this.rate < 1) return 0;
    const scaled = Math.log10(this.rate) / Math.log10(this.ceiling);
    return Math.max(0, Math.min(LEVELS - 1, Math.round(scaled * (LEVELS - 1))));
  }

  /** How long the output has been silent. The row says this in words, not in a shape. */
  quietMs(now: number): number {
    return now - this.lastArrival;
  }

  /** True once silence is long enough that the row should stop counting and say so. */
  isQuiet(now: number): boolean {
    return this.quietMs(now) >= this.quietAfter;
  }
}

export const pulseGlyph = (level: number, ramp: "blocks" | "ascii"): string => {
  const set = ramp === "ascii" ? PULSE_ASCII : PULSE_BLOCKS;
  return set[Math.max(0, Math.min(LEVELS - 1, level))]!;
};
