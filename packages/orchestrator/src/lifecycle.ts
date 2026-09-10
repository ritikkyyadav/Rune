// ─── The task lifecycle projection ───
//
// Phase 2's shared read model. `TaskLifecycle` (in @rune/protocol) is the
// contract; this module is the one place that BUILDS one, bounds it for the
// wire, and reconciles the two terminal vocabularies that used to disagree.
//
// It also owns the `filesChanged` predicate. That predicate had four
// incompatible definitions — the TUI transcript counted write/edit/multi_edit
// plus `apply_patch`, the TUI footer counted write/edit only, the engine's
// auto-commit scope counted write/edit/multi_edit plus a worker's declared
// files, and the headless envelope counted write/edit/multi_edit — so a run
// whose writes came from a worker reported `filesChanged: []` while the same
// run's commit contained them. One function, four callers.

import { execFileSync } from "node:child_process";

import type {
  CheckRecord,
  ClaimRung,
  Criterion,
  HandoffReason,
  TaskLifecycle,
  TaskLifecycleChild,
  TaskLifecycleKind,
  TaskLifecycleStatus,
  TodoItem,
} from "@rune/protocol";

// ─── What a run changed ───

/** The tools whose success means a file in the workspace now differs. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
]);

/**
 * Every workspace path a successful tool call wrote, from the call itself.
 *
 * `apply_patch` is one call over several files and reports them in its RESULT,
 * not its arguments — which is why every consumer that read only `args.path`
 * silently dropped it. `worker` declares its owned files up front and writes
 * them in a worktree the lead never sees a tool call for, so its `args.files`
 * are the only record the event stream carries.
 *
 * Callers pass whatever they have: the result is optional, and a caller with
 * no result simply gets no `apply_patch` paths rather than a wrong answer.
 */
export function filesChangedFrom(
  toolName: string | undefined,
  args: unknown,
  result?: string,
): string[] {
  const name = typeof toolName === "string" ? toolName : "";
  const a = (args ?? {}) as Record<string, unknown>;

  if (name === "apply_patch") {
    const paths: string[] = [];
    let parsed: unknown;
    try {
      parsed = result ? JSON.parse(result) : undefined;
    } catch {
      parsed = undefined;
    }
    const files = (parsed as { files?: unknown } | undefined)?.files;
    if (Array.isArray(files)) {
      for (const file of files as Array<Record<string, unknown>>) {
        const path = file?.path ?? file?.moved_to;
        if (typeof path === "string" && path) paths.push(path);
      }
    }
    // A patch the harness could not read back is still a write; fall back to
    // the declared path so the count is never lower than the truth.
    if (paths.length === 0 && typeof a.path === "string" && a.path) paths.push(a.path);
    return paths;
  }

  if (name === "worker") {
    const files = a.files;
    if (!Array.isArray(files)) return [];
    return (files as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 0);
  }

  if (!WRITE_TOOLS.has(name)) return [];
  if (typeof a.path === "string" && a.path) return [a.path];
  // write_file/edit_file echo the path in their result when the argument was
  // normalised (an absolute path rewritten workspace-relative, say).
  try {
    const echoed = result ? (JSON.parse(result) as { path?: unknown }).path : undefined;
    if (typeof echoed === "string" && echoed) return [echoed];
  } catch {
    // not JSON — no path to recover
  }
  return [];
}

/** True when this tool call, if it succeeded, changed the workspace. */
export function isFileChangingTool(toolName: string | undefined): boolean {
  return typeof toolName === "string" && (WRITE_TOOLS.has(toolName) || toolName === "worker");
}

// ─── The workspace revision ───

/**
 * The revision a run is working against, and whether the tree is dirty.
 *
 * Nothing recorded this before: `sessions.workspace_root` is a path, and the
 * only commit sha that reached disk was prose inside an opt-in auto-commit
 * marker. Without it a stored verdict has nothing to be stale AGAINST, which
 * is why "no verified status for stale evidence" had no durable anchor.
 *
 * Two short git calls, bounded and never fatal: a non-repo, a broken git, or a
 * repository with no commits all report `{ head: null, dirty: false }` rather
 * than failing a run over bookkeeping.
 */
export function workspaceRevision(root: string): { head: string | null; dirty: boolean } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const head = run(["rev-parse", "HEAD"]);
  if (head === null) return { head: null, dirty: false };
  // Untracked files count: a run that created files and never committed them
  // has changed the tree, and a criterion verified before that is not safe.
  const status = run(["status", "--porcelain", "--untracked-files=normal"]);
  return { head, dirty: status !== null && status.length > 0 };
}

// ─── Stale evidence ───

const RUNGS: readonly ClaimRung[] = ["suspected", "observed", "reproduced", "verified"];

/**
 * Demote any claim that was proven against a DIFFERENT workspace revision.
 *
 * `verified` means "this check failed on the parent commit and passes now".
 * That sentence is about a revision. After a restart — or after the run's own
 * auto-commit moved HEAD — the claim is about a tree that no longer exists,
 * and reporting it unchanged is the harness taking the model's word by proxy.
 *
 * The rule is deliberately narrow, because the alternative is demoting every
 * criterion on every resume and teaching the reader to ignore the ledger:
 *  · HEAD moved since the claim was recorded → drop one rung.
 *  · the tree was CLEAN when the claim was recorded and is dirty now → drop
 *    one rung (something was edited under a proven claim).
 *  · it was dirty then and is dirty now → nothing can be concluded either
 *    way, so nothing moves.
 * A claim recorded before revisions were tracked has no `head` and is left
 * alone; it is not evidence of staleness, only of age.
 *
 * Returns the criteria that moved, for the line the surface prints.
 */
export function demoteStaleCriteria(
  criteria: Criterion[],
  now: { head: string | null; dirty: boolean },
): Array<{ text: string; from: ClaimRung; to: ClaimRung }> {
  const moved: Array<{ text: string; from: ClaimRung; to: ClaimRung }> = [];
  for (const criterion of criteria) {
    const rung = criterion.rung;
    const evidence = criterion.evidence as
      (Criterion["evidence"] & { head?: string; dirty?: boolean }) | undefined;
    if (!rung || !evidence?.head) continue;
    const index = RUNGS.indexOf(rung);
    if (index <= 1) continue; // suspected/observed cannot go stale
    const headMoved = now.head !== null && evidence.head !== now.head;
    const wentDirty = evidence.dirty === false && now.dirty;
    if (!headMoved && !wentDirty) continue;
    const to = RUNGS[index - 1]!;
    criterion.rung = to;
    moved.push({ text: criterion.text, from: rung, to });
  }
  return moved;
}

// ─── One terminal vocabulary ───

const STATUSES: ReadonlySet<string> = new Set<TaskLifecycleStatus>([
  "running",
  "end_turn",
  "aborted",
  "halted",
  "max_turns",
  "max_tokens",
  "provider_lost",
  "open_steps",
  "stalled",
]);

/**
 * Map a `turn_complete.stopReason` onto the lifecycle vocabulary.
 *
 * The loop emits the PROVIDER's own value verbatim when it has one (`tool_use`
 * is the common case), so anything unrecognised that is not an obvious failure
 * reads as an ordinary finish rather than inventing a new terminal state.
 */
export function statusFromStopReason(stopReason: string | undefined): TaskLifecycleStatus {
  if (!stopReason) return "running";
  if (STATUSES.has(stopReason)) return stopReason as TaskLifecycleStatus;
  return "end_turn";
}

/** Map a `HandoffReason` onto the same vocabulary. Five of eight are shared. */
export function statusFromHandoffReason(reason: HandoffReason): TaskLifecycleStatus {
  switch (reason) {
    case "max_turns":
    case "aborted":
    case "halted":
    case "open_steps":
    case "stalled":
    case "provider_lost":
      return reason;
    // Neither has a `turn_complete` spelling of its own: an exhausted context
    // ends the run out of tokens, and a plain error ends it lost.
    case "context_exhausted":
      return "max_tokens";
    case "error":
      return "provider_lost";
    default:
      return "end_turn";
  }
}

/** True for every status that is not a finished task. */
export function isUnfinished(status: TaskLifecycleStatus): boolean {
  return status !== "end_turn" && status !== "running";
}

// ─── Building one, bounded ───

/**
 * Wire bounds. The event is persisted on every boundary, so an unbounded
 * projection would reproduce exactly the defect Phase 2 exists to fix: a run's
 * bookkeeping outweighing the run. None of these truncate the DURABLE spine —
 * `task_state` still holds the full plan and the full check log.
 */
export const LIFECYCLE_BOUNDS = {
  /** The objective, in characters. A goal is a sentence, not a document. */
  objective: 2000,
  /** Acceptance criteria carried. A read-back with more is pathological. */
  constraints: 32,
  /** Plan steps carried. */
  todos: 64,
  /** The most RECENT checks; the older ones are in `task_state`. */
  checks: 20,
  /** Children carried, newest last. */
  children: 32,
  /** Conflict paths per child. */
  conflicts: 20,
} as const;

export interface LifecycleInput {
  id: string;
  parentId?: string;
  kind: TaskLifecycleKind;
  objective: string;
  constraints: readonly Criterion[];
  workspace: { root: string; head: string | null; dirty: boolean };
  status: TaskLifecycleStatus;
  budget: TaskLifecycle["budget"];
  checkpoint: TaskLifecycle["checkpoint"];
  todos: readonly TodoItem[];
  checks: readonly CheckRecord[];
  verifiedCriteria: number;
  children: readonly TaskLifecycleChild[];
}

/** Build the projection, bounded for the wire and for the event log. */
export function buildLifecycle(input: LifecycleInput): TaskLifecycle {
  return {
    id: input.id,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    kind: input.kind,
    objective: input.objective.slice(0, LIFECYCLE_BOUNDS.objective),
    constraints: input.constraints.slice(0, LIFECYCLE_BOUNDS.constraints).map((c) => ({
      text: c.text,
      rung: c.rung,
      ...(c.evidence ? { evidence: c.evidence } : {}),
    })),
    workspace: { ...input.workspace },
    status: input.status,
    budget: { ...input.budget },
    checkpoint: input.checkpoint ? { ...input.checkpoint } : null,
    evidence: {
      todos: input.todos.slice(0, LIFECYCLE_BOUNDS.todos),
      checks: input.checks.slice(-LIFECYCLE_BOUNDS.checks),
      verifiedCriteria: input.verifiedCriteria,
    },
    children: input.children.slice(-LIFECYCLE_BOUNDS.children).map((child) => ({
      id: child.id,
      kind: child.kind,
      status: child.status,
      ...(child.integration ? { integration: child.integration } : {}),
      ...(child.conflicts && child.conflicts.length > 0
        ? { conflicts: child.conflicts.slice(0, LIFECYCLE_BOUNDS.conflicts) }
        : {}),
    })),
  };
}

/**
 * A cheap content key for "has anything a reader would notice changed?".
 *
 * Used to skip a checkpoint write and a duplicate `lifecycle` row when a
 * boundary produced no news. Deliberately excludes the live-only numbers that
 * move on their own (reserved spend, the clock) — a projection that differs
 * only in those is the same projection.
 */
export function lifecycleDigest(l: TaskLifecycle): string {
  const todos = l.evidence.todos.map((t) => `${t.status}:${t.content}`).join("|");
  const criteria = l.constraints.map((c) => `${c.rung ?? "-"}:${c.text}`).join("|");
  const children = l.children.map((c) => `${c.id}:${c.status}:${c.integration ?? "-"}`).join("|");
  return [
    l.id,
    l.status,
    l.objective,
    l.workspace.head ?? "-",
    l.workspace.dirty ? "dirty" : "clean",
    l.budget.turnsUsed,
    l.budget.secondWindsUsed,
    l.budget.tokensIn,
    l.budget.tokensOut,
    l.evidence.verifiedCriteria,
    l.checkpoint?.compactions ?? 0,
    todos,
    criteria,
    children,
  ].join("");
}

/**
 * The budget a resumed run inherits.
 *
 * Reads the newest persisted `lifecycle` row for the session. Returns null
 * when there is none, when the previous run finished, or when its plan had no
 * open steps — a fresh task gets a fresh ceiling, and only work that was
 * genuinely interrupted carries its spent turns forward.
 */
export function inheritedBudget(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): { turnsUsed: number; secondWindsUsed: number; spentUsd: number; from: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]!.event;
    if (row.type !== "run_trace") continue;
    const p = row.payload as { type?: unknown; lifecycle?: unknown };
    if (p.type !== "lifecycle") continue;
    const l = p.lifecycle as TaskLifecycle | undefined;
    if (!l || typeof l !== "object" || !l.budget) return null;
    // A run that finished hands nothing forward.
    if (l.status === "end_turn") return null;
    const open = (l.evidence?.todos ?? []).filter((t) => t.status !== "completed").length;
    if (open === 0) return null;
    return {
      turnsUsed: Math.max(0, Math.floor(l.budget.turnsUsed ?? 0)),
      secondWindsUsed: Math.max(0, Math.floor(l.budget.secondWindsUsed ?? 0)),
      spentUsd: Math.max(0, l.budget.spentUsd ?? 0),
      from: l.status,
    };
  }
  return null;
}

/**
 * The per-session run counter, derived from the log rather than stored.
 *
 * Every run appends a `checkpoint:"session_started"` marker before its first
 * turn, so counting them is the run's ordinal. Derived on purpose: a counter
 * held in memory resets on the crash it exists to survive.
 */
export function runSeqFromEvents(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): number {
  let started = 0;
  for (const { event } of events) {
    if (event.type === "checkpoint" && event.payload?.summary === "session_started") started++;
  }
  return started + 1;
}

/**
 * True when the session's PREVIOUS run ended without running its close.
 *
 * A clean end appends `checkpoint:"session_ended"` in the `finally`; a SIGKILL
 * runs no `finally` at all. So a `session_started` with no `session_ended`
 * after it is the signature of a run that died, and the one condition under
 * which a restart should look for a checkpoint to resume from.
 */
export function previousRunWasInterrupted(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): boolean {
  let open = false;
  for (const { event } of events) {
    if (event.type !== "checkpoint") continue;
    const summary = event.payload?.summary;
    if (summary === "session_started") open = true;
    else if (summary === "session_ended") open = false;
  }
  return open;
}

/** `runId` for a session's Nth run: stable, addressable, derivable on restart. */
export function checkpointRunId(sessionId: string, runSeq: number): string {
  return `${sessionId}#${runSeq}`;
}

/** The session a `runId` belongs to, for pruning and for the doctor's report. */
export function sessionIdFromRunId(runId: string): string {
  const hash = runId.lastIndexOf("#");
  return hash === -1 ? runId : runId.slice(0, hash);
}
