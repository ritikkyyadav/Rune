/**
 * The leak check: a mined task's prompt must not hand the arm the fix.
 *
 * Each prompt is written by hand from the fix commit, so it can pick up the
 * fix's own vocabulary without anyone noticing: a helper's name, a new constant,
 * an error message the fix introduced. The check collects what the fix ADDED
 * that did not exist before it. That is every name its added lines declare
 * (function, method, variable, class, interface, type, enum) and every string
 * literal of 12 characters or more. Whatever the hidden tests reference is
 * removed from that set, because it is the interface the task has to name. If
 * anything left over appears in the prompt, the task fails validation.
 *
 * The scan is lexical and deliberately generous. It may collect a name that is
 * not a declaration, but such a name also exists at the parent, and the
 * existence filter drops it. It never needs to be exact to be safe, because the
 * cost of a false alarm is rewording a prompt.
 *
 * Nothing here calls a model.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MIN_LITERAL = 12;

const CODE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

export interface AddedNames {
  /** Names declared on the fix's added lines. */
  identifiers: string[];
  /** String literals on the added lines, and a template's fixed text, of MIN_LITERAL+ characters. */
  literals: string[];
}

/** Runs of consecutive `+` lines of a unified diff, per code file. */
export function addedBlocks(diff: string): { file: string; text: string }[] {
  const blocks: { file: string; text: string }[] = [];
  let file = "";
  let run: string[] = [];
  const flush = () => {
    if (run.length && CODE_FILE.test(file)) blocks.push({ file, text: run.join("\n") });
    run = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      file = "";
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) run.push(line.slice(1));
    else flush();
  }
  flush();
  return blocks;
}

const REGEX_BEFORE = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

/**
 * Split source text into code (strings blanked, comments dropped) and the
 * string literals it contains. Lines that begin with `*` or `//` are prose
 * (a doc comment's body, a line comment) and are skipped whole, so an
 * apostrophe in them never opens a string.
 */
export function scan(text: string): { code: string; literals: string[] } {
  const literals: string[] = [];
  const code: string[] = [];
  let state: "code" | "template" | "comment" = "code";
  let chunk = "";
  const push = (value: string) => {
    for (const piece of value.split("\n")) if (piece.length) literals.push(piece);
  };
  for (const line of text.split("\n")) {
    let out = "";
    let i = 0;
    const trimmed = line.trimStart();
    if (state === "code" && (trimmed.startsWith("*") || trimmed.startsWith("//"))) {
      code.push("");
      continue;
    }
    while (i < line.length) {
      const ch = line[i]!;
      const next = line[i + 1];
      if (state === "comment") {
        const end = line.indexOf("*/", i);
        if (end < 0) {
          i = line.length;
          break;
        }
        i = end + 2;
        state = "code";
        continue;
      }
      if (state === "template") {
        if (ch === "\\") {
          chunk += line.slice(i, i + 2);
          i += 2;
        } else if (ch === "`") {
          push(chunk);
          chunk = "";
          state = "code";
          out += '""';
          i++;
        } else if (ch === "$" && next === "{") {
          push(chunk);
          chunk = "";
          let depth = 1;
          i += 2;
          while (i < line.length && depth > 0) {
            if (line[i] === "{") depth++;
            else if (line[i] === "}") depth--;
            i++;
          }
        } else {
          chunk += ch;
          i++;
        }
        continue;
      }
      // code
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        state = "comment";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        let value = "";
        while (j < line.length && line[j] !== ch) {
          if (line[j] === "\\") {
            value += line.slice(j, j + 2);
            j += 2;
          } else value += line[j++];
        }
        push(value);
        out += '""';
        i = j + 1;
        continue;
      }
      if (ch === "`") {
        state = "template";
        chunk = "";
        i++;
        continue;
      }
      if (ch === "/") {
        const before = out.trimEnd();
        const last = before.slice(-1);
        if (REGEX_BEFORE.has(last) || /\b(?:return|typeof|case|in|of)$/.test(before)) {
          // A regular expression literal: skip it, classes and escapes included.
          let j = i + 1;
          let inClass = false;
          while (j < line.length) {
            const c = line[j]!;
            if (c === "\\") j += 2;
            else {
              if (c === "[") inClass = true;
              else if (c === "]") inClass = false;
              else if (c === "/" && !inClass) break;
              j++;
            }
          }
          j++;
          while (j < line.length && /[a-z]/.test(line[j]!)) j++;
          out += "/r/";
          i = j;
          continue;
        }
      }
      out += ch;
      i++;
    }
    if (state === "template") chunk += "\n";
    code.push(out);
  }
  if (state === "template") push(chunk);
  return { code: code.join("\n"), literals };
}

const IDENT = "[A-Za-z_$][\\w$]*";
const KEYWORD_DECL = new RegExp(
  `\\b(?:function\\s*\\*?|class|interface|type|enum|namespace)\\s+(${IDENT})`,
  "g",
);
const VARIABLE_DECL = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})`, "g");
const DESTRUCTURED = /\b(?:const|let|var)\s+(?:\{([^}]*)\}|\[([^\]]*)\])/g;
const MODIFIERS =
  "(?:(?:export|default|public|private|protected|static|async|readonly|override|abstract|declare|get|set)\\s+)*";
const METHOD_HEAD = new RegExp(
  `^\\s*${MODIFIERS}\\*?\\s*#?(${IDENT})\\s*\\??\\s*(?:<[^()]*>)?\\s*\\(`,
);
const ARROW_PROPERTY = new RegExp(
  `^\\s*${MODIFIERS}#?(${IDENT})\\s*\\??\\s*[:=]\\s*(?:async\\s+)?(?:\\([^)]*\\)|${IDENT})\\s*(?::\\s*[^=]+)?=>`,
);
/**
 * A member that opens its line: an interface or type field (`groupGone?: boolean;`),
 * a class field, an object-literal key (`attemptStartedAt: stamp,`) or a
 * parameter on a line of its own. A new field is fix vocabulary as much as a
 * new function is ("add a `groupGone` flag" hands over the design).
 */
const MEMBER = new RegExp(`^\\s*${MODIFIERS}#?(${IDENT})\\s*[?!]?\\s*:(?!:)`);
const NOT_A_NAME = new Set(
  "if for while switch catch return function typeof await new super import export with do else try finally throw delete void yield in of instanceof case default constructor".split(
    " ",
  ),
);

/** The names one line of code (strings already blanked) declares. */
export function declarationsOn(line: string): string[] {
  const names: string[] = [];
  for (const m of line.matchAll(KEYWORD_DECL)) names.push(m[1]!);
  for (const m of line.matchAll(VARIABLE_DECL)) names.push(m[1]!);
  for (const m of line.matchAll(DESTRUCTURED)) {
    for (const part of (m[1] ?? m[2] ?? "").split(",")) {
      const renamed = part.includes(":") ? part.split(":")[1]! : part;
      const name = renamed.split("=")[0]!.replace("...", "").trim();
      if (new RegExp(`^${IDENT}$`).test(name)) names.push(name);
    }
  }
  const head = METHOD_HEAD.exec(line);
  if (head && !NOT_A_NAME.has(head[1]!)) {
    const rest = line.slice(head[0].length);
    const body = /\)\s*(?::[^;{]*)?\{\s*$/.test(rest); // name(args) {   name(args): T {
    const signature = /\)\s*:\s*[^;]+;\s*$/.test(rest); // name(args): T;
    const continues = !rest.includes(")"); // name(  — the parameters follow
    if (body || signature || continues) names.push(head[1]!);
  }
  const arrow = ARROW_PROPERTY.exec(line);
  if (arrow && !NOT_A_NAME.has(arrow[1]!)) names.push(arrow[1]!);
  const member = MEMBER.exec(line);
  if (member && !NOT_A_NAME.has(member[1]!) && !names.includes(member[1]!)) names.push(member[1]!);
  return names.filter((name) => !NOT_A_NAME.has(name));
}

/** Everything the fix's added lines declare, and their long literals. */
export function addedNames(diff: string): AddedNames {
  const identifiers = new Set<string>();
  const literals = new Set<string>();
  for (const block of addedBlocks(diff)) {
    const scanned = scan(block.text);
    for (const line of scanned.code.split("\n"))
      for (const name of declarationsOn(line)) identifiers.add(name);
    for (const literal of scanned.literals)
      if (literal.length >= MIN_LITERAL) literals.add(literal);
  }
  return { identifiers: [...identifiers], literals: [...literals] };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` contains `name` as a whole word, case and all. */
export function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(text);
}

/** Every identifier-shaped word in `text`. */
export function wordsOf(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * What one entry of a task's `interface` list names. A module path
 * (`packages/shared/src/model-catalog.ts`) names the module, without its
 * extension; anything else names its last symbol, so `ResumePlanStore#transition`,
 * `CostEntry.attemptStartedAt` and `reportCheckpoints(db, keep?)` name
 * `transition`, `attemptStartedAt` and `reportCheckpoints`.
 */
export function interfaceSymbol(entry: string): { kind: "module" | "symbol"; name: string } {
  const bare = entry.trim();
  if (bare.includes("/")) return { kind: "module", name: bare.replace(/\.[cm]?tsx?$/, "") };
  const head = bare.split("(")[0]!.split(":")[0]!.trim();
  return { kind: "symbol", name: head.split(/[#.]/).pop()!.trim() };
}

/**
 * Everything wrong with a task's interface list. An interface is the one place
 * a prompt may name what the fix adds, so each entry must be something the
 * hidden tests actually use (a symbol they reference, a module they import) and
 * something the prompt actually names; anything else is either a leak with a
 * licence or a promise the prompt does not keep.
 */
export function interfaceProblems(entries: string[], prompt: string, testText: string): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const { kind, name } = interfaceSymbol(entry);
    if (kind === "module") {
      if (!testText.includes(name))
        problems.push(`interface ${entry} is not imported by the hidden tests`);
      if (!prompt.includes(name)) problems.push(`interface ${entry} is not named in the prompt`);
      continue;
    }
    if (!new RegExp(`^${IDENT}$`).test(name)) {
      problems.push(`interface ${entry} names no symbol`);
      continue;
    }
    if (!mentions(testText, name))
      problems.push(`interface ${entry} is not referenced by the hidden tests`);
    if (!mentions(prompt, name)) problems.push(`interface ${entry} is not named in the prompt`);
  }
  return problems;
}

export interface LeakInput {
  prompt: string;
  added: AddedNames;
  /** The hidden test files' text at the fix commit. */
  testText: string;
  /** Does `needle` occur in the parent's tree (as a whole word, for identifiers)? */
  inBase: (needle: string, wholeWord: boolean) => boolean;
}

export interface LeakReport {
  /** New names in the prompt that the hidden tests do not reference: each one fails the task. */
  leaks: string[];
  /** New names in the prompt that the hidden tests do reference: the interface, allowed. */
  interfaceNames: string[];
}

export function findLeaks(input: LeakInput): LeakReport {
  const testWords = wordsOf(input.testText);
  const promptLower = input.prompt.toLowerCase();
  const leaks: string[] = [];
  const interfaceNames: string[] = [];
  for (const name of input.added.identifiers) {
    if (!mentions(input.prompt, name)) continue;
    if (input.inBase(name, true)) continue;
    if (testWords.has(name)) interfaceNames.push(name);
    else leaks.push(name);
  }
  for (const literal of input.added.literals) {
    if (literal.length < MIN_LITERAL) continue;
    if (!promptLower.includes(literal.toLowerCase())) continue;
    if (input.inBase(literal, false)) continue;
    if (input.testText.includes(literal)) interfaceNames.push(literal);
    else leaks.push(literal);
  }
  return { leaks, interfaceNames };
}

// ── Against the repository ──

function gitText(repoRoot: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.status !== 0 && run.status !== 1)
    throw new Error(`git ${args.join(" ")}: ${(run.stderr || "").trim()}`);
  return run.stdout;
}

/** The fix: the commit's `packages/**` diff against its parent. */
export function fixDiff(repoRoot: string, parent: string, sha: string): string {
  return gitText(repoRoot, ["diff", "--no-renames", "--no-color", parent, sha, "--", "packages/"]);
}

/** The concatenated text of `paths` at `rev` (missing paths are skipped). */
export function revisionText(repoRoot: string, rev: string, paths: string[]): string {
  const parts: string[] = [];
  for (const path of paths) {
    const run = spawnSync("git", ["-C", repoRoot, "show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (run.status === 0) parts.push(run.stdout);
  }
  return parts.join("\n");
}

/** `git grep` at `rev`, one needle at a time, remembered. */
export function inRevision(repoRoot: string, rev: string): LeakInput["inBase"] {
  const memo = new Map<string, boolean>();
  return (needle, wholeWord) => {
    const key = `${wholeWord ? "w" : "s"}:${needle}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const args = [
      "-C",
      repoRoot,
      "grep",
      "-q",
      "-I",
      "-F",
      ...(wholeWord ? ["-w"] : []),
      "-e",
      needle,
      rev,
      "--",
    ];
    const found = spawnSync("git", args).status === 0;
    memo.set(key, found);
    return found;
  };
}

/** Which of `needles` occur at `rev`: one `git grep` for all of them. */
export function presentIn(
  repoRoot: string,
  rev: string,
  needles: string[],
  wholeWord: boolean,
): Set<string> {
  const wanted = new Set(needles.filter((needle) => needle.length > 0 && !needle.includes("\n")));
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "serious-grep-"));
  try {
    const patterns = join(scratch, "patterns");
    writeFileSync(patterns, [...wanted].join("\n") + "\n");
    const args = [
      "grep",
      "-o",
      "-h",
      "-I",
      "-F",
      ...(wholeWord ? ["-w"] : []),
      "-f",
      patterns,
      rev,
      "--",
    ];
    for (const line of gitText(repoRoot, args).split("\n")) {
      if (wanted.has(line)) {
        found.add(line);
        continue;
      }
      // Tolerate a `rev:path:` prefix, should git print one.
      for (let at = line.indexOf(":"); at >= 0; at = line.indexOf(":", at + 1)) {
        const tail = line.slice(at + 1);
        if (wanted.has(tail)) {
          found.add(tail);
          break;
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return found;
}

/**
 * The leak report for one task, from the repository. Only what the prompt
 * mentions is looked up at the parent, one early-exiting `git grep -q` per
 * name: a name the parent has is found in milliseconds. (One `git grep -o -w`
 * over a batch of names is far slower on common words, measured 25 s → 194 s
 * over the committed corpus, so the batch form is kept for `newNames` only.)
 */
export function taskLeaks(
  repoRoot: string,
  task: { sha: string; parent: string; prompt: string; hiddenFiles: string[] },
): LeakReport {
  return findLeaks({
    prompt: task.prompt,
    added: addedNames(fixDiff(repoRoot, task.parent, task.sha)),
    testText: revisionText(repoRoot, task.sha, task.hiddenFiles),
    inBase: inRevision(repoRoot, task.parent),
  });
}

/**
 * What the fix added that the parent does not have, split by whether the hidden
 * tests reference it. The prompt writer's list of words to keep out of the
 * prompt (`hidden`) and of candidates for its interface section (`referenced`).
 */
export function newNames(
  repoRoot: string,
  task: { sha: string; parent: string; hiddenFiles: string[] },
): { referenced: string[]; hidden: string[] } {
  const added = addedNames(fixDiff(repoRoot, task.parent, task.sha));
  const testText = revisionText(repoRoot, task.sha, task.hiddenFiles);
  const testWords = wordsOf(testText);
  const presentIds = presentIn(repoRoot, task.parent, added.identifiers, true);
  const presentLits = presentIn(repoRoot, task.parent, added.literals, false);
  const referenced: string[] = [];
  const hidden: string[] = [];
  for (const name of added.identifiers.filter((id) => !presentIds.has(id)))
    (testWords.has(name) ? referenced : hidden).push(name);
  for (const literal of added.literals.filter((lit) => !presentLits.has(lit)))
    (testText.includes(literal) ? referenced : hidden).push(JSON.stringify(literal));
  return { referenced, hidden };
}
