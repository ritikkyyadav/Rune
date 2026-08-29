// ─── The parent-commit check ───
//
// `verified` is defined in brief.ts as "a test that failed on the parent
// commit passes now". The runtime used to award it from something weaker: the
// same command failing and then passing WITHIN one session. Those are not the
// same claim, and the gap between them is the most common shape of agent work
// there is — the agent edits, breaks a test, fixes its own break, and the test
// goes red→green without the change ever being the reason it passes now. The
// parent commit was green the whole time. The receipt said otherwise.
//
// So the runtime does the work instead of inferring it. It checks out the
// pre-change tree in a DETACHED WORKTREE — never `git stash`, never the user's
// working tree, which must survive a crash here untouched — runs the same
// command there, and reports what happened.
//
// The hard part is not running the command. It is refusing to lie when the
// answer is unclear: a parent tree has no node_modules, no build output, no
// virtualenv. A command that fails there because nothing is installed looks
// exactly like a command that fails there because the bug was real, and
// treating the first as the second manufactures the precise false receipt this
// module exists to abolish. Anything that smells of a missing environment
// comes back INCONCLUSIVE, and inconclusive never yields `verified`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GEAR_COMMIT_PREFIX } from "./git-undo";

/** What running a check against the pre-change tree established. */
export type ParentCheckStatus = "failed" | "passed" | "inconclusive";

export interface ParentCheckResult {
  status: ParentCheckStatus;
  /** The commit the check actually ran against. Absent when it never ran. */
  commit?: string;
  /** Why, in one line — for inconclusive, and for the receipt. */
  reason?: string;
}

function git(cwd: string, args: string[], timeoutMs = 30_000) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/**
 * Signatures of "this tree was never set up", as opposed to "this check
 * genuinely failed". Exit 127 is the strongest single signal (the shell could
 * not find the program at all); the rest catch the dependency managers whose
 * absence a fresh checkout guarantees.
 */
const ENV_FAILURE = new RegExp(
  [
    "command not found",
    "cannot find module",
    "module_not_found",
    "modulenotfounderror",
    "no such file or directory",
    "enoent",
    "is not recognized as an internal or external command",
    "could not determine executable to run",
    "no lockfile found",
    "cargo\\.lock.*not found",
    "go: cannot find main module",
    "virtualenv|no module named",
  ].join("|"),
  "i",
);

function looksLikeMissingEnvironment(exitCode: number, output: string): boolean {
  if (exitCode === 127) return true;
  return ENV_FAILURE.test(output);
}

/**
 * The commit representing the tree BEFORE this session's changes.
 *
 * Normally that is HEAD: the agent's edits are uncommitted, so HEAD is
 * untouched by them. The exception is a landed auto-commit — `[git] autoCommit`
 * makes each run one revertible commit, so when HEAD is a Gear commit the
 * pre-change tree is its parent.
 */
export function resolveParentCommit(repoRoot: string): { sha: string; ref: string } | null {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) return null;

  const subject = git(repoRoot, ["log", "-1", "--pretty=%s"]);
  if (subject.ok && subject.stdout.startsWith(GEAR_COMMIT_PREFIX)) {
    const parent = git(repoRoot, ["rev-parse", "HEAD~1"]);
    // A Gear commit with no parent means the repo's first commit is ours;
    // there is no pre-change tree to compare against.
    if (!parent.ok || !parent.stdout) return null;
    return { sha: parent.stdout, ref: "HEAD~1" };
  }
  return { sha: head.stdout, ref: "HEAD" };
}

/**
 * Run `command` against the pre-change tree and report what happened.
 *
 * Never mutates the caller's working tree: the check runs inside a detached
 * worktree in the OS temp dir, which is removed in a finally block whatever
 * happens. Every failure path returns `inconclusive` rather than throwing —
 * an evidence probe that cannot answer must say so, not take the run down.
 */
export function runOnParentCommit(
  repoRoot: string,
  command: string,
  timeoutMs = 120_000,
): ParentCheckResult {
  const parent = resolveParentCommit(repoRoot);
  if (!parent) {
    return { status: "inconclusive", reason: "no parent commit to compare against" };
  }

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "gear-parent-check-"));
    const checkout = join(dir, "tree");
    const added = git(repoRoot, ["worktree", "add", "--detach", checkout, parent.sha], 60_000);
    if (!added.ok) {
      return {
        status: "inconclusive",
        commit: parent.sha,
        reason: `could not check out ${parent.ref}: ${added.stderr.slice(0, 160)}`,
      };
    }

    try {
      const res = spawnSync("bash", ["-c", command], {
        cwd: checkout,
        encoding: "utf8",
        timeout: timeoutMs,
        env: { ...process.env },
      });
      const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;

      if (res.signal || res.error) {
        return {
          status: "inconclusive",
          commit: parent.sha,
          reason: `check did not complete on ${parent.ref} (${res.signal ?? res.error?.message})`,
        };
      }
      const exitCode = res.status ?? 1;
      if (exitCode === 0) {
        return {
          status: "passed",
          commit: parent.sha,
          reason: `already passed on ${parent.ref} — this change is not why it passes`,
        };
      }
      if (looksLikeMissingEnvironment(exitCode, output)) {
        return {
          status: "inconclusive",
          commit: parent.sha,
          reason: `the ${parent.ref} tree is not set up to run this check (exit ${exitCode})`,
        };
      }
      return { status: "failed", commit: parent.sha, reason: `exit ${exitCode} on ${parent.ref}` };
    } finally {
      // Detach the worktree registration before the directory disappears, or
      // git keeps a stale entry in .git/worktrees forever.
      git(repoRoot, ["worktree", "remove", "--force", checkout], 30_000);
    }
  } catch (err) {
    return {
      status: "inconclusive",
      commit: parent.sha,
      reason: `parent check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}
