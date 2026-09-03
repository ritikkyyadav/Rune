// ─── The Task State the composer reads ───
//
// P11.1 owns the Task State Model: it adds `kind`, `narrative`, `artifacts`,
// `pendingDecisions` and `progress` to `packages/orchestrator/src/task-state.ts`
// and puts them on the wire as new `@gear/protocol` events. This file is the
// WEB's view of that shape, and it exists for exactly as long as P11.1 is a
// separate branch.
//
// Every field name below is taken verbatim from docs/program/11-intent-layer.md
// so the merge is mechanical: when P11.1 lands, this module becomes a re-export
// of the protocol types and nothing else in `compose/` moves. Two names are
// re-stated here rather than imported because importing them would pull the
// orchestrator into the browser bundle: `TodoItem` and `StepEvidence` already
// exist in `@gear/protocol/task.ts` with these exact fields.
//
// The composer treats this as READ-ONLY and never as a source of truth it can
// repair: a missing `narrative` is a task with no hypotheses, not a bug to
// paper over with an empty object at the call site.

/** The task kinds the Intent Interpreter sets. One persona each. */
export const TASK_KINDS = [
  "investigate",
  "build",
  "analyze",
  "research",
  "operate",
  "write",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A pointer at the thing that supports a claim. Mirrors P11.1's `EvidenceRef`. */
export interface EvidenceRef {
  kind: "file" | "url" | "command" | "span" | "check";
  ref: string;
  line?: number;
  endLine?: number;
  excerpt?: string;
}

export type HypothesisStatus = "proposed" | "testing" | "refuted" | "confirmed";

export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  evidence: EvidenceRef[];
  /** Required in practice for `refuted`; the primitive's schema enforces it. */
  reason?: string;
}

export interface RecordedDecision {
  id: string;
  text: string;
  basedOn: EvidenceRef[];
  at: string;
  alternatives?: string[];
}

export interface TaskArtifact {
  id: string;
  kind: "file" | "diff" | "report" | "chart" | "table" | "preview";
  ref: string;
  name?: string;
  bytes?: number;
  at?: string;
}

export interface Narrative {
  hypotheses: Hypothesis[];
  decisions: RecordedDecision[];
}

/**
 * One list unifying held steps, `ask_user` questions, approvals and reviews.
 * The inbox in P11.3 reads this; the composer renders it into Approval and
 * Choice blocks according to `kind`.
 */
export interface PendingDecision {
  id: string;
  kind: "held_step" | "question" | "approval" | "review";
  /** What is being asked, in one line. */
  text: string;
  /** For a held step: the exact grant. Never a category. */
  grant?: string;
  alwaysScope?: string;
  reason?: string;
  risk?: "low" | "medium" | "high";
  options?: Array<{ id: string; label: string; consequence?: string; recommended?: boolean }>;
  deadline?: string;
  /** Set once answered; a resolved decision folds. */
  resolution?: string | null;
}

/** A pending decision reshaped into the Approval primitive's props. */
export interface HeldApproval {
  id: string;
  action: string;
  grant: string;
  alwaysScope?: string;
  reason?: string;
  risk?: "low" | "medium" | "high";
  deadline?: string;
  outcome?: "approved" | "always" | "refused" | null;
}

/** A pending decision reshaped into the Choice primitive's props. */
export interface AskQuestion {
  id: string;
  question: string;
  options: Array<{ id: string; label: string; consequence?: string; recommended?: boolean }>;
  context?: string;
  answered?: string | null;
}

/** One row of the checks table, in the shape the Table primitive accepts. */
export interface CheckRow {
  [column: string]: string | number | null;
}

/** Steps with evidence over steps. Derived from the ledger, never guessed. */
export interface TaskProgress {
  done: number;
  total: number;
  unproven?: number;
  runState?: "working" | "waiting" | "done" | "failed";
}

export interface TaskStep {
  content: string;
  status: "pending" | "in_progress" | "completed";
  verified?: boolean;
  unproven?: "no_evidence" | "check_failed";
  owner?: string;
}

export interface TaskCheck {
  at?: string;
  command: string;
  passed: boolean;
  source: "harness" | "model";
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}

export interface TaskAgentRow {
  id: string;
  name: string;
  status: "queued" | "working" | "waiting" | "done" | "failed";
  activity?: string;
  step?: string;
  elapsedMs?: number;
  model?: string;
  usd?: number | null;
}

export interface TaskMetric {
  name: string;
  value: number | string;
  unit?: string;
  from?: number | string;
  goodDirection?: "up" | "down";
  note?: string;
}

export interface TaskEvent {
  at?: string;
  text: string;
  tone?: "neutral" | "ok" | "caution" | "danger" | "accent";
  detail?: string;
}

export interface TaskDiff {
  path: string;
  patch: string;
  from?: string;
  added?: number;
  removed?: number;
}

export interface TaskTerminal {
  command: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  cwd?: string;
}

export interface TaskSource {
  id?: string;
  title: string;
  locator: EvidenceRef;
  retrievedAt?: string;
  via?: string;
}

export interface TaskClaim {
  id?: string;
  claim: string;
  sources: EvidenceRef[];
  reading?: string;
  verified?: boolean;
}

export interface TranscriptTurn {
  role: "user" | "agent" | "tool" | "system";
  text: string;
  at?: string;
  count?: number;
}

/**
 * The shape the composer projects from.
 *
 * `objective` is the verbatim user ask (`goal` on the spine). Everything below
 * it is optional because a task three seconds old has a goal and nothing else,
 * and every persona has to compose something sane from that.
 */
export interface TaskStateView {
  taskId: string;
  objective: string;
  kind: TaskKind;
  /** investigating · building · waiting · done · failed, as the header reads it. */
  phase?: string;
  elapsedMs?: number;

  narrative?: Narrative;
  artifacts?: TaskArtifact[];
  pendingDecisions?: PendingDecision[];
  /**
   * `pendingDecisions` split by kind and reshaped into the two primitives that
   * can answer one. Both are DERIVED — `deriveView` fills them — for two
   * reasons that a state path cannot solve on its own:
   *
   *   filtering: an Approval bound at the unified list would be handed a
   *   `question` with no grant, and a Choice would be handed a held step with
   *   no options;
   *   shape: a bound row is spread straight over a block's props, so the row
   *   has to BE the primitive's prop shape. `text` is `action` on one and
   *   `question` on the other, and reconciling that in a binding language is
   *   how a projection schema turns into a template engine.
   */
  heldDecisions?: HeldApproval[];
  askDecisions?: AskQuestion[];
  progress?: TaskProgress;

  todos?: TaskStep[];
  checks?: TaskCheck[];
  /** `checks` reshaped into Table rows. Derived by `deriveView`. */
  checkRows?: CheckRow[];
  agents?: TaskAgentRow[];
  metrics?: TaskMetric[];
  events?: TaskEvent[];
  diffs?: TaskDiff[];
  terminals?: TaskTerminal[];
  sources?: TaskSource[];
  claims?: TaskClaim[];
  transcript?: TranscriptTurn[];
  logs?: string[];
  /** Prose the agent wrote: the summary, the reading, the draft. */
  prose?: string;

  /** The one series the analyze surface plots. A second one would need a second hue. */
  chartPoints?: Array<{ x: string; y: number }>;
  /** Rows for the analyze surface's table, keyed by its declared columns. */
  table?: Array<Record<string, string | number | null>>;
  comparison?: {
    options: Array<{ id: string; name: string }>;
    rows: Array<{ criterion: string; values: Record<string, string>; better?: string }>;
    recommend?: string;
    because?: string;
  };
  relationship?: {
    nodes: Array<{
      id: string;
      name: string;
      ring: number;
      focus?: boolean;
      tone?: "neutral" | "ok" | "caution" | "danger";
    }>;
    edges: Array<{ from: string; to: string; label?: string }>;
    caption?: string;
  };
  /** The write surface's outline, in the Tree primitive's flat-with-depth shape. */
  outline?: Array<{
    id: string;
    name: string;
    depth: number;
    kind?: "dir" | "file" | "symbol";
    meta?: string;
    current?: boolean;
  }>;

  cost?: {
    usd: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
    model?: string;
    budgetUsd?: number;
  };
}

/**
 * Fill the fields the composer binds that the wire does not carry.
 *
 * Three of them, all reshapings of something already on the state, and they
 * live in one named pure function so a composer never contains a `.filter`.
 * Idempotent: `deriveView(deriveView(s))` is `deriveView(s)`.
 */
export function deriveView(state: TaskStateView): TaskStateView {
  const pending = state.pendingDecisions ?? [];

  const heldDecisions: HeldApproval[] = pending
    .filter((p) => p.kind === "held_step" || p.kind === "approval")
    .map((p) => ({
      id: p.id,
      action: p.text,
      grant: p.grant ?? p.text,
      ...(p.alwaysScope ? { alwaysScope: p.alwaysScope } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.risk ? { risk: p.risk } : {}),
      ...(p.deadline ? { deadline: p.deadline } : {}),
      outcome: outcomeOf(p.resolution),
    }));

  const askDecisions: AskQuestion[] = pending
    .filter((p) => p.kind === "question" || p.kind === "review")
    .map((p) => ({
      id: p.id,
      question: p.text,
      options: p.options ?? [],
      ...(p.reason ? { context: p.reason } : {}),
      answered: p.resolution ?? null,
    }));

  const checkRows: CheckRow[] = (state.checks ?? []).map((c) => ({
    command: c.command,
    summary: c.summary ?? (c.passed ? "passed" : "failed"),
    durationMs: c.durationMs ?? null,
  }));

  return {
    ...state,
    ...(heldDecisions.length > 0 ? { heldDecisions } : {}),
    ...(askDecisions.length > 0 ? { askDecisions } : {}),
    ...(checkRows.length > 0 ? { checkRows } : {}),
  };
}

/** A resolution string mapped onto the Approval primitive's three outcomes. */
function outcomeOf(resolution: string | null | undefined): HeldApproval["outcome"] {
  if (resolution === "approved" || resolution === "always" || resolution === "refused") {
    return resolution;
  }
  return null;
}
