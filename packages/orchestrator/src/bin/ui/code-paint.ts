// --- Code paint: syntax colour for evidence rows ---
// A diff row is code the reader is being asked to judge, and code is easier to
// judge with the same cues an editor gives it. This is the smallest painter
// that earns that: comments, strings, numbers and keywords, per line, with no
// cross-line state. It deliberately stays inside Flow's six colour roles --
// comment=faint, string=ok, number=warn, keyword=accent, the rest in the
// caller's base tone -- so every theme that exists keeps working and no new
// pigment enters the product.
//
// Wrong-language worst case is a mis-tinted word, never a broken line: the
// painter recolours, it does not rewrite, and `paintCode(line).stripAnsi ===
// line` is the invariant the tests hold it to.

import { faint, info, ok, warn } from "./theme";

export type CodeLang = "ts" | "py" | "rs" | "go" | "sh" | "json" | "css" | "sql" | null;

const EXT_LANG: Record<string, CodeLang> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  mts: "ts",
  cts: "ts",
  py: "py",
  pyi: "py",
  rs: "rs",
  go: "go",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  sql: "sql",
  toml: "sh",
  yaml: "sh",
  yml: "sh",
};

/** The language a path's extension implies, or null when we should not guess. */
export function langOfPath(path: string): CodeLang {
  const ext = /\.([A-Za-z]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && EXT_LANG[ext]) || null;
}

const KEYWORDS: Record<Exclude<CodeLang, null>, ReadonlySet<string>> = {
  ts: new Set(
    (
      "const let var function return if else for while do switch case break continue new " +
      "class extends implements interface type import export from default async await try " +
      "catch finally throw yield typeof instanceof in of delete void null undefined true false " +
      "this super static readonly public private protected abstract enum namespace declare as " +
      "satisfies keyof infer never unknown any get set"
    ).split(" "),
  ),
  py: new Set(
    (
      "def return if elif else for while import from as class try except finally raise with " +
      "lambda yield global nonlocal pass break continue and or not in is None True False " +
      "async await assert del match case self"
    ).split(" "),
  ),
  rs: new Set(
    (
      "fn let mut pub use mod struct enum impl trait for while loop if else match return " +
      "crate self super where async await move ref dyn const static type unsafe extern in as " +
      "break continue true false Some None Ok Err"
    ).split(" "),
  ),
  go: new Set(
    (
      "func var const type struct interface map chan go defer return if else for range " +
      "switch case default break continue package import select fallthrough goto nil true false"
    ).split(" "),
  ),
  sh: new Set(
    (
      "if then else elif fi for while until do done case esac function return local export " +
      "readonly source in true false"
    ).split(" "),
  ),
  json: new Set(["true", "false", "null"]),
  css: new Set(["important", "inherit", "initial", "unset", "auto", "none"]),
  sql: new Set(
    (
      "select from where insert into values update set delete create table index view drop " +
      "alter join left right inner outer on group by order having limit offset union all " +
      "distinct as and or not null primary key foreign references default"
    ).split(" "),
  ),
};

/** How a line comment starts, per language. `/*` is handled for the C family
 *  as start-of-comment-to-EOL -- good enough for a display painter. */
const LINE_COMMENT: Record<Exclude<CodeLang, null>, string[]> = {
  ts: ["//", "/*", "*/", "*"],
  py: ["#"],
  rs: ["//", "/*", "*/", "*"],
  go: ["//", "/*", "*/", "*"],
  sh: ["#"],
  json: [],
  css: ["/*", "*/", "*"],
  sql: ["--"],
};

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const WORD = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** True when the trimmed line opens as a comment for this language. A `*`
 *  opener only counts as a continuation cue for the C family block style. */
function opensComment(trimmed: string, lang: Exclude<CodeLang, null>): boolean {
  for (const mark of LINE_COMMENT[lang]) {
    if (mark === "*") {
      if (trimmed.startsWith("* ") || trimmed === "*") return true;
    } else if (trimmed.startsWith(mark)) {
      return true;
    }
  }
  return false;
}

/**
 * Paint one line of code. `base` colours everything that is not a recognised
 * token, so an add row can read primary while a context row recedes -- the
 * painter never decides the row's tone, only its accents. Unknown language
 * (`null`) paints everything with `base`, which is exactly what the previous
 * renderer did for every language.
 */
export function paintCode(line: string, lang: CodeLang, base: (s: string) => string): string {
  if (!lang) return base(line);
  const trimmed = line.trimStart();
  if (opensComment(trimmed, lang)) return faint(line);

  let out = "";
  let plain = "";
  const flush = () => {
    if (plain) out += base(plain);
    plain = "";
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    // Comment openers mid-line: the rest of the line is the comment.
    const commentAt = LINE_COMMENT[lang].some((m) => m !== "*" && m !== "*/" && rest.startsWith(m));
    if (commentAt) {
      flush();
      out += faint(rest);
      return out;
    }
    const ch = line[i]!;
    // Strings, with escapes. An unterminated string paints to end of line --
    // this is a per-line painter and the honest rendering of a split literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      flush();
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === ch) {
          j++;
          break;
        } else j++;
      }
      out += ok(line.slice(i, j));
      i = j;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? "")) {
      flush();
      out += warn(num[0]);
      i += num[0].length;
      continue;
    }
    const word = WORD.exec(rest);
    if (word) {
      if (KEYWORDS[lang].has(word[0])) {
        flush();
        out += info(word[0]);
      } else {
        plain += word[0];
      }
      i += word[0].length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}
