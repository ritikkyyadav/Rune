/**
 * Git auto-commit + /undo: every successful run's writes land as ONE
 * revertible "rune:" commit, and undo can only ever discard a Rune commit —
 * never user work. Each guard here corresponds to a way the naive version
 * would eat someone's changes.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  autoCommitPaths,
  undoLastRuneCommit,
  isGitRepo,
} from "../../../packages/orchestrator/src/git-undo";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "git-undo-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@test.local"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "-qm", "seed"]);
  return root;
}

let root: string;
beforeEach(() => {
  root = makeRepo();
});

describe("autoCommitPaths", () => {
  test("commits exactly the written paths with a rune: subject", () => {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "unrelated.txt"), "user's own uncommitted file\n");

    const r = autoCommitPaths(root, ["a.ts"], "add the a constant");
    expect(r.committed).toBe(true);
    if (!r.committed) return;
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("rune: add the a constant");
    // Only a.ts landed; the user's file stays untracked and untouched.
    expect(git(root, ["show", "--name-only", "--pretty=format:", "HEAD"]).trim()).toBe("a.ts");
    expect(git(root, ["status", "--porcelain"])).toContain("unrelated.txt");
  });

  test("refuses when the user has STAGED changes (protects their half-built commit)", () => {
    writeFileSync(join(root, "user.txt"), "user work\n");
    git(root, ["add", "user.txt"]);
    writeFileSync(join(root, "rune.txt"), "agent work\n");

    const r = autoCommitPaths(root, ["rune.txt"], "task");
    expect(r.committed).toBe(false);
    if (r.committed) return;
    expect(r.reason).toContain("staged changes");
    // Their staging area is untouched.
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("user.txt");
  });

  test("declines cleanly when nothing effectively changed", () => {
    // seed.txt already committed with identical content → nothing to commit.
    const r = autoCommitPaths(root, ["seed.txt"], "noop");
    expect(r.committed).toBe(false);
    if (r.committed) return;
    expect(r.reason).toBe("no effective changes");
  });

  test("declines outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-git-"));
    writeFileSync(join(dir, "x.txt"), "x\n");
    const r = autoCommitPaths(dir, ["x.txt"], "task");
    expect(r.committed).toBe(false);
    expect(isGitRepo(dir)).toBe(false);
  });
});

describe("undoLastRuneCommit", () => {
  test("resets a rune commit and restores the file state", () => {
    writeFileSync(join(root, "a.ts"), "broken\n");
    const c = autoCommitPaths(root, ["a.ts"], "bad change");
    expect(c.committed).toBe(true);

    const r = undoLastRuneCommit(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toBe("rune: bad change");
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("seed");
    // The rune-written file is gone from the worktree again.
    expect(() => readFileSync(join(root, "a.ts"))).toThrow();
  });

  test("still undoes a commit made under the previous name", () => {
    writeFileSync(join(root, "a.ts"), "pre-rename\n");
    git(root, ["add", "a.ts"]);
    git(root, ["commit", "-q", "--no-verify", "-m", "gear: pre-rename change"]);
    const r = undoLastRuneCommit(root);
    expect(r.ok).toBe(true);
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("seed");
  });

  test("refuses when HEAD is not a rune commit", () => {
    const r = undoLastRuneCommit(root); // HEAD = "seed"
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not a Rune-managed commit");
  });

  test("refuses when the worktree is dirty (reset --hard would eat user edits)", () => {
    writeFileSync(join(root, "a.ts"), "v1\n");
    expect(autoCommitPaths(root, ["a.ts"], "task").committed).toBe(true);
    // User edits after the commit:
    writeFileSync(join(root, "seed.txt"), "user edited this\n");

    const r = undoLastRuneCommit(root);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("uncommitted changes");
    // Their edit survived.
    expect(readFileSync(join(root, "seed.txt"), "utf8")).toBe("user edited this\n");
  });

  test("refuses when the rune commit has no parent", () => {
    const bare = mkdtempSync(join(tmpdir(), "git-undo-root-"));
    git(bare, ["init", "-q"]);
    git(bare, ["config", "user.email", "t@t"]);
    git(bare, ["config", "user.name", "T"]);
    writeFileSync(join(bare, "only.txt"), "x\n");
    expect(autoCommitPaths(bare, ["only.txt"], "first ever").committed).toBe(true);

    const r = undoLastRuneCommit(bare);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("only commit");
  });
});
