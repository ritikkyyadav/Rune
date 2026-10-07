// ─── The working row: what the run is doing, in words ───
//
// The row above the composer answers one question -- what is the run doing --
// and this module owns the WORDS of the answer: the closed set of kinds a run
// can be in, the phrase for each, the stage, the clock, and how all of it is
// fitted to a window (`stagedRow`).
//
// The row's MARK is not here. Since 2026-10-02 it is Say's glyph, struck by the
// turn's own output and by every sub-agent's (./waveform.ts), and it is the
// only thing in the product that animates.
//
// History, because four versions of this row were rejected and the reasons are
// the design. A borrowed florette and a capitalised gerund (`✻ Thinking · 12s`)
// were another product's indicator. A one-cell bar breathing on a raised cosine
// moved on a wall clock: a fast stream and a hung call drew the same bar, and
// at its crest it was a full block, the composer cursor's twin. A glow sweeping
// the phrase was a second thing moving on a row meant to be watched for an
// hour. And the same breathing bar, kept for each sub-agent, was "just a
// deterministic behaviour ... I don't want that in Rune, just that one Glyph as
// the animation." So this module draws nothing that moves: the words hold
// still, and the motion is the work's.
//
// What this module is NOT: a liveness detector. `pulse.ts` owns that, it is fed
// by real bytes, and the `quiet 31s` word beside the row stops when the output
// stops.

import { faint, quiet, text } from "./theme";
import { TERMINAL_GLYPH_MODE, glyph, type GlyphMode } from "./glyphs";
import { graphemeSpans, prefixByWidth, termWidth, visLen } from "./render";

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
 * 90ms is 11.1fps, under the 12fps ceiling the rung is allowed, and it is the
 * number the mark's motion is quantised to: the repaint tick runs at the same
 * period (tui.ts), and the mark takes one frame of motion per paint
 * (./waveform.ts), so a slower tick would be a slower mark.
 */
export const FRAME_MS = 90;

/** The ceiling, stated so a future edit to FRAME_MS trips a test rather than
 *  a reader's eye. Motion above this stops reading as motion and starts
 *  reading as flicker. */
export const MAX_FPS = 12;

/**
 * The calm period: 4.32s, fourteen to the minute, a person breathing at rest.
 *
 * It was the length of the one-cell breath this module used to draw (first
 * 2.16s, which the founder read as "too fast, not soothing, totally jittery").
 * The breath is gone; the number is kept because it is still the pace of
 * everything that is calm here -- one sweep of the mark across the row while a
 * turn is silent (./waveform.ts), one crossing of the tab's pill at rest
 * (./title.ts). Tests hold all three equal.
 */
export const BREATH_MS = 48 * FRAME_MS;

/**
 * Is the turn in flight?
 *
 * `done` is finished and `waiting` is waiting on a person. A row that went on
 * describing work through either would be reporting activity that is not
 * happening, so both say their one word and stop, and the mark beside them is
 * flat. Idle is the third case and it is the caller's: no turn, no tick.
 */
export function isBreathing(kind: WorkingKind): boolean {
  return kind !== "done" && kind !== "waiting";
}

// ─── The measure ───

/**
 * The widest this row is ever drawn, whatever the terminal claims.
 *
 * A row is a SENTENCE, and a sentence past about a hundred cells stops being
 * read and starts being scanned -- the same measure the prose column keeps.
 */
export const ROW_MAX_COLS = 120;

/**
 * The cells this row may use: the terminal's own width, capped at the measure,
 * less the two-cell gutter every caller draws it in (`  ▄ reading …`).
 */
export function workingRowCells(width?: number): number {
  const cols = width ?? termWidth();
  return Math.max(16, Math.min(ROW_MAX_COLS, Math.max(1, Math.floor(cols))) - 2);
}

/** The longest grapheme-safe SUFFIX that fits in `max` cells -- the tail of a
 *  path, which is the half of it a reader actually needs. */
function suffixByWidth(value: string, max: number): string {
  if (max <= 0) return "";
  const spans = graphemeSpans(value);
  let width = 0;
  let start = value.length;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    if (width + span.width > max) break;
    width += span.width;
    start = span.start;
  }
  return value.slice(start);
}

/**
 * Fit a phrase to a budget by taking the MIDDLE out of it, not the end.
 *
 * `reading /Users/me/project/packages/orchestrator/src/bin/ui/working.ts` cut
 * from the right is `reading /Users/me/project/packa…` -- which names no file
 * at all, and the file is the entire content of the row. So the verb is kept
 * whole, the subject keeps its head and its tail, and the elision sits where
 * the least is lost. The tail is given the larger share, because that is where
 * the filename is.
 */
export function fitPhrase(
  value: string,
  budget: number,
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
): string {
  if (budget <= 0) return "";
  if (visLen(value) <= budget) return value;
  const mark = glyph("elision", mode);
  const space = value.indexOf(" ");
  // Keep the verb only while what is left can still say something: below a
  // handful of cells the subject is all elision, and then the verb is the
  // thing worth spending them on.
  const MIN_SUBJECT = 8;
  const verbCells = space > 0 ? visLen(value.slice(0, space)) : 0;
  if (space > 0 && verbCells + 1 + visLen(mark) + MIN_SUBJECT <= budget) {
    return `${value.slice(0, space)} ${elideMiddle(value.slice(space + 1), budget - verbCells - 1, mark)}`;
  }
  return elideMiddle(value, budget, mark);
}

function elideMiddle(value: string, budget: number, mark: string): string {
  if (visLen(value) <= budget) return value;
  const cost = visLen(mark);
  if (budget <= cost) return prefixByWidth(value, budget);
  const keep = budget - cost;
  const tail = Math.max(1, Math.round(keep * 0.6));
  const head = Math.max(0, keep - tail);
  return `${prefixByWidth(value, head)}${mark}${suffixByWidth(value, tail)}`;
}

/** What the row ends up saying: Rune's voice, and the fact beside it. */
export interface FittedSaid {
  voice: string;
  fact: string;
}

/**
 * Fit the voice and the fact into one budget.
 *
 * The fact is the part a developer reads (`reading turn.ts`); the voice is the
 * part that makes the row Rune's (`having a look around`). So a window too
 * narrow for both keeps the FACT -- the same call turn.ts makes when the prose
 * column drops under 72 cells -- and the fact is elided rather than dropped,
 * because a row with no subject reports nothing.
 */
export function fitSaid(
  voice: string,
  fact: string,
  budget: number,
  mode: GlyphMode = TERMINAL_GLYPH_MODE,
): FittedSaid {
  const room = Math.max(0, budget);
  if (!voice) return { voice: "", fact: fitPhrase(fact, room, mode) };
  if (!fact) return { voice: fitPhrase(voice, room, mode), fact: "" };
  const gap = visLen(sep(mode));
  const spent = visLen(voice) + gap + visLen(fact);
  if (spent <= room) return { voice, fact };
  const left = room - visLen(voice) - gap;
  // Under this the fact is elision and a letter, which says less than the
  // voice does; past it the pair still reads as a sentence and a subject.
  const MIN_FACT = 12;
  if (left >= MIN_FACT) return { voice, fact: fitPhrase(fact, left, mode) };
  return { voice: "", fact: fitPhrase(fact, room, mode) };
}

// ─── The stage ───

/**
 * Where the turn is: the harness's own phases (turn.ts `WorkPhase`), and the
 * opening before anything has been called.
 */
export type WorkStage = "start" | "understand" | "plan" | "act" | "verify";

/** The stage as a plain word. One table, so the wording is one edit. */
const STAGE_WORD: Record<WorkStage, string> = {
  start: "starting",
  understand: "looking",
  plan: "planning",
  act: "building",
  verify: "checking",
};

/**
 * The word in the row's first slot.
 *
 * The stage, unless the kind is one of the four states that are not a stage of
 * the work at all: the turn is waiting on a person, has finished, is rewriting
 * its own context, or is writing the answer.
 */
export function stageWord(stage: WorkStage, kind: WorkingKind): string {
  switch (kind) {
    case "waiting":
      return "over to you";
    case "done":
      return "done";
    case "compacting":
      return "housekeeping";
    case "answering":
      return "answering";
    default:
      return STAGE_WORD[stage];
  }
}

/**
 * The row with a stage in it: the mark, where the turn is, Rune's voice, the
 * fact, and the clock.
 *
 *     ▁▂▄▃▂▁▁▁▁▁▁▁ building · small, steady edits · editing turn.ts · 1m 05s
 *
 * The mark is the caller's (./waveform.ts paints it) and is the only thing on
 * the row that moves: the words are set once and held, the stage in the text
 * ink because it is the slot the eye comes back to, everything after it quiet.
 * A state that is about the reader rather than the work -- waiting, done --
 * says its word and stops.
 */
export function stagedRow(
  mark: string,
  state: WorkingState & { stage: WorkStage },
  opts: {
    mode?: GlyphMode;
    width?: number;
    /** Cells the caller will set down after the row (a receipt and its gap).
     *  Paid for here, out of the fact, so the clock is never what gets cut. */
    reserve?: number;
    /** False when what follows the row already says the fact: a fan-out whose
     *  members are named in blocks beside it does not also say
     *  `delegating 3 sub-agents`. `"whole"` says it only where it fits
     *  unshortened -- beside a row of blocks, a fact with its middle taken out
     *  is clutter rather than information. */
    fact?: boolean | "whole";
  } = {},
): string {
  const stage = stageWord(state.stage, state.kind);
  const clock =
    state.kind === "waiting" || state.elapsedMs == null ? "" : elapsedWord(state.elapsedMs);
  const still = !isBreathing(state.kind);
  const gap = visLen(sep(opts.mode));
  const budget = Math.max(
    0,
    workingRowCells(opts.width) -
      visLen(mark) -
      1 -
      stage.length -
      gap -
      (clock ? gap + clock.length : 0) -
      Math.max(0, Math.floor(opts.reserve ?? 0)),
  );
  const voice = still ? "" : (state.voice ?? "").trim();
  // A bare word (`working`, `answering`, `compacting`) is never set beside the
  // stage: the stage word already says it, voice or no voice.
  const said = still || opts.fact === false || isBareKind(state.kind) ? "" : workingPhrase(state);
  const fact = opts.fact === "whole" && visLen(said) > budget ? "" : said;
  // The voice is what makes the row Rune's and the fact is what a developer
  // reads, so the voice gives way FIRST and whole: with a mark and a stage in
  // front of them an 80-column row cannot hold both, and a file name with its
  // middle taken out to keep a pleasantry is the wrong trade.
  // And it is never elided: half a voice line (`…e`) is not a voice.
  const voiceFits = visLen(voice) + (fact ? gap + visLen(fact) : 0) <= budget;
  const fit = fitSaid(voiceFits ? voice : "", fact, budget, opts.mode);
  const parts = [text(stage), fit.voice && quiet(fit.voice), fit.fact && quiet(fit.fact)];
  if (clock) parts.push(faint(clock));
  return `${mark} ${parts.filter(Boolean).join(faint(sep(opts.mode)))}`;
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
