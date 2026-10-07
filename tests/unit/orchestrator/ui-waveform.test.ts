/**
 * The glyph: Say's dictation mark, drawn in a row of cells.
 *
 * Founder, 2026-10-02: "the same animation glyph we have for our product Say
 * ... use that exact thing, with the colors that are present there."
 *
 * "Exact" is a claim about numbers, so it is held to numbers. The reference
 * values in this file were produced by Say's own Python (`Say/say/waveform.py`
 * and `overlay_theme.py`, run 2026-10-02) on the inputs stated beside them.
 * Four claims:
 *
 *   1. the PORT -- the springs, the membrane, the sweep, the ripple, the taper
 *      and the colour patterns give Say's numbers;
 *   2. the SHAPE -- a column at rest is the base `▁`, a full one is `█`, and
 *      the row is always the same width;
 *   3. the RUN'S MARK -- real output is gathered into beats and struck, the
 *      tempo and the height are the run's own rate, it sweeps while a live
 *      turn is silent, and it is flat when there is no turn;
 *   4. the CALM -- a hit may climb four levels in a frame and falls one, a
 *      stroke ends at the base, and no column ever twitches.
 *
 * Claims 3 and 4 were rewritten on the founder's second look (2026-10-02). The
 * first version drew output as a low travelling history and capped every cell
 * at one level a frame: "trapped ... no single stroke is getting big hits, they
 * are all living in the bottom ... like some ants are making some mess". So
 * what is pinned now is the opposite of what was pinned then: strokes hit
 * HIGH, most of the row RESTS, and the small restless changes are gone.
 */
import { describe, expect, it } from "bun:test";
import {
  BAND_COUNT,
  BRISK_BEAT_S,
  BarMotion,
  CALM_BEAT_S,
  CALM_SWEEP_S,
  FALL_LEVELS,
  GATE_SHUT_MS,
  GLYPH_COLORS,
  GLYPH_FRAME_MS,
  GLYPH_PATTERN,
  GLYPH_THEMES,
  RISE_LEVELS,
  STROKE_WEIGHT,
  SWEEP_HEIGHT,
  WorkGlyph,
  beatGap,
  columnColors,
  edgeTaper,
  glyphCells,
  paintGlyph,
  parseHex,
  rampLevel,
  type GlyphBeat,
  type GlyphFrame,
} from "../../../packages/orchestrator/src/bin/ui/waveform";
import { PULSE_GLYPHS } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { BREATH_MS, FRAME_MS } from "../../../packages/orchestrator/src/bin/ui/working";

const DT = 0.09;
const SPECTRUM = [0.1, 0.9, 0.3, 0.7, 0.0, 1.0, 0.5, 0.2, 0.8, 0.4, 0.6, 0.05];

/** Six decimals: what the reference run printed. */
const near = (got: readonly number[], want: readonly number[]): void => {
  expect(got.length).toBe(want.length);
  got.forEach((value, i) => expect(Math.abs(value - want[i]!)).toBeLessThan(1e-5));
};

const LIVE: GlyphBeat = { quietMs: 0, live: true };
const TOP = PULSE_GLYPHS.length - 1;

/** Paint the mark `frames` times, feeding `rate` units a second of output. */
function run(
  glyph: WorkGlyph,
  frames: number,
  opts: { rate?: number; beat?: GlyphBeat | ((frame: number) => GlyphBeat); from?: number } = {},
): GlyphFrame[] {
  const out: GlyphFrame[] = [];
  const from = opts.from ?? 0;
  for (let f = 0; f < frames; f++) {
    if (opts.rate) glyph.feed((opts.rate * GLYPH_FRAME_MS) / 1000);
    const beat = typeof opts.beat === "function" ? opts.beat(f) : (opts.beat ?? LIVE);
    out.push(glyph.step(beat, (from + f) * GLYPH_FRAME_MS));
  }
  return out;
}

const peak = (frames: readonly GlyphFrame[]): number =>
  Math.max(...frames.flatMap((frame) => frame.levels));
const flat = (frame: GlyphFrame): boolean => frame.levels.every((level) => level === 0);

describe("the port", () => {
  it("sweeps the way Say's does: one hump, the same numbers", () => {
    const motion = new BarMotion();
    const frames: number[][] = [];
    for (let i = 0; i < 30; i++) frames.push(motion.tick(DT, null, 0, "work"));
    near(
      frames[0]!,
      [0.134106, 0.064505, 0.021071, 0.005265, 0.001059, 0.000175, 2.4e-5, 3e-6, 0, 0, 0, 0],
    );
    near(
      frames[9]!,
      [
        0.063179, 0.100007, 0.173965, 0.272226, 0.357111, 0.388469, 0.323099, 0.199735, 0.091836,
        0.031858, 0.009169, 0.002703,
      ],
    );
    near(
      frames[29]!,
      [
        0.196183, 0.265233, 0.34756, 0.390258, 0.3433, 0.225225, 0.109793, 0.040188, 0.011834,
        0.00299, 0.000679, 0.00017,
      ],
    );
  });

  it("follows a spectrum, and lets go of it, the way Say's does", () => {
    const motion = new BarMotion();
    const frames: number[][] = [];
    for (let i = 0; i < 12; i++) frames.push(motion.tick(DT, SPECTRUM, 1, "listen"));
    for (let i = 0; i < 6; i++) frames.push(motion.tick(DT, SPECTRUM, 0, "listen"));
    near(
      frames[0]!,
      [
        0.28887, 0.663171, 0.484196, 0.571165, 0.392006, 0.770762, 0.533628, 0.407265, 0.645429,
        0.489188, 0.473363, 0.192699,
      ],
    );
    near(
      frames[11]!,
      [
        0.38101, 0.706493, 0.549194, 0.615975, 0.475885, 0.813317, 0.602413, 0.488035, 0.682716,
        0.53832, 0.505013, 0.257967,
      ],
    );
    near(
      frames[17]!,
      [
        0.013087, 0.02095, 0.032557, 0.043703, 0.051228, 0.052374, 0.045969, 0.033872, 0.019969,
        0.00912, 0.004172, 0.004009,
      ],
    );
  });

  it("rests on Say's ripple, which is under one level of the ramp", () => {
    const motion = new BarMotion();
    let heights: number[] = [];
    for (let i = 0; i < 20; i++) heights = motion.tick(DT, null, 0, "rest");
    near(
      heights,
      [
        0.005982, 0.011358, 0.021651, 0.034035, 0.045, 0.051875, 0.051831, 0.044327, 0.031616,
        0.017742, 0.007361, 0.002752,
      ],
    );
    expect(heights.map(rampLevel).every((level) => level === 0)).toBe(true);
  });

  it("holds the outer columns a little shorter", () => {
    near(edgeTaper(12), [0.83125, 0.96875, 1, 1, 1, 1, 1, 1, 1, 1, 0.96875, 0.83125]);
  });

  it("lays colours through the columns by Say's five patterns", () => {
    const want = {
      pulse: { 2: [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0], 3: [0, 2, 0, 2, 0, 1, 1, 0, 2, 1, 1, 1] },
      spark: { 2: [0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0], 3: [0, 2, 0, 2, 0, 2, 0, 0, 2, 0, 0, 0] },
      flow: { 2: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0], 3: [1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1] },
      drift: { 2: [0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 3: [0, 1, 0, 2, 1, 0, 2, 0, 2, 1, 0, 2] },
      alternate: {
        2: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
        3: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2],
      },
    } as const;
    for (const pattern of ["pulse", "spark", "flow", "drift", "alternate"] as const) {
      for (const n of [2, 3] as const) {
        expect(columnColors(pattern, n, SPECTRUM, 1.7)).toEqual([...want[pattern][n]]);
      }
    }
  });

  it("carries Say's catalogue, and defaults to the colour Say is set to", () => {
    expect(GLYPH_THEMES.map((theme) => theme.id)).toEqual([
      "ink",
      "ember",
      "signal",
      "crimson",
      "mono",
      "forest",
      "tide",
      "bloom",
      "dusk",
    ]);
    expect(GLYPH_THEMES.find((theme) => theme.id === "bloom")!.colors).toEqual([
      "#D9713F",
      "#E9B44C",
      "#17150F",
    ]);
    expect(GLYPH_COLORS).toEqual(["#B92D5D"]);
    expect(GLYPH_PATTERN).toBe("drift");
    expect(parseHex("#B92D5D")).toEqual([185, 45, 93]);
    expect(parseHex("b2d")).toEqual([187, 34, 221]);
    expect(parseHex("crimson")).toBeNull();
  });
});

describe("the shape", () => {
  it("stands on the base and tops out at the full block", () => {
    expect(rampLevel(0)).toBe(0);
    expect(rampLevel(1)).toBe(PULSE_GLYPHS.length - 1);
    expect(glyphCells([0, 7], "utf8")).toEqual(["▁", "█"]);
    expect(glyphCells([0, 7], "ascii")).toEqual(["_", "#"]);
    // An ambiguous-width locale gets the twins: a block that renders double
    // eats its neighbour.
    expect(glyphCells([3], "ambig")).toEqual(["-"]);
  });

  it("is twelve cells wide in every state", () => {
    const glyph = new WorkGlyph();
    const frames = [
      ...run(glyph, 30, { beat: { quietMs: 0, live: false } }),
      ...run(glyph, 30, { rate: 1400, from: 30 }),
      ...run(glyph, 30, { beat: { quietMs: 9000, live: true }, from: 60 }),
    ];
    for (const frame of frames) {
      expect(frame.levels.length).toBe(BAND_COUNT);
      expect([...paintGlyph(frame, { color: false, mode: "utf8" })].length).toBe(BAND_COUNT);
    }
  });

  it("paints the colour Say is set to, by value", () => {
    const frame: GlyphFrame = { levels: [0, 3, 0], heights: [0, 0.4, 0] };
    expect(paintGlyph(frame, { color: true, mode: "utf8", depth: "truecolor" })).toBe(
      "\x1b[38;2;185;45;93m▁▄▁\x1b[0m",
    );
    expect(paintGlyph(frame, { color: false, mode: "utf8" })).toBe("▁▄▁");
    expect(paintGlyph(frame, { color: true, mode: "ascii", depth: "truecolor" })).toBe("_-_");
    // A two-colour theme is laid through the same cells, column by column.
    const two = paintGlyph(frame, {
      color: true,
      mode: "utf8",
      depth: "truecolor",
      colors: ["#D9713F", "#17150F"],
      pattern: "alternate",
    });
    expect(two).toBe(
      "\x1b[38;2;217;113;63m▁\x1b[0m\x1b[38;2;23;21;15m▄\x1b[0m\x1b[38;2;217;113;63m▁\x1b[0m",
    );
  });
});

describe("the run's mark", () => {
  it("runs on the same frame and the same breath as the rest of the row", () => {
    expect(GLYPH_FRAME_MS).toBe(FRAME_MS);
    expect(CALM_SWEEP_S * 1000).toBe(BREATH_MS);
  });

  it("is flat, and stays flat, when there is no turn -- whatever is fed to it", () => {
    const glyph = new WorkGlyph();
    const frames = run(glyph, 120, { rate: 1400, beat: { quietMs: 60_000, live: false } });
    for (const frame of frames) expect(flat(frame)).toBe(true);
    expect(glyph.beats).toBe(0);
  });

  it("does not move on a clock: no output, no strokes", () => {
    const glyph = new WorkGlyph();
    // Inside the gap a stream is allowed, so the sweep is out of it too.
    const frames = run(glyph, 100, { beat: { quietMs: 500, live: true } });
    expect(glyph.beats).toBe(0);
    for (const frame of frames) expect(flat(frame)).toBe(true);
  });

  it("gathers output into beats instead of drawing every chunk", () => {
    const glyph = new WorkGlyph();
    // Ten seconds of an ordinary stream is 111 frames of arriving text, and
    // about fifteen strokes.
    run(glyph, 111, { rate: 250 });
    expect(glyph.beats).toBeGreaterThanOrEqual(11);
    expect(glyph.beats).toBeLessThanOrEqual(18);
  });

  it("beats at the run's own tempo: a resting heart to a working one", () => {
    expect(beatGap(0)).toBeCloseTo(CALM_BEAT_S, 10);
    expect(beatGap(1)).toBeCloseTo(BRISK_BEAT_S, 10);
    const beats = (rate: number): number => {
      const glyph = new WorkGlyph();
      run(glyph, 150, { rate });
      return glyph.beats;
    };
    expect(beats(60)).toBeLessThan(beats(250));
    expect(beats(250)).toBeLessThan(beats(1400));
    // Never faster than the brisk beat, however fast the tokens come.
    expect(beats(50_000)).toBeLessThanOrEqual(
      Math.ceil((150 * GLYPH_FRAME_MS) / 1000 / BRISK_BEAT_S) + 1,
    );
  });

  it("hits high for an ordinary stream, the top flat out, and small for a trickle", () => {
    const height = (rate: number): number => peak(run(new WorkGlyph(), 150, { rate }).slice(30));
    expect(height(250)).toBeGreaterThanOrEqual(5);
    expect(height(1400)).toBe(TOP);
    expect(height(60)).toBeGreaterThanOrEqual(1);
    expect(height(60)).toBeLessThanOrEqual(3);
  });

  it("is one tall stroke for one tool call", () => {
    const glyph = new WorkGlyph();
    glyph.feed(STROKE_WEIGHT.callback);
    const frames = run(glyph, 30, {
      beat: (f) => ({ quietMs: Math.min(1100, f * 90), live: true }),
    });
    expect(glyph.beats).toBe(1);
    expect(peak(frames)).toBeGreaterThanOrEqual(5);
    // And it is over: the stroke came down to the base and left nothing.
    expect(flat(frames.at(-1)!)).toBe(true);
  });

  it("dances on a resting row: most columns are at the base while a few are struck", () => {
    const frames = run(new WorkGlyph(), 150, { rate: 250 }).slice(30);
    const resting = frames.map((frame) => frame.levels.filter((level) => level === 0).length);
    const mean = resting.reduce((sum, n) => sum + n, 0) / resting.length;
    expect(mean).toBeGreaterThanOrEqual(4);
    // And the more it works, the more of the row is up.
    const busy = run(new WorkGlyph(), 150, { rate: 1400 }).slice(30);
    const busyMean =
      busy.reduce((sum, frame) => sum + frame.levels.filter((level) => level === 0).length, 0) /
      busy.length;
    expect(busyMean).toBeLessThan(mean);
  });

  it("comes all the way down when the output stops", () => {
    const glyph = new WorkGlyph();
    run(glyph, 60, { rate: 250 });
    const after = run(glyph, 20, { beat: { quietMs: 1000, live: true }, from: 60 });
    expect(flat(after.at(-1)!)).toBe(true);
  });

  it("sweeps one low hump while a live turn is silent, as Say does while it decodes", () => {
    const glyph = new WorkGlyph();
    const frames = run(glyph, 140, { beat: { quietMs: GATE_SHUT_MS + 1000, live: true } });
    const settled = frames.slice(20);
    // Low: the hump is Say's 0.42 of full height, never a slab.
    expect(peak(settled)).toBeGreaterThanOrEqual(2);
    expect(peak(settled)).toBeLessThanOrEqual(rampLevel(SWEEP_HEIGHT));
    // One hump: the raised cells are a single run.
    for (const frame of settled) {
      const raised = frame.levels.map((level) => (level > 0 ? "1" : "0")).join("");
      expect(/^0*1*0*$/.test(raised)).toBe(true);
    }
    // And it travels: the crest is on the left early in a crossing and on the
    // right late in it.
    const crests = settled.map((frame) => frame.heights.indexOf(Math.max(...frame.heights)));
    expect(Math.min(...crests)).toBeLessThanOrEqual(1);
    expect(Math.max(...crests)).toBeGreaterThanOrEqual(BAND_COUNT - 2);
  });

  it("sweeps faster with sub-agents running", () => {
    const crossings = (agents: number): number => {
      const frames = run(new WorkGlyph(), 300, { beat: { quietMs: 9000, agents, live: true } });
      const crests = frames.map((frame) => frame.heights.indexOf(Math.max(...frame.heights)));
      let wraps = 0;
      for (let i = 1; i < crests.length; i++) if (crests[i]! < crests[i - 1]! - 6) wraps++;
      return wraps;
    };
    expect(crossings(3)).toBeGreaterThan(crossings(0));
  });
});

describe("the calm", () => {
  it("lets a hit land and makes it fall: up four levels a frame at most, down one", () => {
    const glyph = new WorkGlyph();
    // The worst a turn can do: silence to a flat-out stream and back, a turn
    // ending mid-stroke, and a sweep starting from nothing.
    let before = new Array<number>(BAND_COUNT).fill(0);
    for (let f = 0; f < 300; f++) {
      const loud = Math.floor(f / 9) % 2 === 0;
      if (loud) glyph.feed(400);
      const { levels } = glyph.step(
        {
          quietMs: loud ? 0 : (f % 9) * GLYPH_FRAME_MS + (f > 150 ? 5000 : 0),
          agents: f > 220 ? 3 : 0,
          live: f < 240 || f > 255,
        },
        f * GLYPH_FRAME_MS,
      );
      levels.forEach((level, i) => {
        expect(level - before[i]!).toBeLessThanOrEqual(RISE_LEVELS);
        expect(before[i]! - level).toBeLessThanOrEqual(FALL_LEVELS);
      });
      before = levels;
    }
  });

  it("never twitches: no column goes up and straight back down", () => {
    for (const rate of [60, 250, 600, 1400]) {
      const rows = run(new WorkGlyph(), 200, { rate }).map((frame) => frame.levels);
      let twitches = 0;
      for (let f = 2; f < rows.length; f++) {
        for (let i = 0; i < BAND_COUNT; i++) {
          if (rows[f - 1]![i]! > rows[f - 2]![i]! && rows[f]![i]! < rows[f - 1]![i]!) twitches++;
        }
      }
      expect(twitches).toBe(0);
    }
  });

  it("moves one frame a paint, however late the paint was, and once per frame", () => {
    const late = new WorkGlyph();
    let before = late.step(LIVE, 0).levels;
    // A terminal that comes back every 400ms moves slower; it does not jump.
    for (let f = 1; f < 40; f++) {
      late.feed(400);
      const { levels } = late.step(LIVE, f * 400);
      levels.forEach((level, i) => {
        expect(level - before[i]!).toBeLessThanOrEqual(RISE_LEVELS);
        expect(before[i]! - level).toBeLessThanOrEqual(FALL_LEVELS);
      });
      before = levels;
    }
    // Two asks inside one frame are one frame.
    const twice = new WorkGlyph();
    const frameStart = 11 * GLYPH_FRAME_MS;
    expect(twice.step(LIVE, frameStart)).toBe(twice.step(LIVE, frameStart + GLYPH_FRAME_MS - 1));
  });
});
