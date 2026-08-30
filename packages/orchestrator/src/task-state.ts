// ─── Task state: the spine of a run ───
//
// Why this exists: the agent's understanding of WHAT IT IS DOING used to live
// only in the transcript — a todo list was a tool echo, the file ledger was
// implicit in tool results, and compaction paraphrased all of it into a
// 2k-token summary. After one compaction (or a resume, or a crash) the model
// no longer knew its own plan. This store is the fix: a small, structured,
// engine-owned record of the task — goal, clarifications, todos, file ledger,
// verification status, handoff — that lives OUTSIDE the transcript, is
// re-injected every request as an ephemeral tail block, and is persisted as
// `task_state` snapshot events in the ordinary session log (latest wins).
// Everything here is deterministic and zero-token: no model calls, ever.

import type { SessionEvent } from "@gear/shared";
import { countTokens } from "./tokenizer";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export type HandoffReason =
  | "max_turns"
  | "context_exhausted"
  | "aborted"
  | "error"
  /** The safety broker halted the run; the agent reported and stopped. */
  | "halted";

export interface TaskState {
  version: 1;
  /** Verbatim user ask that started the CURRENT task — never paraphrased. */
  goal: string;
  /**
   * Latest pure-steering message ("proceed", "fix it properly") — pushes that
   * carry no content of their own and therefore must NOT replace the goal.
   */
  directive?: string;
  /**
   * Goals of earlier tasks in this session, oldest first (capped). Restores
   * lineage after a follow-up starts a new task: "make it work properly" is
   * only intelligible next to the original "build me a clone of X".
   */
  priorGoals?: string[];
  /** ask_user rounds captured this task — they survive compaction via re-injection. */
  clarifications: Array<{ question: string; answer: string }>;
  /** THE plan. todo_write is its sole write API. */
  todos: TodoItem[];
  /** Files this task wrote (same semantics as the git auto-commit scope). */
  filesWritten: string[];
  /** Files read, ring-capped — recency beats completeness here. */
  filesRead: string[];
  /** One-line decisions/assumptions worth remembering across compaction. */
  decisions: string[];
  verification: {
    status: "none" | "passed" | "failed" | "unavailable";
    attempts: number;
    lastReport?: string;
  };
  /** Set when a run ended without finishing; cleared once resumed work folds it in. */
  handoff?: { reason: HandoffReason; state: string; at: string };
  updatedAt: string;
}

const FILES_READ_CAP = 30;
const DECISIONS_CAP = 10;
const TODOS_RENDER_CAP = 20;
const REPORT_CAP = 500;
const PRIOR_GOALS_CAP = 3;

// Words that make up a contentless push. A message whose every token is one of
// these ("well now proceed !!", "ok go ahead", "just fix it properly") steers
// the CURRENT work — it is not a goal. Observed failure this guards against: a
// session whose spine said `Goal: well now proceed !!` while the real product
// ask lived only in the compaction-vulnerable transcript.
const STEERING_WORDS = new Set([
  "well",
  "now",
  "proceed",
  "continue",
  "go",
  "ahead",
  "ok",
  "okay",
  "yes",
  "yeah",
  "yep",
  "please",
  "just",
  "do",
  "it",
  "this",
  "that",
  "then",
  "next",
  "keep",
  "going",
  "carry",
  "on",
  "resume",
  "start",
  "again",
  "properly",
  "correctly",
  "fine",
  "sure",
  "right",
  "alright",
  "so",
  "and",
  "fix",
  "the",
  "them",
  "all",
  "everything",
  "more",
  "done",
  "finish",
  "complete",
  "work",
]);

/** True when a message is pure steering: short and made only of push-words. */
function isPureSteering(message: string): boolean {
  if (message.length > 80) return false;
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true; // punctuation-only ("!!", "??")
  return tokens.length <= 8 && tokens.every((t) => STEERING_WORDS.has(t));
}
/** Default token budget for the injected block. */
export const TASK_STATE_BLOCK_BUDGET = 600;

function emptyState(): TaskState {
  return {
    version: 1,
    goal: "",
    clarifications: [],
    todos: [],
    filesWritten: [],
    filesRead: [],
    decisions: [],
    verification: { status: "none", attempts: 0 },
    updatedAt: new Date().toISOString(),
  };
}

export class TaskStateStore {
  private state: TaskState = emptyState();

  // ─── Task boundary ───

  /**
   * Deterministic task-boundary rule, applied to every incoming user message:
   * a message that arrives with no open work (no todos, or all completed) and
   * no pending handoff starts a NEW task — reset everything and record the
   * verbatim goal. Anything else is mid-task steering: the goal and plan
   * stand, per the mid-task-steering doctrine.
   *
   * Two refinements keep the goal meaningful across a session:
   * - A pure-steering push ("proceed", "fix it properly") NEVER becomes the
   *   goal, even at a task boundary — it lands in `directive` and the previous
   *   goal stands, because the push is only intelligible next to it.
   * - When a substantive message does start a new task, the outgoing goal is
   *   retained in `priorGoals` so follow-up tasks ("make it actually work")
   *   keep their lineage to the original ask.
   *
   * Returns true when a new task began (callers may want to persist).
   */
  beginTurn(userMessage: string): boolean {
    const open = this.state.todos.some((t) => t.status !== "completed");
    if (open || this.state.handoff) {
      this.touch();
      return false;
    }
    const trimmed = userMessage.trim();
    if (this.state.goal && isPureSteering(trimmed)) {
      this.state.directive = trimmed.slice(0, 200);
      this.touch();
      return false;
    }
    const outgoingGoal = this.state.goal;
    const lineage = [...(this.state.priorGoals ?? []), outgoingGoal]
      .filter(Boolean)
      .slice(-PRIOR_GOALS_CAP);
    this.state = emptyState();
    this.state.goal = trimmed.slice(0, 2_000);
    if (lineage.length > 0) this.state.priorGoals = lineage;
    return true;
  }

  // ─── Mutators (all zero-token, all called from the loop's tool chokepoint) ───

  setTodos(items: TodoItem[]): void {
    this.state.todos = items
      .filter((t) => typeof t.content === "string" && t.content.trim().length > 0)
      .map((t) => ({
        content: t.content.slice(0, 300),
        status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending",
      }));
    this.touch();
  }

  addClarification(question: string, answer: string): void {
    this.state.clarifications.push({
      question: question.slice(0, 300),
      answer: answer.slice(0, 300),
    });
    this.touch();
  }

  noteFileRead(path: string): void {
    if (!path) return;
    const list = this.state.filesRead.filter((p) => p !== path);
    list.push(path);
    this.state.filesRead = list.slice(-FILES_READ_CAP);
    this.touch();
  }

  noteFileWritten(path: string): void {
    if (!path) return;
    if (!this.state.filesWritten.includes(path)) this.state.filesWritten.push(path);
    this.touch();
  }

  addDecision(line: string): void {
    const t = line.trim();
    if (!t) return;
    this.state.decisions.push(t.slice(0, 200));
    if (this.state.decisions.length > DECISIONS_CAP) {
      this.state.decisions = this.state.decisions.slice(-DECISIONS_CAP);
    }
    this.touch();
  }

  noteVerification(ran: boolean, passed: boolean, report?: string): void {
    this.state.verification = {
      status: !ran ? "unavailable" : passed ? "passed" : "failed",
      attempts: this.state.verification.attempts + (ran ? 1 : 0),
      lastReport: report?.slice(0, REPORT_CAP),
    };
    this.touch();
  }

  setHandoff(reason: HandoffReason): void {
    this.state.handoff = { reason, state: this.renderHandoff(), at: new Date().toISOString() };
    this.touch();
  }

  clearHandoff(): void {
    delete this.state.handoff;
    this.touch();
  }

  // ─── Reads ───

  get todos(): TodoItem[] {
    return this.state.todos;
  }

  hasOpenTodos(): boolean {
    return this.state.todos.some((t) => t.status !== "completed");
  }

  filesWrittenCount(): number {
    return this.state.filesWritten.length;
  }

  clarificationCount(): number {
    return this.state.clarifications.length;
  }

  // ─── Rendering ───

  /**
   * The compact block injected as an ephemeral tail message each request.
   * Returns null when there is nothing beyond a bare goal — trivial tasks
   * inject nothing and cost nothing. Under budget pressure, sections drop in
   * fixed order (filesRead → decisions → verification report → clarifications);
   * the goal and the todo list are never dropped.
   */
  renderBlock(maxTokens: number = TASK_STATE_BLOCK_BUDGET): string | null {
    const s = this.state;
    const hasSubstance =
      s.todos.length > 0 ||
      s.clarifications.length > 0 ||
      s.filesWritten.length > 0 ||
      s.decisions.length > 0 ||
      s.verification.status !== "none" ||
      !!s.handoff;
    if (!hasSubstance) return null;

    // Assemble at full detail, then shed optional sections until it fits.
    for (let detail = 3; detail >= 0; detail--) {
      const lines: string[] = ["[Task state — maintained by the harness, not a user message]"];
      if (s.goal) lines.push(`Goal: ${s.goal.slice(0, 300)}`);
      if (s.directive) lines.push(`Latest user push: ${s.directive.slice(0, 200)}`);
      if (detail >= 2 && s.priorGoals && s.priorGoals.length > 0) {
        lines.push(
          `Earlier goals this session: ${s.priorGoals.map((g) => g.slice(0, 120)).join(" | ")}`,
        );
      }
      if (s.handoff) {
        lines.push(`Resume note (${s.handoff.reason}): continue from the next unfinished step.`);
      }
      if (detail >= 1 && s.clarifications.length > 0) {
        for (const c of s.clarifications.slice(-4)) {
          lines.push(`Clarified: ${c.question} → ${c.answer}`);
        }
      }
      if (s.todos.length > 0) {
        lines.push("Todos:");
        for (const t of s.todos.slice(0, TODOS_RENDER_CAP)) {
          const mark =
            t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
          lines.push(`  ${mark} ${t.content}`);
        }
        if (s.todos.length > TODOS_RENDER_CAP) {
          lines.push(`  …+${s.todos.length - TODOS_RENDER_CAP} more`);
        }
      }
      if (s.filesWritten.length > 0 || (detail >= 3 && s.filesRead.length > 0)) {
        const written =
          s.filesWritten.length > 0
            ? `${s.filesWritten.length} written (${s.filesWritten.slice(-6).join(", ")})`
            : "";
        const read = detail >= 3 && s.filesRead.length > 0 ? `${s.filesRead.length} read` : "";
        lines.push(`Files: ${[written, read].filter(Boolean).join(" · ")}`);
      }
      if (detail >= 2 && s.decisions.length > 0) {
        lines.push(`Decisions: ${s.decisions.join(" | ")}`);
      }
      if (s.verification.status !== "none") {
        // "failed" shows its first error line at high detail; "unavailable"
        // ALWAYS shows why — after a session that wrote files, "nothing
        // runnable detected" is a red flag (static files where an application
        // was asked for), and hiding it is how mocks get presented as apps.
        const rep =
          s.verification.lastReport &&
          (s.verification.status === "unavailable" ||
            (detail >= 2 && s.verification.status === "failed"))
            ? ` — ${s.verification.lastReport.split("\n")[0].slice(0, 160)}`
            : "";
        lines.push(
          `Verification: ${s.verification.status}` +
            (s.verification.attempts > 0 ? ` (attempt ${s.verification.attempts})` : "") +
            rep,
        );
      }
      lines.push("Keep this list accurate with todo_write. If the plan changed, rewrite it.");
      const block = lines.join("\n");
      if (countTokens(block) <= maxTokens || detail === 0) return block;
    }
    return null; // unreachable — detail 0 always returns
  }

  /**
   * The zero-token handoff template: an honest "state of work" for a run that
   * ended before finishing. Deliberately NOT a model call — the moment the
   * budget is exhausted is the least reliable moment to ask for one more
   * completion.
   */
  renderHandoff(): string {
    const s = this.state;
    const done = s.todos.filter((t) => t.status === "completed");
    const open = s.todos.filter((t) => t.status !== "completed");
    const lines: string[] = ["State of work:"];
    if (s.goal) lines.push(`Goal: ${s.goal.slice(0, 300)}`);
    if (done.length > 0) {
      lines.push(`Done (${done.length}):`);
      for (const t of done.slice(0, 10)) lines.push(`  ✓ ${t.content}`);
    }
    if (open.length > 0) {
      lines.push(`Remaining (${open.length}):`);
      for (const t of open.slice(0, 10)) lines.push(`  · ${t.content}`);
    }
    if (s.filesWritten.length > 0) {
      lines.push(`Files touched: ${s.filesWritten.slice(-10).join(", ")}`);
    }
    if (s.verification.status !== "none") {
      lines.push(`Verification: ${s.verification.status}`);
    }
    lines.push(
      open.length > 0
        ? `Next step: ${open[0].content}`
        : "Next step: confirm the result and wrap up.",
    );
    return lines.join("\n");
  }

  // ─── Persistence ───

  snapshot(): TaskState {
    return structuredClone(this.state);
  }

  static restore(state: TaskState): TaskStateStore {
    const store = new TaskStateStore();
    // Merge over an empty state so snapshots from older versions never leave
    // a field undefined.
    store.state = { ...emptyState(), ...structuredClone(state) };
    return store;
  }

  /**
   * Rebuild from a session's event log: the LATEST `task_state` snapshot wins.
   * Returns null when the log carries none (pre-spine sessions).
   */
  static fromEvents(events: Array<{ seq: number; event: SessionEvent }>): TaskStateStore | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i].event;
      if (e.type === "task_state" && e.payload && typeof e.payload === "object") {
        const state = (e.payload as { state?: TaskState }).state;
        if (state && state.version === 1) return TaskStateStore.restore(state);
      }
    }
    return null;
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}
