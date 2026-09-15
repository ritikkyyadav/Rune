// ─── The live comparison runner's spend authorisation ───
//
// The offline corpus costs nothing, which is exactly what makes the live runner
// beside it dangerous: it is one flag away and it spends the founder's money.
// `RUNE_EVAL_BUDGET_USD` is the authorisation for the run existing at all, and
// an unset variable is a refusal, not a default of zero and not a default of
// whatever `--budget-usd` happened to say.
//
// Also here: the `--corpus` reader, checked without inference — the tasks the
// live runner would use are the corpus's own fixtures and its own acceptance.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { authorisedBudgetUsd, corpusTasks, pilotSpendRoute } from "../../eval/comparison/runner";
import { TASK_IDS, loadAcceptance, loadTask } from "../../eval/corpus/corpus";

describe("RUNE_EVAL_BUDGET_USD authorises a live run, or there is no live run", () => {
  test("unset: it refuses, and says where the free path is", () => {
    expect(() => authorisedBudgetUsd({})).toThrow(/not authorised/i);
    expect(() => authorisedBudgetUsd({})).toThrow(/RUNE_EVAL_BUDGET_USD/);
    // A refusal that does not say what to do instead gets worked around.
    expect(() => authorisedBudgetUsd({})).toThrow(/offline corpus/i);
  });

  test("empty or whitespace is the same as unset", () => {
    expect(() => authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "" })).toThrow(/not authorised/i);
    expect(() => authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "   " })).toThrow(/not authorised/i);
  });

  test("zero, negative and nonsense are refused rather than rounded up", () => {
    for (const value of ["0", "-1", "lots", "NaN", "Infinity"])
      expect(() => authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: value })).toThrow(
        /positive number of dollars/,
      );
  });

  test("a positive number is the authorised ceiling", () => {
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "2" })).toBe(2);
    expect(authorisedBudgetUsd({ RUNE_EVAL_BUDGET_USD: "0.5" })).toBe(0.5);
  });

  test("the live pilot itself refuses to start with it unset", async () => {
    const previous = process.env.RUNE_EVAL_BUDGET_USD;
    delete process.env.RUNE_EVAL_BUDGET_USD;
    try {
      const { runPilot } = await import("../../eval/comparison/runner");
      // The arms are the REAL harness — the same argv the `--real` block
      // builds. That is the run that can spend, and it is the run that has to
      // be refused; it never reaches a spawn, because the refusal is the first
      // thing runPilot does.
      await expect(
        runPilot({
          out: join(import.meta.dir, "never-created"),
          model: "nothing",
          runeProvider: "codex",
          opencodeProvider: "openai",
          budgetUsd: 2,
          timeoutMs: 1000,
          runs: 1,
          tasks: ["csv-state-machine"],
          runeCommand: [process.execPath, "packages/orchestrator/src/bin/rune-cli.ts"],
          opencodeCommand: ["opencode"],
        }),
      ).rejects.toThrow(/not authorised/i);
      // And a declared live route is refused whatever the commands look like.
      await expect(
        runPilot({
          route: "live",
          out: join(import.meta.dir, "never-created"),
          model: "nothing",
          runeProvider: "codex",
          opencodeProvider: "openai",
          budgetUsd: 2,
          timeoutMs: 1000,
          runs: 1,
          tasks: ["csv-state-machine"],
          runeCommand: ["false"],
          opencodeCommand: ["false"],
        }),
      ).rejects.toThrow(/not authorised/i);
    } finally {
      if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
      else process.env.RUNE_EVAL_BUDGET_USD = previous;
    }
  });

  test("the recogniser reads a real harness in either arm, and only there", () => {
    const base = {
      route: undefined,
      runeCommand: ["false"],
      opencodeCommand: ["false"],
    } as const;
    expect(pilotSpendRoute(base)).toBe("scripted");
    expect(
      pilotSpendRoute({
        ...base,
        runeCommand: [process.execPath, "/repo/packages/orchestrator/src/bin/rune-cli.ts"],
      }),
    ).toBe("live");
    expect(pilotSpendRoute({ ...base, runeCommand: ["/usr/local/bin/rune"] })).toBe("live");
    expect(pilotSpendRoute({ ...base, opencodeCommand: ["opencode"] })).toBe("live");
    // A fixture script in a temp directory reaches no provider.
    expect(
      pilotSpendRoute({ ...base, runeCommand: [process.execPath, "/tmp/x/interrupted.ts"] }),
    ).toBe("scripted");
    // A declaration always wins over the recogniser, in both directions.
    expect(pilotSpendRoute({ ...base, route: "live" })).toBe("live");
    expect(pilotSpendRoute({ ...base, route: "scripted", opencodeCommand: ["opencode"] })).toBe(
      "scripted",
    );
  });
});

describe("--corpus reads the frozen corpus as live tasks", () => {
  test("every pinned task arrives with its fixture and its own acceptance", () => {
    const tasks = corpusTasks(join(import.meta.dir, "../../eval/corpus"));
    expect(tasks.map((task) => task.id)).toEqual([...TASK_IDS]);
    for (const task of tasks) {
      const source = loadTask(task.id);
      expect(task.prompt).toBe(source.prompt);
      expect(Object.keys(task.files).sort()).toEqual([...source.files].sort());
      // The grader runs the corpus's own acceptance commands, so an offline row
      // and a live row are answering the same question.
      for (const criterion of loadAcceptance(source))
        expect(task.checks).toContain(criterion.command!);
    }
    expect(
      Object.keys(tasks.find((task) => task.id === "working-tree-integration")!.untracked!),
    ).toEqual(["money.ts"]);
    expect(tasks.filter((task) => task.browser).map((task) => task.id)).toEqual([
      "responsive-project-board",
      "signup-form-states",
    ]);
  });
});

// ─── The same door, in front of the new arms ───
//
// The Claude Code and Codex arms are a second live route into the same corpus,
// and a second route is exactly how a guard ends up covering one door. They
// spend differently from the Rune arm — a subscription arm burns quota rather
// than dollars, and Codex has no dollar ceiling of its own at all — which makes
// the authorisation MORE necessary here, not less: quota is the founder's
// scarcest resource and no ledger can refund it.

describe("the comparator arms are refused without the same authorisation", () => {
  const corpus = join(import.meta.dir, "../../eval/corpus");
  /** Executables that do not exist, so a leak would be a spawn error, not a turn. */
  const command = {
    "claude-code": ["/nonexistent/claude"],
    codex: ["/nonexistent/codex"],
  } as const;

  test("a live arm series refuses to start with RUNE_EVAL_BUDGET_USD unset", async () => {
    const previous = process.env.RUNE_EVAL_BUDGET_USD;
    delete process.env.RUNE_EVAL_BUDGET_USD;
    try {
      const { runArmSeries } = await import("../../eval/comparison/arms/run-arms");
      await expect(
        runArmSeries({
          arms: ["claude-code", "codex"],
          out: join(import.meta.dir, "never-created"),
          corpus,
          tasks: ["csv-state-machine"],
          model: "nothing",
          budgetUsd: 2,
          timeoutMs: 1000,
          command: { ...command },
        }),
      ).rejects.toThrow(/not authorised/i);
    } finally {
      if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
      else process.env.RUNE_EVAL_BUDGET_USD = previous;
    }
  });

  test("a per-task ceiling above the authorised total is refused", async () => {
    const previous = process.env.RUNE_EVAL_BUDGET_USD;
    process.env.RUNE_EVAL_BUDGET_USD = "1";
    try {
      const { runArmSeries } = await import("../../eval/comparison/arms/run-arms");
      await expect(
        runArmSeries({
          arms: ["codex"],
          out: join(import.meta.dir, "never-created"),
          corpus,
          tasks: ["csv-state-machine"],
          budgetUsd: 5,
          timeoutMs: 1000,
          command: { ...command },
        }),
      ).rejects.toThrow(/above the authorised/i);
    } finally {
      if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
      else process.env.RUNE_EVAL_BUDGET_USD = previous;
    }
  });

  test("a dry run is asked for no budget, because a dry run cannot spend", async () => {
    const previous = process.env.RUNE_EVAL_BUDGET_USD;
    delete process.env.RUNE_EVAL_BUDGET_USD;
    try {
      const { runArmSeries } = await import("../../eval/comparison/arms/run-arms");
      const report = await runArmSeries({
        arms: ["claude-code", "codex"],
        out: join(import.meta.dir, "never-created"),
        corpus,
        tasks: ["csv-state-machine"],
        model: "nothing",
        budgetUsd: 2,
        timeoutMs: 1000,
        dryRun: true,
        command: { ...command },
      });
      // A guard that refuses runs which cannot spend is not a safety property;
      // it is the reason guards get deleted (V6 finding 6).
      expect(report.kind).toBe("comparator-arm-dry-run");
      expect(report.results).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
      else process.env.RUNE_EVAL_BUDGET_USD = previous;
    }
  });
});
