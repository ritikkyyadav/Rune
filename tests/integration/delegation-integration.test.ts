/**
 * M4 exit R6 — a correct patch on a changed destination is not "integrated".
 *
 * The claim (`docs/program/m4-repair-and-delegation.md`): "Integration is
 * verified, not assumed. After a child's patch lands, the runtime re-runs the
 * checks bound to the child's criteria on the combined tree, and compares the
 * destination revision to the one the child started from; if the destination
 * moved incompatibly … the run reports `not integrated` with the reason and
 * keeps the user's edits."
 *
 * Real git, real worktrees, a real merge. No model, no gateway, no network:
 * every run in this file is the mechanism itself, driven directly, because the
 * thing being tested is what happens to FILES and a model has no part in it.
 *
 * Needs the sandbox off: it runs `git` in a temporary directory.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkerWorktree,
  mergeWorkerWorktree,
  removeWorkerWorktree,
  treeRevision,
} from "../../packages/orchestrator/src/worker-worktree";
import { rmTemp } from "../helpers/tmp";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmTemp(dir);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with one file a worker will own, committed. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rune-delegation-"));
  temps.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "owned.ts"), "export const version = 1;\n");
  writeFileSync(join(root, "src", "other.ts"), "export const other = true;\n");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "rune@localhost"]);
  git(root, ["config", "user.name", "Rune"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base", "--no-verify"]);
  return root;
}

describe("R6 — the destination moved under the child", () => {
  test("the child's patch is NOT integrated, and the user's edit is kept", () => {
    const root = makeRepo();
    const startedFrom = treeRevision(root);

    // ── dispatch ──
    const wt = createWorkerWorktree(root, "w1")!;
    expect(wt).not.toBeNull();
    writeFileSync(join(wt.path, "src", "owned.ts"), "export const version = 2; // worker\n");

    // ── the lead (or the person) edits the same file, after dispatch ──
    const usersEdit = "export const version = 1; // USER-EDIT, keep me\n";
    writeFileSync(join(root, "src", "owned.ts"), usersEdit);

    // ── the merge back ──
    const merge = mergeWorkerWorktree(root, wt, ["src/owned.ts"], "build the version bump");
    expect(merge.merged).toBe(false);
    expect(merge.conflicts).toEqual(["src/owned.ts"]);

    // The user's edit STANDS. Not "mostly stands", not "stands except for the
    // hunk the worker also touched" — the merge checks the whole patch before
    // it writes anything, so a conflict leaves the destination untouched.
    expect(readFileSync(join(root, "src", "owned.ts"), "utf8")).toBe(usersEdit);

    // …and the worker's work is not lost either: it is on its branch, which is
    // the only copy of it and is where a person looks.
    const onBranch = git(root, ["show", `${merge.branch}:src/owned.ts`]);
    expect(onBranch).toContain("// worker");

    // The destination revision moved between dispatch and return, which is the
    // fact "not integrated" is derived from.
    const returnedTo = treeRevision(root);
    expect(startedFrom).not.toBe("");
    expect(returnedTo).not.toBe(startedFrom);
    expect(returnedTo).toContain("+dirty");

    removeWorkerWorktree(root, wt, true);
  });

  test("an UNTOUCHED destination integrates, and the revision says why it could", () => {
    const root = makeRepo();
    const wt = createWorkerWorktree(root, "w2")!;
    writeFileSync(join(wt.path, "src", "owned.ts"), "export const version = 2; // worker\n");

    // Nobody touched the destination this time.
    const merge = mergeWorkerWorktree(root, wt, ["src/owned.ts"], "build the version bump");
    expect(merge.merged).toBe(true);
    expect(merge.conflicts).toEqual([]);
    expect(merge.manifest).toEqual(["src/owned.ts"]);
    expect(readFileSync(join(root, "src", "owned.ts"), "utf8")).toContain("// worker");

    removeWorkerWorktree(root, wt, false);
  });

  test("an edit to a file the child does NOT own is not a conflict", () => {
    const root = makeRepo();
    const wt = createWorkerWorktree(root, "w3")!;
    writeFileSync(join(wt.path, "src", "owned.ts"), "export const version = 2; // worker\n");
    // The lead works on its own file while the child builds. That is the whole
    // point of ownership: it is not a conflict, and the merge must not read it
    // as one — a false "not integrated" throws a good build away.
    writeFileSync(join(root, "src", "other.ts"), "export const other = false; // lead\n");

    const merge = mergeWorkerWorktree(root, wt, ["src/owned.ts"], "build the version bump");
    expect(merge.merged).toBe(true);
    expect(merge.conflicts).toEqual([]);
    expect(readFileSync(join(root, "src", "other.ts"), "utf8")).toContain("// lead");
    expect(readFileSync(join(root, "src", "owned.ts"), "utf8")).toContain("// worker");

    removeWorkerWorktree(root, wt, false);
  });
});

describe("treeRevision — the stamp both sides of an integration are compared on", () => {
  test("a clean tree is its short HEAD; a dirty one says so", () => {
    const root = makeRepo();
    const clean = treeRevision(root);
    expect(clean).toMatch(/^[0-9a-f]{7,}$/);
    writeFileSync(join(root, "src", "other.ts"), "// touched\n");
    const dirty = treeRevision(root);
    expect(dirty).toBe(`${clean}+dirty`);
  });

  test("a directory that is not a repository claims nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-delegation-norepo-"));
    temps.push(dir);
    expect(treeRevision(dir)).toBe("");
  });
});
