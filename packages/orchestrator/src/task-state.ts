import type { VisualReviewState } from "./visual-verification";
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

import type { SessionEvent } from "@rune/shared";
import { countTokens } from "./tokenizer";
import { missingStepEvidence, stepShape } from "./step-evidence";

// The plan-ledger wire shapes live in `@rune/protocol`: `todo_updated` and
// `handoff` carry them to every surface, so the union and its evidence counts
// are defined once and re-exported here for the ~40 in-repo import sites.
export type {
  TodoStatus,
  StepEvidence,
  TodoItem,
  HandoffReason,
  CheckRecord,
  TaskKind,
  EvidenceRef,
  Hypothesis,
  HypothesisStatus,
  TaskDecision,
  TaskArtifact,
  ArtifactKind,
  PendingDecision,
  PendingDecisionKind,
} from "@rune/protocol";
import type {
  ArtifactKind,
  CheckRecord,
  EvidenceRef,
  HandoffReason,
  Hypothesis,
  HypothesisStatus,
  PendingDecision,
  PendingDecisionKind,
  StepEvidence,
  TaskArtifact,
  TaskDecision,
  TaskKind,
  TodoItem,
  TodoStatus,
} from "@rune/protocol";

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
  visualReview?: VisualReviewState;
  verification: {
    status: "none" | "passed" | "failed" | "unavailable";
    attempts: number;
    lastReport?: string;
  };
  /** Set when a run ended without finishing; cleared once resumed work folds it in. */
  handoff?: { reason: HandoffReason; state: string; at: string };
  /** The run's own audit trail, newest last, capped. */
  log?: StepLogEntry[];
  /**
   * Every verification-shaped command this task ran, newest last, capped.
   *
   * The log line said "step check passed" and the receipt said "check ok";
   * neither said WHICH command, what it exited with, or how long it took, so
   * `rune audit` could report that a step was checked without being able to
   * say what checked it. `exitCode` and `durationMs` are present for checks
   * the harness ran and absent for checks the model ran through `bash` —
   * absent means no data, never zero.
   */
  checks?: CheckRecord[];
  // ─── The narrative (P11.1) ───
  //
  // Everything above says what the task IS and what was done. This says how
  // the run got there: what it suspected, what settled each suspicion, what it
  // committed to, what it produced, and what is waiting on a person. A run
  // that tried three things and reports only the one that worked has hidden
  // the part a reader needs in order to trust the answer.
  /**
   * What shape of work this is. Set once per task by the Intent Interpreter
   * and revisable once by the model; cleared when the goal rolls, because the
   * next task is a different task.
   */
  kind?: TaskKind;
  /** True once the model has used its single revision of `kind`. */
  kindRevised?: boolean;
  /** Hypotheses in the order they were raised, and the decisions they led to. */
  narrative?: {
    hypotheses: Hypothesis[];
    decisions: TaskDecision[];
  };
  /** What the run produced: files, diffs, reports, previews. */
  artifacts?: TaskArtifact[];
  /** Held steps, questions, approvals and reviews, as one list. */
  pendingDecisions?: PendingDecision[];
  /**
   * Steps closed on evidence over steps. DERIVED on every touch, never
   * written by a caller and never guessed — absent when there is no plan,
   * because a task with no steps has no progress, and 0% would be a claim.
   */
  progress?: number;
  updatedAt: string;
}

const FILES_READ_CAP = 30;
const DECISIONS_CAP = 10;
const TODOS_RENDER_CAP = 20;
const REPORT_CAP = 500;
const PRIOR_GOALS_CAP = 3;
const LOG_CAP = 80;
/** Checks kept on the spine. Bounded like the log — this is a record, not a stream. */
const CHECKS_CAP = 60;
/** Files remembered for the step check's project scoping. */
const PENDING_WRITES_CAP = 100;
// The narrative is a record, not a stream: every list on it is bounded, and
// the oldest entries fall off first — except hypotheses, where a refuted
// branch is exactly what the reader wants and the cap is set where a real
// investigation fits.
const HYPOTHESES_CAP = 40;
const TASK_DECISIONS_CAP = 20;
const ARTIFACTS_CAP = 200;
const PENDING_DECISIONS_CAP = 50;
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
    // A later check covers earlier edits. Adding both accumulators made a
    // repaired step stay unproven forever after its passing re-check.
    if (src.lastCheck) out.writesSinceCheck = src.writesSinceCheck ?? 0;
    else out.writesSinceCheck += src.writesSinceCheck ?? 0;
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
/**
 * What may follow "the user" for the phrase to be communication rather than
 * the start of a noun phrase: the end of the step, punctuation, or a
 * connective. "the user table", "the user's orders" and "the user interface"
 * are objects of ordinary work, and a first version of this rule let all
 * three close without evidence — which is precisely the freedom a weak model
 * must not have.
 */
const USER_TAIL =
  "(?=\\s*(?:$|[,.;:!?)\\]]|\\s+(?:that|what|which|how|where|why|when|whether|about|of|to|on|with|in|the|a|an|this|these|those|their|its|it|them|there|here|before|after|so|and|but|if|once|exactly|plainly|clearly|from|through|via|for|now|then|again|directly|first|last|only)\\b))";

/** Nouns that turn "final report" into a thing to build rather than to give. */
const BUILT_THING =
  "(?!\\s+(?:generator|module|builder|template|page|component|endpoint|table|function|class|file|view|screen|schema|type|model|pipeline|job|task|step|script|service|feature|section|format|export|renderer|writer|parser|api)\\b)";

/** A hand-off addressed to another worker is delegation, not the handoff to the user. */
const NOT_TO_A_PEER =
  "(?![^.\\n]*\\bto\\s+(?:the\\s+|a\\s+|an\\s+)?(?:teams?|workers?|sub-?agents?|agents?|backend|frontend|reviewers?|lead|builder|designer|engineer)\\b)";

/**
 * A step whose content is the communication itself: handing back, reporting,
 * telling the user something. Deliberately narrow — the verb must address the
 * user as a whole phrase, or the step must be the final report — so "write
 * the report generator", "show the user's orders" and "update the user table"
 * stay ordinary work that needs evidence. The one shape that must match is the
 * one that was refused five times in a single run: "Hand the user the one
 * command…".
 */
export const REPORT_STEP_RE = new RegExp(
  "\\b(?:" +
    `(?:hand(?:\\s|-)?(?:back|off|over)|handoff)\\b${NOT_TO_A_PEER}` +
    `|hand\\s+the\\s+user${USER_TAIL}` +
    `|(?:tell|show|inform|update|brief|walk|remind|notify)\\s+the\\s+user${USER_TAIL}` +
    `|(?:report|reply|respond|explain|summari[sz]e|present|describe)\\s+(?:[\\w'’-]+\\s+){0,4}(?:back\\s+)?to\\s+the\\s+user${USER_TAIL}` +
    `|final\\s+(?:report|summary|message|write-?up|handoff|answer)\\b${BUILT_THING}` +
    `|write-?up\\s+(?:for|to)\\s+the\\s+user${USER_TAIL}` +
    ")",
  "i",
);

export function isReportStep(content: string): boolean {
  return REPORT_STEP_RE.test(content);
}

export function stepReceipt(item: TodoItem): string {
  if (item.unproven === "check_failed") return "unproven — last check failed";
  if (item.unproven && item.unprovenReason) return `unproven — ${item.unprovenReason}`;
  if (item.unproven === "no_evidence") return "unproven — nothing ran";
  if (item.closedBy === "report") return "closed by report";
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
      refused: Array<{
        index: number;
        content: string;
        reason: string;
        /**
         * Which rule refused it. Callers must branch on THIS, never on the
         * wording of `reason`: the no-evidence sentence lists "no check" among
         * the things that did not happen, so a `/check/` test over the prose
         * reads a no-evidence refusal as a failed check.
         */
        kind: "no_evidence" | "check_failed";
      }>;
      notes: string[];
    };

export class TaskStateStore {
  private state: TaskState = emptyState();
  /**
   * Workspace-relative path of the mission file, when the engine maintains one
   * (e.g. ".rune/mission.md"). Render-time only — never part of the snapshot,
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
  /**
   * Files written since the last accepted todo_write — the step's own edits.
   * The step check reads them to pick WHICH project to compile in a workspace
   * that holds several; checking all four services because one changed is a
   * minute the step did not have. Same lifetime as `pending`, same reason.
   */
  private pendingWrites: string[] = [];
  /** Completion keys refused once (refuse mode only); the second submission is accepted as unproven. */
  private refusedOnce = new Set<string>();
  /** Steps already asked for a kind — the ask is made once per step, not on every plan write. */
  private kindAsked = new Set<string>();
  /**
   * What a completion with nothing behind it gets. `attest` (the default)
   * accepts it, marks the step unproven, and says so in one line of fact;
   * `refuse` sends the list back once. See `[reliability] evidenceGate`.
   */
  private gate: "attest" | "refuse" = "attest";

  setEvidenceGate(mode: "attest" | "refuse"): void {
    this.gate = mode;
  }
  /**
   * Id counters for the narrative. Restored from the snapshot rather than kept
   * only in memory: a resumed session that started again at `h1` would give
   * two different hypotheses the same id, and every later update would land on
   * the wrong one.
   */
  private hypothesisSeq = 0;
  private decisionSeq = 0;

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
  noteEffect(
    kind: EffectKind,
    detail?: {
      command?: string;
      summary?: string;
      /** The exit code the runtime read — harness-run checks only. */
      exitCode?: number;
      durationMs?: number;
      /** Who ran it. Defaults to the model (the `bash` chokepoint). */
      source?: "harness" | "model";
    },
  ): void {
    const check = (passed: boolean): StepEvidence["lastCheck"] => ({
      passed,
      command: detail?.command,
      summary: detail?.summary,
      ...(detail?.exitCode != null ? { exitCode: detail.exitCode } : {}),
      ...(detail?.durationMs != null ? { durationMs: detail.durationMs } : {}),
    });
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
          ev.lastCheck = check(true);
          break;
        case "check_fail":
          ev.checksFailed++;
          ev.writesSinceCheck = 0;
          ev.lastCheck = check(false);
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
    // The check ledger: WHICH command, its exit code, how long. Kept beside the
    // counters because a count of checks cannot answer "checked with what?".
    if (kind === "check_pass" || kind === "check_fail") {
      this.state.checks ??= [];
      this.state.checks.push({
        at: new Date().toISOString(),
        command: (detail?.command ?? "project check").slice(0, 200),
        passed: kind === "check_pass",
        source: detail?.source ?? "model",
        ...(detail?.exitCode != null ? { exitCode: detail.exitCode } : {}),
        ...(detail?.durationMs != null ? { durationMs: detail.durationMs } : {}),
        ...(detail?.summary ? { summary: detail.summary.slice(0, 200) } : {}),
      });
      if (this.state.checks.length > CHECKS_CAP) {
        this.state.checks = this.state.checks.slice(-CHECKS_CAP);
      }
    }
    this.touch();
  }

  /** Every check this task ran, oldest first. Read by `rune audit`. */
  get checks(): CheckRecord[] {
    return this.state.checks ?? [];
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
      if (prev?.status === "completed") {
        // An unproven step re-submitted after a fix landed is closing AGAIN
        // as far as the check is concerned: the writes since the failing
        // check are exactly what needs compiling before the mark can clear.
        if (prev.unproven && (this.pending.writesSinceCheck ?? 0) > 0) {
          out.push({ item, uncheckedWrites: true });
        }
        continue;
      }
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
   * - Zero evidence, or a last check that FAILED, closes the step as
   *   `unproven` and says so in ONE line of fact — never an instruction to
   *   re-run or re-submit, which weaker models echoed on screen for whole
   *   turns. The harness cannot know whether a thinking-only step needed a
   *   tool, so it never argues; it makes the claim visible instead. (In
   *   `refuse` mode the list comes back once, as one line, and the
   *   re-submission is accepted as unproven.) An unproven step re-submitted
   *   after real work landed is re-judged on that work, so a fix clears the
   *   mark without the step being re-opened.
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
        ...(["inspect", "change", "verify"].includes(t.kind ?? "") ? { kind: t.kind } : {}),
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
    const refused: Array<{
      index: number;
      content: string;
      reason: string;
      kind: "no_evidence" | "check_failed";
    }> = [];
    const completed: TodoItem[] = [];
    const next: TodoItem[] = cleaned.map((t, index) => {
      const key = todoKey(t.content);
      const prev = oldByKey.get(key);
      const item: TodoItem = {
        content: t.content,
        status: t.status,
        ...(t.kind || prev?.kind ? { kind: t.kind ?? prev?.kind } : {}),
      };
      if (prev?.evidence) item.evidence = structuredClone(prev.evidence);
      if (prev?.unproven && t.status === "completed" && prev.status === "completed") {
        // Re-judged on what landed since: evidence clears the mark, so a fix
        // counts without the model re-opening the step. With nothing new
        // behind it, the mark stands.
        const since = mergeEvidence(prev.evidence, this.pending);
        item.evidence = { ...since, completedAt: now };
        const stillFailing =
          !!since.lastCheck && !since.lastCheck.passed && (since.writesSinceCheck ?? 0) === 0;
        if (
          enforce &&
          evidenceWeight(this.pending) > 0 &&
          !stillFailing &&
          !missingStepEvidence(item, since)
        ) {
          item.evidence = { ...since, completedAt: now };
          completed.push(item);
        } else {
          item.unproven = prev.unproven;
          item.unprovenReason = missingStepEvidence(item, since) ?? prev.unprovenReason;
        }
      }
      // The report mark rides the same way, or the very next plan write would
      // turn "closed by report" back into a bare tick with no receipt.
      if (prev?.closedBy && t.status === "completed" && prev.status === "completed") {
        item.closedBy = prev.closedBy;
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
          const missing = missingStepEvidence(item, ev);
          const failedCheck =
            !!ev.lastCheck && !ev.lastCheck.passed && (ev.writesSinceCheck ?? 0) === 0;
          if (weight === 0 && !failedCheck && isReportStep(t.content)) {
            // Communication is the step. No tool can attest "told the user";
            // the model's report does, and refusing it made runs spend a
            // completion inventing a command to back the handoff.
            item.closedBy = "report";
            notes.push(
              `Step ${index + 1} closes with your report to the user — it needs no tool evidence.`,
            );
          } else if (missing || failedCheck) {
            const kind = failedCheck ? "check_failed" : "no_evidence";
            // One line of fact, and no verb aimed at the model. The old
            // wording ("Fix it and re-run the check, or re-submit to mark the
            // step unproven") was answered by narrating exactly that on
            // screen, seven messages in a row.
            const fact = failedCheck
              ? `its last check failed${ev.lastCheck?.command ? ` (${ev.lastCheck.command}${ev.lastCheck.summary ? `: ${ev.lastCheck.summary}` : ""})` : ""}`
              : (missing ?? "nothing ran while it was open");
            if (this.gate === "refuse" && !this.refusedOnce.has(key)) {
              this.refusedOnce.add(key);
              refused.push({ index, content: t.content, kind, reason: `${fact}.` });
            } else {
              item.unproven = kind;
              item.unprovenReason = fact;
              notes.push(`Step ${index + 1} closed unproven: ${fact}.`);
            }
          }
        }
        completed.push(item);
      }
      return item;
    });

    // A step whose wording names no action the ledger recognises will close
    // on "something ran" — exactly the freedom the evidence gate exists to
    // remove. The `kind` field is the structural answer; ask for it once per
    // step, as a note, never as a refusal. Completed steps are judged on
    // their evidence already, and a report step needs none.
    const unshaped = next
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          item.status !== "completed" &&
          !item.kind &&
          !isReportStep(item.content) &&
          !stepShape(item).recognised &&
          !this.kindAsked.has(todoKey(item.content)),
      );
    if (unshaped.length > 0) {
      for (const { item } of unshaped) this.kindAsked.add(todoKey(item.content));
      const one = unshaped.length === 1;
      notes.push(
        `Step${one ? "" : "s"} ${unshaped.map((u) => u.index + 1).join(", ")} name${one ? "s" : ""} no recognisable action; ` +
          `set kind (inspect | change | verify) on ${one ? "it" : "them"} so ${one ? "its" : "their"} evidence can be checked — ` +
          "without a kind, a completion needs only that something ran.",
      );
    }

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
    this.pendingWrites = [];

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
    // The narrative belongs to the MISSION, not to the workspace: a new goal
    // is a new investigation, and carrying the old one's refuted branches into
    // it would put someone else's dead ends in this task's record. The file
    // and check ledgers stay, because they are true of the tree.
    delete this.state.kind;
    delete this.state.kindRevised;
    delete this.state.narrative;
    delete this.state.progress;
    delete this.state.visualReview;
    this.hypothesisSeq = 0;
    this.decisionSeq = 0;
    this.refusedOnce.clear();
    this.kindAsked.clear();
    this.logEvent("boundary", `new goal: ${nextGoal.slice(0, 120)}`);
  }

  // ─── The narrative ───

  /**
   * What shape of work this task is.
   *
   * `harness` is the Intent Interpreter's reading at task start and may be
   * written only once per task; `model` is the single revision the model gets,
   * which is why the flag is on the snapshot rather than in memory — a resumed
   * session must not hand out a second one. Returns true when the kind moved,
   * so the caller knows whether to emit the event.
   */
  setKind(kind: TaskKind, source: "harness" | "model" = "harness"): boolean {
    if (source === "harness") {
      if (this.state.kind) return false;
      this.state.kind = kind;
      this.touch();
      return true;
    }
    if (this.state.kindRevised) return false;
    this.state.kindRevised = true;
    if (this.state.kind === kind) {
      this.touch();
      return false;
    }
    this.state.kind = kind;
    this.logEvent("plan", `task kind: ${kind}`);
    this.touch();
    return true;
  }

  get kind(): TaskKind | undefined {
    return this.state.kind;
  }

  private narrative(): { hypotheses: Hypothesis[]; decisions: TaskDecision[] } {
    this.state.narrative ??= { hypotheses: [], decisions: [] };
    return this.state.narrative;
  }

  /**
   * Raise a hypothesis: the suspicion, named BEFORE it is tested.
   *
   * The order matters more than it looks. A hypothesis recorded after its own
   * refutation is a story told backwards, and one recorded only when it turns
   * out to be right is not a record of an investigation at all — it is a
   * record of the answer. So this is a `proposed`/`testing` write, and only
   * the harness's reading of a check moves it to a verdict.
   */
  noteHypothesis(
    text: string,
    opts: { status?: HypothesisStatus; step?: string } = {},
  ): Hypothesis {
    const n = this.narrative();
    const hypothesis: Hypothesis = {
      id: `h${++this.hypothesisSeq}`,
      text: text.trim().slice(0, 400),
      status: opts.status ?? "testing",
      evidence: [],
      at: new Date().toISOString(),
      ...(opts.step ? { step: opts.step.slice(0, 200) } : {}),
    };
    n.hypotheses.push(hypothesis);
    if (n.hypotheses.length > HYPOTHESES_CAP) {
      n.hypotheses = n.hypotheses.slice(-HYPOTHESES_CAP);
    }
    this.touch();
    return hypothesis;
  }

  /**
   * Move a hypothesis to a verdict. Returns the updated hypothesis, or null
   * when the id is unknown — a caller reports that rather than inventing one.
   */
  updateHypothesis(
    id: string,
    status: HypothesisStatus,
    opts: { reason?: string; evidence?: EvidenceRef[] } = {},
  ): Hypothesis | null {
    const hypothesis = this.narrative().hypotheses.find((h) => h.id === id);
    if (!hypothesis) return null;
    hypothesis.status = status;
    hypothesis.at = new Date().toISOString();
    if (opts.reason) hypothesis.reason = opts.reason.slice(0, 300);
    if (opts.evidence && opts.evidence.length > 0) {
      hypothesis.evidence = [...hypothesis.evidence, ...opts.evidence].slice(-8);
    }
    if (status === "refuted" || status === "confirmed") {
      this.logEvent(
        "check",
        `hypothesis ${id} ${status}: ${hypothesis.text.slice(0, 80)}${hypothesis.reason ? ` — ${hypothesis.reason.slice(0, 80)}` : ""}`,
      );
    }
    this.touch();
    return hypothesis;
  }

  /** The hypothesis a verdict should land on: the one still being tested. */
  openHypothesis(): Hypothesis | null {
    const open = this.narrative().hypotheses.filter(
      (h) => h.status === "testing" || h.status === "proposed",
    );
    return open.length > 0 ? open[open.length - 1] : null;
  }

  get hypotheses(): Hypothesis[] {
    return this.state.narrative?.hypotheses ?? [];
  }

  /**
   * Record what the run committed to, and what justified it.
   *
   * This is the recorder the `decisions` field never had. The field existed
   * from the first version of the spine and nothing in production wrote it:
   * `addDecision` had exactly one caller, a test. So a decision now lands in
   * two places at once — the structured list the record reads, and the one-line
   * list the injected block and the mission file already render — because a
   * decision the model cannot see after compaction is a decision it will make
   * again differently.
   */
  recordDecision(text: string, basedOn: EvidenceRef[] = []): TaskDecision {
    const n = this.narrative();
    const decision: TaskDecision = {
      id: `d${++this.decisionSeq}`,
      text: text.trim().slice(0, 400),
      basedOn: basedOn.slice(0, 8),
      at: new Date().toISOString(),
    };
    n.decisions.push(decision);
    if (n.decisions.length > TASK_DECISIONS_CAP) {
      n.decisions = n.decisions.slice(-TASK_DECISIONS_CAP);
    }
    this.addDecision(decision.text);
    this.touch();
    return decision;
  }

  get decisionsRecorded(): TaskDecision[] {
    return this.state.narrative?.decisions ?? [];
  }

  /**
   * Record something the run produced. Deduplicated on (kind, ref): a file
   * edited nine times is one artifact, not nine.
   */
  setVisualReview(review: VisualReviewState): void {
    this.state.visualReview = structuredClone(review);
    this.touch();
  }

  recordArtifact(kind: ArtifactKind, ref: string): TaskArtifact | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    this.state.artifacts ??= [];
    const existing = this.state.artifacts.find((a) => a.kind === kind && a.ref === trimmed);
    if (existing) return null;
    const artifact: TaskArtifact = {
      id: `a${this.state.artifacts.length + 1}`,
      kind,
      ref: trimmed.slice(0, 400),
      at: new Date().toISOString(),
    };
    this.state.artifacts.push(artifact);
    if (this.state.artifacts.length > ARTIFACTS_CAP) {
      this.state.artifacts = this.state.artifacts.slice(-ARTIFACTS_CAP);
    }
    this.touch();
    return artifact;
  }

  get artifacts(): TaskArtifact[] {
    return this.state.artifacts ?? [];
  }

  /**
   * Record a decision waiting on a person — one list for all four round-trips,
   * because the inbox that reads it is one list. Re-recording the same id
   * updates it rather than duplicating it, so a retried round-trip does not
   * appear twice in the inbox.
   */
  addPendingDecision(entry: {
    id: string;
    kind: PendingDecisionKind;
    summary: string;
    deadline?: string;
  }): PendingDecision {
    this.state.pendingDecisions ??= [];
    const decision: PendingDecision = {
      id: entry.id,
      kind: entry.kind,
      summary: entry.summary.slice(0, 300),
      createdAt: new Date().toISOString(),
      ...(entry.deadline ? { deadline: entry.deadline } : {}),
    };
    const at = this.state.pendingDecisions.findIndex((p) => p.id === entry.id);
    if (at >= 0) this.state.pendingDecisions[at] = decision;
    else this.state.pendingDecisions.push(decision);
    if (this.state.pendingDecisions.length > PENDING_DECISIONS_CAP) {
      this.state.pendingDecisions = this.state.pendingDecisions.slice(-PENDING_DECISIONS_CAP);
    }
    this.touch();
    return decision;
  }

  /** Close one. Returns false for an id nobody is holding. */
  resolvePendingDecision(id: string, outcome: string): boolean {
    const entry = this.state.pendingDecisions?.find((p) => p.id === id);
    if (!entry || entry.resolution) return false;
    entry.resolution = { at: new Date().toISOString(), outcome: outcome.slice(0, 200) };
    this.touch();
    return true;
  }

  /** Everything recorded, resolved or not. */
  get pendingDecisions(): PendingDecision[] {
    return this.state.pendingDecisions ?? [];
  }

  /** What is still waiting on a person — what the inbox shows. */
  openDecisions(): PendingDecision[] {
    return this.pendingDecisions.filter((p) => !p.resolution);
  }

  /**
   * Steps closed on evidence over steps.
   *
   * Derived, never asserted: the numerator counts completed steps that carry
   * measured evidence and are not marked unproven, which is the same bar the
   * plan ledger already holds a completion to. A step the model closed with
   * nothing behind it does not move this number, so a run cannot report
   * progress by claiming it.
   */
  progress(): number | undefined {
    const todos = this.state.todos;
    if (todos.length === 0) return undefined;
    const proven = todos.filter(
      (t) =>
        t.status === "completed" &&
        !t.unproven &&
        evidenceWeight(t.evidence) > 0 &&
        !missingStepEvidence(t, t.evidence),
    ).length;
    const review = this.state.visualReview;
    return (proven + (review?.status === "reviewed" ? 1 : 0)) / (todos.length + (review ? 1 : 0));
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
    // A written file is an artifact of the task, not only an entry in a
    // ledger: "what changed" in the record reads this list.
    this.recordArtifact("file", path);
    if (!this.state.filesWritten.includes(path)) this.state.filesWritten.push(path);
    if (!this.pendingWrites.includes(path)) this.pendingWrites.push(path);
    if (this.pendingWrites.length > PENDING_WRITES_CAP) {
      this.pendingWrites = this.pendingWrites.slice(-PENDING_WRITES_CAP);
    }
    this.touch();
  }

  /**
   * Files written since the last accepted plan — what the step being closed
   * actually touched. Used to scope the step check to one project.
   */
  get touchedFiles(): string[] {
    return [...this.pendingWrites];
  }

  /**
   * Every file this task has written, cumulative.
   *
   * `touchedFiles` is drained on each accepted plan, which makes it right for a
   * STEP check and wrong for the end-of-turn one: by the time a turn finishes,
   * the step accumulator is usually empty and the verifier would fall back to
   * grading the entire workspace. This list is what the run actually built.
   */
  get writtenFiles(): string[] {
    return [...this.state.filesWritten];
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

  noteVerification(
    ran: boolean,
    passed: boolean,
    report?: string,
    /** Per-command records from the verifier, when it produced them. */
    runs?: Array<{
      command: string;
      passed: boolean;
      exitCode: number | null;
      durationMs: number;
      skipped?: string;
    }>,
  ): void {
    this.state.verification = {
      status: !ran ? "unavailable" : passed ? "passed" : "failed",
      attempts: this.state.verification.attempts + (ran ? 1 : 0),
      lastReport: report?.slice(0, REPORT_CAP),
    };
    if (ran) {
      for (const r of runs ?? []) {
        if (r.skipped) continue; // a command that never ran is not evidence
        this.state.checks ??= [];
        this.state.checks.push({
          at: new Date().toISOString(),
          command: r.command.slice(0, 200),
          passed: r.passed,
          source: "harness",
          ...(r.exitCode != null ? { exitCode: r.exitCode } : {}),
          durationMs: r.durationMs,
        });
      }
      if (this.state.checks && this.state.checks.length > CHECKS_CAP) {
        this.state.checks = this.state.checks.slice(-CHECKS_CAP);
      }
      const named = (runs ?? []).filter((r) => !r.skipped).map((r) => r.command);
      const skipped = (runs ?? []).filter((r) => r.skipped).length;
      this.logEvent(
        "check",
        `${passed ? "project checks passed" : "project checks FAILED"}` +
          (named.length > 0 ? ` — ${named.join(", ")}` : "") +
          (skipped > 0 ? ` (${skipped} skipped, toolchain absent)` : ""),
      );
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

  /**
   * Claim the next unowned pending step for `owner`, and return it.
   *
   * This is what makes the ledger a queue rather than a list. The alternative —
   * every worker reading the plan and picking what looks unclaimed — is a race
   * with no arbiter, and two workers building the same slice is the specific
   * failure the ownership model exists to prevent one layer down.
   *
   * In-process the claim is atomic because the engine's turns are serial; the
   * cross-instance version lives on the team bus, which has a real transaction
   * and the same TTL sweep as `claims`.
   */
  claimNext(owner: string, opts: { reclaimAfterMs?: number } = {}): TodoItem | null {
    const state = this.state;
    const now = Date.now();
    const reclaimAfter = opts.reclaimAfterMs ?? 15 * 60_000;
    const candidate =
      state.todos.find((t) => t.status === "pending" && !t.owner) ??
      // A step whose owner has gone quiet for long enough is reclaimable.
      // Without this a crashed worker strands its step forever, and the fleet
      // deadlocks on an item nobody is doing and nobody may take.
      state.todos.find(
        (t) =>
          t.status === "in_progress" &&
          t.owner &&
          t.owner !== owner &&
          t.claimedAt !== undefined &&
          now - Date.parse(t.claimedAt) > reclaimAfter,
      );
    if (!candidate) return null;
    candidate.owner = owner;
    candidate.claimedAt = new Date().toISOString();
    candidate.status = "in_progress";
    this.logEvent("plan", `${owner} claimed: ${candidate.content.slice(0, 80)}`);
    this.touch();
    return candidate;
  }

  /** Release a step back to the queue — a worker that could not finish it. */
  releaseClaim(owner: string): number {
    const state = this.state;
    let released = 0;
    for (const todo of state.todos) {
      if (todo.owner === owner && todo.status !== "completed") {
        delete todo.owner;
        delete todo.claimedAt;
        todo.status = "pending";
        released++;
      }
    }
    if (released > 0) this.touch();
    return released;
  }

  /** Every step a given owner holds. The scoped view a sub-agent is given. */
  claimsOf(owner: string): TodoItem[] {
    return this.state.todos.filter((t) => t.owner === owner);
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
      !!s.pendingGoal ||
      (s.narrative?.hypotheses.length ?? 0) > 0;
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
        // Stated as fact, not as an instruction: "continue from the next
        // unfinished step" was echoed verbatim by weaker models as "Continuing
        // from the next unfinished step" at the top of every message. The
        // unfinished steps are already listed below; the model does not need to
        // be told to work them, and being told invites it to narrate that it is.
        lines.push(
          `Resumed after: ${s.handoff.reason}. Unfinished steps remain in the list below.`,
        );
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
      // The narrative, as briefly as it can be said. This is the model's own
      // memory of what it has already ruled out: without it, a run that
      // compacts mid-investigation re-tests a branch it refuted an hour ago,
      // which is the specific waste the record exists to make visible.
      if (detail >= 2 && (s.narrative?.hypotheses.length ?? 0) > 0) {
        const shown = s.narrative!.hypotheses.slice(-6);
        lines.push("Hypotheses:");
        for (const h of shown) {
          lines.push(
            `  ${h.id} [${h.status}] ${h.text.slice(0, 100)}${h.reason ? ` — ${h.reason.slice(0, 60)}` : ""}`,
          );
        }
      }
      if (detail >= 2 && s.decisions.length > 0) {
        lines.push(`Decisions: ${s.decisions.join(" | ")}`);
      }
      if (detail >= 3 && this.openDecisions().length > 0) {
        lines.push(
          `Waiting on the user: ${this.openDecisions()
            .map((p) => `${p.kind} — ${p.summary.slice(0, 60)}`)
            .join(" | ")}`,
        );
      }
      if (s.visualReview)
        lines.push(
          `UI review: ${s.visualReview.status}${s.visualReview.missing.length ? ` — ${s.visualReview.missing.join("; ")}` : " (screenshots, responsive viewports, interaction observed)"}`,
        );
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
      // State is data. Every imperative this block ever carried came back as
      // the opening of the model's next message ("Act on the next open step"
      // became "Picking up the open step" at the top of 19 of 25 messages in
      // one run), so the tail states how the list works and the one thing
      // the model must not do with it — and issues no instruction it could
      // repeat back.
      lines.push(
        "Kept current by todo_write. A step closes on evidence — something ran while it was open — or, for a step that is itself the report to the user, on that report.",
        "This block is harness state, not a message to answer: never acknowledge, restate, or narrate it, and never open a message by naming which step you are on.",
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
      "> Maintained by Rune. This is the durable record of the current task —",
      "> read it when unsure what the mission is. Do not edit by hand:",
      "> todo_write and the run itself keep it current.",
      "",
      "## Goal (verbatim)",
      "",
      s.goal || "(none yet)",
    ];
    if (s.kind) lines.push("", `_Task kind: ${s.kind}_`);
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
      const pct = this.progress();
      lines.push(
        "",
        `## Plan (${c.done}/${c.total} done${c.unproven > 0 ? `, ${c.unproven} unproven` : ""}` +
          (pct != null ? `, ${Math.round(pct * 100)}% closed on evidence` : "") +
          ")",
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
    // ── The narrative ──
    // Refuted branches are kept, and kept in order. A dossier that listed only
    // the hypothesis that turned out to be right would read as though the run
    // knew the answer from the start, which is both false and useless to the
    // next person (or the next run) trying to understand the problem.
    const hypotheses = s.narrative?.hypotheses ?? [];
    if (hypotheses.length > 0) {
      lines.push("", "## How we got here");
      hypotheses.forEach((h, i) => {
        lines.push(
          `${i + 1}. **${h.text}** — ${h.status}${h.reason ? `: ${h.reason}` : ""}` +
            (h.evidence.length > 0
              ? ` (${h.evidence.map((e) => `${e.kind}: ${e.ref}`).join("; ")})`
              : ""),
        );
      });
    }
    const recorded = s.narrative?.decisions ?? [];
    if (recorded.length > 0) {
      lines.push("", "## Decisions (with evidence)");
      for (const d of recorded) {
        lines.push(
          `- ${d.text}` +
            (d.basedOn.length > 0
              ? ` — based on ${d.basedOn.map((e) => `${e.kind}: ${e.ref}`).join("; ")}`
              : " — no evidence cited"),
        );
      }
    } else if (s.decisions.length > 0) {
      lines.push("", "## Decisions");
      for (const d of s.decisions) lines.push(`- ${d}`);
    }
    const open = this.openDecisions();
    if (open.length > 0) {
      lines.push("", "## Waiting on the user");
      for (const p of open) lines.push(`- [${p.kind}] ${p.summary}`);
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
    // Resume the narrative's id counters past the highest id on the snapshot,
    // so a resumed run cannot mint an `h1` that already exists.
    store.hypothesisSeq = highestSeq(store.state.narrative?.hypotheses);
    store.decisionSeq = highestSeq(store.state.narrative?.decisions);
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
    // Progress is derived here and nowhere else, so no caller can set it and
    // every snapshot carries the number the ledger actually supports.
    const progress = this.progress();
    if (progress == null) delete this.state.progress;
    else this.state.progress = progress;
  }
}

/** The numeric tail of the highest `h7` / `d3` id on a list, or 0. */
function highestSeq(entries: Array<{ id: string }> | undefined): number {
  let max = 0;
  for (const entry of entries ?? []) {
    const n = Number.parseInt(entry.id.replace(/^[a-z]+/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
