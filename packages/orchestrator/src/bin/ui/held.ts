// ─── The held steps, and what you do about them ───
//
// Auto mode's contract is that it never interrupts the run: an outward,
// irreversible step it will not take unattended is recorded and the work
// around it gets finished. The record used to arrive as prose — a printed
// list at the end of the turn — and prose was the whole problem. The steps
// it named could not be acted on: re-running one meant re-typing it, and the
// path of least resistance past a held publish was "shift to 4th gear",
// which grants everything to get one thing.
//
// This surface is the other half of the contract. The same list, but each
// step can be approved individually — and an approval runs EXACTLY the call
// the agent asked for, byte for byte, as an exact session grant. Nothing
// broader is granted, no model is consulted, and leaving a step unrun is a
// decision the next turn gets told about rather than a silence it re-litigates.
//
// Both halves are pure so the defaults are pinned by tests rather than by
// folklore — the same reason ./question.ts is built this way.

import * as F from "./flow";
import { glyph } from "./glyphs";
import { bold, faint, info, muted, ok, text, warn } from "./theme";
import { truncate, visLen } from "./render";
import type { Key } from "./keys";

/** What happened to one held step while the panel was open. */
export type HeldOutcome = "ran" | "failed" | "refused" | "skipped";

/** The step as the panel needs it — a structural slice of AutoModeDeferral. */
export interface HeldStepItem {
  toolName: string;
  /** Bounded, secret-scrubbed display form of the exact call. */
  summary: string;
  /** Why Auto declined it, one sentence. */
  reason: string;
  /** The containment route, for the receipt. */
  route: string;
  /** For a redirect: the safe stand-in that already ran. */
  substitute?: string;
}

/** Everything the panel needs to draw itself and to decide what a key means. */
export interface HeldView {
  steps: HeldStepItem[];
  /** Per-step outcome; null = still waiting on the person. */
  outcomes: Array<HeldOutcome | null>;
  /** The highlighted step. Enter runs THIS. */
  selected: number;
  /** True while an approved step is executing; keys other than esc wait. */
  running: boolean;
  /** Columns the pinned region owns. */
  width?: number;
}

/** The index of the next undecided step at or after `from`, or -1. */
export function nextUndecided(outcomes: ReadonlyArray<HeldOutcome | null>, from: number): number {
  for (let i = 0; i < outcomes.length; i++) {
    const at = (from + i) % outcomes.length;
    if (outcomes[at] === null) return at;
  }
  return -1;
}

function outcomeGlyph(outcome: HeldOutcome): string {
  switch (outcome) {
    case "ran":
      return ok(glyph("verified"));
    case "failed":
      return warn(glyph("failure"));
    case "refused":
      return warn(glyph("failure"));
    case "skipped":
      return muted(glyph("observed"));
  }
}

/**
 * The hint line: what the keys do IN THIS STATE. Same budgeted degradation as
 * the question picker — a hint cut mid-word reads as a rendering fault, so
 * what the row gives up on a narrow terminal is chosen, not truncated.
 */
export function heldHint(view: HeldView): string {
  const dot = ` ${glyph("observed")} `;
  const budget = Math.max(12, F.measure(view.width) - F.BODY.length);
  if (view.running) {
    return truncate(`running exactly this${dot}esc  cancel it`, budget);
  }
  const count = view.steps.length;
  // The one hint that must survive any narrowing is the promise itself:
  // "run exactly this". Everything else is a way of reaching what enter
  // already does, so everything else degrades first.
  const hints: Array<{ long: string; short: string; keep: number }> = [
    { long: "enter  run exactly this", short: "enter  run", keep: 5 },
    { long: "s  skip", short: "s  skip", keep: 4 },
    ...(count > 1
      ? [
          { long: `1-${count}  pick`, short: `1-${count}`, keep: 2 },
          { long: "up/down", short: "up/down", keep: 1 },
        ]
      : []),
    { long: "esc  leave rest", short: "esc  leave", keep: 3 },
  ];
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

/** The block above the composer: the promise, the steps, and the hint. */
export function heldLines(view: HeldView): string[] {
  const width = F.measure(view.width);
  const decided = view.outcomes.filter((o) => o !== null).length;
  const lines: string[] = [
    "",
    F.row(
      `${F.MARK}${warn(glyph("selection"))} ${bold(text("held for you"))}  ${faint("outward steps Auto did not take on its own")}`,
      decided > 0 ? faint(`${decided} of ${view.steps.length} decided`) : "",
      width,
    ),
    // The trust line IS the feature: the reason this surface exists is that
    // the old way past a held step was a grant of everything.
    `${F.BODY}${faint("approving runs only that exact call -- nothing broader is granted")}`,
    "",
  ];
  view.steps.forEach((step, index) => {
    const outcome = view.outcomes[index] ?? null;
    const chosen = index === view.selected;
    // MARK + glyph + space is exactly BODY's four cells, so the number column
    // holds still as the selection travels (the ask() rule).
    const gutter = chosen && !view.running ? `${F.MARK}${info(glyph("selection"))} ` : F.BODY;
    const keyCell =
      outcome !== null
        ? outcomeGlyph(outcome)
        : chosen
          ? bold(info(String(index + 1)))
          : info(String(index + 1));
    const paint = outcome !== null ? faint : chosen ? (v: string) => bold(text(v)) : text;
    lines.push(`${gutter}${keyCell}   ${truncate(paint(step.summary), width - 8)}`);
    if (chosen) {
      const detailWidth = width - F.RAIL_IN.length;
      lines.push(`${F.RAIL_IN}${faint(truncate(`${step.reason} [${step.route}]`, detailWidth))}`);
      if (step.substitute) {
        lines.push(
          `${F.RAIL_IN}${faint(truncate(`already ran instead: ${step.substitute}`, detailWidth))}`,
        );
      }
    }
  });
  lines.push("", `${F.BODY}${faint(heldHint(view))}`);
  return lines;
}

/** What a keystroke means while the held panel is open. */
export type HeldAction =
  /** Walk the steps. */
  | { kind: "move"; selected: number }
  /** Run exactly this step. */
  | { kind: "run"; index: number }
  /** Leave this step unrun and move on. */
  | { kind: "skip"; index: number }
  /** Close the panel; every undecided step stays unrun. */
  | { kind: "leave" }
  /** Abort the step that is executing right now. */
  | { kind: "cancel" }
  /** Deliberately nothing. */
  | { kind: "ignore" };

/**
 * The panel's whole state machine. A key may only mean something the hint is
 * currently saying it means: while a step is running, the one live binding is
 * the cancel.
 */
export function heldAction(key: Key, view: HeldView): HeldAction {
  if (view.running) {
    return key.type === "esc" ? { kind: "cancel" } : { kind: "ignore" };
  }
  const count = view.steps.length;
  if (key.type === "up" || key.type === "down") {
    const step = key.type === "down" ? 1 : -1;
    return { kind: "move", selected: (view.selected + step + count) % count };
  }
  // A digit picks AND runs, the same one-keystroke fast path the pickers use.
  // On a decided step it does nothing: a step cannot be un-run, and a stray
  // digit must not re-run one.
  if (key.type === "char" && /^[1-9]$/.test(key.value)) {
    const index = Number(key.value) - 1;
    if (index >= count) return { kind: "ignore" };
    return view.outcomes[index] === null ? { kind: "run", index } : { kind: "ignore" };
  }
  if (key.type === "enter") {
    return view.outcomes[view.selected] === null
      ? { kind: "run", index: view.selected }
      : { kind: "ignore" };
  }
  if (key.type === "char" && (key.value === "s" || key.value === "S")) {
    return view.outcomes[view.selected] === null
      ? { kind: "skip", index: view.selected }
      : { kind: "ignore" };
  }
  if (key.type === "esc") return { kind: "leave" };
  return { kind: "ignore" };
}

/**
 * The transcript record of one decided step — scrollback keeps what was run
 * and what it produced after the panel is gone.
 */
export function heldOutcomeRow(step: HeldStepItem, outcome: HeldOutcome, detail?: string): string {
  const head =
    outcome === "ran"
      ? `${ok(glyph("verified"))} ${text("ran exactly")}`
      : outcome === "failed"
        ? `${warn(glyph("failure"))} ${text("ran and failed")}`
        : outcome === "refused"
          ? `${warn(glyph("failure"))} ${muted("refused")}`
          : `${muted(glyph("observed"))} ${muted("left unrun")}`;
  return F.flowRow(
    `${F.MARK}${head}  ${text(truncate(step.summary, 56))}`,
    detail ? faint(detail) : "",
  );
}

/** The closing receipt: the panel's whole story in one row. */
export function heldCloseReceipt(outcomes: ReadonlyArray<HeldOutcome | null>): string {
  const count = (o: HeldOutcome) => outcomes.filter((x) => x === o).length;
  const ran = count("ran");
  const failed = count("failed");
  const unrun = outcomes.length - ran - failed;
  const mark = ran > 0 && failed === 0 ? ok(glyph("verified")) : muted(glyph("observed"));
  return F.flowRow(
    `${F.MARK}${mark} ${text("held steps")}`,
    faint(
      F.receiptOf([
        ran > 0 ? `${ran} ran` : null,
        failed > 0 ? `${failed} failed` : null,
        unrun > 0 ? `${unrun} left unrun` : null,
      ]),
    ),
  );
}
