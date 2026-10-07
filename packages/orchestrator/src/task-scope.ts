// ─── What a request allows to be written ───
//
// "Explain how the parser handles quoting, write it to ANSWER.md and change no
// code." "Review invoice.ts and put your findings in REVIEW.md — this is a
// review, not a fix." Requests like these state a boundary in the user's own
// words, and until now nothing held a run to it: the same gates that push a
// code change toward tests pushed a review toward them too, and a run that
// "helpfully" fixed what it was asked to describe had broken the one thing it
// was told.
//
// This file reads that boundary out of the request and answers two questions
// about it: may this path be written, and is this path documentation.
//
// Two rules decide what it is allowed to conclude.
//
// IT ONLY EVER NARROWS, AND ONLY ON EXPLICIT WORDS. The default is the
// ordinary one — a run may edit. A request becomes `no_code` when the user
// said so ("change no code", "don't modify the source", "not a fix"), never
// because a sentence looked like a question: "Can you fix the header?" is one,
// syntactically. A mechanical read of a sentence's shape is not a safe input
// to a permission, and this file does not use one.
//
// ONLY THE USER'S REQUEST IS READ. Not a README, not a tool result, not a
// model's restatement. Text from the repository therefore cannot widen a
// scope — there is nothing wider than the default to widen to, and no path
// from repository text to this function at all.
//
// Pure: a string in, a record out.

import { isAbsolute, relative, resolve } from "node:path";

export interface TaskScope {
  /** `code` — the ordinary case, nothing withheld. `no_code` — the user said to change none. */
  mode: "code" | "no_code";
  /**
   * Under `no_code`: the files the user named as where the answer goes, as
   * they wrote them. These, and nothing else in the workspace, may be written.
   */
  outputs: string[];
  /** The user's own words that set the boundary — for the record and the refusal. */
  because?: string;
}

export const UNRESTRICTED: TaskScope = Object.freeze({ mode: "code", outputs: [] }) as TaskScope;

/**
 * The ways a person says "leave the code alone". Each one is a statement about
 * CHANGING things; none is a statement about what kind of request this is.
 */
const NO_CODE: RegExp[] = [
  // "change no code", "modify no source files", "touching no files" — said TO
  // the reader. Not "changes no code": that is a sentence describing something
  // ("the arm writes REVIEW.md and changes no code"), and it is not an order.
  /\b(?:chang(?:e|ing)|modif(?:y|ying)|edit(?:ing)?|touch(?:ing)?|alter(?:ing)?)\s+no\s+(?:code|source(?:\s+files?)?|files?|tests?)\b/i,
  // "do not change any code", "don't modify the source", "without editing code"
  /\b(?:do\s+not|don['’]?t|never|without)\s+(?:chang|modif|edit|touch|alter|fix|rewrit)\w*\s+(?:any\s+|the\s+|a\s+single\s+)?(?:\w+\s+)?(?:code|source(?:\s+files?)?|files?|implementation)\b/i,
  // "no code changes", "no source edits", "no code may be changed"
  /\bno\s+(?:code|source)\s+(?:files?\s+)?(?:changes?|edits?|modifications?|may\s+be\s+\w+|should\s+be\s+\w+)/i,
  // "this is a review, not a fix"
  /\bnot\s+a\s+fix\b/i,
  // "Read-only: …" as a label on the request, or "this is read-only". Not the
  // bare word: "a read-only run with no answer is still an error" is a
  // sentence ABOUT read-only things, and it sits in the middle of a request to
  // write a fix (a mined task's own prompt — which is how this was found).
  // Anchored to the start of the REQUEST, not of a line: prose is hard-wrapped,
  // and "…opens the database\nread-only — no engine" put the word at a line
  // start in a commit message.
  /^\s*read[-\s]only\s*:/i,
  /\b(?:this|it)\s+is\s+(?:a\s+)?read[-\s]only\s+(?:task|request|review|pass|question|session)\b/i,
  // "leave the code as it is / alone / untouched"
  /\bleave\s+(?:the\s+|all\s+)?(?:code|source|files?)\s+(?:as\s+(?:it\s+is|is)|alone|untouched|unchanged)\b/i,
];

/**
 * A named place for the answer: "write it to PLAN.md", "save your findings in
 * `docs/REVIEW.md`", "put the explanation into ANSWER.md".
 */
const OUTPUT =
  /\b(?:writ|sav|put|record|output|stor|document|report)\w*\b[^.\n]{0,100}?\b(?:to|in|into|as|at)\s+(?:a\s+file\s+(?:called|named)\s+)?[`'"]?((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt|rst|adoc|json|csv|html))[`'"]?/gi;

/** The scope a request sets. Reads the request and nothing else. */
export function taskScope(request: string): TaskScope {
  const text = request ?? "";
  let because: string | undefined;
  for (const re of NO_CODE) {
    const hit = text.match(re);
    if (hit) {
      because = hit[0].trim();
      break;
    }
  }
  if (!because) return UNRESTRICTED;
  const outputs: string[] = [];
  for (const m of text.matchAll(OUTPUT)) {
    const path = m[1]!.replace(/^\.\//, "");
    // A name only: never a way out of the workspace.
    if (path.startsWith("/") || path.split("/").includes("..")) continue;
    if (!outputs.includes(path)) outputs.push(path);
  }
  return { mode: "no_code", outputs, because };
}

const DOC_EXT = /\.(?:md|markdown|rst|txt|adoc|asciidoc)$/i;
const DOC_NAME =
  /^(?:LICEN[CS]E|NOTICE|AUTHORS|CONTRIBUTORS|CHANGELOG|CHANGES|HISTORY|README|COPYING|TODO)$/i;

/**
 * Whether a path is prose for people, as opposed to something a build or a
 * test reads. Deliberately small: `.mdx` is source, `.json` is data a program
 * loads, and anything not on this list is not documentation.
 */
export function isDocumentationPath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return DOC_EXT.test(name) || DOC_NAME.test(name);
}

const CASE_BLIND = process.platform === "darwin" || process.platform === "win32";

/** `target`, as a tool was handed it, as a workspace-relative path — or null when it is outside. */
function inWorkspace(workspaceRoot: string, target: string): string | null {
  const abs = isAbsolute(target) ? resolve(target) : resolve(workspaceRoot, target);
  const rel = relative(resolve(workspaceRoot), abs).replace(/\\/g, "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Whether a file tool may write `target` under this scope.
 *
 * Unrestricted says yes to everything — the ordinary permission layer is what
 * decides there, as it always has. `no_code` says yes to the outputs the user
 * named and to nothing else: not a source file, not a test, not a second
 * report. (A path outside the workspace is not this function's to allow; it is
 * refused here and was never the file tools' to write.)
 */
export function writeAllowed(scope: TaskScope, workspaceRoot: string, target: string): boolean {
  if (scope.mode === "code") return true;
  const rel = inWorkspace(workspaceRoot, target);
  if (rel === null) return false;
  const same = (a: string, b: string): boolean =>
    CASE_BLIND ? a.toLowerCase() === b.toLowerCase() : a === b;
  return scope.outputs.some((out) => same(out, rel));
}

/** What a refused write is told. Says what IS allowed, so the next call can be right. */
export function scopeRefusal(scope: TaskScope, refused: readonly string[]): string {
  const where =
    scope.outputs.length > 0
      ? `Only ${scope.outputs.map((o) => `\`${o}\``).join(", ")} may be written.`
      : "No file was named for the answer, so nothing in the workspace may be written — answer in your reply.";
  return (
    `Not written: ${refused.map((p) => `\`${p}\``).join(", ")}. The request set a boundary ` +
    `("${scope.because ?? "change no code"}"). ${where} ` +
    "For a throwaway reproduction, use the shell in $TMPDIR; it is not part of the result."
  );
}

/** One line telling the model the boundary, before it spends a call finding it. */
export function scopeNote(scope: TaskScope): string | null {
  if (scope.mode === "code") return null;
  return (
    `The request set a boundary ("${scope.because ?? "change no code"}"). ` +
    (scope.outputs.length > 0
      ? `Write only ${scope.outputs.map((o) => `\`${o}\``).join(", ")}, with the file tools. `
      : "Write nothing in the workspace; answer in your reply. ") +
    "Do not edit sources, do not add tests, and do not fix what you find — report it. " +
    "The shell cannot write inside the workspace for this request; use $TMPDIR for a throwaway reproduction."
  );
}
