import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkerWorktree,
  mergeWorkerWorktree,
  removeWorkerWorktree,
  runWorktreeChecks,
} from "../../../packages/orchestrator/src/worker-worktree";

/**
 * P6B.1 / P6B.2 — a worker gets a filesystem, and it verifies its own slice.
 *
 * These tests build real git repositories. The behaviour under test is git
 * behaviour, and a mock would assert my beliefs about git rather than git.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-wt-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "# base\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

describe("P6B.1 — the worktree is seeded from the working tree, not from HEAD", () => {
  test("the lead's uncommitted work is visible to the worker", () => {
    const repo = makeRepo();
    // The lead writes an interface and does NOT commit it. This is the whole
    // reason `git worktree add … HEAD` was not good enough: a worker that
    // cannot see the interface the lead just wrote will re-invent it.
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\nexport type Api = {};\n");

    const wt = createWorkerWorktree(repo, "w1");
    expect(wt).not.toBeNull();
    expect(wt!.seededFromWorkingTree).toBe(true);
    const seen = readFileSync(join(wt!.path, "src", "base.ts"), "utf8");
    expect(seen).toContain("export type Api");
    removeWorkerWorktree(repo, wt!, false);
  });

  test("a clean tree still produces a worktree", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w2");
    expect(wt).not.toBeNull();
    expect(existsSync(join(wt!.path, "README.md"))).toBe(true);
    removeWorkerWorktree(repo, wt!, false);
  });

  test("a non-repository yields null rather than throwing", () => {
    // Losing delegation entirely because a directory is not a git repository
    // would be far worse than losing isolation.
    const dir = mkdtempSync(join(tmpdir(), "gear-nonrepo-"));
    dirs.push(dir);
    expect(createWorkerWorktree(dir, "w3")).toBeNull();
  });

  test("two workers get separate filesystems", () => {
    const repo = makeRepo();
    const a = createWorkerWorktree(repo, "w1")!;
    const b = createWorkerWorktree(repo, "w2")!;
    expect(a.path).not.toBe(b.path);
    writeFileSync(join(a.path, "src", "a.ts"), "a");
    // The collision that kept workers from having a shell cannot happen here.
    expect(existsSync(join(b.path, "src", "a.ts"))).toBe(false);
    removeWorkerWorktree(repo, a, false);
    removeWorkerWorktree(repo, b, false);
  });
});

describe("P6B.1 — merge back on the owned paths only", () => {
  test("the worker's files land in the lead's tree", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    mkdirSync(join(wt.path, "src"), { recursive: true });
    writeFileSync(join(wt.path, "src", "feature.ts"), "export const feature = true;\n");

    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "add the feature");
    expect(merge.merged).toBe(true);
    expect(merge.conflicts).toEqual([]);
    expect(merge.manifest).toEqual(["src/feature.ts"]);
    expect(readFileSync(join(repo, "src", "feature.ts"), "utf8")).toContain("feature = true");
    removeWorkerWorktree(repo, wt, false);
  });

  test("files outside the owned set are not taken", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "owned\n");
    writeFileSync(join(wt.path, "src", "stowaway.ts"), "not owned\n");

    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "add the feature");
    expect(merge.manifest).toEqual(["src/feature.ts"]);
    // Ownership governs which paths may move; the worktree only governs where
    // they were written.
    expect(existsSync(join(repo, "src", "stowaway.ts"))).toBe(false);
    removeWorkerWorktree(repo, wt, false);
  });

  test("nothing written is a clean, empty merge rather than a failure", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "did nothing");
    expect(merge.merged).toBe(true);
    expect(merge.manifest).toEqual([]);
    removeWorkerWorktree(repo, wt, false);
  });

  test("merged files are not left staged in the lead's tree", () => {
    // A surprise staged set makes the lead's own auto-commit refuse, to
    // protect work it thinks the user staged.
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
    removeWorkerWorktree(repo, wt, false);
  });
});

describe("P6B.1 — teardown", () => {
  test("the checkout goes and the branch survives when asked", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");

    removeWorkerWorktree(repo, wt, true);
    expect(existsSync(wt.path)).toBe(false);
    // The branch is the only copy of a failed worker's build.
    expect(git(repo, ["branch", "--list", wt.branch])).toContain("gear/worker-w1");
  });

  test("the branch goes too when the work landed", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");
    removeWorkerWorktree(repo, wt, false);
    expect(git(repo, ["branch", "--list", wt.branch])).toBe("");
  });
});

describe("P6B.2 — the worker runs the project's checks in its own tree", () => {
  test("a passing check reports passed", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    const res = runWorktreeChecks(wt.path, ["true"], 10_000);
    expect(res.outcome).toBe("passed");
    expect(res.failures).toEqual([]);
    removeWorkerWorktree(repo, wt, false);
  });

  test("a failing check reports failed and names the command", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    const res = runWorktreeChecks(wt.path, ["echo boom >&2; exit 3"], 10_000);
    expect(res.outcome).toBe("failed");
    expect(res.failures[0]).toContain("exit 3");
    expect(res.failures[0]).toContain("boom");
    removeWorkerWorktree(repo, wt, false);
  });

  test("no configured checks is not_run, never a silent pass", () => {
    // The difference between "checks passed" and "no checks exist" is the
    // difference between a report and a claim.
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    expect(runWorktreeChecks(wt.path, [], 10_000).outcome).toBe("not_run");
    removeWorkerWorktree(repo, wt, false);
  });

  test("checks run in the worktree, not in the lead's tree", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "marker.txt"), "in the worktree\n");
    const res = runWorktreeChecks(wt.path, ["test -f marker.txt"], 10_000);
    expect(res.outcome).toBe("passed");
    expect(existsSync(join(repo, "marker.txt"))).toBe(false);
    removeWorkerWorktree(repo, wt, false);
  });
});
