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
//
// Two later hardenings, each pinned to an observed failure:
//  - Task boundaries ARCHIVE, never erase (see beginTurn) — a casual
//    follow-up used to wipe a 4-hour build's ledger to empties.
//  - The full state also renders to an on-disk mission file the engine
//    maintains (renderMissionFile), because a budgeted excerpt of a 10k-word
//    spec is not a spec.

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
// The goal is the SPEC. It used to be capped at 2,000 chars, which turned a
// 10k-word product brief into a stub the moment it left the transcript — the
// durable record of a 4-hour build held 2,000 chars of requirements. The cap
// exists only to bound event size, so it is set where a real brief fits.
const GOAL_CAP = 24_000;
/** Lineage entries are context, not the live spec — capped harder. */
const PRIOR_GOAL_CHARS = 2_000;
/** Todos rendered into the mission FILE (the block keeps its tighter cap). */
const MISSION_TODOS_CAP = 50;
/** Hard ceiling on the mission file so a runaway state can't fill a disk. */
const MISSION_FILE_MAX_CHARS = 64_000;

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

// Filler that precedes the real verb ("well then show me…"). Stripped before
// the stem test so conversational padding can't hide an inspection.
const FILLER_PREFIX_RE =
  /^(?:(?:well|ok|okay|so|now|then|and|also|please|hey|btw|hmm|but|alright)\b[\s,!.-]*)+/i;
// Interrogative / inspection openers: the message asks ABOUT the work rather
// than commissioning new work. Deliberately structural (English question
// grammar), not a vocabulary of pushes — vocabulary lists rot; observed:
// "well then show me the preview if its done !!" became a 4-hour build's goal
// because it wasn't on the push-word list.
const INSPECTION_STEM_RE =
  /^(?:show|preview|status|is\b|are\b|was\b|were\b|does\b|did\b|have\b|has\b|what\b|which\b|where\b|when\b|why\b|how\b|tell me\b|explain\b)/i;

/**
 * True when a short message inspects existing work ("show me the preview",
 * "is it done?", "what did you change") rather than starting new work. Only
 * consulted when a goal already exists; misclassification is deliberately
 * cheap either way because the task boundary archives instead of erasing.
 */
function isInspection(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > 100) return false;
  if (/\?\s*$/.test(trimmed)) return true;
  return INSPECTION_STEM_RE.test(trimmed.replace(FILLER_PREFIX_RE, ""));
}
/** Default token budget for the injected block. */
export const TASK_STATE_BLOCK_BUDGET = 600;
/**
 * Budget for the ONE request right after a compaction. That is the moment the
 * verbatim spec just left the transcript, so the spine briefly carries more of
 * it — the difference between "the goal survived" and "a 300-char paraphrase
 * survived".
 */
export const TASK_STATE_BLOCK_BUDGET_AFTER_COMPACTION = 1_400;

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
  /**
   * Workspace-relative path of the mission file, when the engine maintains one
   * (e.g. ".gear/mission.md"). Render-time only — never part of the snapshot,
   * so a session restored on another machine simply omits the pointer until
   * its engine sets it again.
   */
  private missionPath: string | null = null;

  setMissionPath(path: string | null): void {
    this.missionPath = path;
  }

  // ─── Task boundary ───

  /**
   * Deterministic task-boundary rule, applied to every incoming user message:
   * a message that arrives with no open work (no todos, or all completed) and
   * no pending handoff starts a NEW task. Anything else is mid-task steering:
   * the goal and plan stand, per the mid-task-steering doctrine.
   *
   * Three refinements keep the state meaningful across a session:
   * - A pure-steering push ("proceed", "fix it properly") or a short
   *   INSPECTION of existing work ("show me the preview", "is it done?")
   *   NEVER becomes the goal — it lands in `directive` and the previous goal
   *   stands, because such a message is only intelligible next to it.
   * - When a substantive message does start a new task, the outgoing goal is
   *   retained in `priorGoals` so follow-up tasks ("make it actually work")
   *   keep their lineage to the original ask.
   * - The boundary ARCHIVES, never erases. The session ledger — files
   *   written/read, decisions, clarifications, the last verification result —
   *   records what is true of the WORKSPACE, and a new goal does not
   *   un-happen any of it. Only the todo list belongs to the mission and
   *   resets. Observed rot this replaces: a casual follow-up wiped a 4-hour
   *   build's spine to empties, leaving no plan, no ledger, and a goal of
   *   "well then show me the preview if its done !!".
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
    if (this.state.goal && (isPureSteering(trimmed) || isInspection(trimmed))) {
      this.state.directive = trimmed.slice(0, 200);
      this.touch();
      return false;
    }
    const outgoingGoal = this.state.goal;
    const lineage = [...(this.state.priorGoals ?? []), outgoingGoal.slice(0, PRIOR_GOAL_CHARS)]
      .filter(Boolean)
      .slice(-PRIOR_GOALS_CAP);
    this.state.goal = trimmed.slice(0, GOAL_CAP);
    delete this.state.directive;
    this.state.todos = [];
    if (lineage.length > 0) this.state.priorGoals = lineage;
    else delete this.state.priorGoals;
    // Verification describes the tree, which the new goal inherits — keep the
    // last known status/report, but the attempt counter belongs to the task.
    this.state.verification = {
      status: this.state.verification.status,
      attempts: 0,
      ...(this.state.verification.lastReport
        ? { lastReport: this.state.verification.lastReport }
        : {}),
    };
    this.touch();
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

    // The goal excerpt scales with the budget: the post-compaction boost
    // exists precisely to carry more of the spec at the moment the verbatim
    // text just left the transcript.
    const goalChars = maxTokens >= 1_000 ? 2_400 : 600;

    // Assemble at full detail, then shed optional sections until it fits.
    for (let detail = 3; detail >= 0; detail--) {
      const lines: string[] = ["[Task state — maintained by the harness, not a user message]"];
      if (s.goal) {
        const shown = s.goal.slice(0, detail >= 1 ? goalChars : 300);
        lines.push(`Goal: ${shown}${s.goal.length > shown.length ? " …" : ""}`);
      }
      if (s.directive) lines.push(`Latest user push: ${s.directive.slice(0, 200)}`);
      if (
        detail >= 1 &&
        this.missionPath &&
        (s.goal.length > goalChars || (s.priorGoals?.length ?? 0) > 0)
      ) {
        lines.push(`Full brief and history: ${this.missionPath} — read it if unsure of the mission.`);
      }
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

  /**
   * The mission dossier: a durable, on-disk rendering of the whole state, at
   * full fidelity. The ephemeral block is a budgeted excerpt; this file is the
   * document it excerpts. The engine rewrites it whenever the spine persists,
   * so it survives compaction, resume, crash, quota death, and the engine
   * process itself — and the model can simply read it when unsure.
   */
  renderMissionFile(): string {
    const s = this.state;
    const lines: string[] = [
      "# Mission",
      "",
      "> Maintained by Gear. This is the durable record of the current task —",
      "> read it when unsure what the mission is. Do not edit by hand:",
      "> todo_write and the run itself keep it current.",
      "",
      "## Goal (verbatim)",
      "",
      s.goal || "(none yet)",
    ];
    if (s.directive) {
      lines.push("", "## Latest user push", "", s.directive);
    }
    if (s.priorGoals && s.priorGoals.length > 0) {
      lines.push("", "## Earlier goals this session (oldest first)");
      s.priorGoals.forEach((g, i) => {
        lines.push("", `### ${i + 1}.`, "", g);
      });
    }
    if (s.todos.length > 0) {
      lines.push("", "## Plan");
      for (const t of s.todos.slice(0, MISSION_TODOS_CAP)) {
        const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        lines.push(`- ${mark} ${t.content}`);
      }
      if (s.todos.length > MISSION_TODOS_CAP) {
        lines.push(`- …+${s.todos.length - MISSION_TODOS_CAP} more`);
      }
    }
    if (s.decisions.length > 0) {
      lines.push("", "## Decisions");
      for (const d of s.decisions) lines.push(`- ${d}`);
    }
    if (s.clarifications.length > 0) {
      lines.push("", "## Clarified with the user");
      for (const c of s.clarifications) lines.push(`- ${c.question} → ${c.answer}`);
    }
    if (s.filesWritten.length > 0 || s.filesRead.length > 0) {
      lines.push("", "## Files");
      if (s.filesWritten.length > 0) {
        lines.push(`Written (${s.filesWritten.length}):`);
        for (const f of s.filesWritten) lines.push(`- ${f}`);
      }
      if (s.filesRead.length > 0) {
        lines.push(`Recently read: ${s.filesRead.slice(-10).join(", ")}`);
      }
    }
    if (s.verification.status !== "none") {
      lines.push(
        "",
        "## Verification",
        `${s.verification.status}` +
          (s.verification.attempts > 0 ? ` (attempt ${s.verification.attempts})` : "") +
          (s.verification.lastReport ? ` — ${s.verification.lastReport.split("\n")[0]}` : ""),
      );
    }
    if (s.handoff) {
      lines.push("", "## Resume note", `Run ended early (${s.handoff.reason}).`, s.handoff.state);
    }
    lines.push("", `_Updated: ${s.updatedAt}_`, "");
    const doc = lines.join("\n");
    return doc.length > MISSION_FILE_MAX_CHARS
      ? doc.slice(0, MISSION_FILE_MAX_CHARS) + "\n… (truncated)"
      : doc;
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
