// ─── Gear · the row ───
// A miniature renderer with one rule that everything else hangs off: a span carries a
// semantic *role*, never a colour. Colour is chosen later, from the role, by whatever
// the terminal turned out to be able to do — which is why switching the whole product
// to monochrome loses nothing.
//
// The other rule that matters is ordering: **padding is computed after the ASCII
// fold**, so a row lands in the same columns whether it is UTF-8 or a serial console.
// Fold first, measure second, pad third. Reverse those and every right-hand column
// drifts by the number of multi-byte glyphs on the line.

import { type Caps } from "./caps";
import { pulseGlyph } from "./pulse";

/** The six chrome roles. Every one of them is *state*, and state must survive NO_COLOR. */
export type ChromeRole =
  | "dim"
  | "accent"
  | "strong"
  | "ok"
  | "warn"
  | "danger"
  /** emphasis the way a terminal does it: reverse video, not a seventh hue */
  | "reverse";

/** The six code tokens. These carry nothing — which is exactly why they may be colour. */
export type CodeRole = "kw" | "str" | "num" | "cm" | "pu" | "add" | "del";

export type Role = ChromeRole | CodeRole;

const CODE_ROLES = new Set<string>(["kw", "str", "num", "cm", "pu"]);

export type Span =
  | { t: string; c?: Role }
  /** expands to push everything after it to the right margin */
  | { pad: true }
  /** the pulse, at a level the caller measured. never a clock. */
  | { pulse: number }
  /** a flat pulse: nothing is arriving */
  | { quiet: true };

export interface Row {
  spans: Span[];
  /** a row tint is a 7% blend of the terminal's own ground — optional, and says so */
  tint?: "add" | "del";
  /** live rows are the only ones that redraw. everything else is written once. */
  live?: boolean;
  /**
   * Code regions are the one place a hue may appear that means nothing. Marking the
   * region is what keeps syntax colour from leaking into chrome, where every colour
   * means something.
   */
  region?: "code";
  /**
   * Whitespace is semantic in code, so one source line is always exactly one terminal
   * row: `truncate` clips at the measure rather than wrapping, because a wrapped line
   * loses its alignment with the number gutter — and that alignment is the only reason
   * a diff can be read by scanning down a column. `never` is for snippets, which are
   * meant to be pasted: a `…` in the middle of a shell command is a broken command.
   */
  clip?: "truncate" | "never";
}

/**
 * The 7-bit twin of every glyph in the design. A row folded through this table is
 * the same number of columns wide as the one that wasn't, which is what lets the
 * padding maths run once for both.
 */
export const FOLD: Record<string, string> = {
  "›": ">",
  "●": "*",
  "○": "o",
  "◐": "o",
  "⎿": "-",
  "└": "`",
  "│": "|",
  "┌": "+",
  "┤": "|",
  "├": "|",
  "─": "-",
  "═": "=",
  "✓": "+",
  "✗": "x",
  "·": ".",
  "◆": "#",
  "◇": "?",
  "▸": "!",
  "⤴": "^",
  "→": ">",
  "←": "<",
  "↑": "^",
  "↓": "v",
  "⋯": "~",
  "▌": "_",
  "↻": "@",
  "⊘": "/",
  "×": "x",
  "−": "-",
  "–": "-",
  "▶": ">",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "▁": "_",
  "▂": ".",
  "▃": ".",
  "▄": "-",
  "▅": "-",
  "▆": "=",
  "▇": "=",
  "█": "#",
};

/** Multi-character folds, applied before the per-character table. */
const FOLD_LONG: Array<[string, string]> = [
  ["…", "..."],
  ["⇥", "tab"],
  ["⏎", "ret"],
  ["⌃", "^"],
  ["—", "--"],
];

/**
 * Fold *data*, not just glyphs. Real content contains em dashes, curly quotes, `José`
 * and CJK; writing them raw to an ASCII sink yields mojibake or an encode error. So:
 * named punctuation first, then NFKD to strip diacritics, then `?` for the genuinely
 * unrepresentable — a visible gap beats silent corruption.
 */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const long = FOLD_LONG.find(([from]) => from === ch);
    if (long) {
      out += long[1];
      continue;
    }
    const mapped = FOLD[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (ch.codePointAt(0)! <= 126) {
      out += ch;
      continue;
    }
    const stripped = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += stripped.length && /^[\x20-\x7e]+$/.test(stripped) ? stripped : "?";
  }
  return out;
}

// ─── the glyph budget ───
// Two shapes carry the whole product. Round is work; diamond is judgement. Status is
// carried by the *word* beside the glyph, never by a new symbol — which is why this
// table never needs a fourteenth entry.

export const GLYPH = {
  queued: "○",
  running: "◌", // stands in for the pulse cell
  held: "✓",
  failed: "✗",
  off: "!",
  again: "↻",
  blocked: "⊘",
  decision: "◇",
  finding: "◆",
  agent: "●",
  child: "⎿",
  gate: "▸",
} as const;

/** The claim column: one character, in the last column of the terminal, always. */
export const RUNG_GLYPH = {
  suspected: "~",
  observed: "·",
  reproduced: "=",
  verified: "✓",
} as const;

// ─── the authoring notation ───
// Figures, holds and fixed copy are written in the same shorthand the design document
// uses, so a frame can move between the spec and the program without being retyped:
//   §d{dim} §a{accent} §k{strong} §o{ok} §y{warn} §x{danger} §v{reverse}
//   ¶ pushes the rest of the row to the right margin
//   ◌ is the pulse · ◍ is a flat pulse

const MARK: Record<string, Role> = {
  d: "dim",
  a: "accent",
  k: "strong",
  o: "ok",
  y: "warn",
  x: "danger",
  v: "reverse",
};

export function L(source: string, opts: { level?: number } = {}): Row {
  const spans: Span[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      spans.push({ t: buf });
      buf = "";
    }
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const role = MARK[source[i + 1] ?? ""];
    if (ch === "§" && role && source[i + 2] === "{") {
      flush();
      let j = i + 3;
      let depth = 1;
      let text = "";
      while (j < source.length) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}" && --depth === 0) break;
        text += source[j];
        j++;
      }
      spans.push({ t: text, c: role });
      i = j;
    } else if (ch === "¶") {
      flush();
      spans.push({ pad: true });
    } else if (ch === "◌") {
      flush();
      spans.push({ pulse: opts.level ?? 4 });
    } else if (ch === "◍") {
      flush();
      spans.push({ quiet: true });
    } else buf += ch;
  }
  flush();
  return { spans };
}

/** Constructors, so `pad: true` and a role never widen to `boolean` / `string`. */
export const PAD: Span = { pad: true };
export const sp = (t: string, c?: Role): Span => ({ t, c });

/** A blank row. `null` in a row list means the same thing and reads better in figures. */
export const BLANK: Row = { spans: [] };

/** A rule that always lands on the measure, whatever the caps say. */
export const rule = (caps: Caps, ch = "─"): Row => ({
  spans: [{ t: ch.repeat(caps.measure), c: "dim" }],
});

export const repeat = (n: number, ch = "─"): string => ch.repeat(Math.max(0, n));

/**
 * Resolve a row to plain spans at a given width: fold, then measure, then distribute
 * the slack across every `¶`. Returns spans whose `t` is final — the ANSI layer only
 * has to decide colour.
 */
export function layout(row: Row, caps: Caps): Array<{ t: string; c?: Role }> {
  const width = caps.measure;
  const resolved = row.spans.map((s) => {
    if ("pad" in s) return s;
    if ("pulse" in s) return { t: pulseGlyph(s.pulse, caps.pulse), c: "accent" as Role };
    if ("quiet" in s) return { t: pulseGlyph(0, caps.pulse), c: "dim" as Role };
    return { t: caps.glyphs === "ascii" ? fold(s.t) : s.t, c: s.c };
  });

  const pads = resolved.filter((s) => "pad" in s).length;
  if (!pads) return clip(resolved as Array<{ t: string; c?: Role }>, row, caps);

  const used = resolved.reduce((n, s) => n + ("pad" in s ? 0 : s.t.length), 0);
  const slack = Math.max(pads, width - used);
  const per = Math.floor(slack / pads);
  let extra = slack - per * pads;
  return clip(
    resolved.map((s) =>
      "pad" in s ? { t: " ".repeat(per + (extra-- > 0 ? 1 : 0)) } : s,
    ) as Array<{ t: string; c?: Role }>,
    row,
    caps,
  );
}

/** Clip after the fold and after the padding, so the cut lands on a real column. */
function clip(
  spans: Array<{ t: string; c?: Role }>,
  row: Row,
  caps: Caps,
): Array<{ t: string; c?: Role }> {
  if (row.clip !== "truncate") return spans;
  const mark = caps.glyphs === "ascii" ? "..." : "…";
  const total = spans.reduce((n, s) => n + s.t.length, 0);
  if (total <= caps.measure) return spans;

  const budget = caps.measure - mark.length;
  const out: Array<{ t: string; c?: Role }> = [];
  let used = 0;
  for (const s of spans) {
    if (used + s.t.length <= budget) {
      out.push(s);
      used += s.t.length;
      continue;
    }
    const room = budget - used;
    if (room > 0) out.push({ t: s.t.slice(0, room), c: s.c });
    break;
  }
  out.push({ t: mark, c: "dim" });
  return out;
}

/** Break prose to a width on word boundaries. Code never comes through here. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length) out.push(line);
  return out.length ? out : [""];
}

/**
 * A row with a left side and a right-hand column. When the two do not fit on the
 * measure the metadata **drops to its own indented row**, where it is still in a
 * column and still scannable — it never gets squeezed, and the row never overflows.
 * This is the same rule that makes 58 columns work, applied at every width.
 */
export function pair(left: Span[], right: Span[], caps: Caps, indent = "     "): Row[] {
  const width = (spans: Span[]) =>
    spans.reduce(
      (n, s) => n + ("t" in s ? (caps.glyphs === "ascii" ? fold(s.t) : s.t).length : 1),
      0,
    );
  const l = width(left);
  const r = width(right);

  // Both fit: one row, the right-hand column pushed to the margin.
  if (l + r + 1 <= caps.measure) return [{ spans: [...left, PAD, ...right] }];

  /** The dropped metadata row — itself wrapped if the measure cannot hold it either. */
  const dropped = (): Row[] => {
    if (!r) return [];
    if (indent.length + r + 1 <= caps.measure) return [{ spans: [{ t: indent }, PAD, ...right] }];
    const first = right[0];
    if (!first || !("t" in first)) return [{ spans: [{ t: indent }, PAD, ...right] }];
    const restW = width(right.slice(1));
    const lines = wrapText(first.t, Math.max(8, caps.measure - indent.length - restW - 1));
    const out: Row[] = lines
      .slice(0, -1)
      .map((line) => ({ spans: [{ t: indent }, { ...first, t: line }] }));
    out.push({
      spans: [{ t: indent }, { ...first, t: lines[lines.length - 1]! }, PAD, ...right.slice(1)],
    });
    return out;
  };

  // Only the left fits: the metadata drops, still in a column, still scannable.
  if (l <= caps.measure) return [{ spans: left }, ...dropped()];

  // The left itself is too long: wrap its trailing prose under the fixed prefix, so
  // the glyphs and labels that place the row keep their columns. Code never reaches
  // here — it is truncated instead, because whitespace there is semantic.
  const last = left[left.length - 1];
  if (!last || !("t" in last)) return [{ spans: left }];
  // The prose span usually carries the indent that separates it from the glyph column.
  // Keep that indent with the prefix, or the first wrapped line loses its gutter and
  // the continuation lines sit under the wrong column.
  const lead = /^\s*/.exec(last.t)?.[0] ?? "";
  const body = last.t.slice(lead.length);
  const head = [...left.slice(0, -1), ...(lead ? [{ t: lead } as Span] : [])];
  const prefix = Math.min(width(head), Math.max(0, caps.measure - 8));
  const lines = wrapText(body, Math.max(8, caps.measure - prefix));
  const rows: Row[] = lines.map((line, i) =>
    i === 0
      ? { spans: [...head, { ...last, t: line }] }
      : { spans: [{ t: " ".repeat(prefix) }, { ...last, t: line }] },
  );
  rows.push(...dropped());
  return rows;
}

/** The plain text of a row, at the ladder's floor. What `| cat` and a pipe get. */
export const plainText = (row: Row, caps: Caps): string =>
  layout(row, caps)
    .map((s) => s.t)
    .join("")
    .replace(/\s+$/, "");

/**
 * Syntax colour may only appear inside a code region, because everywhere else on the
 * screen a colour means something and a design that lets the two meet has to make one
 * of them lose. This is that rule, enforced where it can actually be checked.
 */
export function assertColourBudget(row: Row): void {
  if (row.region === "code") return;
  for (const s of row.spans) {
    if ("t" in s && s.c && CODE_ROLES.has(s.c))
      throw new Error(`syntax role "${s.c}" outside a code region: ${JSON.stringify(s.t)}`);
  }
}
