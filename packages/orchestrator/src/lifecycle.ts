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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { patchTargetPaths } from "@rune/tool-registry";

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
 * Callers pass whatever they have. The result is optional: without it an
 * `apply_patch` is read from the patch text's own file headers, which is the
 * same set the tool then writes — so an event-stream consumer that never sees
 * a result (the TUI footer) is no longer short by every patched file.
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
    // A patch the harness could not read back — or a caller that has the call
    // but not its result, which is every event-stream consumer — is still a
    // write. The patch text names its own targets, so read them from there
    // rather than answering "nothing changed": the TUI footer counted zero
    // patched files for exactly this reason.
    if (paths.length === 0 && typeof a.patch === "string" && a.patch)
      paths.push(...patchTargetPaths(a.patch));
    if (paths.length === 0 && typeof a.path === "string" && a.path) paths.push(a.path);
    return [...new Set(paths)];
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
  if (status === null) return { head, dirty: false };
  return { head, dirty: status.split("\n").some((line) => changesTheWork(line)) };
}

/**
 * Rune's own footprint inside the workspace — not work, and not dirt.
 *
 * V7 finding 10. The harness writes `<workspace>/.rune/tool-children.jsonl`
 * (and the run's mission note beside it) DURING the run, so in any project
 * whose `.gitignore` has not been told about `.rune/` the tree was `<sha>`
 * when a check ran and `<sha>+dirty` by the time the verdict was taken:
 * `treeMovedUnder` fired on Rune's own evidence and reported a genuinely
 * passing acceptance as `stale`. Measured with two identical workspaces,
 * identical finished work and an identical honest check, differing in one line
 * of `.gitignore`: `met/satisfied` with it, `partial/stale` without.
 *
 * A verdict may depend on the work and on nothing else. The harness's own
 * directory is therefore excluded from the dirty computation — the freshness
 * question is "did the tree move under this claim", and Rune moving its own
 * ledger is not the tree moving. Everything else, including every untracked
 * file the model wrote, still counts.
 */
const HARNESS_OWNED = /^\.(?:rune|gear|alan)\//;

/**
 * One `git status --porcelain` line: is it a change to the WORK?
 *
 * Exported because the vocabulary IS the distinction, and it is held to
 * examples rather than to the regexp's shape — the same way the runner
 * vocabularies are.
 */
export function changesTheWork(line: string): boolean {
  if (!line.trim()) return false;
  // `XY <path>`, or `XY <old> -> <new>` for a rename. Quoted when the path has
  // characters git will not print raw; the quotes do not change the prefix.
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  const path = (arrow === -1 ? rest : rest.slice(arrow + 4)).replace(/^"|"$/g, "");
  return !HARNESS_OWNED.test(path);
}

/**
 * The first of `paths` that git says is not the parent commit's file: it is
 * untracked, or it is tracked and modified. Undefined when every one of them
 * is exactly what the tree was opened with, or when there is no git to ask.
 *
 * V7 finding 8. "Did THIS RUN write the program this check runs?" was asked of
 * the live write ledger, which is one Engine's. The next `rune` invocation —
 * or simply a new session on the same workspace, which is how anyone works —
 * has an empty ledger and the script is still on disk, so a check the run
 * itself wrote settled a criterion one session later. The ledger cannot answer
 * a question about the TASK, only about the process; git can, it survives
 * every crash and every restart, and it is the same question: a check program
 * that is not in the commit the work started from is a program the work
 * produced.
 *
 * Deliberately conservative in the other direction from the ledger: a script
 * the PERSON wrote and never committed also reads as not-from-the-parent, and
 * a criterion cited on it derives `needs_review` rather than `satisfied`.
 * That costs a person one commit; the reverse costs the verdict.
 */
export function notFromParentCommit(
  root: string,
  paths: readonly string[],
  opts?: { since?: string | null; epoch?: string | null },
): string | undefined {
  const named = paths.filter((p) => typeof p === "string" && p.trim().length > 0);
  if (named.length === 0) return undefined;
  // ── The run's own commits (V8 critical 5) ──
  //
  // `git status` was the whole of the witness, so the answer was "not
  // self-authored" the moment the run COMMITTED the check it wrote — which is
  // how a task normally ends. In the next session the write ledger is empty
  // too, and both witnesses agree the run's fabricated oracle is the commit's
  // program. A commit made DURING the task is the task's work by any reading,
  // so it is asked first: everything between the commit the task opened at and
  // HEAD, and everything in a Rune auto-commit, whose subject names it.
  const committed = committedDuringTask(root, named, opts?.since ?? null, opts?.epoch ?? null);
  if (committed) return committed;
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal", "--", ...named],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    // No git, or a path git will not take. Nothing is KNOWN to be self-authored,
    // which is the reading that keeps an honest citation.
    return undefined;
  }
  const moved = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    moved.add((arrow === -1 ? rest : rest.slice(arrow + 4)).replace(/^"|"$/g, ""));
  }
  if (moved.size === 0) return undefined;
  for (const path of named) {
    const norm = path.replace(/^\.\//, "");
    if (moved.has(norm) || moved.has(path)) return path;
  }
  return undefined;
}

/**
 * The first of `paths` that a commit made DURING this task created or changed.
 *
 * Two readings of "during", because they cover different gaps and neither
 * covers the other:
 *
 *   · `since..HEAD` — the commit the task opened at, carried on the contract
 *     row (`TaskContract.baseCommit`) so it survives a crash and a resume.
 *     Exact, and it covers a commit the model made itself through `bash`.
 *   · a Rune auto-commit — the subject prefix `git-undo` writes. Durable in git
 *     itself, so it still answers in a brand-new session on the same workspace,
 *     where no contract row is restored and `since` is HEAD.
 *
 * Bounded at 200 commits: a check program is recent work or it is the repo's.
 */
function committedDuringTask(
  root: string,
  named: readonly string[],
  since: string | null,
  epoch: string | null = null,
): string | undefined {
  const touched = new Set<string>();
  const collect = (args: string[]): void => {
    try {
      const out = execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        const path = line.trim();
        if (path) touched.add(path);
      }
    } catch {
      // No git, an unknown commit, a path git will not take: this witness has
      // no answer, and the ones after it still do.
    }
  };
  if (since && /^[0-9a-fA-F]{7,40}$/.test(since)) {
    collect(["diff", "--name-only", `${since}..HEAD`, "--", ...named]);
  }
  // ── The TASK EPOCH (V9 finding 8) ──
  //
  // `since..HEAD` is exact and it is empty in a brand-new session, where
  // `baseCommit` is HEAD. The durable witness was therefore the SUBJECT grep
  // below — and this repo's own commits are `docs:`, `ui:`, `ci:`, never
  // `rune:`, so a run that wrote its own oracle, committed it as "chore: tidy"
  // and ended the task normally was unattributed in the next session. A commit
  // message is the one part of a commit its author chooses; the TREE is not.
  //
  // So the second reading is a tree diff from the epoch: the commit the
  // PREVIOUS task in this workspace opened at, recorded at intake beside the
  // database where a run cannot quietly rewrite it. Anything touched between
  // there and HEAD is work done while a task was open, whatever its subject
  // says. Deliberately conservative in the same direction as the rest of this
  // function: a script a PERSON committed in that window also reads as
  // not-from-the-parent, and a criterion cited on it derives `needs_review`
  // rather than `satisfied`. That costs a person one re-run; the reverse costs
  // the verdict.
  if (epoch && /^[0-9a-fA-F]{7,40}$/.test(epoch) && epoch !== since) {
    collect(["diff", "--name-only", `${epoch}..HEAD`, "--", ...named]);
  }
  collect([
    "log",
    "-n",
    "200",
    "--name-only",
    "--format=",
    "--grep=^rune: ",
    "--grep=^gear: ",
    "--grep=^alan: ",
    "--",
    ...named,
  ]);
  if (touched.size === 0) return undefined;
  for (const path of named) {
    const norm = path.replace(/^\.\//, "");
    if (touched.has(norm) || touched.has(path)) return path;
  }
  return undefined;
}

/** What a claim or a verdict is a claim ABOUT: a revision, and the content of
 *  the files it is scoped to at that moment. */
export interface StampedRevision {
  head: string | null;
  dirty: boolean;
  /** sha256 (short) over the named files' contents. Undefined when no file was named. */
  digest?: string;
}

/**
 * A content digest of the files a claim is scoped to.
 *
 * HEAD cannot date a claim on a dirty tree, and the ordinary agent run is
 * dirty from its first write to its last: nothing commits mid-run, so every
 * rung and every check was stamped against one unchanging revision however
 * much the very file it was about was rewritten afterwards. This is the part
 * that moves.
 *
 * Bounded and never fatal: at most 64 files, at most 256 KiB read from each,
 * and a file that cannot be read contributes its name and "missing" rather
 * than throwing. A path that resolves outside the workspace is skipped — the
 * digest is a fact about this tree.
 */
export function workspaceDigest(
  root: string,
  files: readonly string[] | undefined,
): string | undefined {
  const named = (files ?? []).filter((f) => typeof f === "string" && f.trim().length > 0);
  if (named.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of [...new Set(named)].sort().slice(0, 64)) {
    const full = resolve(root, file);
    if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
    hash.update(file);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) {
        hash.update(`\0dir:${stats.mtimeMs}`);
        continue;
      }
      hash.update("\0");
      hash.update(readFileSync(full).subarray(0, 256 * 1024));
    } catch {
      hash.update("\0missing");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

// ─── Stale evidence ───

const RUNGS: readonly ClaimRung[] = ["suspected", "observed", "reproduced", "verified"];

/** What a stamp on one piece of evidence says about the tree it was taken on. */
export interface EvidenceStamp {
  head?: string;
  dirty?: boolean;
  digest?: string;
}

/**
 * Did the tree move under this claim? The ONE test, for both readers.
 *
 * `demoteStaleCriteria` drops a rung with it; `criterionStatus` (contract.ts)
 * derives `stale` with it. They must agree — a criterion reported `satisfied`
 * by one rule and demoted by the other describes the run two ways — so the
 * predicate lives here once rather than being copied into the derivation.
 *
 * The three original clauses are unchanged. The fourth — two digests that
 * differ — is what makes the test work outside git at all: with no commit to
 * move and no dirty flag to flip, the content of the files the claim is about
 * is the only thing that can say it moved. Inside a repository it adds
 * nothing (a clean tree whose content changed has a different HEAD, which the
 * first clause already caught).
 */
export function treeMovedUnder(evidence: EvidenceStamp, now: StampedRevision): boolean {
  const headMoved = now.head !== null && evidence.head != null && evidence.head !== now.head;
  const wentDirty = evidence.dirty === false && now.dirty;
  const stayedDirty =
    evidence.dirty === true &&
    now.dirty &&
    !(evidence.digest !== undefined && evidence.digest === now.digest);
  const digestMoved =
    evidence.digest !== undefined && now.digest !== undefined && evidence.digest !== now.digest;
  return headMoved || wentDirty || stayedDirty || digestMoved;
}

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
 *  · it was dirty then and is dirty now → the claim has no immutable anchor.
 *    If both moments carry a digest of the files the claim is about, that
 *    digest decides; with no digest on either side nothing can be shown to
 *    have held, so the claim drops a rung. This is the ordinary agent run —
 *    HEAD never moves inside it — and treating it as "nothing can be
 *    concluded, so nothing moves" is what made the rule almost unfireable.
 * A claim recorded before revisions were tracked has no `head` and is left
 * alone; it is not evidence of staleness, only of age.
 *
 * Each demotion is KEYED by the revision that caused it (`evidence.staleAt`),
 * so one change costs one rung. Without that key the same unchanged fact
 * decayed again on every call — verified → reproduced → observed — because
 * the evidence itself is never re-stamped: `evidence.head` still says, truly,
 * where the claim was taken.
 *
 * Returns the criteria that moved, for the line the surface prints.
 */
export function demoteStaleCriteria(
  criteria: Criterion[],
  now: StampedRevision,
): Array<{ text: string; from: ClaimRung; to: ClaimRung }> {
  const moved: Array<{ text: string; from: ClaimRung; to: ClaimRung }> = [];
  const key = `${now.head ?? ""}|${now.dirty ? 1 : 0}|${now.digest ?? ""}`;
  for (const criterion of criteria) {
    const rung = criterion.rung;
    const evidence = criterion.evidence as
      | (Criterion["evidence"] & {
          head?: string;
          dirty?: boolean;
          digest?: string;
          staleAt?: string;
        })
      | undefined;
    if (!rung || !evidence?.head) continue;
    const index = RUNGS.indexOf(rung);
    if (index <= 1) continue; // suspected/observed cannot go stale
    // This revision has already cost this criterion its rung.
    if (evidence.staleAt === key) continue;
    if (!treeMovedUnder(evidence, now)) continue;
    const to = RUNGS[index - 1]!;
    criterion.rung = to;
    evidence.staleAt = key;
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
  // Phase 5B: the three exits the harness itself takes. Before them the loop
  // emitted no terminal event on any of these paths, so every one of them was
  // reconciled into `provider_lost` by `engine.ts` — the vocabulary could not
  // tell a killed loop from a dead network.
  "loop_detected",
  "barren",
  "budget",
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
    // Rebuilt field by field rather than spread, so a live child's private
    // bookkeeping never leaks onto the wire. The cost of that is that a field
    // added to `TaskLifecycleChild` and set by `Engine.recordChild` is dropped
    // here unless it is named — which is exactly what happened to P3B I4's
    // stamps: `recordChild` set them and this map deleted them one call later,
    // so `integratedAt` appeared zero times in a real session log. Anything
    // added to the child row must be added here too.
    children: input.children.slice(-LIFECYCLE_BOUNDS.children).map((child) => ({
      id: child.id,
      kind: child.kind,
      status: child.status,
      ...(child.name ? { name: child.name } : {}),
      ...(child.integration ? { integration: child.integration } : {}),
      ...(child.conflicts && child.conflicts.length > 0
        ? { conflicts: child.conflicts.slice(0, LIFECYCLE_BOUNDS.conflicts) }
        : {}),
      // When the child's own loop began and when its result was integrated
      // (P3B I4). Both optional: a child from an older build reports neither.
      ...(child.startedAt ? { startedAt: child.startedAt } : {}),
      ...(child.integratedAt ? { integratedAt: child.integratedAt } : {}),
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
 * Empty completions the interrupted predecessor already spent (M3).
 *
 * The counter that joins `inheritedBudget`: a run killed after two empty
 * completions does not get a fresh allowance when it resumes. It is derived
 * from the run's own `decision` rows rather than from the lifecycle
 * projection, because a `decision` row is written BEFORE the act — so it
 * survives exactly the kill this rule exists for, while a projection is only
 * as fresh as its last emission.
 *
 * Cleared on `session_ended`, not on `session_started` — the same correction
 * `inheritedRepairTurns` carries. A `session_started` is the marker a RESTART
 * writes, so clearing there handed the whole allowance back at every crash:
 * exactly the defect this counter exists to prevent, in the counter written to
 * prevent it. A run that reached its `finally` finished and handed nothing
 * forward; a SIGKILL runs no `finally` at all, which is the pair
 * `previousRunWasInterrupted` reads.
 *
 * Only `working` is counted — a `verifying` or an `abandoned(...)` decision
 * ended the retrying, and counting it would spend an allowance the run never
 * used.
 *
 * Called under the same `previousRunWasInterrupted` gate as `inheritedBudget`.
 */
export function inheritedEmptyCompletions(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): number {
  let seen = 0;
  for (const { event } of events) {
    if (event.type === "checkpoint" && event.payload?.summary === "session_ended") {
      seen = 0;
      continue;
    }
    if (event.type !== "decision") continue;
    const p = event.payload as {
      guard?: unknown;
      applied?: unknown;
      transition?: unknown;
      inputs?: { emptyCompletions?: unknown };
    };
    if (p.guard !== "E4" || p.applied !== true) continue;
    if (p.transition !== "working") continue;
    // The ROW's own number, not the row COUNT (V6 finding 12). Counting rows
    // drops the allowance the killed run had itself inherited: run A writes
    // one row; run B inherits 1, spends one more and writes ONE row — whose
    // `inputs.emptyCompletions` correctly reads 2 — and run C then inherited
    // 1 again. Four empty completions against an allowance of three, growing
    // one per crash. `Math.max` keeps the count monotonic, so a row without
    // the field (an older log) still advances it by one.
    const stated = Number(p.inputs?.emptyCompletions);
    seen = Math.max(seen + 1, Number.isFinite(stated) ? Math.floor(stated) : 0);
  }
  return seen;
}

/**
 * Repair turns the interrupted predecessor already spent, by class (M4).
 *
 * The same rule as `inheritedEmptyCompletions`, generalised to the six repair
 * classes: **limits are shared and durable**. A run killed after its one
 * acceptance re-prompt does not get a second one when it resumes, and a run
 * killed at two transport failures resumes at two. Derived from the run's own
 * `decision` rows for the same reason — a `decision` row is written BEFORE the
 * act, so it survives exactly the kill this rule exists for.
 *
 * Which transition counts as SPENT differs by class, and that is the whole
 * subtlety:
 *
 *   * `transport` — `working` is a retry, and the retry is the thing bounded.
 *   * `check_failed` / `acceptance` — `repairing` is a repair turn spent;
 *     `verifying` / `complete(partial)` is the bound already being enforced.
 *   * `no_progress` — `working` is the nudge.
 *   * `missing_dependency` / `denied` — no counter: neither buys anything, so
 *     there is nothing to carry. They are absent from the result by design.
 *
 * The count is the ROW'S OWN number, floored at one more than the last, for
 * the reason V6 finding 12 names: counting rows alone drops the allowance the
 * killed run had itself inherited, and the loss compounds one per crash.
 */
export function inheritedRepairTurns(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): Record<string, number> {
  /**
   * guard → the authority key, the transition that means "spent", the input
   * that counts it, and whether that input was read BEFORE the site's own
   * increment.
   *
   * The last field is the whole subtlety. `transport` reads `attempts` after
   * `consecutiveErrors++`, so the row's 2 means two spent. The other three
   * read their counter before incrementing it, so a row saying 0 is a row
   * saying "this is the first" — and taking it at face value would hand the
   * resumed run the turn the killed one had already spent.
   */
  const SPENT: Record<string, [string, string, string, boolean]> = {
    REPAIR_TRANSPORT: ["transport", "working", "attempts", false],
    REPAIR_CHECK: ["check_failed", "repairing", "repairTurns", true],
    REPAIR_ACCEPTANCE: ["acceptance", "repairing", "repromptsUsed", true],
    REPAIR_PROGRESS: ["no_progress", "working", "nudges", true],
  };
  const out: Record<string, number> = {};
  for (const { event } of events) {
    // ── Cleared by a CLEAN END, never by a restart ──
    //
    // V7 finding 7. This cleared the whole accumulator on every
    // `session_started`, which is the marker a RESTART writes — so the bound
    // survived exactly one crash. A run that resumed with its allowance
    // already spent writes no `spent` row of its own; when it is killed too,
    // the next resume walks past ITS `session_started` and erases the first
    // run's row. Measured: `{check_failed: 1}` → `{}`, and the same for
    // `no_progress`, `transport` and `acceptance`. That is V6 finding 12
    // inverted — not a shrink of one per crash, a RESET per crash — in the
    // counter written to avoid it.
    //
    // `session_ended` is what the reset was written for: a run that reached
    // its `finally` finished, handed nothing forward, and the next request in
    // that session is a new task with a new allowance. A SIGKILL runs no
    // `finally` at all, which is the whole reason `previousRunWasInterrupted`
    // reads the same pair.
    if (event.type === "checkpoint" && event.payload?.summary === "session_ended") {
      for (const key of Object.keys(out)) delete out[key];
      continue;
    }
    if (event.type !== "decision") continue;
    const p = event.payload as {
      guard?: unknown;
      applied?: unknown;
      transition?: unknown;
      inputs?: Record<string, unknown>;
    };
    if (p.applied !== true || typeof p.guard !== "string") continue;
    const rule = SPENT[p.guard];
    if (!rule) continue;
    const [key, spent, field, preIncrement] = rule;
    if (p.transition !== spent) continue;
    // The row's own number, normalised to "spent after this decision", with a
    // `+ 1` floor so a row missing the field (an older log) still advances the
    // count by one rather than silently handing an allowance back.
    const raw = Number(p.inputs?.[field]);
    const stated = Number.isFinite(raw) ? Math.floor(raw) + (preIncrement ? 1 : 0) : 0;
    const prior = out[key] ?? 0;
    out[key] = Math.max(prior + 1, stated);
  }
  return out;
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

// ─── The task epoch (V9 finding 8) ───
//
// One line per workspace, beside the database: the commit the last task in it
// opened at. It is read at intake — giving the PREVIOUS task's base — and then
// overwritten with this task's, so a new session can ask "what has been
// committed here since a task was last open" without a session row, without a
// commit subject, and without trusting anything the run writes about itself.
//
// It lives under `~/.rune` (`acceptance-pins`' own neighbourhood), so a run
// that wants to erase it is making a guardrail change rather than an ordinary
// write; losing it costs this witness and no other.
const TASK_EPOCH_FILE = "task-epochs.json";
const TASK_EPOCH_MAX = 64;

interface TaskEpochRow {
  baseCommit: string;
  at: string;
}

/**
 * Read the previous task's base commit for this workspace and record this
 * one's. Returns the PREVIOUS value, which is the epoch the witness uses;
 * `null` the first time a workspace is ever seen.
 */
export function takeTaskEpoch(
  stateDir: string,
  workspaceRoot: string,
  head: string | null,
): string | null {
  const path = join(stateDir, TASK_EPOCH_FILE);
  const key = resolve(workspaceRoot);
  let rows: Record<string, TaskEpochRow> = {};
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (raw && typeof raw === "object") rows = raw as Record<string, TaskEpochRow>;
    }
  } catch {
    rows = {};
  }
  const previous = rows[key]?.baseCommit;
  if (head && /^[0-9a-fA-F]{7,40}$/.test(head)) {
    rows[key] = { baseCommit: head, at: new Date().toISOString() };
    const keys = Object.entries(rows)
      .sort((a, b) => (b[1]?.at ?? "").localeCompare(a[1]?.at ?? ""))
      .slice(0, TASK_EPOCH_MAX);
    rows = Object.fromEntries(keys);
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
    } catch {
      // No record is this witness missing, not a run that cannot start.
    }
  }
  return typeof previous === "string" && /^[0-9a-fA-F]{7,40}$/.test(previous) ? previous : null;
}
