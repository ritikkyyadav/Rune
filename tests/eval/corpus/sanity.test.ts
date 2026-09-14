// ─── The corpus's fixture sanity check ───
//
// An acceptance file nobody has ever seen pass is not an oracle; it is an
// assertion. This check materialises each of the twelve tasks into a scratch
// checkout, lays a HAND-WRITTEN CORRECT solution over it, and runs the task's
// own acceptance commands. All green means the acceptance measures the work
// rather than the fixture, and a later red row in the offline report is about
// the run, not about the criterion being impossible.
//
// It also pins the four fixtures reused from `tests/eval/comparison/tasks.ts`:
// a corpus that silently drifts from the comparison rig is two corpora.
//
// The two frontend tasks need a browser. Without `RUNE_BENCH_PLAYWRIGHT` they
// are SKIPPED and reported as skipped — never counted as passing.
//
// Zero model calls: nothing here constructs an Engine.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMPARISON_TASKS } from "../comparison/tasks";
import {
  SCENARIOS,
  TASK_IDS,
  applyTree,
  browserAvailable,
  loadAcceptance,
  loadScenario,
  loadTask,
  materialise,
  solutionFiles,
  type CorpusTask,
} from "./corpus";

const FAMILIES = new Set([
  "fix",
  "omission-prone-feature",
  "migration",
  "frontend",
  "research",
  "dirty-worktree",
]);

/** Run one acceptance command the way the runtime does: in the workspace, via a shell. */
function runAcceptance(command: string, root: string): { code: number; output: string } {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function scratch(task: CorpusTask): { root: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `corpus-${task.id}-`));
  const root = join(dir, "workspace");
  materialise(task, root);
  return { root, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the corpus is twelve well-formed tasks", () => {
  test("every pinned id has a directory, and every directory is pinned", () => {
    expect(TASK_IDS.length).toBe(12);
    for (const id of TASK_IDS)
      expect(existsSync(join(import.meta.dir, id, "task.json"))).toBe(true);
    // `tasks.json` is the same list as data, for the live runner's `--corpus`,
    // which reads the corpus without importing it. Two lists that can disagree
    // are one list and one bug.
    expect(JSON.parse(readFileSync(join(import.meta.dir, "tasks.json"), "utf8"))).toEqual([
      ...TASK_IDS,
    ]);
  });

  test("each task declares a family, a prompt, fixture files and five scenarios", () => {
    const counts: Record<string, number> = {};
    for (const id of TASK_IDS) {
      const task = loadTask(id);
      expect(task.id).toBe(id);
      expect(FAMILIES.has(task.family)).toBe(true);
      expect(task.prompt.length).toBeGreaterThan(80);
      expect(task.files.length).toBeGreaterThan(0);
      counts[task.family] = (counts[task.family] ?? 0) + 1;

      const acceptance = loadAcceptance(task);
      expect(acceptance.length).toBeGreaterThan(0);
      for (const criterion of acceptance) {
        expect(criterion.text.length).toBeGreaterThan(10);
        expect(criterion.command).toBeTruthy();
      }
      // The solution is what makes the acceptance falsifiable.
      expect(solutionFiles(task).length).toBeGreaterThan(0);
      for (const name of SCENARIOS) {
        const scenario = loadScenario(task, name);
        expect(scenario.scenario).toBe(name);
        expect(scenario.turns.length).toBeGreaterThan(0);
        expect(scenario.note.length).toBeGreaterThan(10);
      }
    }
    // The family table is part of the protocol, so it is asserted, not assumed.
    expect(counts).toEqual({
      fix: 3,
      "omission-prone-feature": 2,
      migration: 2,
      frontend: 2,
      research: 2,
      "dirty-worktree": 1,
    });
  });

  test("the four reused fixtures are byte-identical to the comparison rig's", () => {
    for (const id of [
      "csv-state-machine",
      "working-tree-integration",
      "dependent-migration",
      "responsive-project-board",
    ]) {
      const task = loadTask(id);
      const original = COMPARISON_TASKS.find((row) => row.id === id)!;
      expect(task.prompt).toBe(original.prompt);
      expect(task.files).toEqual(Object.keys(original.files).sort());
      for (const [path, value] of Object.entries(original.files))
        expect(readFileSync(join(task.dir, "fixture", path), "utf8")).toBe(value);
      for (const [path, value] of Object.entries(original.untracked ?? {}))
        expect(readFileSync(join(task.dir, "untracked", path), "utf8")).toBe(value);
      expect(Boolean(task.browser)).toBe(Boolean(original.browser));
    }
  });

  test("a materialised task is a committed fixture with the checks beside it, ignored", () => {
    const task = loadTask("working-tree-integration");
    const { root, done } = scratch(task);
    try {
      expect(existsSync(join(root, ".rune-acceptance", "check.mjs"))).toBe(true);
      // The untracked API is untracked, which is the whole fixture.
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
      expect(status.stdout).toContain("?? money.ts");
      expect(status.stdout).not.toContain(".rune-acceptance");
    } finally {
      done();
    }
  });
});

describe("each task's acceptance passes against a hand-written correct solution", () => {
  for (const id of TASK_IDS) {
    const task = loadTask(id);
    const needsBrowser = Boolean(task.browser);
    const runner = needsBrowser && !browserAvailable() ? test.skip : test;
    runner(
      `${id} (${task.family})${needsBrowser ? " [browser]" : ""}`,
      () => {
        const { root, done } = scratch(task);
        try {
          applyTree(task, root, "solution");
          const failures: string[] = [];
          for (const criterion of loadAcceptance(task)) {
            const { code, output } = runAcceptance(criterion.command!, root);
            if (code !== 0)
              failures.push(`${criterion.id}: exit ${code}\n${output.trim().slice(-600)}`);
          }
          expect(failures).toEqual([]);
        } finally {
          done();
        }
      },
      240_000,
    );
  }
});
