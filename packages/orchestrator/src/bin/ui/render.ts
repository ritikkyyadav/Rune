// ─── Alan Render Primitives ───
// Pure, width-aware string builders. All length math goes through stripAnsi so
// colored content lays out correctly. These replace the hand-counted padding that
// was scattered through alan-cli.ts.

import { line as lineColor, muted, faint, text as textColor, warn, stripAnsi } from "./theme";

export function termWidth(): number {
  // `columns` is 0 (not undefined) on a PTY with no winsize — fall back sanely.
  return process.stdout.columns || 80;
}

/** Visible (printable) length of a possibly-colored string. */
export function visLen(value: string): number {
  return stripAnsi(value).length;
}

/**
 * Truncate by visible width, appending an ellipsis. Operates on plain text —
 * callers truncate content *before* coloring it.
 */
export function truncate(value: string, max: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= max) return value;
  if (max <= 1) return "…";
  return plain.slice(0, max - 1) + "…";
}

/**
 * ANSI-aware hard clamp: cut an already-STYLED line to `max` visible columns,
 * keeping its escape sequences and closing with a reset. This is the last line
 * of defense for the pinned-region contract (lines must never auto-wrap): a
 * single over-wide line breaks the region's cursor math, and every subsequent
 * repaint then leaks stale rows into the scrollback.
 */
export function clampVisible(line: string, max: number): string {
  if (max <= 0) return "";
  let visible = 0;
  let out = "";
  let cut = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      // Copy the whole escape sequence (CSI `\x1b[...X` or two-char like `\x1b(B`).
      const m = /^\x1b(\[[0-9;?]*[A-Za-z]|.)/.exec(line.slice(i));
      const seq = m ? m[0] : line[i]!;
      out += seq;
      i += seq.length - 1;
      continue;
    }
    if (visible >= max - 1) {
      // Room for one glyph left: spend it on the ellipsis if anything follows.
      const rest = stripAnsi(line.slice(i));
      out += rest.length > 1 ? "…" : line[i];
      visible++;
      cut = rest.length > 1;
      // Keep any TRAILING escape sequences (resets) so styling never bleeds.
      const tail = line.slice(i + 1).match(/(?:\x1b\[[0-9;?]*[A-Za-z])+$/);
      if (tail) out += tail[0];
      break;
    }
    out += line[i];
    visible++;
  }
  return cut ? out + "\x1b[0m" : out;
}

/** Word-wrap plain text to a column width. */
export function wrap(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Horizontal rule, indented. */
export function rule(width?: number, opts: { pad?: string; color?: (s: string) => string } = {}): string {
  const pad = opts.pad ?? "  ";
  const w = width ?? Math.min(termWidth() - 4, 76);
  return `${pad}${(opts.color ?? lineColor)("─".repeat(Math.max(1, w)))}`;
}

// ─── Box ───

export interface BoxOpts {
  /** Left indentation. Default "  ". */
  pad?: string;
  /** Rounded corners (╭╮╰╯) vs square (┌┐└┘). Default rounded. */
  rounded?: boolean;
  /** Hard inner width override. Default: fit content, capped to terminal. */
  width?: number;
  /** Border color. Default theme `line`. */
  color?: (s: string) => string;
}

function boxInnerWidth(lines: string[], pad: string, override?: number): number {
  const content = Math.max(0, ...lines.map(visLen));
  if (override != null) return Math.max(1, override);
  // terminal minus indent, two border glyphs, two inner spaces
  const avail = termWidth() - pad.length - 4;
  return Math.max(1, Math.min(content, Math.max(10, avail)));
}

/**
 * Frame pre-rendered content lines in a box. Content may already be colored;
 * any header (e.g. `>_ Alan`) is just the first line.
 */
export function box(lines: string[], opts: BoxOpts = {}): string {
  const pad = opts.pad ?? "  ";
  const color = opts.color ?? lineColor;
  const rounded = opts.rounded ?? true;
  const [tl, tr, bl, br] = rounded ? ["╭", "╮", "╰", "╯"] : ["┌", "┐", "└", "┘"];
  const inner = boxInnerWidth(lines, pad, opts.width);

  const top = `${pad}${color(tl + "─".repeat(inner + 2) + tr)}`;
  const bottom = `${pad}${color(bl + "─".repeat(inner + 2) + br)}`;
  const body = lines.map((ln) => {
    const shown = visLen(ln) > inner ? truncate(ln, inner) : ln;
    const fill = Math.max(0, inner - visLen(shown));
    return `${pad}${color("│")} ${shown}${" ".repeat(fill)} ${color("│")}`;
  });
  return [top, ...body, bottom].join("\n");
}

// ─── Key/value rows ───

export interface KvOpts {
  labelWidth?: number;
  labelColor?: (s: string) => string;
  valueColor?: (s: string) => string;
}

/** Aligned `label   value` rows (unframed — drop into a box or print directly). */
export function kv(rows: [string, string][], opts: KvOpts = {}): string[] {
  const lw = opts.labelWidth ?? Math.max(0, ...rows.map(([k]) => k.length));
  const lc = opts.labelColor ?? muted;
  const vc = opts.valueColor ?? textColor;
  return rows.map(([k, v]) => `${lc(k.padEnd(lw))}  ${vc(v)}`);
}

// ─── Progress bar ───

export interface BarOpts {
  fill?: (s: string) => string;
  empty?: (s: string) => string;
}

/** `[████░░░░]` progress bar for a fraction in [0,1]. */
export function bar(frac: number, width = 20, opts: BarOpts = {}): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  const fill = opts.fill ?? warn;
  const empty = opts.empty ?? faint;
  return `${faint("[")}${fill("█".repeat(filled))}${empty("░".repeat(width - filled))}${faint("]")}`;
}

// ─── Bullets & connectors (Codex-style activity rows) ───

/** `• content` — a top-level activity row. */
export function bullet(content: string, opts: { color?: (s: string) => string; pad?: string } = {}): string {
  const pad = opts.pad ?? "  ";
  const c = opts.color ?? muted;
  return `${pad}${c("•")} ${content}`;
}

/** `  └ content` with optional indented sub-lines beneath it. */
export function connector(
  content: string,
  opts: { pad?: string; sub?: string[]; color?: (s: string) => string } = {},
): string {
  const pad = opts.pad ?? "  ";
  const c = opts.color ?? faint;
  const lines = [`${pad}${c("└")} ${content}`];
  for (const s of opts.sub ?? []) lines.push(`${pad}  ${muted(s)}`);
  return lines.join("\n");
}
