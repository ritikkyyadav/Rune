// ─── Git Auto-Commit + /undo ───
//
// Aider-grade trust story, opt-in via `[git] autoCommit = true`: after every
// successful run that wrote files, Rune commits EXACTLY the files it touched
// (message "rune: <task>"), and `/undo` reverts the last such commit. Every
// AI change becomes one revertible unit — the strongest undo primitive a
// coding agent can offer, using plumbing the user already trusts.
//
// Safety rules (each one exists because the naive version eats user work):
//  - Never commit when the user already has STAGED changes — `git add` would
//    sweep their half-built commit into ours.
//  - Stage only the paths Rune wrote this run, never `-A` on the repo.
//  - `/undo` only resets a Rune (or migration-era legacy) commit, only when the
//    worktree is otherwise clean, and only when a parent commit exists.
//  - Everything is best-effort: a git failure degrades to "not committed",
//    never to a broken run.

import { execFileSync } from "node:child_process";

export const RUNE_COMMIT_PREFIX = "rune: ";
/** The prefix the previous name wrote; existing auto-commits in users' repos carry it. */
export const LEGACY_COMMIT_PREFIXES: readonly string[] = ["gear: "];

/** Whether a commit subject is one of ours, under the current or the previous name. */
export function isManagedCommitSubject(subject: string): boolean {
  return [RUNE_COMMIT_PREFIX, ...LEGACY_COMMIT_PREFIXES].some((p) => subject.startsWith(p));
}

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
 * Commit the given paths as one "rune:" commit. Returns why when it declines
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

  // Stage only what Rune touched. -A scoped to the paths handles deletions.
  const add = git(root, ["add", "-A", "--", ...paths]);
  if (!add.ok) return { committed: false, reason: `git add failed: ${add.out}` };

  // Nothing actually changed (e.g. rewrite produced identical content).
  const check = git(root, ["diff", "--cached", "--quiet"]);
  if (check.ok) {
    return { committed: false, reason: "no effective changes" };
  }

  const summary = taskSummary.replace(/\s+/g, " ").trim().slice(0, 72) || "changes";
  const commit = git(root, ["commit", "--no-verify", "-m", `${RUNE_COMMIT_PREFIX}${summary}`]);
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
 * Undo the last Rune auto-commit via `git reset --hard HEAD~1` — guarded so it
 * can ONLY discard a Rune or migration-era legacy commit, never user work.
 */
export function undoLastRuneCommit(root: string): UndoResult {
  if (!isGitRepo(root)) return { ok: false, reason: "not a git repository" };

  const subject = git(root, ["log", "-1", "--pretty=%s"]);
  if (!subject.ok) return { ok: false, reason: `git unavailable: ${subject.out}` };
  if (!isManagedCommitSubject(subject.out)) {
    return {
      ok: false,
      reason: `HEAD is not a Rune-managed commit ("${subject.out.slice(0, 60)}") — nothing to undo`,
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
      reason: "the Rune-managed commit is the only commit — cannot reset past it",
    };

  const sha = git(root, ["rev-parse", "HEAD"]).out;
  const reset = git(root, ["reset", "--hard", "HEAD~1"]);
  if (!reset.ok) return { ok: false, reason: `git reset failed: ${reset.out}` };

  return { ok: true, undoneSha: sha.slice(0, 7), subject: subject.out };
}

// ─── The review workspace (P3.5) ───
//
// Every git operation the desktop's Review tab performs lives here, next to the
// safety rules above and for the same reason: git plumbing scattered across a
// UI layer is how a "revert this file" button ends up running `checkout .`.
// The UI names paths; this file decides what may happen to them.

export interface ChangedFile {
  path: string;
  /** Porcelain status: "M", "A", "D", "??", "R" … */
  status: string;
  added: number;
  removed: number;
  /** True when git has never seen this path, so reverting means deleting it. */
  untracked: boolean;
}

/**
 * Parse `git status --porcelain=v1`.
 *
 * Column arithmetic (`slice(0, 2)`, `slice(3)`) is the obvious way to read this
 * and it is wrong here, because `git()` above trims the whole output: a first
 * line of ` M edited.ts` loses its leading space and every subsequent slice is
 * off by one, silently, on exactly one file. Matching the code instead of
 * counting columns is immune to that.
 */
function parsePorcelain(out: string): Array<{ code: string; path: string; untracked: boolean }> {
  const rows: Array<{ code: string; path: string; untracked: boolean }> = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([ MADRCU!?]{1,2})\s+(.+)$/.exec(line);
    if (!m) continue;
    const code = m[1]!;
    // A rename reads `R  old -> new`; the new path is the one on disk.
    const raw = m[2]!;
    const arrow = raw.indexOf(" -> ");
    rows.push({
      code,
      path: arrow === -1 ? raw : raw.slice(arrow + 4),
      untracked: code.includes("?"),
    });
  }
  return rows;
}

export interface WorkspaceDiff {
  repo: boolean;
  branch?: string;
  files: ChangedFile[];
  /** Unified diff for the whole working tree, tracked files only. */
  patch: string;
  reason?: string;
}

/**
 * What has changed in the working tree, and by how much.
 *
 * Deliberately the WORKING TREE and not "the files this run wrote": a person
 * reviewing an agent's work needs to see everything that differs from the last
 * commit, including anything they changed themselves. Attributing a change to
 * the run is the transcript's job; this is the tree's own answer.
 */
export function workspaceDiff(root: string, maxPatchBytes = 400_000): WorkspaceDiff {
  if (!isGitRepo(root)) {
    return { repo: false, files: [], patch: "", reason: "not a git repository" };
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return { repo: true, files: [], patch: "", reason: status.out };

  const numstat = git(root, ["diff", "HEAD", "--numstat"]);
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    counts.set(m[3]!, {
      added: m[1] === "-" ? 0 : Number(m[1]),
      removed: m[2] === "-" ? 0 : Number(m[2]),
    });
  }

  const files: ChangedFile[] = [];
  for (const entry of parsePorcelain(status.out)) {
    const count = counts.get(entry.path) ?? { added: 0, removed: 0 };
    files.push({
      path: entry.path,
      status: entry.code.trim() || "M",
      added: count.added,
      removed: count.removed,
      untracked: entry.untracked,
    });
  }

  const diff = git(root, ["diff", "HEAD"]);
  // A patch that takes a second to paint is not a review aid. Truncation is
  // announced in the payload rather than silently returning half a hunk.
  const patch =
    diff.out.length > maxPatchBytes
      ? diff.out.slice(0, maxPatchBytes) + "\n… diff truncated; open the file to see the rest\n"
      : diff.out;

  return { repo: true, branch, files, patch };
}

export type RevertResult = { ok: true; reverted: string[] } | { ok: false; reason: string };

/**
 * Revert exactly the named paths, and nothing else.
 *
 * Three rules, each there because the naive version eats work:
 *
 *  - Only paths INSIDE the workspace. A `..` or a leading `/` arriving from a
 *    UI is either a bug or an attack; either way it does not touch the disk.
 *  - A tracked path is restored from HEAD, one `git checkout HEAD -- <path>`
 *    per path. Never `checkout .`, never a pathspec the caller composed.
 *  - An untracked path is DELETED, because that is what "revert" means for a
 *    file git has never seen — stated here rather than discovered afterwards.
 */
export function revertPaths(root: string, paths: string[]): RevertResult {
  if (paths.length === 0) return { ok: false, reason: "no paths given" };
  if (!isGitRepo(root)) return { ok: false, reason: "not a git repository" };

  for (const p of paths) {
    if (p.startsWith("/") || p.split("/").includes("..") || p.startsWith("-")) {
      return { ok: false, reason: `refusing a path outside the workspace: ${p}` };
    }
  }

  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return { ok: false, reason: `git unavailable: ${status.out}` };
  const untracked = new Set(
    parsePorcelain(status.out)
      .filter((r) => r.untracked)
      .map((r) => r.path),
  );

  const reverted: string[] = [];
  for (const p of paths) {
    if (untracked.has(p)) {
      const rm = git(root, ["clean", "-f", "--", p]);
      if (!rm.ok) return { ok: false, reason: `could not remove ${p}: ${rm.out}` };
      reverted.push(p);
      continue;
    }
    // `--` before the path so a filename that looks like a flag stays a filename.
    const restore = git(root, ["checkout", "HEAD", "--", p]);
    if (!restore.ok) return { ok: false, reason: `could not revert ${p}: ${restore.out}` };
    reverted.push(p);
  }
  return { ok: true, reverted };
}
