// --- Activity rendering ---
// The single source of truth for how a turn reads on screen, shared by the live
// stream and the session-resume replay so a resumed session looks exactly like
// watching it happen. Both paths speak the flow grammar in ./flow -- this module
// only decides *which* facts of a tool call are worth a row, and reads those
// facts out of the tool's own structured result rather than its raw blob.
//
//   o Found it. The loop breaks on the wrong event.
//     | | grep  content_block_stop                            4 files
//     | + src/streaming.ts:42 | 3 more
//     |   edit  src/streaming.ts                      +6 -1 | 1 hunk
//     |    42 - if (event.type === 'content_block_stop') break
//     |    42 + if (event.type === 'content_block_stop') {
//     | x run   npx vitest run                                    2.6s
//     | + 1 failed, 24 passed
//
// Note which rows carry a mark. `grep` and `edit` do not announce that they
// worked, because they almost always do; their receipts carry the news. The
// green tick belongs to a check that passed and the red cross to work that
// failed, so both still mean something by the time you reach them.
//
// renderToolActivity renders ONE call and is used by both paths. Only the batch
// replay renderer (renderTranscript) -- which can see the whole list -- collapses
// a run of reads into one row; the live stream cannot look ahead.

import { faint, info, muted } from "./theme";
import { glyph } from "./glyphs";
import { truncate } from "./render";
import { renderMarkdown } from "./markdown";
import { langOfPath } from "./code-paint";
import * as F from "./flow";

/** The assistant-narration marker. */
export const STEP = glyph("live");

export interface ToolActivityView {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** One replayed transcript line. Structurally compatible with the engine's
 *  TranscriptLine so callers can pass `engine.getTranscript()` straight in. */
export interface TranscriptLineView {
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

const s = (v: unknown): string => (v == null ? "" : String(v));
const firstLine = (v: string): string => v.split("\n")[0] ?? "";

/** Looser shortening for the bare-path file listing: workspace-relative paths
 *  show whole (`src/apps/ipod/ClickWheel.tsx`); only deep/absolute ones cut. */
function listingPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (!p.startsWith("/") && parts.length <= 6) return p;
  if (parts.length <= 4) return p;
  return ".../" + parts.slice(-4).join("/");
}

/**
 * Harness prose travels INSIDE a tool result string: a `[Doctrine — …]` or
 * `[Harness note] …` block prepended (each ends at a blank line) and a
 * `[post-tool hook output]` block appended. The model needs them where they
 * are; the renderer does not -- JSON.parse choked on the prose, so an edit
 * whose result carried a doctrine block rendered as a bare `edit foo.ts` with
 * no diff and no path. This is the envelope, peeled deterministically: leading
 * bracketed notes come off at their blank line, the trailing hook block comes
 * off at its marker, and a body that still opens with prose is cut at the
 * first line that opens a JSON value after a blank line. The notes are
 * returned rather than dropped, for a surface that wants them.
 */
export function unwrapEnvelope(raw: string): { body: string; notes: string[] } {
  const notes: string[] = [];
  let text = raw;
  let trailing = "";
  const hook = text.indexOf("\n\n[post-tool hook output]\n");
  if (hook >= 0) {
    trailing = text.slice(hook + 2).trim();
    text = text.slice(0, hook);
  }
  // Leading notes, each a bracketed heading and its paragraph.
  for (;;) {
    if (!/^\[(?:Doctrine|Harness note)\b/.test(text)) break;
    const cut = text.indexOf("\n\n");
    if (cut < 0) break;
    notes.push(text.slice(0, cut).trim());
    text = text.slice(cut + 2).replace(/^\n+/, "");
  }
  // Whatever prose is still in front of a JSON body: cut at the value.
  if (!/^\s*[[{]/.test(text)) {
    const lines = text.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (lines[i - 1]!.trim() === "" && /^[[{]/.test(lines[i]!)) {
        notes.push(lines.slice(0, i).join("\n").trim());
        text = lines.slice(i).join("\n");
        break;
      }
    }
  }
  if (trailing) notes.push(trailing);
  return { body: text, notes };
}

function tryJson(raw: string): Record<string, unknown> | null {
  const { body } = unwrapEnvelope(raw);
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    // The belt under the envelope: a note the peel did not recognise still
    // leaves the object intact after its first brace.
    const brace = body.indexOf("{");
    if (brace > 0) {
      try {
        const v = JSON.parse(body.slice(brace));
        return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** The result as text, with the harness envelope taken off. */
function bodyOf(raw: string): string {
  return unwrapEnvelope(raw).body;
}

/** Non-empty result lines -- a cheap proxy for grep match / output counts. */
function nonEmptyLines(result: string): string[] {
  return result
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * What a call was about, in words, for a tool the grammar has no case for:
 * its most descriptive scalar argument. A row never shows an object -- the
 * old `{"criterion":0,"command":"curl -sS …` rows were the reader doing the
 * tool's summarising, and a failure that quotes its whole argument object
 * has named nothing.
 */
export function describeArgs(args: Record<string, unknown>): string {
  const preferred = [
    "label",
    "name",
    "title",
    "path",
    "pattern",
    "command",
    "query",
    "url",
    "text",
    "question",
    "prompt",
    "key",
    "action",
    "id",
  ];
  const pick = (v: unknown): string => {
    if (typeof v === "string") return firstLine(v).trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
    return "";
  };
  for (const key of preferred) {
    const got = pick(args[key]);
    if (got) return truncate(got, 60);
  }
  for (const value of Object.values(args)) {
    const got = pick(value);
    if (got) return truncate(got, 60);
  }
  return "";
}

/**
 * The harness's own tools: the plan ledger, the read-back and its evidence,
 * the narrative, the question to the user, the team bus, configuration.
 * Their failures are bookkeeping, not work that went wrong -- a refused
 * completion is not a defect in the tree -- so the transcript sets them down
 * as quiet notes and the receipt never counts them among the failures.
 */
export const HARNESS_TOOLS: ReadonlySet<string> = new Set([
  "todo_write",
  "read_back",
  "record_evidence",
  "note_hypothesis",
  "record_decision",
  "ask_user",
  "team",
  "update_config",
  "load_tools",
  "skill",
]);

export function isHarnessTool(name: string): boolean {
  return HARNESS_TOOLS.has(name);
}

/** The `o <text>` head that opens an assistant narration step (first line only). */
export function stepHead(line: string): string {
  return F.said(line).split("\n")[0] ?? "";
}

/**
 * An assistant narration block: one dot, then prose aligned beneath it. The
 * model writes Markdown mid-turn as readily as it does in its final answer -- a
 * numbered plan, a path in backticks -- so this renders it rather than printing
 * the markup, which is what a reader would otherwise have to decode by eye.
 */
export function stepBlock(prose: string): string[] {
  // The TOTAL line budget -- renderMarkdown subtracts F.BODY itself. See
  // responseBlock(): passing proseWidth() here paid for the indent twice.
  const body = renderMarkdown(prose, { width: F.measure(), indent: F.BODY });
  return body.length ? F.dot(body) : [];
}

/** A progress paragraph. The agent's intent reads in its own voice -- there is
 *  no "Plan:" label, because a sentence that needs a label is not a sentence. */
export function planBlock(prose: string): string[] {
  const clean = prose.trim().replace(/^plan\s*:\s*/i, "");
  return clean ? stepBlock(clean) : [];
}

// --- Tool grammar ---
// Every call renders the same shape: a rail, a status, a four-column verb, the
// thing it acted on, and the receipt hard against the right edge. Whatever the
// call produced that the reader actually needs -- a diff, a command's output --
// hangs beneath it on the same rail, never in a box of its own. Nothing here
// paraphrases: the command shown is the command run, the count shown is the
// count the tool reported.

/** The verb column. Four characters wherever the language allows it, so a run
 *  of calls lines up without anyone drawing a table. */
const VERB: Record<string, string> = {
  bash: "run",
  read_file: "read",
  list_dir: "list",
  grep: "grep",
  glob: "glob",
  symbol_search: "find",
  lsp: "lsp",
  write_file: "new",
  edit_file: "edit",
  multi_edit: "edit",
  apply_patch: "edit",
  web_search: "web",
  web_fetch: "get",
  task: "scout",
  worker: "work",
  todo_write: "plan",
  bash_output: "poll",
  kill_shell: "stop",
  interactive_dashboard: "view",
  read_many: "read",
  ask_user: "ask",
  read_back: "read-back",
  record_evidence: "evidence",
  note_hypothesis: "hypothesis",
  record_decision: "decision",
  team: "team",
  update_config: "config",
  load_tools: "tools",
  skill: "skill",
};

/** The verb a tool's row opens with -- the same one its provisional row opens with. */
export function verbOf(toolName: string): string {
  return VERB[toolName] ?? toolName;
}

/** Present-tense verb for the live "what's running now" status line. */
const RUNNING: Record<string, string> = {
  bash: "running",
  read_file: "reading",
  list_dir: "listing",
  grep: "searching",
  glob: "matching",
  write_file: "writing",
  edit_file: "editing",
  multi_edit: "editing",
  web_search: "searching the web",
  web_fetch: "fetching",
  interactive_dashboard: "building a view",
  task: "scouting",
  worker: "delegating",
  read_many: "reading",
  apply_patch: "editing",
  ask_user: "asking",
  read_back: "reading back",
  record_evidence: "citing",
  note_hypothesis: "noting",
  record_decision: "deciding",
  todo_write: "planning",
};

/** A short label for an in-flight tool call (args aren't known yet at start). */
export function runningLabel(toolName: string): string {
  return RUNNING[toolName] ?? toolName;
}

/** Commands whose result is evidence, rather than merely another action.
 *  Defined beside the check log (brief.ts) since the loop and the engine
 *  judge evidence by it too; re-exported here for the UI's existing imports. */
import { isVerificationCommand } from "../../brief";
export { isVerificationCommand };

/** `840ms` / `2.6s` / `2m 58s` -- a duration only when the harness actually
 *  timed the call. Past a minute it switches to minutes: a delegation routinely
 *  runs for several, and `178.0s` is a number a reader has to divide before it
 *  means anything. */
function elapsed(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The one-line outcome of a command: the runner's own tally when it printed
 * one, else the last line it wrote. Scanned from the end, because a runner
 * states its verdict last and its per-file counts first -- reading forward finds
 * `Test Files 1 failed | 1 passed` and reports it as the result.
 */
export function commandOutcome(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const passed = /\b(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/.exec(line)?.[1];
    const failed = /\b(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/.exec(line)?.[1];
    if (passed != null && failed != null) return `${failed} failed, ${passed} passed`;
    if (passed != null) return `${passed} passed`;
    if (failed != null) return `${failed} failed`;
  }
  return lines.at(-1) ?? "";
}

/** stdout + stderr as the process wrote them, in order. */
function outputOf(parsed: Record<string, unknown> | null): string {
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
  return (stdout + (stdout && stderr ? "\n" : "") + stderr).trimEnd();
}

/** Output as rail rows: split, with trailing blank lines dropped. */
function railLines(body: string): string[] {
  const all = body.split("\n");
  while (all.length > 0 && !all.at(-1)!.trim()) all.pop();
  return all;
}

// The committed excerpt of a failed command: enough signal to know WHAT failed
// without opening anything, sized so the verdict is never further than a
// glance from the row. The full output lives behind the fold.
const EXCERPT_HEAD = 5;
const EXCERPT_TAIL = 3;

/** Output lines a command that merely RAN shows inline before its last line:
 *  four, so the head and the verdict make five, and the rest is the fold's. */
const INLINE_HEAD = 4;

/** How much of an expanded fold a single call may spend. Bounds memory and the
 *  worst-case splice, not the truth: the ledger under ctrl+r keeps going. */
const DETAIL_HEAD = 240;
const DETAIL_TAIL = 60;

/** How much of a NEW file rides inline under its row. */
const WRITE_PREVIEW_ROWS = 12;

/** New-file content as add rows, numbered from 1, elided past `limit`. */
function writeRows(content: string, limit: number): F.DiffRow[] {
  const lines = content.split("\n");
  const rows: F.DiffRow[] = lines
    .slice(0, limit)
    .map((text, i) => ({ kind: "add" as const, line: i + 1, text }));
  if (lines.length > limit) {
    rows.push({ kind: "elide", text: `${lines.length - limit} more lines` });
  }
  return rows;
}

/**
 * The one line of a sub-agent's report worth setting down beside its row.
 *
 * A delegation is the only call whose result is PROSE, and the only one that
 * can run for minutes, so the usual receipt (`2m 58s`) leaves a reader knowing
 * exactly how long they waited and nothing about what came back. This is the
 * first substantive sentence of what it said -- not a summary of the summary,
 * just its opening, which is where a scout puts its finding.
 *
 * The two banner cases lead instead of the prose, because when a report is
 * marked unverified the fact that it is unverified IS the news about it. Both
 * are rendered in the failure tone: they are the two states that must not slide
 * past as ordinary output.
 */
function delegationTakeaway(result: string): { text: string; tone: "muted" | "fail" } | null {
  const body = result.trim();
  if (!body || looksLikeJson(body)) return null;
  if (body.startsWith("[PROVENANCE")) {
    return { text: "came back on a fallback model -- re-check before relying on it", tone: "fail" };
  }
  if (body.startsWith("INCOMPLETE")) {
    return { text: truncate(firstLine(body), 120), tone: "fail" };
  }
  for (const raw of body.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue; // a section heading names nothing
    // A worker opens with its own file tally, which is already the row's
    // receipt; repeating it here would spend the note saying nothing new.
    if (/^worker changed \d+ files?\b/.test(raw.trim())) continue;
    const line = raw
      .replace(/^[\s>*\-+]+/, "")
      .replace(/[`*_]/g, "")
      .trim();
    if (line.length < 12) continue;
    return { text: truncate(line, 120), tone: "muted" };
  }
  return null;
}

/** A failed call, in one row and one reason. Nothing is hidden and nothing is
 *  padded: the row says which call, the note says what the tool actually said. */
function failedCall(v: ToolActivityView, name: string): string {
  const reason = firstLine(v.error ?? "failed").trim() || "failed";
  // The ledger declining a claim, a question the user did not answer, a
  // citation with nothing behind it: the harness talking, not the tree
  // breaking. One quiet row and the reason, in the neutral tone.
  const harness = isHarnessTool(v.toolName);
  return [
    F.toolRow({
      name,
      arg: compactTarget(v),
      status: harness ? "none" : "fail",
      metric: harness ? "" : elapsed(v.durationMs),
    }),
    F.toolNote(reason, harness ? "muted" : "fail"),
  ].join("\n");
}

/** The questions an ask_user call carried, whichever shape the model used. */
function questionsOf(args: Record<string, unknown>): string[] {
  const list = Array.isArray(args.questions) ? args.questions : [];
  const out = list
    .map((q) => (q && typeof q === "object" ? s((q as Record<string, unknown>).question) : s(q)))
    .filter(Boolean);
  if (out.length === 0 && s(args.question)) out.push(s(args.question));
  return out;
}

/** Structured data, not prose: an object, or an array of values. A banner
 *  such as `[PROVENANCE …]` opens with a bracket too, and is prose. */
function looksLikeJson(text: string): boolean {
  return /^\{|^\[\s*(?:[[{"\]]|-?\d)/.test(text);
}

/** A line of a result worth quoting under its row: the first non-empty one,
 *  unless the result is structured data, which the row has already read. */
function quotable(result: string): string {
  const body = bodyOf(result).trim();
  if (!body || looksLikeJson(body)) return "";
  return firstLine(body).trim();
}

/** The first answer in an ask_user result: the whole reply for one question,
 *  the first `A:` line for several. */
function firstAnswer(result: string): string {
  const body = bodyOf(result).trim();
  if (!body || looksLikeJson(body)) return "";
  const multi = /^A:\s*(.+)$/m.exec(body);
  return firstLine(multi ? multi[1]! : body).trim();
}

/**
 * Render one completed tool call. The default is a single row -- the whole point
 * of the receipt column is that most work needs no more than that. Two calls
 * earn more: an edit always shows its diff, and a command that failed or was a
 * check always shows its real output, because those are the two moments where a
 * summary is not good enough.
 */
export function renderToolActivity(v: ToolActivityView): string {
  const name = VERB[v.toolName] ?? v.toolName;
  if (!v.success) return failedCall(v, name);
  const out = tryJson(v.result);

  switch (v.toolName) {
    case "read_file": {
      const total = typeof out?.total_lines === "number" ? out.total_lines : null;
      const shown = typeof out?.lines_shown === "number" ? out.lines_shown : null;
      const offset = typeof out?.offset === "number" ? out.offset : 0;
      const partial = total != null && shown != null && shown < total;
      return F.toolRow({
        name,
        arg: listingPath(s(out?.path ?? v.args.path)),
        metric: partial
          ? `lines ${offset + 1}-${offset + shown}`
          : total != null
            ? `${total} lines`
            : "",
      });
    }

    case "list_dir": {
      const count = typeof out?.total_count === "number" ? out.total_count : null;
      return F.toolRow({
        name,
        arg: (listingPath(s(out?.path ?? v.args.path) || ".") + "/").replace(/\/+$/, "/"),
        metric: count != null ? `${count} ${count === 1 ? "entry" : "entries"}` : "",
      });
    }

    case "grep": {
      const matches = Array.isArray(out?.matches)
        ? (out.matches as Array<Record<string, unknown>>)
        : [];
      const total = typeof out?.total_matches === "number" ? out.total_matches : matches.length;
      const files = new Set(matches.map((m) => String(m.file ?? ""))).size;
      const rows = [
        F.toolRow({
          name,
          arg: s(v.args.pattern),
          metric:
            total === 0
              ? "no matches"
              : files > 1
                ? `${files} files`
                : `${total} match${total === 1 ? "" : "es"}`,
        }),
      ];
      // Where the first hit is beats how many there were -- that is the line the
      // reader is about to open.
      const first = matches[0];
      if (first) {
        const rest = total - 1;
        rows.push(
          F.toolNote(
            `${listingPath(String(first.file ?? ""))}:${first.line_number ?? "?"}` +
              (rest > 0 ? ` | ${rest} more` : ""),
          ),
        );
      }
      return rows.join("\n");
    }

    case "glob":
    case "symbol_search":
    case "lsp": {
      const found = nonEmptyLines(v.result).length;
      return F.toolRow({
        name,
        arg: s(v.args.pattern ?? v.args.query ?? v.args.symbol ?? v.args.path),
        metric: found > 0 ? `${found} result${found === 1 ? "" : "s"}` : "",
      });
    }

    case "write_file": {
      const path = s(out?.path ?? v.args.path);
      const body = s(v.args.content);
      const added = body ? body.split("\n").length : 0;
      const rows = [
        F.toolRow({
          name,
          arg: listingPath(path),
          argTone: "path",
          status: "none",
          metric: F.editMetric(added, 0, "new file"),
        }),
      ];
      // A new file IS a change to the tree, so it shows its opening the way an
      // edit shows its hunk -- enough to judge what arrived, never the whole
      // file. The rest sits behind the fold like any long evidence.
      if (body) {
        rows.push(...F.diffRows(writeRows(body, WRITE_PREVIEW_ROWS), langOfPath(path)));
      }
      return rows.join("\n");
    }

    case "edit_file":
    case "multi_edit": {
      const path = s(out?.path ?? v.args.path);
      const raw = s(out?.diff);
      if (!raw) {
        return F.toolRow({ name, arg: listingPath(path), argTone: "path", status: "none" });
      }
      const diff = F.parseDiff(raw);
      const hunkNote = diff.hunks > 0 ? `${diff.hunks} hunk${diff.hunks === 1 ? "" : "s"}` : "";
      return [
        F.toolRow({
          name,
          arg: listingPath(path),
          argTone: "path",
          status: "none",
          metric: F.editMetric(diff.added, diff.removed, hunkNote),
        }),
        ...F.diffRows(diff.rows, langOfPath(path)),
      ].join("\n");
    }

    case "apply_patch": {
      // One patch can touch several files; each carries its own diff now (see
      // apply-patch.ts). A row per file, its diff beneath it -- the same shape
      // an edit_file row has, so a multi-file patch reads as a short stack of
      // edits rather than one opaque `apply_patch` line.
      const files = Array.isArray(out?.files) ? (out!.files as Array<Record<string, unknown>>) : [];
      if (files.length === 0) {
        return F.toolRow({
          name,
          arg: listingPath(s(v.args.path)),
          argTone: "path",
          status: "none",
        });
      }
      const rows: string[] = [];
      for (const file of files) {
        const path = s(file.path ?? file.moved_to);
        const raw = s(file.diff);
        const action = s(file.action);
        const diff = raw ? F.parseDiff(raw) : { rows: [], added: 0, removed: 0, hunks: 0 };
        const hunkNote =
          action === "deleted"
            ? "deleted"
            : action === "moved"
              ? "moved"
              : diff.hunks > 0
                ? `${diff.hunks} hunk${diff.hunks === 1 ? "" : "s"}`
                : "";
        rows.push(
          F.toolRow({
            name,
            arg: listingPath(path),
            argTone: "path",
            status: "none",
            metric: F.editMetric(diff.added, diff.removed, hunkNote),
          }),
        );
        rows.push(...F.diffRows(diff.rows, langOfPath(path)));
      }
      return rows.join("\n");
    }

    case "bash": {
      const command = firstLine(s(v.args.command));
      const exit = typeof out?.exit_code === "number" ? out.exit_code : null;
      const timedOut = out?.timed_out === true;
      const failed = timedOut || (exit != null && exit !== 0);
      const body = outputOf(out);
      // What the runner said about itself beats what the shell said about the
      // runner: `1 failed, 24 passed` is the news; `exit 1` only repeats it.
      const summary = timedOut
        ? "timed out"
        : commandOutcome(body) || (failed ? `exit ${exit}` : "");
      // Where the green tick gets spent. A command that *checked* something and
      // came back clean is the one routine outcome worth announcing -- it is the
      // only row on the rail that answers "is it actually right?". A command
      // that merely ran takes the neutral mark like every other call.
      const checked = isVerificationCommand(command);
      const rows = [
        F.toolRow({
          name,
          arg: command,
          status: failed ? "fail" : checked ? "pass" : "ok",
          metric: elapsed(v.durationMs),
        }),
      ];
      // A FAILURE shows a short excerpt of its evidence -- the budget is spent
      // on signal lines (assertions, FAILED names, the tally), and its own last
      // line closes the rail as the verdict. That is the whole print-out the
      // transcript gets: two hundred raw lines under a row is not evidence, it
      // is the reader doing the tool's summarising, and the full output stays
      // one keystroke away behind the row's fold (see renderToolDetail). A
      // check that PASSED needs only its verdict. A command that merely ran
      // shows its first lines and its last -- the receipt used to be its last
      // line alone, whatever that line happened to be, which is how `ls -lh`
      // came to be summarised as `<!doctype html>` -- with the count of what
      // the fold holds.
      if (failed && body) {
        const all = railLines(body);
        const closing = all.length > 1 ? all.pop()!.trim() : "";
        rows.push(
          ...F.outputRail("", F.clip(all, EXCERPT_HEAD, EXCERPT_TAIL), closing || summary, true),
        );
      } else if (checked) {
        if (summary) rows.push(F.toolNote(summary, "ok"));
      } else if (body) {
        const all = railLines(body);
        const closing = all.pop()!.trim();
        const head = all.slice(0, INLINE_HEAD);
        const hidden = Math.max(0, all.length - head.length);
        const shown = [...head];
        if (hidden > 0)
          shown.push(`${glyph("elision")} ${hidden} more line${hidden === 1 ? "" : "s"}`);
        rows.push(...F.outputRail("", shown, closing, false));
      } else if (summary) {
        rows.push(F.toolNote(summary, "muted"));
      }
      return rows.join("\n");
    }

    case "web_search": {
      const found = nonEmptyLines(v.result).length;
      return F.toolRow({
        name,
        arg: s(v.args.query ?? v.args.q ?? ""),
        metric: found > 0 ? `${found} result${found === 1 ? "" : "s"}` : "",
      });
    }

    case "web_fetch":
      return F.toolRow({
        name,
        arg: s(v.args.url ?? v.args.uri ?? ""),
        metric: `${nonEmptyLines(v.result).length} lines`,
      });

    case "todo_write": {
      // The checklist renders from the todo event; this row is only the receipt.
      const items = Array.isArray(v.args.items) ? v.args.items.length : 0;
      return F.toolRow({
        name,
        arg: "updated",
        metric: items > 0 ? `${items} step${items === 1 ? "" : "s"}` : "",
      });
    }

    case "bash_output":
    case "kill_shell":
      return F.toolRow({ name, arg: s(v.args.shell_id ?? v.args.id ?? "") });

    case "worker":
    case "task": {
      const brief =
        s(v.args.label ?? "") ||
        firstLine(s(v.args.prompt ?? v.args.description ?? "")) ||
        (v.toolName === "worker" ? "a build" : "an investigation");
      const report = bodyOf(v.result ?? "");
      const changed = /worker changed (\d+) files?/.exec(report)?.[1];
      const steps = /\(sub-agent made (\d+) tool calls?/.exec(report)?.[1];
      const rows = [
        F.toolRow({
          name,
          arg: brief,
          metric: F.receiptOf([
            changed ? `${changed} files` : steps ? `${steps} steps` : "",
            elapsed(v.durationMs),
          ]),
        }),
      ];
      // What came BACK. Without this a three-minute scout left one row naming
      // what it was asked and nothing at all about what it found -- the whole
      // investigation reduced to a duration. The banner cases lead instead,
      // because a report that has to be re-checked is the news about it.
      const takeaway = delegationTakeaway(report);
      if (takeaway) rows.push(F.toolNote(takeaway.text, takeaway.tone));
      return rows.join("\n");
    }

    case "interactive_dashboard": {
      const url = s(out?.url ?? "");
      const rows = [
        F.toolRow({ name, arg: s(out?.title ?? v.args.title) || s(v.args.action) || "dashboard" }),
      ];
      if (url) rows.push(F.toolNote(url));
      return rows.join("\n");
    }

    // ── The harness's own tools ──
    // Each says what it was FOR and what came of it, in words. The old rows
    // printed the argument object (`{"questions":[{"question":"Which data…`),
    // which is the one thing a rail must never do.

    case "ask_user": {
      const questions = questionsOf(v.args);
      const answer = firstAnswer(v.result);
      const rows = [
        F.toolRow({
          name,
          arg: truncate(questions[0] ?? "a question", 60),
          metric:
            questions.length > 1 ? `${questions.length} questions` : answer ? "" : "no answer",
        }),
      ];
      if (answer) rows.push(F.toolNote(`answered ${answer}`));
      return rows.join("\n");
    }

    case "record_evidence": {
      const reply = quotable(v.result);
      const rung = /\b(verified|reproduced|observed)\b/.exec(reply)?.[1] ?? "";
      const target =
        typeof v.args.criterion === "number"
          ? `criterion ${v.args.criterion + 1}`
          : s(v.args.claim ?? v.args.criterion)
            ? truncate(s(v.args.claim ?? v.args.criterion), 40)
            : "";
      const rows = [
        F.toolRow({
          name,
          arg: F.receiptOf([target, truncate(firstLine(s(v.args.command)), 48)]),
          metric: rung,
        }),
      ];
      // No rung means the runtime declined the citation; its one line says why.
      if (!rung && reply) rows.push(F.toolNote(reply));
      return rows.join("\n");
    }

    case "note_hypothesis": {
      const text = s(v.args.text);
      const status = s(v.args.status) || (text ? "testing" : "");
      const rows = [
        F.toolRow({
          name,
          arg: text ? `"${truncate(text, 58)}"` : s(v.args.id),
          metric: status,
        }),
      ];
      const reason = s(v.args.reason);
      if (reason) rows.push(F.toolNote(truncate(reason, 80)));
      return rows.join("\n");
    }

    case "record_decision": {
      const refs = Array.isArray(v.args.based_on) ? v.args.based_on.length : 0;
      return F.toolRow({
        name,
        arg: truncate(s(v.args.text), 60),
        metric: refs > 0 ? `on ${refs} piece${refs === 1 ? "" : "s"} of evidence` : "unbacked",
      });
    }

    case "read_back": {
      const criteria = Array.isArray(v.args.done_when) ? v.args.done_when.length : 0;
      const reply = quotable(v.result);
      const accepted = /^accepted\b/i.test(reply);
      const rows = [
        F.toolRow({
          name,
          arg: s(v.args.kind) || "brief",
          metric: F.receiptOf([
            criteria > 0 ? `${criteria} criteri${criteria === 1 ? "on" : "a"}` : "",
            accepted ? "accepted" : reply ? "sent back" : "",
          ]),
        }),
      ];
      if (!accepted && reply) rows.push(F.toolNote(truncate(reply, 100)));
      return rows.join("\n");
    }

    case "read_many": {
      const paths = Array.isArray(v.args.paths) ? v.args.paths.map((p) => s(p)) : [];
      const text = bodyOf(v.result);
      const heads = (text.match(/^=== .+ ===$/gm) ?? []).length;
      const lines = text.split("\n").length - heads;
      return F.toolRow({
        name,
        arg: `${paths.length || heads} file${(paths.length || heads) === 1 ? "" : "s"}`,
        metric: lines > 0 && heads > 0 ? `${group(lines)} lines` : "",
      });
    }

    case "team": {
      const paths = Array.isArray(v.args.paths) ? v.args.paths.map((p) => s(p)) : [];
      return F.toolRow({
        name,
        arg: F.receiptOf([s(v.args.action), paths.length ? truncate(paths.join(", "), 48) : ""]),
      });
    }

    case "update_config": {
      const key = s(v.args.key ?? v.args.setting ?? v.args.name);
      const value = s(v.args.value);
      return F.toolRow({ name, arg: key ? (value ? `${key} = ${truncate(value, 30)}` : key) : "" });
    }

    case "load_tools":
    case "skill":
      return F.toolRow({ name, arg: describeArgs(v.args) });

    default:
      // MCP / unknown tool -- its own name, and what its arguments were about.
      return F.toolRow({ name, arg: describeArgs(v.args), metric: elapsed(v.durationMs) });
  }
}

/** What a call is about, from its arguments alone -- the provisional row a
 *  live sink commits the moment the call starts names it with this. */
export function targetOf(toolName: string, args: Record<string, unknown>): string {
  return compactTarget({ toolName, args, result: "", success: true });
}

/** Best-effort subject for a failed call (arguments only -- the result is an error). */
function compactTarget(v: ToolActivityView): string {
  switch (v.toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "list_dir":
      return listingPath(s(v.args.path));
    case "grep":
    case "glob":
      return s(v.args.pattern);
    case "bash":
      return firstLine(s(v.args.command));
    case "web_fetch":
      return s(v.args.url ?? v.args.uri ?? "");
    case "web_search":
      return s(v.args.query ?? v.args.q ?? "");
    case "todo_write":
      return "updated";
    case "bash_output":
    case "kill_shell":
      return s(v.args.shell_id ?? v.args.id ?? "");
    case "interactive_dashboard":
      return s(v.args.title ?? v.args.id ?? v.args.action ?? "");
    case "worker":
    case "task":
      return s(v.args.label ?? "") || firstLine(s(v.args.prompt ?? v.args.description ?? ""));
    case "ask_user":
      return truncate(questionsOf(v.args)[0] ?? "a question", 60);
    case "record_evidence":
      return truncate(firstLine(s(v.args.command)), 60);
    case "note_hypothesis":
      return s(v.args.text) ? `"${truncate(s(v.args.text), 58)}"` : s(v.args.id);
    case "record_decision":
      return truncate(s(v.args.text), 60);
    case "read_back":
      return s(v.args.kind) || "brief";
    case "read_many": {
      const paths = Array.isArray(v.args.paths) ? v.args.paths.length : 0;
      return `${paths} file${paths === 1 ? "" : "s"}`;
    }
    default:
      return describeArgs(v.args);
  }
}

function toView(ln: TranscriptLineView): ToolActivityView {
  return {
    toolName: ln.toolName ?? ln.text,
    args: ln.args ?? {},
    result: ln.result ?? "",
    success: !ln.isError,
    error: ln.isError ? ln.result || "failed" : undefined,
  };
}

/**
 * Batch-render a replayed transcript (session resume / startup seeding) into the
 * same thought-chain language as a live turn. Consecutive successful reads
 * collapse into a single `Read N files` line; everything else renders per-call.
 */
export function renderTranscript(lines: TranscriptLineView[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.role === "user") {
      out.push(F.asked(ln.text));
      i++;
    } else if (ln.role === "assistant") {
      out.push(...stepBlock(ln.text));
      i++;
    } else if (ln.role === "note") {
      out.push(`  ${faint(`-- ${ln.text} --`)}`);
      i++;
    } else if (ln.role === "tool") {
      // Collapse a run of chamber-eligible calls into one chamber row -- the
      // same reading a live turn commits, so a resumed session and a watched
      // one cannot be told apart.
      let j = i;
      const run: ToolActivityView[] = [];
      while (j < lines.length && lines[j]!.role === "tool") {
        const view = toView(lines[j]!);
        if (!isChamberView(view)) break;
        run.push(view);
        j++;
      }
      if (run.length >= CHAMBER_AT) {
        out.push(renderChamberHead(run));
        i = j;
      } else {
        out.push(renderToolActivity(toView(ln)));
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("\n");
}

// --- Folds: the full evidence behind a committed row ---
// The transcript states outcomes; the fold holds the print-out. Everything
// here renders the OPEN form of a block whose committed form held something
// back -- the same rows, plus the evidence the summary elided -- so the fixed
// viewport can swap one for the other in place. Returning null means the
// committed form already shows everything and the row has nothing to open.

/**
 * The expanded rendering for one successful call, or null when the committed
 * row already is the whole story. Kept in this module so the two forms of a
 * call are written next to each other and cannot drift apart.
 */
export function renderToolDetail(v: ToolActivityView): string | null {
  if (!v.success) return null;
  const out = tryJson(v.result);
  switch (v.toolName) {
    case "bash": {
      const command = firstLine(s(v.args.command));
      const body = outputOf(out);
      if (!body) return null;
      const all = railLines(body);
      const exit = typeof out?.exit_code === "number" ? out.exit_code : null;
      const failed = out?.timed_out === true || (exit != null && exit !== 0);
      // A failure already showed an excerpt; a passing check showed its
      // verdict; a command that merely ran showed its first lines and its last.
      const shownInline = failed
        ? EXCERPT_HEAD + EXCERPT_TAIL + 2
        : isVerificationCommand(command)
          ? 1
          : INLINE_HEAD + 1;
      if (all.length <= shownInline) return null;
      const checked = isVerificationCommand(command);
      const closing = all.length > 1 ? all.pop()!.trim() : "";
      return [
        F.toolRow({
          name: VERB.bash!,
          arg: command,
          status: failed ? "fail" : checked ? "pass" : "ok",
          metric: elapsed(v.durationMs),
        }),
        ...F.outputRail("", F.clip(all, DETAIL_HEAD, DETAIL_TAIL), closing || undefined, failed),
      ].join("\n");
    }
    case "edit_file":
    case "multi_edit": {
      const path = s(out?.path ?? v.args.path);
      const raw = s(out?.diff);
      if (!raw) return null;
      const full = F.parseDiff(raw, DETAIL_HEAD);
      const shown = F.parseDiff(raw);
      // Worth opening only when the committed hunk actually dropped rows.
      if (full.rows.length <= shown.rows.length) return null;
      const hunkNote = full.hunks > 0 ? `${full.hunks} hunk${full.hunks === 1 ? "" : "s"}` : "";
      return [
        F.toolRow({
          name: "edit",
          arg: listingPath(path),
          argTone: "path",
          status: "none",
          metric: F.editMetric(full.added, full.removed, hunkNote),
        }),
        ...F.diffRows(full.rows, langOfPath(path)),
      ].join("\n");
    }
    case "write_file": {
      const path = s(out?.path ?? v.args.path);
      const body = s(v.args.content);
      const total = body ? body.split("\n").length : 0;
      if (total <= WRITE_PREVIEW_ROWS) return null;
      return [
        F.toolRow({
          name: VERB.write_file!,
          arg: listingPath(path),
          argTone: "path",
          status: "none",
          metric: F.editMetric(total, 0, "new file"),
        }),
        ...F.diffRows(writeRows(body, DETAIL_HEAD), langOfPath(path)),
      ].join("\n");
    }
    case "apply_patch": {
      // Every file's whole diff. Worth opening only when some file's
      // committed hunk dropped rows.
      const files = Array.isArray(out?.files) ? (out!.files as Array<Record<string, unknown>>) : [];
      let dropped = false;
      const rows: string[] = [];
      for (const file of files) {
        const path = s(file.path ?? file.moved_to);
        const raw = s(file.diff);
        const full = raw
          ? F.parseDiff(raw, DETAIL_HEAD)
          : { rows: [], added: 0, removed: 0, hunks: 0 };
        const shown = raw ? F.parseDiff(raw) : full;
        if (full.rows.length > shown.rows.length) dropped = true;
        const action = s(file.action);
        const note =
          action === "deleted"
            ? "deleted"
            : action === "moved"
              ? "moved"
              : full.hunks > 0
                ? `${full.hunks} hunk${full.hunks === 1 ? "" : "s"}`
                : "";
        rows.push(
          F.toolRow({
            name: "edit",
            arg: listingPath(path),
            argTone: "path",
            status: "none",
            metric: F.editMetric(full.added, full.removed, note),
          }),
        );
        rows.push(...F.diffRows(full.rows, langOfPath(path)));
      }
      return dropped ? rows.join("\n") : null;
    }
    case "read_many": {
      // The batch row names a count; the fold names the files.
      const paths = Array.isArray(v.args.paths) ? v.args.paths.map((p) => s(p)) : [];
      if (paths.length === 0) return null;
      return [
        renderToolActivity(v),
        ...paths.map((p) => F.toolRow({ name: "read", arg: listingPath(p), status: "none" })),
      ].join("\n");
    }
    default:
      return null;
  }
}

// --- The chamber ---
// Context-gathering is the bulk of every turn and almost none of its news. A
// run of thirty reads is one fact ("it read the module"), and printing it as
// thirty rows spends the reader's whole screen establishing that fact while the
// sentence that matters scrolls past. So a finished burst sets down as ONE row
// -- the chamber -- with its per-call record behind the fold, where a reader who
// wants to know exactly what ran in that stretch opens it in place.

/** Tools whose individual rows are context, not news. */
const ROUTINE = new Set(["read_file", "list_dir", "grep", "glob", "symbol_search", "lsp"]);

export function isRoutineTool(name: string): boolean {
  return ROUTINE.has(name);
}

/**
 * Whether a finished call may ride in a chamber instead of standing alone.
 * Gathering always may. A web call is gathering with a different network. A
 * command may ONLY when it succeeded and was not a check: a failure is news, a
 * check is evidence, and both must stand where the eye will hit them.
 */
export function isChamberView(v: ToolActivityView): boolean {
  if (!v.success) return false;
  if (ROUTINE.has(v.toolName)) return true;
  if (v.toolName === "web_search" || v.toolName === "web_fetch") return true;
  if (v.toolName === "bash") {
    const out = tryJson(v.result);
    const exit = typeof out?.exit_code === "number" ? out.exit_code : null;
    if (out?.timed_out === true || (exit != null && exit !== 0)) return false;
    return !isVerificationCommand(firstLine(s(v.args.command)));
  }
  return false;
}

/** `1,204` — thousands grouped without a locale, so the row reads the same on
 *  every machine and in every test. */
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** How long a run of chamber-eligible calls has to get before it is worth more
 *  as one row than as a list. Two paths are worth naming; twelve are one fact. */
export const CHAMBER_AT = 3;

function chamberPhrase(views: ToolActivityView[]): { phrase: string; lines: number } {
  let files = 0;
  let dirs = 0;
  let searches = 0;
  let commands = 0;
  let web = 0;
  let lines = 0;
  for (const view of views) {
    const out = tryJson(view.result);
    if (view.toolName === "read_file") {
      files++;
      const total = typeof out?.total_lines === "number" ? out.total_lines : null;
      const shown = typeof out?.lines_shown === "number" ? out.lines_shown : total;
      if (typeof shown === "number" && shown > 0) lines += shown;
    } else if (view.toolName === "list_dir") dirs++;
    else if (view.toolName === "bash") commands++;
    else if (view.toolName === "web_search" || view.toolName === "web_fetch") web++;
    else searches++;
  }
  const phrase = [
    files > 0 ? `read ${files} file${files === 1 ? "" : "s"}` : "",
    dirs > 0 ? `listed ${dirs} director${dirs === 1 ? "y" : "ies"}` : "",
    searches > 0 ? `${searches} search${searches === 1 ? "" : "es"}` : "",
    commands > 0 ? `ran ${commands} command${commands === 1 ? "" : "s"}` : "",
    web > 0 ? `${web} web source${web === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return { phrase, lines };
}

/**
 * The chamber's committed row: what the burst covered, in one reading. The
 * open-mark leads the row -- it is the affordance the click and ctrl+o answer
 * -- and the counts are the calls that actually returned, never an estimate.
 */
export function renderChamberHead(views: ToolActivityView[]): string {
  const { phrase, lines } = chamberPhrase(views);
  return F.flowRow(
    F.railRow(`${info(glyph("selection"))} ${muted(phrase)}`),
    lines > 0 ? faint(`${group(lines)} lines`) : "",
  );
}

/** The chamber, opened: the same head, then every call it holds, per row. */
export function renderChamberDetail(views: ToolActivityView[]): string {
  return [renderChamberHead(views), ...views.map((view) => renderToolActivity(view))].join("\n");
}

/** Back-compat name for the collapsed gathering row. */
export function renderRoutineBatch(views: ToolActivityView[]): string {
  return renderChamberHead(views);
}
