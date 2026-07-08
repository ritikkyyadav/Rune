// ─── Markdown → ANSI (the response voice) ───
// Renders the model's final answer as *typography*, not raw markup: headings set
// bold with a hairline, code fences get a gutter, lists get real bullets with
// hanging indents, and inline `code`/**bold**/*italic* become their terminal
// equivalents. Deliberately small: block-level structure + the inline styles
// models actually emit. Everything width-aware so nothing overflows the column.
//
// Style follows the Savoir identity: prose is the statement (clean, primary
// text); code and metadata are the record (gutter, faint hairlines, info tint).

import {
  bold,
  text,
  muted,
  faint,
  info,
  warn,
  line as lineColor,
  colorEnabled,
  stripAnsi,
} from "./theme";
import { termWidth } from "./render";

const ITALIC_ON = "\x1b[3m";
const STRIKE_ON = "\x1b[9m";
const STYLE_OFF = "\x1b[0m";

const italic = (v: string): string => (colorEnabled ? `${ITALIC_ON}${v}${STYLE_OFF}` : v);
const strike = (v: string): string => (colorEnabled ? `${STRIKE_ON}${v}${STYLE_OFF}` : v);

export interface MarkdownOpts {
  /** Total column budget for each rendered line (indent included). Default: min(term-2, 100). */
  width?: number;
  /** Left indent prepended to every line. Default "  ". */
  indent?: string;
}

// ── inline styling ──
// Parse a single line of prose into styled segments, then wrap segment-aware so
// a style never leaks across a line break (each chunk is styled independently).

interface Seg {
  t: string;
  paint: (s: string) => string;
}

const plain = (s: string): string => text(s);

/** `**bold**`, `*em*`, `_em_`, `` `code` ``, `~~strike~~`, `[label](url)`. */
export function parseInline(src: string): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) segs.push({ t: buf, paint: plain });
    buf = "";
  };
  while (i < src.length) {
    const rest = src.slice(i);
    // inline code — highest precedence, protects its contents
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      flush();
      segs.push({ t: code[1]!, paint: info });
      i += code[0].length;
      continue;
    }
    const boldm = rest.match(/^\*\*([^*]+)\*\*/) ?? rest.match(/^__([^_]+)__/);
    if (boldm) {
      flush();
      segs.push({ t: boldm[1]!, paint: (s) => bold(text(s)) });
      i += boldm[0].length;
      continue;
    }
    const em = rest.match(/^\*([^*\s][^*]*)\*/) ?? rest.match(/^_([^_\s][^_]*)_/);
    if (em) {
      flush();
      segs.push({ t: em[1]!, paint: (s) => italic(text(s)) });
      i += em[0].length;
      continue;
    }
    const st = rest.match(/^~~([^~]+)~~/);
    if (st) {
      flush();
      segs.push({ t: st[1]!, paint: (s) => strike(muted(s)) });
      i += st[0].length;
      continue;
    }
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      flush();
      segs.push({ t: link[1]!, paint: (s) => bold(text(s)) });
      segs.push({ t: ` (${link[2]!})`, paint: faint });
      i += link[0].length;
      continue;
    }
    buf += src[i];
    i++;
  }
  flush();
  return segs;
}

/**
 * Greedy word-wrap over styled segments. Returns fully-styled lines whose
 * visible width never exceeds `width`; `hang` indents continuation lines
 * (hanging indent for list items).
 */
/** One unbreakable wrap unit: styled pieces glued edge-to-edge (`code`+"," etc.). */
interface Unit {
  pieces: Seg[];
  len: number;
}

/** Explode styled segments into wrap units, gluing chunks not separated by
 *  whitespace in the source — so `` `dir`. `` renders "dir." not "dir .". */
function toUnits(segs: Seg[]): Unit[] {
  const units: Unit[] = [];
  let open = false; // the previous token ended flush against this boundary
  for (const seg of segs) {
    for (const tok of seg.t.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) {
        open = false;
        continue;
      }
      if (open && units.length) {
        const u = units[units.length - 1]!;
        u.pieces.push({ t: tok, paint: seg.paint });
        u.len += tok.length;
      } else {
        units.push({ pieces: [{ t: tok, paint: seg.paint }], len: tok.length });
      }
      open = true;
    }
    if (/\s$/.test(seg.t)) open = false;
  }
  return units;
}

/** Slice an over-wide unit into ≤`max`-char chunks, each piece keeping its paint. */
function splitUnit(u: Unit, max: number): Unit[] {
  const out: Unit[] = [];
  let cur: Unit = { pieces: [], len: 0 };
  for (const p of u.pieces) {
    let t = p.t;
    while (t.length > 0) {
      const room = max - cur.len;
      if (room <= 0) {
        out.push(cur);
        cur = { pieces: [], len: 0 };
        continue;
      }
      const take = t.slice(0, room);
      cur.pieces.push({ t: take, paint: p.paint });
      cur.len += take.length;
      t = t.slice(take.length);
    }
  }
  if (cur.len > 0) out.push(cur);
  return out;
}

export function wrapInline(src: string, width: number, hang = ""): string[] {
  const maxChunk = Math.max(4, width - hang.length);
  const units = toUnits(parseInline(src)).flatMap((u) =>
    u.len > maxChunk ? splitUnit(u, maxChunk) : [u],
  );
  if (units.length === 0) return [""];

  const paintUnit = (u: Unit) => u.pieces.map((p) => p.paint(p.t)).join("");
  const lines: string[] = [];
  let parts: string[] = []; // styled units on the current line
  let len = 0; // their visible length, separators included
  const avail = () => width - (lines.length === 0 ? 0 : hang.length);
  const flush = () => {
    lines.push((lines.length === 0 ? "" : hang) + parts.join(" "));
    parts = [];
    len = 0;
  };
  for (const u of units) {
    if (parts.length && len + 1 + u.len > avail()) flush();
    len += (parts.length ? 1 : 0) + u.len;
    parts.push(paintUnit(u));
  }
  if (parts.length) flush();
  return lines.length ? lines : [""];
}

// ── block-level rendering ──

/** Render a markdown document to themed terminal lines. */
export function renderMarkdown(md: string, opts: MarkdownOpts = {}): string[] {
  const indent = opts.indent ?? "  ";
  const width = Math.max(24, (opts.width ?? Math.min(termWidth() - 2, 100)) - indent.length);
  const out: string[] = [];
  const src = md.replace(/\r\n/g, "\n").split("\n");

  let inFence = false;
  let fenceMark = "```";
  let lastBlank = true; // collapse runs of blank lines

  const emit = (ln: string) => {
    out.push(indent + ln);
    lastBlank = false;
  };
  const blank = () => {
    if (!lastBlank) out.push("");
    lastBlank = true;
  };

  for (let li = 0; li < src.length; li++) {
    const raw = src[li]!;

    // ── fenced code ──
    const fence = raw.match(/^\s*(```+|~~~+)\s*(\S+)?\s*$/);
    if (fence && !inFence) {
      inFence = true;
      fenceMark = fence[1]!.startsWith("~") ? "~~~" : "```";
      blank();
      const lang = fence[2] ? faint(fence[2]) : "";
      emit(`${lineColor("╭─")} ${lang}`);
      continue;
    }
    if (inFence) {
      if (raw.trim().startsWith(fenceMark)) {
        inFence = false;
        emit(lineColor("╰─"));
        blank();
        continue;
      }
      // Code is the record: verbatim, guttered, hard-cut to the column.
      const codeWidth = width - 2;
      let ln = raw.replace(/\t/g, "  ");
      do {
        emit(`${lineColor("│")} ${info(ln.slice(0, codeWidth))}`);
        ln = ln.slice(codeWidth);
      } while (ln.length > 0);
      continue;
    }

    const t = raw.trim();

    if (t === "") {
      blank();
      continue;
    }

    // ── horizontal rule ──
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blank();
      emit(lineColor("─".repeat(Math.min(width, 40))));
      blank();
      continue;
    }

    // ── headings ──
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      // Headings are set as type, not markup — drop any inline markers.
      const title = h[2]!
        .replace(/#+\s*$/, "")
        .replace(/\*\*|__|~~|`/g, "")
        .trim();
      blank();
      emit(bold(text(title.slice(0, width))));
      if (level <= 2) emit(lineColor("─".repeat(Math.max(4, Math.min(title.length, width)))));
      lastBlank = false;
      continue;
    }

    // ── blockquote ──
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      for (const ln of wrapInline(bq[1]!, width - 2))
        emit(`${lineColor("▏")} ${muted(stripAnsi(ln))}`);
      continue;
    }

    // ── list items (unordered + ordered), nesting via leading spaces ──
    const ul = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = raw.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/);
    if (ul || ol) {
      const lead = " ".repeat(Math.min((ul ?? ol)![1]!.length, 8));
      const marker = ul ? muted("•") : warn(`${ol![2]!}.`);
      const markerW = ul ? 1 : ol![2]!.length + 1;
      const body = ul ? ul[2]! : ol![3]!;
      const hang = lead + " ".repeat(markerW + 1);
      const wrapped = wrapInline(body, width, hang);
      emit(`${lead}${marker} ${wrapped[0] ?? ""}`);
      for (const ln of wrapped.slice(1)) emit(ln);
      continue;
    }

    // ── table rows: keep mono alignment, tint the frame ──
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s\-:|]+\|\s*$/.test(raw)) {
        emit(lineColor(t.slice(0, width)));
      } else {
        emit(text(t.slice(0, width)).replace(/\|/g, lineColor("|")));
      }
      continue;
    }

    // ── paragraph (merge soft-wrapped source lines into one flow) ──
    let para = t;
    while (li + 1 < src.length) {
      const nxt = src[li + 1]!;
      const nt = nxt.trim();
      if (
        nt === "" ||
        /^(#{1,6})\s/.test(nt) ||
        /^\s*(```+|~~~+)/.test(nxt) ||
        /^\s*>/.test(nxt) ||
        /^(\s*)[-*+]\s+/.test(nxt) ||
        /^(\s*)\d{1,3}[.)]\s+/.test(nxt) ||
        /^\s*\|.*\|\s*$/.test(nxt) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nt)
      ) {
        break;
      }
      para += " " + nt;
      li++;
    }
    for (const ln of wrapInline(para, width)) emit(ln);
  }

  // Close an unterminated fence so the frame never dangles.
  if (inFence) emit(lineColor("╰─"));

  // Trim leading/trailing blanks.
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}
