// ─── The working indicator: a calm mark, a whole phrase, and the clock ───
//
// Founder, 2026-09-15: the old indicator "does not look satisfying — make it
// soothing and calm, give it proper character, the whole text and a pulse, the
// way Codex and Claude Code have."
//
// What it replaced was one bright accent cell off the block ramp (`▄`) and a
// two-word telegram: `▄ working · asking`. Three things were wrong with it and
// only one of them was the glyph.
//
//   1. The cell CHANGED SHAPE, eight levels of it, driven by the byte rate. A
//      shape that jumps between ▁ and █ four times a second is not a pulse, it
//      is a flicker, and it was drawn in the accent colour — the one colour the
//      grammar reserves for things that matter.
//   2. `working` is not a state, it is the absence of one. It was true of a
//      grep, of a 90-second test run and of four sub-agents alike.
//   3. `asking` is a fragment. It reads as an adjective on `working` rather
//      than as the sentence it actually is: the run is waiting for YOU.
//
// So: one mark that never changes shape, a whole phrase that names what is
// actually happening, and the elapsed clock.
//
//     ✻ Thinking · 12s
//     ✻ Reading turn.ts · 40s
//     ✻ Running checks · 1m 05s
//     ✻ Waiting for you
//     ✻ Done · 1m 58s
//
// The BREATH is colour, not shape: muted → text → accent → text → muted, one
// step every 700ms, so a full breath is 3.5 seconds and the mark spends two of
// its five steps at rest. Nothing on screen moves; the mark warms and cools.
// That is the whole difference between calm and busy, and it is also what
// makes the indicator honest under NO_COLOR — where the colour is gone, the
// PHRASE and the clock still say everything the row has to say, which is the
// rule the rest of this product already keeps (nothing carried by colour
// alone).
//
// What this module is NOT: a liveness detector. `pulse.ts` still owns that,
// and it still cannot lie — the `quiet 31s` word beside this row is fed by
// real output and stops when the bytes stop. This row says what the run is
// DOING; that one says whether it is still doing it. Keeping them separate is
// deliberate: the previous design made one cell carry both, and so the cell
// could say neither.

import { accent, faint, muted, text } from "./theme";
import { glyph, TERMINAL_GLYPH_MODE, type GlyphMode } from "./glyphs";

/**
 * What the run is doing, as a closed set.
 *
 * Every member is reachable from an event the transcript ALREADY reads — a
 * tool call opening, a verification notice, a fan-out, a compaction notice,
 * the stream of prose, the turn ending. There is deliberately no member for
 * "busy" or "processing": a phrase nothing can produce is a phrase that will
 * eventually be produced by everything.
 */
export type WorkingKind =
  | "thinking"
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
   * A phrase the caller already composed from the event, used VERBATIM.
   *
   * This exists for one caller and one reason: the live tool label
   * (`turn.ts`'s `liveToolLabel`) has been writing whole, careful phrases for
   * a year -- `Reading turn.ts`, `Checking with npx vitest run`, and
   * critically `Running the necessary command` while a command's arguments are
   * still streaming, which is what stops the row typing a path out letter by
   * letter. Re-deriving a verb from the tool name here would have thrown that
   * away and replaced it with `Running run`. So the kind still decides how the
   * mark behaves and what the closed set contains; the phrase, where the event
   * already produced one, is the one the event produced.
   */
  phrase?: string;
  /** Milliseconds since the turn started. Omitted where there is no clock. */
  elapsedMs?: number;
}

/** The verb, capitalised, for a state with nothing to name. */
const PHRASE: Record<WorkingKind, string> = {
  thinking: "Thinking",
  reading: "Reading",
  editing: "Editing",
  running: "Running",
  delegating: "Delegating",
  answering: "Answering",
  // The one phrase that is a sentence rather than a verb, because the state it
  // names is about the reader and not about the machine.
  waiting: "Waiting for you",
  compacting: "Compacting",
  done: "Done",
};

/** Kinds that read as a bare verb with no object -- adding one would be
 *  inventing a subject the event never carried. */
const INTRANSITIVE: ReadonlySet<WorkingKind> = new Set<WorkingKind>([
  "thinking",
  "answering",
  "waiting",
  // A compaction has exactly one subject -- this conversation -- so naming it
  // would be filling a slot rather than reporting a fact.
  "compacting",
  "done",
]);

/**
 * Map a tool name onto the verb that describes running it.
 *
 * Read from the SAME tool names the transcript's own verb table uses
 * (activity.ts), so a row that says `Reading turn.ts` is above a rail that
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
      return "thinking";
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

/** The phrase alone: the verb, and the subject when the event carried one. */
export function workingPhrase(state: WorkingState): string {
  const given = (state.phrase ?? "").trim();
  if (given) return given;
  const verb = PHRASE[state.kind];
  const target = (state.target ?? "").trim();
  if (!target || INTRANSITIVE.has(state.kind)) return verb;
  return `${verb} ${target}`;
}

// ─── The breath ───

/**
 * One step of the breath, in milliseconds.
 *
 * The founder's floor is 600ms and the ceiling 800ms; 700 sits in the middle
 * and divides the 125ms repaint tick evenly enough that no step is ever missed
 * or doubled. A full breath is `BREATH_TINTS.length * BREATH_MS` = 3.5s.
 */
export const BREATH_MS = 700;

/** The ramp, as tint NAMES. Muted at both ends, so the mark rests at the
 *  bottom of the breath for two steps out of five rather than snapping back. */
export const BREATH_TINTS = ["muted", "text", "accent", "text", "muted"] as const;
export type BreathTint = (typeof BREATH_TINTS)[number];

// `muted` is theme.ts's `muted`/`faint` (both the faint slot), which is the ink
// every other "quieter than body" call in this product lands on -- so the
// bottom of the breath is a colour the reader has already learned means
// background, and the top is the accent they have learned means look here.
const TINT: Record<BreathTint, (s: string) => string> = {
  muted,
  text,
  accent,
};

/**
 * Which step of the breath a given moment is on.
 *
 * Driven by wall-clock and NOT by the output rate, which is the one thing this
 * shares with a spinner and the reason it is safe to: it carries no claim
 * about liveness. `quiet 31s` beside it does, fed by real bytes, and a stalled
 * run therefore reads as a calm mark next to the word `quiet` -- which is
 * exactly right, and is what a hurrying spinner could never say.
 */
export function breathStep(elapsedMs: number, cadenceMs: number = BREATH_MS): number {
  const step = Math.max(1, Math.floor(cadenceMs));
  const ticks = Math.floor(Math.max(0, elapsedMs) / step);
  return ticks % BREATH_TINTS.length;
}

/** The tint a step lands on. */
export function breathTint(step: number): BreathTint {
  const n = BREATH_TINTS.length;
  return BREATH_TINTS[((Math.floor(step) % n) + n) % n]!;
}

/**
 * The mark, painted for this step of the breath.
 *
 * A settled state does not breathe: `done` is finished and `waiting` is
 * waiting on a person, and a mark that went on pulsing through either would be
 * reporting activity that is not happening.
 */
export function workingMark(state: WorkingState, step: number, mode?: GlyphMode): string {
  const mark = glyph("working", mode ?? TERMINAL_GLYPH_MODE);
  if (state.kind === "done") return muted(mark);
  if (state.kind === "waiting") return accent(mark);
  return TINT[breathTint(step)](mark);
}

/**
 * The whole row: the mark, the phrase, and the clock.
 *
 *     ✻ Reading turn.ts · 40s
 *
 * The separator is the grammar's own middot (`observed`), so this row is
 * punctuated like every receipt beside it. The clock is dropped when there is
 * nothing to time -- `Waiting for you` is not more informative for carrying
 * the number of seconds it has been true.
 */
export function workingRow(
  state: WorkingState,
  opts: { cadenceMs?: number; mode?: GlyphMode } = {},
): string {
  // The breath is phased off the turn's OWN clock, not off `Date.now()`: two
  // surfaces drawing the same state in the same frame then show the same step,
  // and a test can state the colour at 0ms, 700ms and 1400ms without a fake
  // timer. A state with no clock does not breathe, so there is nothing to phase.
  const step = breathStep(state.elapsedMs ?? 0, opts.cadenceMs);
  const mark = workingMark(state, step, opts.mode);
  const phrase = workingPhrase(state);
  const clock =
    state.kind === "waiting" || state.elapsedMs == null ? "" : elapsedWord(state.elapsedMs);
  const sep = ` ${glyph("observed", opts.mode ?? TERMINAL_GLYPH_MODE)} `;
  return clock
    ? `${mark} ${muted(phrase)}${faint(sep)}${faint(clock)}`
    : `${mark} ${muted(phrase)}`;
}

/** The phrase and clock without the mark, for surfaces that paint their own
 *  (the panel card, whose first cell is the selection rung). */
export function workingText(state: WorkingState): string {
  const clock =
    state.kind === "waiting" || state.elapsedMs == null ? "" : elapsedWord(state.elapsedMs);
  const phrase = workingPhrase(state);
  return clock ? `${phrase} ${glyph("observed")} ${clock}` : phrase;
}
