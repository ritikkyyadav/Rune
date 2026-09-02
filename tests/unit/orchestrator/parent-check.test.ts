/**
 * The parent-commit probe, against real git.
 *
 * `verified` claims "a test that failed on the parent commit passes now". The
 * runtime used to infer that from in-session red→green, which is a different
 * and much weaker fact. This module makes the measurement instead — in a
 * detached worktree, so the user's working tree is never touched — and these
 * tests hold it to the two properties that matter:
 *
 *   1. it distinguishes a genuine parent failure from a parent that was green;
 *   2. it refuses to call a missing environment a failure, because doing so
 *      would manufacture exactly the false receipt the probe exists to prevent.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runOnParentCommit,
  resolveParentCommit,
} from "../../../packages/orchestrator/src/parent-check";

let repo: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gear-parent-check-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Gear Test");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Commit a `check.sh` that exits with `code`. */
function commitCheck(code: number, message: string): void {
  writeFileSync(join(repo, "check.sh"), `#!/bin/sh\nexit ${code}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/**
 * POSIX-only: the fixture check IS `sh check.sh`, and the subject is "did this
 * check pass on the PARENT commit", not the shell that ran it. Windows has no
 * `sh`; a `.cmd` fixture would exercise the same logic through a different
 * shell, which is worth doing when someone runs Gear's verifier on Windows and
 * not before. Logged in docs/program/backlog.md.
 */
const POSIX_SHELL = process.platform !== "win32";

describe.skipIf(!POSIX_SHELL)("runOnParentCommit", () => {
  test("a check that FAILS on the parent commit is reported as failed", () => {
    commitCheck(1, "broken check");
    // The working tree now "fixes" it — uncommitted, as agent work usually is.
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");

    const result = runOnParentCommit(repo, "sh check.sh");
    expect(result.status).toBe("failed");
    expect(result.commit).toBe(git("rev-parse", "HEAD"));
  });

  test("a check that already PASSED on the parent is reported as passed", () => {
    commitCheck(0, "green check");
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");

    const result = runOnParentCommit(repo, "sh check.sh");
    expect(result.status).toBe("passed");
    expect(result.reason).toContain("not why it passes");
  });

  test("a missing program is INCONCLUSIVE, never a parent failure", () => {
    // Exit 127. Under a naive implementation this reads as "the check failed
    // on the parent", which would mint `verified` for a change that fixed
    // nothing — the precise false receipt this module exists to prevent.
    commitCheck(0, "base");

    const result = runOnParentCommit(repo, "gear-definitely-not-a-real-binary --version");
    expect(result.status).toBe("inconclusive");
  });

  test("a missing dependency is INCONCLUSIVE, not a parent failure", () => {
    commitCheck(0, "base");

    const result = runOnParentCommit(
      repo,
      "sh -c 'echo \"Error: Cannot find module foo\" >&2; exit 1'",
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("not set up");
  });

  test("the user's working tree is untouched, and no worktree is left behind", () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(repo, "uncommitted-scratch.txt"), "precious");

    const before = git("status", "--porcelain");
    const result = runOnParentCommit(repo, "sh check.sh");

    expect(result.status).toBe("failed");
    // Nothing stashed, nothing reverted, nothing swept.
    expect(git("status", "--porcelain")).toBe(before);
    expect(existsSync(join(repo, "uncommitted-scratch.txt"))).toBe(true);
    // And no stale registration in .git/worktrees.
    const wt = join(repo, ".git", "worktrees");
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });

  test("a repo with no commits cannot answer, and says so instead of guessing", () => {
    const result = runOnParentCommit(repo, "true");
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("no parent commit");
  });
});

describe.skipIf(!POSIX_SHELL)("resolveParentCommit", () => {
  test("HEAD is the pre-change tree when the agent's work is uncommitted", () => {
    commitCheck(0, "base");
    expect(resolveParentCommit(repo)).toEqual({ sha: git("rev-parse", "HEAD"), ref: "HEAD" });
  });

  test("a landed Gear auto-commit shifts the comparison to HEAD~1", () => {
    commitCheck(1, "base");
    const base = git("rev-parse", "HEAD");
    // [git] autoCommit lands the run as one commit with this exact prefix.
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "gear: fix the check");

    expect(resolveParentCommit(repo)).toEqual({ sha: base, ref: "HEAD~1" });
  });

  test("a Gear commit that is the repo's first commit has no parent to compare", () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "gear: initial");

    expect(resolveParentCommit(repo)).toBeNull();
  });
});
