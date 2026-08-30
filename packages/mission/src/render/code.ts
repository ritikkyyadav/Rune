// ─── Gear · code output ───
// Four shapes, and the rule that separates them from everything else on the screen:
// change lives in the gutter, the sign column and the row tint; syntax lives in the
// code text. Different scale, different position, no argument.
//
// The highlighter has six classes and five of them — string, number, comment,
// punctuation, identifier — are *lexical* facts that hold in essentially every
// language ever written, and in the ones not written yet. Only `keyword` needs a
// per-language word list, and a language the list has never heard of simply gets an
// empty one: you still see strings, numbers and comments, which is most of the value.
// It can be **less helpful** about a language invented in 2040. It cannot be **wrong**
// about it — which was the whole objection to shipping a highlighter at all.

import { type Row, type Span } from "./row";

/**
 * One flat list, not a per-language grammar. A word that is a keyword somewhere and an
 * identifier elsewhere costs a slightly-too-violet identifier, which is a cosmetic
 * error. A parser that is confidently wrong about structure is not.
 */
const KEYWORDS = new Set(
  (
    "const let var function return if else for while do import from export default " +
    "class new await async type interface enum extends implements public private " +
    "protected static readonly void never unknown throw try catch finally switch " +
    "case break continue delete typeof instanceof in of not and or true false null " +
    "undefined none this self super def lambda pass raise with as yield elif " +
    "fn mut pub struct impl trait use mod match where func package defer chan " +
    "select range string number boolean int float bool str list dict"
  ).split(" "),
);

/** Tokenise one line. Line-scoped on purpose: no state carries across rows, so a row
 *  can be rendered on its own and scrollback can be re-rendered out of order. */
export function tokenize(src: string): Span[] {
  const out: Span[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: buf });
      buf = "";
    }
  };

  while (i < src.length) {
    const ch = src[i]!;
    const two = src.slice(i, i + 2);

    if (two === "//" || two === "/*" || two === "--" || ch === "#") {
      flush();
      out.push({ t: src.slice(i), c: "cm" });
      return out; // comments run to end of line, in every language that has them
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      flush();
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      out.push({ t: src.slice(i, j), c: "str" });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? " ")) {
      flush();
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXbo._]/.test(src[j]!)) j++;
      out.push({ t: src.slice(i, j), c: "num" });
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) {
        flush();
        out.push({ t: word, c: "kw" });
      } else buf += word; // identifiers inherit your foreground. never styled.
      i = j;
      continue;
    }

    if (/[{}()[\]<>=+\-*/%!&|?:;,.]/.test(ch)) {
      flush();
      out.push({ t: ch, c: "pu" });
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

export interface DiffLine {
  line: number;
  sign: " " | "+" | "-";
  text: string;
}

/** A diff row: rail, line number, sign column, code. The first three are the change. */
export function diffRow(rail: string, { line, sign, text }: DiffLine): Row {
  const spans: Span[] = [];
  if (rail) spans.push({ t: " " }, { t: rail, c: "dim" });
  spans.push({ t: String(line).padStart(6) + " ", c: "dim" });
  spans.push(
    sign === "+" ? { t: "+ ", c: "add" } : sign === "-" ? { t: "- ", c: "del" } : { t: "  " },
  );
  spans.push(...tokenize(text));
  return {
    spans,
    region: "code",
    // One source line is always exactly one terminal row.
    clip: "truncate",
    tint: sign === "+" ? "add" : sign === "-" ? "del" : undefined,
  };
}

/** A snippet: no gutter, never truncated, still coloured. Something you are meant to run. */
export const snippet = (indent: string, src: string): Row => ({
  spans: [{ t: indent }, ...tokenize(src)],
  region: "code",
  // Opts out of clipping entirely: it survives a mouse drag and pastes clean.
  clip: "never",
});

/** The rule: nothing larger than twelve rows enters the stream without a keystroke. */
export const WINDOW_ROWS = 12;

/**
 * A window over a diff: at most twelve rows, elision *counted* rather than implied,
 * and the head kept because a hunk's first rows are the ones that place it.
 */
export function window(lines: DiffLine[], rail = "", max = WINDOW_ROWS): Array<Row | null> {
  if (lines.length <= max) return lines.map((l) => diffRow(rail, l));
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head).map((l) => diffRow(rail, l)),
    {
      spans: [{ t: `${rail ? " " + rail : ""}      ⋯ ${hidden} unchanged lines`, c: "dim" }],
    },
    ...lines.slice(lines.length - tail).map((l) => diffRow(rail, l)),
  ];
}

/**
 * Foreign output — pytest chose this formatting, not us. Framed so its edges are
 * unambiguous, capped, and the **tail** is what survives, because that is where a
 * runner puts its failures.
 */
export function foreign(
  command: string,
  lines: string[],
  opts: { rail?: string; max?: number } = {},
): Row[] {
  const rail = opts.rail ? ` ${opts.rail}    ` : "   ";
  const max = opts.max ?? 6;
  const kept = lines.slice(-max);
  const hidden = lines.length - kept.length;
  const rows: Row[] = [{ spans: [{ t: `${rail}┌ ${command}`, c: "dim" }] }];
  if (hidden > 0)
    rows.push({
      spans: [
        { t: `${rail}│ `, c: "dim" },
        { t: `⋯ ${hidden} lines above`, c: "dim" },
      ],
    });
  for (const l of kept.slice(0, -1))
    rows.push({ spans: [{ t: `${rail}│ `, c: "dim" }, ...markFailure(l)] });
  const last = kept[kept.length - 1];
  if (last !== undefined) rows.push({ spans: [{ t: `${rail}└ ${last}`, c: "dim" }] });
  return rows;
}

/** The one thing we read in foreign output: whether a line announces a failure. */
function markFailure(line: string): Span[] {
  const m = /^(\s*)(FAILED|ERROR|FAIL)\b(.*)$/.exec(line);
  if (!m) return [{ t: line }];
  return [{ t: m[1]! }, { t: m[2]!, c: "danger" }, { t: m[3]! }];
}

/**
 * A stack trace: your frames kept, everyone else's counted. A run of vendor frames is
 * one row saying how many there were, which is the only thing anyone reads them for.
 */
export function stack(
  frames: Array<{ location: string; fn: string; vendor: boolean }>,
  indent = "   ",
): Row[] {
  const rows: Row[] = [];
  let vendorRun = 0;
  const flush = () => {
    if (vendorRun) {
      rows.push({ spans: [{ t: `${indent}⋯ ${vendorRun} frames in node_modules`, c: "dim" }] });
      vendorRun = 0;
    }
  };
  for (const f of frames) {
    if (f.vendor) {
      vendorRun++;
      continue;
    }
    flush();
    rows.push({
      spans: [{ t: indent }, { t: f.location, c: "strong" }, { t: "  " + f.fn, c: "dim" }],
    });
  }
  flush();
  return rows;
}
