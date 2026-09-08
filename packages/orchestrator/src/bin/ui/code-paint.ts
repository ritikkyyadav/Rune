// --- Code paint: syntax colour for evidence rows and fenced blocks ---
// A diff row is code the reader is being asked to judge, and code is easier to
// judge with the same cues an editor gives it. This is the painter that earns
// that: a per-line tokenizer with no cross-line state, classifying nine kinds
// of token (comment, string, number, keyword, constant, type, function,
// property, decorator) and painting each with the syntax palette in theme.ts
// (RUNE_SYNTAX in design-tokens.ts). Until 2026-09-05 it knew four classes and
// painted them inside the six chrome roles -- keywords in the accent, strings
// in the status green -- and every block read as one blue-and-grey texture.
//
// Wrong-language worst case is a mis-tinted word, never a broken line: the
// painter recolours, it does not rewrite, and `paintCode(line).stripAnsi ===
// line` is the invariant the tests hold it to. `tokenize` is exported pure so
// the classification can be tested without a tty.

import { syntax } from "./theme";
import type { RuneBaseName, SyntaxRole } from "@rune/shared";

export type CodeLang = "ts" | "py" | "rs" | "go" | "sh" | "json" | "css" | "sql" | "html" | null;

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
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  svelte: "html",
};

/** The language a path's extension implies, or null when we should not guess. */
export function langOfPath(path: string): CodeLang {
  const ext = /\.([A-Za-z]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && EXT_LANG[ext]) || null;
}

/** The language a markdown fence label names (```typescript, ```py, ```bash),
 *  or null for an unlabelled or unknown fence -- plain is never wrong. */
const LABEL_LANG: Record<string, CodeLang> = {
  typescript: "ts",
  javascript: "ts",
  python: "py",
  rust: "rs",
  golang: "go",
  shell: "sh",
  console: "sh",
  dockerfile: "sh",
  makefile: "sh",
  ini: "sh",
  env: "sh",
  jsx: "ts",
  tsx: "ts",
  vue: "html",
  xml: "html",
  svg: "html",
};
export function langOfLabel(label: string): CodeLang {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/^\{\.?|\}$/g, "");
  if (!key) return null;
  return LABEL_LANG[key] ?? EXT_LANG[key] ?? null;
}

type Lang = Exclude<CodeLang, null>;

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const KEYWORDS: Record<Lang, ReadonlySet<string>> = {
  ts: words(
    "const let var function return if else for while do switch case break continue new " +
      "class extends implements interface type import export from default async await try " +
      "catch finally throw yield typeof instanceof in of delete void " +
      "static readonly public private protected abstract enum namespace declare as " +
      "satisfies keyof infer never unknown any get set",
  ),
  py: words(
    "def return if elif else for while import from as class try except finally raise with " +
      "lambda yield global nonlocal pass break continue and or not in is " +
      "async await assert del match case",
  ),
  rs: words(
    "fn let mut pub use mod struct enum impl trait for while loop if else match return " +
      "crate super where async await move ref dyn const static type unsafe extern in as " +
      "break continue",
  ),
  go: words(
    "func var const type struct interface map chan go defer return if else for range " +
      "switch case default break continue package import select fallthrough goto",
  ),
  sh: words(
    "if then else elif fi for while until do done case esac function return local export " +
      "readonly source in",
  ),
  json: new Set(),
  css: words("important inherit initial unset"),
  sql: words(
    "select from where insert into values update set delete create table index view drop " +
      "alter join left right inner outer on group by order having limit offset union all " +
      "distinct as and or not primary key foreign references default with returning " +
      "exists between like case when then else end",
  ),
  html: new Set(),
};

/** Literal constants: the editor paints them apart from keywords. */
const CONSTANTS: Record<Lang, ReadonlySet<string>> = {
  ts: words("true false null undefined NaN Infinity this super"),
  py: words("None True False self cls"),
  rs: words("true false Some None Ok Err self Self"),
  go: words("nil true false iota"),
  sh: words("true false"),
  json: words("true false null"),
  css: words("auto none"),
  sql: words("null true false"),
  html: new Set(),
};

/** Languages where a Capitalised identifier is, by convention, a type. */
const CAPITALISED_TYPES: ReadonlySet<Lang> = new Set<Lang>(["ts", "py", "rs", "go"]);

/** How a line comment starts, per language. `/*` is handled for the C family
 *  as start-of-comment-to-EOL -- good enough for a display painter. */
const LINE_COMMENT: Record<Lang, string[]> = {
  ts: ["//", "/*", "*/", "*"],
  py: ["#"],
  rs: ["//", "/*", "*/", "*"],
  go: ["//", "/*", "*/", "*"],
  sh: ["#"],
  json: [],
  css: ["/*", "*/", "*"],
  sql: ["--"],
  html: ["<!--"],
};

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const WORD = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** True when the trimmed line opens as a comment for this language. A `*`
 *  opener only counts as a continuation cue for the C family block style. */
function opensComment(trimmed: string, lang: Lang): boolean {
  for (const mark of LINE_COMMENT[lang]) {
    if (mark === "*") {
      if (trimmed.startsWith("* ") || trimmed === "*") return true;
    } else if (trimmed.startsWith(mark)) {
      return true;
    }
  }
  return false;
}

export interface CodeToken {
  text: string;
  /** null = the caller's base tone (punctuation, operators, plain identifiers). */
  role: SyntaxRole | null;
}

/**
 * Split one line into painted tokens. Pure, per-line, and lossless: joining
 * the token texts gives the line back exactly.
 *
 * The rules are an editor's, simplified to what one line can know:
 *   comment   a line that opens as one, or the rest of a line from a marker
 *   string    quoted with " ' `, escapes honoured, unterminated runs to EOL
 *   number    integer / float / hex, not glued to an identifier
 *   decorator @name (ts / py)
 *   keyword   the language's reserved words (sql: case-insensitive)
 *   constant  true / false / null / None / nil / self ... painted apart
 *   type      a Capitalised identifier in ts / py / rs / go
 *   function  an identifier followed by `(`, or a shell word in command position
 *   property  an identifier after `.`, a json key, a css property before `:`,
 *             an html attribute; html tag names paint as keywords
 */
export function tokenize(line: string, lang: CodeLang): CodeToken[] {
  if (!lang) return [{ text: line, role: null }];
  const trimmed = line.trimStart();
  if (opensComment(trimmed, lang)) return [{ text: line, role: "comment" }];

  const out: CodeToken[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain, role: null });
    plain = "";
  };
  const push = (text: string, role: SyntaxRole | null) => {
    if (role === null) plain += text;
    else {
      flush();
      out.push({ text, role });
    }
  };

  // Shell: the first bare word of a command is the command (yellow, like a
  // function call). Re-armed after `&&`, `||`, `|`, `;`, `$(` and `(`.
  let commandPosition = lang === "sh";
  // html: inside a tag after `<name` -- bare words there are attributes.
  let inTag = false;

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const commentAt = LINE_COMMENT[lang].some((m) => m !== "*" && m !== "*/" && rest.startsWith(m));
    if (commentAt && !(lang === "sh" && line[i - 1] === "$")) {
      push(rest, "comment");
      return finish();
    }
    const ch = line[i]!;

    // Strings, with escapes. An unterminated string paints to end of line --
    // this is a per-line painter and the honest rendering of a split literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === ch) {
          j++;
          break;
        } else j++;
      }
      const lit = line.slice(i, j);
      // A json key is the string before a colon: a name, not a value.
      const isKey = lang === "json" && /^\s*:/.test(line.slice(j));
      push(lit, isKey ? "property" : "string");
      i = j;
      commandPosition = false;
      continue;
    }

    const num = NUMBER.exec(rest);
    if (num && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? "")) {
      push(num[0], "number");
      i += num[0].length;
      commandPosition = false;
      continue;
    }

    // Decorators / annotations.
    if (ch === "@" && (lang === "ts" || lang === "py")) {
      const w = WORD.exec(rest.slice(1));
      if (w) {
        push("@" + w[0], "decorator");
        i += 1 + w[0].length;
        continue;
      }
    }

    // html: `<tag`, `</tag` -> keyword; the rest of the tag is attributes.
    if (lang === "html" && ch === "<") {
      const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
      if (m) {
        push(rest.slice(0, m[0].length - m[1]!.length), null);
        push(m[1]!, "keyword");
        i += m[0].length;
        inTag = true;
        continue;
      }
    }
    if (lang === "html" && ch === ">") inTag = false;

    const word = WORD.exec(rest);
    if (word) {
      const w = word[0];
      const after = line.slice(i + w.length);
      const before = line[i - 1] ?? "";
      const called = /^\s*\(/.test(after);
      const keyed = lang === "sql" ? w.toLowerCase() : w;
      let role: SyntaxRole | null = null;
      if (lang === "html") {
        role = inTag ? "property" : null;
      } else if (CONSTANTS[lang].has(w)) {
        role = "constant";
      } else if (KEYWORDS[lang].has(keyed)) {
        role = "keyword";
      } else if (lang === "sh") {
        role = commandPosition ? "function" : null;
      } else if (lang === "css") {
        role = /^\s*:/.test(after) ? "property" : called ? "function" : null;
      } else if (called) {
        role = "function";
      } else if (before === ".") {
        role = "property";
      } else if (CAPITALISED_TYPES.has(lang) && /^[A-Z]/.test(w) && !/^[A-Z0-9_$]+$/.test(w)) {
        role = "type";
      }
      push(w, role);
      i += w.length;
      if (lang === "sh" && role !== "keyword") commandPosition = false;
      continue;
    }

    // Shell command position re-arms after a separator.
    if (lang === "sh") {
      if (rest.startsWith("&&") || rest.startsWith("||") || rest.startsWith("$(")) {
        push(rest.slice(0, 2), null);
        i += 2;
        commandPosition = true;
        continue;
      }
      if (ch === "|" || ch === ";" || ch === "(") commandPosition = true;
    }
    push(ch, null);
    i++;
  }
  return finish();

  function finish(): CodeToken[] {
    flush();
    return out;
  }
}

/**
 * Paint one line of code. `base` colours everything that is not a recognised
 * token, so an add row can read primary while a context row recedes -- the
 * painter never decides the row's tone, only its accents. Unknown language
 * (`null`) paints everything with `base`.
 */
export function paintCode(
  line: string,
  lang: CodeLang,
  base: (s: string) => string,
  /** The syntax palette to paint with; defaults to the theme's. A diff band on
   *  the opposite ground passes the palette that reads there. */
  palette?: RuneBaseName,
): string {
  if (!lang) return base(line);
  return tokenize(line, lang)
    .map((t) => (t.role ? syntax(t.role, t.text, palette) : base(t.text)))
    .join("");
}
