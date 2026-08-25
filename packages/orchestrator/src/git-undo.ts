// ─── Git Auto-Commit + /undo ───
//
// Aider-grade trust story, opt-in via `[git] autoCommit = true`: after every
// successful run that wrote files, Gear commits EXACTLY the files it touched
// (message "gear: <task>"), and `/undo` reverts the last such commit. Every
// AI change becomes one revertible unit — the strongest undo primitive a
// coding agent can offer, using plumbing the user already trusts.
//
// Safety rules (each one exists because the naive version eats user work):
//  - Never commit when the user already has STAGED changes — `git add` would
//    sweep their half-built commit into ours.
//  - Stage only the paths Gear wrote this run, never `-A` on the repo.
//  - `/undo` only resets a Gear (or migration-era legacy) commit, only when the
//    worktree is otherwise clean, and only when a parent commit exists.
//  - Everything is best-effort: a git failure degrades to "not committed",
//    never to a broken run.

import { execFileSync } from "node:child_process";

export const GEAR_COMMIT_PREFIX = "gear: ";

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, out: (e.stderr ?? e.stdout ?? String(err)).toString().trim() };
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

export type AutoCommitResult =
  | { committed: true; sha: string; shortSha: string; fileCount: number }
  | { committed: false; reason: string };

/**
 * Commit the given paths as one "gear:" commit. Returns why when it declines
 * — every decline reason is safe-by-design, not an error.
 */
export function autoCommitPaths(
  root: string,
  paths: string[],
  taskSummary: string,
): AutoCommitResult {
  if (paths.length === 0) return { committed: false, reason: "no files written" };
  if (!isGitRepo(root)) return { committed: false, reason: "not a git repository" };

  // The user has something staged → committing now would swallow their work.
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  if (!staged.ok) return { committed: false, reason: `git unavailable: ${staged.out}` };
  if (staged.out !== "") {
    return { committed: false, reason: "you have staged changes — skipped to protect them" };
  }

  // Stage only what Gear touched. -A scoped to the paths handles deletions.
  const add = git(root, ["add", "-A", "--", ...paths]);
  if (!add.ok) return { committed: false, reason: `git add failed: ${add.out}` };

  // Nothing actually changed (e.g. rewrite produced identical content).
  const check = git(root, ["diff", "--cached", "--quiet"]);
  if (check.ok) {
    return { committed: false, reason: "no effective changes" };
  }

  const summary = taskSummary.replace(/\s+/g, " ").trim().slice(0, 72) || "changes";
  const commit = git(root, ["commit", "--no-verify", "-m", `${GEAR_COMMIT_PREFIX}${summary}`]);
  if (!commit.ok) {
    // Leave nothing half-staged behind on failure.
    git(root, ["reset", "--quiet", "--", ...paths]);
    return { committed: false, reason: `git commit failed: ${commit.out}` };
  }

  const sha = git(root, ["rev-parse", "HEAD"]).out;
  return {
    committed: true,
    sha,
    shortSha: sha.slice(0, 7),
    fileCount: paths.length,
  };
}

export type UndoResult =
  { ok: true; undoneSha: string; subject: string } | { ok: false; reason: string };

/**
 * Undo the last Gear auto-commit via `git reset --hard HEAD~1` — guarded so it
 * can ONLY discard a Gear or migration-era legacy commit, never user work.
 */
export function undoLastGearCommit(root: string): UndoResult {
  if (!isGitRepo(root)) return { ok: false, reason: "not a git repository" };

  const subject = git(root, ["log", "-1", "--pretty=%s"]);
  if (!subject.ok) return { ok: false, reason: `git unavailable: ${subject.out}` };
  const managedPrefixes = [GEAR_COMMIT_PREFIX];
  if (!managedPrefixes.some((prefix) => subject.out.startsWith(prefix))) {
    return {
      ok: false,
      reason: `HEAD is not a Gear-managed commit ("${subject.out.slice(0, 60)}") — nothing to undo`,
    };
  }

  const dirty = git(root, ["status", "--porcelain"]);
  if (!dirty.ok) return { ok: false, reason: `git unavailable: ${dirty.out}` };
  if (dirty.out !== "") {
    return {
      ok: false,
      reason:
        "worktree has uncommitted changes — commit or stash them first (undo uses reset --hard)",
    };
  }

  const parent = git(root, ["rev-parse", "--verify", "HEAD~1"]);
  if (!parent.ok)
    return {
      ok: false,
      reason: "the Gear-managed commit is the only commit — cannot reset past it",
    };

  const sha = git(root, ["rev-parse", "HEAD"]).out;
  const reset = git(root, ["reset", "--hard", "HEAD~1"]);
  if (!reset.ok) return { ok: false, reason: `git reset failed: ${reset.out}` };

  return { ok: true, undoneSha: sha.slice(0, 7), subject: subject.out };
}
