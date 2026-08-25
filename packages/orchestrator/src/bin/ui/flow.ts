// ─── Flow: the terminal design system ───
// A coding agent's terminal UI, as it reads under a real pty. One rule underneath
// everything here: never own the screen, own the last four lines. So there are no
// cards, no boxes, no painted surfaces, no logo — just a fixed reading measure, a
// left rail where work happens, and a right column where the receipt lands.
//
// The whole grammar is five marks:
//
//   › you asked                            the human, at the left margin
//   ● the agent answers                    one signal dot, prose beside it
//     │ · grep  content_block_stop         work, on a rail under the prose
//     │ └ src/streaming.ts:42              what that work found
//   ▸ Run this? It touches ~/.cache        a decision, and only a decision
//
// Colour carries meaning, never decoration: teal is identity and location,
// green is added and passed, red is removed and failed, amber asks. Everything
// else is one of three greys. If a value is unknown it is absent — no row here
// ever pads itself with a reassuring guess.

import { accent, bold, faint, info, muted, ok, text, warn } from "./theme";
import { termWidth, truncate, visLen, wrap } from "./render";

// ─── The grid ───
// Prose sits at column 4 and work rails from the same column, so a tool call
// reads as a continuation of the sentence that introduced it rather than a
// separate panel. The measure is fixed: wide terminals get whitespace, not
// longer lines, because a 200-column sentence is unreadable.

/** Marker column — `›` and `●` live here. */
export const MARK = "  ";
/** Prose/rail column. Everything a marker introduces aligns here. */
export const BODY = "    ";
/** Content inside a rail: past `│ `. */
export const RAIL_IN = "      ";

/**
 * The content measure, in columns. Rows that carry *data* — a path, a diff, a
 * command's output, a receipt — get this, and it follows the terminal up to a
 * generous ceiling. The ceiling exists only so a right-aligned receipt stays
 * near the row it belongs to; it is not a reading limit, because truncating a
 * path with `…` while half the window sits empty destroys the one thing the row
 * was printed to say.
 *
 * A caller that owns a narrower region (an overlay, a pinned panel) passes its
 * own cap; the measure is a ceiling, never a floor, so nothing renders wider
 * than its host.
 */
export function measure(cap?: number): number {
  const base = Math.min(120, Math.max(40, termWidth() - 2));
  return cap != null ? Math.max(12, Math.min(base, cap)) : base;
}

/**
 * The whole surface, for the structural rules that divide it — the header's two
 * rules and the hairline above the composer. Chrome is not content: a divider
 * that stops at the reading column leaves the screen looking half-drawn, and
 * the thing it is dividing is the window, not the paragraph.
 */
export function surfaceWidth(): number {
  return Math.max(20, termWidth() - 1);
}

/**
 * Columns available to *prose*. Sentences are capped well below the data
 * measure and stay there on a wide window, because a 120-column sentence is
 * genuinely harder to read than an 84-column one — the eye loses the line on
 * the way back. Code and paths have no such problem, which is why they are
 * measured separately.
 */
export function proseWidth(): number {
  return Math.max(16, Math.min(88, measure()) - BODY.length);
}

/** Columns available inside a rail (`    │ ` is 6 cells) for a row that also
 *  carries a right-aligned receipt. */
export function railWidth(): number {
  return Math.max(12, measure() - RAIL_IN.length);
}

/**
 * Columns available inside a rail for *verbatim* content — a line of a diff,
 * a line a command actually printed. These rows carry no receipt, so there is
 * nothing to keep near anything, and they take the whole window: a source line
 * cut at `…` is a line the reader cannot check, which defeats the point of
 * showing the evidence at all.
 */
export function verbatimWidth(): number {
  return Math.max(12, Math.max(measure(), termWidth() - 2) - RAIL_IN.length);
}

/**
 * One row of the grid: content on the left, a receipt hard against the right
 * edge of the measure. When the two cannot both fit, the receipt wins and the
 * content truncates — a metric you cannot read is worse than a clipped path.
 */
export function row(left: string, right = ""): string {
  const width = measure();
  const rightCells = visLen(right);
  const budget = Math.max(4, width - rightCells - (rightCells ? 2 : 0));
  const shown = visLen(left) > budget ? truncate(left, budget) : left;
  if (!rightCells) return shown;
  const gap = Math.max(1, width - visLen(shown) - rightCells);
  return `${shown}${" ".repeat(gap)}${right}`;
}

// ─── Header ───

export interface FlowHeader {
  /** Product name, set in the identity colour. */
  name: string;
  /** Version, no `v` prefix — `gear 0.3.0`. */
  version: string;
  /** Workspace folder name. */
  workspace?: string;
  /** Git branch, when the workspace has one. */
  branch?: string;
  /** Anything else true about the tree right now (`3 files changed`). */
  state?: string;
  /** Model id or label. */
  model?: string;
  /** What the agent may do without asking — the gear, in words. */
  scope?: string;
  /** The part of `scope` that is a guardrail rather than a permission. */
  caution?: string;
}

/**
 * The identity block: a rule with the name set into it, two lines that say
 * where you are and what the agent is allowed to do, and a closing rule. No
 * mark, no avatar, no wordmark — the terminal already knows it is a terminal.
 */
export function header(opts: FlowHeader): string {
  const width = measure();
  const surface = surfaceWidth();
  const title = `${info(opts.name)} ${muted(opts.version)}`;
  const lead = faint("──── ");
  const tail = Math.max(3, surface - visLen(lead) - visLen(title) - 1);
  const lines = [
    "",
    `${lead}${title} ${faint("─".repeat(tail))}`,
    ...place(
      [
        opts.workspace && text(opts.workspace),
        opts.branch && info(opts.branch),
        opts.state && muted(opts.state),
      ],
      width,
    ),
    ...place([opts.model && muted(opts.model), scopeClause(opts)], width),
    faint("─".repeat(surface)),
    "",
  ];
  return lines.join("\n");
}

/** What the agent may do, and where that stops — one amber clause, because
 *  this is the only line in the header that governs your machine. */
function scopeClause(opts: FlowHeader): string | undefined {
  const clause = [opts.scope, opts.caution && `— ${opts.caution}`].filter(Boolean).join(" ");
  return clause ? warn(clause) : undefined;
}

/** A middot-joined meta line under the header rule, or nothing when empty. */
function place(parts: Array<string | undefined | false>, width: number): string[] {
  const shown = parts.filter((part): part is string => Boolean(part));
  if (shown.length === 0) return [];
  return [`${MARK}${truncate(shown.join(faint(" · ")), width - MARK.length)}`];
}

// ─── Turn markers ───

/**
 * What you asked, at the left margin — the strongest landmark in scrollback
 * precisely because nothing decorates it.
 */
export function asked(body: string): string {
  const lines: string[] = [""];
  let first = true;
  for (const source of body.replace(/\r\n/g, "\n").split("\n")) {
    for (const part of wrap(source, proseWidth())) {
      lines.push(first ? `${MARK}${muted("›")} ${text(part)}` : `${BODY}${text(part)}`);
      first = false;
    }
  }
  return lines.join("\n");
}

/**
 * Put the agent's dot on an already-rendered block — Markdown that has been
 * laid out at the body indent, so lists and inline code survive. The dot
 * replaces the first line's indent rather than being prepended to it, which is
 * what keeps every continuation aligned under the prose.
 */
export function dot(lines: string[]): string[] {
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return lines;
  return lines.map((line, index) =>
    index === first && line.startsWith(BODY)
      ? `${MARK}${info("●")} ${line.slice(BODY.length)}`
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
      lines.push(first ? `${MARK}${info("●")} ${paint(part)}` : `${BODY}${paint(part)}`);
      first = false;
    }
  }
  return lines.join("\n");
}

// ─── Work rails ───

export type Status = "ok" | "pass" | "fail" | "active" | "none";

/**
 * The status column, ordered by how much attention each mark is allowed to ask
 * for. `ok` is the default and says only *this happened*: a faint middot, no
 * verdict. A file that was read is not news — reads almost always succeed — and
 * a rail that awards a green tick to fifteen routine calls has spent the tick
 * before it reaches the one that mattered. What the reader actually wants from
 * a finished call is on the other side of the row: `120 lines`, `4 files`,
 * `2.6s`. Neutralising the mark is what lets the eye travel there.
 *
 * `pass` is the green tick, and it is spent only where something was genuinely
 * checked — a test run, a typecheck, a build. `fail` is the single mark allowed
 * to interrupt. Every glyph occupies one cell, `none` included, so the verb
 * column holds whether or not a row carries a mark.
 */
const GLYPH: Record<Status, string> = { ok: "·", pass: "✓", fail: "✗", active: "›", none: " " };

/** The rail cell — a hairline under the prose, marking work rather than boxing it. */
function rail(): string {
  return `${BODY}${faint("│")} `;
}

export interface ToolRow {
  /** `grep`, `read`, `edit`, `run` — a verb short enough to scan, not a tool id. */
  name: string;
  /** What it acted on: a pattern, a path, a command. */
  arg?: string;
  /** The receipt, right-aligned: `4 files`, `+6 -1 · 1 hunk`, `2.6s`. */
  metric?: string;
  /** How the call ended. `ok` (the default) is a neutral "this happened";
   *  `pass` is reserved for work that verified something. Edits use `none`:
   *  the diff below is the evidence, and it does not need a mark to vouch for
   *  it. */
  status?: Status;
  /** Paints the argument — teal when it names a file the agent is changing. */
  argTone?: "muted" | "path";
}

/** A receipt that already carries colour keeps it; a plain one reads secondary. */
function paintMetric(metric?: string): string {
  if (!metric) return "";
  return metric.includes("\x1b") ? metric : muted(metric);
}

/**
 * One unit of work: `│ · grep  content_block_stop            4 files`.
 * The name is padded to a stable column so a run of calls reads as a table
 * without ever drawing one.
 */
export function toolRow(v: ToolRow): string {
  const status = v.status ?? "ok";
  const mark =
    status === "ok"
      ? `${faint(GLYPH.ok)} `
      : status === "pass"
        ? `${ok(GLYPH.pass)} `
        : status === "fail"
          ? `${accent(GLYPH.fail)} `
          : status === "active"
            ? `${info(GLYPH.active)} `
            : `${GLYPH.none} `;
  const name = text(v.name.padEnd(4));
  const arg = v.arg ? `  ${(v.argTone === "path" ? info : muted)(v.arg)}` : "";
  return row(`${rail()}${mark}${name}${arg}`, paintMetric(v.metric));
}

/**
 * What the work found, one line, under its call: `│ └ src/streaming.ts:42`.
 * Tinted only when the outcome itself is the news (a failure).
 */
export function toolNote(detail: string, tone: "muted" | "fail" | "ok" = "muted"): string {
  const paint = tone === "fail" ? accent : tone === "ok" ? text : muted;
  const glyph = tone === "fail" ? accent("└") : faint("└");
  return `${rail()}${glyph} ${truncate(paint(detail), railWidth() - 2)}`;
}

/** A plain continuation row on the rail, already painted by the caller. */
export function railRow(content: string): string {
  return `${rail()}${content}`;
}

// ─── Diffs ───

export interface DiffRow {
  kind: "add" | "remove" | "context" | "elide";
  line?: number;
  text: string;
}

/**
 * A hunk as it actually reads: a line-number gutter, one sign column, and the
 * source's own indentation preserved. Added lines are green, removed red,
 * context grey — no background wash, because a wash makes code harder to read,
 * not easier.
 */
export function diffRows(rows: DiffRow[]): string[] {
  const codeWidth = Math.max(8, verbatimWidth() - 8);
  return rows.map((r) => {
    if (r.kind === "elide") return `${rail()}   ${faint(`⋯ ${r.text}`)}`;
    const number = faint(String(r.line ?? "").padStart(4));
    const body = truncate(r.text, codeWidth);
    if (r.kind === "add") return `${rail()}${number} ${ok("+")} ${ok(body)}`;
    if (r.kind === "remove") return `${rail()}${number} ${accent("-")} ${accent(body)}`;
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

/** The receipt for an edit: `+6 -1 · 1 hunk`, or `+14 · new file`. The counts
 *  carry their own meaning, so they carry their own colour. */
export function editMetric(added: number, removed: number, note = ""): string {
  const counts = [added > 0 ? ok(`+${added}`) : "", removed > 0 ? accent(`-${removed}`) : ""]
    .filter(Boolean)
    .join(" ");
  return [counts || muted("no change"), note ? muted(note) : ""].filter(Boolean).join(muted(" · "));
}

// ─── Command output ───

/**
 * A command's real output, kept whole in its own rail: `┌ the command`, the
 * bytes it printed, `└ what happened`. The rail sits in the same column as the
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
  const lines = [`${BODY}${faint("┌")} ${muted(truncate(command, width))}`];
  for (const source of body) {
    lines.push(`${BODY}${faint("│")} ${muted(truncate(source.replace(/\t/g, "  "), width))}`);
  }
  if (summary) {
    const edge = failed ? accent : faint;
    lines.push(`${BODY}${edge("└")} ${(failed ? accent : text)(truncate(summary, width))}`);
  }
  return lines;
}

/** Keep the head and tail of a long output; say exactly what was dropped. */
export function clip(lines: string[], head = 22, tail = 8): string[] {
  if (lines.length <= head + tail + 1) return lines;
  const hidden = lines.length - head - tail;
  return [...lines.slice(0, head), `⋯ ${hidden} lines`, ...lines.slice(-tail)];
}

// ─── Checklists ───

export interface CheckItem {
  status: Status;
  label: string;
  /** Right-aligned per row: `+9 -1`, or why a row is `✗`. */
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
 * then one row per item. A `✗` row states its reason instead of disappearing —
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
          ? ok(GLYPH.pass)
          : item.status === "fail"
            ? accent(GLYPH.fail)
            : item.status === "active"
              ? info(GLYPH.active)
              : faint("○");
      const tone = item.metricTone === "ok" ? ok : item.metricTone === "fail" ? accent : muted;
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

// ─── Decisions ───

export interface AskBlock {
  /** The question, in one sentence, stating what is at stake. */
  question: string;
  /** The exact thing that would run — never a paraphrase. */
  command?: string;
  /** Pre-painted evidence rows (a located diff) when the proposal is not a
   *  command. Rendered exactly as given, under the question. */
  evidence?: string[];
  /** Real consequences, computed: `deletes 1.2 GB outside the repo · ~90s`. */
  impact?: string;
  /** The one line that cannot be walked back, if there is one. */
  irreversible?: string;
  /** Numbered choices, in the order a person would consider them. */
  options: string[];
  /** Highlighted choice (0-based), when the surface has a cursor. */
  selected?: number;
  /** What Escape does — always shown, always the safe default. */
  escape?: string;
  /** Columns the host region owns, when it is narrower than the measure. */
  width?: number;
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
  const lines: string[] = [
    "",
    `${MARK}${warn("▸")} ${bold(text(truncate(block.question, width - 4)))}`,
  ];
  if (block.command) {
    lines.push("");
    for (const part of wrap(block.command, rail)) {
      lines.push(`${BODY}${warn("│")} ${text(part)}`);
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
  block.options.forEach((option, index) => {
    const chosen = index === block.selected;
    const key = chosen ? bold(info(String(index + 1))) : info(String(index + 1));
    const label = chosen ? bold(text(option)) : text(option);
    lines.push(`${BODY}${key}   ${truncate(label, width - 8)}`);
  });
  lines.push(`${BODY}${faint("esc")} ${faint(block.escape ?? "cancel")}  ${faint("(default)")}`);
  return lines;
}

/** The answer, echoed back so scrollback records what was decided. */
export function answered(index: number, label: string): string {
  return `\n${MARK}${info("›")} ${info(String(index + 1))}   ${text(label)}`;
}

// ─── Notes ───

/**
 * Something the turn could not do, or chose not to: a mark, a sentence, and —
 * when there is one — the exact command that would resolve it. Never a warning
 * without a way out.
 */
export function note(
  headline: string,
  body?: string,
  next?: { verb: string; command: string },
  tone: "fail" | "warn" | "ok" = "warn",
): string[] {
  const paint = tone === "fail" ? accent : tone === "ok" ? ok : warn;
  const glyph = tone === "fail" ? "✗" : tone === "ok" ? "✓" : "!";
  const lines = ["", `${MARK}${paint(glyph)} ${bold(text(truncate(headline, measure() - 4)))}`];
  if (body) {
    lines.push("");
    for (const part of wrap(body, proseWidth())) lines.push(`${BODY}${text(part)}`);
  }
  if (next) {
    lines.push("");
    lines.push(
      `${BODY}${info("→")} ${muted(next.verb)}  ${text(truncate(next.command, proseWidth() - 8))}`,
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
