import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunWorktree,
  isGitRepo,
  listRunWorktrees,
  removeRunWorktree,
} from "../../../packages/orchestrator/src/worktree";

// P6 acceptance: two concurrent detached runs on the same repo do not touch
// each other's files — each gets its own checkout on its own branch.

let repo: string;

function sh(args: string[]): void {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "alan-worktree-"));
  sh(["init", "-q"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "t"]);
  writeFileSync(join(repo, "shared.txt"), "base content\n");
  sh(["add", "."]);
  sh(["commit", "-qm", "base"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("per-run worktree isolation", () => {
  test("two runs get disjoint checkouts of the same HEAD", () => {
    const runA = createRunWorktree(repo, "run-a");
    const runB = createRunWorktree(repo, "run-b");

    expect(runA.path).not.toBe(runB.path);
    expect(runA.branch).toBe("gear/run-run-a");
    // Both see the committed base…
    expect(readFileSync(join(runA.path, "shared.txt"), "utf8")).toBe("base content\n");
    expect(readFileSync(join(runB.path, "shared.txt"), "utf8")).toBe("base content\n");

    // …and writes in one are invisible in the other AND in the main tree.
    writeFileSync(join(runA.path, "only-a.txt"), "a was here\n");
    expect(existsSync(join(runB.path, "only-a.txt"))).toBe(false);
    expect(existsSync(join(repo, "only-a.txt"))).toBe(false);

    const listed = listRunWorktrees(repo);
    expect(listed.map((w) => w.branch).sort()).toEqual(["gear/run-run-a", "gear/run-run-b"]);
  });

  test("commits in a run worktree land on the run branch, mergeable later", () => {
    const run = createRunWorktree(repo, "feature-x");
    writeFileSync(join(run.path, "work.txt"), "done\n");
    const add = spawnSync("git", ["add", "."], { cwd: run.path });
    expect(add.status).toBe(0);
    const commit = spawnSync("git", ["commit", "-qm", "run work"], { cwd: run.path });
    expect(commit.status).toBe(0);

    // Merge-back is ordinary git from the main tree.
    sh(["merge", "-q", run.branch]);
    expect(readFileSync(join(repo, "work.txt"), "utf8")).toBe("done\n");
  });

  test("remove drops the checkout but keeps the branch (the work survives)", () => {
    const run = createRunWorktree(repo, "throwaway");
    removeRunWorktree(repo, "throwaway");
    expect(existsSync(run.path)).toBe(false);
    const branches = spawnSync("git", ["branch", "--list", run.branch], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(branches.stdout).toContain(run.branch);
  });

  test("duplicate run ids and non-repos refuse with clear errors", () => {
    createRunWorktree(repo, "dup");
    expect(() => createRunWorktree(repo, "dup")).toThrow(/already exists/);

    const notRepo = mkdtempSync(join(tmpdir(), "alan-notrepo-"));
    try {
      expect(isGitRepo(notRepo)).toBe(false);
      expect(() => createRunWorktree(notRepo, "x")).toThrow(/git repository/);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
