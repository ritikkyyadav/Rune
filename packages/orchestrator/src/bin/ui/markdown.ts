// --- Markdown -> ANSI (the response voice) ---
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
  codeSurface,
  panel,
} from "./theme";
import { langOfLabel, paintCode, type CodeLang } from "./code-paint";
import { glyph } from "./glyphs";
import { termWidth } from "./render";

const ITALIC_ON = "\x1b[3m";
const STRIKE_ON = "\x1b[9m";
const STYLE_OFF = "\x1b[0m";

const italic = (v: string): string => (colorEnabled ? `${ITALIC_ON}${v}${STYLE_OFF}` : v);
const strike = (v: string): string => (colorEnabled ? `${STRIKE_ON}${v}${STYLE_OFF}` : v);

/** The customizer's response voice: the headline is bold primary text, the
 * detail is the secondary tone, and plain prose elsewhere is primary. */
export type MarkdownTone = "primary" | "secondary" | "headline";

export interface MarkdownOpts {
  /**
   * Total column budget for each rendered line, INDENT INCLUDED -- this
   * renderer subtracts `indent` itself, so a caller passes the whole line's
   * budget, not the room left after the indent. Default: the terminal.
   */
  width?: number;
  /** Left indent prepended to every line. Default "  ". */
  indent?: string;
  /** Base paint for plain prose. Default "primary". */
  tone?: MarkdownTone;
}

// -- inline styling --
// Parse a single line of prose into styled segments, then wrap segment-aware so
// a style never leaks across a line break (each chunk is styled independently).

interface Seg {
  t: string;
  paint: (s: string) => string;
}

type Painter = (s: string) => string;

const TONE_PAINT: Record<MarkdownTone, Painter> = {
  primary: (s) => text(s),
  secondary: (s) => muted(s),
  headline: (s) => bold(text(s)),
};

/** Inline `code` as the v2 code tag: primary weight on the bar surface. */
const codeTag = (s: string): string => panel(bold(text(s)));

const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether an underscore run at `start` is emphasis rather than part of an
 * identifier. CommonMark's rule, and the one that matters most here: `_` inside
 * a word never opens or closes emphasis -- otherwise `content_block_stop` and
 * `read_file`, which this product prints constantly, come out as
 * `contentblockstop` with the underscores silently eaten.
 */
function flanks(src: string, start: number, length: number): boolean {
  const before = start > 0 ? src[start - 1]! : "";
  const after = src[start + length] ?? "";
  return !WORD.test(before) && !WORD.test(after);
}

/** `**bold**`, `*em*`, `_em_`, `` `code` ``, `~~strike~~`, `[label](url)`. */
export function parseInline(src: string, tone: MarkdownTone = "primary"): Seg[] {
  const plain = TONE_PAINT[tone];
  const segs: Seg[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) segs.push({ t: buf, paint: plain });
    buf = "";
  };
  while (i < src.length) {
    const rest = src.slice(i);
    // inline code -- highest precedence, protects its contents
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      flush();
      segs.push({ t: code[1]!, paint: codeTag });
      i += code[0].length;
      continue;
    }
    const star2 = rest.match(/^\*\*([^*]+)\*\*/);
    const under2 = star2 ? null : rest.match(/^__([^_]+)__/);
    const boldm = star2 ?? (under2 && flanks(src, i, under2[0].length) ? under2 : null);
    if (boldm) {
      flush();
      segs.push({ t: boldm[1]!, paint: (s) => bold(text(s)) });
      i += boldm[0].length;
      continue;
    }
    const star1 = rest.match(/^\*([^*\s][^*]*)\*/);
    const under1 = star1 ? null : rest.match(/^_([^_\s][^_]*)_/);
    const em = star1 ?? (under1 && flanks(src, i, under1[0].length) ? under1 : null);
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
 *  whitespace in the source -- so `` `dir`. `` renders "dir." not "dir .". */
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

/** Slice an over-wide unit into <=`max`-char chunks, each piece keeping its paint. */
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

export function wrapInline(
  src: string,
  width: number,
  hang = "",
  tone: MarkdownTone = "primary",
): string[] {
  const maxChunk = Math.max(4, width - hang.length);
  const units = toUnits(parseInline(src, tone)).flatMap((u) =>
    u.len > maxChunk ? splitUnit(u, maxChunk) : [u],
  );
  if (units.length === 0) return [""];

  const paintUnit = (u: Unit) => u.pieces.map((p) => p.paint(p.t)).join("");
  const lines: string[] = [];
  let parts: string[] = []; // styled units on the current line
  let len = 0; // their visible length, separators included
  // Every line pays for the hang, the first one included. It does not carry
  // `hang` in its own string -- the list caller prepends the marker instead --
  // but the marker is sized to exactly hang.length, so the first line lands in
  // the same content column as its continuations and costs the same. Budgeting
  // it at the full `width` overflowed the measure by the marker's width on
  // every bullet; with a ceiling in place that overflow stayed under the window
  // and went unseen, and the moment the measure followed the terminal it began
  // pushing list items onto the last cell -- where the line soft-wraps and the
  // pinned composer's cursor math desyncs. splitUnit()'s maxChunk above has
  // always subtracted the hang; this is the same rule, applied consistently.
  const avail = () => width - hang.length;
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

// -- block-level rendering --

/** Render a markdown document to themed terminal lines. */
export function renderMarkdown(md: string, opts: MarkdownOpts = {}): string[] {
  const indent = opts.indent ?? "  ";
  const tone = opts.tone ?? "primary";
  // No ceiling. This defaulted to min(term - 2, 100), which on a wide window
  // set an answer's paragraphs, lists and fenced code at 100 columns while the
  // rails and rules around them ran to the edge -- the same half-drawn frame
  // that flow.proseWidth() was capping into existence. Callers that own a
  // narrower region still pass their own budget; the default follows the window.
  const width = Math.max(24, (opts.width ?? termWidth() - 2) - indent.length);
  const out: string[] = [];
  const src = md.replace(/\r\n?/g, "\n").split("\n");

  const codeRow = (plainText: string, painted: string): string =>
    codeSurface(`${painted}${" ".repeat(Math.max(0, width - plainText.length))}`);

  let inFence = false;
  let fenceMark = "```";
  let fenceLang: CodeLang = null;
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

    // -- fenced code --
    const fence = raw.match(/^\s*(```+|~~~+)\s*(\S+)?\s*$/);
    if (fence && !inFence) {
      inFence = true;
      fenceMark = fence[1]!.startsWith("~") ? "~~~" : "```";
      blank();
      // The language is a label, not a frame. A box around code buys nothing a
      // blank line and a change of weight does not already buy.
      const langRaw = fence[2] ?? "";
      fenceLang = langOfLabel(langRaw);
      if (langRaw) emit(faint(langRaw));
      continue;
    }
    if (inFence) {
      if (raw.trim().startsWith(fenceMark)) {
        inFence = false;
        blank();
        continue;
      }
      // Code is the record: verbatim, hard-cut to the column, and set brighter
      // than the prose around it because the command is the part you copy.
      // Painted by the fence's own label (```ts, ```python, ```bash ...) with
      // the same painter the diffs use, so a block in an answer reads like
      // the editor it will be pasted into. An unlabelled block stays plain --
      // guessing a language mis-tints words, and plain is never wrong.
      let ln = raw.replace(/\t/g, "  ");
      do {
        const chunk = ln.slice(0, width);
        if (fenceLang) emit(paintCode(chunk, fenceLang, text));
        else emit(chunk.trimStart().startsWith("#") ? muted(chunk) : text(chunk));
        ln = ln.slice(width);
      } while (ln.length > 0);
      continue;
    }

    const t = raw.trim();

    if (t === "") {
      blank();
      continue;
    }

    // -- horizontal rule --
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blank();
      emit(lineColor("-".repeat(Math.min(width, 40))));
      blank();
      continue;
    }

    // -- headings --
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      // Headings are set as type, not markup -- drop any inline markers.
      const title = h[2]!
        .replace(/#+\s*$/, "")
        .replace(/\*\*|__|~~|`/g, "")
        .trim();
      blank();
      emit(bold(text(title.slice(0, width))));
      if (level <= 2) emit(lineColor("-".repeat(Math.max(4, Math.min(title.length, width)))));
      lastBlank = false;
      continue;
    }

    // -- blockquote --
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      for (const ln of wrapInline(bq[1]!, width - 2, "", tone))
        emit(`${lineColor(glyph("gutter"))} ${muted(stripAnsi(ln))}`);
      continue;
    }

    // -- list items (unordered + ordered), nesting via leading spaces --
    const ul = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = raw.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/);
    if (ul || ol) {
      const lead = " ".repeat(Math.min((ul ?? ol)![1]!.length, 8));
      const marker = ul ? muted(glyph("observed")) : warn(`${ol![2]!}.`);
      const markerW = ul ? 1 : ol![2]!.length + 1;
      const body = ul ? ul[2]! : ol![3]!;
      const hang = lead + " ".repeat(markerW + 1);
      const wrapped = wrapInline(body, width, hang, tone);
      emit(`${lead}${marker} ${wrapped[0] ?? ""}`);
      for (const ln of wrapped.slice(1)) emit(ln);
      continue;
    }

    // -- table rows: keep mono alignment, tint the frame --
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s\-:|]+\|\s*$/.test(raw)) {
        emit(lineColor(t.slice(0, width)));
      } else {
        emit(TONE_PAINT[tone](t.slice(0, width)).replace(/\|/g, lineColor("|")));
      }
      continue;
    }

    // -- paragraph (merge soft-wrapped source lines into one flow) --
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
    for (const ln of wrapInline(para, width, "", tone)) emit(ln);
  }

  // Trim leading/trailing blanks.
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}
