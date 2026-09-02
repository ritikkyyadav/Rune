// ─── Per-run git worktree isolation ───
//
// A detached background run must not collide with the user's working tree —
// or with another detached run. `git worktree add` gives each run its own
// checkout sharing one object store; merge-back is ordinary git (the run's
// work is a branch). This COMPOSES with the worker ownership model: workers
// split files within one tree, worktrees split whole trees between runs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** New run worktrees live here; pre-rename `.alan/worktrees` checkouts are still recognized. */
const WORKTREE_DIR = join(".gear", "worktrees");
const WORKTREE_DIRS = [".gear/worktrees", ".alan/worktrees"];
/**
 * Whether a path from `git worktree list --porcelain` is one of ours.
 *
 * Compared with FORWARD SLASHES on both sides. `join()` produces
 * `.gear\worktrees` on Windows and git prints `D:/a/repo/.gear/worktrees/run-a`
 * whatever the platform, so a native-separator needle matched nothing there:
 * `listRunWorktrees` returned an empty list on Windows and every run worktree
 * became invisible to the code that cleans them up (P10.2).
 */
function isRunWorktreePath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/");
  return WORKTREE_DIRS.some((dir) => normalized.includes(dir));
}

export interface RunWorktree {
  /** Absolute path of the isolated checkout. */
  path: string;
  /** The branch the run's commits land on (gear/run-<id>). */
  branch: string;
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/** True when `dir` is inside a git repository (worktree isolation possible). */
export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

/**
 * Create an isolated worktree for a run at `.gear/worktrees/<runId>`, on a
 * fresh `gear/run-<runId>` branch off the current HEAD. Throws with the git
 * error on failure — a run that THINKS it is isolated but isn't would be
 * worse than one that refuses to start.
 */
export function createRunWorktree(repoRoot: string, runId: string): RunWorktree {
  if (!isGitRepo(repoRoot)) {
    throw new Error(
      "worktree isolation needs a git repository — run `git init` or drop --worktree",
    );
  }
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const base = join(repoRoot, WORKTREE_DIR);
  mkdirSync(base, { recursive: true });
  const path = join(base, safeId);
  if (existsSync(path)) {
    throw new Error(`worktree already exists for run ${safeId}: ${path}`);
  }
  const branch = `gear/run-${safeId}`;
  const res = git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!res.ok) {
    throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
  }
  return { path, branch };
}

/** Worktrees under `.gear/worktrees` (path + branch per entry). */
export function listRunWorktrees(repoRoot: string): RunWorktree[] {
  const res = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  const out: RunWorktree[] = [];
  let current: Partial<RunWorktree> = {};
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
    else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "") {
      if (isRunWorktreePath(current.path) && current.branch) {
        out.push(current as RunWorktree);
      }
      current = {};
    }
  }
  if (isRunWorktreePath(current.path) && current.branch) {
    out.push(current as RunWorktree);
  }
  return out;
}

/**
 * Remove a run's worktree (the checkout only — the branch and its commits
 * survive for merge-back; delete the branch separately once merged).
 */
export function removeRunWorktree(repoRoot: string, runId: string): void {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const path = join(repoRoot, WORKTREE_DIR, safeId);
  const res = git(repoRoot, ["worktree", "remove", "--force", path]);
  if (!res.ok) {
    throw new Error(`git worktree remove failed: ${res.stderr || res.stdout}`);
  }
}
