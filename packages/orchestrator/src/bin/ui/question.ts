// --- The agent's question, and how you answer it ---
//
// `ask_user` is the one place the agent stops and hands the decision back. It
// used to render three inert lines above the composer -- the question, a
// numbered list nothing could select, and a run-on legend
// (`1-4 choose | or type an answer | Enter = 1 | Esc = skip`) -- and then wait
// for the ordinary input field to produce a string.
//
// Three things about that were wrong, and they compounded:
//
//   Nothing was selected. The list could not be walked, so `Enter` had to mean
//   something, and what it meant was options[0]. The reflex Enter of a person
//   clearing a prompt silently answered a product question with its first
//   option -- a choice they may never have read.
//
//   The digit shortcut was real but invisible. A bare `2` picked the second
//   option, and only while the field was empty. Type one character first and
//   the same key became text. One keystroke, two meanings, no way to tell
//   which one you were about to get. That is the jitter.
//
//   The field still read "describe a change, or / for commands" while the
//   agent was blocked waiting on an answer -- the UI advertising the one thing
//   it was not listening for.
//
// So: the choices are live and walkable, the digit still answers in a single
// keystroke (it is the fastest thing here and worth keeping), and the state
// that decides what a digit MEANS is drawn on the screen before you press it.
// The moment you type a word the choices dim, the marker leaves them, and the
// hint changes to say what Enter and Escape now do.
//
// Both halves are pure so the default is pinned by a test rather than by
// folklore -- the same reason ./surface.ts exists.

import * as F from "./flow";
import { glyph } from "./glyphs";
import { truncate, visLen } from "./render";
import type { Key } from "./keys";

/** Everything the picker needs to draw itself and to decide what a key means. */
export interface QuestionView {
  question: string;
  /** 2-6 short options, per the ask_user schema. */
  options: string[];
  /** The highlighted choice. Enter commits THIS. */
  selected: number;
  /** What is in the composer right now. Non-empty means they are writing. */
  input: string;
  /** Position within a batched round, 0-based, and its size. */
  index?: number;
  total?: number;
  /** Wall clock the 4th-gear grace window expires at, when there is one. */
  deadline?: number;
  /** Columns the pinned region owns. */
  width?: number;
  /** Injected for tests; defaults to now. */
  now?: number;
}

/**
 * What the empty field is for while a question is open.
 *
 * It names both paths, in the order you would try them: the fast one first,
 * then the escape hatch. A field that keeps its session placeholder here is
 * telling you to describe a change while the agent waits on an answer.
 */
export function questionPlaceholder(optionCount: number): string {
  // A free-form question (ask_user salvaged an unusable option list, or the
  // model deliberately offered none) has exactly one path, so the field names
  // exactly one path.
  if (optionCount === 0) return "type an answer in your own words";
  return `press 1-${optionCount}, or type an answer in your own words`;
}

/** Seconds left in the grace window, or null when nothing is counting down. */
export function graceRemaining(view: QuestionView): number | null {
  if (view.deadline == null) return null;
  return Math.max(0, Math.ceil((view.deadline - (view.now ?? Date.now())) / 1000));
}

/**
 * The hint line: what the keys do IN THIS STATE, never a legend of everything
 * they could ever do. It is the only row that changes when you start typing,
 * and that change is what makes the mode switch legible.
 */
export function questionHint(view: QuestionView): string {
  const dot = ` ${glyph("observed")} `;
  const budget = Math.max(12, F.measure(view.width) - F.BODY.length);
  const answering = view.input.length > 0;
  const seconds = graceRemaining(view);

  // Every hint carries a long form, a short form, and how hard it holds on.
  // Spelled out in full the row runs past 80 columns, and a row that wraps in
  // the pinned region desyncs the composer's cursor math -- so it has to give
  // something up. What it gives up is chosen rather than truncated: a hint cut
  // mid-word is worse than a hint that never mentioned the binding, because it
  // reads as a rendering fault. Lowest `keep` goes first.
  const hints: Array<{ long: string; short: string; keep: number }> = answering
    ? [
        { long: "enter  send this answer", short: "enter  send", keep: 3 },
        {
          long: view.options.length > 0 ? "esc  back to the choices" : "esc  clear",
          short: view.options.length > 0 ? "esc  back" : "esc  clear",
          keep: 2,
        },
      ]
    : view.options.length === 0
      ? // Free-form: there is nothing to pick, so the hints only name the two
        // things a key can actually do here.
        [
          { long: "type your answer, enter sends it", short: "type + enter", keep: 5 },
          { long: "esc  skip", short: "esc  skip", keep: 3 },
        ]
      : [
          // The number IS the picker. Everything else is a way of doing what a
          // digit already does in one keystroke, so everything else goes first.
          // Its short form is its long form. Nine columns is not what makes this
          // row too wide, and "1-4" on its own is a range with no verb -- the one
          // hint that must survive is also the one that must stay readable.
          {
            long: `1-${view.options.length}  pick`,
            short: `1-${view.options.length}  pick`,
            keep: 5,
          },
          { long: "up/down  move", short: "up/down", keep: 1 },
          { long: "enter  choose", short: "enter", keep: 2 },
          { long: "esc  skip", short: "esc  skip", keep: 3 },
        ];
  // The grace window outranks the bindings. Every other hint tells you how to
  // do something; this one tells you that not deciding is itself about to
  // decide, and it is the only line on screen that is spending while you read.
  if (seconds != null) {
    hints.push({ long: `continues on its own in ${seconds}s`, short: `${seconds}s left`, keep: 4 });
  }

  const render = (rows: typeof hints, long: boolean): string =>
    rows.map((h) => (long ? h.long : h.short)).join(dot);
  let rows = hints;
  if (visLen(render(rows, true)) <= budget) return render(rows, true);
  while (rows.length > 1) {
    if (visLen(render(rows, false)) <= budget) return render(rows, false);
    const weakest = rows.reduce((a, b) => (b.keep < a.keep ? b : a));
    rows = rows.filter((h) => h !== weakest);
  }
  return truncate(render(rows, false), budget);
}

/** The block above the composer: the question, the choices, and the hint. */
export function questionLines(view: QuestionView): string[] {
  return F.ask({
    question: view.question,
    options: view.options,
    selected: view.selected,
    // The presence of typed text IS the mode. Deriving it in one place keeps
    // the drawing and the key handling from ever disagreeing about which mode
    // the picker is in, which is the failure the old surface actually had.
    answering: view.input.length > 0,
    tone: "question",
    progress:
      view.total && view.total > 1 ? `${(view.index ?? 0) + 1} of ${view.total}` : undefined,
    hint: questionHint(view),
    width: view.width,
  });
}

/** What a keystroke means while a question is open. */
export type QuestionAction =
  /** Walk the choices. */
  | { kind: "move"; selected: number }
  /** Commit. `chosen` is the option's index when one was picked, absent for
   *  words the person wrote themselves. */
  | { kind: "answer"; text: string; chosen?: number }
  /** Discard a half-written answer and go back to the choices. */
  | { kind: "clear" }
  /** Leave the question unanswered; the model proceeds on its judgment. */
  | { kind: "skip" }
  /** Not ours: the composer edits itself. */
  | { kind: "edit" }
  /** Deliberately nothing. */
  | { kind: "ignore" };

/**
 * The picker's whole state machine.
 *
 * The one rule underneath it: a key may only mean something the screen is
 * currently saying it means. `answering` gates the shortcuts, and the renderer
 * derives `answering` from exactly the same field, so the hint can never
 * advertise a binding that is not live.
 */
export function questionAction(key: Key, view: QuestionView): QuestionAction {
  const answering = view.input.length > 0;
  const count = view.options.length;

  // Up/down walk the choices, wrapping, so a short list never dead-ends at
  // either edge. While an answer is being written they belong to the composer.
  // With no choices there is nothing to walk.
  if (!answering && count > 0 && (key.type === "up" || key.type === "down")) {
    const step = key.type === "down" ? 1 : -1;
    return { kind: "move", selected: (view.selected + step + count) % count };
  }

  // A bare digit answers in ONE keystroke -- no Enter, no confirmation. This is
  // the fast path the picker exists for, and the reason it is worth having a
  // picker at all rather than a text prompt. On a free-form question a digit
  // is just the first character of an answer, so it falls through to the edit.
  if (key.type === "char" && !answering && count > 0 && /^[1-9]$/.test(key.value)) {
    const n = Number(key.value);
    if (n >= 1 && n <= count) return { kind: "answer", text: view.options[n - 1]!, chosen: n - 1 };
    // A number with no option behind it does nothing. Letting it fall through
    // to the composer would drop a stray "7" into an answer the person thought
    // they had just submitted.
    return { kind: "ignore" };
  }

  if (key.type === "enter") {
    const typed = view.input.trim();
    if (typed) return { kind: "answer", text: typed };
    // Enter commits what is HIGHLIGHTED -- the row carrying the marker -- and
    // never a fixed first option. With nothing highlighted and nothing typed
    // there is nothing to commit, and inventing an answer would be worse than
    // waiting for one.
    if (count === 0) return { kind: "ignore" };
    return { kind: "answer", text: view.options[view.selected]!, chosen: view.selected };
  }

  // Escape backs out one step at a time: it clears a half-written answer before
  // it abandons the question, so a typo never costs the round.
  if (key.type === "esc") return answering ? { kind: "clear" } : { kind: "skip" };

  return { kind: "edit" };
}

/** Sent to the model when nobody chose. It says what happened and what to do. */
export const QUESTION_SKIPPED = "(user skipped the question -- proceed with your best judgment)";

/** Sent when 4th gear's grace window expires with no one at the keyboard. */
export const QUESTION_UNANSWERED =
  "(no answer within 60s -- proceed with your best judgment and state the assumption)";
