// --- Flow: the terminal design system ---
// A coding agent's terminal UI, as it reads under a real pty. One rule underneath
// everything here: never own the screen, own the last four lines. So there are no
// cards, no boxes, no painted surfaces, no logo -- just a fixed reading measure, a
// left rail where work happens, and a right column where the receipt lands.
//
// The whole grammar is five marks:
//
//   > you asked                            the human, at the left margin
//   o the agent answers                    one signal dot, prose beside it
//     | | grep  content_block_stop         work, on a rail under the prose
//     | + src/streaming.ts:42              what that work found
//   > Run this? It touches ~/.cache        a decision, and only a decision
//
// Colour carries meaning, never decoration: teal is identity and location,
// green is added and passed, red is removed and failed, amber asks. Everything
// else is one of three greys. If a value is unknown it is absent -- no row here
// ever pads itself with a reassuring guess.

import { bold, danger, faint, info, muted, ok, quiet, text, warn } from "./theme";
import { glyph } from "./glyphs";
import { termWidth, truncate, visLen, wrap } from "./render";

// --- The grid ---
// Prose sits at column 4 and work rails from the same column, so a tool call
// reads as a continuation of the sentence that introduced it rather than a
// separate panel. The measure is fixed: wide terminals get whitespace, not
// longer lines, because a 200-column sentence is unreadable.

/** Marker column -- `>` and `o` live here. */
/**
 * The frame's margin, and the column every line begins in.
 *
 * It was two columns, and the frame ran to one column short of the window on
 * the right — so the product hugged the edges asymmetrically. That went
 * unnoticed for as long as it was only ever looked at inside Warp, which insets
 * its own pane and was quietly supplying the breathing room. Opened in
 * Terminal.app, which does not, the same build reads as jammed against the
 * glass. A UI should not depend on its host to be legible.
 *
 * Four columns, and the same four on the right — see surfaceWidth().
 */
export const MARK = "  ";
/** Prose/rail column. Everything a marker introduces aligns here. */
export const BODY = "    ";
/** Content inside a rail: past `| `. */
export const RAIL_IN = "      ";

/**
 * The content measure, in columns. Rows that carry *data* -- a path, a diff, a
 * command's output, a receipt -- get this, and it follows the terminal up to a
 * generous ceiling. The ceiling exists only so a right-aligned receipt stays
 * near the row it belongs to; it is not a reading limit, because truncating a
 * path with `...` while half the window sits empty destroys the one thing the row
 * was printed to say.
 *
 * A caller that owns a narrower region (an overlay, a pinned panel) passes its
 * own cap; the measure is a ceiling, never a floor, so nothing renders wider
 * than its host.
 */
export function measure(cap?: number): number {
  // No fixed ceiling. There used to be one at 120 columns, and on an ordinary
  // 80-column terminal it never bound — measure, prose and surface all landed
  // within five columns of each other and the product looked like one column.
  //
  // Open the same session at 241 columns and it became three nested rectangles
  // on one screen: prose wrapping at 84, data rows and their right-aligned
  // receipts stopping at 120, and the chrome spanning the full 240. The frame
  // read as empty on its right half because the rows inside it stopped less
  // than halfway across.
  //
  // The ceiling also contradicted the reason given for it. It existed so a
  // receipt would stay near the row it belongs to — but the same paragraph
  // says truncating a path while half the window sits empty destroys the one
  // thing the row was printed to say, and at 241 columns the ceiling did
  // precisely that. Rows follow the terminal now; prose keeps its own reading
  // limit below, which is the only width here that SHOULD stop early.
  const base = Math.max(40, termWidth() - 2);
  return cap != null ? Math.max(12, Math.min(base, cap)) : base;
}

/**
 * The whole surface, for the structural rules that divide it -- the header's two
 * rules and the hairline above the composer. Chrome is not content: a divider
 * that stops at the reading column leaves the screen looking half-drawn, and
 * the thing it is dividing is the window, not the paragraph.
 */
export function surfaceWidth(): number {
  // Symmetric with MARK: a line starts at MARK and ends MARK short of the
  // window, so the frame is inset by the same amount on both sides. The old
  // single-column right margin also sat one cell from the edge for a reason —
  // a line that touches the last cell wraps, and a wrap desyncs the pinned
  // region's cursor math — and four keeps that safety with room to spare.
  return Math.max(20, termWidth() - MARK.length);
}

/**
 * Columns available to *prose*: the same measure as everything else, less the
 * body indent, so a sentence ends flush with the hairline above it and the
 * rails below it.
 *
 * This used to stop at 88 on the argument that a 120-column sentence is harder
 * to read than an 84-column one -- the eye loses the line on the way back to
 * the left margin. That is true of a book, and it was still the wrong rule
 * here, for two reasons.
 *
 * The first is that prose was the only thing it bound. measure() gave up its
 * own ceiling when the frame was found to be holding three widths at once, so
 * on a 200-column window the header rule, the composer, the work rails and
 * every receipt ran to 192 and past -- and the sentences inside them stopped
 * at 84. Half the window was empty, all of it on one side. That does not read
 * as a chosen reading column; it reads as a pane that failed to fill, which is
 * exactly how it was reported.
 *
 * The second is the composer, which is full width. You type a paragraph across
 * the whole window and it is echoed back in a narrow strip directly beneath
 * the field you typed it into. Whatever the measure is, the same text has to
 * occupy the same width going in and coming out.
 *
 * So: one measure, and the window sets it. A wide terminal is a choice the
 * reader made, and the honest answer to it is to use the room.
 */
export function proseWidth(): number {
  return Math.max(16, measure() - BODY.length);
}

/** Columns available inside a rail (`    | ` is 6 cells) for a row that also
 *  carries a right-aligned receipt. */
export function railWidth(): number {
  return Math.max(12, measure() - RAIL_IN.length);
}

/**
 * Columns available inside a rail for *verbatim* content -- a line of a diff,
 * a line a command actually printed. These rows carry no receipt, so there is
 * nothing to keep near anything, and they take the whole window: a source line
 * cut at `...` is a line the reader cannot check, which defeats the point of
 * showing the evidence at all.
 */
export function verbatimWidth(): number {
  return Math.max(12, Math.max(measure(), termWidth() - 2) - RAIL_IN.length);
}

/**
 * One row of the grid: content on the left, a receipt hard against the right
 * edge of the measure. When the two cannot both fit, the receipt wins and the
 * content truncates -- a metric you cannot read is worse than a clipped path.
 */
/** Fill a chrome row to its budget. A frame whose rows are different lengths is
 *  not a frame — the hairlines above and below would overhang it. Transcript
 *  rows are NOT padded: trailing whitespace on content is noise in a pipe. */
function pad(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visLen(line)));
}

export function row(left: string, right = "", budgetWidth = measure()): string {
  const width = budgetWidth;
  const rightCells = visLen(right);
  const budget = Math.max(4, width - rightCells - (rightCells ? 2 : 0));
  const shown = visLen(left) > budget ? truncate(left, budget) : left;
  if (!rightCells) return shown;
  const gap = Math.max(1, width - visLen(shown) - rightCells);
  return `${shown}${" ".repeat(gap)}${right}`;
}

// --- Header ---

export interface FlowHeader {
  /** Product name, set in the identity colour. */
  name: string;
  /** Version, no `v` prefix -- `gear 0.3.0`. */
  version: string;
  /** Workspace folder name. */
  workspace?: string;
  /** Git branch, when the workspace has one. */
  branch?: string;
  /** Anything else true about the tree right now (`3 files changed`). */
  state?: string;
  /** Model id or label. */
  model?: string;
  /** What the agent may do without asking -- the gear, in words. */
  scope?: string;
  /** The part of `scope` that is a guardrail rather than a permission. */
  caution?: string;
}

/**
 * The identity block: a rule with the name set into it, two lines that say
 * where you are and what the agent is allowed to do, and a closing rule. No
 * mark, no avatar, no wordmark -- the terminal already knows it is a terminal.
 */
/**
 * The header, as one line and a hairline.
 *
 * It used to be six rows: a blank, a full-width rule with the product name
 * inlaid, a location row, a model row, another full-width rule, another blank —
 * before a single word of the session. Two heavy rules and two blanks is a lot
 * of screen spent saying "a program started", and the dashes read as texture
 * rather than as structure.
 *
 * One row carries all of it: who you are talking to, where, on what, in which
 * gear. The mode sits hard against the right edge because it is the one field
 * that changes under you. The hairline beneath is the only chrome, and it marks
 * the boundary the session scrolls away from.
 */
export function header(opts: FlowHeader): string {
  const surface = surfaceWidth();
  // Ordered by how much you need it when the line has to be cut: who and where
  // first, then what it is running on, then the tree's shape. The mode goes
  // hard right on its own, because it is the field that changes under you and
  // the one whose absence would be dangerous rather than merely inconvenient.
  // Only what stays true.
  //
  // This row is committed scrollback: written once and never rewritten, which
  // is what makes history in this UI incapable of developing rendering bugs. It
  // also means everything on it is a record of how the session STARTED. The
  // model and the gear both change mid-session, so naming them here produced a
  // header that confidently stated the wrong model for the rest of the run —
  // and, worse, contradicted the status line one row above the composer, which
  // was right. Under the old alt screen the banner repainted every frame and
  // this never showed; deleting that surface exposed it.
  //
  // Live state lives in the pinned region, which redraws. What is left here is
  // what does not move: who you are talking to, where, and the shape the tree
  // was in when you opened it.
  const left = [
    info(opts.name),
    opts.workspace && text(opts.workspace),
    opts.branch && muted(opts.branch),
    opts.state && muted(opts.state),
  ]
    .filter(Boolean)
    .join(faint(` ${glyph("observed")} `));
  // Just the gear, not its explanation. The caution ("every action asks first")
  // is already spelled out on the status line above the composer, and repeating
  // it here cost more of this row than the dirty-file count it displaced.
  // The gear moves too — shift+tab changes it — so it is not written down
  // here either. The status line above the composer carries it, live.
  const right = "";
  // The indent is paid for out of the row's own budget. Prepending MARK to a
  // row already sized to the full measure pushes the line onto the terminal's
  // last cell, and a line that touches the last cell wraps — which desyncs the
  // relative cursor math for the pinned region below it.
  // Budgeted to the SURFACE, not to the reading column.
  //
  // The header is chrome: it is divided by a hairline that spans the window, so
  // it is budgeted to the surface rather than to the content column. Back when
  // measure() capped at 120, this row parked its mode badge at column 120 while
  // the rule beneath it ran to 164 — a 44-column gap on a wide terminal, which
  // reads as a broken right edge rather than as a deliberate column. Chrome
  // aligns to the window it divides, and no width in this file stops early now.
  //
  // The indent is still paid for out of the row's own budget: prepending MARK
  // to a row already sized to the full surface pushes the line onto the
  // terminal's last cell, and a line that touches the last cell wraps — which
  // desyncs the relative cursor math for the pinned region below it.
  // The top of the frame: an identity row and the rule that closes it.
  //
  // The rule belongs here. Without it the header is just another line of text
  // above the transcript and stops reading as chrome at all. What it must NOT
  // do is collide with the composer's own top rule on a fresh session, where
  // there is no transcript between them — that is solved at the other end, by
  // the composer carrying a blank line above itself, so the two rules can
  // never end up on adjacent rows however empty the session is.
  return [
    "",
    `${MARK}${pad(row(left, right, surface - MARK.length), surface - MARK.length)}`,
    hairline(surface),
  ].join("\n");
}

/**
 * The one piece of chrome in the product — and it begins where the content
 * begins.
 *
 * Every rule in this codebase used to start at column 0 while every line of
 * content started at column 2, so each hairline overhung its own block by two
 * characters on the left. The right edges agreed; the left edges never did.
 * That is what made the frame look ragged no matter how carefully the right
 * side was measured, and it was invisible for as long as rules were drawn with
 * repeated dashes — a dashed line's ragged start reads as texture. Drawn as a
 * continuous hairline it reads as exactly what it is: a misalignment.
 *
 * A rule spans MARK..width, the same span as the row above it.
 */
export function hairline(width = surfaceWidth()): string {
  return `${MARK}${faint(glyph("rule").repeat(Math.max(1, width - MARK.length)))}`;
}

/** What the agent may do, and where that stops -- one amber clause, because
 *  this is the only line in the header that governs your machine. */
function scopeClause(opts: FlowHeader): string | undefined {
  const clause = [opts.scope, opts.caution && `-- ${opts.caution}`].filter(Boolean).join(" ");
  return clause ? warn(clause) : undefined;
}

/** A middot-joined meta line under the header rule, or nothing when empty. */
function place(parts: Array<string | undefined | false>, width: number): string[] {
  const shown = parts.filter((part): part is string => Boolean(part));
  if (shown.length === 0) return [];
  return [`${MARK}${truncate(shown.join(faint(` ${glyph("observed")} `)), width - MARK.length)}`];
}

// --- Turn markers ---

/** Paste chips carried inside an echoed message. They are attachments, not
 *  words, so they are painted apart from the sentence: the eye steps over them
 *  while reading and can still find them when the question is what was
 *  attached. Kept in sync with pasteChip() in ./paste.ts. */
const ECHO_CHIP = /\[Pasted text #\d+ \+\d+ (?:lines|chars)\]/g;

/** One line of the echo: the sentence recedes, its attachments recede further. */
function echoed(part: string): string {
  let out = "";
  let last = 0;
  for (const match of part.matchAll(ECHO_CHIP)) {
    const at = match.index ?? 0;
    if (at > last) out += quiet(part.slice(last, at));
    out += faint(match[0]);
    last = at + match[0].length;
  }
  if (last === 0) return quiet(part);
  return last < part.length ? out + quiet(part.slice(last)) : out;
}

/**
 * What you asked, at the left margin.
 *
 * This used to be set in full body text, on the argument that the message is
 * the strongest landmark in scrollback precisely because nothing decorates it.
 * Half of that is right and the half that is wrong made the transcript tiring:
 * "findable when you scan back" and "brightest when you read forward" are
 * different properties, and only the first one is what a landmark needs. You
 * already know what you typed. The sentence you came back for is the answer,
 * and it was competing with your own words at identical weight.
 *
 * So the emphasis moves from AREA to POINT: the whole block steps back to the
 * muted slot, and the marker -- one cell -- takes the identity pigment. That is
 * quieter to sit in front of for an hour and easier to find when scrolling,
 * because a dim paragraph under a coloured pip is a landmark and a bright
 * paragraph among bright paragraphs is not.
 *
 * It steps back to `quiet`, never to `faint`: see the note on quiet() in
 * ./theme.ts for why the obvious call would have shipped a 2:1 block.
 */
export function asked(body: string): string {
  const lines: string[] = [""];
  let first = true;
  for (const source of body.replace(/\r\n/g, "\n").split("\n")) {
    for (const part of wrap(source, proseWidth())) {
      lines.push(
        first ? `${MARK}${info(glyph("selection"))} ${echoed(part)}` : `${BODY}${echoed(part)}`,
      );
      first = false;
    }
  }
  return lines.join("\n");
}

/**
 * Put the agent's dot on an already-rendered block -- Markdown that has been
 * laid out at the body indent, so lists and inline code survive. The dot
 * replaces the first line's indent rather than being prepended to it, which is
 * what keeps every continuation aligned under the prose.
 */
export function dot(lines: string[]): string[] {
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return lines;
  return lines.map((line, index) =>
    index === first && line.startsWith(BODY)
      ? `${MARK}${info(glyph("live"))} ${line.slice(BODY.length)}`
      : line,
  );
}

/** The agent's voice: one dot, then prose. Continuations align under the prose. */
export function said(body: string, paint: (v: string) => string = text): string {
  const lines: string[] = [];
  let first = true;
  for (const source of body.replace(/\r\n/g, "\n").split("\n")) {
    if (!source.trim()) {
      if (!first) lines.push("");
      continue;
    }
    for (const part of wrap(source, proseWidth())) {
      lines.push(first ? `${MARK}${info(glyph("live"))} ${paint(part)}` : `${BODY}${paint(part)}`);
      first = false;
    }
  }
  return lines.join("\n");
}

// --- Work rails ---

export type Status = "ok" | "pass" | "fail" | "active" | "none";

/**
 * The status column, ordered by how much attention each mark is allowed to ask
 * for. `ok` is the default and says only *this happened*: a faint middot, no
 * verdict. A file that was read is not news -- reads almost always succeed -- and
 * a rail that awards a green tick to fifteen routine calls has spent the tick
 * before it reaches the one that mattered. What the reader actually wants from
 * a finished call is on the other side of the row: `120 lines`, `4 files`,
 * `2.6s`. Neutralising the mark is what lets the eye travel there.
 *
 * `pass` is the green tick, and it is spent only where something was genuinely
 * checked -- a test run, a typecheck, a build. `fail` is the single mark allowed
 * to interrupt. Every glyph occupies one cell, `none` included, so the verb
 * column holds whether or not a row carries a mark.
 */
const STATUS_GLYPH: Record<Status, string> = {
  ok: glyph("observed"),
  pass: glyph("verified"),
  fail: glyph("failure"),
  active: glyph("selection"),
  none: " ",
};

/** The rail cell -- a hairline under the prose, marking work rather than boxing it. */
function rail(): string {
  return `${BODY}${faint(glyph("gutter"))} `;
}

export interface ToolRow {
  /** `grep`, `read`, `edit`, `run` -- a verb short enough to scan, not a tool id. */
  name: string;
  /** What it acted on: a pattern, a path, a command. */
  arg?: string;
  /** The receipt, right-aligned: `4 files`, `+6 -1 | 1 hunk`, `2.6s`. */
  metric?: string;
  /** How the call ended. `ok` (the default) is a neutral "this happened";
   *  `pass` is reserved for work that verified something. Edits use `none`:
   *  the diff below is the evidence, and it does not need a mark to vouch for
   *  it. */
  status?: Status;
  /** Paints the argument -- teal when it names a file the agent is changing. */
  argTone?: "muted" | "path";
}

/** A receipt that already carries colour keeps it; a plain one reads secondary. */
function paintMetric(metric?: string): string {
  if (!metric) return "";
  return metric.includes("\x1b") ? metric : muted(metric);
}

/**
 * One unit of work: `| | grep  content_block_stop            4 files`.
 * The name is padded to a stable column so a run of calls reads as a table
 * without ever drawing one.
 */
export function toolRow(v: ToolRow): string {
  const status = v.status ?? "ok";
  const mark =
    status === "ok"
      ? `${faint(STATUS_GLYPH.ok)} `
      : status === "pass"
        ? `${ok(STATUS_GLYPH.pass)} `
        : status === "fail"
          ? `${danger(STATUS_GLYPH.fail)} `
          : status === "active"
            ? `${info(STATUS_GLYPH.active)} `
            : `${STATUS_GLYPH.none} `;
  const name = text(v.name.padEnd(4));
  const arg = v.arg ? `  ${(v.argTone === "path" ? info : muted)(v.arg)}` : "";
  return row(`${rail()}${mark}${name}${arg}`, paintMetric(v.metric));
}

/**
 * What the work found, one line, under its call: `| + src/streaming.ts:42`.
 * Tinted only when the outcome itself is the news (a failure).
 */
export function toolNote(detail: string, tone: "muted" | "fail" | "ok" = "muted"): string {
  const paint = tone === "fail" ? danger : tone === "ok" ? text : muted;
  const branch = tone === "fail" ? danger(glyph("gutter")) : faint(glyph("gutter"));
  return `${rail()}${branch} ${truncate(paint(detail), railWidth() - 2)}`;
}

/** A plain continuation row on the rail, already painted by the caller. */
export function railRow(content: string): string {
  return `${rail()}${content}`;
}

// --- Diffs ---

export interface DiffRow {
  kind: "add" | "remove" | "context" | "elide";
  line?: number;
  text: string;
}

/**
 * A hunk as it actually reads: a line-number gutter, one sign column, and the
 * source's own indentation preserved. Added lines are green, removed red,
 * context grey -- no background wash, because a wash makes code harder to read,
 * not easier.
 */
export function diffRows(rows: DiffRow[]): string[] {
  const codeWidth = Math.max(8, verbatimWidth() - 8);
  return rows.map((r) => {
    if (r.kind === "elide") return `${rail()}   ${faint(`${glyph("elision")} ${r.text}`)}`;
    const number = faint(String(r.line ?? "").padStart(4));
    const body = truncate(r.text, codeWidth);
    if (r.kind === "add") return `${rail()}${number} ${ok("+")} ${ok(body)}`;
    if (r.kind === "remove") return `${rail()}${number} ${danger("-")} ${danger(body)}`;
    return `${rail()}${number}   ${muted(body)}`;
  });
}

/** Parse a unified diff into flow rows, keeping real line numbers. */
export function parseDiff(
  raw: string,
  limit = 40,
): { rows: DiffRow[]; added: number; removed: number; hunks: number } {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  let dropped = 0;
  for (const source of raw.split("\n")) {
    if (source.startsWith("--- ") || source.startsWith("+++ ")) continue;
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(source);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunks++;
      if (hunks > 1 && rows.length < limit) rows.push({ kind: "elide", text: "unchanged lines" });
      continue;
    }
    const kind = source.startsWith("+")
      ? "add"
      : source.startsWith("-")
        ? "remove"
        : ("context" as const);
    if (kind === "add") added++;
    if (kind === "remove") removed++;
    const number = kind === "add" ? newLine++ : kind === "remove" ? oldLine++ : newLine++;
    if (kind === "context") oldLine++;
    if (rows.length >= limit) {
      dropped++;
      continue;
    }
    rows.push({ kind, line: number, text: kind === "context" ? source.slice(1) : source.slice(1) });
  }
  if (dropped > 0) rows.push({ kind: "elide", text: `${dropped} more diff lines` });
  return { rows, added, removed, hunks };
}

/** The receipt for an edit: `+6 -1 | 1 hunk`, or `+14 | new file`. The counts
 *  carry their own meaning, so they carry their own colour. */
export function editMetric(added: number, removed: number, note = ""): string {
  const counts = [added > 0 ? ok(`+${added}`) : "", removed > 0 ? danger(`-${removed}`) : ""]
    .filter(Boolean)
    .join(" ");
  return [counts || muted("no change"), note ? muted(note) : ""].filter(Boolean).join(muted(" | "));
}

// --- Command output ---

/**
 * A command's real output, kept whole in its own rail: `+ the command`, the
 * bytes it printed, `+ what happened`. The rail sits in the same column as the
 * work above it, so output reads as the continuation of the call rather than a
 * new region of the screen.
 */
export function outputRail(
  command: string,
  body: string[],
  summary?: string,
  failed = false,
): string[] {
  const width = verbatimWidth();
  const lines = [`${BODY}${faint(glyph("gutter"))} ${muted(truncate(command, width))}`];
  for (const source of body) {
    lines.push(
      `${BODY}${faint(glyph("gutter"))} ${muted(truncate(source.replace(/\t/g, "  "), width))}`,
    );
  }
  if (summary) {
    const edge = failed ? danger : faint;
    lines.push(
      `${BODY}${edge(glyph("gutter"))} ${(failed ? danger : text)(truncate(summary, width))}`,
    );
  }
  return lines;
}

/** Keep the head and tail of a long output; say exactly what was dropped. */
export function clip(lines: string[], head = 22, tail = 8): string[] {
  if (lines.length <= head + tail + 1) return lines;
  const hidden = lines.length - head - tail;
  return [...lines.slice(0, head), `${glyph("elision")} ${hidden} lines`, ...lines.slice(-tail)];
}

// --- Checklists ---

export interface CheckItem {
  status: Status;
  label: string;
  /** Right-aligned per row: `+9 -1`, or why a row is `x`. */
  metric?: string;
  metricTone?: "muted" | "ok" | "fail";
}

export interface ChecklistOpts {
  /** A second word on the head row: `changed  4 files`. */
  caption?: string;
  /** The head receipt. Defaults to `done/total`; pass it when the ratio the
   *  reader cares about is coverage rather than completion. */
  receipt?: string;
  /** Plan steps read quietly; changed files read as the news. */
  tone?: "text" | "muted";
}

/**
 * A plan, or the set of files a turn touched: a labelled rail with a receipt,
 * then one row per item. A `x` row states its reason instead of disappearing --
 * work that did not happen is still information.
 */
export function checklist(label: string, items: CheckItem[], opts: ChecklistOpts = {}): string[] {
  const done = items.filter((i) => i.status === "ok" || i.status === "pass").length;
  const paintLabel = opts.tone === "muted" ? muted : text;
  const head = row(
    `${rail()}${text(label)}${opts.caption ? `  ${muted(opts.caption)}` : ""}`,
    paintMetric(opts.receipt ?? `${done}/${items.length}`),
  );
  return [
    head,
    ...items.map((item) => {
      // A checklist item is not a tool call: a plan step marked done is a real
      // milestone someone chose to close, so here the tick keeps its green.
      const mark =
        item.status === "ok" || item.status === "pass"
          ? ok(STATUS_GLYPH.pass)
          : item.status === "fail"
            ? danger(STATUS_GLYPH.fail)
            : item.status === "active"
              ? info(STATUS_GLYPH.active)
              : faint("o");
      const tone = item.metricTone === "ok" ? ok : item.metricTone === "fail" ? danger : muted;
      const metric =
        item.metric && item.metric.includes("\x1b")
          ? item.metric
          : item.metric && tone(item.metric);
      return row(
        `${rail()}${mark} ${(item.status === "active" ? text : paintLabel)(item.label)}`,
        metric || "",
      );
    }),
  ];
}

// --- Decisions ---

export interface AskBlock {
  /** The question, in one sentence, stating what is at stake. */
  question: string;
  /** The exact thing that would run -- never a paraphrase. */
  command?: string;
  /** Pre-painted evidence rows (a located diff) when the proposal is not a
   *  command. Rendered exactly as given, under the question. */
  evidence?: string[];
  /** Real consequences, computed: `deletes 1.2 GB outside the repo | ~90s`. */
  impact?: string;
  /** The one line that cannot be walked back, if there is one. */
  irreversible?: string;
  /** Numbered choices, in the order a person would consider them. */
  options: string[];
  /** Highlighted choice (0-based), when the surface has a cursor. */
  selected?: number;
  /** What Escape does -- always shown, always the safe default. */
  escape?: string;
  /** Columns the host region owns, when it is narrower than the measure. */
  width?: number;
  /**
   * Who is asking. `caution` is the permission broker asking to touch your
   * machine and wears the amber mark. `question` is the agent asking about the
   * WORK -- a product fork it cannot resolve by reading the code -- and wears
   * the identity colour, because nothing is at stake but the answer.
   */
  tone?: "caution" | "question";
  /**
   * True while the person is composing an answer in their own words instead of
   * picking one. The choices dim and the marker leaves them: the list is no
   * longer what Enter commits, and that has to be visible at the instant it
   * stops being true -- otherwise the same keystroke means two things and the
   * surface feels like it is guessing.
   */
  answering?: boolean;
  /** Where this sits in a round of several. Right-aligned: `2 of 4`. */
  progress?: string;
  /** Replaces the escape line with what the keys do in the CURRENT state. */
  hint?: string;
}

/**
 * The approval prompt. It reads as a question with answers, not a dialog with
 * buttons: the caution mark, the literal command on an amber rail, what it
 * costs, then numbered choices. Escape is listed as the default because the
 * safe answer should be the one your hands already know.
 */
export function ask(block: AskBlock): string[] {
  const width = measure(block.width);
  const rail = Math.max(12, width - RAIL_IN.length);
  // The caution mark stays the chevron: `> Run this?` is this product's
  // established grammar for the broker asking to touch your machine.
  //
  // A question about the WORK gets the diamond instead, and not for variety.
  // The chevron is also the cursor -- the composer's, the palette's, and now
  // the highlighted choice's -- so an agent's question drawn with one put two
  // identical marks in the same column two rows apart, where the top one is a
  // heading and the bottom one is where your hands are. The diamond is a fork
  // in the road, which is exactly what the row is.
  const mark = block.tone === "question" ? info(glyph("phase")) : warn(glyph("selection"));
  const lines: string[] = [
    "",
    // The round's position rides the right edge, where every other receipt in
    // this UI lives. A person answering four questions in a row needs to know
    // there are four; without it each one arrives as an unrelated interruption.
    row(
      `${MARK}${mark} ${bold(text(truncate(block.question, width - 4)))}`,
      block.progress ? faint(block.progress) : "",
      width,
    ),
  ];
  if (block.command) {
    lines.push("");
    for (const part of wrap(block.command, rail)) {
      lines.push(`${BODY}${warn(glyph("gutter"))} ${text(part)}`);
    }
  } else if (block.evidence?.length) {
    lines.push("", ...block.evidence);
  }
  if (block.impact || block.irreversible) lines.push("");
  // Consequences wrap; they never truncate. A clipped risk statement is worse
  // than no risk statement, because it reads as if it were the whole story.
  if (block.impact) {
    for (const part of wrap(block.impact, width - BODY.length)) lines.push(`${BODY}${muted(part)}`);
  }
  if (block.irreversible) {
    for (const part of wrap(block.irreversible, width - BODY.length)) {
      lines.push(`${BODY}${warn(part)}`);
    }
  }
  lines.push("");
  const answering = block.answering === true;
  block.options.forEach((option, index) => {
    const chosen = !answering && index === block.selected;
    // The marker is paid for out of the body indent, never prepended to it:
    // MARK + glyph + space is exactly BODY's four cells, so the number column
    // holds still as the selection travels. A list that shifts sideways under
    // the eye is the single cheapest way to make a picker feel unsteady.
    const gutter = chosen ? `${MARK}${info(glyph("selection"))} ` : BODY;
    const key = String(index + 1);
    const paint = chosen ? (v: string) => bold(text(v)) : answering ? faint : text;
    const number = chosen ? bold(info(key)) : answering ? faint(key) : info(key);
    lines.push(`${gutter}${number}   ${truncate(paint(option), width - 8)}`);
  });
  // Truncated like every other row: a hint that wraps costs more than the
  // binding it failed to mention, because the wrap desyncs the pinned region.
  lines.push(
    `${BODY}${faint(truncate(block.hint ?? `esc ${block.escape ?? "cancel"}  (default)`, width - BODY.length))}`,
  );
  return lines;
}

/** How many lines `ask()` puts after the last option -- the hint row. */
export const ASK_TRAILING_ROWS = 1;

/** The answer, echoed back so scrollback records what was decided. */
export function answered(index: number, label: string): string {
  return `\n${MARK}${info(glyph("selection"))} ${info(String(index + 1))}   ${text(label)}`;
}

// --- Notes ---

/**
 * Something the turn could not do, or chose not to: a mark, a sentence, and --
 * when there is one -- the exact command that would resolve it. Never a warning
 * without a way out.
 */
export function note(
  headline: string,
  body?: string,
  next?: { verb: string; command: string },
  tone: "fail" | "warn" | "ok" = "warn",
): string[] {
  const paint = tone === "fail" ? danger : tone === "ok" ? ok : warn;
  const mark = tone === "fail" ? glyph("failure") : tone === "ok" ? glyph("verified") : "!";
  const lines = ["", `${MARK}${paint(mark)} ${bold(text(truncate(headline, measure() - 4)))}`];
  if (body) {
    lines.push("");
    for (const part of wrap(body, proseWidth())) lines.push(`${BODY}${text(part)}`);
  }
  if (next) {
    lines.push("");
    lines.push(
      `${BODY}${info("->")} ${muted(next.verb)}  ${text(truncate(next.command, proseWidth() - 8))}`,
    );
  }
  return lines;
}

/**
 * A short shell recipe the reader can run themselves: a quiet label, then the
 * commands with their comments intact. Comments stay grey and commands stay
 * bright, because the command is the part you copy.
 */
export function recipe(label: string, script: string): string[] {
  const lines = ["", `${MARK}${muted(label)}  ${faint("sh")}`];
  for (const source of script.split("\n")) {
    if (!source.trim()) {
      lines.push("");
      continue;
    }
    const paint = source.trimStart().startsWith("#") ? muted : text;
    lines.push(`${BODY}${paint(truncate(source, proseWidth()))}`);
  }
  return lines;
}
