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

import { faint } from "./theme";
import { glyph } from "./glyphs";
import { truncate } from "./render";
import { renderMarkdown } from "./markdown";
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

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Non-empty result lines -- a cheap proxy for grep match / output counts. */
function nonEmptyLines(result: string): string[] {
  return result
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Compact `{k:v}`-ish summary of an unknown/MCP tool's args. */
function compactArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    if (!json || json === "{}") return "";
    return truncate(json, 60);
  } catch {
    return "";
  }
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
  web_search: "web",
  web_fetch: "get",
  task: "scout",
  worker: "work",
  todo_write: "plan",
  bash_output: "poll",
  kill_shell: "stop",
  interactive_dashboard: "view",
};

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
};

/** A short label for an in-flight tool call (args aren't known yet at start). */
export function runningLabel(toolName: string): string {
  return RUNNING[toolName] ?? toolName;
}

/** Commands whose result is evidence, rather than merely another action. */
export function isVerificationCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)/.test(cmd) ||
    /(^|[\s;&|])(lint|eslint|ruff|mypy|typecheck|tsc|check|build)([\s;&|]|$)/.test(cmd) ||
    /\b(cargo\s+(test|check|clippy)|go\s+test|swift\s+test|xcodebuild|gradle\w*\s+test|mvn\w*\s+test)\b/.test(
      cmd,
    )
  );
}

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
  if (!body) return null;
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
  return [
    F.toolRow({
      name,
      arg: compactTarget(v),
      status: "fail",
      metric: elapsed(v.durationMs),
    }),
    F.toolNote(reason, "fail"),
  ].join("\n");
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
      return F.toolRow({
        name,
        arg: listingPath(path),
        argTone: "path",
        status: "none",
        metric: F.editMetric(added, 0, "new file"),
      });
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
        ...F.diffRows(diff.rows),
      ].join("\n");
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
      if (summary) rows.push(F.toolNote(summary, failed ? "fail" : checked ? "ok" : "muted"));
      // The output itself is kept only when it is the evidence: a failure to
      // diagnose, or a check whose result is the whole point of running it. Its
      // own last line closes the rail, rather than being printed twice.
      if (body && (failed || checked)) {
        const all = body.split("\n");
        while (all.length > 0 && !all.at(-1)!.trim()) all.pop();
        const closing = all.length > 1 ? all.pop()!.trim() : "";
        rows.push(...F.outputRail(command, F.clip(all), closing || undefined, failed));
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
      const changed = /worker changed (\d+) files?/.exec(v.result ?? "")?.[1];
      const steps = /\(sub-agent made (\d+) tool calls?/.exec(v.result ?? "")?.[1];
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
      const takeaway = delegationTakeaway(v.result ?? "");
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

    default:
      // MCP / unknown tool -- its own name, and whatever its arguments say.
      return F.toolRow({ name, arg: compactArgs(v.args), metric: elapsed(v.durationMs) });
  }
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
    default:
      return compactArgs(v.args);
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
      // Collapse a run of successful reads into one count line.
      let j = i;
      while (
        j < lines.length &&
        lines[j]!.role === "tool" &&
        lines[j]!.toolName === "read_file" &&
        !lines[j]!.isError
      ) {
        j++;
      }
      const run = j - i;
      if (run >= 2) {
        out.push(F.toolRow({ name: "read", arg: `${run} files` }));
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

// --- The routine batch ---
// Context-gathering is the bulk of every turn and almost none of its news. A
// run of thirty reads is one fact ("it read the module"), and printing it as
// thirty rows spends the reader's whole screen establishing that fact while the
// sentence that matters scrolls past. These two exports are what let the live
// stream do what the replay renderer already did: show each call while it runs,
// and set down one line when the run is over.

/** Tools whose individual rows are context, not news. */
const ROUTINE = new Set(["read_file", "list_dir", "grep", "glob", "symbol_search", "lsp"]);

export function isRoutineTool(name: string): boolean {
  return ROUTINE.has(name);
}

/** `1,204` — thousands grouped without a locale, so the row reads the same on
 *  every machine and in every test. */
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The collapsed receipt for a run of context-gathering calls: what was covered
 * and how much of it, in one row. Nothing here is estimated — the counts are the
 * calls that actually returned, and the line total is what the reads reported
 * reading. The per-call detail is not lost; it stays in the work log.
 */
export function renderRoutineBatch(views: ToolActivityView[]): string {
  let files = 0;
  let dirs = 0;
  let searches = 0;
  let lines = 0;
  for (const view of views) {
    const out = tryJson(view.result);
    if (view.toolName === "read_file") {
      files++;
      const total = typeof out?.total_lines === "number" ? out.total_lines : null;
      const shown = typeof out?.lines_shown === "number" ? out.lines_shown : total;
      if (typeof shown === "number" && shown > 0) lines += shown;
    } else if (view.toolName === "list_dir") {
      dirs++;
    } else {
      searches++;
    }
  }
  const parts = [
    files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "",
    dirs > 0 ? `${dirs} director${dirs === 1 ? "y" : "ies"}` : "",
    searches > 0 ? `${searches} search${searches === 1 ? "" : "es"}` : "",
  ].filter(Boolean);
  return F.toolRow({
    name: files >= searches ? "read" : "grep",
    arg: parts.join(", "),
    metric: lines > 0 ? `${group(lines)} lines` : "",
  });
}
