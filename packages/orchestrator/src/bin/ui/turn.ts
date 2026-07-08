// ─── TurnRenderer: the quiet work log ───
// A turn renders in the Codex idiom: the conversation stays out in the open —
// the user's message, the model's narration, and the final answer — while the
// heavy chain of work (thinking, file reads, greps, diffs, reroutes) lives
// BENEATH, in a work log that is hidden by default and comes out on demand:
//
//    ▌ build me the ipod app
//
//    Running linters and typecheck to ensure       ← narration: plain, bright
//    the code adheres to style.
//
//    ⋯ 34 earlier steps · ctrl+r to expand         ← the work, collapsed
//    Ran  bun test  · 42 pass
//    Searched  "ClickWheel"  · 3 matches
//
//    ╭──────────────────────────────────────╮
//    │ src/apps/ipod/iPodAppComponent.tsx  +12 -3 │   ← one chip per edited file
//    ╰──────────────────────────────────────╯
//
//    ⬢ Worked on 4 to-dos                          ← the plan, final state
//      ☒ Made new things
//      ☒ Read files
//
//    ⬢ done · 48s · 4 tools · $0.0042              ← the record, one line
//
//    Berne▮
//    <the answer, set as markdown typography>
//
// While the turn runs, the TUI pins a LIVE window above the composer (via the
// sink's live() callback): the last few work lines, the to-do checklist, and a
// preview of the still-streaming prose — so you always see what the agent is
// doing without it flooding the transcript.
//
// The streaming trick is unchanged from the rail era: prose runs are BUFFERED
// because only the stream's end reveals which run is the final answer. A WORK
// event (tool call, plan step) proves a buffered run was narration → committed
// as plain text; whatever survives to finish() is the answer. Out-of-band
// STATUS notices ("Verifying changes…") don't demote — a passing verification
// must not swallow the answer.
//
// Shared by the TUI and the classic readline CLI. The classic surface has no
// pinned window, so it streams work lines as they happen (streamWork: true).

import { bold, text, muted, faint, info, accent, ok, stripAnsi, line as lineColor } from "./theme";
import { PRODUCT_NAME } from "./brand";
import { termWidth, wrap, truncate, visLen } from "./render";
import { runningLabel, renderToolActivity, type TranscriptLineView } from "./activity";
import { formatEvent, formatError } from "./events";
import { renderMarkdown } from "./markdown";
import { renderUnifiedDiff } from "../diff-render";

/** Column budget for a turn's output (bounded so ultra-wide terminals stay readable). */
export function turnWidth(): number {
  return Math.max(40, Math.min(termWidth() - 2, 110));
}

/** How many work-log lines stay visible when the log collapses. */
const WORK_TAIL = 3;
/** How many work-log lines the live pinned window shows. */
const LIVE_TAIL = 4;

export interface TurnSink {
  /** Append a finished block to the transcript (scrollback). */
  commit(block: string): void;
  /** Live window above the composer: recent work + to-dos + prose preview
   *  (null = clear). Optional — the classic surface has none. */
  preview?(lines: string[] | null): void;
}

export interface TurnRendererOpts {
  /** Model id, shown on the record line. */
  model?: string;
  /** Session cost getter for the record line. */
  getCost?: () => number;
  /** Stream work lines straight to the transcript (classic readline surface —
   *  no pinned window to host the live tail, and print can't be retracted). */
  streamWork?: boolean;
}

interface TodoItem {
  content: string;
  status: string;
}

interface EditStat {
  added: number;
  removed: number;
  /** True for a brand-new file (write_file). */
  created?: boolean;
}

// ── the user's message: loud, findable at a glance ──

/** A prominent block for the user's own words: accent bar + bold text. */
export function userBlock(raw: string): string {
  const w = turnWidth() - 4;
  const out: string[] = [""];
  for (const src of raw.split("\n")) {
    for (const ln of wrap(src, w)) out.push(` ${accent("▌")} ${bold(text(ln))}`);
  }
  return out.join("\n");
}

// ── the response: the statement, set down ──

/** The `Berne▮` response header — wordmark + block cursor (the Savoir lockup). */
export function responseHead(): string {
  return ` ${bold(text(PRODUCT_NAME))}${ok("▮")}`;
}

export function responseBlock(markdown: string): string {
  const body = renderMarkdown(markdown, { width: turnWidth(), indent: "   " });
  return ["", responseHead(), ...body].join("\n");
}

// ── shared fragments ──

/** The hexagon status marker (the signal). */
export const HEX = "⬢";

/** The working words — one is drawn per turn and slowly rotates, Claude-style,
 *  so a long turn reads as alive (and a little fun) instead of stuck. */
export const COOKING_VERBS = [
  "Cooking",
  "Brewing",
  "Tinkering",
  "Pondering",
  "Sketching",
  "Wiring",
  "Distilling",
  "Composing",
  "Polishing",
  "Conjuring",
  "Noodling",
  "Simmering",
] as const;

/** The verb for a given turn + elapsed time: seeded per turn, advancing every
 *  ~12s so the word changes while one thing runs long. */
export function cookingVerb(seed: number, elapsedMs: number): string {
  const step = Math.floor(elapsedMs / 12_000);
  return COOKING_VERBS[Math.abs(seed + step) % COOKING_VERBS.length]!;
}

/** One framed chip naming an edited file: `│ path  +12 -3 │`. */
export function editChip(path: string, stat: EditStat): string {
  const w = turnWidth();
  const counts = stat.created ? ok("new") : `${ok(`+${stat.added}`)} ${accent(`-${stat.removed}`)}`;
  const countsW = visLen(counts);
  const shown = truncate(path, Math.max(12, w - countsW - 9));
  const inner = `${info(shown)}  ${counts}`;
  const innerW = visLen(inner);
  const top = `  ${lineColor("╭" + "─".repeat(innerW + 2) + "╮")}`;
  const mid = `  ${lineColor("│")} ${inner} ${lineColor("│")}`;
  const bot = `  ${lineColor("╰" + "─".repeat(innerW + 2) + "╯")}`;
  return [top, mid, bot].join("\n");
}

/** The to-do checklist block: `⬢ Working on N to-dos` + checkbox rows. */
export function todoBlock(items: TodoItem[], done: boolean): string {
  const open = items.filter((t) => t.status !== "completed").length;
  const head = done
    ? `  ${ok(HEX)} ${bold(text("Worked"))} ${text(`on ${items.length} to-do${items.length === 1 ? "" : "s"}`)}`
    : `  ${ok(HEX)} ${bold(text("Working"))} ${text(`on ${open} to-do${open === 1 ? "" : "s"}`)}`;
  const rows = items.map((t) => {
    if (t.status === "completed") return `    ${faint("☒")} ${faint(t.content)}`;
    if (t.status === "in_progress") return `    ${text("▣")} ${text(t.content)}`;
    return `    ${muted("☐")} ${muted(t.content)}`;
  });
  return [head, ...rows].join("\n");
}

/** The one-line record closing a turn: `⬢ done · 48s · 4 tools · $0.0042`. */
export function recordLine(stats: {
  outcome: "done" | "failed" | "interrupted";
  startedAt: number;
  tools: number;
  reroutes: number;
  cost?: number;
}): string {
  const secs = Math.max(0, Math.floor((Date.now() - stats.startedAt) / 1000));
  const t = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const parts: string[] = [stats.outcome, t];
  if (stats.tools > 0) parts.push(`${stats.tools} tool${stats.tools === 1 ? "" : "s"}`);
  if (stats.reroutes > 0) parts.push(`${stats.reroutes} reroute${stats.reroutes === 1 ? "" : "s"}`);
  if (stats.cost != null && stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
  const mark = stats.outcome === "done" ? ok(HEX) : accent(HEX);
  const paint = stats.outcome === "done" ? faint : accent;
  return `  ${mark} ${paint(parts.join(" · "))}`;
}

/** The collapsed view of a work log — the Codex idiom: the first few lines,
 *  then `34 more (ctrl+r to expand)`. Blank/whitespace rows (e.g. a diff cut
 *  mid-body) are not worth a slot. */
export function collapsedWork(log: string[], hint = "ctrl+r to expand"): string {
  const solid = log.filter((l) => stripAnsi(l).trim() !== "");
  if (solid.length <= WORK_TAIL + 1) return solid.join("\n");
  const hidden = solid.length - WORK_TAIL;
  const more = `  ${faint(`${hidden} more (${hint})`)}`;
  return [...solid.slice(0, WORK_TAIL), more].join("\n");
}

// ── the renderer ──

export class TurnRenderer {
  private prose = ""; // buffered current prose run (final-until-proven-narration)
  private think = ""; // buffered partial thinking line
  private thinkOpen = false;
  /** Every work line, styled — the full record. `detail` rows (diff bodies,
   *  long tool output) live only in the full log, never in collapsed tails. */
  private workLog: Array<{ l: string; detail: boolean }> = [];
  private todos: TodoItem[] = [];
  private editedFiles = new Map<string, EditStat>();
  private tools = 0;
  private reroutes = 0;
  private errored = false;
  private readonly startedAt = Date.now();
  /** Present-tense label of the in-flight tool, for the status line. */
  activity: string | null = null;

  constructor(
    private sink: TurnSink,
    private opts: TurnRendererOpts = {},
  ) {}

  /** The complete work log (for ctrl+r expansion), or null when there was none. */
  fullLog(): string | null {
    if (this.workLog.length === 0) return null;
    return [`  ${faint("work log")}`, ...this.workLog.map((e) => e.l)].join("\n");
  }

  /** Whether any work happened (drives the collapsed block + record line). */
  private get worked(): boolean {
    return this.workLog.length > 0 || this.tools > 0;
  }

  /** Tail-worthy lines: steps only, no detail rows, no blanks. */
  private stepLines(): string[] {
    return this.workLog.filter((e) => !e.detail && stripAnsi(e.l).trim() !== "").map((e) => e.l);
  }

  // ── work-log plumbing ──

  /** Add a work block. With detailAfterFirst, only the block's first line is a
   *  step (tail-worthy); the rest — a diff body, dumped output — is detail. */
  private pushWork(block: string, detailAfterFirst = false): void {
    const lines = block.split("\n");
    if (this.opts.streamWork) {
      this.sink.commit(lines.join("\n"));
    } else {
      lines.forEach((l, i) => this.workLog.push({ l, detail: detailAfterFirst && i > 0 }));
      this.updateLive();
    }
  }

  private updateLive(): void {
    this.sink.preview?.(this.liveLines());
  }

  /** The pinned live window: recent work, the to-do list, the prose preview. */
  liveLines(): string[] | null {
    const out: string[] = [];
    const solid = this.opts.streamWork ? [] : this.stepLines();
    if (solid.length > 0) {
      out.push(...solid.slice(-LIVE_TAIL));
      if (solid.length > LIVE_TAIL) {
        out.push(`  ${faint(`${solid.length - LIVE_TAIL} more (ctrl+r to expand)`)}`);
      }
    }
    if (this.todos.length > 0) {
      if (out.length) out.push("");
      out.push(...todoBlock(this.todos, false).split("\n"));
    }
    const preview = this.prosePreview();
    if (preview) {
      if (out.length) out.push("");
      out.push(...preview);
    }
    return out.length ? out : null;
  }

  private prosePreview(): string[] | null {
    const run = this.prose.trim();
    if (!run) return null;
    const w = Math.max(20, turnWidth() - 6);
    const flowed = run
      .split("\n")
      .filter((l) => l.trim() !== "")
      .flatMap((p) => wrap(p, w));
    const tail = flowed.slice(-4);
    const head =
      flowed.length > tail.length
        ? [`  ${faint(`▏ … ${flowed.length - tail.length} more lines`)}`]
        : [];
    return [...head, ...tail.map((ln) => `  ${faint("▏")} ${muted(ln)}`)];
  }

  // ── prose + thinking ──

  /** The buffered run turned out to be narration — set it down as plain prose. */
  private flushProseAsNarration(): void {
    const run = this.prose.trim();
    this.prose = "";
    this.updateLive();
    if (!run) return;
    const w = turnWidth() - 4;
    const flowed = run
      .split("\n")
      .filter((l) => l.trim() !== "")
      .flatMap((p) => wrap(p, w));
    this.sink.commit(["", ...flowed.map((ln) => `  ${text(ln)}`)].join("\n"));
  }

  private flushThink(final = false): void {
    let idx: number;
    while ((idx = this.think.indexOf("\n")) >= 0) {
      this.emitThinkLine(this.think.slice(0, idx));
      this.think = this.think.slice(idx + 1);
    }
    if (final && this.think.trim()) {
      this.emitThinkLine(this.think);
      this.think = "";
    }
  }

  private emitThinkLine(raw: string): void {
    if (raw.trim() === "" && !this.thinkOpen) return;
    if (!this.thinkOpen) {
      this.pushWork(`  ${faint("✻ thinking")}`);
      this.thinkOpen = true;
    }
    const w = turnWidth() - 6;
    for (const ln of wrap(raw, w)) this.pushWork(`    ${faint(ln)}`);
  }

  // ── events ──

  /** Feed one streamed engine event. */
  onEvent(ev: any): void {
    switch (ev.type) {
      case "thinking_delta":
        this.think += ev.text;
        this.flushThink();
        return;

      case "text_delta":
        if (this.think || this.thinkOpen) {
          this.flushThink(true);
          this.thinkOpen = false;
        }
        this.activity = null;
        this.prose += ev.text;
        this.updateLive();
        return;

      case "stream_reset":
        // The provider stream was abandoned and is re-streaming from scratch:
        // drop the partial prose/thinking or the retry doubles it on screen.
        this.prose = "";
        this.think = "";
        this.thinkOpen = false;
        this.activity = null;
        this.updateLive();
        return;

      case "tool_call_start":
        this.activity = runningLabel(ev.toolName);
        return;

      case "todo_updated":
        // The plan lives in the live window while the turn runs; its final
        // state is committed once, at finish. (Classic streams each update.)
        this.todos = Array.isArray(ev.items) ? ev.items : [];
        if (this.opts.streamWork) this.pushWork(todoBlock(this.todos, false));
        else this.updateLive();
        return;

      case "turn_complete":
        return; // folded into the record line

      case "tool_call_end": {
        this.flushThink(true);
        this.thinkOpen = false;
        this.flushProseAsNarration(); // the model kept working → that run was narration
        this.activity = null;
        this.tools++;
        this.recordEdit(ev);
        // Edits render head + diff body: the body is detail (full log only).
        this.pushWork(
          renderToolActivity({
            toolName: ev.output.toolName,
            args: ev.args ?? {},
            result: ev.output.result,
            success: ev.output.success,
            error: ev.output.error,
            durationMs: ev.output.durationMs,
          }),
          ev.output.toolName === "edit_file",
        );
        return;
      }

      case "notice":
      case "context_warning": {
        // STATUS events are out-of-band: they never demote the buffered run —
        // unless the notice announces that more work follows (a failed
        // verification re-prompts; a reroute restarts the stream).
        this.flushThink(true);
        this.thinkOpen = false;
        if (noticeDemotes(ev.message ?? "")) this.flushProseAsNarration();
        if (isReroute(ev.message ?? "")) this.reroutes++;
        const block = formatEvent(ev, { cost: this.opts.getCost?.() });
        if (block) this.pushWork(block);
        return;
      }

      case "error": {
        this.flushThink(true);
        this.thinkOpen = false;
        this.flushProseAsNarration();
        this.activity = null;
        this.errored = true;
        // Errors are never hidden in the log — they commit to the transcript.
        const block = formatEvent(ev, { cost: this.opts.getCost?.() });
        if (block) this.sink.commit(block);
        return;
      }

      default: {
        // Plans, steps, replanning… — work. Demote the run, log the event.
        this.flushThink(true);
        this.thinkOpen = false;
        this.flushProseAsNarration();
        this.activity = null;
        const block = formatEvent(ev, { cost: this.opts.getCost?.() });
        if (block) this.pushWork(block);
        return;
      }
    }
  }

  /** Track edited/written files for the chips. */
  private recordEdit(ev: any): void {
    if (!ev.output?.success) return;
    const name = ev.output.toolName;
    if (name !== "edit_file" && name !== "write_file") return;
    const path = String(ev.args?.path ?? "");
    if (!path) return;
    if (name === "write_file") {
      const prev = this.editedFiles.get(path);
      this.editedFiles.set(path, prev ?? { added: 0, removed: 0, created: true });
      return;
    }
    let added = 0;
    let removed = 0;
    try {
      const parsed = JSON.parse(ev.output.result);
      if (parsed?.diff) {
        const r = renderUnifiedDiff(String(parsed.diff), "");
        added = r.added;
        removed = r.removed;
      }
    } catch {
      // counts stay 0 — the chip still names the file
    }
    const prev = this.editedFiles.get(path) ?? { added: 0, removed: 0 };
    this.editedFiles.set(path, {
      added: prev.added + added,
      removed: prev.removed + removed,
      created: prev.created,
    });
  }

  /** Surface an error raised outside the event stream (thrown mid-turn). */
  onError(err: unknown): void {
    this.errored = true;
    this.flushThink(true);
    this.flushProseAsNarration();
    this.sink.commit(formatError(err instanceof Error ? err.message : String(err)));
  }

  /** Close the turn: collapse the work, set down the chips + plan + record + answer. */
  finish(opts: { aborted?: boolean } = {}): void {
    this.flushThink(true);
    this.thinkOpen = false;
    this.sink.preview?.(null);

    const answer = this.prose.trim();
    this.prose = "";

    // 1 · the work, collapsed (TUI path; classic already streamed it)
    if (!this.opts.streamWork && this.workLog.length > 0) {
      this.sink.commit("");
      this.sink.commit(collapsedWork(this.stepLines()));
    }

    // 2 · one chip per touched file
    if (this.editedFiles.size > 0) {
      this.sink.commit("");
      for (const [path, stat] of this.editedFiles) this.sink.commit(editChip(path, stat));
    }

    // 3 · the plan's final state
    if (this.todos.length > 0) {
      this.sink.commit("");
      this.sink.commit(todoBlock(this.todos, !opts.aborted && !this.errored));
    }

    // 4 · the record
    if (this.worked || this.errored || opts.aborted) {
      const outcome = opts.aborted ? "interrupted" : this.errored && !answer ? "failed" : "done";
      this.sink.commit("");
      this.sink.commit(
        recordLine({
          outcome,
          startedAt: this.startedAt,
          tools: this.tools,
          reroutes: this.reroutes,
          cost: this.opts.getCost?.(),
        }),
      );
    }

    // 5 · the answer
    if (answer) this.sink.commit(responseBlock(answer) + "\n");
    else if (opts.aborted)
      this.sink.commit(`\n ${accent("▮")} ${muted("interrupted — nothing set down")}\n`);
  }
}

function isReroute(message: string): boolean {
  return /unavailable.*Switching to/s.test(message);
}

/** Notices that guarantee the model continues (so buffered prose is narration). */
function noticeDemotes(message: string): boolean {
  return (
    isReroute(message) ||
    /verification failed/i.test(message) ||
    /no execution evidence/i.test(message) ||
    /replanning/i.test(message)
  );
}

// ── replay: a resumed session reads exactly like it did live ──

/**
 * Batch-render a persisted transcript in the same collapsed language. Within
 * each turn (user message → next user message), every assistant line FOLLOWED
 * by more work is narration; the turn's last assistant line is its response.
 * Tool calls and notes collapse into the quiet work view.
 */
export function renderReplay(lines: TranscriptLineView[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.role === "user") {
      out.push(userBlock(ln.text));
      i++;
      continue;
    }
    // Collect one turn's worth of assistant/tool/note lines.
    let j = i;
    while (j < lines.length && lines[j]!.role !== "user") j++;
    const turn = lines.slice(i, j);
    const lastAssistant = turn.map((l) => l.role).lastIndexOf("assistant");
    const answer = lastAssistant >= 0 ? turn[lastAssistant]! : null;

    const w = turnWidth() - 4;
    const work: string[] = [];
    turn.forEach((l, k) => {
      if (k === lastAssistant) return;
      if (l.role === "assistant") {
        // Narration replays as plain prose, in the open — same as live.
        const flowed = l.text
          .split("\n")
          .filter((s) => s.trim() !== "")
          .flatMap((p) => wrap(p, w));
        out.push("", ...flowed.map((s) => `  ${text(s)}`));
      } else if (l.role === "note") {
        work.push(`  ${faint(`— ${truncate(l.text, w)} —`)}`);
      } else if (l.role === "tool") {
        work.push(
          ...renderToolActivity({
            toolName: l.toolName ?? l.text,
            args: l.args ?? {},
            result: l.result ?? "",
            success: !l.isError,
            error: l.isError ? l.result || "failed" : undefined,
          }).split("\n"),
        );
      }
    });

    if (work.length > 0) {
      out.push("");
      out.push(collapsedWork(work, "replayed"));
    }
    if (answer) out.push(responseBlock(answer.text));
    i = j;
  }
  return out.join("\n");
}
