// ─── The request check (A3) ───
//
// A run that finished with the project's own checks green has shown that
// nothing those checks can see is broken. It has not shown that it did what
// was asked. Measured on the offline corpus on 2026-10-21, with the end-of-turn
// check on and no outside acceptance: 19 of 44 half-done or plausibly wrong
// runs passed their fixture's own tests — a forgotten changelog, an exporter
// never touched, a guard dropped, a parser right only on its own test.
//
// So before a run may end `done`, the session's model reads the person's
// request beside what the run changed, once, and lists every ask, found or
// not. An ask it cannot find buys one re-prompt (REPAIR_REQUEST, arbiter.ts)
// and is otherwise a named gap on the verdict. It reads; it never writes.
//
// What it is given is exactly the run's change: each file Rune's own tools
// wrote, from the before-image the file history kept (R5) to what the file
// holds now — never the person's own uncommitted edits from before the run.
// Files a shell command changed are named, not shown.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { unifiedDiff } from "@rune/tool-registry";
import { isHarnessOwnedPath } from "./lifecycle";

/** One ask, as the checker reported it. */
export interface RequestAsk {
  ask: string;
  done: boolean;
  evidence: string;
}

/** What the request check established about a finished change. */
export interface RequestCheckOutcome {
  /** How many distinct asks the checker found in the request. */
  asks: number;
  /** The asks the change does not do, each with what is missing. */
  missing: Array<{ ask: string; why: string }>;
}

/** The check's result: an outcome, or why it could not say. */
export type RequestCheckResult = { outcome: RequestCheckOutcome } | { skipped: string };

/** One file the run changed. */
export interface ChangedFile {
  /** Workspace-relative path. */
  path: string;
  /** What it held before the run first wrote it; null when it did not exist. */
  before: string | null;
  /** What it holds now; null when it is gone. */
  after: string | null;
}

/**
 * The most diff the check reads, in characters. A change bigger than this is
 * not checked at all: a checker shown part of a change reports the rest as
 * missing, and a re-prompt bought on that would be a turn spent on nothing.
 */
export const REQUEST_DIFF_CAP = 120_000;

/** At most this many asks are kept: a list longer than this is not a request. */
const MAX_ASKS = 40;

/** The whole change as one unified diff, or the files it would not fit. */
export function changeDiff(files: readonly ChangedFile[]): { diff: string; omitted: string[] } {
  const parts: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let part: string;
    if (file.before === null && file.after === null) continue;
    if (file.after === null) {
      part = `--- a/${file.path}\n+++ /dev/null\n(deleted)\n`;
    } else {
      part = unifiedDiff(file.before ?? "", file.after, file.path);
      if (!part) continue;
      if (file.before === null) part = `(new file)\n${part}`;
    }
    if (size + part.length > REQUEST_DIFF_CAP) {
      omitted.push(file.path);
      continue;
    }
    size += part.length;
    parts.push(part.endsWith("\n") ? part : `${part}\n`);
  }
  return { diff: parts.join("\n"), omitted };
}

export const REQUEST_CHECK_SYSTEM =
  "You check whether a finished code change does everything a request asked for. " +
  "You read; you do not write or suggest code. You answer with one JSON object and nothing else.";

/** The one message the checker is sent. */
export function requestCheckPrompt(
  request: string,
  diff: string,
  otherChanged: readonly string[],
  passedChecks: readonly string[] = [],
): string {
  const others =
    otherChanged.length > 0
      ? "\n\nThese files also changed, by commands rather than by file edits, and are not shown " +
        `above: ${otherChanged.slice(0, 40).join(", ")}${otherChanged.length > 40 ? ", …" : ""}. ` +
        "An ask that could only have been met in one of them counts as done; say so in its evidence."
      : "";
  // What a diff cannot show and the runtime saw: the checks that ran and
  // passed. Without it, "add tests and run them" read as not done on six of
  // the eight correct corpus runs (2026-10-21, live).
  const ran =
    passedChecks.length > 0
      ? "\n\nThese checks ran during the run and passed — the runtime watched each, and the " +
        "last ran on the tree the change leaves:\n" +
        passedChecks
          .slice(0, 30)
          .map((c) => `- ${c}`)
          .join("\n")
      : "";
  return (
    "THE REQUEST, as the person wrote it:\n<<<\n" +
    `${request.trim()}\n>>>\n\n` +
    "THE CHANGE — a unified diff of every file the run changed:\n<<<\n" +
    `${diff.trim() || "(no file content changed)"}\n>>>` +
    others +
    ran +
    "\n\nList every distinct thing the request asks to be done: each behaviour, fix, field, " +
    'file, test, document or constraint it names ("do not edit X", "keep the signature"). ' +
    "For each, decide from the change alone whether it is done. A constraint is done when the " +
    "change does not break it. A test the run added is evidence only when the behaviour it tests " +
    "is also in the change. An ask to run tests or checks is done when a check listed above " +
    "covers it. An ask to add tests is done when the change adds tests of the asked behaviour; " +
    "do not judge how many tests there are, or how thorough they are.\n\n" +
    "Be strict about omissions: an ask the change does not do is not done, however small. Be " +
    "fair about the rest: do not invent requirements the request does not state, and do not judge " +
    "style, naming or approach.\n\n" +
    "Answer with exactly this JSON and nothing else:\n" +
    '{"asks":[{"ask":"<the request\'s own words, short>","done":true,"evidence":"<the file and ' +
    'what in it does this>"},{"ask":"…","done":false,"evidence":"<what is missing>"}]}'
  );
}

/** The checker's answer, read strictly; null when it is not the JSON asked for. */
export function parseRequestCheck(text: string): RequestCheckOutcome | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (value as { asks?: unknown })?.asks;
  if (!Array.isArray(raw)) return null;
  const asks: RequestAsk[] = [];
  for (const item of raw.slice(0, MAX_ASKS)) {
    const ask = (item as { ask?: unknown })?.ask;
    const done = (item as { done?: unknown })?.done;
    const evidence = (item as { evidence?: unknown })?.evidence;
    if (typeof ask !== "string" || !ask.trim() || typeof done !== "boolean") continue;
    asks.push({
      ask: ask.trim().slice(0, 300),
      done,
      evidence: typeof evidence === "string" ? evidence.trim().slice(0, 300) : "",
    });
  }
  if (asks.length === 0) return null;
  return {
    asks: asks.length,
    missing: asks.filter((a) => !a.done).map((a) => ({ ask: a.ask, why: a.evidence })),
  };
}

/** Run the check: the prompt, one call, the answer read. Never throws. */
export async function runRequestCheck(opts: {
  request: string;
  files: readonly ChangedFile[];
  otherChanged: readonly string[];
  /** Checks the runtime watched pass during the run, as their commands. */
  passedChecks?: readonly string[];
  ask: (system: string, user: string) => Promise<string>;
}): Promise<RequestCheckResult> {
  if (!opts.request.trim()) return { skipped: "no request text to check against" };
  const { diff, omitted } = changeDiff(opts.files);
  if (omitted.length > 0) {
    return {
      skipped: `the change is larger than the check reads (${omitted.length} file(s) would be left out)`,
    };
  }
  if (!diff.trim() && opts.otherChanged.length === 0) {
    return { skipped: "nothing the run changed is on record" };
  }
  let answer: string;
  try {
    answer = await opts.ask(
      REQUEST_CHECK_SYSTEM,
      requestCheckPrompt(opts.request, diff, opts.otherChanged, opts.passedChecks ?? []),
    );
  } catch (error) {
    return { skipped: `the check call failed: ${String(error).slice(0, 200)}` };
  }
  const outcome = parseRequestCheck(answer);
  if (!outcome) return { skipped: "the checker's answer was not the JSON asked for" };
  return { outcome };
}

/**
 * Files changed in the work tree since `sinceMs` that are not already shown:
 * what a shell command wrote during the run. Read from `git status`, kept
 * only when the file was modified after the run began — the person's own
 * uncommitted work from before it is not the run's. Rune's own state is never
 * listed. Empty outside a git repository.
 */
export function filesChangedSince(
  root: string,
  sinceMs: number,
  shown: ReadonlySet<string>,
): string[] {
  const status = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (status.status !== 0 || typeof status.stdout !== "string") return [];
  const out: string[] = [];
  const entries = status.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy carries its source in the next entry.
    if (code[0] === "R" || code[0] === "C") i++;
    if (shown.has(path) || isHarnessOwnedPath(path)) continue;
    try {
      if (statSync(join(root, path)).mtimeMs < sinceMs) continue;
    } catch {
      continue; // gone: nothing to read, and no time to date it by
    }
    out.push(path);
    if (out.length >= 100) break;
  }
  return out;
}

/** The one re-prompt a missing ask buys: what is missing, in the checker's words. */
export function requestRepromptBody(missing: RequestCheckOutcome["missing"]): string {
  const list = missing
    .slice(0, 12)
    .map((m) => `- ${m.ask}${m.why ? ` — ${m.why}` : ""}`)
    .join("\n");
  return (
    "Before you finish: a check of your change against the request found that it does not yet " +
    `do ${missing.length === 1 ? "this" : "these"}:\n${list}\n\n` +
    "Do it now and run the checks, then end your turn. If one of these is deliberately out of " +
    "scope or already done somewhere the check could not see, say so in one line instead."
  );
}
