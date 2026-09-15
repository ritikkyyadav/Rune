/**
 * RUNE_EVAL_BUDGET_USD is the ceiling for the SERIES.
 *
 * It used to be compared with one number — `options.budgetUsd`, the PER-TASK
 * ceiling — and never with anything else. The rig's own documented command,
 * twelve corpus tasks × two arms × `--budget-usd 2`, therefore planned up to
 * $48 of spend against an authorisation of $2, and no running total was
 * compared with the authorisation at any point in the loop. The report's
 * summary of the gate ("rejects a --budget-usd above it") was literally true
 * and materially misleading: nothing rejected a SERIES above it.
 *
 * Three properties now: the plan states the worst-case total, the gate refuses
 * a series whose worst case is above the authorisation, and the loop stops
 * before a run that would take the running total past it.
 *
 * Nothing here spends or spawns a model: every executable is a path that does
 * not exist, and the refusals happen before anything is started.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  planSeries,
  runArmSeries,
  selectedTasks,
  worstCaseSeriesUsd,
} from "../../eval/comparison/arms/run-arms";
import { authorisedBudgetUsd } from "../../eval/comparison/runner";

const CORPUS = join(import.meta.dir, "..", "..", "eval", "corpus");
const NOWHERE = {
  "claude-code": ["/nonexistent/claude"],
  codex: ["/nonexistent/codex"],
} as const;

const OPTIONS = {
  arms: ["claude-code", "codex"] as Array<"claude-code" | "codex">,
  out: join(import.meta.dir, "never-created-series"),
  corpus: CORPUS,
  budgetUsd: 2,
  timeoutMs: 1000,
  command: { ...NOWHERE },
};

/** Run `body` with RUNE_EVAL_BUDGET_USD set, then put the shell back. */
async function withBudget<T>(dollars: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.RUNE_EVAL_BUDGET_USD;
  if (dollars === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
  else process.env.RUNE_EVAL_BUDGET_USD = dollars;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
    else process.env.RUNE_EVAL_BUDGET_USD = previous;
  }
}

describe("the series ceiling is the authorisation", () => {
  test("the worst case is every planned run at the per-task ceiling", () => {
    const worst = worstCaseSeriesUsd(OPTIONS);
    expect(worst.runs).toBe(selectedTasks(OPTIONS).length * 2);
    expect(worst.usd).toBe(worst.runs * 2);
    // The rig's own documented command is the case that mattered.
    expect(worst.usd).toBeGreaterThan(2);
  });

  test("the documented command is refused against its documented authorisation", async () => {
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "2" })).toBe(2);
    const worst = worstCaseSeriesUsd(OPTIONS);
    await withBudget("2", async () => {
      const failure = await runArmSeries(OPTIONS).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure!.message).toContain(`${worst.runs} run(s)`);
      expect(failure!.message).toContain(worst.usd.toFixed(2));
      expect(failure!.message).toMatch(/whole series/i);
    });
  });

  test("a series inside the authorisation gets past the budget gate", async () => {
    // Proved by the error that comes NEXT, not by letting anything run: the
    // output directory already holds a report, which is the check immediately
    // after the plan. The only child process reached is `--version` on a path
    // that does not exist.
    await withBudget("100", async () => {
      const failure = await runArmSeries({
        ...OPTIONS,
        out: join(import.meta.dir, "fixtures", "existing-series-report"),
        tasks: ["csv-state-machine"],
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure!.message).toMatch(/Report already exists/);
    });
  });

  test("the plan prints the total the reviewer is authorising", () => {
    const plan = planSeries(OPTIONS);
    const text = plan.lines.join("\n");
    const worst = worstCaseSeriesUsd(OPTIONS);
    expect(text).toContain(`$${worst.usd.toFixed(2)} total across the series`);
    // And says which number the variable is, so "budget=$2/task" cannot be
    // read as the whole authorisation.
    expect(text).toMatch(/RUNE_EVAL_BUDGET_USD is the ceiling for the SERIES/);
  });

  test("a dry run still needs no budget at all", async () => {
    await withBudget(undefined, async () => {
      const out = await runArmSeries({ ...OPTIONS, dryRun: true });
      expect(out.kind).toBe("comparator-arm-dry-run");
    });
  });
});

describe("--tasks names tasks, and a name that matched nothing is a refusal", () => {
  test("one typo in a list is refused by name, not silently dropped", () => {
    expect(() => planSeries({ ...OPTIONS, tasks: ["csv-state-machine", "no-such-task"] })).toThrow(
      /no-such-task/,
    );
    // The refusal names the corpus, so the typo can be corrected in one read.
    expect(() => planSeries({ ...OPTIONS, tasks: ["csv-state-machine", "no-such-task"] })).toThrow(
      /csv-state-machine/,
    );
  });

  test("an entirely unknown list keeps the refusal it always had", () => {
    expect(() => planSeries({ ...OPTIONS, tasks: ["no-such-task"] })).toThrow(/No tasks selected/);
  });

  test("a list that matches everything it names plans exactly those runs", () => {
    const plan = planSeries({ ...OPTIONS, tasks: ["csv-state-machine"] });
    expect(plan.runs.map((run) => run.task)).toEqual(["csv-state-machine", "csv-state-machine"]);
  });
});

describe("the authorisation is a dollar figure somebody typed", () => {
  test("a hex or exponent literal is not a dollar figure", () => {
    // `Number("0x10")` is 16 and `Number("1e9")` is a billion. Neither is what
    // a founder typed into a variable that authorises spending.
    for (const value of ["0x10", "1e9", "1e-9", "0b11", "  12_000  "])
      expect(() => authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: value })).toThrow(
        /positive number of dollars/,
      );
  });

  test("a plainly written figure, with or without surrounding space, is accepted", () => {
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "2" })).toBe(2);
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: " 5 " })).toBe(5);
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "0.50" })).toBe(0.5);
  });
});
