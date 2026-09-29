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
  workspaceOf,
} from "../../eval/comparison/arms/types";
import { loadResults, pairRows, validateRow, versionsSeen } from "../../eval/parity/aggregate";
import {
  CHECK_DIR,
  CORPUS_DIR,
  IMPOSSIBLE_MARKER,
  checkStatus,
  corpusParityTasks,
  expectedNewFilesOf,
  forbidsCode,
  outcomeFromChecks,
} from "../../eval/parity/corpus-source";
import {
  ARTIFACT,
  type Authorisation,
  type GateState,
  type PairSeriesOptions,
  RESULTS,
  SERIES,
  type WorkspaceSnapshot,
  chargeOf,
  changedPaths,
  gateBeforePair,
  isClean,
  isFalseCompletion,
  pairsAuthorisation,
  parseCli,
  parsePorcelainZ,
  planPairs,
  reconcileImpossible,
  requeued,
  runPairs,
  scoreScope,
  snapshotWorkspace,
  unreadableTreeScope,
  workspaceTouched,
} from "../../eval/parity/run-pairs";
import { scoreMode } from "../../eval/parity/score";
import {
  WALL_LIMIT_MS,
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

  test("a re-queued pair is a new run number with the other arm first", () => {
    const [job] = planPairs(tasks, ["rune", "claude-code"], 1);
    expect(requeued(job!, 2)).toEqual({
      task: job!.task,
      run: 2,
      order: ["claude-code", "rune"],
      requeueOf: 1,
    });
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

describe("the gates between pairs", () => {
  const state = (over: Partial<GateState> = {}): GateState => ({
    pairsRun: 1,
    spentUsd: 0.02,
    unknownCharge: false,
    costliestPairUsd: 0.02,
    ...over,
  });
  const budget: Authorisation = { budgetUsd: 0.05, quotaPct: null };
  const quota: Authorisation = { budgetUsd: null, quotaPct: 50 };
  const both: Authorisation = { budgetUsd: 0.05, quotaPct: 50 };

  test("the first pair always starts", () => {
    expect(gateBeforePair(budget, state({ pairsRun: 0, unknownCharge: true }))).toBeUndefined();
    expect(gateBeforePair(quota, state({ pairsRun: 0 }))).toBeUndefined();
  });

  test("the dollar gate stops before a pair that could cross the ceiling", () => {
    expect(gateBeforePair(budget, state())).toBeUndefined();
    expect(gateBeforePair(budget, state({ spentUsd: 0.04 }))).toMatch(/past the authorised \$0.05/);
  });

  test("the quota gate stops at the share Rune reported", () => {
    expect(gateBeforePair(quota, state({ runeQuotaPct: 49.9 }))).toBeUndefined();
    expect(gateBeforePair(quota, state({ runeQuotaPct: 50 }))).toMatch(/50% of its window/);
  });

  test("a gate that cannot see stops the series unless another one can", () => {
    // Only a dollar ceiling, and a run whose cost nobody could count.
    expect(gateBeforePair(budget, state({ unknownCharge: true }))).toMatch(/no authorisation/);
    // Only a quota share, and a Rune that reports no window (every Rune today).
    expect(gateBeforePair(quota, state({ runeQuotaPct: null }))).toMatch(/cannot be watched/);
    expect(gateBeforePair(quota, state())).toMatch(/no authorisation/);
    // Both given: one blind gate is covered by the other…
    expect(gateBeforePair(both, state({ unknownCharge: true, runeQuotaPct: 10 }))).toBeUndefined();
    expect(gateBeforePair(both, state({ runeQuotaPct: null }))).toBeUndefined();
    // …and two blind gates are not.
    expect(gateBeforePair(both, state({ unknownCharge: true, runeQuotaPct: null }))).toMatch(
      /no authorisation[\s\S]*no cost[\s\S]*quotaPct/,
    );
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

const snap = (entries: Record<string, string>, committed: string[] = []): WorkspaceSnapshot => ({
  head: "h",
  entries,
  committed,
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
    expect(isClean({ durationMs: 1000 }, 5000, false)).toBe(true);
    expect(isClean({ durationMs: 1000, stopped: "timeout" }, 5000, false)).toBe(false);
    expect(isClean({ durationMs: 6000 }, 5000, false)).toBe(false);
    expect(isClean({ durationMs: 1000 }, 5000, true)).toBe(false);
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

  test("an unscored pair is re-queued once, other arm first, under a new run number", async () => {
    const dir = temp("series-requeue-");
    const rune = fakeArm("rune", solve);
    // The comparator's first run of t1 hits a quota wall; every later one works.
    const claude = fakeArm("claude-code", (call) =>
      call.task === "t1" && call.run === 1 ? refused : solve(call),
    );
    const options = series(
      dir,
      { rune: rune.arm, comparator: claude.arm },
      {
        tasks: ["t1", "t2", "t3", "t4"].map((id) => syntheticTask(id)),
      },
    );
    const report = await runPairs(options);
    expect(report).toMatchObject({ planned: 4, pairsRun: 5, unscoredPairs: 1, requeued: 1 });
    const rows = readRows(options.out);
    const t1 = rows.filter((row) => row.task === "t1");
    expect(t1.map((row) => `${row.run}:${row.arm}:${row.scored}`)).toEqual([
      "1:rune:true",
      "1:claude-code:false",
      "2:claude-code:true",
      "2:rune:true",
    ]);
    expect(t1[1]!.unscoredReason).toBe("provider_quota");
    const { pairing } = scorerReads(options.out);
    expect(pairing.pairs).toHaveLength(5);
    expect(pairing.unpaired).toEqual({ rune: [], comparator: [] });
  }, 60_000);

  test("…once only: a re-run that is unscored again is not re-queued again", async () => {
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
    // Two unscored pairs of ten planned is not more than a quarter: it runs on.
    expect(report).toMatchObject({ planned: 10, pairsRun: 11, unscoredPairs: 2, requeued: 1 });
    expect(report.stoppedEarly).toBeUndefined();
    expect(
      readRows(options.out)
        .filter((r) => r.task === "t1")
        .map((r) => r.run),
    ).toEqual([1, 1, 2, 2]);
  }, 60_000);

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
    expect(report).toMatchObject({ unscoredPairs: 1, requeued: 1, pairsRun: 5 });
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
    expect(pairing.pairs).toHaveLength(5);
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

  test("the quota gate stops the series once Rune reports the share it was given", async () => {
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
      },
    );
    const report = await runPairs(options);
    // 30% after the first pair, 60% after the second: no third pair.
    expect(report.pairsRun).toBe(2);
    expect(report.stoppedEarly).toMatch(/60% of its window/);
    expect(
      readRows(options.out)
        .filter((r) => r.arm === "rune")
        .map((r) => r.quotaPct),
    ).toEqual([30, 60]);
  }, 60_000);

  test("…and a quota gate that cannot see stops after the first pair", async () => {
    const dir = temp("series-quota-blind-");
    const options = series(
      dir,
      {
        rune: fakeArm("rune", solve).arm,
        comparator: fakeArm("claude-code", solve).arm,
      },
      { env: { RUNE_EVAL_QUOTA_PCT: "50" } },
    );
    const report = await runPairs(options);
    expect(report.pairsRun).toBe(1);
    expect(report.stoppedEarly).toMatch(/cannot be watched/);
  }, 60_000);

  test("the dollar gate stops before a pair that could cross the series ceiling", async () => {
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

    test("the CLI: twelve pairs planned, nothing executed, nothing written", () => {
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
      expect(cli.stdout).toContain("12 pair(s) planned");
      expect(cli.stdout).toContain("Nothing was executed and nothing was written");
      expect(existsSync(mark)).toBe(false);
      expect(existsSync(out)).toBe(false);
    });

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
        log: () => {},
      });
      expect(report).toMatchObject({ pairsRun: 1, unscoredPairs: 0 });
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
