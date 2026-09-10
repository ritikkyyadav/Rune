// --- Flow: the terminal design system ---
// A coding agent's terminal UI, as it reads under a real pty. One rule underneath
// everything here: never own the screen, own the last four lines. So there are no
// cards, no boxes, no painted grounds, no logo -- just a fixed reading measure, a
// left rail where work happens, and one left edge that nothing escapes. (Two
// MARKS carry a background where the theme knows its ground -- the caret, and
// the diff evidence bands; see theme.ts for why a mark is not ground.)
//
// Nothing in the transcript right-aligns. A receipt sits two spaces after the
// thing it is a receipt for, because at 240 columns a path and its metric a
// hundred and fifty columns apart stop reading as one row. `row` still pads to
// the far margin and is for CHROME only -- the header frame. Content uses
// `flowRow`. See tests/unit/orchestrator/ui-grammar.test.ts, which enforces it.
//
// The whole grammar is five marks:
//
//   > you asked                       the human, at the left margin
//   o the agent answers               one signal dot, prose beside it
//     | | grep  content_block_stop  4 files    work, on a rail under the prose
//     | + src/streaming.ts:42                  what that work found
//   > Run this? It touches ~/.cache           a decision, and only a decision
//
// Colour carries meaning, never decoration: teal is identity and location,
// green is added and passed, red is removed and failed, amber asks. Everything
// else is one of three greys. If a value is unknown it is absent -- no row here
// ever pads itself with a reassuring guess.

import {
  bandsEnabled,
  bold,
  danger,
  faint,
  info,
  muted,
  negativeSurface,
  bandInk,
  bandPalette,
  ok,
  positiveSurface,
  quiet,
  speakerSurface,
  text,
  warn,
} from "./theme";
import { glyph } from "./glyphs";
import { paintCode, type CodeLang } from "./code-paint";
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
 *  carries an inline receipt. */
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
export function row(left: string, right = "", budgetWidth = measure()): string {
  const width = budgetWidth;
  const rightCells = visLen(right);
  const budget = Math.max(4, width - rightCells - (rightCells ? 2 : 0));
  const shown = visLen(left) > budget ? truncate(left, budget) : left;
  if (!rightCells) return shown;
  const gap = Math.max(1, width - visLen(shown) - rightCells);
  return `${shown}${" ".repeat(gap)}${right}`;
}

/**
 * A transcript row: content, then what it produced, one flowing line.
 *
 * This is `row`'s counterpart and the difference between them is the difference
 * between chrome and content. `row` pushes its right half against the far edge,
 * which is correct for a frame -- the header's gear badge marks the boundary of
 * a structure. It was wrong for everything else, for two reasons that turned
 * out to be the same reason.
 *
 * The first is distance. On a wide terminal `read src/streaming.ts` and
 * `319 lines` ended up a hundred and fifty columns apart, and two things that
 * far apart do not read as one row -- they read as two columns of two different
 * reports, which is exactly the complaint.
 *
 * The second is that only some of the screen obeyed it. The live rung, the
 * read-back and the composer blocks each hand-built their own left-flowing
 * layout, so watching a turn meant watching a left-flowing line become a
 * right-aligned one, once per row, forever.
 *
 * So: one edge. Nothing in the transcript travels to the right margin, and a
 * receipt sits two spaces after the thing it is a receipt for, where the eye
 * already is. There is no column to disagree about.
 */
export function flowRow(left: string, receipt = "", budgetWidth = measure()): string {
  // The budget binds whether or not there is a receipt. Returning `left`
  // untouched when the receipt was empty let a long path run past the window on
  // a narrow terminal -- `row` had always truncated it, and dropping that on
  // the way past was a regression, not a simplification.
  const joined = visLen(receipt) ? `${left}  ${receipt}` : left;
  if (visLen(joined) <= budgetWidth) return joined;
  // On overflow the ARGUMENT gives way, never the receipt.
  //
  // Truncating the joined row cut from the right, and the right is where the
  // outcome lives: on an 80-column window a long path ate its own result and
  // the rail filled up with rows ending `0…`, `4 fil…`, `+208 | 1 hu…`. A row
  // whose receipt is gone has reported nothing -- the path was already visible
  // in the call above it. So the left side is cut to make room and the receipt
  // is set down whole, as long as it is small enough to leave the row a
  // readable left half; a receipt wider than that is not a receipt, and the
  // old whole-row truncation still applies to it.
  const receiptWidth = visLen(receipt);
  const room = budgetWidth - receiptWidth - 2;
  if (receiptWidth === 0 || room < Math.min(24, Math.floor(budgetWidth / 3))) {
    return truncate(joined, budgetWidth);
  }
  return `${truncate(left, room)}  ${receipt}`;
}

/**
 * A key legend: the key, then what it does, pairs separated the same way
 * receipt parts are. The footer had this idiom and the read-back invented its
 * own with five-space gaps, which is how a legend starts looking like a padded
 * table. One definition, used by both.
 */
export function keyHint(key: string, word: string): string {
  return `${muted(key)} ${faint(word)}`;
}

export function keyLegend(pairs: Array<[string, string]>): string {
  return pairs.map(([key, word]) => keyHint(key, word)).join("  ");
}

/** Receipt parts as one phrase. Facts about the same row, so they are separated
 *  rather than punctuated -- the marker is from the closed glyph set. */
export function receiptOf(parts: Array<string | undefined | null>): string {
  const kept = parts.filter((p): p is string => !!p && visLen(p) > 0);
  return kept.join(` ${glyph("observed")} `);
}

// --- Header ---

export interface FlowHeader {
  /** Product name. Set as the wordmark -- letterspaced, in the identity colour. */
  name: string;
  /** CLI version. Rendered `v0.3.0`, hard against the right edge. */
  version: string;
  /** Where you are: the whole directory coordinate, `~`-shortened by the caller.
   *  Not the folder name -- two sessions in `web` and `api` under different
   *  projects produced identical headers, which is the one question a location
   *  field exists to answer. */
  workspace?: string;
  /** The branch a LINKED git worktree is checked out on. Absent in the main
   *  checkout, which is the point: the row says nothing until you are somewhere
   *  that can surprise you. */
  worktree?: string;
}

// --- The masthead ---
//
// One row, and the name on it is set as a MARK rather than as a word.
//
// A terminal has no type family to switch to, no weight axis, and no size: the
// only typographic instruments in the box are TRACKING, CASE, WEIGHT and
// COLOUR. So the wordmark is built from all four -- letterspaced, capitalised,
// bold, in the identity pigment -- which is what separates a logotype from the
// first word of a sentence. `rune · evolab4` read as a breadcrumb because it
// used exactly one of the four; `G E A R` cannot be mistaken for running text.
//
// This is still not artwork. The old rule here -- no mark, no avatar, no
// wordmark, because a terminal that opens with a picture has spent its first
// screen on itself -- was about ARTWORK, and it survives: nothing below draws a
// glyph the product did not already own, and the whole masthead is one row
// tall, the same row it has always been.

/**
 * The wordmark: letterspaced caps, knocked out of a filled chip.
 *
 * Tracking and case do the logotype half of the work -- one cell between
 * letters, which costs three columns and buys the entire difference between a
 * name and a mark. WEIGHT is the half a terminal will not sell you: `SGR 1` is
 * a request, and a host with no bold face answers it with nothing, which is
 * exactly what this row looked like. So the mark is reversed out of the
 * identity colour instead (see theme.heavy) -- the one operation that makes a
 * stroke genuinely heavier, because the cell stops being paper and becomes ink.
 *
 * The two padding cells are part of the mark: a chip that starts flush against
 * its first letter reads as a highlight, not a lockup.
 *
 * It is still one row tall. That ceiling is the whole constraint -- a mark that
 * needs a second row has stopped being a name in a header and become a splash
 * screen.
 *
 * Returns the painted string with the number of CELLS it occupies, because the
 * rule underneath changes weight at exactly that column and a caller cannot
 * measure a painted string without stripping it again.
 */
export function lockup(name: string): { text: string; cells: number } {
  // The wordmark IS the logo: the name, set the way Savoir sets its letters --
  // bold, WHITE, wide-tracked (a space between each letter) -- and nothing else.
  // No gear, no chip. Clean type is the mark. The blue lives in the seam rule
  // beneath it and in the one accent the grammar uses, not in the wordmark.
  const letters = name.toUpperCase().split("").join(" ");
  return { text: bold(text(letters)), cells: visLen(letters) };
}

/** The build, for the far right of a masthead. Quiet: it is the least urgent
 *  thing on the row and the only one you go looking for rather than read. */
export function versionTag(version: string): string {
  return quiet(`v${version}`);
}

/** The gap that does the dividing. A vertical bar sat here while the row still
 *  carried four fields and needed a seam drawn for it; with one field left, the
 *  wordmark's own tracking already separates it and the bar was one mark more
 *  than the row was saying. */
const LOCKUP_GAP = "  ";

/**
 * The header: a masthead and the rule that carries it.
 *
 * It used to be six rows -- a blank, a full-width rule with the name inlaid, a
 * location row, a model row, another rule, another blank -- before a single
 * word of the session. That collapsed to one row, correctly, and then stayed
 * flat: name, dot, folder, dot, branch, dot, counts -- every field the same
 * size, the same weight and very nearly the same grey. One row is right. One
 * row of undifferentiated text is a breadcrumb, and that is what it was
 * reported as.
 *
 * Three things, and the row is read left to right in exactly that order:
 *
 *   WHO    the letterspaced wordmark, in the identity pigment, bold.
 *   WHERE  the whole directory coordinate -- and, only when the checkout is a
 *          linked git worktree, which branch that worktree is on.
 *   WHICH  the build, hard against the right edge.
 *
 * ...and the rule beneath is drawn in two tones that change under the last cell
 * of the wordmark, so the mark sits on something instead of merely starting a
 * line. It costs nothing: the rule was already being drawn, in one colour, on
 * that exact row.
 *
 * Nothing else is here, and the deletions are the design. The dirty-file count,
 * the MCP count and `sandbox off` all moved out because the status line above
 * the composer already carries the live ones -- a fact stated twice is a fact
 * you stop reading, and the header's copy was the stale one. This row is
 * committed scrollback under --inline: written once, never rewritten. Every
 * field left on it is immutable for the life of the session by construction,
 * which is the only reason it can be trusted at hour four.
 */
export function header(opts: FlowHeader): string {
  // Budgeted to the SURFACE, not to the reading column. The header is chrome:
  // it is divided by a rule that spans the window, so it aligns to the window
  // it divides. Back when measure() capped at 120 this row stopped at column
  // 120 while its rule ran to 164 -- a 44-column gap that reads as a broken
  // right edge rather than as a chosen column.
  const surface = surfaceWidth();
  // The indent is paid for out of the row's own budget. Prepending MARK to a
  // row already sized to the full measure pushes the line onto the terminal's
  // last cell, and a line that touches the last cell wraps -- which desyncs the
  // relative cursor math for the pinned region below it.
  const budget = surface - MARK.length;

  const mark = lockup(opts.name);
  const version = versionTag(opts.version);

  // What is left after the two fixed ends have taken their columns: the
  // wordmark and its gap on the left, the version and the two-space minimum
  // that keeps it from touching the location on the right. The brand gear is
  // NOT here -- it is drawn full-size in the opening masthead (renderMasthead),
  // and a one-cell glyph pretending to be it in the pinned row only read as a
  // dot. The pinned header stays a clean wordmark; the masthead carries the mark.
  const room = Math.max(8, budget - mark.cells - LOCKUP_GAP.length - visLen(version) - 2);
  const SEP = ` ${glyph("observed")} `;

  // The path is served first, and it is served a FLOOR rather than a share.
  //
  // Letting the clause take what it wanted produced the worst row of the set on
  // a narrow window -- `…ream-wt · worktree fix/stream`, in which the branch is
  // spelled out twice and the folder you are standing in has been reduced to
  // three letters of its own name. The location field exists to answer "where
  // am I". Whatever else the row gives up, it keeps enough columns to name the
  // directory you are in.
  const floor = opts.workspace ? Math.min(room, tailSegment(opts.workspace).length) : 0;

  // What the worktree clause may spend, and how it shortens. The branch is the
  // qualifier; the word is the warning -- so the branch goes first and the word
  // survives on any window that can hold it at all.
  const forClause = room - floor - SEP.length;
  const full = opts.worktree ? `worktree ${opts.worktree}` : "";
  const clause = full.length <= forClause ? full : "worktree".length <= forClause ? "worktree" : "";

  const path = opts.workspace
    ? pathTail(opts.workspace, room - (clause ? clause.length + SEP.length : 0))
    : "";
  const location = [path && text(path), clause && quiet(clause)].filter(Boolean).join(faint(SEP));

  return [
    "",
    `${MARK}${row(`${mark.text}${location ? LOCKUP_GAP + location : ""}`, version, budget)}`,
    seamRule(surface, mark.cells),
  ].join("\n");
}

/**
 * A path cut to fit, from the LEFT.
 *
 * Every other truncation in this file drops the tail, which is right for prose
 * and wrong for a path: `~/Project/Alan/packages/orchestr…` has spent thirty
 * columns to tell you nothing you did not already know, while the segment that
 * says where you actually are is the one it threw away. So the head goes and
 * the tail stays, marked with the alphabet's elision.
 */
export function pathTail(p: string, max: number): string {
  if (max <= 1) return "";
  if (p.length <= max) return p;
  const mark = glyph("elision");
  const room = max - mark.length;
  // Cut on a separator: `…/src/bin/ui` reads as a path, `…rc/bin/ui` reads as a
  // word that lost its beginning. Take whole segments from the end until the
  // next one will not fit.
  const segments = p.split("/");
  let tail = "";
  for (let i = segments.length - 1; i > 0; i--) {
    const next = `/${segments[i]}${tail}`;
    if (next.length > room) break;
    tail = next;
  }
  // Not even one whole segment fits. Keep its end, which is still the half that
  // identifies it -- `…-stabilize` over `…rune/phase`.
  return `${mark}${tail || p.slice(-room)}`;
}

/** The last segment with its separator (`/evolab4`), plus the elision that
 *  would precede it -- the shortest form of a path that still names a place,
 *  and therefore the floor the location field is guaranteed. */
function tailSegment(p: string): string {
  const last = p.split("/").filter(Boolean).at(-1) ?? p;
  return `${glyph("elision")}/${last}`;
}

/**
 * The rule the masthead stands on: heavy and in the identity colour under the
 * mark, a hairline for the rest of the window. `lead` is measured in cells from
 * the left margin, so a caller that knows where its seam is does not have to
 * know how the rule is drawn.
 *
 * Same span and same total width as hairline(). The weight change is the point:
 * a chip sitting on a hairline floats, and the bar under it is what makes the
 * two read as one lockup rather than as a label with a line beneath it.
 */
export function seamRule(width = surfaceWidth(), lead = 0): string {
  const inner = Math.max(1, width - MARK.length);
  const identity = Math.max(0, Math.min(inner, lead));
  const rest = inner - identity;
  return `${MARK}${info(glyph("ruleHeavy").repeat(identity))}${faint(glyph("rule").repeat(rest))}`;
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

// --- Turn markers ---

/**
 * What you asked, on a speaker band.
 *
 * The distinction the whole grammar now turns on: the person's words carry a
 * monochrome inverse band -- a white block in dark mode, a black block in light
 * -- and the agent's words are plain text on the ground. Nothing else in the
 * transcript is inverted, so a glance down a session reads as a conversation:
 * highlighted question, plain answer, highlighted question. The band is inset
 * from the frame edge by MARK, like every other block, and each wrapped line is
 * padded to one common width so it reads as a clean rectangle rather than a
 * ragged highlight.
 *
 * The blue is deliberately absent here. Blue is the brand's mark and its few
 * critical signals; whose turn it is is not a critical signal, it is the shape
 * of the conversation, and monochrome carries shape.
 */
export function asked(body: string): string {
  const width = proseWidth();
  const inner = Math.max(8, width - 2);
  const wrapped: string[] = [];
  for (const source of body.replace(/\r\n?/g, "\n").split("\n")) {
    for (const part of wrap(source, inner)) wrapped.push(part);
  }
  if (wrapped.length === 0) wrapped.push("");
  // One band width for the block: the longest line, plus the one-cell inset on
  // each side. Trailing pad sits inside the band, so stripped of colour it is
  // trailing whitespace -- which the one-left-edge law ignores.
  const bandWidth = Math.min(width, Math.max(...wrapped.map((line) => visLen(line))) + 2);
  const band = (line: string): string => {
    const pad = " ".repeat(Math.max(0, bandWidth - visLen(line) - 1));
    return speakerSurface(` ${line}${pad}`);
  };
  return ["", ...wrapped.map((line) => `${MARK}${band(line)}`)].join("\n");
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
      ? `${MARK}${muted(glyph("live"))} ${line.slice(BODY.length)}`
      : line,
  );
}

/** The agent's voice: one dot, then prose. Continuations align under the prose. */
export function said(body: string, paint: (v: string) => string = text): string {
  const lines: string[] = [];
  let first = true;
  for (const source of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (!source.trim()) {
      if (!first) lines.push("");
      continue;
    }
    for (const part of wrap(source, proseWidth())) {
      lines.push(first ? `${MARK}${muted(glyph("live"))} ${paint(part)}` : `${BODY}${paint(part)}`);
      first = false;
    }
  }
  return lines.join("\n");
}

// --- Work rails ---

/** `unproven`: a step the agent closed with nothing the harness could see
 *  behind it -- shown as a claim (the suspected-rung tilde), never as a tick. */
export type Status = "ok" | "pass" | "fail" | "active" | "none" | "unproven";

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
  // A completed neutral call carries NO bullet: the rail and the verb say it
  // ran, and the receipt says what it produced. Only the outcomes that mean
  // something -- a check that passed, work that failed, a call in flight -- earn
  // a mark. This is where the leading `·` dot left the work rows.
  ok: " ",
  pass: glyph("verified"),
  fail: glyph("failure"),
  active: glyph("selection"),
  none: " ",
  unproven: "~",
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
  /** The receipt, inline after the argument: `4 files`, `+6 -1`, `2.6s`. */
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
  return flowRow(`${rail()}${mark}${name}${arg}`, paintMetric(v.metric));
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
 * source's own indentation preserved.
 *
 * Two registers, chosen by what the host can honestly show. Where the theme
 * knows its ground (see theme.bandsEnabled), a changed row is laid on a band
 * tinted from that ground -- the reading every review surface already taught
 * the eye -- and the code keeps its syntax colour, because the row exists to be
 * JUDGED as code and the band is already saying "changed". Everywhere else --
 * pipes, NO_COLOR, ANSI-16, follow-terminal -- the original rendering holds:
 * whole-line green for added, red for removed, grey context. The sign column
 * survives both registers, so the diff still reads with the colour stripped.
 */
export function diffRows(rows: DiffRow[], lang: CodeLang = null): string[] {
  const codeWidth = Math.max(8, verbatimWidth() - 8);
  const bands = bandsEnabled();
  return rows.map((r) => {
    if (r.kind === "elide") return `${rail()}   ${faint(`${glyph("elision")} ${r.text}`)}`;
    const number = faint(String(r.line ?? "").padStart(4));
    const body = truncate(r.text.replace(/\t/g, "  "), codeWidth);
    if (!bands) {
      if (r.kind === "add") return `${rail()}${number} ${ok("+")} ${ok(body)}`;
      if (r.kind === "remove") return `${rail()}${number} ${danger("-")} ${danger(body)}`;
      return `${rail()}${number}   ${muted(body)}`;
    }
    if (r.kind === "context") {
      return `${rail()}${number}   ${paintCode(body, lang, muted)}`;
    }
    // The band runs the full evidence width, not just to the last glyph: a
    // ragged right edge reads as texture, one column reads as a block of
    // change. Trailing cells are pad inside the band, so nothing here trips
    // the no-right-alignment law -- stripped of colour they are trailing
    // whitespace, which the law ignores, and with colour off this branch is
    // never taken at all.
    // An added row sits on the opposite ground (white on ink, the mark's blue
    // on paper), so everything on it -- gutter, sign, code -- is painted with
    // the ink and the palette that read THERE, not the theme's.
    const role = r.kind === "add" ? "ok" : "danger";
    const ink = bandInk(role);
    const pad = " ".repeat(Math.max(0, codeWidth - visLen(body)));
    const laid = `${ink(String(r.line ?? "").padStart(4))} ${ink(r.kind === "add" ? "+" : "-")} ${paintCode(body, lang, ink, bandPalette(role))}${pad}`;
    return `${rail()}${r.kind === "add" ? positiveSurface(laid) : negativeSurface(laid)}`;
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
  const lines = raw.split("\n");
  // A diff that ends in a newline splits into a final empty segment. That is
  // the end of the text, not an empty context line: without this it rendered
  // as one more numbered row below the last real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const source = lines[i]!;
    if (source.startsWith("--- ") || source.startsWith("+++ ")) continue;
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(source);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      hunks++;
      if (hunks > 1 && rows.length < limit) rows.push({ kind: "elide", text: "unchanged lines" });
      // Older native edits glued the hunk's first line onto its header
      // ("@@ -1,3 +1,5 @@ export function greet…"), so histories written before
      // 2026-09-10 still carry it. A git diff also puts text there, but that
      // is a function name from ABOVE the hunk, never a line of it. Tell the
      // two apart by the counts: only when the body is exactly one context
      // line short of what the header declares does the trailer belong to it.
      const trailer = hunk[5] ?? "";
      if (trailer.startsWith(" ") && trailer.length > 1) {
        const declaredOld = hunk[2] == null ? 1 : Number(hunk[2]);
        const declaredNew = hunk[4] == null ? 1 : Number(hunk[4]);
        let bodyOld = 0;
        let bodyNew = 0;
        for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("@@"); j++) {
          const first = lines[j]![0];
          if (first !== "+") bodyOld++;
          if (first !== "-") bodyNew++;
        }
        if (bodyOld === declaredOld - 1 && bodyNew === declaredNew - 1) {
          lines.splice(i + 1, 0, trailer);
        }
      }
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
 * new region of the screen. An empty `command` skips the echo row -- for the
 * excerpt form, where the tool row directly above already names the command
 * and repeating it would spend the first evidence line saying nothing new.
 */
export function outputRail(
  command: string,
  body: string[],
  summary?: string,
  failed = false,
): string[] {
  const width = verbatimWidth();
  const lines = command
    ? [`${BODY}${faint(glyph("gutter"))} ${muted(truncate(command, width))}`]
    : [];
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

/** How much runner self-talk it takes before stripping it is worth an elision
 *  marker. One stray warning line is cheaper to leave in place than to
 *  annotate; a block of them is the thing that buries the verdict. */
const NOISE_FLOOR = 3;

/**
 * Lines a test runner writes about itself rather than about your code. A
 * deprecation notice from a transitive dependency is not evidence of anything
 * the reader is here to judge, and pytest prints its warnings block BEFORE the
 * failures — so a head-and-tail clip spends its whole head on the noise and
 * elides the assertions. Matched conservatively: when in doubt a line is kept.
 *
 * The last alternative is the bare vendored path pytest prints as the HEADER of
 * each warning (`.../site-packages/fastapi/testclient.py:1`). It has to be
 * matched explicitly because it otherwise reads as signal — a file and a line
 * number is exactly the shape of a real stack frame.
 */
const NOISE =
  /^\s*(?:-{2,}\s*Docs:|={3,}\s*warnings summary|\/?\S*(?:site-packages|node_modules)\/\S*:\d+:?\s*\w*(?:Deprecation|Pending|User|Future)Warning|\w*(?:Deprecation|Pending|Future)Warning:|warnings\.warn\(|from \S+ import .* # noqa|\/?\S*(?:site-packages|node_modules)\/\S*:\d+\s*$)/;

/** Lines that carry the verdict. A clip that has to drop something drops
 *  everything else before it drops one of these.
 *
 *  The two failure marks runners print (U+2715, U+00D7) are written as
 *  escapes, not as characters. The closed-glyph gate forbids non-ASCII literals
 *  in this directory and it is right to: it exists so nobody types ornament
 *  into a renderer. These are neither ornament nor ours — they are marks we
 *  RECOGNISE in someone else's output — and the escape keeps the source honest
 *  to the rule while still matching them. */
const SIGNAL =
  /(?:^\s*(?:FAILED|ERROR|FAIL|\u2715|\u00d7|AssertionError|E\s{3})|\bassert\b|\berror(?::|\b)|\bexpected\b|\breceived\b|\d+\s+(?:failed|passed|error)|Traceback|panicked|\.(?:ts|tsx|js|jsx|py|rs|go):\d+)/i;

/**
 * Keep what a long output is FOR, and say exactly what was dropped.
 *
 * The old rule was positional — first 22 lines, last 8 — which is right for a
 * build log and wrong for a test runner, the one case where this rail is the
 * whole point of showing the command at all. `make verify` came back with the
 * head spent on a StarletteDeprecationWarning and a link to the pytest docs,
 * while the failing assertions sat in the elided middle: verbatim noise, elided
 * news. So the budget is now spent in order of what the line is worth.
 *
 * Order is always preserved — this drops lines, it never reorders them, because
 * output that has been rearranged is no longer a transcript of what happened.
 */
export function clip(lines: string[], head = 22, tail = 8): string[] {
  const budget = head + tail;
  const noise = lines.reduce((n, line) => n + (NOISE.test(line) ? 1 : 0), 0);
  // Two separate reasons to intervene, and either is enough. Length is the
  // obvious one. The other is that a runner buried its verdict in its own
  // deprecation notices -- which it does in twenty lines as readily as in two
  // hundred, and which was the actual complaint: `make verify` came back short
  // enough to escape the old length test and still spent most of its rail on
  // warnings from a transitive dependency.
  if (lines.length <= budget + 1 && noise < NOISE_FLOOR) return lines;

  // Everything that is not runner self-talk, in order; then, if that alone
  // still overruns, the lines that carry the verdict win the remaining budget.
  const consider = lines.map((line, index) => ({ line, index })).filter((l) => !NOISE.test(l.line));
  const overflowed = consider.length > budget;
  const pool = overflowed ? consider.filter((l) => SIGNAL.test(l.line)) : consider;
  // Long, and nothing in it claims to be a verdict: a build log. There is
  // nothing to prefer, so the positional rule is still the right shape.
  if (overflowed && pool.length === 0) {
    const hidden = lines.length - head - tail;
    return [...lines.slice(0, head), `${glyph("elision")} ${hidden} lines`, ...lines.slice(-tail)];
  }
  const kept = new Set<number>();
  for (const { index } of pool.slice(-budget)) kept.add(index);
  // A verdict is usually the last thing written, so the closing lines are held
  // even when nothing in them matched -- but not when they are the very noise
  // this is here to drop. pytest signs off with a link to its own docs.
  for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
    if (!NOISE.test(lines[i]!)) kept.add(i);
  }

  const out: string[] = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (kept.has(i)) {
      if (dropped > 0) {
        out.push(`${glyph("elision")} ${dropped} line${dropped === 1 ? "" : "s"}`);
        dropped = 0;
      }
      out.push(lines[i]!);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) out.push(`${glyph("elision")} ${dropped} line${dropped === 1 ? "" : "s"}`);
  return out;
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
  const head = flowRow(
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
              : item.status === "unproven"
                ? warn(STATUS_GLYPH.unproven)
                : faint("o");
      const tone = item.metricTone === "ok" ? ok : item.metricTone === "fail" ? danger : muted;
      const metric =
        item.metric && item.metric.includes("\x1b")
          ? item.metric
          : item.metric && tone(item.metric);
      return flowRow(
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
