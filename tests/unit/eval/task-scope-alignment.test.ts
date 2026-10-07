/**
 * The product's reading of a request's boundary and the benchmark's scope rule
 * have to agree — about every task, in both directions.
 *
 * The benchmark scores a no-code task 0 for scope when anything other than the
 * files it asked for changes (`scoreScope`, `noCode` + `expectedNewFiles`).
 * H2 makes the product HOLD a run to the boundary its request states. If the
 * two read a prompt differently, one of them is wrong: either the product
 * blocks work a coding task needs, or it lets through what the scorer will
 * count as a violation.
 *
 * Every task the comparison can run is here — the 18 small tasks across the
 * corpus and the supplement, and the 30 mined serious tasks.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { UNRESTRICTED, taskScope } from "../../../packages/orchestrator/src/task-scope";
import { corpusParityTasks } from "../../eval/parity/corpus-source";
import { seriousTasks } from "../../eval/serious/source";

const REPO = join(import.meta.dir, "..", "..", "..");
const small = [
  ...corpusParityTasks(join(REPO, "tests/eval/corpus")),
  ...corpusParityTasks(join(REPO, "tests/eval/parity-tasks")),
];
const serious = seriousTasks({ repoRoot: REPO });

describe("task scope ↔ the benchmark's scope contract", () => {
  test("the sample is the whole comparison: 18 small tasks and 30 serious ones", () => {
    expect(small.length).toBe(18);
    expect(serious.length).toBe(30);
    expect(small.filter((t) => t.noCode).length).toBeGreaterThanOrEqual(3);
  });

  test.each(small.filter((t) => t.noCode).map((t) => [t.id, t] as const))(
    "no-code task %s: the product reads the same boundary, and the same allowed files",
    (_id, task) => {
      const scope = taskScope(task.prompt);
      expect(scope.mode).toBe("no_code");
      expect([...scope.outputs].sort()).toEqual([...(task.expectedNewFiles ?? [])].sort());
    },
  );

  test.each(small.filter((t) => !t.noCode).map((t) => [t.id, t] as const))(
    "coding task %s: no boundary is read into it",
    (_id, task) => {
      expect(taskScope(task.prompt)).toBe(UNRESTRICTED);
    },
  );

  test("no mined serious task is read as no-code — every one of them needs a fix written", () => {
    const narrowed = serious.filter((t) => taskScope(t.prompt).mode === "no_code").map((t) => t.id);
    expect(narrowed).toEqual([]);
  });
});
