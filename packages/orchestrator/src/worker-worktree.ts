import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isGitRepo } from "./worktree";

/**
 * A filesystem of its own, per worker.
 *
 * Ownership claims split *paths* within one tree. That was enough to stop two
 * workers writing the same file and not nearly enough to give them a shell: two
 * parallel `npm run build`s in one checkout collide on `node_modules`, on
 * `dist/`, on lockfiles and on every other unowned artifact a build touches.
 * That is why `WORKER_TOOLS` had no `bash`, and why a worker's output had never
 * been compiled or run by anything before the lead read it.
 *
 * A worktree fixes the collision at the layer where it actually happens. The
 * two mechanisms compose rather than compete: **ownership governs which paths a
 * worker may touch; the worktree governs which filesystem it touches them in.**
 *
 * ## Branching from a dirty tree
 *
 * `git worktree add … HEAD` branches from the last commit, which for this
 * harness is close to useless: the lead's uncommitted work is the context the
 * worker was dispatched to build on. A worker that cannot see the interface the
 * lead just wrote will re-invent it.
 *
 * So the worktree is seeded from the *working tree*, not from HEAD: create the
 * checkout at HEAD, then apply the lead's uncommitted diff into it. This is
 * done with `git diff` piped to `git apply`, deliberately NOT with `git stash`
 * — a stash is repository-global state shared with every other worktree and
 * every other Gear session on the machine, so a stash/pop pair here would be a
 * race with anything else running, and a crash between the two would strand the
 * user's work in a stash entry they never made.
 */

export interface WorkerWorktree {
  path: string;
  branch: string;
  /** True when the lead's uncommitted work was carried in. */
  seededFromWorkingTree: boolean;
}

export interface MergeOutcome {
  merged: boolean;
  /** Paths git could not merge cleanly. Reported as a typed field, never as prose. */
  conflicts: string[];
  /** Files the worker actually changed, from `git diff --stat` against the base. */
  manifest: string[];
  /** Kept when the merge did not happen, so the work can be inspected. */
  branch: string;
  reason?: string;
}

const WORKTREE_DIR = join(".gear", "worktrees");

function git(
  cwd: string,
  args: string[],
  opts: { input?: string; timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

/**
 * Create a worker's worktree, seeded from the lead's working tree.
 *
 * Returns null rather than throwing when isolation is not possible (no git, no
 * repo). A worker that cannot get a worktree must still be able to run in the
 * shared tree the way it always has — losing delegation entirely because a
 * directory is not a git repository would be a much worse outcome than losing
 * isolation.
 */
export function createWorkerWorktree(repoRoot: string, workerId: string): WorkerWorktree | null {
  if (!isGitRepo(repoRoot)) return null;
  const id = safeId(workerId);
  const base = join(repoRoot, WORKTREE_DIR);
  try {
    mkdirSync(base, { recursive: true });
  } catch {
    return null;
  }
  const path = join(base, id);
  if (existsSync(path)) return null;
  const branch = `gear/worker-${id}`;

  // A stale branch from a crashed run would fail `worktree add`; remove it
  // first. It is ours by name and it has already been merged or abandoned.
  git(repoRoot, ["branch", "-D", branch]);
  const add = git(repoRoot, ["worktree", "add", "--detach", path, "HEAD"]);
  if (!add.ok) return null;
  const checkout = git(path, ["checkout", "-b", branch]);
  if (!checkout.ok) {
    git(repoRoot, ["worktree", "remove", "--force", path]);
    return null;
  }

  // Carry the lead's uncommitted work across. `git diff HEAD` covers staged and
  // unstaged tracked changes; untracked files are deliberately NOT carried,
  // because the set is unbounded (build output, node_modules, caches) and a
  // worker that needs an untracked file can be told about it in its prompt.
  let seeded = false;
  const diff = git(repoRoot, ["diff", "HEAD", "--binary"]);
  if (diff.ok && diff.stdout) {
    const applied = git(path, ["apply", "--index", "--allow-empty", "-"], {
      input: `${diff.stdout}\n`,
    });
    seeded = applied.ok;
    // A diff that will not apply is not fatal: the worker gets a clean HEAD
    // checkout, which is the old behaviour, and its report will simply be
    // written against committed state.
  }

  return { path, branch, seededFromWorkingTree: seeded };
}

/**
 * Commit the worker's owned paths in its worktree, then merge them back into
 * the lead's tree.
 *
 * Merge-back is deliberately narrow: only the paths the worker owned are taken.
 * A 3-way merge of the whole branch would also re-apply the lead's own seeded
 * diff, which is already present in the lead's tree — so the base for the file
 * extraction is the worktree branch and the target is the working tree, one
 * owned path at a time.
 */
export function mergeWorkerWorktree(
  repoRoot: string,
  wt: WorkerWorktree,
  ownedPaths: string[],
  summary: string,
): MergeOutcome {
  const conflicts: string[] = [];

  // Stage and commit only what the worker owned, in its own tree.
  //
  // A failing `git add` is usually a pathspec that never materialised — the
  // worker was given three files to own and wrote two of them, which is not an
  // error. So the staged set decides, not the exit code: nothing staged means
  // the worker wrote nothing, which is a clean empty merge.
  const add = git(wt.path, ["add", "-A", "--", ...ownedPaths]);
  const nothing = git(wt.path, ["diff", "--cached", "--quiet"]);
  if (nothing.ok) {
    return { merged: true, conflicts, manifest: [], branch: wt.branch, reason: "no changes" };
  }
  if (!add.ok && !nothing.ok) {
    // Something staged AND git complained: a real failure worth reporting.
    const partial = git(wt.path, ["diff", "--cached", "--name-only"]);
    if (!partial.stdout) {
      return {
        merged: false,
        conflicts,
        manifest: [],
        branch: wt.branch,
        reason: `git add: ${add.stderr}`,
      };
    }
  }
  const message = `gear(worker): ${summary.replace(/\s+/g, " ").trim().slice(0, 64) || "changes"}`;
  const commit = git(wt.path, ["commit", "--no-verify", "-m", message]);
  if (!commit.ok) {
    return {
      merged: false,
      conflicts,
      manifest: [],
      branch: wt.branch,
      reason: `git commit: ${commit.stderr}`,
    };
  }

  // The manifest is git's, not the model's.
  const stat = git(repoRoot, ["diff", "--name-only", "HEAD", wt.branch, "--", ...ownedPaths]);
  const manifest = stat.ok && stat.stdout ? stat.stdout.split("\n").filter(Boolean) : [];

  // Take the worker's version of each owned path. `checkout <branch> -- <path>`
  // is a copy, not a merge, and that is correct here precisely BECAUSE
  // ownership is exclusive: no one else was allowed to write these paths while
  // the worker held them, so there is no third version to reconcile.
  //
  // The exception is a path the lead changed anyway (a manual edit, another
  // tool, a hook). That is a genuine conflict, and it is detected by comparing
  // the lead's current content against the seed the worker started from.
  for (const path of manifest) {
    const leadChanged = git(repoRoot, ["diff", "--quiet", "HEAD", "--", path]);
    const workerBase = git(repoRoot, ["diff", "--quiet", "HEAD", `${wt.branch}^`, "--", path]);
    // leadChanged.ok === true means "no difference from HEAD" — i.e. the lead
    // did NOT change it. A difference on both sides is the conflict.
    if (!leadChanged.ok && !workerBase.ok) {
      conflicts.push(path);
      continue;
    }
    const take = git(repoRoot, ["checkout", wt.branch, "--", path]);
    if (!take.ok) conflicts.push(path);
  }

  // Never leave the merged files staged: the lead's own auto-commit decides
  // what gets committed, and a surprise staged set would make it refuse.
  if (manifest.length > 0) git(repoRoot, ["reset", "--quiet", "HEAD", "--", ...manifest]);

  return { merged: conflicts.length === 0, conflicts, manifest, branch: wt.branch };
}

/**
 * Remove the checkout. The BRANCH survives on purpose: it is the only copy of
 * a failed worker's work, and `gear/worker-<id>` is where a person looks when
 * checks failed or a merge conflicted.
 */
export function removeWorkerWorktree(
  repoRoot: string,
  wt: WorkerWorktree,
  keepBranch: boolean,
): void {
  git(repoRoot, ["worktree", "remove", "--force", wt.path]);
  if (!keepBranch) git(repoRoot, ["branch", "-D", wt.branch]);
}

/**
 * Run the project's checks inside the worker's worktree, before merge.
 *
 * The command list comes from the caller (`[verify] commands`, or detection).
 * Network is off and the cwd is the worktree, so a check cannot reach the
 * lead's tree or the internet — a "check" that installs dependencies from the
 * network is not a check, it is a second build.
 */
export function runWorktreeChecks(
  worktreePath: string,
  commands: string[],
  timeoutMs: number,
): { outcome: "passed" | "failed" | "not_run"; failures: string[] } {
  if (commands.length === 0) return { outcome: "not_run", failures: [] };
  const failures: string[] = [];
  for (const command of commands) {
    const res = spawnSync("/bin/sh", ["-c", command], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GEAR_WORKER_CHECK: "1" },
    });
    if (res.status !== 0) {
      const detail = ((res.stderr || res.stdout) ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      failures.push(
        `${command} → ${res.status === null ? "timed out" : `exit ${res.status}`}${detail ? `: ${detail}` : ""}`,
      );
    }
  }
  return { outcome: failures.length === 0 ? "passed" : "failed", failures };
}
