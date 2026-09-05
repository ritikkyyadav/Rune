// --- Rune Render Primitives ---
// Pure, width-aware string builders. All length math uses terminal cells rather
// than JavaScript string length, so ANSI styling, CJK, emoji, combining marks,
// and joined graphemes do not break cursor math or box alignment.

import { line as lineColor, muted, faint, text as textColor, warn } from "./theme";
import { glyph } from "./glyphs";

let widthOverride: number | null = null;

/** Full-screen Rune keeps a centered reading column on the terminal surface.
 * Set the semantic renderer's width to that column so task bars, prose, commands,
 * and diffs wrap before the compositor applies its final safety clamp. */
export function setTermWidthOverride(width: number | null): void {
  widthOverride = width == null ? null : Math.max(12, Math.floor(width));
}

export function termWidth(): number {
  // `columns` is 0 (not undefined) on a PTY with no winsize -- fall back sanely.
  return widthOverride ?? (process.stdout.columns || 80);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MARK_OR_FORMAT = /^[\p{Mark}\p{Cf}]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/gu;
const RESET = "\x1b[0m";

interface CellToken {
  raw: string;
  width: number;
  escape: boolean;
}

/** Read one terminal escape sequence without mistaking its payload for text. */
function escapeAt(value: string, index: number): string | null {
  if (value[index] !== "\x1b") return null;
  const rest = value.slice(index);
  // CSI: styling, cursor movement, erase commands, etc.
  const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
  if (csi) return csi[0];
  // OSC: terminal title / foreground / background. Ends in BEL or ST.
  const osc = /^\x1b\][^\x07]*(?:\x07|\x1b\\)/.exec(rest);
  if (osc) return osc[0];
  // Other two-byte escape sequences.
  const short = /^\x1b[@-_]/.exec(rest);
  return short?.[0] ?? "\x1b";
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b2ff) ||
      (cp >= 0x1f200 && cp <= 0x1f251) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

/** Width of one user-perceived grapheme in a conventional monospace terminal. */
function graphemeWidth(value: string): number {
  if (!value) return 0;

  // Emoji sequences occupy one two-cell glyph: flags, keycaps, emoji-presentation
  // characters, and pictographs explicitly joined or promoted with VS16.
  const regionalCount = value.match(REGIONAL_INDICATOR)?.length ?? 0;
  if (
    regionalCount >= 2 ||
    /\u20e3/u.test(value) ||
    EMOJI_PRESENTATION.test(value) ||
    (EXTENDED_PICTOGRAPHIC.test(value) && (value.includes("\u200d") || value.includes("\ufe0f")))
  ) {
    return 2;
  }

  // A grapheme normally has one spacing base plus zero-width marks/joiners.
  // Taking the widest base also handles Indic conjuncts without double-counting
  // the code points that form a single displayed cluster.
  let width = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || MARK_OR_FORMAT.test(ch)) continue;
    width = Math.max(width, isWideCodePoint(cp) ? 2 : 1);
  }
  return width;
}

/** Split styled terminal text into zero-width escape tokens and whole graphemes. */
function cellTokens(value: string): CellToken[] {
  const out: CellToken[] = [];
  let i = 0;
  while (i < value.length) {
    const escape = escapeAt(value, i);
    if (escape) {
      out.push({ raw: escape, width: 0, escape: true });
      i += escape.length;
      continue;
    }
    const nextEscape = value.indexOf("\x1b", i);
    const end = nextEscape < 0 ? value.length : nextEscape;
    const chunk = value.slice(i, end);
    for (const part of graphemes.segment(chunk)) {
      out.push({ raw: part.segment, width: graphemeWidth(part.segment), escape: false });
    }
    i = end;
  }
  return out;
}

/** Visible terminal-cell width of a possibly ANSI-colored string. */
export function visLen(value: string): number {
  return cellTokens(value).reduce((sum, token) => sum + token.width, 0);
}

/** Take the longest grapheme-safe prefix that fits in `max` terminal cells. */
function prefixByWidth(value: string, max: number): string {
  if (max <= 0) return "";
  let width = 0;
  let out = "";
  for (const token of cellTokens(value)) {
    if (token.escape) {
      out += token.raw;
      continue;
    }
    if (width + token.width > max) break;
    out += token.raw;
    width += token.width;
  }
  return out;
}

/**
 * Truncate by terminal-cell width, appending an ellipsis. ANSI styling is kept,
 * and a grapheme is either retained whole or omitted whole.
 */
export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (visLen(value) <= max) return value;
  const elision = glyph("elision");
  if (max === 1) return elision;
  const prefix = prefixByWidth(value, max - 1);
  return prefix + elision + (value.includes("\x1b") ? RESET : "");
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
  if (visLen(line) <= max) return line;
  const prefix = max === 1 ? "" : prefixByWidth(line, max - 1);
  return prefix + glyph("elision") + (line.includes("\x1b") ? RESET : "");
}

/** Split one unbroken word into grapheme-safe chunks no wider than `width`. */
function splitWord(word: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  let cells = 0;
  for (const part of graphemes.segment(word)) {
    const next = graphemeWidth(part.segment);
    if (line && cells + next > width) {
      out.push(line);
      line = "";
      cells = 0;
    }
    line += part.segment;
    cells += next;
  }
  if (line) out.push(line);
  return out;
}

/** Word-wrap plain text by terminal cells; long tokens are split safely. */
export function wrap(value: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let curWidth = 0;
  for (const w of words) {
    const wordWidth = visLen(w);
    if (wordWidth > limit) {
      if (cur) {
        lines.push(cur);
        cur = "";
        curWidth = 0;
      }
      const chunks = splitWord(w, limit);
      lines.push(...chunks.slice(0, -1));
      cur = chunks.at(-1) ?? "";
      curWidth = visLen(cur);
    } else if (!cur) {
      cur = w;
      curWidth = wordWidth;
    } else if (curWidth + 1 + wordWidth <= limit) {
      cur += " " + w;
      curWidth += 1 + wordWidth;
    } else {
      lines.push(cur);
      cur = w;
      curWidth = wordWidth;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** The five-cell occupancy meter used by the footer and the compaction
 * receipt: `##...`. Any non-zero percentage shows at least one filled cell. */
export function meterGlyphs(percent: number, cells = 5): string {
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.min(cells, Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * cells)));
  return "#".repeat(filled) + ".".repeat(cells - filled);
}

export interface RailCardOpts {
  /** Paints the left rail glyph -- the card's coloured border. */
  rail: (value: string) => string;
  /** Paints each row's background -- the card's tinted surface. */
  surface?: (value: string) => string;
  /** Card width in cells (default: the reading measure, <=100). */
  width?: number;
  indent?: string;
}

/**
 * A left-railed card: the customizer's `.perm-card` / `.fallback-card` idiom
 * (3px coloured border, tinted body). Every row is truncated and padded to the
 * same width so the surface reads as one solid card, never as coloured words.
 */
export function railCard(rows: string[], opts: RailCardOpts): string[] {
  const indent = opts.indent ?? "  ";
  // An explicit width is the caller's measured column (the TUI's content
  // width); only the default derives from the terminal.
  const available = Math.max(16, termWidth() - visLen(indent) - 1);
  const width = Math.max(16, opts.width ?? Math.min(100, available));
  const inner = width - 3; // rail + gap ... trailing pad
  return rows.map((row) => {
    const shown = truncate(row, inner);
    const fill = " ".repeat(Math.max(0, inner - visLen(shown)));
    const body = `${opts.rail(glyph("gutter"))} ${shown}${fill} `;
    return `${indent}${opts.surface ? opts.surface(body) : body}`;
  });
}

/** Horizontal rule, indented. */
export function rule(
  width?: number,
  opts: { pad?: string; color?: (s: string) => string; glyph?: string } = {},
): string {
  const pad = opts.pad ?? "  ";
  const w = width ?? Math.min(termWidth() - 4, 76);
  // The cell defaults to ASCII so this stays usable from non-UI callers; the
  // UI passes the closed set's hairline, which folds to the same "-" anyway.
  const cell = opts.glyph ?? "-";
  return `${pad}${(opts.color ?? lineColor)(cell.repeat(Math.max(1, w)))}`;
}

// --- Box ---

export interface BoxOpts {
  /** Left indentation. Default "  ". */
  pad?: string;
  /** Rounded corners (++++) vs square (++++). Default rounded. */
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
  const avail = termWidth() - visLen(pad) - 4;
  return Math.max(1, Math.min(content, Math.max(10, avail)));
}

/**
 * Frame pre-rendered content lines in a box. Content may already be colored;
 * any header (e.g. `>_ Rune`) is just the first line.
 */
export function box(lines: string[], opts: BoxOpts = {}): string {
  const pad = opts.pad ?? "  ";
  const color = opts.color ?? lineColor;
  const [tl, tr, bl, br] = ["+", "+", "+", "+"];
  const inner = boxInnerWidth(lines, pad, opts.width);

  const top = `${pad}${color(tl + "-".repeat(inner + 2) + tr)}`;
  const bottom = `${pad}${color(bl + "-".repeat(inner + 2) + br)}`;
  const body = lines.map((ln) => {
    const shown = visLen(ln) > inner ? truncate(ln, inner) : ln;
    const fill = Math.max(0, inner - visLen(shown));
    return `${pad}${color(glyph("gutter"))} ${shown}${" ".repeat(fill)} ${color(glyph("gutter"))}`;
  });
  return [top, ...body, bottom].join("\n");
}

// --- Key/value rows ---

export interface KvOpts {
  labelWidth?: number;
  labelColor?: (s: string) => string;
  valueColor?: (s: string) => string;
}

/** Aligned `label   value` rows (unframed -- drop into a box or print directly). */
export function kv(rows: [string, string][], opts: KvOpts = {}): string[] {
  const lw = opts.labelWidth ?? Math.max(0, ...rows.map(([k]) => visLen(k)));
  const lc = opts.labelColor ?? muted;
  const vc = opts.valueColor ?? textColor;
  return rows.map(([k, v]) => `${lc(k + " ".repeat(Math.max(0, lw - visLen(k))))}  ${vc(v)}`);
}

// --- Progress bar ---

export interface BarOpts {
  fill?: (s: string) => string;
  empty?: (s: string) => string;
}

/** `[████....]` progress bar for a fraction in [0,1]. */
export function bar(frac: number, width = 20, opts: BarOpts = {}): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  const fill = opts.fill ?? warn;
  const empty = opts.empty ?? faint;
  return `${faint("[")}${fill("#".repeat(filled))}${empty(".".repeat(width - filled))}${faint("]")}`;
}

// --- Bullets & connectors (Codex-style activity rows) ---

/** `. content` -- a top-level activity row. */
export function bullet(
  content: string,
  opts: { color?: (s: string) => string; pad?: string } = {},
): string {
  const pad = opts.pad ?? "  ";
  const c = opts.color ?? muted;
  return `${pad}${c(glyph("observed"))} ${content}`;
}

/** `  + content` with optional indented sub-lines beneath it. */
export function connector(
  content: string,
  opts: { pad?: string; sub?: string[]; color?: (s: string) => string } = {},
): string {
  const pad = opts.pad ?? "  ";
  const c = opts.color ?? faint;
  const lines = [`${pad}${c(glyph("gutter"))} ${content}`];
  for (const s of opts.sub ?? []) lines.push(`${pad}  ${muted(s)}`);
  return lines.join("\n");
}
