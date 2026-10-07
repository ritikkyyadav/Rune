// ─── The glyph: Say's dictation mark, drawn in a row of cells ───
//
// Founder, 2026-10-02, on the working row: "the same animation glyph we have
// for our product Say ... for the overlay animation you will find this and can
// use that exact thing, with the colors that are present there."
//
// So this is a PORT, not a design. The mark is Say's overlay
// (`Say/say/waveform.py`, `overlay_theme.py`): twelve gapless columns standing
// on one continuous base, each column a spring, neighbours diffusion-coupled so
// the row settles like a stretched membrane rather than twelve meters. Every
// constant in the motion section below is Say's, under Say's name, and
// `ui-waveform.test.ts` holds the port to numbers produced by Say's own Python.
//
// Two things had to change to stand in a terminal, and nothing else did:
//
//   1. THE SHAPE is cells, not a polygon. Say's base is 2.5pt of a 19pt mark --
//      an eighth -- and an eighth of a cell is `▁`. So a column at height 0 is
//      `▁` and at height 1 is `█`: the ramp this codebase has always drawn
//      (`PULSE_GLYPHS`) is already Say's silhouette, quantised. Block cells are
//      gapless, so adjacent columns still share an edge.
//   2. THE INPUT is the run, not a microphone. Say draws a voice, syllable by
//      syllable: a few columns hit tall, then fall away. The run's syllable is
//      a BEAT -- the output that arrived since the last one, set down as one
//      stroke. How often it beats and how hard each stroke lands are both the
//      run's own output rate, so the mark is slow and low for a trickle, quick
//      and full-height for a long edit streaming flat out, and still when
//      nothing arrives. While the turn is in flight and the stream is silent --
//      a command running, the model thinking -- the mark does what Say does
//      while it decodes: one low hump sweeping the row.
//
// The first version of this drew the output as a travelling history instead,
// and the founder's reading of it is the reason it is gone: "trapped ... no
// single stroke is getting big hits, they are all living in the bottom ... like
// some ants are making some mess". Eighty tokens a second drawn as eighty small
// changes a second IS a crawl. So output is gathered and struck, a stroke may
// rise three levels in a frame and falls one, and a column that is not being
// struck does not move.

import { PULSE_GLYPHS, TERMINAL_GLYPH_MODE, type GlyphMode } from "./glyphs";
import { colorDepth, colorEnabled, dim, text } from "./theme";
import { nearestAnsi256 } from "./themes";
import { workLoad } from "./title";

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// ─── Motion (Say's waveform.py, unchanged) ───

/** Columns in the mark. */
export const BAND_COUNT = 12;

// Asymmetric spring: a column snaps up and falls away slowly. Attack is
// under-damped by a hair so each one lands with a trace of overshoot.
export const ATTACK_OMEGA = 46.0;
export const ATTACK_ZETA = 0.78;
export const RELEASE_OMEGA = 21.0;
export const RELEASE_ZETA = 1.0;
/** Energy kept when a column hits the base or the top. */
export const BOUNCE = 0.18;

// Neighbour diffusion, per second. Too little and the columns are separate
// meters; too much and the row smears into one blob.
export const COUPLING_PER_S = 8.0;
export const COUPLING_MAX_STEP = 0.45;

/** Physics substep, independent of the frame rate. */
export const MAX_SUBSTEP = 1.0 / 120.0;

// Resting ripple. About a pixel tall in Say; under one level here, so a
// resting mark is the flat base.
export const REST_HEIGHT = 0.055;
export const REST_HZ = 0.42;
export const REST_SKEW = 0.09;

// The sweep: a single hump crossing the row.
export const SWEEP_BANDS_PER_S = 9.0;
export const SWEEP_WIDTH = 1.7;
export const SWEEP_HEIGHT = 0.42;
export const SWEEP_PAD = 3.0;

// Outer columns are held slightly shorter so the mark reads as framed.
export const EDGE_TAPER_BANDS = 2.0;
export const EDGE_TAPER_FLOOR = 0.8;

const TAU = Math.PI * 2;

export type MotionState = "rest" | "listen" | "work";

/** How much of its input each column keeps: 0.83 at the ends, 1 inside. */
export function edgeTaper(bands: number = BAND_COUNT): number[] {
  const out: number[] = [];
  for (let i = 0; i < bands; i++) {
    const distance = Math.min(i, bands - 1 - i);
    const t = clamp01((distance + 0.5) / EDGE_TAPER_BANDS);
    out.push(EDGE_TAPER_FLOOR + (1 - EDGE_TAPER_FLOOR) * (t * t * (3 - 2 * t)));
  }
  return out;
}

/** The sweep's hump with its centre at `position`, in columns. */
export function sweepTargets(position: number, bands: number = BAND_COUNT): number[] {
  const width = 2 * SWEEP_WIDTH * SWEEP_WIDTH;
  return Array.from(
    { length: bands },
    (_, i) => SWEEP_HEIGHT * Math.exp(-((i - position) ** 2) / width),
  );
}

/**
 * Levels in, column heights out, as one coupled membrane.
 *
 * `tick` is Say's `BarMotion.tick`, state for state. `toward` is the same
 * integrator with the targets supplied by the caller, which is what the run's
 * own mark uses: its targets come from the stream, not from a spectrum.
 */
export class BarMotion {
  readonly bands: number;
  readonly taper: readonly number[];
  private levels: number[];
  private velocity: number[];
  private t = 0;
  private readonly couplingPerS: number;

  constructor(bands: number = BAND_COUNT, couplingPerS: number = COUPLING_PER_S) {
    this.couplingPerS = Math.max(0, couplingPerS);
    this.bands = Math.max(1, Math.floor(bands));
    this.levels = new Array<number>(this.bands).fill(0);
    this.velocity = new Array<number>(this.bands).fill(0);
    this.taper = edgeTaper(this.bands);
  }

  reset(): void {
    this.levels.fill(0);
    this.velocity.fill(0);
    this.t = 0;
  }

  get heights(): number[] {
    return [...this.levels];
  }

  tick(
    dt: number,
    levels: readonly number[] | null = null,
    gain = 0,
    state: MotionState = "listen",
  ): number[] {
    for (const h of substeps(dt)) {
      this.t += h;
      this.advance(h, this.targets(levels, gain, state));
    }
    return [...this.levels];
  }

  toward(dt: number, targets: readonly number[]): number[] {
    for (const h of substeps(dt)) {
      this.t += h;
      this.advance(h, targets);
    }
    return [...this.levels];
  }

  /** The resting ripple at this moment of the motion's own clock. */
  restTargets(): number[] {
    return Array.from(
      { length: this.bands },
      (_, i) => REST_HEIGHT * (0.5 + 0.5 * Math.sin(TAU * (this.t * REST_HZ - i * REST_SKEW))),
    );
  }

  private targets(levels: readonly number[] | null, gain: number, state: MotionState): number[] {
    if (state === "work") {
      const span = this.bands + 2 * SWEEP_PAD;
      return sweepTargets(((this.t * SWEEP_BANDS_PER_S) % span) - SWEEP_PAD, this.bands);
    }
    const rest = this.restTargets();
    if (state === "rest" || !levels || levels.length === 0) return rest;
    const g = clamp01(gain);
    // The ripple survives only in the gap the voice leaves behind, so two
    // idioms of motion are never visible at once.
    return rest.map((ripple, i) =>
      Math.max(clamp01(levels[i] ?? 0) * g * this.taper[i]!, ripple * (1 - g)),
    );
  }

  private advance(dt: number, targets: readonly number[]): void {
    for (let i = 0; i < this.bands; i++) {
      const target = targets[i] ?? 0;
      let level = this.levels[i]!;
      const rising = target > level;
      const omega = rising ? ATTACK_OMEGA : RELEASE_OMEGA;
      const zeta = rising ? ATTACK_ZETA : RELEASE_ZETA;
      const accel = (target - level) * omega * omega - 2 * zeta * omega * this.velocity[i]!;
      let velocity = this.velocity[i]! + accel * dt;
      level += velocity * dt;
      if (level < 0) {
        level = 0;
        if (velocity < 0) velocity = -velocity * BOUNCE;
      } else if (level > 1) {
        level = 1;
        if (velocity > 0) velocity = -velocity * BOUNCE;
      }
      this.levels[i] = level;
      this.velocity[i] = velocity;
    }
    // Membrane coupling: each column is tugged toward the mean of its
    // neighbours. Without it twelve springs simply run side by side.
    const k = Math.min(this.couplingPerS * dt, COUPLING_MAX_STEP);
    if (k > 0) {
      const previous = this.levels;
      const last = this.bands - 1;
      this.levels = previous.map((level, i) => {
        const left = i > 0 ? previous[i - 1]! : level;
        const right = i < last ? previous[i + 1]! : level;
        return level + k * (left + right - 2 * level);
      });
    }
  }
}

/** A frame's time, cut into physics steps. A late frame is clamped rather than
 *  integrated whole, so a dropped paint cannot make a spring explode. */
function substeps(dt: number): number[] {
  const span = Math.min(Math.max(dt, 1e-5), 0.25);
  const steps = Math.max(1, Math.ceil(span / MAX_SUBSTEP));
  return new Array<number>(steps).fill(span / steps);
}

// ─── Colour (Say's overlay_theme.py, unchanged) ───

export interface GlyphTheme {
  id: string;
  name: string;
  /** Cycled across the columns. Empty follows the terminal's own ink. */
  colors: readonly string[];
}

/** Say's catalogue, in Say's order. */
export const GLYPH_THEMES: readonly GlyphTheme[] = [
  { id: "ink", name: "Ink", colors: [] },
  { id: "ember", name: "Ember", colors: ["#D9713F", "#17150F"] },
  { id: "signal", name: "Signal", colors: ["#CA152C", "#FFECEE"] },
  { id: "crimson", name: "Crimson", colors: ["#CA152C", "#2C2C2E"] },
  { id: "mono", name: "Mono", colors: ["#17150F", "#FDFCF8"] },
  { id: "forest", name: "Forest", colors: ["#3F7D52", "#17150F"] },
  { id: "tide", name: "Tide", colors: ["#2E6F9E", "#FDFCF8"] },
  { id: "bloom", name: "Bloom", colors: ["#D9713F", "#E9B44C", "#17150F"] },
  { id: "dusk", name: "Dusk", colors: ["#6E4B8E", "#E9B44C"] },
];

/**
 * The colour the mark is drawn in unless told otherwise: the one Say's overlay
 * is set to on the founder's machine (`OVERLAY_THEME = custom`,
 * `OVERLAY_CUSTOM_COLORS = #B92D5D`, read 2026-10-02).
 */
export const GLYPH_COLORS: readonly string[] = ["#B92D5D"];

export type GlyphPattern = "pulse" | "spark" | "flow" | "drift" | "alternate";

/** The pattern that goes with that colour in the same settings. */
export const GLYPH_PATTERN: GlyphPattern = "drift";

const PHI = 0.6180339887498949;
const PULSE_SCATTER = 0.5;
const FLOW_SPEED = 0.34;
const SPARK_SHARE = 0.3;

/** Python's `round`: halves go to the even neighbour. */
const roundHalfEven = (value: number): number => {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
};

/**
 * Which colour each column takes this frame, as indices into the list.
 *
 * Pure and frame-local. `heights` are the 0...1 column heights the motion just
 * produced; `t` is a clock in seconds, read only by `flow`.
 */
export function columnColors(
  pattern: GlyphPattern,
  nColors: number,
  heights: readonly number[],
  t = 0,
): number[] {
  const bands = heights.length;
  if (nColors <= 1 || bands === 0) return new Array<number>(bands).fill(0);
  switch (pattern) {
    case "alternate":
      return heights.map((_, i) => i % nColors);
    case "drift":
      return heights.map((_, i) => Math.floor(((i * PHI) % 1) * nColors) % nColors);
    case "flow":
      return heights.map(
        (_, i) => Math.floor(((i / bands + t * FLOW_SPEED) % 1) * nColors) % nColors,
      );
    case "spark": {
      // The loudest few take the last colour. Rank, not threshold, so it holds
      // at any level.
      const keep = Math.max(1, roundHalfEven(bands * SPARK_SHARE));
      const hot = new Set(
        heights
          .map((height, i) => ({ height, i }))
          .sort((a, b) => b.height - a.height)
          .slice(0, keep)
          .map((entry) => entry.i),
      );
      return heights.map((_, i) => (hot.has(i) ? nColors - 1 : 0));
    }
    default:
      return heights.map((height, i) => {
        const mixed = clamp01(height) * (1 - PULSE_SCATTER) + ((i * PHI) % 1) * PULSE_SCATTER;
        return Math.min(nColors - 1, Math.floor(clamp01(mixed) * nColors));
      });
  }
}

/** `#B92D5D` -> [185, 45, 93], or null for anything that is not a hex triple. */
export function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((value ?? "").trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!;
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
}

// ─── The run's own mark ───

/** One frame, restated from ./working.ts so this module stays a leaf (a test
 *  holds the two equal). */
export const GLYPH_FRAME_MS = 90;

/**
 * Seconds between strokes: at rest, and flat out.
 *
 * 0.9s is 67 beats a minute, a heart at rest; 0.36s is 167, a heart working.
 * The beat is the whole of "calm": however fast the tokens come, the mark
 * moves this often and no oftener.
 */
export const CALM_BEAT_S = 0.9;
export const BRISK_BEAT_S = 0.36;

/** Output, in units a second, that reads as most of the way to flat out. An
 *  ordinary stream is 250; a long edit streaming is 1400. */
export const RATE_FULL = 900;

/** How quickly the rate follows the stream. Half a second: quick enough that
 *  one tool call opening is felt, slow enough that one late chunk is not. */
const RATE_SETTLE_S = 0.5;

/** Output gathered in one beat that lands a stroke most of the way up. An
 *  ordinary stream gathers about 165 a beat, so it hits high; the dynamic range
 *  below that is for a trickle. */
export const STROKE_FULL = 130;

/**
 * How far past its energy a stroke's target is set. The membrane shares a
 * column's height with its neighbours, so a target of exactly the energy lands
 * about a fifth short of it; this is what is given back.
 */
export const STROKE_LIFT = 1.25;

/**
 * Neighbour diffusion for the run's mark, per second.
 *
 * Say's is 8, tuned for a spectrum that re-asserts every column sixty times a
 * second. A stroke is asserted once and then let go, and at 8 the membrane
 * spreads it into a hill seven columns wide and half as tall -- the "living in
 * the bottom" the founder saw. At 3 a stroke keeps its height and still tugs
 * its neighbours into shoulders, which is all "one object" needs.
 */
export const STROKE_COUPLING_PER_S = 3.0;

/** What the second and third stroke of a beat stand at, beside the first.
 *  Close to level: the founder's third look asked for "a little bit uniform
 *  motion", and strokes of very different heights read as a scatter. A step
 *  down each, so the first of a beat is still the one the eye follows. */
export const CHORD = [1, 0.85, 0.72] as const;

/** Columns the whole pattern moves right between one beat and the next. One:
 *  each stroke lands beside where the last one is still coming down, so the
 *  beats read as a single wave walking the row rather than as separate hits. */
export const MARCH_COLUMNS = 1;

/** Under this energy a beat is one stroke; over CHORD_FULL_LOAD it is three. */
export const CHORD_MIN_ENERGY = 0.4;
export const CHORD_FULL_LOAD = 0.55;

/** What a discrete event is worth when it carries no byte count: a call
 *  opening or closing, a sub-agent reporting in, a delta with no text. Each is
 *  one stroke on its own, a call the taller. */
export const STROKE_WEIGHT = {
  callback: 160,
  heartbeat: 110,
  token: 24,
} as const;

/** A stroke's half-width in columns, and how much wider a full one is. A weak
 *  stroke lifts one column and nudges its neighbours; a strong one is a hill. */
export const STROKE_WIDTH = 0.42;
export const STROKE_WIDTH_GAIN = 0.22;

/** How long a stroke stands before it lets go, and how long letting go takes.
 *  The fall ENDS: an exponential tail left every old stroke standing one level
 *  high for a second, and a row of those is the crawl this mark must not be. */
export const STROKE_HOLD_S = 0.27;
export const STROKE_FADE_S = 0.75;

/** Levels a cell may climb in one frame, and fall. A hit lands in two frames;
 *  the way down is one level at a time, which is what makes it a fall and not
 *  a flicker. */
export const RISE_LEVELS = 4;
export const FALL_LEVELS = 1;

/** How far past a level's edge a height must be before the cell changes. A
 *  height resting on a boundary would otherwise chatter between two glyphs. */
const LEVEL_HYSTERESIS = 0.15;

/** One sweep of the row at rest, in seconds: a breath (BREATH_MS). */
export const CALM_SWEEP_S = 4.32;

/** Silence shorter than this is the ragged gap between two bursts of a stream,
 *  and the sweep stays out of it. */
export const GATE_HOLD_MS = 1200;

/** Silence this long and the sweep has the row to itself. */
export const GATE_SHUT_MS = 2600;

/** What the mark needs from the turn besides its output, once a paint. */
export interface GlyphBeat {
  /** Milliseconds since real output (./pulse.ts). */
  quietMs: number;
  /** Sub-agents running right now. They quicken the sweep. */
  agents?: number;
  /** A turn is in flight and is not waiting on a person. */
  live: boolean;
}

export interface GlyphFrame {
  /** One ramp index per column: 0 is the base `▁`, 7 is `█`. */
  levels: number[];
  /** The same columns before quantising, 0...1. */
  heights: number[];
}

/** How far a height is up the ramp. */
export function rampLevel(height: number): number {
  return Math.round(clamp01(height) * (PULSE_GLYPHS.length - 1));
}

/** Seconds between strokes at a load. Linear in tempo, not in the gap, so
 *  equal steps in load are equal steps in what the eye counts. */
export function beatGap(load: number): number {
  const calm = 1 / CALM_BEAT_S;
  return 1 / (calm + clamp01(load) * (1 / BRISK_BEAT_S - calm));
}

/** How much of itself a stroke still shows at an age: all of it while it
 *  stands, then a fall that starts briskly, eases, and reaches the base. */
function strokeEnvelope(age: number): number {
  if (age <= STROKE_HOLD_S) return 1;
  const left = 1 - (age - STROKE_HOLD_S) / STROKE_FADE_S;
  return left <= 0 ? 0 : left * left;
}

interface Stroke {
  at: number;
  column: number;
  energy: number;
}

/**
 * The mark for one turn, carried from paint to paint.
 *
 * `feed` it every scrap of real output the turn produces -- the same calls
 * that feed the liveness pulse. It gathers them, and on each beat sets what it
 * gathered down as a chord of strokes. WHEN it beats and HOW HARD are the
 * run's. WHERE is uniform: the strokes of a beat are spaced evenly across the
 * row, and the whole pattern marches one column right each beat -- the same
 * direction Say's sweep travels, so the mark has one direction of motion in
 * every state. The springs that carry a stroke up and let it down are Say's.
 */
export class WorkGlyph {
  readonly bands: number;
  private readonly motion: BarMotion;
  /** The mark's own clock, in seconds: frames it was actually painted for. */
  private clock = 0;
  private bucket: number | null = null;
  private sweep = -SWEEP_PAD;
  private frame: GlyphFrame;
  /** Output since the last stroke, and since the last frame. */
  private pending = 0;
  private arrived = 0;
  /** Units a second, eased. */
  private rate = 0;
  private sinceStroke = Number.POSITIVE_INFINITY;
  private standing: Stroke[] = [];
  private beaten = 0;
  /** Where the first stroke of the next beat lands, in columns. */
  private march = 0;
  /** Which cells climbed in the last frame. */
  private rose: boolean[];

  constructor(bands: number = BAND_COUNT) {
    this.motion = new BarMotion(bands, STROKE_COUPLING_PER_S);
    this.bands = this.motion.bands;
    this.rose = new Array<boolean>(this.bands).fill(false);
    this.frame = {
      levels: new Array<number>(this.bands).fill(0),
      heights: new Array<number>(this.bands).fill(0),
    };
  }

  /** Record real output: bytes where bytes exist, one of STROKE_WEIGHT
   *  otherwise. Nothing but real output moves the strokes. */
  feed(units: number): void {
    if (!Number.isFinite(units) || units <= 0) return;
    this.pending += units;
    this.arrived += units;
  }

  /** 0...1 -- how hard the run is working, by its own output rate. */
  get load(): number {
    return 1 - Math.exp(-this.rate / RATE_FULL);
  }

  /** Beats so far this turn. */
  get beats(): number {
    return this.beaten;
  }

  step(beat: GlyphBeat, now: number = Date.now()): GlyphFrame {
    // One frame of motion per painted frame, however late the paint was: a slow
    // terminal moves slower instead of teleporting. Two asks inside one frame
    // get the same answer.
    const bucket = Math.floor(now / GLYPH_FRAME_MS);
    if (bucket === this.bucket) return this.frame;
    this.bucket = bucket;
    const dt = GLYPH_FRAME_MS / 1000;
    this.clock += dt;
    this.sinceStroke += dt;

    this.rate += (this.arrived / dt - this.rate) * (1 - Math.exp(-dt / RATE_SETTLE_S));
    this.arrived = 0;

    if (!beat.live) {
      // The turn is over: nothing stands, nothing is owed.
      this.pending = 0;
      this.standing = [];
    } else {
      const gap = beatGap(this.load);
      if (this.pending > 0 && this.sinceStroke >= gap) {
        const energy = 1 - Math.exp(-(this.rate * gap) / STROKE_FULL);
        // More of the row dances the harder the run works: a trickle is one
        // stroke, an ordinary stream two, a run flat out three.
        const chord = energy < CHORD_MIN_ENERGY ? 1 : this.load > CHORD_FULL_LOAD ? 3 : 2;
        for (let voice = 0; voice < chord; voice++) {
          this.standing.push({
            at: this.clock,
            column: (this.march + (voice * this.bands) / chord) % this.bands,
            energy: energy * CHORD[voice]!,
          });
        }
        this.march = (this.march + MARCH_COLUMNS) % this.bands;
        this.beaten += 1;
        this.pending = 0;
        this.sinceStroke = 0;
      }
    }

    const heights = this.motion.toward(dt, this.targets(beat, dt));
    const top = PULSE_GLYPHS.length - 1;
    const levels = heights.map((height, i) => {
      const shown = this.frame.levels[i]!;
      const exact = clamp01(height) * top;
      const wanted = Math.abs(exact - shown) < 0.5 + LEVEL_HYSTERESIS ? shown : Math.round(exact);
      const next = Math.min(shown + RISE_LEVELS, Math.max(shown - FALL_LEVELS, wanted));
      // A cell that climbed last frame stands for this one. Say's attack
      // overshoots by a hair, which on a display is life and on an eight-level
      // ramp is a cell going up and straight back down: a twitch.
      const held = next < shown && this.rose[i]!;
      this.rose[i] = next > shown;
      return held ? shown : next;
    });
    this.frame = { levels, heights };
    return this.frame;
  }

  private targets(beat: GlyphBeat, dt: number): number[] {
    if (!beat.live) {
      this.sweep = -SWEEP_PAD;
      return this.motion.restTargets();
    }
    // How much of the row the strokes have: all of it while output is
    // arriving, none once it has been silent for a while.
    const gate = 1 - smoothstep(GATE_HOLD_MS, GATE_SHUT_MS, Math.max(0, beat.quietMs));
    if (gate >= 1) {
      this.sweep = -SWEEP_PAD;
    } else {
      // One crossing a breath at rest, up to Say's own pace flat out.
      const span = this.bands + 2 * SWEEP_PAD;
      const calm = span / CALM_SWEEP_S;
      const load = workLoad({ level: this.load, agents: beat.agents ?? 0 });
      this.sweep += (calm + load * (SWEEP_BANDS_PER_S - calm)) * dt;
      if (this.sweep > this.bands + SWEEP_PAD) this.sweep -= span;
    }
    this.standing = this.standing.filter((stroke) => strokeEnvelope(this.clock - stroke.at) > 0);
    const idle = sweepTargets(this.sweep, this.bands);
    return idle.map((hump, i) => {
      // The tallest stroke over a column, not their sum: two hills side by
      // side stay two hills instead of merging into a slab.
      let voice = 0;
      for (const stroke of this.standing) {
        const width = STROKE_WIDTH + STROKE_WIDTH_GAIN * stroke.energy;
        const reach = Math.exp(-((i - stroke.column) ** 2) / (2 * width * width));
        voice = Math.max(voice, stroke.energy * strokeEnvelope(this.clock - stroke.at) * reach);
      }
      return Math.max(
        // Past 1 on purpose: the spring stops at the top, and a target a
        // little beyond it is what gets a full stroke all the way there.
        Math.min(1.2, voice * STROKE_LIFT) * this.motion.taper[i]!,
        hump * (1 - gate),
      );
    });
  }
}

// ─── Paint ───

export interface GlyphPaint {
  mode?: GlyphMode;
  /** Off under NO_COLOR and when piped. Defaults to the terminal's own answer. */
  color?: boolean;
  depth?: "truecolor" | "ansi256" | "ansi16";
  colors?: readonly string[];
  pattern?: GlyphPattern;
  /** Seconds, for the `flow` pattern. */
  t?: number;
}

const RESET = "\x1b[0m";

/** The cells for a row of levels, unpainted. */
export function glyphCells(
  levels: readonly number[],
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
): string[] {
  const top = PULSE_GLYPHS.length - 1;
  return levels.map((level) => {
    const cell = PULSE_GLYPHS[Math.min(top, Math.max(0, Math.round(level)))]!;
    // Blocks only where a cell is known to be one column wide; the twins are a
    // ramp too, so the motion survives a seven-bit terminal.
    return mode === "utf8" ? cell.utf8 : cell.ascii;
  });
}

function paintRgb(
  rgb: [number, number, number],
  depth: GlyphPaint["depth"],
  value: string,
): string {
  if (depth === "truecolor") return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${value}${RESET}`;
  if (depth === "ansi256") return `\x1b[38;5;${nearestAnsi256(rgb)}m${value}${RESET}`;
  // Sixteen colours cannot name this one, so the mark takes the terminal's ink.
  return text(value);
}

/**
 * The mark, painted: one path's worth of cells, the colours laid through it.
 *
 * The colour is Say's, asked for by value, because a theme slot would hand
 * back whatever the active theme calls an accent. That also means it is
 * painted in a theme that defers to the host's own colours (`auto` on a
 * terminal that will not report its background): those themes go plain because
 * their pigments assume a ground, and this one colour was chosen to stand on
 * light and dark alike (5.9:1 on white, 3.6:1 on black). Under NO_COLOR and on
 * a seven-bit terminal it is the bare cells.
 */
export function paintGlyph(frame: GlyphFrame, opts: GlyphPaint = {}): string {
  const mode = opts.mode ?? TERMINAL_GLYPH_MODE;
  const cells = glyphCells(frame.levels, mode);
  const painted = opts.color ?? colorEnabled;
  if (!painted || mode === "ascii") return cells.join("");
  const palette = (opts.colors ?? GLYPH_COLORS)
    .map(parseHex)
    .filter((rgb): rgb is [number, number, number] => rgb != null);
  if (palette.length === 0) return text(cells.join(""));
  const depth = opts.depth ?? colorDepth;
  const picks = columnColors(
    opts.pattern ?? GLYPH_PATTERN,
    palette.length,
    frame.heights,
    opts.t ?? 0,
  );
  // Neighbours in the same colour share one escape.
  const parts: string[] = [];
  let run = "";
  let pick = -1;
  const flush = (): void => {
    if (run) parts.push(paintRgb(palette[pick]!, depth, run));
    run = "";
  };
  cells.forEach((cell, i) => {
    const next = picks[i] ?? 0;
    if (next !== pick) {
      flush();
      pick = next;
    }
    run += cell;
  });
  flush();
  return parts.join("");
}

/** The mark at rest: the base alone, dim, not moving. Colour is for a run
 *  that is in flight. */
export function restGlyph(
  bands: number = BAND_COUNT,
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
): string {
  return dim(glyphCells(new Array<number>(bands).fill(0), mode).join(""));
}
