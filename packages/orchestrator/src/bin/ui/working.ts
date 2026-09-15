// ─── The working indicator: Rune's own pulse, given motion ───
//
// Founder, 2026-09-15 evening, on the version this replaces: "you actually
// copied Claude Code and built the exact same interface. I don't want that. I
// wanted that pulse design only, and something very soothing — a smooth
// animation, the kind of effect Claude Code and Codex both have while they are
// working — implemented correctly, not copied from some other CLI."
//
// So the correction is precise, and it cuts the other way from the last one.
// What went out is the BORROWED PART: a six-petalled florette and a capitalised
// gerund (`✻ Thinking · 12s`) are another product's indicator, and no amount of
// re-deriving them here makes them ours. What comes back is Rune's own pulse —
// the bar ramp `▁▂▃▄▅▆▇█` this codebase has drawn since the beginning, in
// Rune's own lower-case strip voice (`working`, `reading turn.ts`).
//
// What those tools actually have, and what the previous version did not, is not
// a glyph and not a phrase. It is MOTION WITH EASING. A shape that steps is
// busy; a shape that eases is calm, and the difference is entirely in the
// second derivative. Three things move here, and each of them is eased:
//
//   1. The mark BREATHES: the bar eases up the ramp and back down on a raised
//      cosine, ▁→█→▁, twenty-four frames a half-breath at 90ms a frame, so a
//      whole breath is 4.32s -- fourteen a minute, a calm person at rest.
//      Height and colour are taken from the SAME eased value, so they crest
//      together: `faint` at the trough, `accent` at the top -- and in
//      truecolor the colour is the mix itself, not four named steps.
//   2. The phrase SHIMMERS: it is painted quiet, and a soft glow sweeps across
//      it left to right, eased in and out over two thirds of a breath, then
//      rests for the last third -- one clock with the mark, so the row has one
//      rhythm. That rest is the difference between a shimmer and a barber's
//      pole. In truecolor the glow is a raised-cosine bump six cells wide,
//      each cell painted by its distance from the centre; elsewhere it is a
//      window of `text` over `quiet`.
//   3. Nothing else does. The clock does not shimmer — a number that moves
//      under the eye is a number you re-read — and a run that is finished,
//      waiting on a person, or not running at all holds perfectly still.
//
// Two invariants make this safe to put on screen for an hour at a time, and
// both are tested rather than asserted in prose: the per-frame step in the
// ramp is at most ONE level and in the colour ramp at most ONE tint (nothing
// jumps, because a jump is a strobe), and the frame rate is capped at 12fps.
//
// What this module is still NOT: a liveness detector. `pulse.ts` owns that, it
// is fed by real bytes, and the `quiet 31s` word beside this row stops when the
// output stops. This row says what the run is DOING and moves on a wall clock
// while it does; that word says whether it still is. A single cell carrying
// both could say neither, which is what the original byte-driven ramp proved.

import { accent, blendPaint, colorEnabled, dim, faint, quiet, text, truecolor } from "./theme";
import { PULSE_GLYPHS, TERMINAL_GLYPH_MODE, glyph, type GlyphMode } from "./glyphs";

/**
 * What the run is doing, as a closed set.
 *
 * Every member is reachable from an event the transcript ALREADY reads — a
 * tool call opening, a verification notice, a fan-out, a compaction notice,
 * the stream of prose, the turn ending. `working` is the resting member and
 * the only vague one, and it is vague on purpose: it is what the row says when
 * nothing more specific is true, which is exactly the claim it can support.
 */
export type WorkingKind =
  | "working"
  | "reading"
  | "editing"
  | "running"
  | "delegating"
  | "answering"
  | "waiting"
  | "compacting"
  | "done";

export interface WorkingState {
  kind: WorkingKind;
  /** The subject, when the event carried one: a path, a pattern, a command. */
  target?: string;
  /**
   * A phrase the caller already composed from the event, used verbatim apart
   * from its first letter.
   *
   * This exists for one caller and one reason: the live tool label
   * (`turn.ts`'s `liveToolLabel`) has been writing whole, careful phrases for
   * a year -- `Reading turn.ts`, `Checking with npx vitest run`, and
   * critically `Running the necessary command` while a command's arguments are
   * still streaming, which is what stops the row typing a path out letter by
   * letter. Re-deriving a verb from the tool name here would have thrown that
   * away and replaced it with `running run`. So the kind still decides how the
   * mark behaves and what the closed set contains; the words, where the event
   * already produced them, are the event's own -- down-cased at the boundary
   * (see `workingPhrase`), because the strip speaks in lower case and a
   * capital in the middle of a chrome row is a title, not a sentence.
   */
  phrase?: string;
  /** Milliseconds since the turn started. Omitted where there is no clock. */
  elapsedMs?: number;
  /**
   * Rune's own voice, composed by `voice.ts` from the kind and how long it has
   * been true -- `having a look around`, `still on it, this one's chunky`.
   * Leads the row when present; the phrase then follows it as the fact
   * (`reading turn.ts`), so nothing the row used to say is lost. Absent on
   * surfaces with no turn behind them (the aborting row, the rest row).
   */
  voice?: string;
}

/** The word, lower-case, for a state with nothing to name. */
const PHRASE: Record<WorkingKind, string> = {
  working: "working",
  reading: "reading",
  editing: "editing",
  running: "running",
  delegating: "delegating",
  answering: "answering",
  // The one phrase that is a sentence rather than a verb, because the state it
  // names is about the reader and not about the machine.
  waiting: "waiting for you",
  compacting: "compacting",
  done: "done",
};

/** Kinds that read as a bare verb with no object -- adding one would be
 *  inventing a subject the event never carried. */
const INTRANSITIVE: ReadonlySet<WorkingKind> = new Set<WorkingKind>([
  "working",
  "answering",
  "waiting",
  // A compaction has exactly one subject -- this conversation -- so naming it
  // would be filling a slot rather than reporting a fact.
  "compacting",
  "done",
]);

/**
 * Whether a kind's phrase is a bare word with nothing to name -- `working`,
 * `answering`, `waiting for you`, `compacting`. Beside a voice that already
 * says it (`okay, geared up`, `over to you`) such a word is the same fact
 * twice, so the row keeps the voice alone; a kind with a subject keeps both,
 * because `reading turn.ts` is information the voice does not carry.
 */
export function isBareKind(kind: WorkingKind): boolean {
  return INTRANSITIVE.has(kind);
}

/**
 * Map a tool name onto the verb that describes running it.
 *
 * Read from the SAME tool names the transcript's own verb table uses
 * (activity.ts), so a row that says `reading turn.ts` is above a rail that
 * will say `read turn.ts` a moment later. A tool this does not know is
 * `running`, which is literally true of any call and claims nothing more.
 */
export function workingKindForTool(toolName: string): WorkingKind {
  switch (toolName) {
    case "read_file":
    case "read_many":
    case "list_dir":
    case "grep":
    case "glob":
    case "web_fetch":
    case "web_search":
    case "read_back":
      return "reading";
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "apply_patch":
      return "editing";
    case "task":
    case "worker":
    case "team":
      return "delegating";
    case "ask_user":
      return "waiting";
    case "todo_write":
      return "working";
    default:
      return "running";
  }
}

/** `12s` / `1m 05s` / `1h 04m`. Zero-padded past a minute so the row's tail
 *  does not change width every ten seconds, which is a motion of its own. */
export function elapsedWord(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Lower-case the first letter only. A path, a command and a flag keep their
 *  case -- `checking with npx vitest run` is the whole point of taking the
 *  caller's phrase, and `Checking With Npx` would have thrown it away. */
function downcaseFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

/** The phrase alone: the verb, and the subject when the event carried one. */
export function workingPhrase(state: WorkingState): string {
  const given = (state.phrase ?? "").trim();
  if (given) return downcaseFirst(given);
  const verb = PHRASE[state.kind];
  const target = (state.target ?? "").trim();
  if (!target || INTRANSITIVE.has(state.kind)) return verb;
  return `${verb} ${target}`;
}

// ─── The frame clock ───

/**
 * One animation frame, in milliseconds.
 *
 * 90ms is 11.1fps, under the 12fps ceiling this indicator is allowed, and it
 * is the number the whole motion is quantised to: the repaint tick runs at the
 * same period (tui.ts), so every frame this module computes is a frame the
 * screen actually shows. A repaint slower than the frame clock would sample
 * the curve unevenly and put back exactly the stepping the easing exists to
 * remove.
 */
export const FRAME_MS = 90;

/** The ceiling, stated so a future edit to FRAME_MS trips a test rather than
 *  a reader's eye. Motion above this stops reading as motion and starts
 *  reading as flicker. */
export const MAX_FPS = 12;

/**
 * Twenty-four frames from trough to crest: 2.16s up, 2.16s down.
 *
 * It was twelve -- a 2.16s breath, which is twenty-eight breaths a minute, the
 * rate of someone who has just run up the stairs. The founder read it as
 * "too fast, not soothing, totally jittery", and the number agrees with them:
 * a calm adult at rest breathes twelve to sixteen times a minute, so a whole
 * breath here is 4.32s. Eight ramp levels over twenty-four frames also means
 * each level is held for three frames, which is what stops the bar reading as
 * a ticker.
 */
export const HALF_BREATH_FRAMES = 24;

/** A whole breath, in frames -- 48 at 90ms is 4.32s, fourteen breaths a
 *  minute, the rate of a calm person's breathing, which is the entire design
 *  brief for this curve. */
export const BREATH_FRAMES = HALF_BREATH_FRAMES * 2;

/** A whole breath, in milliseconds. */
export const BREATH_MS = BREATH_FRAMES * FRAME_MS;

/** Which frame of the breath a moment is on: 0 at the trough, 12 at the crest. */
export function breathFrame(elapsedMs: number, frameMs: number = FRAME_MS): number {
  const step = Math.max(1, Math.floor(frameMs));
  const ticks = Math.floor(Math.max(0, elapsedMs) / step);
  return ((ticks % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
}

/**
 * The easing: a raised cosine over the breath, 0 at the trough and 1 at the
 * crest.
 *
 * Raised cosine and not linear, and not a cubic: it is the only curve whose
 * first derivative is zero at BOTH ends, so the bar comes to rest at the top
 * and at the bottom instead of arriving and reversing. That pause at each end
 * is what the eye reads as breathing rather than as oscillation.
 *
 * It is also what bounds the step. The steepest the curve ever gets is
 * π/BREATH_FRAMES ≈ 0.131 per frame, so the ramp (seven intervals) moves at
 * most 0.92 of a level per frame and the tint ramp (three intervals) at most
 * 0.40 -- and a rounded value can therefore never move by more than one.
 */
export function breathEase(frame: number): number {
  // Folded to the rising half and then eased, rather than eased over the whole
  // period. Mathematically the same curve; numerically it is the only version
  // that is EXACTLY symmetric, because `cos(3pi/2)` is not zero in binary
  // floating point and the crest sits on a rounding boundary -- frames 6 and
  // 18 landed one ramp level apart, which is a visible hitch on the way down.
  const f = ((Math.floor(frame) % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
  const rising = f <= HALF_BREATH_FRAMES ? f : BREATH_FRAMES - f;
  return (1 - Math.cos((Math.PI * rising) / HALF_BREATH_FRAMES)) / 2;
}

/** The bar's height, as an index into the ramp: 0 (`▁`) at the trough, 7
 *  (`█`) at the crest. */
export function rampIndex(frame: number): number {
  const eased = breathEase(frame);
  return Math.round(eased * (PULSE_GLYPHS.length - 1));
}

/**
 * The colour ramp, as tint NAMES, faintest first.
 *
 * Four intensities is everything a theme actually owns: `dim` is the faint
 * slot (rails, gutters, elisions), `quiet` the muted slot, `text` the user's
 * own foreground, and `accent` the one colour the grammar reserves for things
 * that matter. Colour is taken from the same eased value as the height, so the
 * mark does not warm on a schedule of its own -- it is bright BECAUSE it is
 * tall.
 */
export const BREATH_TINTS = ["dim", "quiet", "text", "accent"] as const;
export type BreathTint = (typeof BREATH_TINTS)[number];

const TINT: Record<BreathTint, (s: string) => string> = { dim, quiet, text, accent };

/** Where in the colour ramp a frame lands. */
export function tintIndex(frame: number): number {
  return Math.round(breathEase(frame) * (BREATH_TINTS.length - 1));
}

/** The tint a frame lands on. */
export function breathTint(frame: number): BreathTint {
  return BREATH_TINTS[tintIndex(frame)]!;
}

/**
 * One cell of the ramp.
 *
 * The UTF-8 blocks only where the terminal has told us its cells are one
 * column wide. An ambiguous-width locale gets the ASCII twin for the same
 * reason `contextBar` does: a block that renders double-width eats its
 * neighbour, and a row that is one cell too long is worse than a row drawn in
 * punctuation. The twins are a ramp too -- `_ . , - = + * #` climbs -- so the
 * motion survives a seven-bit terminal even though the colour does not.
 */
export function rampGlyph(index: number, mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  const n = PULSE_GLYPHS.length;
  const level = PULSE_GLYPHS[Math.min(n - 1, Math.max(0, Math.round(index)))]!;
  return mode === "utf8" ? level.utf8 : level.ascii;
}

/**
 * Where the bar sits when it is not breathing: the middle of the ramp.
 *
 * Not the trough. `▁` is an underscore's worth of ink, and a finished run
 * whose mark had shrunk to nothing would read as an error rather than as a
 * rest. The mid bar is the cell this indicator used before any of this, held
 * still and painted `dim` -- which is what "at rest" has to look like for the
 * motion beside it to mean anything.
 */
export const REST_INDEX = 3;

/**
 * Does this state move?
 *
 * `done` is finished, `waiting` is waiting on a person, and a mark that went
 * on breathing through either would be reporting activity that is not
 * happening -- the exact failure the byte-fed pulse was built to stop. Idle is
 * the third case and it is handled by the caller: no turn, no tick, no frames.
 */
export function isBreathing(kind: WorkingKind): boolean {
  return kind !== "done" && kind !== "waiting";
}

/** The mark at rest: the mid bar, dim, not moving. */
export function workingRestMark(mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  return dim(rampGlyph(REST_INDEX, mode));
}

/** The bare rest cell, unpainted, for callers that tint the whole row. */
export function workingRestGlyph(mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  return rampGlyph(REST_INDEX, mode);
}

/**
 * The mark, painted for this frame of the breath.
 *
 * Height and tint move together off one eased value, which is the difference
 * between a breath and two animations sharing a cell.
 */
export function workingMark(
  state: WorkingState,
  frame: number,
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
): string {
  if (!isBreathing(state.kind)) return workingRestMark(mode);
  const f = ((Math.floor(frame) % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
  const bar = rampGlyph(rampIndex(f), mode);
  // In truecolor the tint is the SAME eased value, unquantised: the pigment
  // slides from the faint slot to the accent over the half-breath instead of
  // stepping through four names. The four-tint ramp stays for every terminal
  // that cannot take a mixed pigment, and for the tests, which state the
  // colour at a frame by name.
  if (truecolor) return blendPaint("faint", "info", breathEase(f))(bar);
  return TINT[breathTint(f)](bar);
}

// ─── The shimmer ───

/**
 * How long one pass across the phrase takes: two thirds of a breath.
 *
 * The sweep and the breath used to run on unrelated clocks (1.6s + 0.4s
 * against 2.16s), so the highlight crossed the words at a different moment of
 * every breath and the row never settled into a rhythm -- which is what
 * "preprogrammed" looks like when you cannot say why. The cycle is now
 * exactly one breath: the glow leaves the left edge as the bar starts to rise
 * and is off the right edge by the time it crests, then rests through the
 * fall. One clock, one motion at two rates.
 */
export const SHIMMER_SWEEP_MS = Math.round((BREATH_MS * 2) / 3);

/** How long the phrase rests, fully quiet, before the next pass -- the last
 *  third of the breath. Without this the window reappears on the left the
 *  instant it leaves on the right, and a loop with no rest in it is a
 *  barber's pole. */
export const SHIMMER_PAUSE_MS = BREATH_MS - SHIMMER_SWEEP_MS;

/** Sweep plus rest: one breath. */
export const SHIMMER_CYCLE_MS = SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS;

/** How wide the brighter window is. Six cells: in truecolor the glow is a
 *  raised-cosine bump this wide, so only its middle two cells are ever fully
 *  lit and the edges fade -- a highlight, not a stencil. On a stepped
 *  terminal it is the whole window, which is still narrow enough to read as
 *  light travelling over the words. */
export const SHIMMER_CELLS = 6;

/**
 * Ease-in-out for the sweep: the window accelerates off the left margin,
 * crosses the phrase at speed, and decelerates off the right.
 *
 * Same family as the breath -- half a raised cosine -- so the two motions on
 * this row are the same motion at two rates rather than two different ideas of
 * what smooth means.
 */
export function shimmerEase(p: number): number {
  const t = Math.min(1, Math.max(0, p));
  return (1 - Math.cos(Math.PI * t)) / 2;
}

export interface ShimmerWindow {
  /** The window's left edge, unclipped: it starts at `-SHIMMER_CELLS` (fully
   *  off the left) and ends at `length` (fully off the right), so the bright
   *  patch enters and leaves rather than appearing mid-word. */
  head: number;
  /** The visible span, clipped to the phrase: `[start, end)`. Empty while the
   *  window is still entering or has already left. */
  start: number;
  end: number;
}

/**
 * Where the bright window is at a given moment, or `null` during the rest.
 *
 * Driven off the same wall clock as the breath, and off the turn's own
 * `elapsedMs` rather than `Date.now()`, so two surfaces drawing the same state
 * in the same frame shimmer in step and a test can state the window's position
 * at 0ms, 800ms and 1700ms without a fake timer.
 */
export function shimmerWindowAt(
  elapsedMs: number,
  length: number,
  opts: { cells?: number; sweepMs?: number; cycleMs?: number } = {},
): ShimmerWindow | null {
  const cells = Math.max(1, Math.floor(opts.cells ?? SHIMMER_CELLS));
  const exact = shimmerHeadAt(elapsedMs, length, opts);
  if (exact == null) return null;
  const head = Math.round(exact);
  return {
    head,
    start: Math.max(0, Math.min(length, head)),
    end: Math.max(0, Math.min(length, head + cells)),
  };
}

/**
 * The window's left edge as a REAL number, or `null` during the rest.
 *
 * The rounded head above is what a stepped terminal paints, one cell at a
 * time. The truecolor glow reads this unrounded one, so the bump's centre
 * moves by a fraction of a cell each frame and the brightness of every cell
 * under it changes a little -- which is the difference between light passing
 * over the words and a stencil being dragged across them.
 */
export function shimmerHeadAt(
  elapsedMs: number,
  length: number,
  opts: { cells?: number; sweepMs?: number; cycleMs?: number } = {},
): number | null {
  if (length <= 0) return null;
  const cells = Math.max(1, Math.floor(opts.cells ?? SHIMMER_CELLS));
  const sweep = Math.max(1, Math.floor(opts.sweepMs ?? SHIMMER_SWEEP_MS));
  const cycle = Math.max(sweep, Math.floor(opts.cycleMs ?? SHIMMER_CYCLE_MS));
  const t = Math.max(0, elapsedMs) % cycle;
  if (t >= sweep) return null; // the rest between passes
  const travel = length + cells;
  return -cells + shimmerEase(t / sweep) * travel;
}

/**
 * How lit one cell of the phrase is under the glow: 0 quiet, 1 fully `text`.
 *
 * A raised-cosine bump centred on the middle of the window, `cells` wide, so
 * the light has a soft edge on both sides and no cell ever switches on --
 * it warms as the bump approaches and cools as it passes.
 */
export function shimmerGlow(
  elapsedMs: number,
  length: number,
  index: number,
  opts: { cells?: number; sweepMs?: number; cycleMs?: number } = {},
): number {
  const head = shimmerHeadAt(elapsedMs, length, opts);
  if (head == null) return 0;
  const cells = Math.max(1, Math.floor(opts.cells ?? SHIMMER_CELLS));
  const centre = head + cells / 2;
  const distance = Math.abs(index + 0.5 - centre) / (cells / 2);
  if (distance >= 1) return 0;
  return (1 + Math.cos(Math.PI * distance)) / 2;
}

export interface ShimmerSegment {
  text: string;
  bright: boolean;
}

/**
 * The phrase, split into the part under the window and the parts either side.
 *
 * Returned as data rather than as painted bytes because that is the only way
 * the sweep can be tested at all: the suite runs with NO_COLOR, where the
 * theme emits no escapes and every frame would be byte-identical.
 */
export function shimmerSegments(
  phrase: string,
  elapsedMs: number,
  opts: { cells?: number; sweepMs?: number; cycleMs?: number } = {},
): ShimmerSegment[] {
  if (!phrase) return [];
  const win = shimmerWindowAt(elapsedMs, phrase.length, opts);
  if (!win || win.end <= win.start) return [{ text: phrase, bright: false }];
  const parts: ShimmerSegment[] = [];
  if (win.start > 0) parts.push({ text: phrase.slice(0, win.start), bright: false });
  parts.push({ text: phrase.slice(win.start, win.end), bright: true });
  if (win.end < phrase.length) parts.push({ text: phrase.slice(win.end), bright: false });
  return parts;
}

/**
 * The phrase, painted.
 *
 * Quiet everywhere, `text` under the window -- one step up the same ramp the
 * mark climbs, never `accent`, because two accents on one row is two things
 * claiming to be the most important.
 *
 * The shimmer is OFF wherever it cannot be seen, and that is not merely a
 * saving: the repaint tick keys on the rendered row, so a phrase that
 * "shimmers" with no colour to shimmer in would repaint the whole frame eleven
 * times a second to redraw identical bytes. Off under NO_COLOR, off on a
 * seven-bit terminal, and off for any state that is not moving.
 */
export function paintPhrase(
  phrase: string,
  elapsedMs: number,
  opts: {
    kind?: WorkingKind;
    color?: boolean;
    mode?: GlyphMode;
    cells?: number;
    sweepMs?: number;
    cycleMs?: number;
  } = {},
): string {
  const mode = opts.mode ?? TERMINAL_GLYPH_MODE;
  const painted = opts.color ?? colorEnabled;
  const moving = isBreathing(opts.kind ?? "working");
  if (!painted || mode === "ascii" || !moving) return quiet(phrase);
  if (truecolor && opts.color !== false) {
    // The glow: every cell painted by its own distance from the bump's centre,
    // quantised to eight steps so neighbours at the same brightness share one
    // escape and a thirty-character phrase costs a handful of sequences, not
    // thirty. Eight steps over the soft edge is under the eye's threshold at
    // these pigments; the motion is in the bump moving, not in the steps.
    const parts: string[] = [];
    let run = "";
    let level = -1;
    const flush = () => {
      if (run) parts.push(blendPaint("muted", "text", level / 8)(run));
      run = "";
    };
    for (let i = 0; i < phrase.length; i++) {
      const next = Math.round(shimmerGlow(elapsedMs, phrase.length, i, opts) * 8);
      if (next !== level) {
        flush();
        level = next;
      }
      run += phrase[i]!;
    }
    flush();
    return parts.join("");
  }
  return shimmerSegments(phrase, elapsedMs, opts)
    .map((part) => (part.bright ? text(part.text) : quiet(part.text)))
    .join("");
}

/**
 * The whole row: the mark, the phrase, and the clock.
 *
 *     ▄ reading turn.ts · 40s
 *
 * The separator is the grammar's own middot (`observed`), so this row is
 * punctuated like every receipt beside it. The clock is dropped when there is
 * nothing to time -- `waiting for you` is not more informative for carrying
 * the number of seconds it has been true -- and it is painted `faint` and
 * never shimmered, because a number moving under the eye is a number you
 * re-read.
 */
export function workingRow(
  state: WorkingState,
  opts: { frameMs?: number; mode?: GlyphMode; color?: boolean } = {},
): string {
  // Phased off the turn's OWN clock, not off `Date.now()`: two surfaces
  // drawing the same state in the same frame show the same frame of the
  // breath, and a test can state the height at 0ms, 540ms and 1080ms without a
  // fake timer. A state with no clock does not move, so there is nothing to
  // phase.
  const elapsed = state.elapsedMs ?? 0;
  const frame = breathFrame(elapsed, opts.frameMs);
  const mark = workingMark(state, frame, opts.mode);
  const paint = { kind: state.kind, mode: opts.mode, color: opts.color };
  // The voice, when there is one, is the sentence and takes the shimmer; the
  // phrase is then the fact beside it, set quiet. With no voice the phrase is
  // the sentence, exactly as before.
  const voice = (state.voice ?? "").trim();
  const fact = workingPhrase(state);
  // A bare word is not a fact worth a column beside a voice that already
  // says it: `okay, geared up · working` says `working` twice.
  const said = voice
    ? isBareKind(state.kind)
      ? paintPhrase(voice, elapsed, paint)
      : `${paintPhrase(voice, elapsed, paint)}${faint(sep(opts.mode))}${quiet(fact)}`
    : paintPhrase(fact, elapsed, paint);
  const clock =
    state.kind === "waiting" || state.elapsedMs == null ? "" : elapsedWord(state.elapsedMs);
  return clock ? `${mark} ${said}${faint(sep(opts.mode))}${faint(clock)}` : `${mark} ${said}`;
}

/** The row's separator: the grammar's own middot, spaced. */
function sep(mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  return ` ${glyph("observed", mode)} `;
}

/** The phrase and clock without the mark, unpainted, for surfaces that paint
 *  their own (the panel card, whose first cell is the selection rung). */
export function workingText(state: WorkingState): string {
  const clock =
    state.kind === "waiting" || state.elapsedMs == null ? "" : elapsedWord(state.elapsedMs);
  const phrase = workingPhrase(state);
  return clock ? `${phrase} ${glyph("observed")} ${clock}` : phrase;
}
