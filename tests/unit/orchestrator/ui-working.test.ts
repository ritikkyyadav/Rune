/**
 * The working indicator: Rune's own pulse, given motion.
 *
 * Founder, 2026-09-15 evening: the previous lane "copied Claude Code and built
 * the exact same interface. I don't want that. I wanted that pulse design only,
 * and something very soothing — a smooth animation, the kind of effect Claude
 * Code and Codex both have while they are working — implemented correctly, not
 * copied from some other CLI."
 *
 * So this file pins the MOTION, not a glyph and not a sentence, because motion
 * is the part that cannot be reviewed by reading the diff. Five claims, and
 * each of them is the kind that rots first:
 *
 *   1. the CURVE — a raised cosine over 24 frames, monotone within each
 *      half-breath, symmetric about the crest, and never moving the ramp or
 *      the tint by more than one step in a frame (a two-step jump is a strobe);
 *   2. the RATE — 90ms a frame, at most 12fps, and the repaint tick runs on
 *      the same clock so every computed frame is a frame the screen shows;
 *   3. the SHIMMER — a four-cell window that enters from off the left edge,
 *      travels monotonically to off the right, and then RESTS before the next
 *      pass;
 *   4. the STILLNESS — idle, `done` and `waiting` do not move at all, and
 *      neither does anything under NO_COLOR or on a seven-bit terminal beyond
 *      the height the ramp itself carries;
 *   5. the VOICE — every phrase is lower-case, is Rune's own word, and is
 *      reachable from an event the renderer already reads.
 *
 * What changed from the previous lane's version of this file, deliberately and
 * by name:
 *   - `the cadence` (one colour step per 700ms, shape never changes) is gone:
 *     the shape IS the motion again, and 700ms steps are what made the old
 *     version read as a slideshow rather than as a breath. Replaced by
 *     `the curve` and `the frame rate`.
 *   - `the alphabet` asserted the indicator never emits a block cell. Inverted:
 *     the block ramp is the indicator, and what must never appear now is the
 *     borrowed florette.
 *   - `the phrases` asserted capitalised gerunds (`Thinking`, `Reading x`).
 *     Rewritten to Rune's lower-case strip voice, and `Thinking` is asserted
 *     absent.
 *   - `the clock` is unchanged in substance and kept, plus one new claim: the
 *     clock never shimmers.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  BREATH_FRAMES,
  BREATH_MS,
  BREATH_TINTS,
  FRAME_MS,
  HALF_BREATH_FRAMES,
  MAX_FPS,
  REST_INDEX,
  SHIMMER_CELLS,
  SHIMMER_CYCLE_MS,
  SHIMMER_PAUSE_MS,
  SHIMMER_SWEEP_MS,
  breathEase,
  breathFrame,
  breathTint,
  elapsedWord,
  isBreathing,
  paintPhrase,
  rampGlyph,
  rampIndex,
  shimmerEase,
  shimmerSegments,
  shimmerWindowAt,
  tintIndex,
  workingKindForTool,
  workingMark,
  workingPhrase,
  workingRestGlyph,
  workingRow,
  type WorkingKind,
  type WorkingState,
} from "../../../packages/orchestrator/src/bin/ui/working";
import { GLYPH_DEFINITIONS, PULSE_GLYPHS } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { OPENING, VOICE, address } from "../../../packages/orchestrator/src/bin/ui/voice";

/** Whether a rung carries one of a voice set's lines. A bare kind (working,
 *  answering, waiting, compacting) shows Rune's voice in place of the word --
 *  see ui/voice.ts -- so the word itself is no longer what the rung says. */
const voiced = (rung: string, set: readonly string[]): boolean =>
  set.some((line) => rung.includes(address(line, "")));

const RAMP = PULSE_GLYPHS.map((g) => g.utf8);
const ASCII_RAMP = PULSE_GLYPHS.map((g) => g.ascii);
const ALL_KINDS: WorkingKind[] = [
  "working",
  "reading",
  "editing",
  "running",
  "delegating",
  "answering",
  "waiting",
  "compacting",
  "done",
];

describe("the curve", () => {
  it("is a raised cosine: 0 at the trough, 1 at the crest, and level at both", () => {
    expect(breathEase(0)).toBeCloseTo(0, 10);
    expect(breathEase(HALF_BREATH_FRAMES)).toBeCloseTo(1, 10);
    expect(breathEase(BREATH_FRAMES)).toBeCloseTo(0, 10);
    // Level at both ends: the frame either side of the trough and the crest
    // barely moves, which is the pause the eye reads as breathing rather than
    // as a shape bouncing off a wall. A linear ramp fails this.
    expect(breathEase(1) - breathEase(0)).toBeLessThan(0.02);
    expect(breathEase(HALF_BREATH_FRAMES) - breathEase(HALF_BREATH_FRAMES - 1)).toBeLessThan(0.02);
    // ...and genuinely fast in the middle, or it is not eased, it is stalled.
    const mid = HALF_BREATH_FRAMES / 2;
    expect(breathEase(mid + 1) - breathEase(mid)).toBeGreaterThan(0.05);
  });

  it("rises monotonically through a half-breath and falls back monotonically", () => {
    for (let f = 1; f <= HALF_BREATH_FRAMES; f++) {
      expect(rampIndex(f), `up ${f}`).toBeGreaterThanOrEqual(rampIndex(f - 1));
      expect(tintIndex(f), `tint up ${f}`).toBeGreaterThanOrEqual(tintIndex(f - 1));
    }
    for (let f = HALF_BREATH_FRAMES + 1; f <= BREATH_FRAMES; f++) {
      expect(rampIndex(f), `down ${f}`).toBeLessThanOrEqual(rampIndex(f - 1));
      expect(tintIndex(f), `tint down ${f}`).toBeLessThanOrEqual(tintIndex(f - 1));
    }
    // The whole ramp is used: trough to crest, nothing clipped off either end.
    expect(rampIndex(0)).toBe(0);
    expect(rampIndex(HALF_BREATH_FRAMES)).toBe(PULSE_GLYPHS.length - 1);
    expect(tintIndex(0)).toBe(0);
    expect(tintIndex(HALF_BREATH_FRAMES)).toBe(BREATH_TINTS.length - 1);
    expect(breathTint(0)).toBe("dim");
    expect(breathTint(HALF_BREATH_FRAMES)).toBe("accent");
  });

  it("is symmetric: the way down is the way up, reversed", () => {
    for (let f = 0; f <= HALF_BREATH_FRAMES; f++) {
      expect(rampIndex(BREATH_FRAMES - f), `mirror ${f}`).toBe(rampIndex(f));
      expect(tintIndex(BREATH_FRAMES - f), `tint mirror ${f}`).toBe(tintIndex(f));
    }
  });

  it("never steps more than one level, in height OR in colour", () => {
    // This is the strobe test, and it is the reason the curve is a raised
    // cosine rather than anything steeper: the fastest the curve moves is
    // pi/24 of its range per frame, so seven intervals of ramp move by at most
    // 0.92 and three of tint by at most 0.40, and a rounded value therefore
    // cannot jump. Asserted over two whole breaths, across the wrap.
    for (let f = 1; f <= BREATH_FRAMES * 2; f++) {
      const a = f - 1;
      const b = f;
      expect(Math.abs(rampIndex(b) - rampIndex(a)), `ramp ${a}->${b}`).toBeLessThanOrEqual(1);
      expect(Math.abs(tintIndex(b) - tintIndex(a)), `tint ${a}->${b}`).toBeLessThanOrEqual(1);
    }
    // And across the wrap as the renderer actually walks it: frame 23 -> 0.
    expect(Math.abs(rampIndex(breathFrame(0)) - rampIndex(BREATH_FRAMES - 1))).toBeLessThanOrEqual(
      1,
    );
  });

  it("walks the frames off the turn's own clock, and wraps", () => {
    expect(breathFrame(0)).toBe(0);
    expect(breathFrame(FRAME_MS - 1)).toBe(0);
    expect(breathFrame(FRAME_MS)).toBe(1);
    expect(breathFrame(FRAME_MS * HALF_BREATH_FRAMES)).toBe(HALF_BREATH_FRAMES);
    expect(breathFrame(BREATH_MS)).toBe(0);
    expect(breathFrame(BREATH_MS * 3 + FRAME_MS * 5)).toBe(5);
    expect(breathFrame(-500)).toBe(0);
  });
});

describe("the frame rate", () => {
  it("is 90ms a frame -- 11.1fps, under the 12fps ceiling", () => {
    expect(FRAME_MS).toBe(90);
    expect(1000 / FRAME_MS).toBeLessThanOrEqual(MAX_FPS);
    // Twenty-four frames a half-breath: a 4.32s breath, fourteen a minute --
    // a calm person at rest, which is the entire design brief for this curve.
    // Twelve was twenty-eight a minute, and the founder read it as "too fast,
    // not soothing, totally jittery" (2026-09-15).
    expect(HALF_BREATH_FRAMES).toBe(24);
    expect(BREATH_FRAMES).toBe(48);
    expect(BREATH_MS).toBe(4320);
    // Twelve to sixteen breaths a minute: 3.75s to 5s.
    expect(BREATH_MS).toBeGreaterThanOrEqual(3750);
    expect(BREATH_MS).toBeLessThanOrEqual(5000);
  });

  it("is the same clock the repaint tick runs on", () => {
    // A repaint slower than the frame clock samples the curve unevenly and
    // puts back exactly the stepping the easing exists to remove -- which is
    // what a hard-coded 125ms tick beside a 90ms curve would do. Asserted on
    // the source because there is no way to observe an interval's period from
    // inside the interval.
    const tui = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/bin/ui/tui.ts"),
      "utf8",
    );
    expect(tui).toContain("}, FRAME_MS);");
    expect(tui).not.toMatch(/\}, 125\);/);
  });
});

describe("the mark", () => {
  it("is Rune's own ramp and not a borrowed mark", () => {
    // The florette is gone from the alphabet entirely, so it cannot come back
    // by a call site typing its name.
    expect(Object.keys(GLYPH_DEFINITIONS)).not.toContain("working");
    expect(
      Object.values(GLYPH_DEFINITIONS).some((d) => d.utf8 === "✻"),
      "the borrowed florette is still in the alphabet",
    ).toBe(false);

    const seen = new Set<string>();
    for (let f = 0; f < BREATH_FRAMES; f++) {
      const cell = workingMark({ kind: "running" }, f, "utf8");
      expect(visLen(cell)).toBe(1);
      seen.add(stripAnsi(cell));
    }
    // Every cell it emits is a level of the ramp, and it uses ALL of them --
    // a breath that only touches three levels is a flicker with extra steps.
    for (const cell of seen) expect(RAMP).toContain(cell);
    expect(seen.size).toBe(PULSE_GLYPHS.length);
  });

  it("rests at the mid bar, dim, for anything that is not moving", () => {
    expect(rampGlyph(REST_INDEX, "utf8")).toBe(RAMP[REST_INDEX]!);
    expect(workingRestGlyph("utf8")).toBe("▄");
    // Not the trough: a finished run whose mark had shrunk to an underscore
    // reads as an error rather than as a rest.
    expect(REST_INDEX).toBeGreaterThan(0);
    expect(REST_INDEX).toBeLessThan(PULSE_GLYPHS.length - 1);
  });
});

describe("the stillness", () => {
  it("does not move for done or waiting", () => {
    // `done` is finished and `waiting` is waiting on a person. A mark still
    // breathing through either would report activity that is not happening --
    // the exact failure the byte-fed pulse was built to stop.
    for (const kind of ["done", "waiting"] as WorkingKind[]) {
      expect(isBreathing(kind), kind).toBe(false);
      const held = new Set(
        Array.from({ length: BREATH_FRAMES * 2 }, (_, f) => workingMark({ kind }, f, "utf8")),
      );
      expect(held.size, kind).toBe(1);
      expect(stripAnsi([...held][0]!)).toBe(RAMP[REST_INDEX]!);
      // ...and the phrase holds still too: no window sweeps a sentence that
      // is not about work in progress.
      const phrases = new Set(
        Array.from({ length: 40 }, (_, i) =>
          paintPhrase("waiting for you", i * FRAME_MS, { kind, color: true }),
        ),
      );
      expect(phrases.size, `${kind} phrase`).toBe(1);
    }
  });

  it("moves for every state that is genuinely working", () => {
    for (const kind of ALL_KINDS.filter((k) => k !== "done" && k !== "waiting")) {
      expect(isBreathing(kind), kind).toBe(true);
      const cells = new Set(
        Array.from({ length: BREATH_FRAMES }, (_, f) =>
          stripAnsi(workingMark({ kind }, f, "utf8")),
        ),
      );
      expect(cells.size, kind).toBe(PULSE_GLYPHS.length);
    }
  });

  it("does not move when there is no run: no clock, no frames", () => {
    // Idle is the caller's case -- no turn, no tick -- but the row must be
    // safe to draw anyway, and a stateless row draws frame zero forever.
    const idle = stripAnsi(workingRow({ kind: "working" }));
    expect(idle).toBe(`${RAMP[0]!} working`);
    expect(stripAnsi(workingRow({ kind: "working" }))).toBe(idle);
  });
});

describe("the shimmer", () => {
  const PHRASE = "reading turn.ts"; // 15 cells
  const frames = (ms: number) => Math.floor(ms / FRAME_MS);

  it("sweeps for two thirds of a breath, rests for the last third, and cycles once a breath", () => {
    // One clock for the row: the glow crosses the words while the bar rises
    // and rests while it falls. Unrelated clocks (1.6s + 0.4s against a 2.16s
    // breath) put the highlight at a different moment of every breath, which
    // is what "preprogrammed" looks like when you cannot say why.
    expect(SHIMMER_SWEEP_MS).toBe(2880);
    expect(SHIMMER_PAUSE_MS).toBe(1440);
    expect(SHIMMER_CYCLE_MS).toBe(BREATH_MS);
    expect(SHIMMER_CELLS).toBe(6);
    expect(SHIMMER_CELLS).toBeGreaterThanOrEqual(3);
    expect(SHIMMER_CELLS).toBeLessThanOrEqual(6);
    // Same family as the breath -- half a raised cosine -- so the two motions
    // on one row are one idea of smooth at two rates.
    expect(shimmerEase(0)).toBeCloseTo(0, 10);
    expect(shimmerEase(0.5)).toBeCloseTo(0.5, 10);
    expect(shimmerEase(1)).toBeCloseTo(1, 10);
    expect(shimmerEase(0.05)).toBeLessThan(0.05); // slow off the mark
    expect(shimmerEase(0.95)).toBeGreaterThan(0.95); // slow into the stop
  });

  it("enters from off the left edge and leaves off the right, monotonically", () => {
    const heads: number[] = [];
    for (let f = 0; f * FRAME_MS < SHIMMER_SWEEP_MS; f++) {
      const win = shimmerWindowAt(f * FRAME_MS, PHRASE.length);
      expect(win, `frame ${f}`).not.toBeNull();
      heads.push(win!.head);
      // The clipped span is always inside the phrase and never wider than the
      // window -- a bright patch that ran off the end would be painting cells
      // the phrase does not have.
      expect(win!.start).toBeGreaterThanOrEqual(0);
      expect(win!.end).toBeLessThanOrEqual(PHRASE.length);
      expect(win!.end - win!.start).toBeLessThanOrEqual(SHIMMER_CELLS);
    }
    expect(heads[0]).toBe(-SHIMMER_CELLS); // fully off the left: it enters
    expect(heads[heads.length - 1]).toBeGreaterThanOrEqual(PHRASE.length - 1); // and leaves
    for (let i = 1; i < heads.length; i++) {
      expect(heads[i]!, `head ${i}`).toBeGreaterThanOrEqual(heads[i - 1]!);
    }
    // Left to right, never back: a window that reversed would read as a
    // scanner rather than as light moving over the words.
    expect(heads[heads.length - 1]!).toBeGreaterThan(heads[0]!);
  });

  it("rests, fully quiet, between passes", () => {
    // Without the rest the window reappears on the left the instant it leaves
    // on the right, and a loop with no rest in it is a barber's pole.
    expect(shimmerWindowAt(SHIMMER_SWEEP_MS, PHRASE.length)).toBeNull();
    expect(shimmerWindowAt(SHIMMER_SWEEP_MS + 200, PHRASE.length)).toBeNull();
    expect(shimmerWindowAt(SHIMMER_CYCLE_MS - 1, PHRASE.length)).toBeNull();
    // ...and the next cycle starts the pass again from off the left.
    expect(shimmerWindowAt(SHIMMER_CYCLE_MS, PHRASE.length)!.head).toBe(-SHIMMER_CELLS);
    // The whole phrase is quiet during the rest: one segment, unlit.
    const resting = shimmerSegments(PHRASE, SHIMMER_SWEEP_MS + 100);
    expect(resting).toEqual([{ text: PHRASE, bright: false }]);
  });

  it("lights a contiguous run of the phrase and nothing else", () => {
    // Mid-sweep: exactly one bright segment, and the pieces still spell the
    // phrase. Asserted on segments rather than on painted bytes because the
    // suite runs with NO_COLOR, where every frame would be byte-identical.
    const mid = shimmerSegments(PHRASE, SHIMMER_SWEEP_MS / 2);
    expect(mid.map((p) => p.text).join("")).toBe(PHRASE);
    expect(mid.filter((p) => p.bright)).toHaveLength(1);
    expect(mid.find((p) => p.bright)!.text.length).toBe(SHIMMER_CELLS);
    // Over a whole sweep every cell of the phrase is lit at some point, and
    // the phrase is never destroyed by the split.
    const lit = new Set<number>();
    for (let f = 0; f * FRAME_MS < SHIMMER_SWEEP_MS; f++) {
      const win = shimmerWindowAt(f * FRAME_MS, PHRASE.length)!;
      for (let i = win.start; i < win.end; i++) lit.add(i);
      expect(
        shimmerSegments(PHRASE, f * FRAME_MS)
          .map((p) => p.text)
          .join(""),
      ).toBe(PHRASE);
    }
    expect(lit.size).toBe(PHRASE.length);
  });

  it("leaves the clock alone", () => {
    // A number that moves under the eye is a number you re-read. The clock is
    // outside the phrase the window sweeps, and it is faint, not lit.
    const row = workingRow({ kind: "reading", target: "turn.ts", elapsedMs: 40_000 });
    expect(stripAnsi(row)).toBe(`${RAMP[rampIndex(breathFrame(40_000))]!} reading turn.ts · 40s`);
    const segments = shimmerSegments("reading turn.ts", 40_000);
    expect(segments.map((p) => p.text).join("")).toBe("reading turn.ts");
    expect(segments.some((p) => p.text.includes("40s"))).toBe(false);
  });
});

describe("the fallbacks", () => {
  it("keeps the motion on a seven-bit terminal, and drops the shimmer", () => {
    // The ASCII twins are a ramp too -- `_ . , - = + * #` climbs -- so a
    // terminal with no blocks still sees the bar rise and fall. Colour it has
    // none of, so the window would be a repaint with nothing to show.
    const cells = Array.from({ length: BREATH_FRAMES }, (_, f) =>
      stripAnsi(workingMark({ kind: "running" }, f, "ascii")),
    );
    for (const cell of cells) expect(ASCII_RAMP).toContain(cell);
    expect(new Set(cells).size).toBe(PULSE_GLYPHS.length);
    const steady = new Set(
      Array.from({ length: 40 }, (_, i) =>
        paintPhrase("running checks", i * FRAME_MS, { mode: "ascii", color: true }),
      ),
    );
    expect(steady.size).toBe(1);
    const row = stripAnsi(
      workingRow({ kind: "running", target: "checks", elapsedMs: 65_000 }, { mode: "ascii" }),
    );
    expect(row).toContain("running checks");
    expect(row).toContain("1m 05s");
    expect(row).not.toMatch(/[^\x00-\x7f]/);
  });

  it("uses the twin on an ambiguous-width terminal, where a block eats a cell", () => {
    // Same rule `contextBar` follows: the UTF-8 blocks only where the terminal
    // has told us its cells are one column wide.
    for (let f = 0; f < BREATH_FRAMES; f++) {
      expect(ASCII_RAMP).toContain(stripAnsi(workingMark({ kind: "running" }, f, "ambig")));
    }
  });

  it("keeps height only under NO_COLOR: the bar moves, the phrase does not", () => {
    // `color: false` is what a NO_COLOR run looks like from inside this
    // module. The height still carries the breath -- which is the whole reason
    // the indicator went back to a ramp -- and the phrase is one steady string,
    // so the repaint tick is not woken to redraw identical bytes.
    const heights = new Set(
      Array.from({ length: BREATH_FRAMES }, (_, f) =>
        stripAnsi(workingMark({ kind: "running" }, f, "utf8")),
      ),
    );
    expect(heights.size).toBe(PULSE_GLYPHS.length);
    const steady = new Set(
      Array.from({ length: 40 }, (_, i) =>
        paintPhrase("running checks", i * FRAME_MS, { color: false }),
      ),
    );
    expect(steady.size).toBe(1);
    expect(stripAnsi([...steady][0]!)).toBe("running checks");
  });
});

describe("the voice", () => {
  it("speaks Rune's lower-case strip voice, and never the borrowed one", () => {
    const rows = ALL_KINDS.map((kind) =>
      stripAnsi(workingRow({ kind, target: "turn.ts", elapsedMs: 12_000 })),
    );
    for (const row of rows) {
      expect(row).not.toContain("Thinking");
      expect(row).not.toContain("✻");
      // Everything after the mark and its space is lower-case: a capital in a
      // chrome row is a title, and this row is a sentence.
      const words = row.slice(2);
      expect(words, row).toBe(words.toLowerCase());
    }
  });

  it("reads the way the founder wrote it", () => {
    const row = (state: WorkingState) => stripAnsi(workingRow(state));
    const bar = (ms: number) => RAMP[rampIndex(breathFrame(ms))]!;
    expect(row({ kind: "working", elapsedMs: 12_000 })).toBe(`${bar(12_000)} working · 12s`);
    expect(row({ kind: "reading", target: "turn.ts", elapsedMs: 40_000 })).toBe(
      `${bar(40_000)} reading turn.ts · 40s`,
    );
    expect(row({ kind: "editing", target: "composer.ts", elapsedMs: 40_000 })).toBe(
      `${bar(40_000)} editing composer.ts · 40s`,
    );
    expect(row({ kind: "running", target: "checks", elapsedMs: 65_000 })).toBe(
      `${bar(65_000)} running checks · 1m 05s`,
    );
    // The one state that is about the reader, not the machine -- and the one
    // with no clock, because how long it has been true of YOU is not news.
    expect(row({ kind: "waiting", elapsedMs: 9_000 })).toBe(`${RAMP[REST_INDEX]!} waiting for you`);
    expect(row({ kind: "done", elapsedMs: 118_000 })).toBe(`${RAMP[REST_INDEX]!} done · 1m 58s`);
  });

  it("every phrase is reachable from a real event, and nothing else is", () => {
    // The closed set, and the event that produces each one. A phrase with no
    // event is a phrase that will eventually be produced by everything.
    const table: Array<[WorkingKind, string, string]> = [
      ["working", "working", "no tool, no fleet, no prose -- the resting state"],
      ["reading", "reading turn.ts", "tool_call_start: read_file / grep / glob / web_fetch"],
      ["editing", "editing turn.ts", "tool_call_start: edit_file / write_file / apply_patch"],
      ["running", "running turn.ts", "tool_call_start: bash, or the verification notice"],
      ["delegating", "delegating turn.ts", "tool_call_start: task / worker, or a live fleet"],
      ["answering", "answering", "text_delta -- prose is streaming"],
      ["waiting", "waiting for you", "tool_call_start: ask_user"],
      ["compacting", "compacting", "the harness notice that it is rewriting context"],
      ["done", "done", "turn_complete"],
    ];
    for (const [kind, phrase] of table) {
      expect(workingPhrase({ kind, target: "turn.ts" }), kind).toBe(phrase);
      expect(phrase).toBe(phrase.toLowerCase());
    }
    const covered = new Set(table.map(([kind]) => kind));
    expect([...covered].sort()).toEqual([...ALL_KINDS].sort());
    expect(covered.size).toBe(9);
  });

  it("takes the caller's own phrase, down-cased at the first letter only", () => {
    // `liveToolLabel` has been writing these for a year, including the one
    // that matters most: the placeholder that stops a half-arrived command
    // being typed out letter by letter. The strip speaks lower-case, so the
    // first letter folds -- and ONLY the first, or a path and a command would
    // be destroyed by the row that reports them.
    expect(workingPhrase({ kind: "running", phrase: "Running the necessary command" })).toBe(
      "running the necessary command",
    );
    expect(workingPhrase({ kind: "running", phrase: "Checking with npx vitest run" })).toBe(
      "checking with npx vitest run",
    );
    expect(
      workingPhrase({ kind: "editing", target: "a.ts", phrase: "Updating src/UI/App.ts" }),
    ).toBe("updating src/UI/App.ts");
    // An empty one falls through to the closed table rather than blanking the row.
    expect(workingPhrase({ kind: "working", phrase: "   " })).toBe("working");
  });

  it("maps tool names onto kinds the way the transcript's own verbs do", () => {
    expect(workingKindForTool("read_file")).toBe("reading");
    expect(workingKindForTool("read_many")).toBe("reading");
    expect(workingKindForTool("grep")).toBe("reading");
    expect(workingKindForTool("multi_edit")).toBe("editing");
    expect(workingKindForTool("apply_patch")).toBe("editing");
    expect(workingKindForTool("bash")).toBe("running");
    expect(workingKindForTool("task")).toBe("delegating");
    expect(workingKindForTool("worker")).toBe("delegating");
    expect(workingKindForTool("ask_user")).toBe("waiting");
    // A tool this does not know is `running`, which is literally true of any
    // call and claims nothing more.
    expect(workingKindForTool("some_mcp_tool")).toBe("running");
  });

  it("never invents a subject for a state that has none", () => {
    // `working on turn.ts` would be a claim about what the model is working
    // on, which nothing on the wire can support at that moment.
    for (const kind of ["working", "answering", "waiting", "done"] as WorkingKind[]) {
      expect(workingPhrase({ kind, target: "turn.ts" })).not.toContain("turn.ts");
    }
  });
});

describe("the clock", () => {
  it("is seconds, then zero-padded minutes, so the tail does not change width", () => {
    expect(elapsedWord(0)).toBe("0s");
    expect(elapsedWord(999)).toBe("0s");
    expect(elapsedWord(12_000)).toBe("12s");
    expect(elapsedWord(59_999)).toBe("59s");
    expect(elapsedWord(60_000)).toBe("1m 00s");
    expect(elapsedWord(65_000)).toBe("1m 05s");
    expect(elapsedWord(118_000)).toBe("1m 58s");
    expect(elapsedWord(3_600_000)).toBe("1h 00m");
    expect(elapsedWord(3_840_000)).toBe("1h 04m");
    expect(elapsedWord(-5)).toBe("0s");
  });

  it("is dropped where there is nothing worth timing", () => {
    expect(stripAnsi(workingRow({ kind: "working" }))).toBe(`${RAMP[0]!} working`);
    expect(stripAnsi(workingRow({ kind: "waiting", elapsedMs: 600_000 }))).not.toContain("m ");
  });
});

// ─── the wiring: every phrase, from the event that produces it ───
//
// The table above proves the phrase set is closed. This proves it is REACHED
// -- that each phrase comes out of the renderer when the corresponding event
// goes in, and not from a heuristic, a timer, or the model's prose. A closed
// set nothing can produce is as useless as an open one.

import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";

/** The live rung, as the frame tick would paint it. */
function rungHarness() {
  const sink: TurnSink = { commit: () => {}, preview: () => {} };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return { turn, rung: () => stripAnsi(turn.liveLines().join("\n")) };
}

const DWELL = 700;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const call = (callId: string, toolName: string, args?: Record<string, unknown>) => [
  { type: "tool_call_start", callId, toolName },
  ...(args ? [{ type: "tool_call_args_delta", callId, partialJson: JSON.stringify(args) }] : []),
];

describe("the rung says what the events say", () => {
  it("opens on working, with nothing in flight", () => {
    const h = rungHarness();
    expect(h.turn.workingState().kind).toBe("working");
    expect(voiced(h.rung(), OPENING)).toBe(true);
    // And it opens on Rune's mark, not the borrowed one.
    expect(h.rung()).not.toContain("✻");
    expect(RAMP.some((cell) => h.rung().includes(cell))).toBe(true);
  });

  it("reads, edits, runs and checks -- each from its own tool_call_start", async () => {
    const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
      ["read_file", { path: "src/bin/ui/turn.ts" }, "reading src/bin/ui/turn.ts"],
      ["edit_file", { path: "src/bin/ui/turn.ts" }, "updating src/bin/ui/turn.ts"],
      ["bash", { command: "bun test" }, "checking with bun test"],
      ["bash", { command: "git status" }, "running git status"],
      ["task", undefined, "scouting"],
    ];
    for (const [toolName, args, phrase] of cases) {
      const h = rungHarness();
      for (const event of call("c1", toolName, args)) h.turn.onEvent(event as never);
      await sleep(DWELL + 60);
      expect(h.rung(), `${toolName}`).toContain(phrase);
      // Never a capital, and never the borrowed mark.
      expect(h.rung(), `${toolName}`).not.toContain(phrase[0]!.toUpperCase() + phrase.slice(1));
      expect(h.rung()).not.toContain("✻");
    }
  });

  it("says waiting for you when the agent asked a question", async () => {
    const h = rungHarness();
    for (const event of call("q1", "ask_user", { question: "which provider?" })) {
      h.turn.onEvent(event as never);
    }
    await sleep(DWELL + 60);
    // `asking` was a fragment hanging off `working`. This is the sentence --
    // in Rune's voice, because the state is about the reader.
    expect(h.turn.workingState().kind).toBe("waiting");
    expect(voiced(h.rung(), VOICE.waiting)).toBe(true);
    expect(h.rung()).not.toContain("asking");
    // ...and the mark holds still at the mid bar while a person is the one
    // holding things up.
    expect(h.rung()).toContain(RAMP[REST_INDEX]!);
  });

  it("says compacting only while the harness says it is compacting", async () => {
    const h = rungHarness();
    h.turn.onEvent({
      type: "notice",
      message: "provider rejected the prompt as over-limit — force-compacting (attempt 1)",
    } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).toBe("compacting");
    expect(voiced(h.rung(), VOICE.compacting)).toBe(true);
    // The compaction LANDING ends the state. Nothing else does -- no timer,
    // no guess about how long a compaction ought to take.
    h.turn.onEvent({
      type: "compaction",
      beforeTokens: 120_000,
      afterTokens: 40_000,
      limitTokens: 200_000,
    } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).not.toBe("compacting");
    expect(voiced(h.rung(), VOICE.compacting)).toBe(false);
  });

  it("says answering only once prose has actually streamed", async () => {
    const h = rungHarness();
    expect(h.turn.workingState().kind).not.toBe("answering");
    h.turn.onEvent({ type: "text_delta", text: "The loop breaks on the wrong event." } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).toBe("answering");
    expect(voiced(h.rung(), VOICE.answering)).toBe(true);
  });

  it("leads with the fan-out rather than with whichever member streamed last", async () => {
    const h = rungHarness();
    for (const id of ["s1", "s2", "s3"]) {
      h.turn.onEvent({ type: "tool_call_start", callId: id, toolName: "task" } as never);
      h.turn.onEvent({
        type: "tool_call_args_delta",
        callId: id,
        partialJson: JSON.stringify({ description: `scout ${id}` }),
      } as never);
    }
    await sleep(DWELL + 60);
    expect(h.rung().split("\n")[0]).toContain("delegating 3 sub-agents");
  });

  it("carries the elapsed clock inline, and the stall in words beside it", async () => {
    const h = rungHarness();
    for (const event of call("c1", "read_file", { path: "a.ts" })) h.turn.onEvent(event as never);
    await sleep(DWELL + 60);
    // Under the elapsed floor the row is the phrase alone; the clock arrives
    // when there is something to report, and it is a fact, not an estimate.
    expect(h.rung()).toContain("reading a.ts");
    expect(h.rung()).not.toMatch(/\d+m \d\ds/);
  });

  it("breathes while it works: the mark moves between frames of the same state", async () => {
    const h = rungHarness();
    for (const event of call("c1", "read_file", { path: "a.ts" })) h.turn.onEvent(event as never);
    await sleep(DWELL + 60);
    // Same state, different moments: the phrase holds and the bar does not.
    // Sampled over most of a breath, because two frames 90ms apart near the
    // crest legitimately share a level.
    const cells = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const row = h.rung().split("\n")[0]!;
      cells.add([...row].find((c) => RAMP.includes(c)) ?? "");
      expect(row).toContain("reading a.ts");
      await sleep(FRAME_MS);
    }
    expect(cells.size).toBeGreaterThan(1);
  });
});
