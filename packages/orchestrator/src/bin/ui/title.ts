// ─── The pane title: the one moving thing a terminal will actually show us ───
//
// Warp gives a branded icon and a live status badge to the CLI agents it knows,
// and it knows them by the launched command — claude, codex, gemini and the
// rest — from a list compiled into the app. `rune` is not on that list, so Warp
// opens no agent session for this pane, and the OSC 777 events in ./warp.ts,
// correct as they are, arrive with nothing to attach to. Getting on the list is
// a request to Warp, not a sequence this process can emit.
//
// The title is the half that is ours. Every terminal worth the name renames a
// tab on OSC 0, Warp included, and precisely because Warp has *not* classified
// this pane as an agent there is nothing on its side competing to rewrite it.
// So the tab carries the run: a pill gliding along its track while output
// flows, the stall in words when it stops, and a plain ask when the agent is
// waiting on a person.
//
// The mark is the founder's own sketch (2026-10-01): a pill, and inside it a
// solid block that gathers speed to the right, leaves, and comes back in from
// the left -- a bracket pair with the block at the left edge, then one stop
// further along, round again. It replaced a four-frame rung (`| / - \`) that
// turned at one rate whatever the run was doing. This one is paced by the run:
// easy work glides, hard work laps, and the change between the two is eased so
// the tab never lurches.
//
// Every part of the block is the founder's, one correction at a time. The
// first cut drew it as `=`: "a proper solid block, not something like = this".
// The second drew one full block, which a font makes taller than it is wide, a
// slab jammed between the brackets: "the thickness of the block is too much ...
// turn it vertical to horizontal ... like a car on the road ... keeping the
// borders' heights in mind". The third made it two cells long: "the width is
// too much, reduce it to half". The fourth was the right shape at the wrong
// scale: "reduce the size of the operation, it is too big -- [     ] like this,
// turn it to this [  ] kind -- accordingly resize the pill too". The fifth was
// small enough and sat on the floor: "the inner pill is not aligned to the
// centre properly". It could not have been. It was a level of the pulse ramp,
// and a ramp fills its cell from the bottom up, so its centre was two pixels
// under the brackets' and its foot level with theirs.
//
// The sixth was centred and too thin: a 3.7px bar, "instead of a block now you
// used the = this". Thick AND centred turns out to be one shape. Every glyph
// in the symbol blocks was laid out in the title bar's font and kept only if
// it was solid, within three quarters of a pixel of the brackets' centre line,
// and thick enough to be a block: no rectangle passes -- the squares all ride
// most of a pixel high -- and one ellipse does.
//
// So the block is a pill inside the pill, which is what was asked for in the
// first place: 9.9 by 6.6 in a 13px title bar, a third of a pixel off the
// brackets' centre line, longer than it is tall. The whole mark is 31px.
//
// Those numbers are AppKit's, not a guess. They come from laying the string
// out with `NSFont.titleBarFont` and CoreText's own fallback, which is what a
// title bar does: the brackets and the spaces are the system font, the pill is
// STIX Two Math's, a hair space is 0.76px against a space's 3.28. A browser asked for
// the system font answers differently -- it put the ramp's half level at 9.2px
// wide where a title bar draws it 12.3 -- and two of the corrections above were
// made against the browser's answer. Measure where it is drawn.
//
// The third cut was also "not that smooth ... jittery -- make it fluid, smooth,
// buttery", and it was: a few stops, each a jump of a third of the block, held
// for uneven times. What fixes that needs a title drawn in a PROPORTIONAL font,
// which is what a native macOS title bar is: the road is measured in hair
// spaces, about a quarter of a space each, so the same stretch of road has
// twelve places to be instead of three, and the block moves under a pixel a
// paint rather than several every half second.
//
// A tab strip drawn in a monospace font (tmux, a terminal's own tab bar) would
// give every hair space a whole cell, so it gets the plain three-stop road
// instead, and so does any host this has not been measured on -- see
// `detectTitleStrip`.
//
// The block and the hair space are the only characters here that are not
// ASCII. The block is two marks in the glyph budget (./glyphs.ts), one for each
// kind of strip, with a seven-bit twin. Everything else stays ASCII for the reason ./warp.ts is ASCII: this
// string is drawn by another program, in that program's UI font, not in our
// grid.
//
// Every moving frame is the SAME characters, only reordered, so the pill is the
// same width whatever the font -- the words beside it never shiver.
//
// It moves on the pulse, not on the clock — the same rule as ./pulse.ts, for
// the same reason. A mark driven by a timer goes on moving through a wedged
// tool call, and a tab promising work that isn't happening is worse than a tab
// that says nothing at all.

import { existsSync } from "node:fs";
import { GLYPH_DEFINITIONS, TERMINAL_GLYPH_MODE, type GlyphMode } from "./glyphs";

const ESC = "\x1b";
const BEL = "\x07";

/** Which kind of strip draws the title: `smooth` is a proportional UI font,
 *  where the road can be measured in hair spaces; `cells` is anything else. */
export type TitleStrip = "smooth" | "cells";

/** macOS terminals whose title bar and tabs are AppKit's, drawn in the system
 *  font. Named, not guessed: a terminal that draws its own tab bar (Warp, kitty,
 *  WezTerm) may use a font with no hair space at all. */
const SYSTEM_FONT_TITLES = new Set(["Apple_Terminal", "iTerm.app", "ghostty"]);

/** The font a macOS title bar draws the pill from. It ships with the system,
 *  but not with every release of it, and a title bar without it shows a box. */
const PILL_FONT = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf";

/**
 * Which strip this terminal is. `RUNE_TITLE_STRIP=smooth|cells` overrides it.
 *
 * A multiplexer owns the title and shows it in a status line made of cells,
 * whatever terminal is outside it, so it is checked first. A title bar that
 * cannot draw the pill is treated as cells too: it gets the square every font
 * has, on the plain road.
 */
export function detectTitleStrip(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  pillFont: boolean = platform === "darwin" && existsSync(PILL_FONT),
): TitleStrip {
  const forced = (env.RUNE_TITLE_STRIP ?? "").toLowerCase();
  if (forced === "smooth" || forced === "cells") return forced;
  if (platform !== "darwin" || env.TMUX || env.STY || !pillFont) return "cells";
  return SYSTEM_FONT_TITLES.has(env.TERM_PROGRAM ?? "") ? "smooth" : "cells";
}

export const TERMINAL_TITLE_STRIP = detectTitleStrip();

/** U+200A. Not a mark and not in the grid: it is spacing in another program's
 *  font, where it is about a quarter of a space wide. */
const HAIR = "\u200a";

/** Hair spaces to a space, to the nearest whole one. In a title bar a hair is
 *  0.76px and a space 3.28, so it is 4.3: trading four hairs for a space moves
 *  the block a pixel instead of three quarters of one, twice a crossing. */
const HAIRS_PER_SPACE = 4;

/** Spaces of road on a smooth strip. Two: with the loose hairs that is 8.8px
 *  of travel for a 9.9px pill, and the whole mark is 31px. */
const SMOOTH_SPACES = 2;

/** Loose hairs that ride along so the block can sit between two spaces. One
 *  short of a space; a fourth would just be another space. */
const LOOSE_HAIRS = HAIRS_PER_SPACE - 1;

/** Places the block can be on each kind of road. On cells, three: the pill is
 *  `[  ]` with a block in it, and a cell is a cell. On a smooth strip, every hair
 *  of about the same length of road. */
const STOPS: Record<TitleStrip, number> = {
  cells: 3,
  smooth: SMOOTH_SPACES * HAIRS_PER_SPACE + LOOSE_HAIRS + 1,
};

/** How many places the block can be on a strip's road. */
export function trackStops(strip: TitleStrip): number {
  return STOPS[strip];
}

/** Characters in the pill while the block is moving: the brackets, the block, and
 *  the road. The same in every moving frame, so the name beside it holds still. */
export function pillChars(strip: TitleStrip): number {
  return strip === "smooth" ? 3 + SMOOTH_SPACES + LOOSE_HAIRS : 3 + (STOPS.cells - 1);
}

/**
 * The block, for a strip and a mode. On a smooth strip it is the pill, drawn on
 * the brackets' centre line; on cells it is the square every font has -- see
 * ./glyphs.ts for why neither is a level of the pulse ramp. Only a seven-bit
 * terminal gets the twin. An ambiguous-width locale keeps the mark, unlike the
 * grid: there a double-width cell eats its neighbour, and a tab strip has no
 * cells to eat.
 */
function block(mode: GlyphMode, strip: TitleStrip): string {
  const mark = strip === "smooth" ? GLYPH_DEFINITIONS.titlePill : GLYPH_DEFINITIONS.titleBlock;
  return mode === "ascii" ? mark.ascii : mark.utf8;
}

/**
 * The block for a turn that has gone silent: flattened to a line, at the left
 * edge, on the same centre line. Deliberately still, and deliberately a shape
 * no moving frame has -- the stall is said in words beside it, and a block
 * caught mid-road would look like a frame of the glide. A hyphen, because it is
 * in every font and is centred in all of them.
 */
const PARKED = "-";

/**
 * Road added while parked on a smooth strip. The hyphen is the narrower of the
 * two: 6.22px against the pill's 11.21, which is five pixels. A space and two
 * hairs is 4.8, so the mark is within a fifth of a pixel of its moving width
 * and the brackets do not step together when the run goes quiet.
 */
const PARKED_TAKES_UP = ` ${HAIR.repeat(2)}`;

/** How long without real output before the tab stops claiming work. Matches
 *  QUIET_AFTER_MS in ./pulse.ts; the tab and the rung must not disagree. */
export const TITLE_QUIET_AFTER_MS = 4000;

/**
 * One crossing at rest: a breath. BREATH_MS in ./working.ts, restated here so
 * this module stays a leaf (a test holds the two equal). The rung in the grid
 * and the pill in the tab are then one rhythm when nothing much is happening.
 */
export const CALM_SWEEP_MS = 4320;

/**
 * One crossing flat out: a third of a breath. It is a ceiling as much as a
 * pace. On cells the shortest dwell is the last stop, 22% of a crossing, and at
 * 1440ms that is 320ms, three paints of the 90ms frame clock -- much faster and
 * a stop is shown for a single paint, which is a flicker, or skipped, which is
 * a jump. On a smooth strip it is sixteen paints for twelve places, so even at
 * its fastest the block moves a hair or two a paint: about a pixel.
 */
export const BRISK_SWEEP_MS = 1440;

/** How hard the block accelerates along the road: its place is the crossing's
 *  progress raised to this. 1 would be a metronome; much above 2 and it sits at
 *  the left edge and then vanishes. At 1.6 the three stops on cells are held
 *  for 50, 28 and 22 percent of a crossing -- each shorter than the last. */
const ACCEL = 1.6;

/** Time constant the load is eased with. A tool call opening is an instant, and
 *  a pace that tracked it raw would kick; over 700ms it gathers instead. */
const SETTLE_MS = 700;

/** What one sub-agent in flight is worth: it closes this share of the gap that
 *  remains to full load. One is 0.3, three are 0.66, and no number of them
 *  overshoots. */
const AGENT_LIFT = 0.3;

/** The longest gap one paint is allowed to count. A laptop that slept, or a
 *  tick that fired late behind a long frame, is not owed the motion it missed. */
const MAX_STEP_MS = 250;

/** What the pill is paced by, read off the turn once a paint. */
export interface TitleBeat {
  /** Milliseconds since real output -- see ./pulse.ts. */
  quietMs: number;
  /** 0...1 -- the decayed rate of real output, the same accumulator. */
  level: number;
  /** Sub-agents running right now; settled and queued ones do not count. */
  agents: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * How hard the run is working, 0...1.
 *
 * Two readings, both real and neither a clock. The output rate is the base:
 * prose, reasoning, tool arguments and callbacks all feed it, so a model
 * thinking aloud or firing calls back to back reads higher than one trickling
 * an answer. Sub-agents lift it, because a fleet is the heaviest thing a turn
 * does and its own stream is mostly waiting while they run.
 */
export function workLoad(beat: Pick<TitleBeat, "level" | "agents">): number {
  const agents = Number.isFinite(beat.agents) ? Math.max(0, Math.floor(beat.agents)) : 0;
  return 1 - (1 - clamp01(beat.level)) * Math.pow(1 - AGENT_LIFT, agents);
}

/** Crossings per millisecond at a load. Linear in SPEED, not in duration, so
 *  equal steps in load are equal steps in what the eye sees. */
export function sweepRate(load: number): number {
  const calm = 1 / CALM_SWEEP_MS;
  return calm + clamp01(load) * (1 / BRISK_SWEEP_MS - calm);
}

/**
 * Where the block is, carried from paint to paint.
 *
 * A phase accumulator rather than `elapsed * rate`: when the pace changes, only
 * how fast the phase grows changes, so the block never jumps to wherever the
 * new pace says it should have been. That, and the eased load, are the whole of
 * "in control".
 */
export class Glide {
  private at: number;
  private eased = 0;
  private swept = 0;

  constructor(now: number = Date.now()) {
    this.at = now;
  }

  /** 0...1 -- how far through the current crossing. */
  get phase(): number {
    return this.swept;
  }

  /** The load the block is moving at: `workLoad`, eased. */
  get load(): number {
    return this.eased;
  }

  advance(beat: TitleBeat, now: number = Date.now()): void {
    const dt = Math.min(MAX_STEP_MS, Math.max(0, now - this.at));
    this.at = now;
    // Silent past the threshold: park. The next output launches from rest at
    // the left edge instead of resuming mid-road at the old pace.
    if (beat.quietMs >= TITLE_QUIET_AFTER_MS) {
      this.eased = 0;
      this.swept = 0;
      return;
    }
    this.eased += (workLoad(beat) - this.eased) * (1 - Math.exp(-dt / SETTLE_MS));
    this.swept = (this.swept + dt * sweepRate(this.eased)) % 1;
  }
}

const frac = (phase: number): number => (Number.isFinite(phase) ? phase - Math.floor(phase) : 0);

/** Which place on the road the block is at for a phase. Eased in, so it leaves
 *  the left edge slowly and is moving fastest as it goes out on the right. */
export function pillStop(phase: number, strip: TitleStrip = "cells"): number {
  const stops = STOPS[strip];
  return Math.min(stops - 1, Math.floor(Math.pow(frac(phase), ACCEL) * stops));
}

/**
 * A smooth strip's road, `hairs` long, shared out so the block is `stop` hairs
 * along it. Whole spaces where a space fits and hairs for the remainder, on
 * both sides, so the two halves are always the same characters between them.
 */
function hairRoad(stop: number, hairs: number): [behind: string, ahead: string] {
  const wholeSpaces = Math.floor(hairs / HAIRS_PER_SPACE);
  const looseHairs = hairs % HAIRS_PER_SPACE;
  const spaces = Math.min(wholeSpaces, Math.floor(stop / HAIRS_PER_SPACE));
  const loose = stop - spaces * HAIRS_PER_SPACE;
  return [
    " ".repeat(spaces) + HAIR.repeat(loose),
    " ".repeat(wholeSpaces - spaces) + HAIR.repeat(Math.max(0, looseHairs - loose)),
  ];
}

/** The pill with the block at a place. The road behind it and ahead of it is
 *  the same characters every time, shared out differently. */
function pill(stop: number, mode: GlyphMode, strip: TitleStrip): string {
  if (strip === "cells") {
    return `[${" ".repeat(stop)}${block(mode, strip)}${" ".repeat(STOPS.cells - 1 - stop)}]`;
  }
  const [behind, ahead] = hairRoad(stop, STOPS.smooth - 1);
  return `[${behind}${block(mode, strip)}${ahead}]`;
}

/** The pill with the block parked at the left edge. */
function parkedPill(strip: TitleStrip): string {
  if (strip === "cells") return `[${PARKED}${" ".repeat(STOPS.cells - 1)}]`;
  const [, ahead] = hairRoad(0, STOPS.smooth - 1);
  return `[${PARKED}${ahead}${PARKED_TAKES_UP}]`;
}

export type TitleState =
  /** No turn in flight. */
  | { kind: "idle" }
  /** Mid-turn. `phase` is the crossing so far (see Glide); `quietMs` is how
   *  long since real output -- see ./pulse.ts. */
  | { kind: "working"; phase: number; quietMs: number }
  /** Stopped on an approval or a question. The state a background tab is for. */
  | { kind: "waiting" };

/**
 * The title for a state.
 *
 * Pure and exported so the wording can be asserted without a terminal. The mark
 * leads because a vertical tab is narrow and truncates from the right — the
 * part that has to survive the ellipsis is the part that moves.
 */
export function titleText(
  state: TitleState,
  project: string,
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
  strip: TitleStrip = TERMINAL_TITLE_STRIP,
): string {
  const name = project ? `Rune - ${project}` : "Rune";
  // A seven-bit terminal has no hair space to measure a road in.
  const road: TitleStrip = mode === "ascii" ? "cells" : strip;
  switch (state.kind) {
    case "idle":
      return name;
    case "waiting":
      return "? Rune - waiting for you";
    case "working": {
      // Past the threshold the block stops and the wait is stated. Below it, the
      // ragged gaps between token bursts are not worth reporting.
      if (state.quietMs >= TITLE_QUIET_AFTER_MS) {
        return `${parkedPill(road)} Rune - quiet ${Math.floor(state.quietMs / 1000)}s`;
      }
      return `${pill(pillStop(state.phase, road), mode, road)} ${name}`;
    }
  }
}

/**
 * OSC 0 — icon name and window title together, which is the pair Warp reads.
 *
 * Control characters are stripped rather than escaped: unlike ./warp.ts there is
 * no JSON layer here to neutralise them, and a raw BEL inside a title would end
 * the sequence early and spray the remainder across the screen. Project names
 * come off the filesystem, so this is reachable.
 */
export function titleSeq(text: string): string {
  return `${ESC}]0;${text.replace(/[\x00-\x1f\x7f]/g, "")}${BEL}`;
}

/** The last title written, so an unchanged one costs nothing. The turn's tick
 *  asks eleven times a second; on cells the block changes stop three times a
 *  crossing, and past the quiet threshold the text changes once a second. Without
 *  this the identical OSC would go out on every ask -- a second, unbatched
 *  writer interleaving with the frame writes for no change at all. */
let lastTitle: string | null = null;

/** Write one, best-effort, and only when it differs from what is up. Chrome
 *  must never be able to interrupt a session. */
export function setTitle(state: TitleState, project: string): void {
  const next = titleText(state, project);
  if (next === lastTitle) return;
  try {
    process.stdout.write(titleSeq(next));
    lastTitle = next;
  } catch {
    // The terminal is gone; there is nothing to name.
  }
}

/**
 * Hand the tab back.
 *
 * An empty title, not a remembered one: we never saw what was there before, and
 * every terminal treats empty as "resume naming this yourself", which is the
 * actual intent. Same argument as not asserting a background colour — inherit,
 * do not assert.
 */
export function clearTitle(): void {
  lastTitle = null;
  try {
    process.stdout.write(titleSeq(""));
  } catch {
    /* terminal already gone */
  }
}
