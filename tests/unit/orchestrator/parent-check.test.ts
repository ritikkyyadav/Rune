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
  couldNotRunOnParent,
  namedPathsAbsentOnParent,
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
  repo = mkdtempSync(join(tmpdir(), "rune-parent-check-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Rune Test");
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
 * shell, which is worth doing when someone runs Rune's verifier on Windows and
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

    const result = runOnParentCommit(repo, "rune-definitely-not-a-real-binary --version");
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

  test("a landed Rune auto-commit shifts the comparison to HEAD~1", () => {
    commitCheck(1, "base");
    const base = git("rev-parse", "HEAD");
    // [git] autoCommit lands the run as one commit with this exact prefix.
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "rune: fix the check");

    expect(resolveParentCommit(repo)).toEqual({ sha: base, ref: "HEAD~1" });
  });

  test("a Rune commit that is the repo's first commit has no parent to compare", () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "rune: initial");

    expect(resolveParentCommit(repo)).toBeNull();
  });
});

// ─── "It failed on the parent" must not be satisfiable by absence ───
//
// V-5B, F2: a brand-new test file exits non-zero at the parent commit because
// it is not there, and the ladder read that exit code as the reproduction of a
// bug. Two independent readings close it — what the runner SAID, and what the
// command NAMED — and both are held to examples here, because the vocabulary
// is the whole content of the distinction.

describe("couldNotRunOnParent", () => {
  const collectedNothing: Array<[string, string]> = [
    ["bun", "bun test v1.3.14\n\n 0 pass\n 0 fail\nRan 0 tests across 0 files."],
    ["pytest", "===== test session starts =====\ncollected 0 items\n\n==== no tests ran ===="],
    ["jest", "Test Suites: 0 total\nTests:       0 total\nSnapshots:   0 total"],
    ["cargo", "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored"],
    ["go", "?   example.com/pkg\t[no test files]"],
    ["npm script", "npm error Missing script: \"check:csv\""],
    ["python", "python3: can't open file '/tmp/x/new_check.py': [Errno 2] No such file"],
    ["node --test", "node --test\nno test files found"],
    ["an unknown subcommand", "error: unknown command 'verify'"],
    ["a usage error", "usage: check [-v] <path>"],
  ];
  for (const [runner, output] of collectedNothing) {
    test(`${runner} saying it ran nothing is not a parent failure`, () => {
      expect(couldNotRunOnParent(output)).toBe(true);
    });
  }

  test("a runner that ran and FAILED is left alone — this is the real evidence", () => {
    expect(couldNotRunOnParent(" 0 pass\n 3 fail\nRan 3 tests across 1 file.")).toBe(false);
    expect(couldNotRunOnParent("collected 12 items\n\nFAILED tests/test_csv.py::test_header")).toBe(
      false,
    );
    expect(couldNotRunOnParent("test result: FAILED. 4 passed; 1 failed; 0 ignored")).toBe(false);
    expect(couldNotRunOnParent("error TS2345: Argument of type X\n3 errors")).toBe(false);
  });
});

describe.skipIf(!POSIX_SHELL)("namedPathsAbsentOnParent", () => {
  test("a file the command names that the parent commit never had is reported", () => {
    commitCheck(0, "base");
    // Written but never committed — the shape of a brand-new test file.
    writeFileSync(join(repo, "forged.test.ts"), "// new\n");
    const sha = git("rev-parse", "HEAD");

    expect(namedPathsAbsentOnParent(repo, sha, "bun test forged.test.ts")).toEqual([
      "forged.test.ts",
    ]);
  });

  test("a file that existed at the parent draws no conclusion", () => {
    commitCheck(0, "base");
    const sha = git("rev-parse", "HEAD");
    expect(namedPathsAbsentOnParent(repo, sha, "sh check.sh")).toEqual([]);
  });

  test("a word that is not a file here is never read as a missing file there", () => {
    commitCheck(0, "base");
    const sha = git("rev-parse", "HEAD");
    // Flags, bare program names, a path missing on BOTH sides, and tokenising
    // artefacts all have to draw nothing, or every command names a ghost.
    expect(
      namedPathsAbsentOnParent(repo, sha, "node --test --reporter=dot console.log a,b,c ./nope.ts"),
    ).toEqual([]);
  });

  test("the end-to-end probe calls a new file's failure NOT-APPLICABLE, not failed", () => {
    commitCheck(0, "base");
    // A check that did not exist at the parent commit: `sh new-check.sh` exits
    // non-zero there because the file is absent, which says nothing about the
    // change under test.
    writeFileSync(join(repo, "new-check.sh"), "#!/bin/sh\nexit 0\n");

    const result = runOnParentCommit(repo, "sh new-check.sh 2>/dev/null; exit 1");
    expect(result.status).toBe("not-applicable-on-parent");
    expect(result.reason).toContain("new-check.sh");
  });
});
