/**
 * The pane title.
 *
 * This is the only moving thing Warp will render for Rune — it badges agent
 * panes, and it decides what an agent pane is from a list `rune` is not on. So
 * the assertions here are about the ways a title can quietly stop being worth
 * anything: it stops moving when work is happening, it goes on moving when
 * work has stopped, or it moves at a pace that has nothing to do with the work.
 */

import { describe, expect, test } from "bun:test";
import {
  BRISK_SWEEP_MS,
  CALM_SWEEP_MS,
  Glide,
  TITLE_QUIET_AFTER_MS,
  detectTitleStrip,
  pillChars,
  pillStop,
  sweepRate,
  titleText,
  titleSeq,
  trackStops,
  workLoad,
  type TitleBeat,
  type TitleState,
  type TitleStrip,
} from "../../../packages/orchestrator/src/bin/ui/title";
import { QUIET_AFTER_MS } from "../../../packages/orchestrator/src/bin/ui/pulse";
import {
  GLYPH_DEFINITIONS,
  PULSE_GLYPHS,
  type GlyphMode,
} from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { BREATH_MS, FRAME_MS } from "../../../packages/orchestrator/src/bin/ui/working";
import { TurnRenderer } from "../../../packages/orchestrator/src/bin/ui/turn";
import { fleetLedger } from "../../../packages/orchestrator/src/bin/ui/agents-panel";

const working = (phase: number, quietMs = 0): TitleState => ({ kind: "working", phase, quietMs });
/** The title as a tab shows it. The glyph mode and the kind of strip are
 *  pinned, not read off this machine, so the suite says the same thing under
 *  CI as it does in the founder's Terminal. */
const title = (state: TitleState, mode: GlyphMode = "utf8", strip: TitleStrip = "cells"): string =>
  titleText(state, "Atlas", mode, strip);
/** The same, on a strip drawn in a proportional font. */
const smooth = (state: TitleState): string => title(state, "utf8", "smooth");

/** The block in a macOS title bar: a pill, drawn on the brackets' centre line. */
const PILL = "\u2b2c";
/** The block on any other tab strip: the square every font has. */
const SQUARE = "\u25a0";
/** The block for each kind of strip. */
const BLOCK = { smooth: PILL, cells: SQUARE } as const;
/** The block parked: flattened to a line, on the same centre line. */
const PARKED = "-";
/** A quarter of a space, in a title bar's font. */
const HAIR = "\u200a";
const CELLS = trackStops("cells");
const PLACES = trackStops("smooth");

const beat = (level: number, agents = 0, quietMs = 0): TitleBeat => ({ quietMs, level, agents });

/** The pill alone: the brackets, the car and the road. */
const pillOf = (text: string): string => text.slice(0, text.indexOf("]") + 1);

/** Where the car is on a smooth road, in hairs from the left bracket. */
function place(text: string): number {
  const behind = /^\[([ \u200a]*)/.exec(text)![1]!;
  return [...behind].reduce((sum, ch) => sum + (ch === " " ? 4 : 1), 0);
}

/** How long a pill's road is, in hairs. */
const roadHairs = (text: string): number =>
  [...pillOf(text)].reduce((sum, ch) => sum + (ch === " " ? 4 : ch === "\u200a" ? 1 : 0), 0);

/** The car's cell, whatever the road. */
const carOf = (text: string): string => pillOf(text).replace(/[[\] \u200a]/g, "");

/** Paint `ms` of a steady beat on the frame clock; returns the cell at each paint. */
function paint(glide: Glide, from: number, ms: number, b: TitleBeat): number[] {
  const cells: number[] = [];
  for (let now = from + FRAME_MS; now <= from + ms; now += FRAME_MS) {
    glide.advance(b, now);
    cells.push(pillStop(glide.phase));
  }
  return cells;
}

/** Collapse a per-paint cell list into [cell, paints held] runs. */
function runs(cells: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last[0] === cell) last[1]++;
    else out.push([cell, 1]);
  }
  return out;
}

describe("what the tab says", () => {
  test("the pill leads, because a vertical tab truncates from the right", () => {
    // The part that has to survive the ellipsis is the part that moves.
    for (const strip of ["cells", "smooth"] as const) {
      for (let p = 0; p < 1; p += 0.05) {
        const text = title(working(p), "utf8", strip);
        expect(text[0]).toBe("[");
        expect(text[pillChars(strip) - 1]).toBe("]");
        expect(text.slice(pillChars(strip))).toBe(" Rune - Atlas");
      }
    }
  });

  test("the block is thick, and centred between the brackets", () => {
    // The founder's corrections, in order. `=` was "not a proper solid block".
    // One full block was "too thick". Two cells was "the width is too much".
    // One cell in a seven-space pill was "too big". The small one, drawn from
    // the pulse ramp, was "not aligned to the centre properly" -- which no
    // level of a ramp can be: a ramp fills its cell from the bottom up. And
    // the centred rectangle that replaced it was a 3.7px bar: "instead of a
    // block now you used the = this".
    //
    // Thick and centred is one shape. AppKit's numbers, 13px title font: the
    // brackets' centre is 3.67 above the baseline; the ramp's half level 1.59;
    // the thin bar 3.38 but 3.7 tall; this pill 3.35, and 9.9 by 6.6.
    for (const strip of ["cells", "smooth"] as const) {
      for (let p = 0; p < 1; p += 0.01) {
        expect(carOf(title(working(p), "utf8", strip))).toBe(BLOCK[strip]);
      }
    }
    expect(GLYPH_DEFINITIONS.titlePill.utf8).toBe(PILL);
    expect(GLYPH_DEFINITIONS.titleBlock.utf8).toBe(SQUARE);
    // Not one shape of the bottom-anchored family, moving or parked ...
    const ramp = new Set<string>(PULSE_GLYPHS.map((g) => g.utf8));
    for (const strip of ["cells", "smooth"] as const) {
      expect(ramp.has(BLOCK[strip])).toBe(false);
      expect(ramp.has(carOf(title(working(0.5, 31_000), "utf8", strip)))).toBe(false);
    }
    // ... and never the thin bar or the equals sign, in any mode.
    for (const strip of ["cells", "smooth"] as const) {
      for (const mode of ["utf8", "ambig", "ascii"] as const) {
        for (let p = 0; p < 1; p += 0.05) {
          expect(title(working(p), mode, strip)).not.toMatch(/[=▬]/);
        }
      }
    }
  });

  test("the whole mark is small: `[  ]` with a block in it", () => {
    // On cells that is literal: two spaces of road, five characters in all.
    expect(pillOf(title(working(0)))).toBe(`[${SQUARE}  ]`);
    expect(pillChars("cells")).toBe(5);
    // On a smooth strip the road is the same order of length -- under three
    // spaces' worth -- and never the six spaces it was.
    expect(roadHairs(smooth(working(0)))).toBe(PLACES - 1);
    expect(roadHairs(smooth(working(0)))).toBeLessThan(3 * 4);
  });

  test("on cells, the car makes every stop along the road, left to right", () => {
    const seen: string[] = [];
    for (let p = 0; p < 1; p += 0.001) {
      const now = pillOf(title(working(p)));
      if (seen[seen.length - 1] !== now) seen.push(now);
    }
    expect(seen).toEqual([`[${SQUARE}  ]`, `[ ${SQUARE} ]`, `[  ${SQUARE}]`]);
  });

  test("every moving frame is the same characters, so the tab never changes width", () => {
    // A tab strip is drawn in a proportional font. Frames that differ only in
    // the ORDER of their characters are the same width in any font; one more
    // space behind the car and one fewer ahead would shove the name sideways.
    // That includes the block: it keeps one shape all the way across.
    const letters = (text: string): string => [...text].sort().join("");
    for (const strip of ["cells", "smooth"] as const) {
      for (const mode of ["utf8", "ambig", "ascii"] as const) {
        const first = letters(title(working(0), mode, strip));
        for (let p = 0; p < 1; p += 0.004) {
          expect(letters(title(working(p), mode, strip))).toBe(first);
        }
      }
    }
  });

  test("it gathers speed: each stop is held for less of the crossing than the last", () => {
    for (const strip of ["cells", "smooth"] as const) {
      const stops = trackStops(strip);
      const held = new Array<number>(stops).fill(0);
      const steps = 100_000;
      for (let i = 0; i < steps; i++) held[pillStop(i / steps, strip)]!++;
      for (let c = 1; c < stops; c++) expect(held[c]!).toBeLessThan(held[c - 1]!);
      // and it is an acceleration, not a car parked at the left edge
      expect(held[0]! / steps).toBeLessThanOrEqual(0.51);
    }
  });

  test("it comes back in from the left rather than running off the end", () => {
    for (const strip of ["cells", "smooth"] as const) {
      expect(pillStop(1, strip)).toBe(0);
      expect(pillStop(1.25, strip)).toBe(pillStop(0.25, strip));
      expect(pillStop(-0.75, strip)).toBe(pillStop(0.25, strip));
      expect(pillStop(Number.NaN, strip)).toBe(0);
      expect(pillStop(0.999999, strip)).toBe(trackStops(strip) - 1);
    }
  });

  test("a stalled turn parks the car and says so in words", () => {
    // The whole argument of pulse.ts, carried onto the tab: a mark that keeps
    // moving through a wedged tool call is worse than a tab that says nothing.
    const stalled = title(working(0.6, 31_000));
    expect(stalled).toBe("[-  ] Rune - quiet 31s");
    // it is the same wherever the car had got to
    expect(title(working(0.95, 31_000))).toBe(stalled);
    expect(smooth(working(0.6, 31_000))).toBe(smooth(working(0.1, 31_000)));
    expect(carOf(smooth(working(0.6, 31_000)))).toBe(PARKED);
    expect(place(smooth(working(0.6, 31_000)))).toBe(0);
    expect(smooth(working(0.6, 31_000))).toEndWith(" Rune - quiet 31s");
    // and it is a shape no moving frame has, so a glance cannot mistake it
    for (const strip of ["cells", "smooth"] as const) {
      for (const mode of ["utf8", "ascii"] as const) {
        const parked = pillOf(title(working(0, 31_000), mode, strip));
        for (let p = 0; p < 1; p += 0.002) {
          expect(pillOf(title(working(p), mode, strip))).not.toBe(parked);
        }
      }
    }
  });

  test("parking does not move the brackets on a smooth strip", () => {
    // The parked hyphen is narrower than the pill -- 6.22px against 11.21 in a
    // title bar, where a space is 3.28 and a hair 0.76 -- so the road takes up
    // a space and two hairs more, and the mark is within a fifth of a pixel of
    // the width it had while moving.
    const px = (text: string, mark: number): number =>
      [...pillOf(text)].reduce(
        (sum, ch) => sum + (ch === " " ? 3.28 : ch === HAIR ? 0.76 : 0),
        mark,
      );
    const moving = px(smooth(working(0.5)), 11.21);
    const parked = px(smooth(working(0.5, 31_000)), 6.22);
    expect(Math.abs(parked - moving)).toBeLessThan(0.2);
  });

  test("ragged gaps below the threshold still animate", () => {
    expect(title(working(0.5, 3_999))).not.toContain("quiet");
  });

  test("waiting on a person is stated, not implied by a stopped car", () => {
    expect(title({ kind: "waiting" })).toBe("? Rune - waiting for you");
  });

  test("idle carries the project, and nothing that suggests work", () => {
    expect(title({ kind: "idle" })).toBe("Rune - Atlas");
    expect(titleText({ kind: "idle" }, "", "utf8", "smooth")).toBe("Rune");
  });

  const everyState: TitleState[] = [
    { kind: "idle" },
    { kind: "waiting" },
    working(0),
    working(0.5),
    working(0.99),
    working(0.5, 31_000),
  ];

  test("only the block and the road's hairs are not ASCII", () => {
    // Another program's font draws this, not our grid. The block is a mark in
    // the glyph budget; nothing else is allowed to lean on a fallback font, so
    // the words and the brackets render anywhere.
    for (const strip of ["cells", "smooth"] as const) {
      for (const st of everyState) {
        const text = title(st, "utf8", strip);
        const foreign = [...text].filter((ch) => ch.charCodeAt(0) > 0x7e);
        for (const ch of foreign) expect(ch === BLOCK[strip] || ch === HAIR).toBe(true);
        if (strip === "cells") expect(text).not.toContain(HAIR);
      }
    }
  });

  test("a seven-bit terminal gets the block's twin and no hairs, on any strip", () => {
    for (const strip of ["cells", "smooth"] as const) {
      expect(pillOf(title(working(0), "ascii", strip))).toBe("[#  ]");
      expect(pillOf(title(working(0, 31_000), "ascii", strip))).toBe("[-  ]");
      for (const st of everyState) {
        // eslint-disable-next-line no-control-regex
        expect(title(st, "ascii", strip)).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  test("an ambiguous-width locale keeps the block -- a tab strip has no cells to eat", () => {
    // The grid folds its marks to ASCII there because a double-width cell
    // overwrites its neighbour. A title is not laid out in cells.
    expect(title(working(0), "ambig")).toBe(title(working(0), "utf8"));
    expect(title(working(0, 31_000), "ambig")).toBe(title(working(0, 31_000), "utf8"));
  });
});

describe("buttery, where the font allows it", () => {
  // "The animation is not that smooth, it feels jittery -- make it fluid,
  // smooth, buttery." A few stops is a jump of a third of the car each time,
  // held for uneven times.

  /** Long enough for the eased load to settle, and a whole number of paints so
   *  the paint after it is on the frame clock. */
  const SETTLED = 70 * FRAME_MS;

  test("the road is measured in hairs: twelve places, each one hair on", () => {
    const seen: number[] = [];
    for (let p = 0; p < 1; p += 0.0005) {
      const at = place(smooth(working(p)));
      if (seen[seen.length - 1] !== at) seen.push(at);
    }
    expect(PLACES).toBe(12);
    expect(seen).toEqual(Array.from({ length: PLACES }, (_, i) => i));
    // four times the places the same pill has on cells
    expect(PLACES).toBe(CELLS * 4);
    // the car starts against the left bracket and ends against the right one
    expect(smooth(working(0))).toMatch(/^\[[^  ]/);
    expect(pillOf(smooth(working(0.9999)))).toMatch(/[^  ]\]$/);
  });

  test("on the frame clock the car moves a hair or two a paint, never a lurch", () => {
    for (const [load, most] of [
      [0, 1], // at rest: a hair every few paints
      [1, 2], // flat out: a hair or two, about a pixel
    ] as const) {
      const glide = new Glide(0);
      paint(glide, 0, SETTLED, beat(load)); // let the eased load settle
      let last = place(smooth(working(glide.phase)));
      let moved = 0;
      let paints = 0;
      for (let now = SETTLED + FRAME_MS; now <= SETTLED + 3 * CALM_SWEEP_MS; now += FRAME_MS) {
        glide.advance(beat(load), now);
        const at = place(smooth(working(glide.phase)));
        if (at >= last) {
          expect(at - last).toBeLessThanOrEqual(most);
          moved += at - last;
        } // else: the one jump back to the left edge
        last = at;
        paints++;
      }
      // and it is motion, not a car held at three stops: at least a hair
      // every sixth paint, which is about every half second at rest
      expect(moved).toBeGreaterThan(paints / 6);
    }
  });

  test("a strip made of cells never sees a hair", () => {
    // In a monospace tab bar a hair space is a whole cell: the pill would be
    // eight cells wide with the car jumping back and forth in it.
    for (let p = 0; p < 1; p += 0.01) {
      const text = title(working(p), "utf8", "cells");
      expect(text).not.toContain(HAIR);
      expect([...pillOf(text)]).toHaveLength(pillChars("cells"));
    }
    expect(title(working(0.5, 31_000), "utf8", "cells")).not.toContain(HAIR);
  });

  test("only a title bar known to draw the pill, in the system font, is treated as smooth", () => {
    const strip = (env: Record<string, string>, platform = "darwin", pillFont = true): TitleStrip =>
      detectTitleStrip(env, platform, pillFont);
    expect(strip({ TERM_PROGRAM: "Apple_Terminal" })).toBe("smooth");
    expect(strip({ TERM_PROGRAM: "iTerm.app" })).toBe("smooth");
    expect(strip({ TERM_PROGRAM: "ghostty" })).toBe("smooth");
    // a terminal that draws its own tab bar, or one nobody has measured
    expect(strip({ TERM_PROGRAM: "WarpTerminal" })).toBe("cells");
    expect(strip({ TERM_PROGRAM: "WezTerm" })).toBe("cells");
    expect(strip({})).toBe("cells");
    // a multiplexer shows the title in a status line of cells, whatever is outside
    expect(strip({ TERM_PROGRAM: "Apple_Terminal", TMUX: "/tmp/tmux-501/default,1,0" })).toBe(
      "cells",
    );
    expect(strip({ TERM_PROGRAM: "ghostty", STY: "1234.pts-0" })).toBe("cells");
    // the same terminal on another platform has another font
    expect(strip({ TERM_PROGRAM: "ghostty" }, "linux")).toBe("cells");
    // a system without the font the pill is drawn from would show a box
    expect(strip({ TERM_PROGRAM: "Apple_Terminal" }, "darwin", false)).toBe("cells");
    // and the user can say so either way
    expect(strip({ TERM_PROGRAM: "Apple_Terminal", RUNE_TITLE_STRIP: "cells" })).toBe("cells");
    expect(strip({ RUNE_TITLE_STRIP: "smooth" }, "linux", false)).toBe("smooth");
    expect(strip({ TERM_PROGRAM: "Apple_Terminal", RUNE_TITLE_STRIP: "nonsense" })).toBe("smooth");
  });
});

describe("the pace is the work's", () => {
  test("the tab and the rung agree on what quiet and calm are", () => {
    expect(TITLE_QUIET_AFTER_MS).toBe(QUIET_AFTER_MS);
    // At rest the pill crosses once a breath, so the two are one rhythm.
    expect(CALM_SWEEP_MS).toBe(BREATH_MS);
  });

  test("harder work is a faster pill, and the load is bounded", () => {
    expect(workLoad(beat(0))).toBe(0);
    expect(workLoad(beat(1))).toBe(1);
    expect(workLoad(beat(0.6))).toBeGreaterThan(workLoad(beat(0.2)));
    // a fleet lifts it, each member less than the one before, never past full
    const one = workLoad(beat(0.2, 1));
    const three = workLoad(beat(0.2, 3));
    expect(one).toBeGreaterThan(workLoad(beat(0.2, 0)));
    expect(three).toBeGreaterThan(one);
    expect(three - workLoad(beat(0.2, 2))).toBeLessThan(one - workLoad(beat(0.2, 0)));
    expect(workLoad(beat(1, 40))).toBeLessThanOrEqual(1);
    // junk in is rest out, not NaN on the tab
    expect(workLoad(beat(Number.NaN, Number.NaN))).toBe(0);
    expect(workLoad(beat(7, -3))).toBe(1);

    expect(sweepRate(0)).toBeCloseTo(1 / CALM_SWEEP_MS, 12);
    expect(sweepRate(1)).toBeCloseTo(1 / BRISK_SWEEP_MS, 12);
    for (let l = 0.1; l <= 1; l += 0.1) expect(sweepRate(l)).toBeGreaterThan(sweepRate(l - 0.1));
  });

  test("an easy turn crosses once a breath; a hard one laps it three times", () => {
    const crossings = (b: TitleBeat): number => {
      const glide = new Glide(0);
      paint(glide, 0, 6_000, b); // let the eased load settle
      const cells = paint(glide, 6_000, 10 * CALM_SWEEP_MS, b);
      return runs(cells).filter(([cell]) => cell === 0).length;
    };
    const easy = crossings(beat(0));
    const hard = crossings(beat(1));
    expect(easy).toBeGreaterThanOrEqual(9);
    expect(easy).toBeLessThanOrEqual(11);
    expect(hard).toBeGreaterThanOrEqual(29);
    expect(hard).toBeLessThanOrEqual(31);
    // a fleet at a trickle is paced between the two
    const fleet = crossings(beat(0.1, 3));
    expect(fleet).toBeGreaterThan(easy);
    expect(fleet).toBeLessThan(hard);
  });

  test("on cells, flat out on the frame clock, no stop is skipped and none is a single paint", () => {
    // A cell shown for one paint is a flicker; a cell never shown is a jump.
    // BRISK_SWEEP_MS is as fast as the 90ms frame clock lets the pill go.
    const glide = new Glide(0);
    paint(glide, 0, 6_000, beat(1));
    const seen = runs(paint(glide, 6_000, 20 * BRISK_SWEEP_MS, beat(1))).slice(1, -1);
    expect(seen.length).toBeGreaterThan(CELLS * 10);
    for (let i = 0; i < seen.length; i++) {
      const [cell, paints] = seen[i]!;
      expect(paints).toBeGreaterThanOrEqual(2);
      if (i > 0) expect(cell).toBe((seen[i - 1]![0] + 1) % CELLS);
    }
  });

  test("a sudden load gathers; the pace never lurches and the pill never jumps", () => {
    const glide = new Glide(0);
    const rested = 30 * FRAME_MS; // a whole number of paints, so the next is on the clock
    paint(glide, 0, rested, beat(0));
    const range = sweepRate(1) - sweepRate(0);
    let rate = sweepRate(glide.load);
    let phase = glide.phase;
    for (let now = rested + FRAME_MS; now <= rested + 5_000; now += FRAME_MS) {
      glide.advance(beat(1, 3), now); // rest to everything, in one paint
      const next = sweepRate(glide.load);
      expect(next).toBeGreaterThanOrEqual(rate);
      expect(next - rate).toBeLessThan(range * 0.15);
      // the pill only ever moves forward, by less than a cell's worth of phase
      const moved = (glide.phase - phase + 1) % 1;
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(0.1);
      rate = next;
      phase = glide.phase;
    }
    expect(glide.load).toBeGreaterThan(0.99);
  });

  test("silence parks the pill, and the next output launches it from rest", () => {
    // A pill that moves on a timer is the bug -- the same test pulse.ts has.
    const glide = new Glide(0);
    paint(glide, 0, 5_000, beat(1));
    expect(glide.load).toBeGreaterThan(0.9);
    const still = paint(glide, 5_000, 60_000, beat(0, 0, TITLE_QUIET_AFTER_MS));
    expect(new Set(still)).toEqual(new Set([0]));
    expect(glide.phase).toBe(0);
    expect(glide.load).toBe(0);
    // back at the left edge, at the calm pace, not at the pace it stopped at
    glide.advance(beat(0), 65_000 + FRAME_MS);
    expect(glide.phase).toBeGreaterThan(0);
    expect(glide.phase).toBeLessThan((2 * FRAME_MS) / CALM_SWEEP_MS);
  });

  test("a tick that arrives late is not owed the motion it missed", () => {
    // A laptop lid, or a paint stuck behind a long frame: the pill must not
    // teleport on wake. One late tick counts for a quarter of a second at most.
    const glide = new Glide(0);
    glide.advance(beat(1), 60 * 60 * 1000);
    expect(glide.phase).toBeLessThan(250 / BRISK_SWEEP_MS);
    // and a clock that runs backwards moves nothing at all
    const before = glide.phase;
    glide.advance(beat(1), 0);
    expect(glide.phase).toBe(before);
  });
});

describe("what the turn hands the tab", () => {
  const renderer = (): TurnRenderer => {
    fleetLedger.reset(); // session-scoped singleton; a fresh test is a fresh session
    return new TurnRenderer({ commit: () => {}, preview: () => {} }, {});
  };
  const dispatch = (turn: TurnRenderer, callId: string, label: string): void => {
    turn.onEvent({ type: "tool_call_start", callId, toolName: "task" } as any);
    turn.onEvent({
      type: "tool_call_args_delta",
      callId,
      partialJson: JSON.stringify({ label, prompt: label }),
    } as any);
  };
  const progress = (callId: string, state: "started" | "settled") =>
    ({ type: "tool_progress", callId, note: "", state, ok: true }) as any;

  test("a turn that has produced nothing is at rest", () => {
    const b = renderer().beat();
    expect(b.level).toBe(0);
    expect(b.agents).toBe(0);
    expect(b.quietMs).toBeLessThan(TITLE_QUIET_AFTER_MS);
  });

  test("real output raises the level the pill is paced by", () => {
    const turn = renderer();
    turn.onEvent({ type: "text_delta", text: "Reading the retry ladder. ".repeat(40) } as any);
    const b = turn.beat();
    expect(b.level).toBeGreaterThan(0.3);
    expect(workLoad(b)).toBe(b.level);
  });

  test("only sub-agents that are running lift it -- not queued ones, not ones that are back", () => {
    const turn = renderer();
    dispatch(turn, "c1", "map the deploy surface");
    dispatch(turn, "c2", "find the auth store");
    expect(turn.beat().agents).toBe(0); // dispatched, not started
    turn.onEvent(progress("c1", "started"));
    expect(turn.beat().agents).toBe(1);
    turn.onEvent(progress("c2", "started"));
    const both = turn.beat();
    expect(both.agents).toBe(2);
    expect(workLoad(both)).toBeGreaterThan(both.level);
    turn.onEvent(progress("c1", "settled"));
    expect(turn.beat().agents).toBe(1);
  });
});

describe("the wire format", () => {
  test("is OSC 0, BEL-terminated", () => {
    const seq = titleSeq("Rune - Atlas");
    expect(seq.startsWith("\x1b]0;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
  });

  test("a title can never terminate its own sequence", () => {
    // Project names come off the filesystem, so a control character is reachable
    // here. Unlike warp.ts there is no JSON layer to neutralise one.
    const seq = titleSeq("Rune \x07 \x1b]0;evil");
    expect(seq.split("\x07")).toHaveLength(2); // exactly one, the terminator
    expect(seq).not.toContain("\x1b]0;evil");
  });

  test("clearing hands the tab back rather than naming it something else", () => {
    expect(titleSeq("")).toBe("\x1b]0;\x07");
  });
});
