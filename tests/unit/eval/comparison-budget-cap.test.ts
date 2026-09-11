/**
 * The comparison rig's live spend cap, on the competitor arm.
 *
 * This exists because the cap was DEAD and nothing said so. `runPilot` watched
 * OpenCode's stdout, priced each `step_finish` through `CostTracker.record` and
 * stopped the process once the ledger passed `--budget`. When P3B I1 moved
 * `record`'s attribution argument ahead of its timestamp, this one call site
 * was missed; it threw on every step; the throw landed in the enclosing
 * `catch { return false; }`, which means "this line was not an event"; and so
 * the ledger stayed at zero and the cap never fired. `tests/eval` had no
 * typecheck, so the compiler never saw it either (V-L0 #2/#3). On a paid route
 * that is an uncapped-spend path, and the only visible symptom was a benchmark
 * that ran to its timeout.
 *
 * So the watcher is its own function now, and these tests drive the real one.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openCodeBudgetWatcher } from "../../eval/comparison/runner";

const EVAL_DIR = join(import.meta.dir, "..", "..", "eval");

/** One OpenCode `step_finish` event, in the shape the runner reads. */
function step(tokens: { input?: number; output?: number; reasoning?: number }) {
  return { type: "step_finish", part: { tokens: { ...tokens, cache: { read: 0, write: 0 } } } };
}

test("a priced step accrues into the watcher's ledger", () => {
  const watcher = openCodeBudgetWatcher("gpt-5", 1_000);
  expect(watcher.totalListCostUsd()).toBe(0);
  const stopped = watcher.observe(step({ input: 1_000_000, output: 100_000 }));
  // gpt-5: $1.25/M in, $10/M out → 1.25 + 1.00 = $2.25, well under the budget.
  expect(watcher.totalListCostUsd()).toBeCloseTo(2.25, 6);
  expect(stopped).toBe(false);
});

test("the cap fires the moment the accrued list cost reaches the budget", () => {
  const watcher = openCodeBudgetWatcher("gpt-5", 2);
  // Two steps at $1.25 each: the first is under, the second crosses.
  expect(watcher.observe(step({ input: 1_000_000 }))).toBe(false);
  expect(watcher.totalListCostUsd()).toBeCloseTo(1.25, 6);
  expect(watcher.observe(step({ input: 1_000_000 }))).toBe(true);
  expect(watcher.totalListCostUsd()).toBeGreaterThanOrEqual(2);
});

test("reasoning tokens are billed as output, not dropped", () => {
  const plain = openCodeBudgetWatcher("gpt-5", 1_000);
  plain.observe(step({ output: 100_000 }));
  const reasoning = openCodeBudgetWatcher("gpt-5", 1_000);
  reasoning.observe(step({ output: 50_000, reasoning: 50_000 }));
  // A model that thinks for half its output costs the same as one that does not.
  expect(reasoning.totalListCostUsd()).toBeCloseTo(plain.totalListCostUsd(), 6);
});

test("every step is attributed, so the rig's own ledger never reads unattributed", () => {
  // The runner prices a competitor's steps as that competitor's own work.
  // `record` tags an attribution-less row "unattributed" rather than dropping
  // it, so a regression here would still accrue — this is what keeps the LABEL
  // honest as well as the total.
  const watcher = openCodeBudgetWatcher("gpt-5", 1_000);
  watcher.observe(step({ input: 1_000 }));
  expect(watcher.totalListCostUsd()).toBeGreaterThan(0);
});

test("a line that is not a step, or carries no tokens, accrues nothing", () => {
  const watcher = openCodeBudgetWatcher("gpt-5", 0.000_001);
  for (const event of [
    null,
    undefined,
    "plain log line",
    42,
    {},
    { type: "text" },
    { type: "step_finish" },
    { type: "step_finish", part: {} },
    { type: "step_finish", part: { tokens: null } },
  ]) {
    // Never throws, never stops the run, never invents a cost — even against a
    // budget small enough that a single accrued token would trip it.
    expect(watcher.observe(event)).toBe(false);
  }
  expect(watcher.totalListCostUsd()).toBe(0);
});

test("the eval workspace stays inside `bun run typecheck`", () => {
  // The blind spot, as a law. `turbo typecheck` walks the workspaces that
  // declare the task; `tests/eval` declared none and had no tsconfig, so its
  // 26 files compiled nowhere and a signature change could land a runtime
  // TypeError in the benchmark rig with every gate green (V-L0 #4). Removing
  // either of these two files puts it back.
  expect(existsSync(join(EVAL_DIR, "tsconfig.json"))).toBe(true);
  const pkg = JSON.parse(readFileSync(join(EVAL_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  expect(pkg.scripts?.typecheck).toBeTruthy();
});
