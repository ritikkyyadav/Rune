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
// Three hardenings, each pinned to an observed failure:
//  - Task boundaries FOLLOW THE PLAN, never the message (see beginTurn). A
//    vocabulary of push-words used to decide whether a follow-up was a new
//    goal, and vocabularies rot: "well i am unable to see the preview could
//    you show me" replaced a six-hour build's spec as the goal and emptied
//    its plan. Now a substantive follow-up is a CANDIDATE goal that only
//    becomes the goal when the model writes a fresh plan against it.
//  - A step carries EVIDENCE the harness measured (see noteEffect/setTodos).
//    "completed" used to be a free-text assertion — the model could mark
//    "run the tests" done with no command run. A completion with nothing
//    behind it is refused once; re-submitting attests it, and the attestation
//    is shown to the user as unproven rather than as a green tick.
//  - The full state also renders to an on-disk mission file the engine
//    maintains (renderMissionFile), because a budgeted excerpt of a 10k-word
//    spec is not a spec — and the file now carries the run's own log, so the
//    dossier doubles as the audit trail of what moved each step.

import type { SessionEvent } from "@gear/shared";
import { countTokens } from "./tokenizer";

// The plan-ledger wire shapes live in `@gear/protocol`: `todo_updated` and
// `handoff` carry them to every surface, so the union and its evidence counts
// are defined once and re-exported here for the ~40 in-repo import sites.
export type { TodoStatus, StepEvidence, TodoItem, HandoffReason } from "@gear/protocol";
import type { StepEvidence, TodoItem, TodoStatus, HandoffReason } from "@gear/protocol";

export type EffectKind =
  "read" | "write" | "run" | "check_pass" | "check_fail" | "answer" | "delegate" | "look";

export type StepLogKind =
  | "plan"
  | "replan"
  | "done"
  | "unproven"
  | "dropped"
  | "check"
  | "boundary"
  | "steer"
  | "gate"
  | "handoff";

/** One line of the run's own audit trail. Rendered into the mission file. */
export interface StepLogEntry {
  at: string;
  kind: StepLogKind;
  text: string;
}

export interface TaskState {
  version: 1;
  /** Verbatim user ask that started the CURRENT task — never paraphrased. */
  goal: string;
  /**
   * Latest user message that did not start a task of its own — a push
   * ("proceed"), an inspection ("show me"), or a substantive follow-up
   * waiting for a plan. Rendered so the model always sees the latest ask.
   */
  directive?: string;
  /**
   * A substantive follow-up that arrived when no work was open. It becomes
   * the goal the moment the model writes a fresh plan against it, and not
   * before — see beginTurn for why the message alone cannot decide.
   */
  pendingGoal?: string;
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
  /** The run's own audit trail, newest last, capped. */
  log?: StepLogEntry[];
  updatedAt: string;
}

const FILES_READ_CAP = 30;
const DECISIONS_CAP = 10;
const TODOS_RENDER_CAP = 20;
const REPORT_CAP = 500;
const PRIOR_GOALS_CAP = 3;
const LOG_CAP = 80;
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

export function emptyEvidence(): StepEvidence {
  return {
    reads: 0,
    writes: 0,
    runs: 0,
    checksPassed: 0,
    checksFailed: 0,
    answers: 0,
    delegations: 0,
    looks: 0,
    writesSinceCheck: 0,
  };
}

/** Total observed effects — the "did anything happen" number. */
export function evidenceWeight(ev: StepEvidence | undefined): number {
  if (!ev) return 0;
  return (
    ev.reads +
    ev.writes +
    ev.runs +
    ev.checksPassed +
    ev.checksFailed +
    ev.answers +
    ev.delegations +
    ev.looks
  );
}

function mergeEvidence(a: StepEvidence | undefined, b: StepEvidence | undefined): StepEvidence {
  const out = emptyEvidence();
  for (const src of [a, b]) {
    if (!src) continue;
    out.reads += src.reads;
    out.writes += src.writes;
    out.runs += src.runs;
    out.checksPassed += src.checksPassed;
    out.checksFailed += src.checksFailed;
    out.answers += src.answers;
    out.delegations += src.delegations;
    out.looks += src.looks;
    out.writesSinceCheck += src.writesSinceCheck ?? 0;
  }
  // The later check wins: `b` is the more recent accumulator by convention.
  out.lastCheck = b?.lastCheck ?? a?.lastCheck;
  out.startedAt = a?.startedAt ?? b?.startedAt;
  out.completedAt = b?.completedAt ?? a?.completedAt;
  return out;
}

/**
 * One short receipt for a step, from its evidence: `2 files · check ok`,
 * `3 reads`, `unproven`. Shared by the block, the mission file, and the UI so
 * a step reads the same everywhere.
 */
export function stepReceipt(item: TodoItem): string {
  if (item.unproven === "check_failed") return "unproven — last check failed";
  if (item.unproven === "no_evidence") return "unproven — nothing ran";
  const ev = item.evidence;
  if (!ev || evidenceWeight(ev) === 0) return "";
  const parts: string[] = [];
  if (ev.writes > 0) parts.push(`${ev.writes} ${ev.writes === 1 ? "write" : "writes"}`);
  if (ev.runs > 0) parts.push(`${ev.runs} ${ev.runs === 1 ? "run" : "runs"}`);
  if (ev.checksPassed > 0 || ev.checksFailed > 0) {
    parts.push(
      ev.lastCheck
        ? ev.lastCheck.passed
          ? "check ok"
          : "check failed"
        : `${ev.checksPassed}/${ev.checksPassed + ev.checksFailed} checks`,
    );
  }
  if (ev.delegations > 0) parts.push(`${ev.delegations} delegated`);
  if (ev.looks > 0) parts.push("looked");
  if (ev.answers > 0) parts.push("asked");
  if (parts.length === 0 && ev.reads > 0)
    parts.push(`${ev.reads} ${ev.reads === 1 ? "read" : "reads"}`);
  return parts.join(" · ");
}

/** Content-keyed identity for matching a resubmitted list against the last one. */
function todoKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SetTodosVerdict =
  | {
      accepted: true;
      /** Advisory lines for the tool result (demoted in_progress, dropped steps, roll). */
      notes: string[];
      /** Steps that just became completed, in list order. */
      completed: TodoItem[];
      /** True when this call rolled the goal to a pending follow-up. */
      rolledGoal: boolean;
    }
  | {
      accepted: false;
      /** Which completions were refused and why — the tool result verbatim. */
      refused: Array<{ index: number; content: string; reason: string }>;
      notes: string[];
    };

export class TaskStateStore {
  private state: TaskState = emptyState();
  /**
   * Workspace-relative path of the mission file, when the engine maintains one
   * (e.g. ".gear/mission.md"). Render-time only — never part of the snapshot,
   * so a session restored on another machine simply omits the pointer until
   * its engine sets it again.
   */
  private missionPath: string | null = null;
  /**
   * Effects observed since the last accepted todo_write, attributed to
   * whichever steps complete on the next call. In-memory on purpose: after a
   * restart the worst case is one extra refusal, never a wrong acceptance.
   */
  private pending: StepEvidence = emptyEvidence();
  /** Completion keys refused once; the second submission is accepted as unproven. */
  private refusedOnce = new Set<string>();

  setMissionPath(path: string | null): void {
    this.missionPath = path;
  }

  // ─── Task boundary ───

  /**
   * Deterministic task-boundary rule, applied to every incoming user message.
   *
   * The FIRST message is the goal. Every later message is one of:
   * - mid-task steering (open todos, or a pending handoff): the goal and plan
   *   stand, per the mid-task-steering doctrine; the message is recorded as
   *   the latest push;
   * - a pure push ("proceed") or a short INSPECTION of existing work ("show
   *   me the preview", "is it done?"): recorded as the latest push, never a
   *   goal, because such a message is only intelligible next to one;
   * - a substantive follow-up with no work open: recorded as the latest push
   *   AND as a candidate goal. It becomes THE goal — with the outgoing goal
   *   archived into `priorGoals` — the moment the model writes a fresh plan
   *   against it (setTodos), and not before.
   *
   * Why the message alone cannot decide: the rule used to be "no open todos
   * → new task", patched with push-word and inspection vocabularies. Each
   * vocabulary missed the next phrasing ("well i am unable to see the
   * preview could you show me", 57 chars, no question mark), and every miss
   * replaced a multi-hour build's spec with a casual sentence and emptied its
   * plan. Deferring the roll to the plan makes the harm asymmetric in the
   * safe direction: a follow-up that never earns a plan costs nothing, and a
   * genuine new mission rolls the goal on its first todo_write.
   *
   * The boundary ARCHIVES, never erases. The session ledger — files written
   * and read, decisions, clarifications, the last verification result —
   * records what is true of the WORKSPACE, and a new goal does not un-happen
   * any of it. Only the todo list belongs to the mission.
   *
   * Returns true when a goal or a candidate goal was recorded — false for
   * steering, inspection, and mid-task messages, which change only the push.
   */
  beginTurn(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!this.state.goal) {
      this.state.goal = trimmed.slice(0, GOAL_CAP);
      delete this.state.directive;
      delete this.state.pendingGoal;
      this.touch();
      return true;
    }
    const open = this.state.todos.some((t) => t.status !== "completed");
    this.state.directive = trimmed.slice(0, 200);
    if (open || this.state.handoff || isPureSteering(trimmed) || isInspection(trimmed)) {
      this.touch();
      return false;
    }
    this.state.pendingGoal = trimmed.slice(0, GOAL_CAP);
    this.touch();
    return true;
  }

  /**
   * A mid-run steering message (interjection). It reaches the spine so the
   * mission file and the block carry the latest ask — before this, a "no,
   * build Y instead" typed while the run streamed never left the transcript.
   */
  noteSteer(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.state.directive = trimmed.slice(0, 200);
    this.logEvent("steer", trimmed.slice(0, 160));
  }

  // ─── Evidence ───

  /**
   * Record something a tool actually did. Called from the loop's tool-result
   * chokepoint, so every effect is one the runtime observed. Attributed to
   * the step in progress (the first, if the model left several) and to the
   * pending pool that the next completion draws from.
   */
  noteEffect(kind: EffectKind, detail?: { command?: string; summary?: string }): void {
    const apply = (ev: StepEvidence): void => {
      switch (kind) {
        case "read":
          ev.reads++;
          break;
        case "write":
          ev.writes++;
          ev.writesSinceCheck = (ev.writesSinceCheck ?? 0) + 1;
          break;
        case "run":
          ev.runs++;
          break;
        case "check_pass":
          ev.checksPassed++;
          ev.writesSinceCheck = 0;
          ev.lastCheck = { passed: true, command: detail?.command, summary: detail?.summary };
          break;
        case "check_fail":
          ev.checksFailed++;
          ev.writesSinceCheck = 0;
          ev.lastCheck = { passed: false, command: detail?.command, summary: detail?.summary };
          break;
        case "answer":
          ev.answers++;
          break;
        case "delegate":
          ev.delegations++;
          break;
        case "look":
          ev.looks++;
          break;
      }
    };
    apply(this.pending);
    const active = this.state.todos.find((t) => t.status === "in_progress");
    if (active) {
      active.evidence ??= { ...emptyEvidence(), startedAt: new Date().toISOString() };
      apply(active.evidence);
    }
    this.touch();
  }

  /**
   * Pure preview of a proposed list: which steps would newly complete, and
   * whether each carries writes that no check ever covered. The loop uses
   * this to decide whether to run the fast project check BEFORE committing
   * the list — so a step that broke the build is caught at the step, not at
   * the end of a fifteen-step run.
   */
  planCompletions(items: TodoItem[]): Array<{ item: TodoItem; uncheckedWrites: boolean }> {
    const old = new Map(this.state.todos.map((t) => [todoKey(t.content), t] as const));
    const out: Array<{ item: TodoItem; uncheckedWrites: boolean }> = [];
    for (const item of items) {
      if (item.status !== "completed") continue;
      const prev = old.get(todoKey(item.content));
      if (prev?.status === "completed") continue;
      const ev =
        prev?.status === "in_progress"
          ? (prev.evidence ?? emptyEvidence())
          : mergeEvidence(prev?.evidence, this.pending);
      out.push({ item, uncheckedWrites: (ev.writesSinceCheck ?? 0) > 0 });
    }
    return out;
  }

  // ─── Mutators (all zero-token, all called from the loop's tool chokepoint) ───

  /**
   * Replace the plan. This is where "completed" earns its meaning:
   *
   * - A step moving to completed takes the evidence measured while it was in
   *   progress, plus everything observed since the last accepted list (for
   *   steps that were never marked in progress — the model often works first
   *   and reports after).
   * - Zero evidence, or a last check that FAILED, refuses the list once with
   *   a reason the model reads as the tool result. The same completion
   *   re-submitted is then accepted and marked `unproven` — the harness
   *   cannot know whether a thinking-only step needed a tool, so it never
   *   deadlocks the model; it makes the claim visible instead.
   * - Exactly one item may be in progress; extras are demoted, and the note
   *   says so.
   * - Unfinished steps that vanish from the list are noted and logged. A
   *   replan is legitimate; a silent shrink is not.
   * - A FRESH plan (nothing open survives from the old one) written while a
   *   substantive follow-up is pending rolls the goal to that follow-up.
   *
   * `enforce: false` bypasses the evidence rule for restoring known state.
   */
  setTodos(items: TodoItem[], opts: { enforce?: boolean } = {}): SetTodosVerdict {
    const enforce = opts.enforce !== false;
    const now = new Date().toISOString();
    const notes: string[] = [];

    // Normalize, exactly as before, then apply the single-in-progress rule.
    const cleaned: TodoItem[] = items
      .filter((t) => typeof t.content === "string" && t.content.trim().length > 0)
      .map((t) => ({
        content: t.content.slice(0, 300),
        status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending",
      }));
    let seenActive = false;
    let demoted = 0;
    for (const t of cleaned) {
      if (t.status !== "in_progress") continue;
      if (seenActive) {
        t.status = "pending";
        demoted++;
      }
      seenActive = true;
    }
    if (demoted > 0) {
      notes.push(
        `${demoted} extra in_progress item${demoted === 1 ? " was" : "s were"} set back to pending — exactly one step is in progress at a time.`,
      );
    }

    const oldByKey = new Map(this.state.todos.map((t) => [todoKey(t.content), t] as const));
    const newKeys = new Set(cleaned.map((t) => todoKey(t.content)));
    const oldOpen = this.state.todos.filter((t) => t.status !== "completed");

    // Carry evidence across, decide each completion.
    const refused: Array<{ index: number; content: string; reason: string }> = [];
    const completed: TodoItem[] = [];
    const next: TodoItem[] = cleaned.map((t, index) => {
      const key = todoKey(t.content);
      const prev = oldByKey.get(key);
      const item: TodoItem = { content: t.content, status: t.status };
      if (prev?.evidence) item.evidence = structuredClone(prev.evidence);
      if (prev?.unproven && t.status === "completed" && prev.status === "completed") {
        item.unproven = prev.unproven;
      }
      if (t.status === "in_progress" && prev?.status !== "in_progress") {
        item.evidence = { ...(item.evidence ?? emptyEvidence()), startedAt: now };
      }
      if (t.status === "completed" && prev?.status !== "completed") {
        // Evidence: what accrued while in progress; otherwise the pending pool.
        const ev =
          prev?.status === "in_progress"
            ? (item.evidence ?? emptyEvidence())
            : mergeEvidence(item.evidence, this.pending);
        ev.completedAt = now;
        item.evidence = ev;
        if (enforce) {
          const weight = evidenceWeight(ev);
          const failedCheck =
            !!ev.lastCheck && !ev.lastCheck.passed && (ev.writesSinceCheck ?? 0) === 0;
          if (weight === 0 || failedCheck) {
            if (this.refusedOnce.has(key)) {
              item.unproven = failedCheck ? "check_failed" : "no_evidence";
            } else {
              this.refusedOnce.add(key);
              refused.push({
                index,
                content: t.content,
                reason: failedCheck
                  ? `the last check during this step FAILED${ev.lastCheck?.command ? ` (${ev.lastCheck.command})` : ""}${ev.lastCheck?.summary ? `: ${ev.lastCheck.summary}` : ""}. Fix it and re-run the check, or re-submit to mark the step unproven.`
                  : "nothing ran while it was open — no file written, no command run, no check, no read. Do the step, or re-submit the same list to mark it unproven (the user will see it as unproven, not done).",
              });
            }
          }
        }
        completed.push(item);
      }
      return item;
    });

    if (refused.length > 0) {
      this.touch();
      return { accepted: false, refused, notes };
    }

    // Dropped unfinished steps: legitimate in a replan, never silent.
    const dropped = oldOpen.filter((t) => !newKeys.has(todoKey(t.content)));
    if (dropped.length > 0) {
      const names = dropped.map((t) => t.content.slice(0, 60)).join("; ");
      notes.push(
        `dropped ${dropped.length} unfinished step${dropped.length === 1 ? "" : "s"}: ${names}. If that was a cut, say why in your next message.`,
      );
      this.logEvent("dropped", names.slice(0, 200));
    }

    // Fresh plan? Nothing open survived from the previous list, and the new
    // one has work in it. That is a new mission when a follow-up is pending.
    const hasOpen = next.some((t) => t.status !== "completed");
    const fresh =
      hasOpen &&
      (this.state.todos.length === 0 ||
        oldOpen.length === 0 ||
        oldOpen.every((t) => !newKeys.has(todoKey(t.content))));
    let rolledGoal = false;
    if (fresh && this.state.pendingGoal) {
      this.rollGoal(this.state.pendingGoal);
      rolledGoal = true;
      notes.push("The goal is now your latest request; the previous goal is archived as lineage.");
    }

    const before = this.state.todos.length;
    this.state.todos = next;
    this.pending = emptyEvidence();

    for (const item of completed) {
      if (item.unproven) {
        this.logEvent("unproven", `${item.content.slice(0, 120)} — ${stepReceipt(item)}`);
      } else {
        const receipt = stepReceipt(item);
        this.logEvent("done", `${item.content.slice(0, 120)}${receipt ? ` — ${receipt}` : ""}`);
      }
    }
    if (before === 0 && next.length > 0) {
      this.logEvent("plan", `${next.length} step${next.length === 1 ? "" : "s"} recorded`);
    } else if (fresh && before > 0) {
      this.logEvent("replan", `${next.length} step${next.length === 1 ? "" : "s"}`);
    }
    this.touch();
    return { accepted: true, notes, completed, rolledGoal };
  }

  private rollGoal(nextGoal: string): void {
    const outgoing = this.state.goal;
    const lineage = [...(this.state.priorGoals ?? []), outgoing.slice(0, PRIOR_GOAL_CHARS)]
      .filter(Boolean)
      .slice(-PRIOR_GOALS_CAP);
    this.state.goal = nextGoal.slice(0, GOAL_CAP);
    delete this.state.pendingGoal;
    if (this.state.directive && todoKey(this.state.directive) === todoKey(nextGoal.slice(0, 200))) {
      delete this.state.directive;
    }
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
    delete this.state.handoff;
    this.refusedOnce.clear();
    this.logEvent("boundary", `new goal: ${nextGoal.slice(0, 120)}`);
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
    if (ran) {
      this.logEvent("check", `${passed ? "project checks passed" : "project checks FAILED"}`);
    }
    this.touch();
  }

  setHandoff(reason: HandoffReason): void {
    this.state.handoff = { reason, state: this.renderHandoff(), at: new Date().toISOString() };
    this.logEvent("handoff", reason);
    this.touch();
  }

  clearHandoff(): void {
    delete this.state.handoff;
    this.touch();
  }

  /** Append to the run's audit trail. Bounded; the newest entries win. */
  logEvent(kind: StepLogKind, text: string): void {
    const t = text.trim();
    if (!t) return;
    this.state.log ??= [];
    this.state.log.push({ at: new Date().toISOString(), kind, text: t.slice(0, 240) });
    if (this.state.log.length > LOG_CAP) this.state.log = this.state.log.slice(-LOG_CAP);
    this.touch();
  }

  // ─── Reads ───

  get todos(): TodoItem[] {
    return this.state.todos;
  }

  hasOpenTodos(): boolean {
    return this.state.todos.some((t) => t.status !== "completed");
  }

  /** done / total / unproven — the numbers a close line is made of. */
  todoCounts(): { done: number; total: number; unproven: number; open: number } {
    const todos = this.state.todos;
    const done = todos.filter((t) => t.status === "completed").length;
    return {
      done,
      total: todos.length,
      unproven: todos.filter((t) => t.status === "completed" && !!t.unproven).length,
      open: todos.length - done,
    };
  }

  /**
   * The latest substantive ask: the pending follow-up when one is waiting for
   * a plan, else the goal. What a read-back should be checked against, and
   * what "is this a fix?" should be judged on.
   */
  currentRequest(): string {
    return this.state.pendingGoal ?? this.state.goal;
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
      !!s.handoff ||
      !!s.pendingGoal;
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
      if (s.pendingGoal) {
        const shown = s.pendingGoal.slice(0, detail >= 1 ? 600 : 200);
        lines.push(
          `Latest request (becomes the goal when you write a fresh plan for it): ${shown}${s.pendingGoal.length > shown.length ? " …" : ""}`,
        );
      } else if (s.directive) {
        lines.push(`Latest user push: ${s.directive.slice(0, 200)}`);
      }
      if (
        detail >= 1 &&
        this.missionPath &&
        (s.goal.length > goalChars || (s.priorGoals?.length ?? 0) > 0)
      ) {
        lines.push(
          `Full brief and history: ${this.missionPath} — read it if unsure of the mission.`,
        );
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
        const c = this.todoCounts();
        lines.push(
          `Todos (${c.done}/${c.total} done${c.unproven > 0 ? `, ${c.unproven} unproven` : ""}):`,
        );
        for (const t of s.todos.slice(0, TODOS_RENDER_CAP)) {
          const mark =
            t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
          const tag = t.unproven
            ? t.unproven === "check_failed"
              ? " (unproven — last check failed)"
              : " (unproven — nothing ran)"
            : "";
          lines.push(`  ${mark} ${t.content}${tag}`);
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
      lines.push(
        "Keep this list accurate with todo_write. If the plan changed, rewrite it. A step is completed only by evidence — something must have run while it was open.",
      );
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
      for (const t of done.slice(0, 10)) {
        lines.push(`  ✓ ${t.content}${t.unproven ? " (unproven)" : ""}`);
      }
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
   * process itself — and the model can simply read it when unsure. The Log
   * section is the run's audit trail: what moved each step, what was refused,
   * what was dropped, where a boundary was crossed.
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
    if (s.pendingGoal) {
      lines.push("", "## Latest request (pending a plan)", "", s.pendingGoal);
    } else if (s.directive) {
      lines.push("", "## Latest user push", "", s.directive);
    }
    if (s.priorGoals && s.priorGoals.length > 0) {
      lines.push("", "## Earlier goals this session (oldest first)");
      s.priorGoals.forEach((g, i) => {
        lines.push("", `### ${i + 1}.`, "", g);
      });
    }
    if (s.todos.length > 0) {
      const c = this.todoCounts();
      lines.push(
        "",
        `## Plan (${c.done}/${c.total} done${c.unproven > 0 ? `, ${c.unproven} unproven` : ""})`,
      );
      for (const t of s.todos.slice(0, MISSION_TODOS_CAP)) {
        const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        const receipt = stepReceipt(t);
        lines.push(`- ${mark} ${t.content}${receipt ? ` — ${receipt}` : ""}`);
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
    if (s.log && s.log.length > 0) {
      lines.push("", "## Log");
      for (const e of s.log) {
        const hhmm = e.at.slice(11, 16);
        lines.push(`- ${hhmm} ${e.kind}: ${e.text}`);
      }
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
