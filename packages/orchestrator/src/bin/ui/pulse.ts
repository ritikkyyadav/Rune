// --- The pulse: liveness that cannot lie ---
// A spinner turns at the same rate whether the process is streaming a hundred
// kilobytes a second or has been wedged for four minutes. It is the one element
// on screen whose entire job is to prove the process is alive, and the one
// element structurally incapable of reporting that it isn't. The breathing mark
// this replaces had the same defect in a prettier form: it was eased off
// `Date.now()`, so it went on breathing, calmly and beautifully, through a
// hung tool call.
//
// The fix is to drive it from the thing it claims to be about. Every scrap of
// real output the turn produces -- streamed prose, reasoning deltas, tool
// arguments, a sub-agent heartbeat, a call opening or closing -- is fed in as
// `units`. The accumulator decays exponentially, so the level rises while data
// arrives and falls when it stops. Two properties follow, and they are the
// whole point:
//
//   . it cannot lie -- when the bytes stop, the pulse stops.
//   . the stall is STATED, not inferred -- past `QUIET_AFTER_MS` the caller
//     swaps its counter for `quiet 31s`, in words, so nothing is carried by
//     the glyph or by colour alone.
//
// A pulse that moves on a timer is the bug. That is a test, not a remark:
// feed nothing and the level must fall to zero and stay there.

import {
  PULSE_GLYPHS,
  PULSE_RAMP,
  PULSE_RAMP_ASCII,
  TERMINAL_GLYPH_MODE,
  pulseGlyphAt,
} from "./glyphs";

export { PULSE_RAMP, PULSE_RAMP_ASCII } from "./glyphs";

/** Half-life of the accumulator. Short enough that a stall is visible inside a
 *  breath, long enough that the ragged gaps between token bursts don't flicker. */
const HALF_LIFE_MS = 900;

/**
 * Accumulator value that reads as a full bar. A steady rate R settles at
 * roughly R | 1.3 within ~3s, and `1 - e^(-acc/FULL)` then maps, measured:
 *
 *     100 B/s -> 0    400 B/s -> 2    1.5 kB/s -> 5
 *     200 B/s -> 1    800 B/s -> 3    3 kB/s+  -> 7
 *
 * The resolution is deliberately spent on the 200 B/s...3 kB/s band, because
 * that is the ambiguous one -- the band where a person is wondering whether the
 * thing is stuck. Above it, nothing needs saying that a pinned bar doesn't
 * already say. Below it, step 0 is shared with a dead stream, and that is
 * fine and on purpose: the two are told apart by the `quiet Ns` word, not by
 * the glyph, which is the rule everywhere else here too.
 */
const FULL_SCALE = 1500;

/** How long without a single unit before the row must say so in words. */
export const QUIET_AFTER_MS = 4000;

/** Levels in the ramp. One cell, eight steps -- see PULSE_RAMP. */
export const PULSE_LEVELS = PULSE_GLYPHS.length;

/**
 * What a discrete event is worth when it carries no byte count of its own.
 * These are real, countable proof of life -- a tool call does not stream, but a
 * tool call opening is not nothing -- so they are weighted to register as a
 * burst and then decay like everything else rather than pinning the level.
 */
export const PULSE_WEIGHT = {
  /** A tool call opened or closed; a provider retry or switch landed. */
  callback: 400,
  /** A sub-agent or worker reported progress. */
  heartbeat: 250,
  /** One delta that carried no measurable text (e.g. redacted reasoning). */
  token: 24,
} as const;

export interface PulseSample {
  /** 0...1 -- the decayed output rate, normalised. */
  level: number;
  /** 0...7 -- `level` quantised onto the ramp. Repaints inside a step are
   *  byte-identical, so the rung is not redrawn on every streamed token. */
  step: number;
  /** True once nothing has arrived for `QUIET_AFTER_MS`. */
  quiet: boolean;
  /** Milliseconds since the last unit of real output. */
  quietMs: number;
}

export class Pulse {
  private acc = 0;
  private agedAt: number;
  private lastFeedAt: number;

  constructor(now: number = Date.now()) {
    this.agedAt = now;
    this.lastFeedAt = now;
  }

  /** Record real output. `units` is bytes where bytes exist, and one of
   *  PULSE_WEIGHT otherwise. Non-positive input is ignored -- feeding zero to
   *  "keep it alive" is precisely the lie this class exists to prevent. */
  feed(units: number, now: number = Date.now()): void {
    if (!Number.isFinite(units) || units <= 0) return;
    this.age(now);
    this.acc += units;
    this.lastFeedAt = now;
  }

  sample(now: number = Date.now()): PulseSample {
    this.age(now);
    const level = 1 - Math.exp(-this.acc / FULL_SCALE);
    const quietMs = Math.max(0, now - this.lastFeedAt);
    return {
      level,
      step: Math.min(PULSE_LEVELS - 1, Math.max(0, Math.floor(level * PULSE_LEVELS))),
      quiet: quietMs >= QUIET_AFTER_MS,
      quietMs,
    };
  }

  /** Start a fresh turn: no carried-over level, and the quiet clock restarts
   *  from now rather than from whenever the last turn went silent. */
  reset(now: number = Date.now()): void {
    this.acc = 0;
    this.agedAt = now;
    this.lastFeedAt = now;
  }

  private age(now: number): void {
    const dt = now - this.agedAt;
    if (dt <= 0) return;
    this.agedAt = now;
    this.acc *= Math.pow(0.5, dt / HALF_LIFE_MS);
    if (this.acc < 1e-3) this.acc = 0;
  }
}

/** The one-cell mark for a sample, on whichever rung the surface is running. */
export function pulseGlyph(sample: PulseSample, ascii?: boolean): string {
  const mode = ascii === true ? "ascii" : ascii === false ? "utf8" : TERMINAL_GLYPH_MODE;
  return pulseGlyphAt(sample.step, mode);
}

/** The words that carry the stall when the glyph cannot -- `quiet 31s`. */
export function quietLabel(sample: PulseSample): string | null {
  if (!sample.quiet) return null;
  return `quiet ${Math.floor(sample.quietMs / 1000)}s`;
}
