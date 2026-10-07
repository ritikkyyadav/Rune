// ─── The paired runner and the corpus as parity tasks ───
//
// run-pairs.ts is what writes the rows the release gate reads, so this file
// holds it to what the scorer (score.ts / aggregate.ts, lane L0-C) needs and
// to what the parity rules promise the arms:
//
//   · pure pieces first — the alternating order, the one re-run, the door
//     (RUNE_EVAL_BUDGET_USD / RUNE_EVAL_QUOTA_PCT) and the gates behind it,
//     scope from two git snapshots, clean and false completion;
//   · the corpus grader, against the corpus's own solutions and against the
//     three ways an arm's tree could have lied to it;
//   · the series, with fake arms: whole pairs always, a missing arm re-run, an
//     unscored pair re-queued once, the quarter rule, a dry run that spawns and
//     writes nothing, evidence never overwritten, one build per series;
//   · two end-to-end runs whose results.jsonl goes through the landed scorer:
//     every row accepted, every row paired.
//
// Nothing here reaches a model. The arms are fakes — injected objects, or the
// real arm modules pointed at fake binaries — and every environment is
// synthetic. The authorisation variables appear only in those fake
// environments, never in this process.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PARITY_CONFIG_ENV } from "../../eval/comparison/arms/claude-code";
import {
  type ArmLimits,
  type ArmName,
  type ArmResult,
  type ComparatorArm,
  type OutcomeSignals,
  judged,
  terminalOf,
  workspaceOf,
} from "../../eval/comparison/arms/types";
import {
  comparabilityProblems,
  latestAttempts,
  loadResults,
  mixedBuildProblems,
  pairRows,
  validateRow,
  versionsSeen,
} from "../../eval/parity/aggregate";
import {
  CHECK_DIR,
  CORPUS_DIR,
  IMPOSSIBLE_MARKER,
  checkStatus,
  corpusGraderSha256,
  corpusParityTasks,
  expectedNewFilesOf,
  forbidsCode,
  outcomeFromChecks,
  protectedPathsOf,
} from "../../eval/parity/corpus-source";
import {
  availableTasks,
  buildManifest,
  manifestDrift,
  manifestProblems,
  manifestTask,
  promptDigest,
  selectTasks,
  type ParityManifest,
} from "../../eval/parity/manifest";
import {
  ARTIFACT,
  MANIFEST,
  type PairSeriesOptions,
  RESULTS,
  SERIES,
  type WorkspaceSnapshot,
  chargeOf,
  changedPaths,
  configFingerprint,
  isClean,
  isCleanV1,
  isFalseCompletion,
  matchesPath,
  optionsFromManifest,
  pairsAuthorisation,
  parseCli,
  parsePorcelainZ,
  planPairs,
  readManifest,
  reconcileImpossible,
  retryOf,
  runPairs,
  scoreScope,
  scoreScopeV1,
  shuffled,
  snapshotWorkspace,
  taskFingerprint,
  unreadableTreeScope,
  workspaceTouched,
} from "../../eval/parity/run-pairs";
import {
  METERED_ARMS,
  NEW_BUDGET_STATE,
  budgetLines,
  budgetProblems,
  gateBeforeArm,
  gateBeforePair,
  readingOf,
  unwatched,
  type BudgetState,
  type SeriesBudget,
  type SeriesLimits,
} from "../../eval/parity/series-budget";
import { buildReport } from "../../eval/parity/report";
import { scoreMode } from "../../eval/parity/score";
import {
  WALL_LIMIT_MS,
  quality,
  type Outcome,
  type ParityArm,
  type ParityRunResult,
  type ParityTask,
} from "../../eval/parity/types";
import { rmTemp } from "../../helpers/tmp";

const scratch: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmTemp(dir);
});

function git(root: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}
const commit = (root: string, message: string) =>
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--no-verify",
    "-qm",
    message,
  );

// ─── Pure pieces ───

/** A task that costs nothing: a one-file repo, graded by whether done.txt exists. */
function syntheticTask(id: string, over: Partial<ParityTask> = {}): ParityTask {
  return {
    id,
    family: "F1",
    prompt: `Finish ${id}.`,
    size: "small",
    grader: createHash("sha256").update(`checks of ${id}`).digest("hex"),
    async prepare(workspace) {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "main.ts"), "export const x = 1;\n");
      writeFileSync(join(workspace, ".gitignore"), ".rune/\nnode_modules/\n");
      git(workspace, "init", "-q");
      git(workspace, "add", ".");
      commit(workspace, "fixture");
    },
    async grade(workspace) {
      const done = existsSync(join(workspace, "done.txt"));
      return {
        hiddenPassed: done ? 2 : 1,
        hiddenTotal: 2,
        regressionsIntroduced: 0,
        buildBroken: false,
        impossible: [],
      };
    },
    ...over,
  };
}

describe("the order of a pair", () => {
  const tasks = ["a", "b", "c"].map((id) => syntheticTask(id));

  test("the first arm alternates across tasks and across repetitions", () => {
    const jobs = planPairs(tasks, ["rune", "claude-code"], 2);
    expect(jobs.map((job) => `${job.task.id}#${job.run}:${job.order[0]}`)).toEqual([
      "a#1:rune",
      "b#1:claude-code",
      "c#1:rune",
      "a#2:claude-code",
      "b#2:rune",
      "c#2:claude-code",
    ]);
    // Each arm goes first equally often, and every task has both orders.
    expect(jobs.filter((job) => job.order[0] === "rune")).toHaveLength(3);
    for (const task of tasks)
      expect(new Set(jobs.filter((j) => j.task === task).map((j) => j.order[0])).size).toBe(2);
  });

  test("with a seed, each repetition runs the tasks in an order of its own; the arms still alternate", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => syntheticTask(id));
    const arms = ["rune", "claude-code"] as const;
    const plain = planPairs(five, arms, 2);
    const seeded = planPairs(five, arms, 2, 7);
    const ids = (jobs: ReturnType<typeof planPairs>, run: number) =>
      jobs.filter((job) => job.run === run).map((job) => job.task.id);
    // Every task, once, in every repetition.
    for (const run of [1, 2])
      expect([...ids(seeded, run)].sort()).toEqual(["a", "b", "c", "d", "e"]);
    // A seed names one order; another seed, another; none of them the order given.
    expect(planPairs(five, arms, 2, 7)).toEqual(seeded);
    expect(ids(planPairs(five, arms, 2, 8), 1)).not.toEqual(ids(seeded, 1));
    expect(ids(seeded, 1)).not.toEqual(ids(plain, 1));
    expect(ids(seeded, 1)).not.toEqual(ids(seeded, 2));
    expect(ids(plain, 1)).toEqual(["a", "b", "c", "d", "e"]);
    expect(planPairs(five, arms, 2, null)).toEqual(plain);
    // The first arm alternates by position, whatever task landed there.
    expect(seeded.map((job) => job.order[0])).toEqual(plain.map((job) => job.order[0]));
    // The shuffle is a permutation, and leaves what it was given alone.
    const given = [1, 2, 3, 4, 5];
    expect([...shuffled(given, 3)].sort()).toEqual(given);
    expect(shuffled(given, 3)).toEqual(shuffled(given, 3));
    expect(given).toEqual([1, 2, 3, 4, 5]);
  });

  test("the retry of an unscored row is that arm alone; of two, both, the other arm first", () => {
    const [job] = planPairs(tasks, ["rune", "claude-code"], 1);
    expect(job!.order).toEqual(["rune", "claude-code"]);
    // The arm that succeeded is not in it.
    expect(retryOf(job!, ["claude-code"])).toEqual({
      task: job!.task,
      run: 1,
      retry: ["claude-code"],
    });
    expect(retryOf(job!, ["rune"]).retry).toEqual(["rune"]);
    expect(retryOf(job!, ["rune", "claude-code"]).retry).toEqual(["claude-code", "rune"]);
  });
});

describe("the door: refuse unless a spend was authorised", () => {
  test("neither variable is a refusal, and it names both", () => {
    expect(() => pairsAuthorisation({})).toThrow(/RUNE_EVAL_BUDGET_USD[\s\S]*RUNE_EVAL_QUOTA_PCT/);
    expect(() =>
      pairsAuthorisation({ RUNE_EVAL_BUDGET_USD: " ", RUNE_EVAL_QUOTA_PCT: "" }),
    ).toThrow(/not authorised/);
  });

  test("either one alone is enough, and both are read", () => {
    expect(pairsAuthorisation({ RUNE_EVAL_BUDGET_USD: "5" })).toEqual({
      budgetUsd: 5,
      quotaPct: null,
    });
    expect(pairsAuthorisation({ RUNE_EVAL_QUOTA_PCT: "40" })).toEqual({
      budgetUsd: null,
      quotaPct: 40,
    });
    expect(
      pairsAuthorisation({ RUNE_EVAL_BUDGET_USD: "0.50", RUNE_EVAL_QUOTA_PCT: "2.5" }),
    ).toEqual({ budgetUsd: 0.5, quotaPct: 2.5 });
  });

  test("a quota share is a plain number from 1 to 100, and a typo is not a limit", () => {
    for (const value of ["0", "101", "1e2", "0x10", "-5", "fifty", "50%"])
      expect(() => pairsAuthorisation({ RUNE_EVAL_QUOTA_PCT: value })).toThrow(/1 to 100/);
    // A malformed one is refused even when the other is fine.
    expect(() =>
      pairsAuthorisation({ RUNE_EVAL_BUDGET_USD: "5", RUNE_EVAL_QUOTA_PCT: "lots" }),
    ).toThrow(/1 to 100/);
    expect(() =>
      pairsAuthorisation({ RUNE_EVAL_BUDGET_USD: "1e9", RUNE_EVAL_QUOTA_PCT: "50" }),
    ).toThrow(/positive number of dollars/);
  });
});

describe("what a series may use: the budget, checked before every run", () => {
  const limits: SeriesLimits = { maxPairs: 10, maxAttempts: 20, wallAllowanceMs: 600 * 60_000 };
  const budgetOf = (over: Partial<SeriesBudget> = {}): SeriesBudget => ({
    budgetUsd: null,
    accounts: {},
    limits,
    bounded: true,
    ...over,
  });
  const state = (over: Partial<BudgetState> = {}): BudgetState => ({
    ...NEW_BUDGET_STATE(),
    ...over,
  });
  const order = ["rune", "claude-code"] as const;
  const SMALL = WALL_LIMIT_MS.small;

  test("the first pair is asked like any other: a window already past its stop refuses it", () => {
    // The reviewed case: nothing has run, Rune reads 99%, the stop is 90%.
    const read = (usedPct: number) =>
      gateBeforePair(
        budgetOf({ accounts: { rune: { usedPct, stopAtPct: 90 } } }),
        state(),
        order,
        SMALL,
      );
    expect(read(99)).toBe(
      "Series stopped: Rune's window is 99% used (the operator's reading before the series), at or past its stop at 90%.",
    );
    expect(read(90)).toMatch(/at or past its stop at 90%/);
    expect(read(89.9)).toBeUndefined();
  });

  test("each account has its own reserve, and either one stops the pair", () => {
    const budget = budgetOf({
      accounts: {
        rune: { usedPct: 10, stopAtPct: 80 },
        "claude-code": { usedPct: 75, stopAtPct: 70 },
      },
    });
    expect(gateBeforePair(budget, state(), order, SMALL)).toBe(
      "Series stopped: claude-code's window is 75% used (the operator's reading before the series), at or past its stop at 70%.",
    );
    // Asked of one arm, only that arm's account answers.
    expect(gateBeforeArm(budget, state(), "rune", SMALL)).toBeUndefined();
    expect(gateBeforeArm(budget, state(), "claude-code", SMALL)).toMatch(/claude-code's window/);
  });

  test("a meter the arm's own rows report outranks the reading taken before the series", () => {
    const budget = budgetOf({ accounts: { rune: { usedPct: 10, stopAtPct: 80 } } });
    expect(readingOf(budget, state(), "rune")).toEqual({ pct: 10, source: "preflight" });
    const metered = state({ reported: { rune: 85 } });
    expect(readingOf(budget, metered, "rune")).toEqual({ pct: 85, source: "reported" });
    expect(gateBeforeArm(budget, metered, "rune", SMALL)).toBe(
      "Series stopped: Rune's window is 85% used (its last row's meter), at or past its stop at 80%.",
    );
    // A row that reported no meter leaves the earlier reading standing.
    expect(readingOf(budget, state({ reported: { rune: null } }), "rune")).toEqual({
      pct: 10,
      source: "preflight",
    });
    expect(readingOf(budgetOf(), state(), "rune")).toBeNull();
    // With no stop set, a reading stops nothing.
    expect(
      gateBeforeArm(
        budgetOf({ accounts: { rune: { usedPct: 99, stopAtPct: null } } }),
        state(),
        "rune",
        SMALL,
      ),
    ).toBeUndefined();
  });

  test("the run count: no run past the last allowed one, and no pair with one run left", () => {
    const budget = budgetOf({ limits: { ...limits, maxAttempts: 5 } });
    expect(gateBeforeArm(budget, state({ attempts: 4 }), "rune", SMALL)).toBeUndefined();
    expect(gateBeforeArm(budget, state({ attempts: 5 }), "rune", SMALL)).toBe(
      "Series stopped: 5 of 5 allowed arm run(s) used.",
    );
    expect(gateBeforePair(budget, state({ attempts: 3 }), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(budget, state({ attempts: 4 }), order, SMALL)).toBe(
      "Series stopped: 1 of 5 allowed arm run(s) left, and a pair needs two.",
    );
  });

  test("the pair count", () => {
    const budget = budgetOf({ limits: { ...limits, maxPairs: 3 } });
    expect(gateBeforePair(budget, state({ pairsStarted: 2 }), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(budget, state({ pairsStarted: 3 }), order, SMALL)).toBe(
      "Series stopped: 3 of 3 allowed pair(s) started.",
    );
  });

  test("the clock: a run is not started that could not finish inside the allowance", () => {
    const budget = budgetOf({ limits: { ...limits, wallAllowanceMs: 60 * 60_000 } });
    const at = (minutes: number, extraMs = 0) => state({ elapsedMs: minutes * 60_000 + extraMs });
    // Twenty-minute runs: at 40:00 one fits exactly; a millisecond later it does not.
    expect(gateBeforeArm(budget, at(40), "rune", SMALL)).toBeUndefined();
    expect(gateBeforeArm(budget, at(40, 1), "rune", SMALL)).toMatch(
      /the next run may take up to 20\.0 min and 20\.0 min of the 60\.0 min allowance are left/,
    );
    // A pair is two runs.
    expect(gateBeforePair(budget, at(20), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(budget, at(20, 1), order, SMALL)).toMatch(
      /the next pair may take up to 40\.0 min/,
    );
    // A serious task's run is forty-five.
    expect(gateBeforeArm(budget, at(15), "rune", WALL_LIMIT_MS.serious)).toBeUndefined();
    expect(gateBeforeArm(budget, at(16), "rune", WALL_LIMIT_MS.serious)).toMatch(/45\.0 min/);
  });

  test("dollars: an estimate of the next pair, and a stop that can go blind", () => {
    const budget = budgetOf({ budgetUsd: 0.05, bounded: false });
    const spent = { pairsStarted: 1, spentUsd: 0.02, costliestPairUsd: 0.02 };
    // Before the first pair nothing is known of what one costs, and it starts.
    expect(gateBeforePair(budget, state(), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(budget, state(spent), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(budget, state({ ...spent, spentUsd: 0.04 }), order, SMALL)).toBe(
      "Series stopped: $0.0400 spent, and the next pair is estimated at up to $0.0200 (the costliest so far), past the authorised $0.05.",
    );
    // Reaching the figure exactly is not passing it.
    const half = budgetOf({ budgetUsd: 0.5, bounded: false });
    const quarters = { pairsStarted: 1, spentUsd: 0.25, costliestPairUsd: 0.25 };
    expect(gateBeforePair(half, state(quarters), order, SMALL)).toBeUndefined();
    expect(gateBeforePair(half, state({ ...quarters, spentUsd: 0.375 }), order, SMALL)).toMatch(
      /past the authorised \$0\.5/,
    );
    // A run whose cost nobody could count: the stop can no longer be evaluated…
    const blind = state({ ...spent, unknownCharge: true });
    expect(gateBeforePair(budget, blind, order, SMALL)).toMatch(/can no longer be counted/);
    // …unless the operator accepted the limits as the bound.
    expect(gateBeforePair({ ...budget, bounded: true }, blind, order, SMALL)).toBeUndefined();
    // No dollar figure authorised: dollars stop nothing.
    expect(
      gateBeforePair(budgetOf(), state({ ...spent, spentUsd: 99 }), order, SMALL),
    ).toBeUndefined();
  });

  test("what cannot be watched is refused, by name, unless the operator accepted it", () => {
    const read = { usedPct: 10, stopAtPct: 80 };
    // Rune was read and has a reserve. The comparator has no meter, whatever was read.
    const budget = budgetOf({ bounded: false, accounts: { rune: read, "claude-code": read } });
    expect(unwatched(budget, "rune")).toEqual([]);
    expect(unwatched(budget, "claude-code")).toEqual([
      "its window cannot be read while the series runs",
    ]);
    expect(budgetProblems(budget, order, 3)).toEqual([
      "claude-code: its window cannot be read while the series runs",
      "an account that cannot be watched needs --bounded: the run count and the wall allowance are then the only bound, and the record says so",
    ]);
    expect(budgetProblems({ ...budget, bounded: true }, order, 3)).toEqual([]);
    // Nothing read, nothing reserved.
    expect(unwatched(budgetOf(), "rune")).toEqual([
      "no reserve was set for its account",
      "its window was not read before the series",
    ]);
    expect(unwatched(budgetOf(), "codex")).toHaveLength(3);
    expect([...METERED_ARMS]).toEqual(["rune"]);
  });

  test("limits that are not limits, and a plan larger than its own limit", () => {
    const bad = (over: Partial<SeriesLimits>) =>
      budgetProblems(budgetOf({ limits: { ...limits, ...over } }), order, 3);
    expect(bad({})).toEqual([]);
    expect(bad({ maxPairs: 0 })[0]).toMatch(/--max-pairs must be a whole number of at least 1/);
    expect(bad({ maxAttempts: 1 })[0]).toMatch(
      /--max-attempts must be a whole number of at least 2/,
    );
    expect(bad({ maxAttempts: 2.5 })[0]).toMatch(/--max-attempts/);
    expect(bad({ wallAllowanceMs: 0 })[0]).toMatch(/--wall-allowance-min/);
    // A series is never cut short silently.
    expect(bad({ maxPairs: 2 })).toEqual([
      "the plan is 3 pair(s) and --max-pairs allows 2: raise it or select fewer tasks — a series is never cut short silently",
    ]);
    expect(bad({ maxPairs: 3 })).toEqual([]);
    expect(
      budgetProblems(budgetOf({ accounts: { rune: { usedPct: 120, stopAtPct: -1 } } }), order, 3),
    ).toEqual([
      "rune: its used share must be a number from 0 to 100, not 120",
      "rune: its stop-at share must be a number from 0 to 100, not -1",
    ]);
  });

  test("the labels say which figure is a cap, and which is not", () => {
    const needs = { pairs: 3, armRuns: 6, worstCaseWallMs: 6 * SMALL };
    const lines = budgetLines(
      budgetOf({
        budgetUsd: 5,
        accounts: {
          rune: { usedPct: 12, stopAtPct: 80 },
          "claude-code": { usedPct: 30, stopAtPct: 70 },
        },
      }),
      order,
      needs,
    );
    expect(lines[0]).toBe(
      "hard stops, counted by the rig and checked before every arm run: at most 10 pair(s), 20 arm run(s), 600.0 min of wall time",
    );
    expect(lines[1]).toBe(
      "the plan needs 3 pair(s), 6 arm run(s) before any retry, and up to 120.0 min if every run uses its whole wall limit",
    );
    const text = lines.join("\n");
    expect(text).toContain("$5 is an estimate-gated stop, NOT a spend cap");
    expect(text).toContain("the total can pass $5 by up to one pair");
    expect(text).toContain(
      "Rune: 12% of its window used (the operator's reading) · stop at 80% · its rows report a meter when its provider sends one, so the stop is checked before each of its runs",
    );
    expect(text).toContain(
      "claude-code: 30% of its window used (the operator's reading) · stop at 70% · NO METER: checked once, against the reading above, and not a cap after that",
    );
    expect(text).toContain(
      "bounded mode, accepted by the operator: for claude-code the run count and the wall allowance are the only bound; no percentage of a window is a cap",
    );
    // Nobody is told a dollar figure is a ceiling.
    expect(text).not.toContain("ceiling");
    // A metered arm nobody read starts its first run unread, and the label says so.
    const labelled = (rune: { usedPct: number | null; stopAtPct: number | null }) =>
      budgetLines(budgetOf({ accounts: { rune } }), order, needs).join("\n");
    expect(labelled({ usedPct: null, stopAtPct: 70 })).toContain(
      "Rune: window not read · stop at 70% · its rows report a meter when its provider sends one: the stop is checked from its first row on, and NOT before its first run, which starts unread",
    );
    expect(labelled({ usedPct: 5, stopAtPct: null })).toContain(
      "its rows report a meter, and with no reserve set nothing reads it",
    );
    // Nothing read and nothing authorised in dollars is said as plainly.
    const bare = budgetLines(budgetOf({ bounded: false }), order, needs).join("\n");
    expect(bare).toContain(
      "dollars: no dollar figure was authorised, and nothing here bounds spend in dollars",
    );
    expect(bare).toContain(
      "claude-code: window not read · no reserve set · NO METER: nothing about this account is watched",
    );
    expect(bare).toContain(
      "NOT RUNNABLE LIVE as configured: Rune and claude-code cannot be held to a percentage, and --bounded was not given",
    );
    // Limits smaller than the plan are said to be.
    expect(
      budgetLines(budgetOf({ limits: { ...limits, maxAttempts: 4 } }), order, needs).join("\n"),
    ).toContain("these limits are smaller than the plan");
    expect(lines.join("\n")).not.toContain("these limits are smaller than the plan");
  });

  test("what a run is charged: the larger known figure, zero for no call, else unknown", () => {
    expect(chargeOf(null)).toBe(0);
    expect(chargeOf({ listUsd: 0.02, reportedCostUsd: null, calls: 3 })).toBe(0.02);
    expect(chargeOf({ listUsd: 0.02, reportedCostUsd: 0.05, calls: 3 })).toBe(0.05);
    expect(chargeOf({ listUsd: null, reportedCostUsd: null, calls: 0 })).toBe(0);
    expect(chargeOf({ listUsd: null, reportedCostUsd: null, calls: null })).toBeNull();
    expect(chargeOf({ listUsd: null, reportedCostUsd: null, calls: 4 })).toBeNull();
  });
});

// ─── Scope ───

const snap = (
  entries: Record<string, string>,
  committed: string[] = [],
  extra: Pick<WorkspaceSnapshot, "added" | "settled"> = {},
): WorkspaceSnapshot => ({
  head: "h",
  entries,
  committed,
  ...extra,
});

describe("scope, from two snapshots", () => {
  test("porcelain -z: a rename's source is a deletion, a copy's is untouched", () => {
    expect(
      parsePorcelainZ("R  new.ts\0old.ts\0C  copy.ts\0orig.ts\0?? u.ts\0!! .rune/x\0"),
    ).toEqual([
      { code: "R ", path: "new.ts" },
      { code: " D", path: "old.ts" },
      { code: "C ", path: "copy.ts" },
      { code: "??", path: "u.ts" },
      { code: "!!", path: ".rune/x" },
    ]);
  });

  test("a changed path is any entry that differs, plus what was committed", () => {
    const before = snap({ "u.ts": "?? 1", "same.ts": " M 2" });
    const after = snap({ "u.ts": "?? 9", "same.ts": " M 2", "new.ts": "?? 3" }, ["c.ts"]);
    expect(changedPaths(before, after)).toEqual(["c.ts", "new.ts", "u.ts"]);
    expect(
      changedPaths(snap({}), snap({ "node_modules/x/i.js": "?? 1", "a/node_modules/y": "!! 2" })),
    ).toEqual([]);
  });

  const noCode = { noCode: true, expectedNewFiles: ["ANSWER.md"] };
  const coding = {};

  test("no-code: the asked-for file alone is in scope", () => {
    expect(scoreScope(snap({}), snap({ "ANSWER.md": "?? 1" }), noCode)).toEqual({
      scope: 1,
      changed: ["ANSWER.md"],
    });
  });

  test("no-code: any other change, tracked or untracked, ignored or not, is out of scope", () => {
    for (const [path, code] of [
      ["csv.ts", " M"],
      ["scratch.ts", "??"],
      ["notes/x.txt", "!!"],
      ["gone.ts", " D"],
    ] as const) {
      const result = scoreScope(
        snap({}),
        snap({ "ANSWER.md": "?? 1", [path]: `${code} 2` }),
        noCode,
      );
      expect({ path, scope: result.scope, notes: result.notes }).toEqual({
        path,
        scope: 0,
        notes: [path],
      });
    }
    // A committed edit is an edit.
    expect(scoreScope(snap({}), snap({}, ["csv.ts"]), noCode).scope).toBe(0);
  });

  test("no-code: the tool's own state directory is a leftover (0.5), not a code change", () => {
    const result = scoreScope(
      snap({}),
      snap({ "ANSWER.md": "?? 1", ".rune/state.json": "!! 2", ".claude/settings.json": "?? 3" }),
      noCode,
    );
    expect(result).toEqual({
      scope: 0.5,
      notes: [".claude/settings.json", ".rune/state.json"],
      changed: [".claude/settings.json", ".rune/state.json", "ANSWER.md"],
    });
  });

  test("coding: new source and tests are the work; new leftovers are half", () => {
    expect(
      scoreScope(snap({}), snap({ "csv.ts": " M 1", "csv.test.ts": "?? 2" }), coding).scope,
    ).toBe(1);
    for (const leftover of ["target/debug/app", "run.log", "dist/index.js", ".rune/x", "a.orig"]) {
      const code = leftover.startsWith(".rune") ? "!!" : "??";
      const result = scoreScope(
        snap({}),
        snap({ "csv.ts": " M 1", [leftover]: `${code} 2` }),
        coding,
      );
      expect({ leftover, scope: result.scope, notes: result.notes }).toEqual({
        leftover,
        scope: 0.5,
        notes: [leftover],
      });
      expect(ARTIFACT.test(leftover) || code === "!!").toBe(true);
    }
    // Any NEW ignored file is a leftover, whatever its name.
    expect(scoreScope(snap({}), snap({ "cache/blob": "!! 1" }), coding).scope).toBe(0.5);
  });

  test("coding: an ignored or untracked file that was already there is not a new leftover", () => {
    const before = snap({ "money.ts": "?? 1", "old.log": "?? 5" });
    const after = snap({ "money.ts": "?? 2", "old.log": "?? 6" });
    expect(scoreScope(before, after, coding)).toEqual({
      scope: 1,
      changed: ["money.ts", "old.log"],
    });
  });

  // ─── A coding task's boundary: what it protected, what was there, what it declared ───

  test("coding: a path the task protected is out of scope once its bytes change", () => {
    const task = { protectedPaths: ["window.test.ts", "vendor/"] };
    for (const after of [
      snap({ "window.ts": " M 1", "window.test.ts": " M 2" }), // edited
      snap({ "window.ts": " M 1", "window.test.ts": " D missing" }), // deleted
      snap({ "window.ts": " M 1" }, ["window.test.ts"]), // edited, and committed
    ])
      expect(scoreScope(snap({}), after, task)).toMatchObject({
        scope: 0,
        notes: ["window.test.ts (protected)"],
      });
    // A directory is named with its slash, and is not a prefix of a file name.
    expect(scoreScope(snap({}), snap({ "vendor/lib/a.js": " M 1" }), task).notes).toEqual([
      "vendor/lib/a.js (protected)",
    ]);
    expect(scoreScope(snap({}), snap({ "vendored.js": " M 1" }), task).scope).toBe(1);
    expect(matchesPath(["a.ts", "dir/"], "dir/a.ts")).toBe(true);
    expect(matchesPath(["a.ts", "dir/"], "b/a.ts")).toBe(false);
    expect(matchesPath(["a.ts"], "a.ts.bak")).toBe(false);
    // Protection outranks a declared path.
    expect(
      scoreScope(snap({}), snap({ "window.test.ts": " M 2" }), {
        ...task,
        allowedPaths: ["window.test.ts"],
      }).scope,
    ).toBe(0);
    // With nothing protected, the same edit is the work.
    expect(scoreScope(snap({}), snap({ "window.test.ts": " M 2" }), {}).scope).toBe(1);
  });

  test("coding: a protected file only staged, or committed as it stood, is untouched", () => {
    const task = { protectedPaths: ["money.ts"] };
    const before = snap({ "money.ts": "?? aaa" });
    // `git add money.ts`: git's state for the path moved; its bytes did not.
    expect(
      scoreScope(before, snap({ "money.ts": "A  aaa", "orders.ts": " M 1" }), task).scope,
    ).toBe(1);
    // `git add -A && git commit`: gone from the listing, the same bytes on disk.
    expect(
      scoreScope(
        before,
        snap({}, ["money.ts", "orders.ts"], {
          added: ["money.ts"],
          settled: { "money.ts": "aaa" },
        }),
        task,
      ).scope,
    ).toBe(1);
    // Rewritten and then committed: other bytes.
    expect(
      scoreScope(
        before,
        snap({}, ["money.ts"], { added: ["money.ts"], settled: { "money.ts": "bbb" } }),
        task,
      ),
    ).toMatchObject({ scope: 0, notes: ["money.ts (protected)"] });
    // Rewritten in place.
    expect(scoreScope(before, snap({ "money.ts": "?? bbb" }), task).scope).toBe(0);
    // A snapshot that cannot say what is on disk now does not get the benefit of the doubt.
    expect(scoreScope(before, snap({}, ["money.ts"]), task).scope).toBe(0);
  });

  test("coding: uncommitted work that was in the tree and is gone is out of scope", () => {
    const before = snap({ "notes.ts": " M aaa", "draft.ts": "?? bbb", "gone.ts": " D missing" });
    // `git stash` / `git checkout .`: the tracked edit reverted, the deletion undone.
    expect(
      scoreScope(
        before,
        snap({ "draft.ts": "?? bbb", "fix.ts": " M 1" }, [], {
          settled: { "notes.ts": "head", "gone.ts": "head2" },
        }),
        {},
      ),
    ).toMatchObject({
      scope: 0,
      notes: ["gone.ts (uncommitted work lost)", "notes.ts (uncommitted work lost)"],
    });
    // The untracked file removed.
    expect(
      scoreScope(
        before,
        snap({ "notes.ts": " M aaa", "gone.ts": " D missing" }, [], {
          settled: { "draft.ts": "missing" },
        }),
        {},
      ).notes,
    ).toEqual(["draft.ts (uncommitted work lost)"]);
    // The modified tracked file deleted outright.
    expect(
      scoreScope(
        before,
        snap({ "notes.ts": " D missing", "draft.ts": "?? bbb", "gone.ts": " D missing" }),
        {},
      ).notes,
    ).toEqual(["notes.ts (uncommitted work lost)"]);
    // Building on it is not losing it …
    expect(
      scoreScope(
        before,
        snap({ "notes.ts": " M ccc", "draft.ts": "?? ddd", "gone.ts": " D missing" }),
        {},
      ).scope,
    ).toBe(1);
    // … and neither is committing it, changed or as it stood.
    expect(
      scoreScope(
        before,
        snap({ "gone.ts": " D missing" }, ["notes.ts", "draft.ts"], {
          added: ["draft.ts"],
          settled: { "notes.ts": "ccc", "draft.ts": "bbb" },
        }),
        {},
      ).scope,
    ).toBe(1);
  });

  test("coding: an ignored path, or a leftover that was lying there, is nobody's work to lose", () => {
    const before = snap({
      ".env.local": "!! 1",
      "cache/x": "!! 2",
      "old.log": "?? 3",
      "build/out.js": "?? 4",
    });
    const after = snap({}, [], {
      settled: {
        ".env.local": "missing",
        "cache/x": "missing",
        "old.log": "missing",
        "build/out.js": "missing",
      },
    });
    for (const task of [{}, { allowedPaths: ["src/"] }])
      expect(scoreScope(before, after, task)).toEqual({
        scope: 1,
        changed: [".env.local", "build/out.js", "cache/x", "old.log"],
      });
    // A TRACKED file under a build-like name is still somebody's file.
    expect(
      scoreScope(snap({}), snap({ "build/release.sh": " M 1" }), { allowedPaths: ["src/"] }).notes,
    ).toEqual(["build/release.sh (outside the task's paths)"]);
  });

  test("coding: with its paths declared, an existing file changed outside them is out of scope", () => {
    const task = { allowedPaths: ["csv.ts", "tests/"] };
    // The reviewed case: a tracked file the task has nothing to do with.
    expect(scoreScope(snap({}), snap({ "csv.ts": " M 1", "unrelated.ts": " M 2" }), task)).toEqual({
      scope: 0,
      notes: ["unrelated.ts (outside the task's paths)"],
      changed: ["csv.ts", "unrelated.ts"],
    });
    // Deleted, staged, or changed in a commit: the same.
    for (const after of [
      snap({ "unrelated.ts": " D missing" }),
      snap({ "unrelated.ts": "M  2" }),
      snap({}, ["unrelated.ts"], { added: [] }),
    ])
      expect(scoreScope(snap({}), after, task).scope).toBe(0);
    // The person's untracked file is an existing file too.
    expect(
      scoreScope(snap({ "scratch.ts": "?? 1" }), snap({ "scratch.ts": "?? 2" }), task).notes,
    ).toEqual(["scratch.ts (outside the task's paths)"]);
    // Without a declared boundary, none is enforced.
    expect(scoreScope(snap({}), snap({ "csv.ts": " M 1", "unrelated.ts": " M 2" }), {}).scope).toBe(
      1,
    );
  });

  test("coding: what the run CREATED is never outside — a new test or module is the work", () => {
    const task = { allowedPaths: ["csv.ts", "tests/"] };
    const after = snap(
      {
        "csv.ts": " M 1",
        "csv.test.ts": "?? 2",
        "lib/quote.ts": "A  3",
        "lib/moved.ts": "R  4",
        "tests/old.test.ts": " M 5",
      },
      ["docs/new.md", "spec/more.test.ts"],
      { added: ["docs/new.md", "spec/more.test.ts"] },
    );
    expect(scoreScope(snap({}), after, task)).toMatchObject({ scope: 1 });
    // An EXISTING test outside the declared paths is an existing file.
    expect(scoreScope(snap({}), snap({ "spec/old.test.ts": " M 5" }), task).scope).toBe(0);
    // A file a commit created and the run then edited again is still the run's own.
    expect(
      scoreScope(
        snap({}),
        snap({ "lib/new.ts": " M 2" }, ["lib/new.ts"], { added: ["lib/new.ts"] }),
        task,
      ).scope,
    ).toBe(1);
  });

  test("coding: a declared path may be reverted or deleted, the person's edits in it included", () => {
    const before = snap({ "csv.ts": " M aaa" });
    const reverted = snap({}, [], { settled: { "csv.ts": "head" } });
    expect(scoreScope(before, reverted, { allowedPaths: ["csv.ts"] }).scope).toBe(1);
    expect(scoreScope(before, reverted, { allowedPaths: ["other.ts"] }).notes).toEqual([
      "csv.ts (uncommitted work lost)",
    ]);
  });

  test("coding: a file the task asked for is the work, whatever its name looks like", () => {
    const after = snap({ "app.ts": " M 1", "build/REPORT.md": "?? 2", "trace.log": "?? 3" });
    expect(
      scoreScope(snap({}), after, { expectedNewFiles: ["build/REPORT.md", "trace.log"] }).scope,
    ).toBe(1);
    // Unasked, the same two files are leftovers.
    expect(scoreScope(snap({}), after, {})).toMatchObject({
      scope: 0.5,
      notes: ["build/REPORT.md", "trace.log"],
    });
    // Asked for by name, it is in scope under a declared boundary too.
    expect(
      scoreScope(snap({}), snap({ "NOTES.md": " M 1" }), {
        expectedNewFiles: ["NOTES.md"],
        allowedPaths: ["app.ts"],
      }).scope,
    ).toBe(1);
  });

  test("coding: a boundary breach outranks leftovers, and tool state is never a breach", () => {
    const task = { allowedPaths: ["csv.ts"], protectedPaths: [".rune/"] };
    expect(
      scoreScope(snap({}), snap({ "x.ts": " M 1", "run.log": "?? 2", ".rune/s": "!! 3" }), task),
    ).toMatchObject({ scope: 0, notes: ["x.ts (outside the task's paths)"] });
    expect(scoreScope(snap({}), snap({ "csv.ts": " M 1", ".rune/s": "!! 3" }), task)).toMatchObject(
      { scope: 0.5, notes: [".rune/s"] },
    );
  });

  test("real trees: a careful run that commits everything, and one that reverts the person's work", () => {
    const seed = () => {
      const root = temp("scope-coding-");
      for (const [name, text] of [
        ["app.ts", "app\n"],
        ["app.test.ts", "test\n"],
        ["data.json", "{}\n"],
        ["wip.ts", "committed\n"],
        [".gitignore", ".rune/\nnode_modules/\n"],
      ] as const)
        writeFileSync(join(root, name), text);
      git(root, "init", "-q");
      git(root, "add", ".");
      commit(root, "base");
      // The person's uncommitted work: an edit in progress and a file never added.
      writeFileSync(join(root, "wip.ts"), "committed\nand an edit in progress\n");
      writeFileSync(join(root, "draft.ts"), "never added\n");
      return { root, before: snapshotWorkspace(root) };
    };
    const task = { protectedPaths: ["draft.ts"], allowedPaths: ["app.ts", "app.test.ts"] };

    const careful = seed();
    writeFileSync(join(careful.root, "app.ts"), "app, fixed\n");
    writeFileSync(join(careful.root, "app.extra.test.ts"), "a new test\n");
    git(careful.root, "add", "-A");
    commit(careful.root, "the arm's commit, the person's work swept in as it stood");
    const kept = snapshotWorkspace(careful.root, careful.before);
    expect(kept.added).toEqual(["app.extra.test.ts", "draft.ts"]);
    expect(kept.settled).toEqual({
      "draft.ts": careful.before.entries["draft.ts"]!.slice(3),
      "wip.ts": careful.before.entries["wip.ts"]!.slice(3),
    });
    expect(scoreScope(careful.before, kept, task)).toMatchObject({ scope: 1 });

    const careless = seed();
    git(careless.root, "checkout", "--", "wip.ts"); // what `git stash` does to it
    writeFileSync(join(careless.root, "app.ts"), "app, fixed\n");
    writeFileSync(join(careless.root, "data.json"), '{"touched":true}\n');
    writeFileSync(join(careless.root, "draft.ts"), "rewritten\n");
    git(careless.root, "mv", "app.test.ts", "renamed.test.ts");
    commit(careless.root, "a committed rename");
    const lost = scoreScope(careless.before, snapshotWorkspace(careless.root, careless.before), {
      ...task,
      allowedPaths: ["app.ts"],
    });
    expect(lost).toMatchObject({
      scope: 0,
      notes: [
        "app.test.ts (outside the task's paths)",
        "data.json (outside the task's paths)",
        "draft.ts (protected)",
        "wip.ts (uncommitted work lost)",
      ],
    });
    // The same tree, with no contract at all: only the lost work is out of scope.
    expect(
      scoreScope(careless.before, snapshotWorkspace(careless.root, careless.before), {}).notes,
    ).toEqual(["wip.ts (uncommitted work lost)"]);
  });

  test("a tree git cannot read after the run is the run's doing: scope 0, and it worked", () => {
    const scope = unreadableTreeScope("fatal: not a git repository");
    expect(scope.scope).toBe(0);
    expect(scope.notes![0]).toContain("not a git repository");
    expect(workspaceTouched(scope.changed)).toBe(true);
  });

  test("tool state alone is no evidence of work; anything else is", () => {
    expect(workspaceTouched([".rune/db", ".claude/x", ".opencode/y", ".codex/z"])).toBe(false);
    expect(workspaceTouched([".rune/db", "csv.ts"])).toBe(true);
    expect(workspaceTouched([])).toBe(false);
  });

  test("real snapshots of a real tree: edits, new files, ignored state, commits, renames", () => {
    const root = temp("scope-tree-");
    writeFileSync(join(root, "a.ts"), "a\n");
    writeFileSync(join(root, "r.ts"), "r\n");
    writeFileSync(join(root, ".gitignore"), ".rune/\nnode_modules/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    commit(root, "base");
    writeFileSync(join(root, "u.ts"), "untracked\n");
    const before = snapshotWorkspace(root);
    expect(Object.keys(before.entries)).toEqual(["u.ts"]);

    writeFileSync(join(root, "a.ts"), "edited\n");
    writeFileSync(join(root, "b.ts"), "new\n");
    writeFileSync(join(root, "u.ts"), "untracked, edited\n");
    writeFileSync(join(root, "debug.log"), "log\n");
    mkdirSync(join(root, ".rune"));
    writeFileSync(join(root, ".rune", "state.json"), "{}\n");
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "index.js"), "\n");
    writeFileSync(join(root, "c.ts"), "committed\n");
    git(root, "add", "c.ts");
    commit(root, "arm commit");
    git(root, "mv", "r.ts", "renamed.ts");
    const after = snapshotWorkspace(root, before);

    expect(changedPaths(before, after)).toEqual([
      ".rune/state.json",
      "a.ts",
      "b.ts",
      "c.ts",
      "debug.log",
      "r.ts",
      "renamed.ts",
      "u.ts",
    ]);
    const plan = scoreScope(before, after, { noCode: true, expectedNewFiles: ["b.ts"] });
    expect(plan.scope).toBe(0);
    expect(plan.notes).toEqual(["a.ts", "c.ts", "debug.log", "r.ts", "renamed.ts", "u.ts"]);
    const code = scoreScope(before, after, {});
    expect(code).toMatchObject({ scope: 0.5, notes: [".rune/state.json", "debug.log"] });

    // A snapshot never writes into the tree it measures.
    const index = readFileSync(join(root, ".git", "index"));
    snapshotWorkspace(root);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  });
});

describe("clean and false completion", () => {
  const outcome = (passed: number, total = 3): Outcome => ({
    hiddenPassed: passed,
    hiddenTotal: total,
    regressionsIntroduced: 0,
    buildBroken: false,
    impossible: [],
  });

  test("a false completion is a claim of success on work the grader found short", () => {
    expect(isFalseCompletion(true, outcome(2))).toBe(true);
    expect(isFalseCompletion(true, outcome(3))).toBe(false);
    expect(isFalseCompletion(false, outcome(0))).toBe(false);
    // With no runnable check there is no quality, and so no false completion.
    expect(isFalseCompletion(true, outcome(0, 0))).toBe(false);
    expect(isFalseCompletion(true, { ...outcome(3), regressionsIntroduced: 1 })).toBe(true);
  });

  test("clean: ended by itself, inside the limit, and no false completion", () => {
    const quick = { durationMs: 1000 };
    expect(isClean("completed", quick, 5000, false)).toBe(true);
    // An honest "not finished" ended by itself too.
    expect(isClean("incomplete", quick, 5000, false)).toBe(true);
    expect(isClean("completed", { durationMs: 6000 }, 5000, false)).toBe(false);
    expect(isClean("completed", { durationMs: 5000 }, 5000, false)).toBe(true);
    expect(isClean("completed", quick, 5000, true)).toBe(false);
    // However quickly it ended: a crash, a rig stop, a refusal, a tool that never ran.
    for (const terminal of ["crashed", "stopped", "refused", "not_started"] as const)
      expect({ terminal, clean: isClean(terminal, quick, 5000, false) }).toEqual({
        terminal,
        clean: false,
      });
  });

  test("the parity-run/1 rule asked only that the rig had not stopped it", () => {
    expect(isCleanV1({ durationMs: 1000 }, 5000, false)).toBe(true);
    expect(isCleanV1({ durationMs: 1000, stopped: "timeout" }, 5000, false)).toBe(false);
    expect(isCleanV1({ durationMs: 6000 }, 5000, false)).toBe(false);
    expect(isCleanV1({ durationMs: 1000 }, 5000, true)).toBe(false);
  });

  test("how a run ended, from the facts the one classifier reads", () => {
    const base: OutcomeSignals = { exitCode: 1, claimedSuccess: false, reachedModel: true };
    expect(terminalOf({ ...base, exitCode: 0, claimedSuccess: true })).toBe("completed");
    // The tool's own ceiling, or its own named stop: it said it was stopping.
    expect(terminalOf({ ...base, toolLimit: "turns" })).toBe("incomplete");
    expect(terminalOf({ ...base, toolLimit: "budget" })).toBe("incomplete");
    expect(terminalOf({ ...base, selfStopped: "open_steps" })).toBe("incomplete");
    // No report of stopping at all: the process just ended.
    expect(terminalOf(base)).toBe("crashed");
    expect(terminalOf({ ...base, exitCode: 0 })).toBe("crashed");
    expect(terminalOf({ ...base, exitCode: null, stopped: "timeout" })).toBe("stopped");
    // Any other kill by the rig is the rig's, whatever the tool had said first.
    expect(terminalOf({ ...base, stopped: "signal", selfStopped: "halted" })).toBe("stopped");
    expect(terminalOf({ ...base, stopped: "timeout", toolLimit: "turns" })).toBe("stopped");
    // The rig's cost watcher is the budget ceiling of a tool that has none.
    expect(terminalOf({ ...base, exitCode: null, stopped: "cost limit" })).toBe("incomplete");
    // The classifier's own precedence: a claim first, a refusal ahead of the clock.
    expect(terminalOf({ ...base, provider: "quota" })).toBe("refused");
    expect(terminalOf({ ...base, provider: "outage", stopped: "timeout" })).toBe("refused");
    expect(terminalOf({ ...base, exitCode: 0, claimedSuccess: true, provider: "quota" })).toBe(
      "completed",
    );
    expect(terminalOf({ ...base, claimedSuccess: true, stopped: "timeout" })).toBe("stopped");
  });

  test("the parity-run/1 scope rule knew nothing of what a coding task changed", () => {
    const before = snap({ "wip.ts": " M aaa" });
    const after = snap({ "x.ts": " M 1", "window.test.ts": " M 2" }, [], {
      settled: { "wip.ts": "head" },
    });
    const task = { protectedPaths: ["window.test.ts"], allowedPaths: ["csv.ts"] };
    expect(scoreScope(before, after, task).scope).toBe(0);
    expect(scoreScopeV1(before, after, task)).toBe(1);
    // The two rules it did have are the same two.
    expect(scoreScopeV1(snap({}), snap({ "x.ts": " M 1", "run.log": "?? 2" }), task)).toBe(0.5);
    const noCode = { noCode: true, expectedNewFiles: ["ANSWER.md"] };
    expect(scoreScopeV1(snap({}), snap({ "ANSWER.md": "?? 1", "csv.ts": " M 2" }), noCode)).toBe(0);
    expect(scoreScopeV1(snap({}), snap({ "ANSWER.md": "?? 1" }), noCode)).toBe(1);
  });

  test("a check impossible for one arm only unscores that arm's row", () => {
    const row = (arm: ParityArm, impossible: string[]): ParityRunResult =>
      ({ arm, scored: true, outcome: { ...outcome(1), impossible } }) as ParityRunResult;
    const [a, b] = reconcileImpossible(row("rune", ["c1"]), row("claude-code", []));
    expect(a).toMatchObject({ scored: false, unscoredReason: "grader_infrastructure" });
    expect(b.scored).toBe(true);
    const [c, d] = reconcileImpossible(row("rune", ["c1"]), row("claude-code", ["c1"]));
    expect([c.scored, d.scored]).toEqual([true, true]);
  });
});

// ─── Fingerprints ───

describe("what a row was measured with", () => {
  const task = { id: "t1", prompt: "Finish t1." };
  const prepared = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
    head: "commit-1",
    tree: "tree-1",
    entries: { "wip.ts": " M aaa", "draft.ts": "?? bbb" },
    committed: [],
    ...over,
  });
  const print = taskFingerprint(task, prepared(), 1_200_000);

  test("the task: a sha256 of the id, the prompt, the tree, the uncommitted work and the limit", () => {
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(taskFingerprint(task, prepared(), 1_200_000)).toBe(print);
    for (const [what, other] of [
      ["another id", taskFingerprint({ ...task, id: "t2" }, prepared(), 1_200_000)],
      [
        "one more word in the prompt",
        taskFingerprint({ ...task, prompt: "Finish t1 now." }, prepared(), 1_200_000),
      ],
      ["another tree", taskFingerprint(task, prepared({ tree: "tree-2" }), 1_200_000)],
      ["no commit at all", taskFingerprint(task, prepared({ tree: null }), 1_200_000)],
      [
        "the person's edit differs",
        taskFingerprint(
          task,
          prepared({ entries: { "wip.ts": " M ccc", "draft.ts": "?? bbb" } }),
          1_200_000,
        ),
      ],
      [
        "the untracked file is not there",
        taskFingerprint(task, prepared({ entries: { "wip.ts": " M aaa" } }), 1_200_000),
      ],
      ["a longer clock", taskFingerprint(task, prepared(), 2_700_000)],
    ] as const)
      expect({ what, same: other === print }).toEqual({ what, same: false });
  });

  test("…and of nothing else: not the commit, not the order git listed things, not ignored files", () => {
    // Two preparations of one fixture are two commits and one tree.
    expect(taskFingerprint(task, prepared({ head: "commit-2" }), 1_200_000)).toBe(print);
    expect(
      taskFingerprint(
        task,
        prepared({ entries: { "draft.ts": "?? bbb", "wip.ts": " M aaa" } }),
        1_200_000,
      ),
    ).toBe(print);
    // An install's caches are ignored paths whose bytes differ every time.
    expect(
      taskFingerprint(
        task,
        prepared({
          entries: {
            "wip.ts": " M aaa",
            "draft.ts": "?? bbb",
            ".cache/x": "!! 123",
            "dist/a.js": "!! 9",
          },
        }),
        1_200_000,
      ),
    ).toBe(print);
    // What the run did afterwards is not what it started from.
    expect(
      taskFingerprint(
        task,
        prepared({ committed: ["x.ts"], added: ["x.ts"], settled: {} }),
        1_200_000,
      ),
    ).toBe(print);
  });

  test("the configuration: arm, mode, model, provider and effort", () => {
    const spec = { model: "m-1", reasoningEffort: "high" };
    const base = configFingerprint("rune", "product", spec, "codex");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(configFingerprint("rune", "product", { ...spec }, "codex")).toBe(base);
    const others = [
      configFingerprint("claude-code", "product", spec, "codex"),
      configFingerprint("rune", "harness", spec, "codex"),
      configFingerprint("rune", "product", { ...spec, model: "m-2" }, "codex"),
      configFingerprint("rune", "product", spec, "ollama"),
      configFingerprint("rune", "product", spec, undefined),
      configFingerprint("rune", "product", { model: "m-1" }, "codex"),
      configFingerprint("rune", "product", { model: "m-1", reasoningEffort: "low" }, "codex"),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  test("two fresh preparations of one task: two commits, one tree, one fingerprint", async () => {
    const t = syntheticTask("t1");
    const first = join(temp("print-a-"), "workspace");
    const second = join(temp("print-b-"), "workspace");
    await t.prepare(first);
    // A commit made later, or by another author, is another commit of the same files.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await t.prepare(second);
    const a = snapshotWorkspace(first);
    const b = snapshotWorkspace(second);
    expect(a.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(b.tree).toBe(a.tree!);
    expect(b.head).not.toBe(a.head);
    expect(taskFingerprint(t, b, WALL_LIMIT_MS.small)).toBe(
      taskFingerprint(t, a, WALL_LIMIT_MS.small),
    );
    // Uncommitted work in the tree is part of what the arm was given.
    writeFileSync(join(second, "wip.ts"), "in progress\n");
    expect(taskFingerprint(t, snapshotWorkspace(second), WALL_LIMIT_MS.small)).not.toBe(
      taskFingerprint(t, a, WALL_LIMIT_MS.small),
    );
    // A tree with no commit has no tree to name.
    const empty = temp("print-empty-");
    git(empty, "init", "-q");
    expect(snapshotWorkspace(empty)).toMatchObject({ head: null, tree: null });
  });

  test("what grades a corpus task: its acceptance and every byte of its checks", () => {
    const all = [
      ...corpusParityTasks(),
      ...corpusParityTasks(join(CORPUS_DIR, "..", "parity-tasks")),
    ];
    expect(all).toHaveLength(18);
    for (const t of all) expect(t.grader).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(all.map((t) => t.grader)).size).toBe(18);
    // The same directory, read again, is the same exam.
    const source = join(CORPUS_DIR, "csv-state-machine");
    const original = corpusGraderSha256(source);
    expect(all.find((t) => t.id === "csv-state-machine")!.grader).toBe(original);
    const copy = join(temp("grader-"), "task");
    cpSync(source, copy, { recursive: true });
    expect(corpusGraderSha256(copy)).toBe(original);
    // One byte of a check, one reworded criterion, one check more: each is another exam.
    appendFileSync(join(copy, "checks", "check.mjs"), "\n");
    const edited = corpusGraderSha256(copy);
    expect(edited).not.toBe(original);
    writeFileSync(join(copy, "checks", "extra.mjs"), "export {};\n");
    const added = corpusGraderSha256(copy);
    expect(new Set([original, edited, added]).size).toBe(3);
    const acceptance = join(copy, "acceptance.json");
    writeFileSync(acceptance, readFileSync(acceptance, "utf8").replace("c1", "c9"));
    const reworded = corpusGraderSha256(copy);
    expect(new Set([original, edited, added, reworded]).size).toBe(4);
    // A check under another name is another check, the same bytes or not.
    renameSync(join(copy, "checks", "extra.mjs"), join(copy, "checks", "other.mjs"));
    expect(new Set([original, edited, added, reworded, corpusGraderSha256(copy)]).size).toBe(5);
    // The fixture, the solution and the prompt are not the grader.
    cpSync(source, join(copy, "..", "again"), { recursive: true });
    appendFileSync(join(copy, "..", "again", "fixture", "csv.ts"), "\n");
    expect(corpusGraderSha256(join(copy, "..", "again"))).toBe(original);
  });
});

// ─── The manifest ───

describe("one manifest: every task there is, from the loaders that already read them", () => {
  const all = availableTasks();

  test("48 tasks: the corpus, its supplement and the mined ones, each in its family", () => {
    expect(all).toHaveLength(48);
    const count = (key: (entry: (typeof all)[number]) => string) => {
      const counts: Record<string, number> = {};
      for (const entry of all) counts[key(entry)] = (counts[key(entry)] ?? 0) + 1;
      return counts;
    };
    expect(count((entry) => entry.source)).toEqual({ corpus: 12, supplement: 6, serious: 30 });
    expect(count((entry) => entry.task.family)).toEqual({
      F1: 3,
      F2: 3,
      F3: 3,
      F4: 3,
      F5: 3,
      F6: 3,
      F7: 30,
    });
    expect(count((entry) => entry.task.size)).toEqual({ small: 18, serious: 30 });
    expect(new Set(all.map((entry) => entry.task.id)).size).toBe(48);
    // They are the loaders' own tasks, not a second reading of the files.
    expect(all.filter((entry) => entry.source === "corpus").map((entry) => entry.task.id)).toEqual(
      corpusParityTasks().map((task) => task.id),
    );
    expect(availableTasks(["supplement"]).map((entry) => entry.source)).toEqual(
      Array(6).fill("supplement"),
    );
    // The same directory given as two sources is the same ids twice.
    expect(() => availableTasks(["corpus", "supplement"], { supplement: CORPUS_DIR })).toThrow(
      /Task csv-state-machine is in both corpus and supplement/,
    );
  });

  test("a selection is the tasks named, in the order named; an unknown one is refused by name", () => {
    const serious = all.find((entry) => entry.source === "serious")!.task.id;
    const chosen = selectTasks(all, ["wip-due-dates", serious, "csv-state-machine"]);
    expect(chosen.map((entry) => `${entry.task.id}:${entry.source}:${entry.task.family}`)).toEqual([
      "wip-due-dates:supplement:F6",
      `${serious}:serious:F7`,
      "csv-state-machine:corpus:F1",
    ]);
    expect(selectTasks(all)).toHaveLength(48);
    expect(() => selectTasks(all, ["csv-state-machine", "csv-state-machin"])).toThrow(
      /^No such task: csv-state-machin\. 48 task\(s\) are available from corpus, supplement, serious\.$/,
    );
    expect(() => selectTasks(all, ["queue-race", "queue-race"])).toThrow(/named twice/);
  });

  test("the CLI plans all 48 by default, or the subset named, with the sources it came from", () => {
    const base = ["--dry-run", "--out", "/tmp/x", "--model", "m"];
    const every = parseCli(base)!;
    expect(every.tasks).toHaveLength(48);
    expect(Object.values(every.sources!).filter((source) => source === "serious")).toHaveLength(30);
    const serious = all.find((entry) => entry.source === "serious")!.task.id;
    const some = parseCli([...base, "--tasks", `review-invoice-rules,${serious}`])!;
    expect(some.tasks.map((task) => `${task.id}:${task.family}`)).toEqual([
      "review-invoice-rules:F5",
      `${serious}:F7`,
    ]);
    expect(some.sources).toEqual({ "review-invoice-rules": "supplement", [serious]: "serious" });
    expect(parseCli([...base, "--source", "corpus,supplement"])!.tasks).toHaveLength(18);
    expect(() => parseCli([...base, "--source", "corpus,mined"])).toThrow(
      /--source names corpus, supplement, serious, not mined/,
    );
    expect(() => parseCli([...base, "--tasks", "nope"])).toThrow(/No such task: nope/);
    // One corpus directory, as the CLI always took.
    expect(parseCli([...base, "--corpus", CORPUS_DIR])!.tasks).toHaveLength(12);
  });

  test("the CLI's budget: limits all three or none, shares as plain numbers, a seed, the manifest", () => {
    const base = ["--dry-run", "--out", "/tmp/x", "--model", "m", "--tasks", "queue-race"];
    const plain = parseCli(base)!;
    expect(plain.limits).toBeUndefined();
    expect(plain.bounded).toBe(false);
    expect(plain.seed).toBeUndefined();
    expect(plain.accounts).toEqual({
      rune: { usedPct: null, stopAtPct: null },
      "claude-code": { usedPct: null, stopAtPct: null },
    });
    const full = parseCli([
      ...base,
      "--max-pairs",
      "3",
      "--max-attempts",
      "8",
      "--wall-allowance-min",
      "150.5",
      "--bounded",
      "--seed",
      "42",
      "--rune-used-pct",
      "12.5",
      "--rune-stop-at-pct",
      "80",
      "--claude-code-stop-at-pct",
      "70",
      "--write-manifest",
      "/tmp/x/approved.json",
    ])!;
    expect(full).toMatchObject({
      limits: { maxPairs: 3, maxAttempts: 8, wallAllowanceMs: 150.5 * 60_000 },
      bounded: true,
      seed: 42,
      accounts: {
        rune: { usedPct: 12.5, stopAtPct: 80 },
        "claude-code": { usedPct: null, stopAtPct: 70 },
      },
      writeManifest: "/tmp/x/approved.json",
    });
    expect(() => parseCli([...base, "--max-pairs", "3"])).toThrow(
      /one budget: give all three or none/,
    );
    expect(() =>
      parseCli([...base, "--max-pairs", "0", "--max-attempts", "8", "--wall-allowance-min", "5"]),
    ).toThrow(/--max-pairs must be a plain positive whole number/);
    expect(() =>
      parseCli([...base, "--max-pairs", "3", "--max-attempts", "1e2", "--wall-allowance-min", "5"]),
    ).toThrow(/--max-attempts/);
    for (const typo of ["101", "-5", "0x10", "80%"])
      expect(() => parseCli([...base, "--rune-stop-at-pct", typo])).toThrow(
        /--rune-stop-at-pct must be a plain number from 0 to 100/,
      );
    expect(() => parseCli([...base, "--seed", "1.5"])).toThrow(/--seed/);
    expect(() =>
      parseCli(["--real", "--out", "/tmp/x", "--model", "m", "--write-manifest", "/tmp/m.json"]),
    ).toThrow(/--write-manifest goes with --dry-run/);
  });

  test("a manifest is run as approved, with the windows as they read NOW", async () => {
    const dir = temp("manifest-cli-");
    const file = join(dir, "approved.json");
    await runPairs({
      ...parseCli([
        "--dry-run",
        "--out",
        join(dir, "plan"),
        "--model",
        "m",
        "--tasks",
        "queue-race,cache-plan",
        "--seed",
        "3",
        "--max-pairs",
        "2",
        "--max-attempts",
        "6",
        "--wall-allowance-min",
        "100",
        "--rune-used-pct",
        "10",
        "--rune-stop-at-pct",
        "70",
        "--write-manifest",
        file,
      ])!,
      log: () => {},
    });
    const approved = readManifest(file);
    expect(approved.accounts.rune).toEqual({ usedPct: 10, stopAtPct: 70 });
    const base = ["--real", "--manifest", file, "--out", join(dir, "live")];
    // As written: the plan, the limits and the reading it was approved with.
    const asWritten = parseCli(base)!;
    expect(asWritten).toMatchObject({
      dryRun: false,
      runs: 1,
      seed: 3,
      limits: { maxPairs: 2, maxAttempts: 6, wallAllowanceMs: 100 * 60_000 },
      bounded: false,
      accounts: { rune: { usedPct: 10, stopAtPct: 70 } },
    });
    expect([...asWritten.tasks.map((task) => task.id)].sort()).toEqual([
      "cache-plan",
      "queue-race",
    ]);
    expect(asWritten.sources).toEqual({ "queue-race": "corpus", "cache-plan": "corpus" });
    // A reading taken now replaces the one in the file; what was not given stays.
    const now = parseCli([
      ...base,
      "--rune-used-pct",
      "42",
      "--claude-code-used-pct",
      "8",
      "--claude-code-stop-at-pct",
      "60",
      "--bounded",
    ])!;
    expect(now.accounts).toEqual({
      rune: { usedPct: 42, stopAtPct: 70 },
      "claude-code": { usedPct: 8, stopAtPct: 60 },
    });
    expect(now.bounded).toBe(true);
    // The plan itself is not negotiable from the command line.
    const ignored = parseCli([...base, "--tasks", "csv-state-machine", "--runs", "5"])!;
    expect(ignored.tasks).toHaveLength(2);
    expect(ignored.runs).toBe(1);
    expect(() => parseCli([...base, "--rune-used-pct", "lots"])).toThrow(/--rune-used-pct/);
  });

  const input = (tasks = ["t1", "t2", "t3"].map((id) => syntheticTask(id))) => {
    const arms = ["rune", "claude-code"] as [ParityArm, ParityArm];
    return {
      tasks,
      manifest: buildManifest({
        arms,
        mode: "product",
        runs: 2,
        seed: 5,
        tasks: tasks.map((task) => manifestTask(task, "corpus")),
        specs: { rune: { model: "r" }, "claude-code": { model: "c" } },
        limits: { maxPairs: 6, maxAttempts: 14, wallAllowanceMs: 300 * 60_000 },
        accounts: {},
        bounded: true,
        order: planPairs(tasks, arms, 2, 5).map((job) => ({
          task: job.task.id,
          run: job.run,
          first: job.order[0],
          second: job.order[1],
        })),
      }),
    };
  };

  test("a manifest pins each task's prompt and its checks, and counts what the plan needs", () => {
    const { tasks, manifest } = input();
    expect(manifestProblems(manifest)).toEqual([]);
    expect(manifest.families).toEqual({ F1: 3 });
    expect(manifest.needs).toEqual({
      pairs: 6,
      armRuns: 12,
      worstCaseWallMs: 12 * WALL_LIMIT_MS.small,
    });
    expect(manifest.tasks[0]).toEqual({
      id: "t1",
      family: "F1",
      size: "small",
      source: "corpus",
      grader: tasks[0]!.grader,
      prompt: promptDigest("Finish t1."),
    });
    expect(manifest.wallLimitsMs).toEqual(WALL_LIMIT_MS);
    // A serious task's pair is ninety minutes of wall limit, not forty.
    const mixed = buildManifest({
      ...manifest,
      tasks: [manifest.tasks[0]!, { ...manifest.tasks[1]!, size: "serious", family: "F7" }],
      order: [
        { task: "t1", run: 1, first: "rune", second: "claude-code" },
        { task: "t2", run: 1, first: "claude-code", second: "rune" },
      ],
    });
    expect(mixed.needs.worstCaseWallMs).toBe(2 * WALL_LIMIT_MS.small + 2 * WALL_LIMIT_MS.serious);
    expect(mixed.families).toEqual({ F1: 1, F7: 1 });
  });

  test("source drift: a task that is no longer the task the manifest pinned is named, and nothing runs", () => {
    const { tasks, manifest } = input();
    const now = (over: (task: ParityTask) => Partial<ParityTask>) =>
      tasks.map((task) => ({ ...task, ...over(task) }));
    expect(manifestDrift(manifest, tasks)).toEqual([]);
    expect(
      manifestDrift(
        manifest,
        now((t) => (t.id === "t2" ? { prompt: "Finish t2, quickly." } : {})),
      ),
    ).toEqual(["t2: its prompt changed since the manifest was written"]);
    expect(
      manifestDrift(
        manifest,
        now((t) => (t.id === "t3" ? { grader: "0".repeat(64) } : {})),
      ),
    ).toEqual(["t3: its checks changed since the manifest was written"]);
    expect(
      manifestDrift(
        manifest,
        now((t) => (t.id === "t1" ? { family: "F2", size: "serious" } : {})),
      ),
    ).toEqual([
      "t1: filed under F2, and the manifest says F1",
      "t1: now serious, and the manifest says small",
    ]);
    expect(manifestDrift(manifest, tasks.slice(1))).toEqual([
      "t1: no longer available from its source",
    ]);
    // Through the runner's own door: refused before any option exists to run.
    const moved = now((t) => (t.id === "t3" ? { grader: "0".repeat(64) } : {})).map((task) => ({
      source: "corpus" as const,
      task,
    }));
    expect(() => optionsFromManifest(manifest, "/tmp/x", false, moved)).toThrow(
      /^Source drift: the tasks are not the ones the manifest pinned, and nothing was run\.\n {2}t3: its checks changed since the manifest was written$/,
    );
    // An order edited by hand is not the order its own seed gives.
    const available = tasks.map((task) => ({ source: "corpus" as const, task }));
    const reordered = { ...manifest, order: [...manifest.order].reverse() };
    expect(() => optionsFromManifest(reordered, "/tmp/x", false, available)).toThrow(
      /edited by hand/,
    );
    expect(optionsFromManifest(manifest, "/tmp/x", false, available).dryRun).toBe(false);
  });

  test("a file that is not a manifest is refused for what is wrong with it", () => {
    const { manifest } = input();
    const bad = (over: object) => manifestProblems({ ...manifest, ...over });
    expect(manifestProblems("x")).toEqual(["not a JSON object"]);
    expect(bad({ schema: "parity-manifest/0" })[0]).toMatch(/^not a parity-manifest\/1 manifest/);
    expect(bad({ arms: ["rune"] })).toEqual(["arms must name two arms"]);
    expect(bad({ mode: "vibes" })).toEqual(["mode must be product or harness"]);
    expect(bad({ runs: 0 })[0]).toBe("runs must be a positive whole number");
    expect(bad({ tasks: [] })[0]).toBe("tasks must name at least one task");
    expect(bad({ order: manifest.order.slice(1) })).toEqual([
      "order lists 5 pair(s); 3 task(s) × 2 run(s) is 6",
    ]);
    expect(
      bad({ order: [{ ...manifest.order[0]!, task: "t9" }, ...manifest.order.slice(1)] }),
    ).toEqual(["order names t9, which is not one of the tasks"]);
    const dir = temp("manifest-file-");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    expect(() => readManifest(join(dir, "broken.json"))).toThrow(/cannot be read as a manifest/);
    writeFileSync(join(dir, "other.json"), JSON.stringify({ kind: "series" }));
    expect(() => readManifest(join(dir, "other.json"))).toThrow(/is not a usable manifest/);
    expect(() => readManifest(join(dir, "absent.json"))).toThrow(/cannot be read as a manifest/);
  });
});

// ─── The corpus as parity tasks ───

describe("the corpus as parity tasks", () => {
  const tasks = corpusParityTasks();

  test("twelve tasks, their families, and the prompt every earlier row was sent", () => {
    expect(tasks.map((task) => `${task.id}:${task.family}`)).toEqual([
      "csv-state-machine:F1",
      "off-by-one-window:F1",
      "queue-race:F1",
      "health-endpoint-and-changelog:F2",
      "note-field-and-exporter:F2",
      "dependent-migration:F3",
      "three-module-dependent:F3",
      "responsive-project-board:F4",
      "signup-form-states:F4",
      "explain-quote-handling:F5",
      "cache-plan:F5",
      "working-tree-integration:F6",
    ]);
    for (const task of tasks) {
      expect(task.size).toBe("small");
      expect(task.prompt).toContain("Work autonomously in this fixture");
      expect(task.criteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(tasks.filter((task) => task.browser).map((task) => task.id)).toEqual([
      "responsive-project-board",
      "signup-form-states",
    ]);
  });

  test("no-code and the files it asks for come from the task's own words", () => {
    expect(
      tasks.filter((task) => task.noCode).map((task) => [task.id, task.expectedNewFiles]),
    ).toEqual([
      ["explain-quote-handling", ["ANSWER.md"]],
      ["cache-plan", ["PLAN.md"]],
    ]);
    // No other task asks for a new file by name: CHANGELOG.md is an edit.
    expect(tasks.filter((task) => task.expectedNewFiles && !task.noCode)).toEqual([]);
    expect(forbidsCode(["no code may be changed"])).toBe(true);
    expect(forbidsCode(["no source file may be modified"])).toBe(true);
    expect(forbidsCode(["window.test.ts must not be edited"])).toBe(false);
    expect(forbidsCode(undefined)).toBe(false);
    expect(expectedNewFilesOf("Update CHANGELOG.md and write NOTES.md.", ["CHANGELOG.md"])).toEqual(
      ["NOTES.md"],
    );
  });

  test("what a task protects comes from its own words, and its own solution leaves it alone", () => {
    const supplementDir = join(CORPUS_DIR, "..", "parity-tasks");
    const supplement = corpusParityTasks(supplementDir);
    const contract = (list: typeof tasks) =>
      list.filter((task) => task.protectedPaths).map((task) => [task.id, task.protectedPaths]);
    expect(contract(tasks)).toEqual([
      ["off-by-one-window", ["window.test.ts"]],
      ["working-tree-integration", ["money.ts"]],
    ]);
    expect(contract(supplement)).toEqual([
      ["wip-due-dates", ["todos.ts"]],
      ["finish-utils-split", ["money.ts", "report.ts", "text.ts"]],
    ]);
    // No shipped task declares a boundary: the only mechanical source for one,
    // the reference solution, would fail a correct answer (parity-index.md,
    // Changes, 2026-10-04).
    expect([...tasks, ...supplement].filter((task) => task.allowedPaths)).toEqual([]);
    // The reading is the task's own: its reference solution leaves every
    // protected file byte for byte as the fixture has it.
    for (const [root, list] of [
      [CORPUS_DIR, tasks],
      [supplementDir, supplement],
    ] as const)
      for (const task of list)
        for (const path of task.protectedPaths ?? []) {
          const seeded = [
            join(root, task.id, "untracked", path),
            join(root, task.id, "fixture", path),
          ].find((file) => existsSync(file))!;
          const solved = join(root, task.id, "solution", path);
          if (existsSync(solved))
            expect({
              task: task.id,
              path,
              same: readFileSync(solved).equals(readFileSync(seeded)),
            }).toEqual({ task: task.id, path, same: true });
        }

    const files = ["a.ts", "b.ts", "a.test.ts", "cli.ts", "orders/A-1.json"];
    const read = (prompt: string, constraints?: string[]) =>
      protectedPathsOf(prompt, constraints, files);
    expect(read("Do not change a.ts.")).toEqual(["a.ts"]);
    expect(read("Do not edit or weaken a.test.ts. Fix a.ts.")).toEqual(["a.test.ts"]);
    // The instruction's own object, not every file its sentence names.
    expect(read("Keep a.ts exactly as it is in the working tree and finish it in cli.ts.")).toEqual(
      ["a.ts"],
    );
    // "them" is what the sentence named BEFORE the instruction.
    expect(
      read("a.ts and b.ts are done; leave them exactly as they are, then fix cli.ts."),
    ).toEqual(["a.ts", "b.ts"]);
    expect(read("Leave `orders/A-1.json` exactly as it is.")).toEqual(["orders/A-1.json"]);
    expect(read("Fix cli.ts.", ["a.test.ts must not be edited"])).toEqual(["a.test.ts"]);
    expect(read("Fix it.", ["a.test.ts must not be edited, unlike cli.ts"])).toEqual(["a.test.ts"]);
    // A whole name: a.ts is not the tail of data.ts.
    expect(
      protectedPathsOf("data.ts and b.ts are done; leave them exactly as they are.", undefined, [
        "a.ts",
        "b.ts",
      ]),
    ).toEqual(["b.ts"]);
    // Nothing the fixture holds is named: nothing is protected.
    expect(
      read("Do not change the exported signature. Do not install packages. Keep the suite green.", [
        "no source file may be modified",
      ]),
    ).toBeUndefined();
    // A file MENTIONED is not a file protected.
    expect(
      read("Orders saved before say qty (orders/A-1.json is one) and must keep loading."),
    ).toBeUndefined();
  });

  test("an id the corpus does not hold is refused by name", () => {
    expect(() => corpusParityTasks(CORPUS_DIR, ["csv-state-machine", "nope"])).toThrow(/nope/);
  });

  test("a check's status: exit 2 is impossible only with the checks' own marker", () => {
    expect(checkStatus({ exitCode: 0, output: "" })).toBe(0);
    expect(checkStatus({ exitCode: 1, output: IMPOSSIBLE_MARKER })).toBe(1);
    expect(
      checkStatus({ exitCode: 2, output: `acceptance not-applicable: x — ${IMPOSSIBLE_MARKER}` }),
    ).toBe(2);
    expect(checkStatus({ exitCode: 2, output: "usage: cli <path> <id> <text>" })).toBe(1);
    expect(checkStatus({ exitCode: null, output: "" })).toBe(1);
    expect(checkStatus({ exitCode: 0, output: "", heldUp: true })).toBe(1);
    expect(
      outcomeFromChecks([
        { id: "c1", status: 0 },
        { id: "c2", status: 1 },
        { id: "c3", status: 2 },
      ]),
    ).toEqual({
      hiddenPassed: 1,
      hiddenTotal: 2,
      regressionsIntroduced: 0,
      buildBroken: false,
      impossible: ["c3"],
    });
  });
});

/** Seed a task's workspace, overlay a tree of the corpus onto it, and grade it. */
async function gradeWith(
  id: string,
  overlay?: string,
  edit?: (workspace: string) => void,
): Promise<{ outcome: Outcome; workspace: string; evidence: string }> {
  const [task] = corpusParityTasks(CORPUS_DIR, [id]);
  const dir = temp(`grade-${id}-`);
  const workspace = join(dir, "workspace");
  const evidence = join(dir, "evidence");
  await task!.prepare(workspace);
  if (overlay) cpSync(join(CORPUS_DIR, id, overlay), workspace, { recursive: true });
  edit?.(workspace);
  return { outcome: await task!.grade(workspace, evidence), workspace, evidence };
}

describe("the corpus grader, against real trees", () => {
  const coding = corpusParityTasks().filter((task) => !task.browser);

  test("every criterion runs: the corpus's own solution passes all of them", async () => {
    for (const task of coding) {
      const { outcome, evidence } = await gradeWith(task.id, "solution");
      expect({ task: task.id, outcome }).toEqual({
        task: task.id,
        outcome: {
          hiddenPassed: task.criteria.length,
          hiddenTotal: task.criteria.length,
          regressionsIntroduced: 0,
          buildBroken: false,
          impossible: [],
        },
      });
      const graded = JSON.parse(readFileSync(join(evidence, "grade.json"), "utf8"));
      expect(graded.map((r: { id: string }) => r.id)).toEqual(task.criteria.map((c) => c.id));
    }
  }, 120_000);

  test("…and a partial tree gets partial credit, not the first failure's zero", async () => {
    // The fixture is the untouched starting point: some criteria pass on it
    // (the ones that check nothing was broken), the rest fail. A grader that
    // stopped at the first failure would report none passed.
    const explain = await gradeWith("explain-quote-handling");
    expect(explain.outcome).toMatchObject({ hiddenPassed: 1, hiddenTotal: 2 });
    const window = await gradeWith("off-by-one-window");
    expect(window.outcome.hiddenTotal).toBe(3);
    expect(window.outcome.hiddenPassed).toBeGreaterThan(0);
    expect(window.outcome.hiddenPassed).toBeLessThan(3);
  }, 60_000);

  test("an arm's own exit 2 is a failed check, not an impossible one", async () => {
    // dependent-migration's own CLI exits 2 on bad arguments. A store.ts that
    // exits 2 as it loads must fail the criteria that load it.
    const { outcome } = await gradeWith("dependent-migration", "solution", (workspace) =>
      writeFileSync(join(workspace, "store.ts"), "process.exit(2);\nexport {};\n"),
    );
    expect(outcome.impossible).toEqual([]);
    expect(outcome.hiddenTotal).toBe(3);
    expect(outcome.hiddenPassed).toBe(0);
  }, 60_000);

  test("an output flood from the arm's code is its failure, not the grader's", async () => {
    // Synchronously, so the flood cannot be cut short by the check's own exit.
    const { outcome } = await gradeWith("csv-state-machine", "solution", (workspace) =>
      appendFileSync(
        join(workspace, "csv.ts"),
        '\nimport { writeSync as __flood } from "node:fs";\n__flood(1, "x".repeat(17 * 1024 * 1024));\n',
      ),
    );
    expect(outcome).toMatchObject({ hiddenPassed: 0, hiddenTotal: 3, impossible: [] });
  }, 60_000);

  test("the check runs without the rig's credentials in its environment", async () => {
    const previous = process.env.PARITY_SENTINEL_API_KEY;
    process.env.PARITY_SENTINEL_API_KEY = "sk-sentinel";
    try {
      const { workspace } = await gradeWith("csv-state-machine", "solution", (ws) =>
        appendFileSync(
          join(ws, "csv.ts"),
          `\nimport { writeFileSync as __w } from "node:fs";\n__w(${JSON.stringify(join(ws, "env-seen.json"))}, JSON.stringify(Object.keys(process.env)));\n`,
        ),
      );
      const seen = JSON.parse(readFileSync(join(workspace, "env-seen.json"), "utf8")) as string[];
      expect(seen).toContain("PATH");
      expect(seen).not.toContain("PARITY_SENTINEL_API_KEY");
      expect(seen.filter((name) => name.startsWith("RUNE_"))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PARITY_SENTINEL_API_KEY;
      else process.env.PARITY_SENTINEL_API_KEY = previous;
    }
  }, 60_000);

  test("no browser here: the browser criteria are impossible for every arm, and planted help is wiped", async () => {
    const previous = process.env.RUNE_BENCH_PLAYWRIGHT;
    delete process.env.RUNE_BENCH_PLAYWRIGHT;
    try {
      const plain = await gradeWith("signup-form-states", "solution");
      expect(plain.outcome).toEqual({
        hiddenPassed: 0,
        hiddenTotal: 0,
        regressionsIntroduced: 0,
        buildBroken: false,
        impossible: ["c1", "c2", "c3"],
      });
      // An arm that leaves its own `.rune-acceptance/env.json` behind — a
      // "browser" module that passes everything — is not run as the grader.
      const planted = await gradeWith("signup-form-states", "solution", (workspace) => {
        mkdirSync(join(workspace, CHECK_DIR), { recursive: true });
        writeFileSync(
          join(workspace, "fake-playwright.mjs"),
          "export const chromium = { launch: async () => { throw new Error('reached'); } };\n",
        );
        writeFileSync(
          join(workspace, CHECK_DIR, "env.json"),
          JSON.stringify({ playwrightModule: join(workspace, "fake-playwright.mjs") }),
        );
      });
      expect(existsSync(join(planted.workspace, CHECK_DIR, "env.json"))).toBe(false);
      expect(planted.outcome.impossible).toEqual(["c1", "c2", "c3"]);
    } finally {
      if (previous !== undefined) process.env.RUNE_BENCH_PLAYWRIGHT = previous;
    }
  }, 60_000);
});

// ─── The series, with fake arms ───

interface FakeCall {
  task: string;
  run: number;
  dir: string;
  limits: ArmLimits;
  /** `git status --porcelain --untracked-files=all` of the workspace as handed over. */
  statusAtStart: string;
}

interface FakeTurn {
  signals?: Partial<OutcomeSignals>;
  result?: Partial<ArmResult>;
}

/** A stand-in arm: the script says what the tool did; run-pairs does the rest. */
function fakeArm(
  name: ArmName,
  script: (call: FakeCall & { workspace: string; n: number }) => FakeTurn | void,
  options: { version?: (n: number) => string | null; refusal?: string } = {},
) {
  const calls: FakeCall[] = [];
  let versions = 0;
  const arm: ComparatorArm = {
    name,
    version: () => {
      versions++;
      return options.version ? options.version(versions) : `${name} 1.0.0-fake`;
    },
    plan: (task, dir) => ({
      arm: name,
      command: [`fake-${name}`, task.prompt],
      cwd: workspaceOf(dir),
      env: { PATH: "/usr/bin" },
      parityGaps: [`fake ${name}`],
      ...(options.refusal ? { refusal: options.refusal } : {}),
    }),
    parse: () => {
      throw new Error("run-pairs never parses; the arm does");
    },
    async runArm(task, dir, limits) {
      const workspace = workspaceOf(dir);
      const run = Number(/run-(\d+)/.exec(dir)![1]);
      const call: FakeCall = {
        task: task.id,
        run,
        dir,
        limits,
        statusAtStart: git(workspace, "status", "--porcelain", "--untracked-files=all"),
      };
      calls.push(call);
      const turn = script({ ...call, workspace, n: calls.length }) ?? {};
      const signals: OutcomeSignals = {
        exitCode: 0,
        claimedSuccess: true,
        reachedModel: true,
        ...turn.signals,
      };
      return {
        ...judged(signals, {
          resultText: null,
          turns: 3,
          calls: 3,
          reportedCostUsd: null,
          usage: null,
          models: [],
        }),
        arm: name,
        version: `${name} 1.0.0-fake`,
        command: [`fake-${name}`],
        cwd: workspace,
        exitCode: signals.exitCode,
        durationMs: 1234,
        ...(signals.stopped ? { stopped: signals.stopped } : {}),
        listUsd: 0.01,
        estimated: false,
        entries: 3,
        parityGaps: [],
        ...turn.result,
      };
    },
  };
  return { arm, calls, versionCalls: () => versions };
}

const solve = (call: { workspace: string }) =>
  void writeFileSync(join(call.workspace, "done.txt"), "ok\n");
/** A quota wall, as the real arms report one: no call went through, and it cost nothing. */
const refused: FakeTurn = {
  signals: { exitCode: 1, claimedSuccess: false, reachedModel: false, provider: "quota" },
  result: { listUsd: null, reportedCostUsd: 0, calls: 0 },
};

/** A pinned build for the fake Rune: a file the series fingerprints. */
function pinnedBuild(dir: string): string {
  const path = join(dir, "rune-build");
  writeFileSync(path, "build 1\n");
  return path;
}

function series(
  dir: string,
  arms: { rune: ComparatorArm; comparator: ComparatorArm },
  over: Partial<PairSeriesOptions> = {},
): PairSeriesOptions & { logged: string[] } {
  const logged: string[] = [];
  return {
    tasks: ["t1", "t2"].map((id) => syntheticTask(id)),
    arms: ["rune", "claude-code"],
    runs: 1,
    mode: "product",
    out: join(dir, "out"),
    specs: {
      rune: { model: "rune-model", command: [pinnedBuild(dir)] },
      "claude-code": { model: "claude-model" },
    },
    env: { RUNE_EVAL_BUDGET_USD: "5" },
    implementations: { rune: arms.rune, "claude-code": arms.comparator },
    log: (line) => void logged.push(line),
    logged,
    // Generous limits, and the comparator's unwatchable account accepted: what
    // every live series must now say. The budget tests set their own.
    limits: { maxPairs: 100, maxAttempts: 400, wallAllowanceMs: 24 * 60 * 60_000 },
    bounded: true,
    ...over,
  };
}

const readRows = (out: string): ParityRunResult[] =>
  readFileSync(join(out, RESULTS), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** The landed scorer's own reading of a results file: validated, and paired. */
function scorerReads(out: string) {
  const { rows } = loadResults([join(out, RESULTS)]);
  const pairing = pairRows(rows, "product", "claude-code");
  return { rows, pairing };
}

describe("a series, with fake arms", () => {
  test("whole pairs, fresh trees, the same wall limit, and rows the scorer accepts", async () => {
    const dir = temp("series-basic-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", () => ({})); // claims success, does nothing
    const options = series(dir, { rune: rune.arm, comparator: claude.arm }, { runs: 2 });
    const report = await runPairs(options);
    expect(report).toMatchObject({ planned: 4, pairsRun: 4, unscoredPairs: 0, requeued: 0 });
    const rows = readRows(options.out);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(validateRow(row)).toEqual([]);
    // Every arm got a fresh, clean checkout of the fixture — never the other's tree.
    for (const call of [...rune.calls, ...claude.calls]) {
      expect(call.statusAtStart).toBe("");
      expect(call.limits.timeoutMs).toBe(WALL_LIMIT_MS.small);
      expect(call.limits.budgetUsd).toBeUndefined();
    }
    // The comparator claimed success on work the grader found half done.
    for (const row of rows.filter((r) => r.arm === "claude-code"))
      expect(row).toMatchObject({ falseCompletion: true, clean: false, scope: 1 });
    for (const row of rows.filter((r) => r.arm === "rune"))
      expect(row).toMatchObject({ falseCompletion: false, clean: true, scope: 1 });
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(4);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
    // Alternation, as it happened: the first arm of each pair, in order.
    const firsts = rows
      .filter((_, i) => i % 2 === 0)
      .map((row) => `${row.task}#${row.run}:${row.arm}`);
    expect(firsts).toEqual(["t1#1:rune", "t2#1:claude-code", "t1#2:claude-code", "t2#2:rune"]);
    const record = JSON.parse(readFileSync(join(options.out, SERIES), "utf8"));
    expect(record).toMatchObject({ kind: "parity-pairs", stoppedEarly: null });
    expect(record.completedAt).toBeString();
  }, 60_000);

  test("every row names the source it ran and the models its arm was configured with", async () => {
    const dir = temp("series-identity-");
    const rune = fakeArm("rune", solve);
    // The arm states its roster, as the real Rune arm does, in no particular order.
    rune.arm.roster = (spec) => [`${spec.provider}/${spec.model}`, "codex/model-big"];
    const claude = fakeArm("claude-code", solve);
    const options = series(dir, { rune: rune.arm, comparator: claude.arm });
    await runPairs(options);

    const build = createHash("sha256").update("build 1\n").digest("hex");
    const record = JSON.parse(readFileSync(join(options.out, SERIES), "utf8"));
    expect(record.build).toEqual({ rune: build });
    // Rune's provider is its default when the series names none.
    expect(record.rosters).toEqual({ rune: ["codex/rune-model", "codex/model-big"] });

    const rows = readRows(options.out);
    expect(rows).toHaveLength(4);
    for (const row of rows.filter((r) => r.arm === "rune")) {
      expect(row.sourceBuild).toBe(build);
      expect(row.roster).toEqual(["codex/model-big", "codex/rune-model"]);
    }
    // An arm the series fingerprints no source for, and that states no roster, says neither.
    for (const row of rows.filter((r) => r.arm === "claude-code")) {
      expect("sourceBuild" in row).toBe(false);
      expect("roster" in row).toBe(false);
    }
    for (const row of rows) expect(validateRow(row)).toEqual([]);
    expect(mixedBuildProblems(rows, "claude-code")).toEqual([]);
    expect(comparabilityProblems(rows, "claude-code").mixedConfig).toEqual([]);
  }, 60_000);

  test("a run that never produced a row is still a row of that build and that roster", async () => {
    const dir = temp("series-identity-dead-");
    const dead: ComparatorArm = {
      ...fakeArm("rune", solve).arm,
      roster: () => ["codex/rune-model"],
      async runArm() {
        throw new Error("spawn ENOENT");
      },
    };
    const options = series(
      dir,
      { rune: dead, comparator: fakeArm("claude-code", solve).arm },
      { tasks: ["t1", "t2", "t3", "t4", "t5"].map((id) => syntheticTask(id)) },
    );
    await runPairs(options);
    const unstarted = readRows(options.out).filter((r) => r.arm === "rune");
    expect(unstarted.length).toBeGreaterThan(0);
    for (const row of unstarted) {
      expect(row).toMatchObject({ scored: false, terminal: "not_started" });
      expect(row.sourceBuild).toBe(createHash("sha256").update("build 1\n").digest("hex"));
      expect(row.roster).toEqual(["codex/rune-model"]);
      expect(validateRow(row)).toEqual([]);
    }
  }, 60_000);

  test("a correct answer that changed what the task protected is correct, and out of scope", async () => {
    const dir = temp("series-protected-");
    const rune = fakeArm("rune", (call) => {
      solve(call);
      writeFileSync(join(call.workspace, "main.ts"), "export const x = 2;\n");
    });
    const claude = fakeArm("claude-code", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: [syntheticTask("t1", { protectedPaths: ["main.ts"] })] },
    );
    await runPairs(options);
    const rows = readRows(options.out);
    const row = (arm: ParityArm) => rows.find((r) => r.arm === arm)!;
    expect(quality(row("rune").outcome)).toBe(1);
    expect(row("rune")).toMatchObject({ scope: 0, scopeNotes: ["main.ts (protected)"] });
    expect(row("claude-code")).toMatchObject({ scope: 1 });
    expect(row("claude-code").scopeNotes).toBeUndefined();
    // Under parity-run/1 the same run was in scope: the row says both.
    expect(row("rune").legacy).toEqual({ clean: true, scope: 1 });
    expect(row("claude-code").legacy).toEqual({ clean: true, scope: 1 });
    for (const r of rows) expect(validateRow(r)).toEqual([]);
  }, 60_000);

  test('an honest "not finished" and a crash are written as what they were', async () => {
    const dir = temp("series-terminal-");
    // Neither arm finishes or claims to. Rune's own report names its stop; the
    // comparator's process just ends, having reached the model.
    const unfinished = { exitCode: 1, claimedSuccess: false, reachedModel: true };
    const rune = fakeArm("rune", () => ({ signals: { ...unfinished, selfStopped: "open_steps" } }));
    const claude = fakeArm("claude-code", () => ({ signals: unfinished }));
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: [syntheticTask("t1")] },
    );
    await runPairs(options);
    const rows = readRows(options.out);
    const row = (arm: ParityArm) => rows.find((r) => r.arm === arm)!;
    for (const r of rows) {
      expect(validateRow(r)).toEqual([]);
      // Both are the tool failing the task: scored, and graded the same.
      expect(r).toMatchObject({ schema: "parity-run/2", scored: true, falseCompletion: false });
      expect(quality(r.outcome)).toBe(0.5);
    }
    expect(row("rune")).toMatchObject({
      terminal: "incomplete",
      clean: true,
      legacy: { clean: true, scope: 1 },
    });
    // parity-run/1 called this clean: it ended fast and claimed nothing.
    expect(row("claude-code")).toMatchObject({
      terminal: "crashed",
      clean: false,
      legacy: { clean: true, scope: 1 },
    });
    expect(options.logged.join("\n")).toContain("· incomplete · clean");
    expect(options.logged.join("\n")).toContain("· crashed · not clean");
  }, 60_000);

  test("both rows of a pair say what they were given, what graded them and what ran", async () => {
    const dir = temp("series-prints-");
    const rune = fakeArm("rune", () => ({ result: { models: ["m-sub", "rune-model", "m-sub"] } }));
    const claude = fakeArm("claude-code", solve);
    const tasks = [syntheticTask("t1"), syntheticTask("t2")];
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks,
        runs: 2,
        specs: {
          rune: { model: "rune-model", provider: "codex", command: [pinnedBuild(dir)] },
          "claude-code": { model: "claude-model", reasoningEffort: "high" },
        },
      },
    );
    await runPairs(options);
    const rows = readRows(options.out);
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(validateRow(r)).toEqual([]);
    for (const t of tasks) {
      const mine = rows.filter((r) => r.task === t.id);
      // Four runs of one task, by two arms: one starting point, one exam.
      expect(new Set(mine.map((r) => r.fingerprints!.task)).size).toBe(1);
      expect(mine.map((r) => r.fingerprints!.grader)).toEqual(Array(4).fill(t.grader));
      expect(mine[0]!.fingerprints!.task).toMatch(/^[0-9a-f]{64}$/);
    }
    // Two tasks are two starting points and two exams.
    expect(new Set(rows.map((r) => r.fingerprints!.task)).size).toBe(2);
    expect(new Set(rows.map((r) => r.fingerprints!.grader)).size).toBe(2);
    // One configuration per arm, recorded in full.
    const row = (arm: ParityArm) => rows.filter((r) => r.arm === arm);
    expect(new Set(row("rune").map((r) => r.fingerprints!.config))).toEqual(
      new Set([configFingerprint("rune", "product", { model: "rune-model" }, "codex")]),
    );
    expect(new Set(row("claude-code").map((r) => r.fingerprints!.config))).toEqual(
      new Set([
        configFingerprint(
          "claude-code",
          "product",
          { model: "claude-model", reasoningEffort: "high" },
          undefined,
        ),
      ]),
    );
    expect(row("claude-code")[0]).toMatchObject({ reasoningEffort: "high", models: [] });
    expect(row("rune")[0]!.reasoningEffort).toBeUndefined();
    // The roster is what the tool reported, each model once, sorted.
    expect(row("rune")[0]!.models).toEqual(["m-sub", "rune-model"]);
    // The series record names each task's grader too.
    const record = JSON.parse(readFileSync(join(options.out, SERIES), "utf8"));
    expect(record.schema).toBe("parity-run/2");
    expect(record.tasks).toEqual(
      tasks.map((t) => ({ id: t.id, family: "F1", size: "small", grader: t.grader })),
    );
    // And the report takes them as one comparison.
    expect(comparabilityProblems(rows, "claude-code")).toEqual({
      mismatched: [],
      unfingerprinted: [],
      mixedConfig: [],
    });
    expect(() => buildReport({ rows, inputs: [], b: 50 })).not.toThrow();
  }, 120_000);

  test("an unscored row is retried once, alone: the arm that succeeded is not run again", async () => {
    const dir = temp("series-retry-");
    const rune = fakeArm("rune", solve);
    // The comparator's first run of t1 hits a quota wall; every later one works.
    let t1 = 0;
    const claude = fakeArm("claude-code", (call) =>
      call.task === "t1" && t1++ === 0 ? refused : solve(call),
    );
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
      },
    );
    const report = await runPairs(options);
    expect(report).toMatchObject({
      planned: 4,
      pairsRun: 4,
      unscoredPairs: 1,
      requeued: 1,
      retried: ["t1#1:claude-code"],
      attempts: 9,
      halfPairs: [],
    });
    // Rune finished t1 once, and was run on it once.
    expect(rune.calls.filter((call) => call.task === "t1")).toHaveLength(1);
    expect(claude.calls.filter((call) => call.task === "t1")).toHaveLength(2);
    // The retry came after every planned pair, in a directory of its own.
    expect(claude.calls.map((call) => call.task)).toEqual(["t1", "t2", "t3", "t4", "t1"]);
    const rows = readRows(options.out);
    const mine = rows.filter((row) => row.task === "t1");
    expect(mine.map((row) => `${row.run}:${row.arm}:${row.scored}:${row.attempt ?? 1}`)).toEqual([
      "1:rune:true:1",
      "1:claude-code:false:1",
      "1:claude-code:true:2",
    ]);
    expect(mine[1]!.unscoredReason).toBe("provider_quota");
    expect(mine[2]!.evidence).toEndWith(join("run-1", "claude-code-retry"));
    expect(rows.at(-1)).toBe(mine[2]!);
    for (const row of rows) expect(validateRow(row)).toEqual([]);
    // The report pairs the latest attempt; the first is evidence, and still an attempt.
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(4);
    expect(pairing.pairs.every((pair) => pair.rune.scored && pair.comparator.scored)).toBe(true);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
    expect(pairing.rows.comparator).toHaveLength(5);
    expect(latestAttempts(rows).superseded).toEqual([mine[1]!]);
    const f1 = buildReport({ rows, inputs: [], b: 50 }).modes.product.families[0]!;
    expect(f1.n).toBe(4);
    expect(f1.absolute.comparator).toMatchObject({
      attempts: 5,
      scored: 4,
      unscored: { provider_quota: 1 },
    });
    expect(JSON.parse(readFileSync(join(options.out, SERIES), "utf8"))).toMatchObject({
      attempts: 9,
      retried: ["t1#1:claude-code"],
      halfPairs: [],
    });
  }, 60_000);

  test("…once only: a retry that is unscored again is not retried again", async () => {
    const dir = temp("series-once-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", (call) => (call.task === "t1" ? refused : solve(call)));
    const ids = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ids.map((id) => syntheticTask(id)),
      },
    );
    const report = await runPairs(options);
    // One unscored pair of ten planned is not more than a quarter: it runs on.
    expect(report).toMatchObject({
      planned: 10,
      pairsRun: 10,
      unscoredPairs: 1,
      requeued: 1,
      retried: ["t1#1:claude-code"],
    });
    expect(report.stoppedEarly).toBeUndefined();
    expect(claude.calls.filter((call) => call.task === "t1")).toHaveLength(2);
    expect(
      readRows(options.out)
        .filter((r) => r.task === "t1")
        .map((r) => `${r.arm}:${r.scored}:${r.attempt ?? 1}`),
    ).toEqual(["rune:true:1", "claude-code:false:1", "claude-code:false:2"]);
    // Still unscored after its one retry: the pair is out of the index, and counted.
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs.filter((pair) => !pair.comparator.scored)).toHaveLength(1);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
  }, 60_000);

  test("a retry is an arm run like any other: with none left, it is not made", async () => {
    const dir = temp("series-retry-budget-");
    let t1 = 0;
    const claude = fakeArm("claude-code", (call) =>
      call.task === "t1" && t1++ === 0 ? refused : solve(call),
    );
    const options = series(
      dir,
      { rune: fakeArm("rune", solve).arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2", "t3", "t4", "t5"].map((id) => syntheticTask(id)),
        // Exactly the planned runs: five pairs, ten arm runs, and none for a retry.
        limits: { maxPairs: 5, maxAttempts: 10, wallAllowanceMs: 24 * 60 * 60_000 },
      },
    );
    const report = await runPairs(options);
    expect(report).toMatchObject({ pairsRun: 5, attempts: 10, requeued: 1, retried: [] });
    expect(report.stoppedEarly).toBe("Series stopped: 10 of 10 allowed arm run(s) used.");
    expect(claude.calls.filter((call) => call.task === "t1")).toHaveLength(1);
    // The pair stands as it was first written: out of the index, and counted.
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs.filter((pair) => !pair.comparator.scored)).toHaveLength(1);
  }, 60_000);

  test("both rows unscored: both are retried, the other arm first", async () => {
    const dir = temp("series-retry-both-");
    let runeCalls = 0;
    let claudeCalls = 0;
    const rune = fakeArm("rune", (call) => (runeCalls++ === 0 ? refused : solve(call)));
    const claude = fakeArm("claude-code", (call) => (claudeCalls++ === 0 ? refused : solve(call)));
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: ["t1", "t2", "t3", "t4", "t5"].map((id) => syntheticTask(id)) },
    );
    const report = await runPairs(options);
    // t1 ran Rune first; its retry runs the comparator first.
    expect(report.retried).toEqual(["t1#1:claude-code", "t1#1:rune"]);
    expect(report).toMatchObject({ pairsRun: 5, unscoredPairs: 1, requeued: 1, attempts: 12 });
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(5);
    expect(pairing.pairs.every((pair) => pair.rune.scored && pair.comparator.scored)).toBe(true);
  }, 60_000);

  test("a retry graded by other checks than its partner was is not a pair with it", async () => {
    const dir = temp("series-retry-checks-");
    // The first two grades could not run check c2 (no browser); the retry's could.
    let graded = 0;
    const flaky = syntheticTask("t1", {
      async grade(workspace) {
        const done = existsSync(join(workspace, "done.txt"));
        return {
          hiddenPassed: done ? 1 : 0,
          hiddenTotal: 1,
          regressionsIntroduced: 0,
          buildBroken: false,
          impossible: ++graded <= 2 ? ["c2"] : [],
        };
      },
    });
    let calls = 0;
    const claude = fakeArm("claude-code", (call) => (calls++ === 0 ? refused : solve(call)));
    const options = series(
      dir,
      { rune: fakeArm("rune", solve).arm, comparator: claude.arm },
      { tasks: [flaky, ...["t2", "t3", "t4", "t5"].map((id) => syntheticTask(id))] },
    );
    const report = await runPairs(options);
    expect(report.retried).toEqual(["t1#1:claude-code"]);
    const t1 = readRows(options.out).filter((row) => row.task === "t1");
    expect(t1.map((row) => `${row.arm}:${row.scored}:${row.outcome.impossible.join(",")}`)).toEqual(
      ["rune:true:c2", "claude-code:false:c2", "claude-code:false:"],
    );
    // Rune's row was graded without c2 and the retry with it: two different exams.
    expect(t1[2]).toMatchObject({ attempt: 2, unscoredReason: "grader_infrastructure" });
    // The same retry, graded as its partner was, is scored.
    graded = -10;
    calls = 0;
    const same = series(
      temp("series-retry-same-"),
      { rune: fakeArm("rune", solve).arm, comparator: claude.arm },
      { tasks: [flaky, ...["t2", "t3", "t4", "t5"].map((id) => syntheticTask(id))] },
    );
    await runPairs(same);
    expect(
      readRows(same.out)
        .filter((row) => row.task === "t1")
        .map((row) => row.scored),
    ).toEqual([true, false, true]);
  }, 120_000);

  test("a fixture that moved under the series stops it before the tool is spawned again", async () => {
    const dir = temp("series-drift-");
    let prepared = 0;
    const drifting = syntheticTask("t1", {
      async prepare(workspace) {
        mkdirSync(workspace, { recursive: true });
        // The fourth preparation — Rune's, second in run 2 — seeds another file.
        writeFileSync(
          join(workspace, "main.ts"),
          `export const x = ${++prepared === 4 ? 2 : 1};\n`,
        );
        writeFileSync(join(workspace, ".gitignore"), ".rune/\nnode_modules/\n");
        git(workspace, "init", "-q");
        git(workspace, "add", ".");
        commit(workspace, "fixture");
      },
    });
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: [drifting], runs: 2 },
    );
    const report = await runPairs(options);
    expect(prepared).toBe(4);
    // Run 2 ran the comparator; Rune's tree was not the task's, and Rune was not run on it.
    expect(rune.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(2);
    expect(report).toMatchObject({ pairsRun: 1, attempts: 3, halfPairs: ["t1#2:claude-code"] });
    expect(report.stoppedEarly).toMatch(
      /^Series stopped: source drift — t1: the tree prepared for run 2 \(rune\) is not the one this task was first run from \([0-9a-f]{12} against [0-9a-f]{12}\) — its fixture changed under the series\. claude-code's row for t1 run 2 is kept without its partner\.$/,
    );
    const rows = readRows(options.out);
    // What was written is one task, from one starting point: nothing to refuse later.
    expect(new Set(rows.map((r) => r.fingerprints!.task)).size).toBe(1);
    expect(rows.map((r) => `${r.run}:${r.arm}`)).toEqual([
      "1:rune",
      "1:claude-code",
      "2:claude-code",
    ]);
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(1);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: ["t1#2"] });
    expect(readFileSync(join(options.out, "t1", "run-2", "rune", "drift.txt"), "utf8")).toContain(
      "its fixture changed under the series",
    );
  }, 120_000);

  test("…at a pair's first arm: nothing of that pair is run, and nothing is left half", async () => {
    const dir = temp("series-drift-first-");
    let prepared = 0;
    const drifting = syntheticTask("t1", {
      async prepare(workspace) {
        mkdirSync(workspace, { recursive: true });
        // The third preparation is run 2's first arm.
        writeFileSync(
          join(workspace, "main.ts"),
          `export const x = ${++prepared === 3 ? 2 : 1};\n`,
        );
        writeFileSync(join(workspace, ".gitignore"), ".rune/\nnode_modules/\n");
        git(workspace, "init", "-q");
        git(workspace, "add", ".");
        commit(workspace, "fixture");
      },
    });
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: [drifting], runs: 3 },
    );
    const report = await runPairs(options);
    // Run 1 ran whole; run 2 stopped before either arm; run 3 was never reached.
    expect(prepared).toBe(3);
    expect(rune.calls.length + claude.calls.length).toBe(2);
    expect(report).toMatchObject({ pairsRun: 1, attempts: 2, halfPairs: [] });
    expect(report.stoppedEarly).toMatch(
      /^Series stopped: source drift — t1: the tree prepared for run 2 \(claude-code\) is not the one this task was first run from \([0-9a-f]{12} against [0-9a-f]{12}\) — its fixture changed under the series\.$/,
    );
    expect(readRows(options.out).map((row) => row.run)).toEqual([1, 1]);
  }, 120_000);

  test("…and before a retry: the row that waited is not paired with another task's", async () => {
    const dir = temp("series-drift-retry-");
    let prepared = 0;
    const drifting = syntheticTask("t1", {
      async prepare(workspace) {
        mkdirSync(workspace, { recursive: true });
        // Two preparations for the pair, then the retry's: by then the fixture moved.
        writeFileSync(
          join(workspace, "main.ts"),
          `export const x = ${++prepared === 3 ? 2 : 1};\n`,
        );
        writeFileSync(join(workspace, ".gitignore"), ".rune/\nnode_modules/\n");
        git(workspace, "init", "-q");
        git(workspace, "add", ".");
        commit(workspace, "fixture");
      },
    });
    let calls = 0;
    const claude = fakeArm("claude-code", (call) => (calls++ === 0 ? refused : solve(call)));
    const options = series(
      dir,
      { rune: fakeArm("rune", solve).arm, comparator: claude.arm },
      {
        tasks: [
          drifting,
          syntheticTask("t2"),
          syntheticTask("t3"),
          syntheticTask("t4"),
          syntheticTask("t5"),
        ],
      },
    );
    const report = await runPairs(options);
    // The comparator was never spawned on the moved fixture.
    expect(claude.calls.filter((call) => call.task === "t1")).toHaveLength(1);
    expect(report.retried).toEqual([]);
    expect(report.stoppedEarly).toMatch(
      /^Series stopped: source drift — t1: the tree prepared for run 1 \(claude-code\)/,
    );
    expect(report.halfPairs).toEqual([]);
    // The pair as it was first written still stands: one scored row, one unscored.
    const t1 = readRows(options.out).filter((r) => r.task === "t1");
    expect(t1.map((r) => `${r.arm}:${r.scored}`)).toEqual(["rune:true", "claude-code:false"]);
  }, 120_000);

  test("the series stops only when MORE than a quarter of the planned pairs are unscored", async () => {
    const dir = temp("series-quarter-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", () => refused);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
      },
    );
    const report = await runPairs(options);
    // Pair one unscored: 1 of 4, not more than a quarter — go on. Pair two: 2 of 4.
    expect(report.pairsRun).toBe(2);
    expect(report.stoppedEarly).toMatch(/2 of 4 planned pair/);
    expect(JSON.parse(readFileSync(join(options.out, SERIES), "utf8")).stoppedEarly).toBe(
      report.stoppedEarly,
    );
    const { pairing } = scorerReads(options.out);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
  }, 60_000);

  test("an arm whose run produced no row is re-run, and the pair stays whole", async () => {
    const dir = temp("series-missing-");
    const rune = fakeArm("rune", solve);
    let thrown = 0;
    const claude = fakeArm("claude-code", solve);
    const flaky: ComparatorArm = {
      ...claude.arm,
      async runArm(task, runDir, limits) {
        if (thrown++ === 0) throw new Error("spawn ENOENT: the binary moved");
        return claude.arm.runArm(task, runDir, limits);
      },
    };
    const options = series(
      dir,
      { rune: rune.arm, comparator: flaky },
      { tasks: [syntheticTask("t1")] },
    );
    const report = await runPairs(options);
    expect(report.rerunArms).toEqual(["t1#1:claude-code"]);
    expect(report).toMatchObject({ pairsRun: 1, unscoredPairs: 0, requeued: 0 });
    const rows = readRows(options.out);
    expect(rows.map((row) => `${row.arm}:${row.run}:${row.scored}`)).toEqual([
      "rune:1:true",
      "claude-code:1:true",
    ]);
    expect(rows[1]!.evidence).toEndWith(join("run-1", "claude-code-attempt-2"));
    expect(
      readFileSync(join(options.out, "t1", "run-1", "claude-code", "no-row.txt"), "utf8"),
    ).toContain("the binary moved");
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(1);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
  }, 60_000);

  test("…and if the re-run produces none either, an unscored row keeps it whole", async () => {
    const dir = temp("series-missing-twice-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    let broken = 0;
    const dead: ComparatorArm = {
      ...claude.arm,
      async runArm(task, runDir, limits) {
        if (task.id === "t1" && broken++ < 2) throw new Error("spawn ENOENT");
        return claude.arm.runArm(task, runDir, limits);
      },
    };
    const options = series(
      dir,
      { rune: rune.arm, comparator: dead },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
      },
    );
    const report = await runPairs(options);
    // Unscored like any other, so retried like any other: alone, at the end.
    expect(report).toMatchObject({
      unscoredPairs: 1,
      requeued: 1,
      pairsRun: 4,
      retried: ["t1#1:claude-code"],
    });
    const rows = readRows(options.out);
    const missing = rows.find(
      (row) => row.task === "t1" && row.arm === "claude-code" && row.run === 1,
    )!;
    expect(missing).toMatchObject({
      scored: false,
      unscoredReason: "crash_before_first_call",
      calls: null,
      exitCode: null,
      clean: false,
    });
    expect(validateRow(missing)).toEqual([]);
    const { pairing } = scorerReads(options.out);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
    expect(pairing.pairs).toHaveLength(4);
    expect(pairing.pairs.every((pair) => pair.comparator.scored)).toBe(true);
  }, 60_000);

  test("a task that could not be prepared is re-run too, and is never the arm's failure", async () => {
    const dir = temp("series-prepare-");
    let prepares = 0;
    const base = syntheticTask("t1");
    const task: ParityTask = {
      ...base,
      async prepare(workspace) {
        if (prepares++ === 0) throw new Error("git: index.lock exists");
        return base.prepare(workspace);
      },
    };
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    const options = series(dir, { rune: rune.arm, comparator: claude.arm }, { tasks: [task] });
    const report = await runPairs(options);
    expect(report.rerunArms).toEqual(["t1#1:rune"]);
    expect(readRows(options.out).map((row) => row.scored)).toEqual([true, true]);
    expect(rune.calls).toHaveLength(1);
  }, 60_000);

  test("an arm that destroys the repository is out of scope, and the pair is still written", async () => {
    const dir = temp("series-git-gone-");
    // The evidence sits inside ANOTHER repository, as it would under the Rune
    // checkout: git must not climb into it once the workspace's .git is gone.
    git(dir, "init", "-q");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", (call) => {
      solve(call);
      rmSync(join(call.workspace, ".git"), { recursive: true, force: true });
    });
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      { tasks: [syntheticTask("t1")] },
    );
    await runPairs(options);
    const rows = readRows(options.out);
    const broken = rows.find((row) => row.arm === "claude-code")!;
    expect(broken).toMatchObject({ scored: true, scope: 0 });
    expect(broken.scopeNotes![0]).toMatch(/git cannot read/);
    // parity-run/1 called this out of scope too: the two rules agree here.
    expect(broken.legacy).toEqual({ clean: true, scope: 0 });
    expect(rows.find((row) => row.arm === "rune")!.legacy).toEqual({ clean: true, scope: 1 });
  }, 60_000);

  test("a grader that cannot run is grader_infrastructure, and the pair is re-queued", async () => {
    const dir = temp("series-grader-");
    let grades = 0;
    const base = syntheticTask("t1");
    const task: ParityTask = {
      ...base,
      async grade(workspace, evidence) {
        if (grades++ === 1) throw new Error("the checks directory is gone");
        return base.grade(workspace, evidence);
      },
    };
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: [task, ...["t2", "t3", "t4"].map((id) => syntheticTask(id))],
      },
    );
    const report = await runPairs(options);
    const rows = readRows(options.out);
    expect(rows[1]).toMatchObject({
      task: "t1",
      scored: false,
      unscoredReason: "grader_infrastructure",
    });
    expect(report.requeued).toBe(1);
  }, 60_000);

  test("one build per series: a Rune rebuilt between two runs is source_changed", async () => {
    const dir = temp("series-rebuilt-");
    const rune = fakeArm("rune", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: fakeArm("claude-code", solve).arm },
      {
        tasks: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => syntheticTask(id)),
      },
    );
    const build = options.specs.rune!.command![0]!;
    // Another session rebuilds the binary while the comparator's first run is
    // going — between Rune's runs, where the arm's own before/after check
    // cannot see it.
    const claude = fakeArm("claude-code", (call) => {
      solve(call);
      if (call.task === "t1") writeFileSync(build, "build 2\n");
    });
    options.implementations!["claude-code"] = claude.arm;
    await runPairs(options);
    const runeRows = readRows(options.out).filter((row) => row.arm === "rune");
    expect(runeRows[0]).toMatchObject({ task: "t1", scored: true });
    expect(runeRows[1]).toMatchObject({
      task: "t2",
      scored: false,
      unscoredReason: "source_changed",
    });
    const record = JSON.parse(readFileSync(join(options.out, SERIES), "utf8"));
    expect(record.build.rune).toBe(createHash("sha256").update("build 1\n").digest("hex"));
  }, 60_000);

  test("each row records the version its tool gave just before that run", async () => {
    const dir = temp("series-versions-");
    const rune = fakeArm("rune", solve);
    // Probe 1 is the series start; probes 2 and 3 are the first two runs.
    const claude = fakeArm("claude-code", solve, {
      version: (n) => (n <= 2 ? "2.1.284 (Claude Code)" : "2.1.285 (Claude Code)"),
    });
    const options = series(dir, { rune: rune.arm, comparator: claude.arm });
    await runPairs(options);
    const versions = readRows(options.out)
      .filter((row) => row.arm === "claude-code")
      .map((row) => row.version);
    expect(versions).toEqual(["2.1.284 (Claude Code)", "2.1.285 (Claude Code)"]);
    const seen = versionsSeen(scorerReads(options.out).rows);
    expect(seen.product["claude-code"]!.map((v) => v.version)).toEqual([
      "2.1.284 (Claude Code)",
      "2.1.285 (Claude Code)",
    ]);
  }, 60_000);

  test("Rune's own meter stops the series at the share it was given", async () => {
    const dir = temp("series-quota-");
    let pct = 0;
    const rune = fakeArm("rune", (call) => {
      solve(call);
      pct += 30;
      return { result: { quotaPct: pct } };
    });
    const options = series(
      dir,
      { rune: rune.arm, comparator: fakeArm("claude-code", solve).arm },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
        env: { RUNE_EVAL_QUOTA_PCT: "50" },
        accounts: { rune: { usedPct: 5, stopAtPct: null } },
      },
    );
    const report = await runPairs(options);
    // 30% after the first pair, 60% after the second: no third pair.
    expect(report.pairsRun).toBe(2);
    expect(report.stoppedEarly).toBe(
      "Series stopped: Rune's window is 60% used (its last row's meter), at or past its stop at 50%.",
    );
    expect(
      readRows(options.out)
        .filter((r) => r.arm === "rune")
        .map((r) => r.quotaPct),
    ).toEqual([30, 60]);
    // RUNE_EVAL_QUOTA_PCT is Rune's stop, as it always was.
    expect(report.manifest.accounts.rune).toEqual({ usedPct: 5, stopAtPct: 50 });
  }, 60_000);

  test("the first pair is refused when a window is already past its stop, either account's", async () => {
    for (const [name, accounts, said] of [
      [
        "rune",
        { rune: { usedPct: 99, stopAtPct: 90 } },
        /^Refused before anything ran: Rune's window is 99% used \(the operator's reading before the series\), at or past its stop at 90%\.$/,
      ],
      [
        "claude",
        { rune: { usedPct: 10, stopAtPct: 90 }, "claude-code": { usedPct: 75, stopAtPct: 70 } },
        /^Refused before anything ran: claude-code's window is 75% used/,
      ],
    ] as const) {
      const dir = temp(`series-preflight-${name}-`);
      const rune = fakeArm("rune", solve);
      const claude = fakeArm("claude-code", solve);
      const options = series(dir, { rune: rune.arm, comparator: claude.arm }, { accounts });
      await expect(runPairs(options)).rejects.toThrow(said);
      // Nothing was probed, prepared, spawned or written.
      expect(rune.versionCalls() + claude.versionCalls()).toBe(0);
      expect(rune.calls.length + claude.calls.length).toBe(0);
      expect(existsSync(options.out)).toBe(false);
    }
  }, 60_000);

  test("the comparator's reserve is checked once, against the reading; Rune's before each of its runs", async () => {
    const dir = temp("series-reserves-");
    let pct = 20;
    const rune = fakeArm("rune", (call) => {
      solve(call);
      pct += 25;
      return { result: { quotaPct: pct } };
    });
    const options = series(
      dir,
      { rune: rune.arm, comparator: fakeArm("claude-code", solve).arm },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
        accounts: {
          rune: { usedPct: 20, stopAtPct: 60 },
          "claude-code": { usedPct: 30, stopAtPct: 70 },
        },
      },
    );
    const report = await runPairs(options);
    // Rune: 45% after pair one, 70% after pair two — past its 60%.
    expect(report.pairsRun).toBe(2);
    expect(report.stoppedEarly).toMatch(/Rune's window is 70% used \(its last row's meter\)/);
    // The record says which account is watched and which is not.
    const record = JSON.parse(readFileSync(join(options.out, SERIES), "utf8"));
    expect(record.budget).toMatchObject({ bounded: true, accounts: options.accounts });
    const bounds = (record.bounds as string[]).join("\n");
    expect(bounds).toContain("Rune: 20% of its window used (the operator's reading) · stop at 60%");
    expect(bounds).toContain(
      "claude-code: 30% of its window used (the operator's reading) · stop at 70% · NO METER",
    );
    expect(bounds).toContain("bounded mode, accepted by the operator: for claude-code");
    expect(bounds).toContain("$5 is an estimate-gated stop, NOT a spend cap");
    expect(report.lines.join("\n")).toContain(bounds);
  }, 60_000);

  test("the dollar stop: before a pair that the estimate says would cross the figure", async () => {
    const dir = temp("series-budget-");
    const options = series(
      dir,
      {
        rune: fakeArm("rune", solve).arm,
        comparator: fakeArm("claude-code", solve).arm,
      },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
        env: { RUNE_EVAL_BUDGET_USD: "0.05" },
      },
    );
    const report = await runPairs(options);
    // $0.02 a pair: after two, $0.04 + up to $0.02 more would pass $0.05.
    expect(report.pairsRun).toBe(2);
    expect(report.stoppedEarly).toMatch(/past the authorised \$0.05/);
  }, 60_000);

  test("the run count stops the series, and says how many pairs it did not run", async () => {
    const dir = temp("series-max-attempts-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2", "t3"].map((id) => syntheticTask(id)),
        limits: { maxPairs: 3, maxAttempts: 5, wallAllowanceMs: 24 * 60 * 60_000 },
      },
    );
    const report = await runPairs(options);
    // Two pairs are four runs; the fifth is not enough for a third pair.
    expect(report).toMatchObject({ planned: 3, pairsRun: 2, attempts: 4, halfPairs: [] });
    expect(report.stoppedEarly).toBe(
      "Series stopped: 1 of 5 allowed arm run(s) left, and a pair needs two.",
    );
    expect(rune.calls.length + claude.calls.length).toBe(4);
    expect(report.lines.join("\n")).toContain("these limits are smaller than the plan");
  }, 60_000);

  test("stopped between two arms: the row that exists is kept, and reported partnerless", async () => {
    const dir = temp("series-between-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    // The first arm's tool cannot be started once, and is re-run: two of the
    // two allowed runs are used before the second arm's turn comes.
    let thrown = 0;
    const flaky: ComparatorArm = {
      ...rune.arm,
      async runArm(task, runDirectory, limits) {
        if (thrown++ === 0) throw new Error("spawn ENOENT");
        return rune.arm.runArm(task, runDirectory, limits);
      },
    };
    const options = series(
      dir,
      { rune: flaky, comparator: claude.arm },
      {
        tasks: [syntheticTask("t1")],
        limits: { maxPairs: 1, maxAttempts: 2, wallAllowanceMs: 24 * 60 * 60_000 },
      },
    );
    const report = await runPairs(options);
    expect(claude.calls).toHaveLength(0);
    expect(report).toMatchObject({
      pairsRun: 0,
      attempts: 2,
      halfPairs: ["t1#1:rune"],
      rerunArms: ["t1#1:rune"],
    });
    expect(report.stoppedEarly).toBe(
      "Series stopped: 2 of 2 allowed arm run(s) used. rune's row for t1 run 1 is kept without its partner.",
    );
    const rows = readRows(options.out);
    expect(rows.map((row) => `${row.arm}:${row.scored}`)).toEqual(["rune:true"]);
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(0);
    expect(pairing.unpaired).toEqual({ rune: ["t1#1"], comparator: [] });
    // A partnerless row keeps its family from passing, and is still an attempt.
    const built = buildReport({ rows, inputs: [], b: 50 });
    expect(built.status).toBe("PROVISIONAL");
    expect(built.modes.product.families[0]!.absolute.rune.attempts).toBe(1);
    expect(JSON.parse(readFileSync(join(options.out, SERIES), "utf8")).halfPairs).toEqual([
      "t1#1:rune",
    ]);
  }, 60_000);

  test("the clock: the second arm is not started when it could not finish inside the allowance", async () => {
    const dir = temp("series-clock-");
    // A clock the test turns: every arm run takes thirty minutes of it.
    let now = 1_000_000;
    const slow = (name: ArmName) =>
      fakeArm(name, (call) => {
        solve(call);
        now += 30 * 60_000;
      });
    const rune = slow("rune");
    const claude = slow("claude-code");
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2"].map((id) => syntheticTask(id)),
        // Forty-five minutes: a pair of twenty-minute runs may start; after one
        // thirty-minute run, a second twenty-minute run may not.
        limits: { maxPairs: 2, maxAttempts: 4, wallAllowanceMs: 45 * 60_000 },
        now: () => now,
      },
    );
    const report = await runPairs(options);
    expect(rune.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
    expect(report).toMatchObject({ pairsRun: 0, attempts: 1, halfPairs: ["t1#1:rune"] });
    expect(report.stoppedEarly).toBe(
      "Series stopped: the next run may take up to 20.0 min and 15.0 min of the 45.0 min allowance are left. rune's row for t1 run 1 is kept without its partner.",
    );
  }, 60_000);

  test("a re-run after a missing row is not made when the budget has no run left for it", async () => {
    const dir = temp("series-no-rerun-");
    const claude = fakeArm("claude-code", solve);
    const dead: ComparatorArm = {
      ...claude.arm,
      async runArm() {
        throw new Error("spawn ENOENT");
      },
    };
    const options = series(
      dir,
      { rune: fakeArm("rune", solve).arm, comparator: dead },
      {
        // Five planned, so one unscored pair is not yet a quarter of them.
        tasks: ["t1", "t2", "t3", "t4", "t5"].map((id) => syntheticTask(id)),
        limits: { maxPairs: 5, maxAttempts: 2, wallAllowanceMs: 24 * 60 * 60_000 },
      },
    );
    const report = await runPairs(options);
    // One run for each arm. The comparator's produced no row, and the second
    // of the two allowed runs was the one it had just used: no re-run.
    expect(report).toMatchObject({ attempts: 2, pairsRun: 1, rerunArms: [], halfPairs: [] });
    expect(options.logged.join("\n")).toContain(
      "not re-run — Series stopped: 2 of 2 allowed arm run(s) used.",
    );
    const rows = readRows(options.out);
    expect(rows.map((row) => `${row.arm}:${row.scored}:${row.terminal}`)).toEqual([
      "rune:true:completed",
      "claude-code:false:not_started",
    ]);
    for (const row of rows) expect(validateRow(row)).toEqual([]);
    // Nothing after it runs either: not the next pair, not the retry.
    expect(report.retried).toEqual([]);
    expect(report.stoppedEarly).toBe(
      "Series stopped: 0 of 2 allowed arm run(s) left, and a pair needs two.",
    );
  }, 60_000);

  test("the manifest is on disk before the first pair, and says what was approved", async () => {
    const dir = temp("series-manifest-");
    let seen: ParityManifest | undefined;
    const rune = fakeArm("rune", (call) => {
      solve(call);
      // The first thing the first arm can see is the manifest, already written.
      seen ??= JSON.parse(readFileSync(join(dir, "out", MANIFEST), "utf8")) as ParityManifest;
    });
    const tasks = ["t1", "t2", "t3"].map((id) => syntheticTask(id));
    const options = series(
      dir,
      { rune: rune.arm, comparator: fakeArm("claude-code", solve).arm },
      {
        tasks,
        runs: 2,
        seed: 11,
        limits: { maxPairs: 6, maxAttempts: 14, wallAllowanceMs: 300 * 60_000 },
        accounts: { rune: { usedPct: 12, stopAtPct: 80 } },
      },
    );
    const report = await runPairs(options);
    expect(seen).toEqual(report.manifest);
    expect(manifestProblems(seen)).toEqual([]);
    expect(report.manifest).toMatchObject({
      kind: "parity-manifest",
      schema: "parity-manifest/1",
      arms: ["rune", "claude-code"],
      mode: "product",
      runs: 2,
      seed: 11,
      families: { F1: 3 },
      limits: { maxPairs: 6, maxAttempts: 14, wallAllowanceMs: 300 * 60_000 },
      accounts: {
        rune: { usedPct: 12, stopAtPct: 80 },
        "claude-code": { usedPct: null, stopAtPct: null },
      },
      bounded: true,
      needs: { pairs: 6, armRuns: 12, worstCaseWallMs: 12 * WALL_LIMIT_MS.small },
    });
    expect(report.manifest.tasks).toEqual(
      tasks.map((task) => ({
        id: task.id,
        family: "F1",
        size: "small",
        source: "given",
        grader: task.grader,
        prompt: promptDigest(task.prompt),
      })),
    );
    // The order it names is the order that ran, arm by arm.
    expect(report.manifest.order).toHaveLength(6);
    const ran = readRows(options.out)
      .filter((_, index) => index % 2 === 0)
      .map((row) => `${row.task}#${row.run}:${row.arm}`);
    expect(ran).toEqual(report.manifest.order.map((p) => `${p.task}#${p.run}:${p.first}`));
    expect(report).toMatchObject({ pairsRun: 6, attempts: 12 });
    // A second series in the same directory is refused for the manifest alone.
    rmSync(join(options.out, RESULTS));
    rmSync(join(options.out, SERIES));
    for (const task of tasks) rmSync(join(options.out, task.id), { recursive: true });
    await expect(runPairs(options)).rejects.toThrow(/manifest\.json already exists/);
  }, 60_000);
});

describe("refusals come before anything runs", () => {
  const fresh = () => {
    const dir = temp("series-refused-");
    const rune = fakeArm("rune", solve);
    const claude = fakeArm("claude-code", solve);
    return { dir, rune, claude, options: series(dir, { rune: rune.arm, comparator: claude.arm }) };
  };
  const failure = (options: PairSeriesOptions) =>
    runPairs(options).then(
      () => null,
      (error: Error) => error.message,
    );

  test("no authorisation: refused, nothing probed, nothing written", async () => {
    const { rune, claude, options } = fresh();
    expect(await failure({ ...options, env: {} })).toMatch(/not authorised/);
    expect(existsSync(options.out)).toBe(false);
    expect(rune.versionCalls() + claude.versionCalls()).toBe(0);
    expect(rune.calls.length + claude.calls.length).toBe(0);
  });

  test("no limits: refused, with what the plan would need, before anything is probed", async () => {
    const { rune, claude, options } = fresh();
    const { limits: _limits, ...unlimited } = options;
    expect(await failure(unlimited)).toBe(
      "A live series needs its limits before the first pair: --max-pairs, --max-attempts and --wall-allowance-min. This plan is 2 pair(s), 4 arm run(s) before any retry, and up to 80.0 min if every run uses its whole wall limit.",
    );
    expect(existsSync(options.out)).toBe(false);
    expect(rune.versionCalls() + claude.versionCalls()).toBe(0);
  });

  test("an account nobody can watch is refused by name, unless the operator said bounded", async () => {
    const { rune, claude, options } = fresh();
    // Rune read and reserved; the comparator read and reserved too — and unmetered.
    const accounts = {
      rune: { usedPct: 10, stopAtPct: 80 },
      "claude-code": { usedPct: 10, stopAtPct: 80 },
    };
    expect(await failure({ ...options, accounts, bounded: false })).toBe(
      "Refused before anything ran:\n  claude-code: its window cannot be read while the series runs\n  an account that cannot be watched needs --bounded: the run count and the wall allowance are then the only bound, and the record says so",
    );
    // With nothing read at all, each arm is named with every reason.
    expect(await failure({ ...options, bounded: false })).toMatch(
      /Rune: no reserve was set for its account; its window was not read before the series\n {2}claude-code: no reserve was set for its account; its window was not read before the series; its window cannot be read while the series runs/,
    );
    expect(existsSync(options.out)).toBe(false);
    expect(rune.versionCalls() + claude.versionCalls()).toBe(0);
    // Said out loud, the same series runs.
    expect(await failure({ ...options, accounts, bounded: true })).toBeNull();
  });

  test("a plan larger than its own pair limit is refused, never cut short", async () => {
    const { options } = fresh();
    expect(
      await failure({
        ...options,
        limits: { maxPairs: 1, maxAttempts: 10, wallAllowanceMs: 60 * 60_000 },
      }),
    ).toMatch(/the plan is 2 pair\(s\) and --max-pairs allows 1/);
    expect(existsSync(options.out)).toBe(false);
  });

  test("a quota share alone needs a Rune arm to read it from", async () => {
    const { options } = fresh();
    const codexOnly = {
      ...options,
      arms: ["codex", "claude-code"] as [ParityArm, ParityArm],
      specs: { codex: { model: "m" }, "claude-code": { model: "c" } },
      implementations: {
        codex: fakeArm("codex", solve).arm,
        "claude-code": fakeArm("claude-code", solve).arm,
      },
      env: { RUNE_EVAL_QUOTA_PCT: "50" },
    };
    expect(await failure(codexOnly)).toMatch(/no Rune arm/);
  });

  test("an existing results.jsonl is never overwritten, and nothing runs", async () => {
    const { rune, options } = fresh();
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, RESULTS), "earlier evidence\n");
    expect(await failure(options)).toMatch(/already exists/);
    expect(readFileSync(join(options.out, RESULTS), "utf8")).toBe("earlier evidence\n");
    expect(rune.versionCalls()).toBe(0);
  });

  test("…nor a run's evidence directory", async () => {
    const { options } = fresh();
    mkdirSync(join(options.out, "t1", "run-1", "rune"), { recursive: true });
    expect(await failure(options)).toMatch(/already exists/);
    expect(existsSync(join(options.out, RESULTS))).toBe(false);
  });

  test("an arm that would refuse refuses the series before the other arm spends", async () => {
    const { dir, rune, options } = fresh();
    const unready = fakeArm("claude-code", solve, { refusal: "no evaluation profile" });
    const refusedOptions = series(dir, { rune: rune.arm, comparator: unready.arm });
    expect(await failure(refusedOptions)).toMatch(/no evaluation profile/);
    expect(rune.calls).toHaveLength(0);
    expect(existsSync(options.out)).toBe(false);
  });

  test("a tool that will not say its version gets no row", async () => {
    const { dir, rune } = fresh();
    const mute = fakeArm("claude-code", solve, { version: () => null });
    const options = series(dir, { rune: rune.arm, comparator: mute.arm });
    expect(await failure(options)).toMatch(/--version said nothing/);
    expect(existsSync(options.out)).toBe(false);
  });
});

// ─── The dry run ───

/** An executable that leaves a mark if anything ever runs it. */
function tripwire(dir: string): { bin: string; mark: string } {
  const mark = join(dir, "RAN");
  const bin = join(dir, "tripwire");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(mark)}\necho "tripwire 0"\n`);
  chmodSync(bin, 0o755);
  return { bin, mark };
}

describe.skipIf(process.platform === "win32")(
  "--dry-run plans everything and spawns nothing",
  () => {
    test("injected arms: no version probe, no run, no directory", async () => {
      const dir = temp("dry-injected-");
      const rune = fakeArm("rune", () => {
        throw new Error("a dry run ran the arm");
      });
      const claude = fakeArm("claude-code", () => {
        throw new Error("a dry run ran the arm");
      });
      const options = series(
        dir,
        { rune: rune.arm, comparator: claude.arm },
        {
          dryRun: true,
          env: {},
          runs: 2,
        },
      );
      const report = await runPairs(options);
      expect(report).toMatchObject({ kind: "parity-pairs-dry-run", planned: 4, pairsRun: 0 });
      expect(rune.versionCalls() + claude.versionCalls()).toBe(0);
      expect(rune.calls.length + claude.calls.length).toBe(0);
      expect(existsSync(options.out)).toBe(false);
      expect(report.lines.join("\n")).toContain("4 pair(s) planned");
    });

    test("no workspace is prepared, no task is graded, and the budget is shown as it would bind", async () => {
      const dir = temp("dry-prepare-");
      const never = (what: string) => async (): Promise<never> => {
        throw new Error(`a dry run ${what}`);
      };
      const tasks = ["t1", "t2", "t3"].map((id) =>
        syntheticTask(id, {
          prepare: never("prepared a workspace"),
          grade: never("graded a tree"),
        }),
      );
      const options = series(
        dir,
        { rune: fakeArm("rune", solve).arm, comparator: fakeArm("claude-code", solve).arm },
        {
          dryRun: true,
          env: { RUNE_EVAL_BUDGET_USD: "2" },
          tasks,
          seed: 4,
          limits: { maxPairs: 3, maxAttempts: 8, wallAllowanceMs: 150 * 60_000 },
          accounts: { rune: { usedPct: 12, stopAtPct: 80 } },
          bounded: false,
        },
      );
      const report = await runPairs(options);
      expect(existsSync(options.out)).toBe(false);
      const text = report.lines.join("\n");
      expect(text).toContain("tasks by family: F1 × 3");
      expect(text).toContain("order: tasks shuffled within each repetition, seed 4");
      expect(text).toContain("at most 3 pair(s), 8 arm run(s), 150.0 min of wall time");
      expect(text).toContain("$2 is an estimate-gated stop, NOT a spend cap");
      // What a live run would refuse is said in the plan, and refuses nothing here.
      expect(text).toContain(
        "NOT RUNNABLE LIVE as configured: claude-code cannot be held to a percentage, and --bounded was not given",
      );
      expect(text).toContain("no workspace was prepared and nothing was written");
      expect(report.manifest).toMatchObject({
        seed: 4,
        bounded: false,
        needs: { pairs: 3, armRuns: 6, worstCaseWallMs: 6 * WALL_LIMIT_MS.small },
        limits: { maxPairs: 3, maxAttempts: 8, wallAllowanceMs: 150 * 60_000 },
      });
      expect(report.attempts).toBe(0);
      // A malformed authorisation is the live run's to refuse, not the plan's.
      const typo = await runPairs({ ...options, env: { RUNE_EVAL_QUOTA_PCT: "lots" } });
      expect(typo.manifest.accounts.rune).toEqual({ usedPct: 12, stopAtPct: 80 });
    });

    test("--write-manifest writes the manifest and nothing else; a live run reads it back", async () => {
      const dir = temp("dry-manifest-");
      const file = join(dir, "approved.json");
      const tasks = ["t1", "t2", "t3"].map((id) => syntheticTask(id));
      const options = series(
        dir,
        { rune: fakeArm("rune", solve).arm, comparator: fakeArm("claude-code", solve).arm },
        {
          dryRun: true,
          env: {},
          tasks,
          runs: 2,
          seed: 9,
          limits: { maxPairs: 6, maxAttempts: 14, wallAllowanceMs: 300 * 60_000 },
          writeManifest: file,
        },
      );
      const report = await runPairs(options);
      expect(existsSync(options.out)).toBe(false);
      expect(report.lines.join("\n")).toContain(`nothing was written but the manifest (${file})`);
      const manifest = readManifest(file);
      expect(manifest).toEqual(report.manifest);
      // It is never overwritten: an approved plan is not replaced under its reader.
      await expect(runPairs(options)).rejects.toThrow(/EEXIST/);
      // Read back, with the tasks loaded again from their source, it is the same plan.
      const available = tasks.map((task) => ({ source: "corpus" as const, task }));
      const again = optionsFromManifest(manifest, join(dir, "live"), true, available);
      expect(again).toMatchObject({
        arms: ["rune", "claude-code"],
        runs: 2,
        mode: "product",
        seed: 9,
        limits: manifest.limits!,
        bounded: true,
        dryRun: true,
      });
      expect(again.tasks.map((task) => task.id)).toEqual(["t1", "t2", "t3"]);
      const replanned = await runPairs({
        ...again,
        implementations: options.implementations!,
        log: () => {},
      });
      expect(replanned.manifest.order).toEqual(manifest.order);
      expect(replanned.manifest.tasks.map((task) => task.source)).toEqual(Array(3).fill("corpus"));
    });

    test("the real arms over the whole corpus: the tripwire is never touched", async () => {
      const dir = temp("dry-real-");
      const { bin, mark } = tripwire(dir);
      const out = join(dir, "out");
      const report = await runPairs({
        tasks: corpusParityTasks(),
        arms: ["rune", "claude-code"],
        runs: 1,
        mode: "product",
        out,
        specs: {
          rune: { model: "rune-model", command: [bin] },
          "claude-code": { model: "opus", reasoningEffort: "high", command: [bin] },
        },
        dryRun: true,
        env: { PATH: "/usr/bin:/bin", HOME: dir },
        log: () => {},
      });
      expect(report.planned).toBe(12);
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(out)).toBe(false);
      const text = report.lines.join("\n");
      // The plan a reviewer reads is the plan a live run would run: the argv of
      // both arms, and the refusal a live run would hit first.
      expect(text).toContain('"--pristine"');
      expect(text).toContain('"--setting-sources","project"');
      expect(text).toContain(
        `REFUSED live: Claude Code product mode needs its own evaluation profile`,
      );
      expect(text).not.toContain("--max-budget-usd");
    });

    test("the CLI: every available task planned, nothing executed, nothing written", () => {
      const dir = temp("dry-cli-");
      const { bin, mark } = tripwire(dir);
      const out = join(dir, "out");
      const cli = spawnSync(
        process.execPath,
        [
          join(import.meta.dir, "../../eval/parity/run-pairs.ts"),
          "--dry-run",
          "--arms",
          "rune,claude-code",
          "--rune-model",
          "rune-model",
          "--claude-code-model",
          "opus",
          "--rune-bin",
          bin,
          "--claude-code-bin",
          bin,
          "--out",
          out,
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir }, timeout: 120_000 },
      );
      expect(cli.status).toBe(0);
      // The corpus, its supplement and the mined tasks: 48, in their families.
      expect(cli.stdout).toContain("48 task(s) × 1 run(s) = 48 pair(s)");
      expect(cli.stdout).toContain(
        "tasks by family: F1 × 3, F2 × 3, F3 × 3, F4 × 3, F5 × 3, F6 × 3, F7 × 30",
      );
      expect(cli.stdout).toContain(
        "48 pair(s) planned. Nothing was executed, no workspace was prepared and nothing was written: a dry run spawns nothing, not even --version.",
      );
      // With no limits given, the plan says what a live run would need.
      expect(cli.stdout).toContain(
        "limits: none given. A live run needs --max-pairs, --max-attempts and --wall-allowance-min; this plan needs 48 pair(s), 96 arm run(s) before any retry, and up to 3420.0 min",
      );
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(out)).toBe(false);
    }, 120_000);

    test("the CLI flags: two arms, a known mode, and no effort for Rune", () => {
      const base = ["--dry-run", "--out", "/tmp/x", "--model", "m"];
      const options = parseCli([...base, "--effort", "high", "--tasks", "csv-state-machine"])!;
      expect(options.specs.rune).toEqual({ model: "m" });
      expect(options.specs["claude-code"]).toEqual({ model: "m", reasoningEffort: "high" });
      expect(options.tasks.map((task) => task.id)).toEqual(["csv-state-machine"]);
      expect(() => parseCli([...base, "--rune-effort", "high"])).toThrow(/shipped defaults/);
      expect(() => parseCli([...base, "--arms", "rune"])).toThrow(/exactly two/);
      expect(() => parseCli([...base, "--arms", "rune,cursor"])).toThrow(/Unknown arm/);
      expect(() => parseCli([...base, "--mode", "vibes"])).toThrow(/product or harness/);
      expect(parseCli(["--out", "/tmp/x"])).toBeUndefined();
    });
  },
);

// ─── End to end: the landed scorer reads what this writes ───

describe("end to end through the landed scorer", () => {
  test("the corpus, fake arms, three families: every row accepted and paired", async () => {
    const dir = temp("e2e-corpus-");
    const overlay = (tree: string) => (call: { task: string; workspace: string }) => {
      const source = join(CORPUS_DIR, call.task, tree);
      if (existsSync(source)) cpSync(source, call.workspace, { recursive: true });
    };
    // Rune writes the corpus's own solution; the comparator writes its `wrong`
    // variant and claims success anyway.
    const rune = fakeArm("rune", overlay("solution"));
    const claude = fakeArm("claude-code", overlay("variants/wrong"));
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: corpusParityTasks(CORPUS_DIR, [
          "csv-state-machine",
          "explain-quote-handling",
          "working-tree-integration",
        ]),
        runs: 2,
      },
    );
    const report = await runPairs(options);
    expect(report).toMatchObject({ planned: 6, pairsRun: 6, unscoredPairs: 0 });
    // The dirty-worktree fixture arrives with its untracked file in place.
    const wti = rune.calls.find((call) => call.task === "working-tree-integration")!;
    expect(wti.statusAtStart).toBe("?? money.ts");

    const { rows, pairing } = scorerReads(options.out);
    expect(rows).toHaveLength(12);
    expect(pairing.pairs).toHaveLength(6);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
    expect(pairing.unpairedByFamily).toEqual({});
    for (const row of rows.filter((r) => r.arm === "rune"))
      expect(row).toMatchObject({ scored: true, falseCompletion: false, scope: 1 });
    // The explain task forbade code; the wrong variant edits csv.ts.
    const explain = rows.find(
      (r) => r.arm === "claude-code" && r.task === "explain-quote-handling",
    )!;
    expect(explain).toMatchObject({ scope: 0, scopeNotes: ["csv.ts"], falseCompletion: true });

    const score = scoreMode("product", pairing.pairs, {
      seed: 1,
      b: 50,
      unpaired: pairing.unpairedByFamily,
    });
    const measured = score.families.filter((f) => f.status !== "UNMEASURED").map((f) => f.family);
    expect(measured).toEqual(["F1", "F5", "F6"]);
    for (const family of score.families.filter((f) => f.status !== "UNMEASURED"))
      expect(family.n).toBe(2);
  }, 120_000);

  test.skipIf(process.platform === "win32")(
    "the real Rune and Claude Code arms, on fake binaries, through run-pairs to the scorer",
    async () => {
      const dir = temp("e2e-real-arms-");
      const solution = join(CORPUS_DIR, "csv-state-machine", "solution", "csv.ts");
      const fakeRune = join(dir, "rune");
      writeFileSync(
        fakeRune,
        [
          `#!${process.execPath}`,
          `import { Database } from "bun:sqlite";`,
          `import { copyFileSync } from "node:fs";`,
          `if (process.argv.includes("--version")) { console.log("rune 9.9.9-fake"); process.exit(0); }`,
          `const db = new Database(process.env.RUNE_DB_PATH);`,
          `db.exec("CREATE TABLE events (payload_json TEXT)");`,
          `for (const listCostUsd of [0.01, 0.02]) db.prepare("INSERT INTO events VALUES (?)").run(JSON.stringify({ type: "cost", payload: { model: "m", provider: "openai", priced: true, listCostUsd } }));`,
          `db.close();`,
          `const workspace = process.argv[process.argv.indexOf("--workspace") + 1];`,
          `copyFileSync(${JSON.stringify(solution)}, workspace + "/csv.ts");`,
          `console.log(JSON.stringify({ type: "usage", inputTokens: 10, outputTokens: 2 }));`,
          `console.log(JSON.stringify({ type: "turn_complete", stopReason: "end_turn", totalTurns: 2 }));`,
          `console.log(JSON.stringify({ ok: true, text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } }));`,
          "",
        ].join("\n"),
      );
      chmodSync(fakeRune, 0o755);
      const fakeClaude = join(dir, "claude");
      writeFileSync(
        fakeClaude,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "2.1.284 (Claude Code)"; exit 0; fi',
          `cp ${JSON.stringify(solution)} ./csv.ts`,
          `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":2}}'`,
          "",
        ].join("\n"),
      );
      chmodSync(fakeClaude, 0o755);
      const profile = join(dir, "eval-profile");
      mkdirSync(profile);
      const out = join(dir, "out");
      const report = await runPairs({
        tasks: corpusParityTasks(CORPUS_DIR, ["csv-state-machine"]),
        arms: ["rune", "claude-code"],
        runs: 1,
        mode: "product",
        out,
        specs: {
          rune: { model: "m", provider: "openai", command: [fakeRune] },
          "claude-code": { model: "opus", command: [fakeClaude] },
        },
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dir,
          RUNE_HOME: join(dir, ".rune"),
          RUNE_EVAL_BUDGET_USD: "1",
          [CLAUDE_PARITY_CONFIG_ENV]: profile,
        },
        limits: { maxPairs: 1, maxAttempts: 2, wallAllowanceMs: 60 * 60_000 },
        bounded: true,
        log: () => {},
      });
      expect(report).toMatchObject({ pairsRun: 1, unscoredPairs: 0, attempts: 2 });
      const { rows, pairing } = scorerReads(out);
      expect(pairing.pairs).toHaveLength(1);
      expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
      const [runeRow, claudeRow] = [pairing.pairs[0]!.rune, pairing.pairs[0]!.comparator];
      expect(runeRow).toMatchObject({
        scored: true,
        clean: true,
        falseCompletion: false,
        scope: 1,
        calls: 2,
        version: "rune 9.9.9-fake",
        provider: "openai",
        binarySha256: createHash("sha256").update(readFileSync(fakeRune)).digest("hex"),
        outcome: { hiddenPassed: 3, hiddenTotal: 3 },
      });
      expect(runeRow.listUsd).toBeCloseTo(0.03);
      expect(claudeRow).toMatchObject({
        scored: true,
        clean: true,
        scope: 1,
        calls: 2,
        version: "2.1.284 (Claude Code)",
        outcome: { hiddenPassed: 3, hiddenTotal: 3 },
      });
      expect(rows.every((row) => validateRow(row).length === 0)).toBe(true);
    },
    60_000,
  );
});
