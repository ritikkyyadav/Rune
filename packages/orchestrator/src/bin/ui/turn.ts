// ─── TurnRenderer: the Gear customizer's visible activity stream ───
// The reference deliberately shows Plan → Read/Search → Command → Edit/Diff →
// Complete → Answer. Keep private reasoning private, but never hide the actual
// actions or evidence that explain what the agent did.

import { accent, bold, faint, muted, ok, stripAnsi, text, warn, brand, panel } from "./theme";
import { termWidth, truncate, visLen, wrap } from "./render";
import {
  renderToolActivity,
  renderTranscript,
  runningLabel,
  planBlock,
  stepBlock,
  isVerificationCommand,
  type ToolActivityView,
  type TranscriptLineView,
} from "./activity";
import { formatError, formatEvent, fmtTokens } from "./events";
import { renderMarkdown } from "./markdown";
import { renderUnifiedDiff } from "../diff-render";
import { GEAR_MARK } from "./banner";

export { isVerificationCommand };

/** Column budget for a turn (wide terminals should still read like prose). */
export function turnWidth(): number {
  return Math.min(110, Math.max(1, termWidth() - 2));
}

export interface TurnSink {
  /** Append a finished block to terminal scrollback. */
  commit(block: string): void;
  /** Replace the small live focus above the composer. */
  preview?(lines: string[] | null): void;
}

export interface TurnRendererOpts {
  model?: string;
  getCost?: () => number;
  /** Retained for API compatibility. Work is now quiet on every surface. */
  streamWork?: boolean;
}

export type WorkPhase = "understand" | "plan" | "act" | "verify";

interface TodoItem {
  content: string;
  status: string;
}

interface EditStat {
  added: number;
  removed: number;
  created?: boolean;
}

interface CheckEvidence {
  label: string;
  detail: string;
  status: "passed" | "failed" | "not-run";
  count: number;
  /** Tests the runner reported as passing, when its output carried a tally. */
  tests?: number;
}

interface CurrentTool {
  callId: string;
  name: string;
  argsJson: string;
  args: Record<string, unknown>;
}

const PHASE_DEFAULT: Record<WorkPhase, string> = {
  understand: "Reading the task and gathering context",
  plan: "Shaping a reliable approach",
  act: "Making the change",
  verify: "Checking the result against real evidence",
};

/** The stable signal glyph used for the current phase. */
export const HEX = "◆";

function oneLine(raw: string, max = 100): string {
  const clean = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

function lastNonEmpty(raw: string): string {
  return (
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (!path.startsWith("/") && parts.length <= 5) return path;
  if (parts.length <= 3) return path;
  return "…/" + parts.slice(-3).join("/");
}

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function phaseForTool(name: string, args: Record<string, unknown>): WorkPhase {
  if (
    name === "read_file" ||
    name === "list_dir" ||
    name === "grep" ||
    name === "glob" ||
    name === "symbol_search" ||
    name === "lsp" ||
    name === "web_search" ||
    name === "web_fetch" ||
    name === "task"
  ) {
    return "understand";
  }
  if (name === "todo_write" || name === "create_plan" || name === "update_plan") return "plan";
  if (name === "bash" && isVerificationCommand(String(args.command ?? ""))) return "verify";
  return "act";
}

function liveToolLabel(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  switch (name) {
    case "read_file":
      return path ? `Reading ${shortPath(path)}` : "Reading relevant code";
    case "list_dir":
      return path ? `Exploring ${shortPath(path)}` : "Mapping the workspace";
    case "grep": {
      const pattern = String(args.pattern ?? "");
      return pattern ? `Searching for “${truncate(pattern, 48)}”` : "Searching the codebase";
    }
    case "glob":
      return "Finding relevant files";
    case "symbol_search":
    case "lsp":
      return "Tracing code relationships";
    case "write_file":
      return path ? `Creating ${shortPath(path)}` : "Creating the implementation";
    case "edit_file":
    case "multi_edit":
      return path ? `Updating ${shortPath(path)}` : "Applying the change";
    case "bash": {
      const command = oneLine(String(args.command ?? ""), 68);
      if (!command) return "Running the necessary command";
      return isVerificationCommand(command) ? `Checking with ${command}` : `Running ${command}`;
    }
    case "web_search": {
      const query = oneLine(String(args.query ?? args.q ?? ""), 58);
      return query ? `Researching “${query}”` : "Researching current information";
    }
    case "web_fetch":
      return "Reading the primary source";
    case "worker":
      return "Integrating a parallel workstream";
    case "task":
      return "Scouting the relevant subsystem";
    case "todo_write":
      return "Keeping the execution plan current";
    default:
      return runningLabel(name);
  }
}

function partialArgs(raw: string): Record<string, unknown> {
  const parsed = tryJson(raw);
  if (parsed) return parsed;
  const result: Record<string, unknown> = {};
  for (const key of ["path", "pattern", "command", "query", "q"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\n]*)`).exec(raw);
    if (match?.[1]) result[key] = match[1].replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
  return result;
}

/** Turn metadata shown at the right edge of the task bar (`turn 3 · checkpoint v2`). */
export interface UserBlockMeta {
  turn?: number;
  checkpoint?: string;
}

/** The user's message is the strongest landmark in scrollback: the v2 task bar —
 * an open chevron, the task, and the turn/checkpoint receipt on the right. */
export function userBlock(raw: string, meta: UserBlockMeta = {}): string {
  const width = Math.max(12, turnWidth() - 2);
  const receipt = [
    meta.turn && meta.turn > 0 ? `turn ${meta.turn}` : "",
    meta.checkpoint ? `checkpoint ${meta.checkpoint}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Reserve the receipt's cells only when the bar is wide enough to carry both.
  const showReceipt = receipt.length > 0 && width >= receipt.length + 28;
  const textWidth = Math.max(4, width - 5 - (showReceipt ? receipt.length + 2 : 0));
  const lines = [""];
  let first = true;
  for (const source of raw.split("\n")) {
    for (const line of wrap(source, textWidth)) {
      const marker = first ? faint("⌄") : " ";
      const content = `${marker} ${text(line)}`;
      const tail = first && showReceipt ? faint(receipt) : "";
      const fill = " ".repeat(Math.max(0, width - visLen(content) - visLen(tail) - 2));
      lines.push(`  ${panel(` ${content}${fill}${tail} `)}`);
      first = false;
    }
  }
  return lines.join("\n");
}

export function responseHead(): string {
  return "";
}

const BLOCK_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||(?:-{3,}|\*{3,}|_{3,})$)/;
const HEADLINE_MAX = 200;

/**
 * Split an opening paragraph into the v2 response headline (its first
 * sentence) and the detail that follows. Sentence ends are found outside
 * inline code and after common abbreviations are skipped; a paragraph with no
 * boundary is a headline only when it is short enough to read as one.
 */
export function splitHeadline(paragraph: string): { headline: string; rest: string } | null {
  let inCode = false;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i]!;
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (ch !== "." && ch !== "!" && ch !== "?")) continue;
    // A decimal point or dotted version (v0.2.0) is not a sentence end.
    if (ch === "." && /\d/.test(paragraph[i + 1] ?? "")) continue;
    if (/\b(e\.g|i\.e|etc|vs|cf|approx|fig|no)$/i.test(paragraph.slice(0, i))) continue;
    let j = i + 1;
    while (j < paragraph.length && /[)"'*_\]]/.test(paragraph[j]!)) j++;
    const next = paragraph.slice(j);
    if (next.length > 0 && !/^\s+["'(`\[*_A-Z0-9]/.test(next)) continue;
    const headline = paragraph.slice(0, j).trim();
    if (headline.length > HEADLINE_MAX) return null;
    return { headline, rest: next.trim() };
  }
  return paragraph.length <= HEADLINE_MAX ? { headline: paragraph, rest: "" } : null;
}

/**
 * The final answer in the customizer's response voice: a bold headline (the
 * opening sentence) set in the primary tone, then the detail in the secondary
 * tone. Authored Markdown structure (headings, lists, code) is preserved; only
 * a plain opening paragraph is promoted.
 */
export function responseBlock(markdown: string): string {
  const width = turnWidth();
  const source = markdown.replace(/\r\n/g, "\n").split("\n");
  const first = source.findIndex((line) => line.trim());
  if (
    first >= 0 &&
    !BLOCK_OPENER.test(source[first]!.trim()) &&
    !/^(\*\*|__)/.test(source[first]!.trim())
  ) {
    let end = first;
    while (
      end + 1 < source.length &&
      source[end + 1]!.trim() &&
      !BLOCK_OPENER.test(source[end + 1]!.trim())
    ) {
      end++;
    }
    const paragraph = source
      .slice(first, end + 1)
      .map((line) => line.trim())
      .join(" ");
    const split = splitHeadline(paragraph);
    if (split) {
      const head = renderMarkdown(split.headline, { width, indent: "  ", tone: "headline" });
      const restSource = [...(split.rest ? [split.rest] : []), ...source.slice(end + 1)];
      const detail = restSource.join("\n").trim()
        ? renderMarkdown(restSource.join("\n"), { width, indent: "  ", tone: "secondary" })
        : [];
      return ["", ...head, ...(detail.length ? ["", ...detail] : [])].join("\n");
    }
  }
  const body = renderMarkdown(source.join("\n"), { width, indent: "  " });
  return ["", ...body].join("\n");
}

function duration(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function plural(count: number, singular: string, many = singular + "s"): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function joinedList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** Routine exploration is summarized as a paced ledger, exactly like the
 * reference's “Read 3 files, listed 1 directory, ran 2 shell commands” rows. */
function routineSummary(views: ToolActivityView[]): string {
  const count = (names: string[]) => views.filter((view) => names.includes(view.toolName)).length;
  const reads = count(["read_file"]);
  const directories = count(["list_dir"]);
  const searches = count(["grep", "glob", "symbol_search", "lsp"]);
  const commands = count(["bash"]);
  return joinedList([
    ...(reads ? [`Read ${plural(reads, "file")}`] : []),
    ...(directories ? [`listed ${plural(directories, "directory", "directories")}`] : []),
    ...(searches ? [`ran ${plural(searches, "search", "searches")}`] : []),
    ...(commands ? [`ran ${plural(commands, "shell command")}`] : []),
  ]);
}

function isRoutine(view: ToolActivityView): boolean {
  if (!view.success) return false;
  if (view.toolName === "bash") {
    return !isVerificationCommand(String(view.args.command ?? ""));
  }
  return ["read_file", "list_dir", "grep", "glob", "symbol_search", "lsp"].includes(view.toolName);
}

function parseCheck(command: string, result: string, toolSuccess: boolean): CheckEvidence | null {
  if (!isVerificationCommand(command)) return null;
  const parsed = tryJson(result);
  const timedOut = parsed?.timed_out === true;
  const exitCode = typeof parsed?.exit_code === "number" ? parsed.exit_code : null;
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
  const passed = toolSuccess && !timedOut && (exitCode == null || exitCode === 0);
  const detail = timedOut
    ? "timed out"
    : exitCode != null && exitCode !== 0
      ? `exit ${exitCode}`
      : oneLine(lastNonEmpty(stdout || stderr), 56) || (passed ? "passed" : "failed");
  // A runner's own tally (`214 pass`, `214 passed`, `Ran 214 tests`) feeds
  // the summary badge; absent a tally the badge stays generic, never invented.
  const tally =
    /^\s*(\d+)\s+pass(?:ed|ing)?\b/m.exec(stdout)?.[1] ??
    /\bRan\s+(\d+)\s+tests?\b/.exec(stdout)?.[1] ??
    /\b(\d+)\s+tests?\s+passed\b/i.exec(stdout)?.[1] ??
    /test result: ok\.\s+(\d+)\s+passed/.exec(stdout)?.[1];
  return {
    label: oneLine(command, 62),
    detail,
    status: passed ? "passed" : "failed",
    count: 1,
    tests: tally != null && passed ? Number(tally) : undefined,
  };
}

/** The v2 summary-strip badge for a passed check: `214 tests pass`,
 * `typecheck clean`, `lint clean`, `build ok` — or the command itself. */
function checkBadge(check: CheckEvidence): string {
  const cmd = check.label.toLowerCase();
  const detail = check.detail ?? "";
  const count =
    check.tests ??
    /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i.exec(detail)?.[1] ??
    /\b(\d+)\s+passed\b/i.exec(detail)?.[1];
  if (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)|\b(cargo|go|swift)\s+test\b/.test(
      cmd,
    )
  )
    return count ? `${count} tests pass` : "tests pass";
  if (/\b(typecheck|tsc)\b/.test(cmd)) return "typecheck clean";
  if (/\b(lint|eslint|ruff|clippy|mypy)\b/.test(cmd)) return "lint clean";
  if (/\bbuild\b/.test(cmd)) return "build ok";
  return truncate(check.label || check.detail || "project checks", 32);
}

function editCounts(result: string): { added: number; removed: number } {
  const parsed = tryJson(result);
  if (!parsed?.diff) return { added: 0, removed: 0 };
  const rendered = renderUnifiedDiff(String(parsed.diff), "");
  return { added: rendered.added, removed: rendered.removed };
}

export class TurnRenderer {
  private prose = "";
  private workLog: Array<{ line: string; detail: boolean }> = [];
  private todos: TodoItem[] = [];
  private editedFiles = new Map<string, EditStat>();
  private checks: CheckEvidence[] = [];
  private currentTool: CurrentTool | null = null;
  private phase: WorkPhase = "understand";
  private intent = PHASE_DEFAULT.understand;
  private toolCalls = 0;
  private reads = 0;
  private searches = 0;
  private webSources = 0;
  private reroutes = 0;
  private failures = 0;
  private errored = false;
  private hardError = false;
  private committedErrors = new Set<string>();
  private routineQueue: ToolActivityView[] = [];
  private narratedPlan = false;
  private verificationRunning = false;
  private readonly startedAt = Date.now();
  // v2 turn metadata: provider-reported download tokens, accumulated thinking
  // wall-clock, live context %, the agent-loop turn number, and the latest
  // durable checkpoint — all fed by structured events, never invented.
  private downTokens = 0;
  private thinkingMs = 0;
  private lastThinkingAt = 0;
  private contextPercent: number | null = null;
  private turnCount = 0;
  private checkpoint: { runId: string; version: number } | null = null;

  /** Back-compat for callers that used the old separate activity line. */
  activity: string | null = null;

  constructor(
    private sink: TurnSink,
    private opts: TurnRendererOpts = {},
  ) {
    this.updateLive();
  }

  /** Complete, inspectable mechanics. Never printed unless the user asks. */
  fullLog(): string | null {
    if (this.workLog.length === 0) return null;
    return [
      `  ${bold(text("Work details"))} ${faint(`· ${plural(this.toolCalls, "action")}`)}`,
      ...this.workLog.map((entry) => entry.line),
    ].join("\n");
  }

  get worked(): boolean {
    return this.toolCalls > 0 || this.workLog.length > 0 || this.todos.length > 0;
  }

  /** The v2 status ladder rung: `⚙︎ Thinking… / Running tools… / Synthesizing…`
   * with the honest receipt (elapsed · ↓ tokens · thought for). One animated
   * row above the composer, plus a faint detail row naming what is in flight. */
  liveLines(): string[] {
    const label = this.currentTool
      ? "Running tools"
      : this.verificationRunning
        ? "Verifying"
        : this.prose.trim()
          ? "Synthesizing"
          : "Thinking";
    const pulse = Math.floor((Date.now() - this.startedAt) / 250) % 2 === 0;
    const mark = pulse ? bold(brand(GEAR_MARK)) : brand(GEAR_MARK);
    const lines = [
      `  ${mark} ${bold(brand(label))}${faint("…")} ${faint(`(${this.receipt().join(" · ")})`)}`,
    ];
    const detail = this.liveDetail();
    if (detail) lines.push(`    ${faint(truncate(detail, Math.max(24, turnWidth() - 6)))}`);
    return lines;
  }

  /** What the rung is waiting on: the in-flight tool, else the active plan step,
   * else the phase intent the renderer inferred from the stream. */
  private liveDetail(): string {
    if (this.currentTool) return liveToolLabel(this.currentTool.name, this.currentTool.args);
    const active = this.todos.find((item) => item.status === "in_progress");
    if (active) {
      const done = this.todos.filter((item) => item.status === "completed").length;
      return `${active.content} · ${done}/${this.todos.length} steps`;
    }
    // While the answer streams the intent is stale context — stay quiet.
    if (this.prose.trim()) return "";
    if (this.intent && this.intent !== PHASE_DEFAULT.understand) return this.intent;
    return "";
  }

  /** Elapsed · provider-reported ↓ tokens · reasoning wall-clock — never invented. */
  private receipt(): string[] {
    const parts = [duration(this.startedAt)];
    if (this.downTokens > 0) parts.push(`↓ ${fmtTokens(this.downTokens)} tokens`);
    if (this.thinkingMs >= 100) parts.push(`thought for ${(this.thinkingMs / 1000).toFixed(1)}s`);
    return parts;
  }

  private updateLive(): void {
    this.sink.preview?.(this.liveLines());
  }

  private setPhase(phase: WorkPhase, intent?: string): void {
    this.phase = phase;
    if (intent) this.intent = oneLine(intent, 100);
    else if (!this.intent) this.intent = PHASE_DEFAULT[phase];
    this.updateLive();
  }

  private addLog(block: string, detailAfterFirst = false): void {
    block.split("\n").forEach((line, index) => {
      if (stripAnsi(line).trim())
        this.workLog.push({ line, detail: detailAfterFirst && index > 0 });
    });
  }

  /** One vertical rhythm unit between timeline groups, mirroring the 14px
   * stream gap in the supplied card without wasting multiple terminal rows. */
  private commitTimeline(block: string): void {
    if (!stripAnsi(block).trim()) return;
    this.sink.commit(`\n${block}`);
  }

  /** Flush a burst of low-level exploration into one truthful summary row. If
   * the burst ended in a search or shell command, preserve that most useful
   * evidence card directly beneath the summary, as in the reference. */
  private flushRoutine(): void {
    if (this.routineQueue.length === 0) return;
    const views = this.routineQueue.splice(0);
    if (views.length === 1) {
      this.commitTimeline(renderToolActivity(views[0]!));
      return;
    }

    const blocks = [`  ${muted(routineSummary(views))}`];
    const representative = [...views]
      .reverse()
      .find((view) => view.toolName === "grep" || view.toolName === "bash");
    if (representative) blocks.push("", renderToolActivity(representative));
    this.commitTimeline(blocks.join("\n"));
  }

  private captureProseAsIntent(): void {
    const raw = this.prose.trim();
    this.prose = "";
    if (!raw) return;
    this.flushRoutine();
    const summary = oneLine(raw, 100);
    if (summary) {
      this.intent = summary;
      const block = (this.narratedPlan ? stepBlock(raw) : planBlock(raw)).join("\n");
      this.narratedPlan = true;
      this.addLog(block);
      this.commitTimeline(block);
    }
  }

  private recordEdit(event: any): void {
    if (!event.output?.success) return;
    const name = event.output.toolName;
    if (name !== "edit_file" && name !== "write_file" && name !== "multi_edit") return;
    const path = String(event.args?.path ?? tryJson(String(event.output.result))?.path ?? "");
    if (!path) return;
    const previous = this.editedFiles.get(path) ?? { added: 0, removed: 0 };
    if (name === "write_file") {
      this.editedFiles.set(path, { ...previous, created: previous.created ?? true });
      return;
    }
    const counts = editCounts(String(event.output.result ?? ""));
    this.editedFiles.set(path, {
      added: previous.added + counts.added,
      removed: previous.removed + counts.removed,
      created: previous.created,
    });
  }

  private recordTool(event: any): void {
    const name = String(event.output?.toolName ?? "");
    const args = (event.args ?? {}) as Record<string, unknown>;
    const result = String(event.output?.result ?? "");
    const success = event.output?.success === true;
    this.toolCalls++;
    if (name === "read_file" || name === "list_dir") this.reads++;
    if (name === "grep" || name === "glob" || name === "symbol_search" || name === "lsp") {
      this.searches++;
    }
    if (name === "web_search" || name === "web_fetch") this.webSources++;
    if (!success) {
      this.failures++;
      this.errored = true;
    }
    this.recordEdit(event);
    if (name === "bash") {
      const check = parseCheck(String(args.command ?? ""), result, success);
      if (check) {
        this.checks.push(check);
        if (check.status === "failed" && success) {
          this.failures++;
          this.errored = true;
        }
      }
    }
    const view: ToolActivityView = {
      toolName: name,
      args,
      result,
      success,
      error: event.output?.error,
      durationMs: event.output?.durationMs,
    };
    const rendered = renderToolActivity(view);
    this.addLog(rendered, name === "edit_file" || name === "multi_edit");
    if (!success) {
      this.flushRoutine();
      this.commitErrorOnce(rendered);
    } else if (isRoutine(view)) {
      this.routineQueue.push(view);
    } else {
      this.flushRoutine();
      this.commitTimeline(rendered);
    }

    // The default stays one line, but review mode must preserve enough command
    // evidence to diagnose a failure or verify a claim.
    if (name === "bash") {
      const parsed = tryJson(result);
      const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
      const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
      const raw = (stdout + (stdout && stderr ? "\n" : "") + stderr).trim();
      if (raw) {
        const all = raw.split("\n");
        const shown =
          all.length <= 60
            ? all
            : [...all.slice(0, 42), `… ${all.length - 54} lines omitted …`, ...all.slice(-12)];
        this.addLog(
          [
            `    ${faint("command output")}`,
            ...shown.map((line) => `      ${muted(truncate(line, 100))}`),
          ].join("\n"),
          true,
        );
      }
    }
  }

  private commitErrorOnce(block: string): void {
    const key = oneLine(stripAnsi(block), 180);
    if (!key || this.committedErrors.has(key)) return;
    this.committedErrors.add(key);
    this.commitTimeline(block);
  }

  onEvent(event: any): void {
    switch (event.type) {
      case "thinking_delta": {
        // Reasoning remains private. The UI communicates intent and evidence
        // instead — but the time SPENT reasoning is honest turn metadata
        // ("thought for 2.3s"), so accumulate wall-clock across delta bursts.
        const now = Date.now();
        if (this.lastThinkingAt > 0 && now - this.lastThinkingAt < 3000) {
          this.thinkingMs += now - this.lastThinkingAt;
        }
        this.lastThinkingAt = now;
        return;
      }

      case "text_delta":
        this.activity = null;
        this.prose += event.text;
        this.updateLive();
        return;

      case "stream_reset":
        this.prose = "";
        this.currentTool = null;
        this.activity = null;
        this.updateLive();
        return;

      case "tool_call_start": {
        this.captureProseAsIntent();
        this.currentTool = {
          callId: String(event.callId ?? ""),
          name: String(event.toolName ?? "tool"),
          argsJson: "",
          args: {},
        };
        this.activity = runningLabel(this.currentTool.name);
        this.setPhase(phaseForTool(this.currentTool.name, {}));
        return;
      }

      case "tool_call_args_delta":
        if (this.currentTool && (!event.callId || event.callId === this.currentTool.callId)) {
          this.currentTool.argsJson += String(event.partialJson ?? "");
          this.currentTool.args = partialArgs(this.currentTool.argsJson);
          this.activity = liveToolLabel(this.currentTool.name, this.currentTool.args);
          this.setPhase(phaseForTool(this.currentTool.name, this.currentTool.args));
        }
        return;

      case "tool_call_end": {
        this.captureProseAsIntent();
        const phase = phaseForTool(String(event.output?.toolName ?? ""), event.args ?? {});
        this.setPhase(phase);
        this.recordTool(event);
        const failedCheck = this.checks.at(-1)?.status === "failed" && phase === "verify";
        this.currentTool = null;
        this.activity = null;
        if (failedCheck) this.setPhase("act", "Addressing the failed check");
        else this.updateLive();
        return;
      }

      case "todo_updated": {
        this.flushRoutine();
        this.narratedPlan = true;
        this.todos = Array.isArray(event.items) ? event.items : [];
        const active = this.todos.find((item) => item.status === "in_progress");
        const plan = [
          `  ${text("●")} ${bold(text("Plan:"))} ${muted(active?.content ?? `${this.todos.length} steps`)}`,
          ...this.todos.map((item) => {
            const mark =
              item.status === "completed"
                ? ok("✓")
                : item.status === "in_progress"
                  ? brand("›")
                  : faint("○");
            return `    ${mark} ${item.status === "in_progress" ? text(item.content) : muted(item.content)}`;
          }),
        ].join("\n");
        this.addLog(plan);
        this.commitTimeline(plan);
        if (this.editedFiles.size === 0)
          this.setPhase("plan", active?.content ?? "Planning the work");
        else if (active) this.intent = active.content;
        this.updateLive();
        return;
      }

      case "plan_created":
      case "plan_updated": {
        this.flushRoutine();
        this.narratedPlan = true;
        const steps = Array.isArray(event.plan?.steps) ? event.plan.steps : [];
        const block = formatEvent(event, { cost: this.opts.getCost?.() }) ?? "";
        this.addLog(block);
        if (block) this.commitTimeline(block);
        this.setPhase("plan", steps[0]?.description ?? "Planning the work");
        return;
      }

      case "step_started": {
        this.flushRoutine();
        const block = formatEvent(event, { cost: this.opts.getCost?.() }) ?? "";
        this.addLog(block);
        if (block) this.commitTimeline(block);
        this.setPhase("act", event.description ?? "Executing the plan");
        return;
      }

      case "step_completed":
      case "plan_completed":
      case "replanning": {
        this.flushRoutine();
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.addLog(block);
          this.commitTimeline(block);
        }
        if (event.type === "replanning")
          this.setPhase("plan", "Adjusting the approach from evidence");
        else this.updateLive();
        return;
      }

      case "verification_started":
        this.captureProseAsIntent();
        this.flushRoutine();
        this.currentTool = null;
        this.activity = null;
        this.verificationRunning = true;
        this.setPhase("verify", "Running the project checks");
        return;

      case "verification_completed": {
        this.flushRoutine();
        this.verificationRunning = false;
        const report = String(event.report ?? "");
        const commandCount = Math.max(1, (report.match(/^\$ /gm) ?? []).length);
        const command = oneLine(
          report
            .split("\n")
            .find((line) => line.startsWith("$ "))
            ?.replace(/^\$ /, "")
            .replace(/\s+\(ok\)$/, "") ?? "project checks",
          62,
        );
        this.checks.push({
          label: command || "project checks",
          detail: event.ran
            ? event.passed
              ? "passed"
              : oneLine(lastNonEmpty(report), 56)
            : "not run",
          status: !event.ran ? "not-run" : event.passed ? "passed" : "failed",
          count: event.ran ? commandCount : 0,
        });
        const verification = `  ${event.passed && event.ran ? ok("✓") : event.ran ? accent("✕") : faint("○")} ${muted(
          event.ran ? oneLine(report, 100) : "No project checks were detected",
        )}`;
        this.addLog(verification);
        this.commitTimeline(verification);
        if (event.ran && !event.passed) {
          this.failures++;
          this.setPhase("act", "Fixing what the checks found");
        } else {
          this.setPhase(
            "verify",
            event.ran ? "Project checks passed" : "No automatic checks detected",
          );
        }
        return;
      }

      case "usage": {
        // Authoritative provider counts: drive the "↓ tokens" meta and the
        // live context percentage without a transcript line.
        this.downTokens += Number(event.outputTokens ?? 0);
        if (event.context && Number(event.context.percent) > 0) {
          this.contextPercent = Number(event.context.percent);
        }
        this.updateLive();
        return;
      }

      case "checkpoint_saved": {
        // Feeds the task metadata + end-of-turn summary strip; never printed
        // inline (a checkpoint per write would be noise).
        this.checkpoint = {
          runId: String(event.runId ?? ""),
          version: Number(event.version ?? 0),
        };
        this.turnCount = Math.max(this.turnCount, Number(event.turnCount ?? 0));
        this.updateLive();
        return;
      }

      case "fallback": {
        this.reroutes++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "compaction": {
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "notice":
      case "context_warning": {
        const message = String(event.message ?? "");
        if (/verifying changes/i.test(message)) {
          this.verificationRunning = true;
          this.setPhase("verify", "Running the project checks");
          return;
        }
        if (/verification failed|no execution evidence/i.test(message)) {
          this.captureProseAsIntent();
          this.setPhase("act", "Strengthening the result with real evidence");
        }
        if (/replanning/i.test(message)) this.setPhase("plan", "Adjusting the approach");
        if (/unavailable.*Switching to/s.test(message)) this.reroutes++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "error": {
        this.captureProseAsIntent();
        this.flushRoutine();
        this.currentTool = null;
        this.activity = null;
        this.errored = true;
        this.hardError = true;
        this.failures++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.addLog(block);
          this.commitErrorOnce(block);
        }
        this.updateLive();
        return;
      }

      case "turn_complete":
        this.turnCount = Math.max(this.turnCount, Number(event.totalTurns ?? 0));
        return;

      default: {
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
      }
    }
  }

  onError(error: unknown): void {
    this.errored = true;
    this.hardError = true;
    this.failures++;
    this.captureProseAsIntent();
    this.flushRoutine();
    const block = formatError(error instanceof Error ? error.message : String(error));
    this.addLog(block);
    this.commitErrorOnce(block);
  }

  private completionBlock(aborted: boolean): string {
    const latestCheck = [...this.checks].reverse().find((check) => check.status !== "not-run");
    const repaired = this.failures > 0 && latestCheck?.status === "passed";
    const failed = this.hardError && !repaired;
    const warned = !failed && this.failures > 0 && !repaired;
    const label = aborted
      ? "Interrupted."
      : failed
        ? "Needs attention"
        : warned
          ? "Done with notes"
          : "Complete.";
    const mark = aborted || failed ? accent(aborted ? "■" : "✕") : warned ? warn("!") : ok("✓");
    const paintLabel = aborted || failed ? accent : warned ? warn : ok;
    // v2 completion meta: (11s · ↓ 6.1k tokens · thought for 2.3s) — every
    // number provider-reported or wall-clock, never invented.
    const metaParts = aborted ? [...this.receipt(), "esc · partial work kept"] : this.receipt();
    return `  ${mark} ${bold(paintLabel(label))} ${faint(`(${metaParts.join(" · ")})`)}`;
  }

  /** Outcome evidence belongs after the answer, like the reference's two
   * summary strips — not mixed into the green Complete status row. */
  private summaryBlock(): string | null {
    const lines: string[] = [];
    const passedChecks = this.checks.filter((check) => check.status === "passed");
    const failedChecks = this.checks.filter((check) => check.status === "failed");
    const passed = passedChecks.reduce((sum, check) => sum + check.count, 0);

    if (passedChecks.length > 0) {
      const checkBadges = passedChecks
        .slice(-3)
        .map((check) => `${ok("✓")} ${muted(checkBadge(check))}`);
      lines.push(`  ${checkBadges.join("   ")}`);
    } else if (failedChecks.length > 0) {
      const latest = failedChecks.at(-1)!;
      lines.push(
        `  ${accent("✕")} ${muted(truncate(latest.label, 44))}${latest.detail ? ` ${faint("· " + latest.detail)}` : ""}`,
      );
    }

    const metrics: string[] = [];
    const edits = [...this.editedFiles.values()];
    const added = edits.reduce((sum, edit) => sum + edit.added, 0);
    const removed = edits.reduce((sum, edit) => sum + edit.removed, 0);
    if (this.editedFiles.size > 0) {
      metrics.push(muted(plural(this.editedFiles.size, "file") + " changed"));
      if (added > 0 || removed > 0) metrics.push(`${ok(`+${added}`)} ${accent(`−${removed}`)}`);
    } else {
      if (this.reads > 0) metrics.push(muted(plural(this.reads, "file") + " reviewed"));
      if (this.searches > 0) metrics.push(muted(plural(this.searches, "search", "searches")));
      if (this.webSources > 0) metrics.push(muted(plural(this.webSources, "source")));
    }
    // The badges above carry the checks; only a long run needs the count too.
    if (passedChecks.length > 3) metrics.push(muted(plural(passed, "check") + " passed"));
    if (failedChecks.length > 0 && passed > 0) {
      metrics.push(muted(plural(failedChecks.length, "failure") + " repaired"));
    }
    if (this.editedFiles.size > 0 && passed === 0) metrics.push(warn("verification not observed"));
    if (this.reroutes > 0)
      metrics.push(muted(plural(this.reroutes, "model switch", "model switches")));
    // v2 summary strip: the durable checkpoint this turn produced, plus the
    // escape hatch. Only rendered when a checkpoint really was written; the
    // turn number itself lives in the task bar.
    if (this.checkpoint) {
      metrics.push(
        `${muted(`checkpoint v${this.checkpoint.version} saved`)} ${faint("· /rewind to undo")}`,
      );
    }
    if (metrics.length > 0) lines.push(`  ${metrics.join(` ${faint("·")} `)}`);
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /** Live context occupancy (0–100) from the last provider report, if any. */
  get liveContextPercent(): number | null {
    return this.contextPercent;
  }

  finish(options: { aborted?: boolean } = {}): void {
    this.currentTool = null;
    this.activity = null;
    this.sink.preview?.(null);

    const answer = this.prose.trim();
    const aborted = options.aborted === true;
    this.flushRoutine();
    if (this.worked || this.errored || aborted || this.verificationRunning) {
      this.commitTimeline(this.completionBlock(aborted));
    }
    if (answer) this.sink.commit(responseBlock(answer) + "\n");
    else if (aborted)
      this.sink.commit(`\n ${accent("■")} ${muted("stopped before a result was ready")}\n`);
    const summary = this.summaryBlock();
    if (summary) this.sink.commit(`\n${summary}\n`);
    this.prose = "";
  }
}

function replaySummary(lines: TranscriptLineView[]): string | null {
  let reads = 0;
  let searches = 0;
  let sources = 0;
  let failures = 0;
  const edits = new Set<string>();
  let checks = 0;
  for (const line of lines) {
    if (line.role !== "tool") continue;
    const name = line.toolName ?? line.text;
    if (name === "read_file" || name === "list_dir") reads++;
    if (name === "grep" || name === "glob" || name === "symbol_search" || name === "lsp")
      searches++;
    if (name === "web_search" || name === "web_fetch") sources++;
    if (name === "edit_file" || name === "write_file" || name === "multi_edit") {
      const path = String(line.args?.path ?? tryJson(line.result ?? "")?.path ?? "");
      if (path) edits.add(path);
    }
    if (
      name === "bash" &&
      isVerificationCommand(String(line.args?.command ?? "")) &&
      !line.isError
    ) {
      checks++;
    }
    if (line.isError) failures++;
  }
  if (reads + searches + sources + edits.size + checks + failures === 0) return null;
  const metrics: string[] = [];
  if (edits.size > 0) metrics.push(plural(edits.size, "file") + " changed");
  if (checks > 0) metrics.push(plural(checks, "check") + " passed");
  if (edits.size === 0 && reads > 0) metrics.push(plural(reads, "file") + " reviewed");
  if (searches > 0) metrics.push(plural(searches, "search", "searches"));
  if (sources > 0) metrics.push(plural(sources, "source"));
  if (failures > 0) metrics.push(plural(failures, "failure"));
  const mark = failures > 0 ? warn("!") : ok("✓");
  return `  ${mark} ${bold(text("Done"))}${metrics.length ? ` ${faint("· " + metrics.join(" · "))}` : ""}`;
}

/** Replayed sessions preserve the same inspectable chronology as a live turn. */
export function renderReplay(lines: TranscriptLineView[]): string {
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.role === "user") {
      output.push(userBlock(line.text));
      index++;
      const turn: TranscriptLineView[] = [];
      while (index < lines.length && lines[index]!.role !== "user") turn.push(lines[index++]!);
      if (turn.length) output.push(renderTranscript(turn));
      const summary = replaySummary(turn);
      if (summary) output.push("", summary);
      continue;
    }
    if (line.role === "note") output.push(`  ${faint(`— ${line.text} —`)}`);
    index++;
  }
  return output.join("\n");
}
