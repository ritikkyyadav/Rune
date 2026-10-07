/**
 * The Parity Index report: inputs validated and hashed, pairs formed, one Rune
 * build per mode, product mode as the gate, and a CLI that never overwrites.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ParityInputError,
  comparabilityProblems,
  consistencyProblems,
  latestAttempts,
  loadResults,
  mixedBuildProblems,
  pairRows,
  validateRow,
} from "../../eval/parity/aggregate";
import { DEFAULT_SEED } from "../../eval/parity/bootstrap";
import {
  REPORT_JSON,
  REPORT_MD,
  buildReport,
  main,
  parseArgs,
  renderMarkdown,
  type ParityReport,
} from "../../eval/parity/report";
import {
  GOLDEN,
  GOLDEN_HARNESS_E,
  RUNE_SHA,
  RUNE_SHA_2,
  digest,
  exclusionPairs,
  goldenFile,
  goldenPairs,
  mixedRuneFile,
  pair,
  row,
  toJsonl,
} from "../../fixtures/parity/rows";
import type { ParityRunResult } from "../../eval/parity/types";

const FIXTURES = join(import.meta.dir, "../../fixtures/parity");
const GOLDEN_FILE = join(FIXTURES, "golden-v2.jsonl");
/** `parity-run/1` evidence, kept byte for byte. */
const GOLDEN_V1_FILE = join(FIXTURES, "golden.jsonl");
const MIXED_FILE = join(FIXTURES, "mixed-rune.jsonl");
const INVALID_FILE = join(FIXTURES, "invalid.jsonl");

const scratch = mkdtempSync(join(tmpdir(), "parity-report-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const B = 400;
const NOW = new Date("2026-09-28T12:00:00.000Z");

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) }, out, err };
};

describe("the checked-in fixtures are what rows.ts builds", () => {
  test("golden-v2.jsonl, golden.jsonl and mixed-rune.jsonl", () => {
    expect(readFileSync(GOLDEN_FILE, "utf8")).toBe(toJsonl(goldenFile()));
    expect(readFileSync(GOLDEN_V1_FILE, "utf8")).toBe(toJsonl(goldenFile(true)));
    expect(readFileSync(MIXED_FILE, "utf8")).toBe(toJsonl(mixedRuneFile()));
    // The two golden files are the same runs under two schemas, and nothing else.
    expect(goldenFile().map((r) => r.schema)).toEqual(goldenFile().map(() => "parity-run/2"));
    expect(goldenFile(true).map((r) => r.schema)).toEqual(goldenFile().map(() => "parity-run/1"));
  });
});

describe("reading results", () => {
  test("every row is validated against the contract, and every bad line named", () => {
    let error: unknown;
    try {
      loadResults([INVALID_FILE]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ParityInputError);
    const problems = (error as ParityInputError).problems;
    const at = (line: number, text: string) =>
      problems.some((p) => p.startsWith(`${INVALID_FILE}:${line}: `) && p.includes(text));
    expect(at(1, 'schema is "parity-run/0"')).toBe(true);
    expect(at(2, "not JSON")).toBe(true);
    expect(at(4, "version missing")).toBe(true);
    expect(at(4, "hiddenPassed exceeds")).toBe(true);
    expect(at(5, "unscoredReason")).toBe(true);
    expect(at(5, "scope must be 0, 0.5 or 1")).toBe(true);
    expect(problems.some((p) => p.startsWith(`${INVALID_FILE}:3:`))).toBe(false);
  });

  test("a valid row has no problems; a scored row may not carry an unscoredReason", () => {
    expect(validateRow(row({ task: "a", run: 1, arm: "rune" }))).toEqual([]);
    const r = { ...row({ task: "a", run: 1, arm: "rune" }), unscoredReason: "provider_auth" };
    expect(validateRow(r)).toContain("a scored row carries an unscoredReason");
  });

  test("both row schemas are readable, and a schema nobody wrote is not", () => {
    for (const r of goldenFile()) expect(validateRow(r)).toEqual([]);
    for (const r of goldenFile(true)) expect(validateRow(r)).toEqual([]);
    expect(
      validateRow({ ...row({ task: "a", run: 1, arm: "rune" }), schema: "parity-run/3" }),
    ).toEqual(['schema is "parity-run/3", expected "parity-run/1" or "parity-run/2"']);
  });

  test("a current row says how its run ended, and its flags cannot contradict that", () => {
    const base = row({ task: "a", run: 1, arm: "rune" });
    const bad = (over: Record<string, unknown>) => validateRow({ ...base, ...over });
    const { terminal: _terminal, ...unsaid } = base;
    expect(validateRow(unsaid)).toEqual([
      "terminal undefined unknown: a parity-run/2 row says how its run ended",
    ]);
    expect(bad({ terminal: "finished" })[0]).toMatch(/^terminal "finished" unknown/);
    // A crash, a rig stop and a refusal are never clean, however the row was built.
    for (const terminal of ["crashed", "stopped", "refused", "not_started"])
      expect(bad({ terminal, scored: false, unscoredReason: "provider_outage" })).toContain(
        `a run that ended ${terminal} cannot be clean`,
      );
    expect(bad({ terminal: "incomplete" })).toEqual([]);
    // A false completion is a success CLAIM the grader found short.
    expect(bad({ terminal: "incomplete", clean: false, falseCompletion: true })).toEqual([
      "a false completion needs a success claim, and this run ended incomplete",
    ]);
    expect(bad({ falseCompletion: true })).toEqual(["a false completion cannot be clean"]);
    expect(bad({ clean: false, falseCompletion: true })).toEqual([]);
    // Refused or never started: nothing of the tool's was measured.
    expect(bad({ terminal: "refused", clean: false })).toEqual([
      "a run that ended refused cannot be scored",
    ]);
    // What parity-run/1 said of the run is part of the row.
    const { legacy: _legacy, ...unremembered } = base;
    expect(validateRow(unremembered)[0]).toMatch(/^legacy must be \{ clean: boolean, scope/);
    expect(bad({ legacy: { clean: true, scope: 2 } })[0]).toMatch(/^legacy must be/);
    // None of this is asked of a parity-run/1 row, which never recorded it.
    expect(validateRow(row({ task: "a", run: 1, arm: "rune", v1: true }))).toEqual([]);
  });

  test("inputs are hashed from their bytes", () => {
    const { inputs, rows } = loadResults([GOLDEN_FILE]);
    const bytes = readFileSync(GOLDEN_FILE);
    expect(inputs).toEqual([
      {
        path: GOLDEN_FILE,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rows: goldenFile().length,
      },
    ]);
    expect(rows.length).toBe(goldenFile().length);
  });

  test("two rows for one (mode, arm, task, run), or a task under two families, are refused", () => {
    const dup = [row({ task: "a", run: 1, arm: "rune" }), row({ task: "a", run: 1, arm: "rune" })];
    expect(consistencyProblems(dup)[0]).toMatch(/2 rows for rune on a run 1 \(product\)/);
    const split = [
      row({ task: "a", run: 1, arm: "rune", family: "F1" }),
      row({ task: "a", run: 2, arm: "rune", family: "F2" }),
    ];
    expect(consistencyProblems(split)).toEqual(["task a is filed under F1 and F2"]);
    const path = join(scratch, "dup.jsonl");
    writeFileSync(path, toJsonl(dup));
    expect(() => loadResults([path])).toThrow(ParityInputError);
  });

  test("pairs are (task, run, mode) across Rune and the comparator; the rest is counted", () => {
    const p = pairRows(goldenFile(), "product", "claude-code");
    expect(p.pairs.length).toBe(11);
    expect(p.unpaired).toEqual({ rune: ["f#1"], comparator: [] });
    expect(p.otherArmRows).toBe(1);
    const o = pairRows(goldenFile(), "product", "opencode");
    expect(o.pairs.map((x) => `${x.task}#${x.run}`)).toEqual(["a#1"]);
    expect(o.pairs[0]!.comparator.arm).toBe("opencode");
  });
});

describe("the report", () => {
  const { inputs, rows } = loadResults([GOLDEN_FILE]);
  const report = buildReport({ rows, inputs, now: NOW, b: B });
  const f1 = report.modes.product.families[0]!;

  test("identifies itself and records what it was made from", () => {
    expect(report.kind).toBe("parity-report");
    expect(report.schema).toBe("parity-report/2");
    expect(report.rowSchemas).toEqual({ "parity-run/2": goldenFile().length });
    expect(report.proposedCompleteRateFloor).toBe(0.8);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.comparator).toBe("claude-code");
    expect(report.seed).toBe(DEFAULT_SEED);
    expect(report.inputs).toEqual(inputs);
    expect(report.bootstrap).toEqual({
      b: B,
      quantiles: [0.1, 0.9],
      stratifiedBy: "task",
      prng: "mulberry32",
      taskLevel: { quantiles: [0.025, 0.975], resamples: "tasks" },
    });
    expect(report.allowed).toEqual({ unfingerprinted: [], mixedConfig: [] });
  });

  test("product F1 carries the golden numbers", () => {
    expect(f1.n).toBe(6);
    expect(f1.tasks).toEqual(["a", "b", "c"]);
    expect(f1.axes!.O).toBeCloseTo(GOLDEN.O, 9);
    expect(f1.axes!.E).toBeCloseTo(GOLDEN.E, 9);
    expect(f1.axes!.R).toBeCloseTo(GOLDEN.R, 9);
    expect(f1.axes!.S).toBe(100);
    expect(f1.uncapped!.S).toBeCloseTo(1.1, 9);
    expect(f1.PI).toBeCloseTo(GOLDEN.PI, 9);
    expect(f1.excluded).toEqual({
      unscoredPairs: 2,
      noHiddenChecks: 2,
      tooHardPairs: 1,
      tooHardTasks: ["e"],
    });
  });

  test("the headline is the weakest product family; the rest are unmeasured", () => {
    expect(report.headline).toEqual({ mode: "product", family: "F1", name: "fix", PI: f1.PI! });
    expect(report.modes.product.families.slice(1).every((f) => f.status === "UNMEASURED")).toBe(
      true,
    );
    // Unmeasured families hold the overall status at PROVISIONAL at best.
    expect(report.status).toBe(f1.status === "FAIL" ? "FAIL" : "PROVISIONAL");
    expect(report.reasons).toContain("F2 unmeasured");
  });

  test("an unpaired row is reported, not scored", () => {
    expect(report.modes.product.unpaired).toEqual({ rune: ["f#1"], comparator: [] });
    expect(report.reasons.some((r) => r.includes("1 Rune row(s)"))).toBe(true);
  });

  test("harness mode is scored separately, and the model gap is harness − product", () => {
    const h = report.modes.harness.families[0]!;
    expect(h.axes!.E).toBeCloseTo(GOLDEN_HARNESS_E, 9);
    expect(report.modelGap.F1).toBeCloseTo(25 * (2 ** (-3 / 28) - 2 ** (-1 / 8)), 9);
    expect(report.modelGap.F2).toBeNull();
  });

  test("versions seen per arm and mode", () => {
    expect(report.versions.product.rune).toEqual([
      { version: "1.3.1", binarySha256: RUNE_SHA, models: ["model-r"], rows: 12 },
    ]);
    expect(report.versions.product.opencode).toEqual([
      { version: "0.9.0", binarySha256: null, models: ["model-o"], rows: 1 },
    ]);
    expect(report.versions.harness.rune![0]!.models).toEqual(["model-h"]);
    expect(report.mixedVersions).toEqual([]);
  });

  test("the seed is the caller's, is recorded, and never moves the point", () => {
    const other = buildReport({ rows, inputs, now: NOW, b: B, seed: 7 });
    expect(other.seed).toBe(7);
    expect(other.modes.product.families[0]!.PI).toBe(f1.PI);
    // Same seed, same interval: the report can be re-derived from what it records.
    const again = buildReport({ rows, inputs, now: NOW, b: B });
    expect(again.modes.product.families[0]!.interval).toEqual(f1.interval);
  });

  test("the comparator can be OpenCode", () => {
    const oc = buildReport({ rows, inputs, now: NOW, b: B, comparator: "opencode" });
    expect(oc.comparator).toBe("opencode");
    expect(oc.modes.product.families[0]!.n).toBe(1);
    // Claude Code's eleven product rows are now the third arm.
    expect(oc.modes.product.otherArmRows).toBe(11);
  });

  test("the Markdown carries the same numbers", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("# Parity Index — Rune vs claude-code");
    expect(md).toContain(`**Status: ${report.status}**`);
    const within = `${f1.interval!.PI!.lo.toFixed(1)}–${f1.interval!.PI!.hi.toFixed(1)}`;
    const across = `${f1.taskInterval!.PI!.lo.toFixed(1)}–${f1.taskInterval!.PI!.hi.toFixed(1)}`;
    expect(md).toContain(
      `| F1 fix | 6 | 3 | 95.7 | 91.7 | 80.0 | 100.0 | 92.2 | ${within} | ${across} | 92.2 | ${f1.status} |`,
    );
    expect(md).toContain(
      "| Family | n | Tasks | O | E | R | S | PI | 80% within tasks | 95% across tasks | PI, v1 rules | Status |",
    );
    expect(md).toContain("95% task-level interval, tasks resampled");
    expect(md).toContain("| F1 | 0.96× | 0.92× | 0.80× | 1.10× |");
    expect(md).toContain("## Harness mode — attribution only, never a gate");
    expect(md).toContain(`seed ${DEFAULT_SEED}`);
    expect(md).toContain(report.inputs[0]!.sha256);
  });
});

describe("what each arm did, counted — beside the ratio, never inside it", () => {
  const { inputs, rows } = loadResults([GOLDEN_FILE]);
  const report = buildReport({ rows, inputs, now: NOW, b: B });
  const f1 = report.modes.product.families[0]!;

  test("every attempt is in the count: excluded pairs, unscored rows and partnerless ones", () => {
    // Product F1: 6 golden pairs + 5 exclusion pairs; the F2 row has no partner.
    expect(f1.absolute.rune).toMatchObject({
      attempts: 11,
      scored: 10,
      unscored: { provider_quota: 1 },
      gradable: 9,
      unverified: 1,
      complete: 6,
      partial: 2,
      zero: 1,
      cleanComplete: 5,
      scopeViolations: 0,
      leftovers: 1,
      falseCompletions: 0,
      terminal: { completed: 10, refused: 1 },
    });
    expect(f1.absolute.rune.completeRate).toBeCloseTo(6 / 9, 12);
    expect(f1.absolute.comparator).toMatchObject({
      attempts: 11,
      scored: 10,
      unscored: { provider_outage: 1 },
      gradable: 8,
      unverified: 2,
      complete: 6,
      partial: 1,
      zero: 1,
      cleanComplete: 4,
      scopeViolations: 1,
    });
    // The partnerless F2 row is an attempt Rune made.
    expect(report.modes.product.families[1]!.absolute.rune.attempts).toBe(1);
    expect(report.modes.product.families[1]!.absolute.comparator.attempts).toBe(0);
    expect(report.modes.product.absolute.rune.attempts).toBe(12);
    // Counting changes nothing the gate reads.
    expect(f1.PI).toBeCloseTo(GOLDEN.PI, 9);
  });

  test("equal partial quality: the ratio is perfect and the caveat says what it is worth", () => {
    // Six pairs over three tasks; both arms pass 2 of 4 hidden checks every time.
    const half = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, { passed: 2 }, { passed: 2 })),
    );
    const r = buildReport({ rows: half, inputs: [], now: NOW, b: B });
    const f = r.modes.product.families[0]!;
    expect(f.axes).toMatchObject({ O: 100, R: 100, S: 100 });
    expect(f.PI).toBeCloseTo(100, 9);
    expect(f.absolute.rune).toMatchObject({
      gradable: 6,
      complete: 0,
      partial: 6,
      completeRate: 0,
    });
    expect(f.absolute.comparator).toMatchObject({ complete: 0, partial: 6, completeRate: 0 });
    expect(f.caveats).toEqual([
      "relative O is 100.0, but Rune completed 0 of 6 gradable attempt(s) (0%) and claude-code 0 of 6 gradable attempt(s) (0%), both under the proposed 80% floor: the ratio is parity at a low level",
    ]);
    // A caveat is reported, and is no part of the status: the same pairs with
    // nothing to caveat gate the same way.
    const whole = buildReport({
      rows: half.map((x) => ({ ...x, outcome: { ...x.outcome, hiddenPassed: 4 } })),
      inputs: [],
      now: NOW,
      b: B,
    }).modes.product.families[0]!;
    expect(whole.caveats).toEqual([]);
    expect(f.status).toBe("PROVISIONAL");
    expect(f.reasons).toEqual(["E insufficient: 0 pair(s) where both arms succeeded, need 4"]);
    expect(renderMarkdown(r)).toContain("- F1: relative O is 100.0, but Rune completed 0 of 6");
    expect(renderMarkdown(r)).toContain(
      "| F1 | Rune | 6 | 0 | 6 | 0 | 6 | 0 | 0 | 0% | 0 | 0 | 0 | 0 | 0 | 0 |",
    );
    // A family nobody attempted has no line in the count.
    expect(renderMarkdown(r)).not.toContain("| F2 | Rune |");
    expect(renderMarkdown(r)).toContain("| All | Rune | 6 | 0 | 6 | 0 | 6 |");
  });

  test("a report made only of exclusions never passes, and still says what was attempted", () => {
    const r = buildReport({ rows: exclusionPairs(), inputs: [], now: NOW, b: B });
    expect(r.status).toBe("PROVISIONAL");
    expect(r.headline).toBeNull();
    expect(r.reasons[0]).toMatch(/^no product-mode family was measured/);
    expect(r.modes.product.families.map((f) => f.status)).toEqual(Array(7).fill("UNMEASURED"));
    const f = r.modes.product.families[0]!;
    expect(f).toMatchObject({ n: 0, PI: null, axes: null });
    // Unmeasured is not unsaid: the counts still carry their caveat.
    expect(f.caveats).toEqual([
      "Rune completed 1 of 3 gradable attempt(s) (33%), under the proposed 80% floor",
    ]);
    expect(f.excluded).toEqual({
      unscoredPairs: 2,
      noHiddenChecks: 2,
      tooHardPairs: 1,
      tooHardTasks: ["e"],
    });
    // Out of the index, in the count: the both-zero pair's two zeros are there.
    expect(f.absolute.rune).toMatchObject({ attempts: 5, scored: 4, gradable: 3, zero: 1 });
    expect(f.absolute.comparator).toMatchObject({ attempts: 5, scored: 4, gradable: 2, zero: 1 });
    expect(renderMarkdown(r)).toContain("1 both-zero pair(s) (too hard: e)");
  });

  test("a complete answer that went out of scope is complete, and is not a clean completion", () => {
    const rows = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, run === 1 ? { scope: 0 } : {}, {})),
    );
    const f = buildReport({ rows, inputs: [], now: NOW, b: B }).modes.product.families[0]!;
    expect(f.axes).toMatchObject({ O: 100, S: 50 });
    expect(f.status).toBe("FAIL");
    expect(f.reasons).toContain("S 50.0 < 70");
    expect(f.absolute.rune).toMatchObject({
      complete: 6,
      cleanComplete: 3,
      scopeViolations: 3,
      completeRate: 1,
    });
    expect(f.caveats).toEqual([
      "3 Rune attempt(s) changed something out of scope",
      "3 of Rune's 6 complete attempt(s) ended unclean or out of scope",
    ]);
  });

  test('an honest "not finished" and a crash are different rows, and only one is clean', () => {
    // Rune fails task c twice. Once it says so; once the process dies.
    const rows = [
      ...pair("a", 1, {}, {}),
      ...pair("a", 2, {}, {}),
      ...pair("b", 1, {}, {}),
      ...pair("b", 2, {}, {}),
      ...pair("c", 1, { passed: 2, terminal: "incomplete" }, {}),
      ...pair("c", 2, { passed: 2, terminal: "crashed", legacyClean: true }, {}),
    ];
    for (const r of rows) expect(validateRow(r)).toEqual([]);
    const f = buildReport({ rows, inputs: [], now: NOW, b: B }).modes.product.families[0]!;
    expect(f.absolute.rune.terminal).toEqual({ completed: 4, incomplete: 1, crashed: 1 });
    // Five of six clean now; parity-run/1 called the crash clean too.
    expect(f.axes!.R).toBeCloseTo((100 * 5) / 6, 9);
    expect(f.legacy.R).toBe(100);
    expect(f.legacy.differs).toBe(true);
    expect(f.legacy.PI!).toBeGreaterThan(f.PI!);
    expect(f.caveats).toContain("1 Rune attempt(s) crashed");
    // The honest row alone moves nothing: both rules call it clean.
    const honest = buildReport({ rows: rows.slice(0, 10), inputs: [], now: NOW, b: B }).modes
      .product.families[0]!;
    expect(honest.axes!.R).toBe(100);
    expect(honest.legacy).toMatchObject({ R: 100, differs: false });
    expect(honest.legacy.PI).toBe(honest.PI);
  });

  test("the index under the old rules is shown beside the new one, and marked where they part", () => {
    // Rune's coding-task scope: out of bounds now (0), in scope under parity-run/1 (1).
    const rows = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, { scope: 0, legacyScope: 1 }, {})),
    );
    const r = buildReport({ rows, inputs: [], now: NOW, b: B });
    const f = r.modes.product.families[0]!;
    expect(f.axes!.S).toBe(0);
    expect(f.legacy).toMatchObject({ S: 100, PI: 100, differs: true });
    expect(f.PI).toBeCloseTo(85, 9);
    expect(f.status).toBe("FAIL");
    expect(renderMarkdown(r)).toMatch(
      /\| F1 fix \| 6 \| 3 \| 100\.0 \| 100\.0 \| 100\.0 \| 0\.0 \| 85\.0 \| [^|]+ \| [^|]+ \| 100\.0† \| FAIL \|/,
    );
    // The golden family has no such row: the two indexes are one number.
    expect(f1.legacy).toMatchObject({ differs: false });
    expect(f1.legacy.PI).toBe(f1.PI);
  });
});

describe("old evidence stays readable", () => {
  test("golden.jsonl, written under parity-run/1, still derives the same index", () => {
    const { inputs, rows } = loadResults([GOLDEN_V1_FILE]);
    const r = buildReport({ rows, inputs, now: NOW, b: B, allowUnfingerprinted: true });
    const f = r.modes.product.families[0]!;
    expect(r.rowSchemas).toEqual({ "parity-run/1": goldenFile(true).length });
    expect(f.PI).toBeCloseTo(GOLDEN.PI, 9);
    expect(f.axes!.R).toBeCloseTo(GOLDEN.R, 9);
    // Its clean and scope ARE the old rules' values: one index, not two.
    expect(f.legacy).toMatchObject({ differs: false });
    expect(f.legacy.PI).toBe(f.PI);
    // What it never recorded is reported as unrecorded, not guessed.
    expect(f.absolute.rune.terminal).toEqual({ unrecorded: 11 });
    expect(renderMarkdown(r)).toContain("Row schemas read: parity-run/1 × 36.");
    // And the two schemas' golden files agree on everything the gate reads.
    const current = buildReport({ ...loadResults([GOLDEN_FILE]), now: NOW, b: B });
    const g = current.modes.product.families[0]!;
    expect({ PI: g.PI, axes: g.axes, interval: g.interval, taskInterval: g.taskInterval }).toEqual({
      PI: f.PI,
      axes: f.axes,
      interval: f.interval,
      taskInterval: f.taskInterval,
    });
  });

  test("…but only when asked, and it can never PASS: it does not say what graded it", () => {
    const { inputs, rows } = loadResults([GOLDEN_V1_FILE]);
    let refusal: unknown;
    try {
      buildReport({ rows, inputs, now: NOW, b: B });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ParityInputError);
    // 35: the third arm's row is not being compared, and is not held to it.
    expect((refusal as ParityInputError).problems).toEqual([
      "35 row(s) carry no fingerprints (parity-run/1 × 35): nothing shows they were given the same task or graded by the same checks",
      "pass --allow-unfingerprinted to report them: the report then says so and cannot PASS",
    ]);
    // A family that passes every threshold, written under parity-run/1.
    const perfect = (v1: boolean) =>
      ["a", "b", "c"].flatMap((task) => [1, 2].flatMap((run) => pair(task, run, {}, {}, { v1 })));
    const now = buildReport({ rows: perfect(false), inputs: [], now: NOW, b: B });
    expect(now.modes.product.families[0]).toMatchObject({ status: "PASS", reasons: [] });
    const old = buildReport({
      rows: perfect(true),
      inputs: [],
      now: NOW,
      b: B,
      allowUnfingerprinted: true,
    });
    expect(old.modes.product.families[0]).toMatchObject({
      PI: 100,
      status: "PROVISIONAL",
      reasons: ["rows without fingerprints (allowed by --allow-unfingerprinted)"],
    });
    expect(old.allowed.unfingerprinted).toHaveLength(1);
    expect(old.reasons.at(-1)).toMatch(
      /^12 row\(s\) carry no fingerprints .* \(allowed by --allow-unfingerprinted\)$/,
    );
  });

  test("the CLI: refused without the flag, and the refusal names it", () => {
    const refused = quiet();
    const out = join(scratch, "v1-refused");
    expect(main(["--results", GOLDEN_V1_FILE, "--out", out], refused.io)).toBe(1);
    expect(refused.err.join("\n")).toContain("pass --allow-unfingerprinted to report them");
    expect(existsSync(join(out, REPORT_JSON))).toBe(false);
    const allowed = quiet();
    expect(
      main(["--results", GOLDEN_V1_FILE, "--out", out, "--allow-unfingerprinted"], allowed.io),
    ).toBe(0);
    const json = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as ParityReport;
    expect(json.rowSchemas).toEqual({ "parity-run/1": 36 });
    expect(json.allowed.unfingerprinted).toHaveLength(1);
  });

  test("a report already on disk, whatever its schema, is never rewritten", () => {
    const out = join(scratch, "old-report");
    mkdirSync(out, { recursive: true });
    const old = `${JSON.stringify({ kind: "parity-report", schema: "parity-report/1", status: "PASS" })}\n`;
    writeFileSync(join(out, REPORT_JSON), old);
    const q = quiet();
    expect(main(["--results", GOLDEN_FILE, "--out", out], q.io)).toBe(1);
    expect(q.err.join("\n")).toMatch(/refusing to overwrite/);
    expect(readFileSync(join(out, REPORT_JSON), "utf8")).toBe(old);
    expect(existsSync(join(out, REPORT_MD))).toBe(false);
  });
});

describe("a retried run: the latest attempt counts, the first one is evidence", () => {
  // The comparator's first run of task a hit an outage and was retried, alone.
  const outage = row(
    { task: "a", run: 1, arm: "claude-code" },
    { scored: false, unscoredReason: "provider_outage", wallMs: 7000 },
  );
  const retry = row({ task: "a", run: 1, arm: "claude-code", attempt: 2 }, { wallMs: 100 });
  const rune = row({ task: "a", run: 1, arm: "rune" });
  const rows = [rune, outage, retry];

  test("an attempt is a whole number of at least 1, and absent means the first", () => {
    for (const r of rows) expect(validateRow(r)).toEqual([]);
    expect(retry.attempt).toBe(2);
    expect(outage.attempt).toBeUndefined();
    for (const attempt of [0, 1.5, "2", -1])
      expect(validateRow({ ...retry, attempt })).toEqual([
        "attempt must be a whole number of at least 1",
      ]);
  });

  test("two attempts of one run are not a duplicate; the same attempt twice is", () => {
    expect(consistencyProblems(rows)).toEqual([]);
    expect(consistencyProblems([rune, outage, { ...outage }])).toEqual([
      "2 rows for claude-code on a run 1 (product); a pair needs exactly one",
    ]);
    expect(consistencyProblems([rune, retry, { ...retry }])).toEqual([
      "2 rows for claude-code on a run 1, attempt 2 (product); a pair needs exactly one",
    ]);
  });

  test("the pair is Rune's row with the comparator's LATEST attempt, whatever order they were read in", () => {
    for (const order of [rows, [retry, outage, rune], [outage, retry, rune]]) {
      const p = pairRows(order, "product", "claude-code");
      expect(p.pairs).toHaveLength(1);
      expect(p.pairs[0]!.comparator).toBe(retry);
      expect(p.pairs[0]!.rune).toBe(rune);
      expect(p.unpaired).toEqual({ rune: [], comparator: [] });
      // The first attempt is not scored, and is still one of the arm's attempts.
      expect(p.rows.comparator).toHaveLength(2);
      expect(p.rows.rune).toHaveLength(1);
    }
    expect(latestAttempts(rows)).toEqual({ counted: [rune, retry], superseded: [outage] });
    // A third arm's superseded row is as ignored as its counted one.
    const third = [
      ...rows,
      row(
        { task: "a", run: 1, arm: "opencode" },
        { scored: false, unscoredReason: "provider_quota" },
      ),
      row({ task: "a", run: 1, arm: "opencode", attempt: 2 }),
    ];
    expect(pairRows(third, "product", "claude-code").otherArmRows).toBe(2);
  });

  test("the report scores the retry and still shows the outage and the time it took", () => {
    const five = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => (task === "a" && run === 1 ? [] : pair(task, run, {}, {}))),
    );
    const report = buildReport({ rows: [...rows, ...five], inputs: [], now: NOW, b: B });
    const f = report.modes.product.families[0]!;
    expect(f).toMatchObject({ n: 6, status: "PASS" });
    expect(f.excluded.unscoredPairs).toBe(0);
    expect(f.absolute.comparator).toMatchObject({
      attempts: 7,
      scored: 6,
      complete: 6,
      unscored: { provider_outage: 1 },
      unscoredWallMs: 7000,
      terminal: { completed: 6, refused: 1 },
    });
    expect(f.absolute.rune.attempts).toBe(6);
    // Without the retry the same pair is out of the index.
    const unfilled = buildReport({
      rows: [rune, outage, ...five],
      inputs: [],
      now: NOW,
      b: B,
    }).modes.product.families[0]!;
    expect(unfilled).toMatchObject({ n: 5, status: "PROVISIONAL" });
    expect(unfilled.excluded.unscoredPairs).toBe(1);
  });
});

describe("evidence that cannot be shown comparable is refused", () => {
  /** Six perfect pairs over three tasks: PASS, unless something about the rows says otherwise. */
  const perfect = (over: (task: string, run: number) => [object, object] = () => [{}, {}]) =>
    ["a", "b", "c"].flatMap((task) => [1, 2].flatMap((run) => pair(task, run, ...over(task, run))));
  const refusal = (rows: ParityRunResult[], options: object = {}): string[] => {
    try {
      buildReport({ rows, inputs: [], now: NOW, b: B, ...options });
    } catch (error) {
      if (error instanceof ParityInputError) return error.problems;
      throw error;
    }
    return [];
  };
  const everyFlag = {
    allowMixedVersions: true,
    allowMixedConfig: true,
    allowUnfingerprinted: true,
  };

  test("rows that agree on everything are reported, and can PASS", () => {
    expect(refusal(perfect())).toEqual([]);
    expect(comparabilityProblems(perfect(), "claude-code")).toEqual({
      mismatched: [],
      unfingerprinted: [],
      mixedConfig: [],
    });
    const f = buildReport({ rows: perfect(), inputs: [], now: NOW, b: B }).modes.product
      .families[0]!;
    expect(f).toMatchObject({ status: "PASS", reasons: [] });
  });

  test("a current row that does not say what it was given or graded by is not a row", () => {
    const base = row({ task: "a", run: 1, arm: "rune" });
    const { fingerprints, ...bare } = base;
    expect(validateRow(bare)).toEqual([
      "fingerprints missing: a row that does not say what it was given or graded by is not evidence",
    ]);
    const bad = (prints: object) =>
      validateRow({ ...base, fingerprints: { ...fingerprints, ...prints } });
    expect(bad({ grader: "checks-v2" })).toEqual(["fingerprints.grader must be a sha256"]);
    expect(bad({ grader: undefined })).toEqual(["fingerprints.grader must be a sha256"]);
    expect(bad({ config: 7 })).toEqual(["fingerprints.config must be a sha256"]);
    expect(bad({ task: "tree" })).toEqual([
      "fingerprints.task must be a sha256, or null on a run that never started",
    ]);
    // No task fingerprint is the mark of a tree that was never prepared, and of nothing else.
    expect(bad({ task: null })).toEqual([
      "fingerprints.task must be a sha256, or null on a run that never started",
    ]);
    expect(
      validateRow(
        row(
          { task: "a", run: 1, arm: "rune" },
          {
            scored: false,
            unscoredReason: "grader_infrastructure",
            terminal: "not_started",
            startedFrom: null,
          },
        ),
      ),
    ).toEqual([]);
    // The roster is part of the row: absent is not the same as empty.
    const { models: _models, ...unnamed } = base;
    expect(validateRow(unnamed)).toEqual([
      "models must be a string array: every model the tool reported using, or [] for none",
    ]);
    expect(validateRow({ ...base, models: [] })).toEqual([]);
    expect(validateRow({ ...base, reasoningEffort: 3 })).toEqual([
      "reasoningEffort must be a string",
    ]);
  });

  test("one task graded by two sets of checks: refused, and no flag makes it one exam", () => {
    // The comparator's run of task b, run 2, was graded by other checks.
    const rows = perfect((task, run) => [
      {},
      task === "b" && run === 2 ? { gradedBy: "checks b, edited" } : {},
    ]);
    const expected = [
      `task b was graded by 2 different sets of checks: ${[
        digest("checks b"),
        digest("checks b, edited"),
      ]
        .sort()
        .map((d) => d.slice(0, 12))
        .join(", ")}`,
    ];
    expect(refusal(rows)).toEqual(expected);
    expect(refusal(rows, everyFlag)).toEqual(expected);
  });

  test("one task run from two starting points: refused the same way", () => {
    const rows = perfect((task, run) => [
      task === "a" && run === 1 ? { startedFrom: "task a, another tree" } : {},
      {},
    ]);
    expect(refusal(rows, everyFlag)).toHaveLength(1);
    expect(refusal(rows)[0]).toMatch(
      /^task a was run from 2 different starting points \(prompt, tree, uncommitted work or wall limit\): /,
    );
    // A run that never started was given no tree: it mismatches nothing.
    const withUnstarted = [
      ...perfect(),
      ...pair(
        "a",
        3,
        {
          scored: false,
          unscoredReason: "grader_infrastructure",
          terminal: "not_started",
          startedFrom: null,
        },
        {},
      ),
    ];
    expect(refusal(withUnstarted)).toEqual([]);
  });

  test("rows of two schemas are never scored together", () => {
    const rows = [...perfect(), ...pair("d", 1, {}, {}, { v1: true })];
    const problems = refusal(rows, everyFlag);
    expect(problems).toEqual([
      "parity-run/1 and parity-run/2 rows cannot be scored together: clean and scope mean different things in each",
    ]);
  });

  test("one arm on two configurations in a mode: refused, or reported at PROVISIONAL at best", () => {
    const rows = perfect((task, run) => [
      task === "c" && run === 2 ? { model: "model-x" } : {},
      {},
    ]);
    expect(refusal(rows)).toEqual([
      "product mode mixes 2 Rune configurations: model-r × 5, model-x × 1",
      "product mode mixes 2 Rune model rosters: [model-r] × 5, [model-x] × 1",
      "pass --allow-mixed-config to report across them: the report then says so and cannot PASS",
    ]);
    const r = buildReport({ rows, inputs: [], now: NOW, b: B, allowMixedConfig: true });
    const f = r.modes.product.families[0]!;
    // Every threshold is met; the evidence is still not one comparison.
    expect(f.PI).toBe(100);
    expect(f.status).toBe("PROVISIONAL");
    expect(f.reasons).toEqual([
      "product mode mixes 2 Rune configurations: model-r × 5, model-x × 1 (allowed by --allow-mixed-config)",
      "product mode mixes 2 Rune model rosters: [model-r] × 5, [model-x] × 1 (allowed by --allow-mixed-config)",
    ]);
    expect(r.allowed.mixedConfig).toHaveLength(2);
    // Said once for the family it caps, and once for the report as a whole.
    expect(r.reasons[0]).toBe(`F1 PROVISIONAL: ${f.reasons.join("; ")}`);
    expect(r.reasons.slice(-2)).toEqual(f.reasons);
    // The other mode's rows were not mixed, and are not capped by this one's.
    expect(r.modes.harness.families[0]!.reasons).toEqual(["no scored pairs"]);
    const harness = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, {}, {}, { mode: "harness" })),
    );
    const both = buildReport({
      rows: [...rows, ...harness],
      inputs: [],
      now: NOW,
      b: B,
      allowMixedConfig: true,
    });
    expect(both.modes.product.families[0]!.status).toBe("PROVISIONAL");
    expect(both.modes.harness.families[0]).toMatchObject({ status: "PASS", reasons: [] });
  });

  test("the CLI: --allow-mixed-config lifts that refusal and no other", () => {
    const rows = perfect((task, run) => [
      task === "c" && run === 2 ? { model: "model-x" } : {},
      {},
    ]);
    const file = join(scratch, "mixed-config.jsonl");
    writeFileSync(file, toJsonl(rows));
    const refused = quiet();
    expect(main(["--results", file, "--out", join(scratch, "mc-1")], refused.io)).toBe(1);
    expect(refused.err.join("\n")).toContain("pass --allow-mixed-config to report across them");
    // The wrong flag is not a key to this door.
    expect(
      main(
        ["--results", file, "--out", join(scratch, "mc-2"), "--allow-unfingerprinted"],
        quiet().io,
      ),
    ).toBe(1);
    expect(
      main(["--results", file, "--out", join(scratch, "mc-3"), "--allow-mixed-config"], quiet().io),
    ).toBe(0);
    const json = JSON.parse(
      readFileSync(join(scratch, "mc-3", REPORT_JSON), "utf8"),
    ) as ParityReport;
    expect(json.allowed.mixedConfig).toHaveLength(2);
    expect(json.modes.product.families[0]!.status).toBe("PROVISIONAL");
  });

  test("a provider or an effort is configuration too", () => {
    const viaOther = perfect((task, run) => [run === 2 ? { provider: "ollama" } : {}, {}]);
    expect(refusal(viaOther)[0]).toBe(
      "product mode mixes 2 Rune configurations: model-r × 3, model-r via ollama × 3",
    );
    const effort = perfect((task) => [{}, task === "a" ? { reasoningEffort: "high" } : {}]);
    expect(refusal(effort)[0]).toBe(
      "product mode mixes 2 claude-code configurations: model-c × 4, model-c, effort high × 2",
    );
  });

  test("a model the tool used and was not told to: the roster says so", () => {
    // Told to run model-r every time; on one run it also used a fallback.
    const rows = perfect((task, run) => [
      task === "a" && run === 1 ? { models: ["model-r", "model-fallback"] } : {},
      {},
    ]);
    expect(refusal(rows)).toEqual([
      "product mode mixes 2 Rune model rosters: [model-fallback, model-r] × 1, [model-r] × 5",
      "pass --allow-mixed-config to report across them: the report then says so and cannot PASS",
    ]);
    // A run on which the tool named no model says nothing about which it used.
    const silent = perfect((task, run) => [task === "a" && run === 1 ? { models: [] } : {}, {}]);
    expect(refusal(silent)).toEqual([]);
  });

  test("the comparator is held to the same; a third arm, not being compared, is not", () => {
    const rows = perfect((task) => [
      {},
      task === "b" ? { models: ["model-c", "model-small"] } : {},
    ]);
    expect(refusal(rows)[0]).toBe(
      "product mode mixes 2 claude-code model rosters: [model-c, model-small] × 2, [model-c] × 4",
    );
    const third = [
      ...perfect(),
      row({ task: "a", run: 1, arm: "opencode" }, { model: "model-o" }),
      row({ task: "a", run: 2, arm: "opencode" }, { model: "model-p", gradedBy: "other checks" }),
      row({ task: "b", run: 1, arm: "opencode", v1: true }),
    ];
    expect(refusal(third)).toEqual([]);
    // Compared against OpenCode, they are.
    expect(refusal(third, { comparator: "opencode" }).length).toBeGreaterThan(0);
  });

  test("the comparator on two versions in a mode is two tools, as Rune on two is", () => {
    const rows = perfect((task) => [{}, task === "c" ? { version: "2.1.1" } : {}]);
    expect(mixedBuildProblems(rows, "claude-code")).toEqual([
      "product mode mixes 2 claude-code versions (2.1.0, 2.1.1)",
    ]);
    expect(refusal(rows)).toEqual([
      "product mode mixes 2 claude-code versions (2.1.0, 2.1.1)",
      "pass --allow-mixed-versions to report across them",
    ]);
    const r = buildReport({ rows, inputs: [], now: NOW, b: B, allowMixedVersions: true });
    expect(r.mixedVersions).toEqual(["product mode mixes 2 claude-code versions (2.1.0, 2.1.1)"]);
    // OpenCode's versions are its own business while Claude Code is the comparator.
    const third = [
      ...perfect(),
      row({ task: "a", run: 1, arm: "opencode" }, { version: "0.9.0" }),
      row({ task: "a", run: 2, arm: "opencode" }, { version: "0.9.1" }),
    ];
    expect(mixedBuildProblems(third, "claude-code")).toEqual([]);
    expect(mixedBuildProblems(third, "opencode")).toEqual([
      "product mode mixes 2 opencode versions (0.9.0, 0.9.1)",
    ]);
  });

  test("every problem is named in one refusal", () => {
    const rows = perfect((task, run) => [
      task === "a" && run === 1 ? { model: "model-x", version: "1.3.0" } : {},
      task === "b" && run === 1 ? { gradedBy: "checks b, edited" } : {},
    ]);
    const problems = refusal(rows);
    expect(problems.some((p) => p.startsWith("task b was graded by 2"))).toBe(true);
    expect(problems.some((p) => p.includes("mixes 2 Rune configurations"))).toBe(true);
    expect(problems.some((p) => p.includes("mixes 2 Rune versions"))).toBe(true);
    expect(problems).toContain("pass --allow-mixed-versions to report across them");
    // The flags lift what they name and nothing else.
    expect(refusal(rows, everyFlag)).toEqual([problems[0]!]);
  });

  // ── The roster an arm was configured with ──
  //
  // The first breadth sitting, 2026-10-05: Rune was told to run one model on
  // every run, and its shipped configuration puts the reviewer on another. Ten
  // of eighteen runs needed a review and eight did not, so the rows held two
  // sets of models and the report could not PASS however many pairs ran. The
  // founder's rule: hold what a run called to what its arm was configured with.

  /** The same rows, with one arm's given the roster it was configured with. */
  const withRoster = (rows: ParityRunResult[], arm: string, roster: string[]) =>
    rows.map((r) => (r.arm === arm ? { ...r, roster } : r));
  /** Rune told to run model-r; on task a's two runs it also called model-big. */
  const reviewedTwice = () =>
    perfect((task) => [task === "a" ? { models: ["model-big", "model-r"] } : {}, {}]);

  test("a configured helper that one run called and another did not is one configuration", () => {
    const rows = withRoster(reviewedTwice(), "rune", ["model-big", "model-r", "model-small"]);
    expect(refusal(rows)).toEqual([]);
    expect(comparabilityProblems(rows, "claude-code").mixedConfig).toEqual([]);
    const report = buildReport({ rows, inputs: [], now: NOW, b: B });
    expect(report.modes.product.families[0]).toMatchObject({ status: "PASS", reasons: [] });
    // What was called is still on the page.
    expect(report.rosters).toEqual([
      "product · Rune · configured [model-big, model-r, model-small] · called [model-big, model-r] × 2, [model-r] × 4",
    ]);
    expect(renderMarkdown(report)).toContain(
      "## Models called\n\n- product · Rune · configured [model-big, model-r, model-small] · called",
    );
    // The same rows with no roster stated are two rosters, as they always were.
    expect(refusal(reviewedTwice())[0]).toBe(
      "product mode mixes 2 Rune model rosters: [model-big, model-r] × 2, [model-r] × 4",
    );
    expect(buildReport({ rows: perfect(), inputs: [], now: NOW, b: B }).rosters).toBeUndefined();
    expect(
      renderMarkdown(buildReport({ rows: perfect(), inputs: [], now: NOW, b: B })),
    ).not.toContain("## Models called");
  });

  test("a call to a model outside the configured roster is still a difference", () => {
    const rows = withRoster(
      perfect((task, run) => [
        task === "a" && run === 1 ? { models: ["model-r", "model-fallback"] } : {},
        {},
      ]),
      "rune",
      ["model-big", "model-r"],
    );
    expect(refusal(rows)).toEqual([
      "product mode has Rune runs that called a model outside the configured roster: model-fallback × 1",
      "pass --allow-mixed-config to report across them: the report then says so and cannot PASS",
    ]);
    const allowed = buildReport({ rows, inputs: [], now: NOW, b: B, allowMixedConfig: true });
    expect(allowed.modes.product.families[0]!.status).toBe("PROVISIONAL");
  });

  test("two configured rosters in one mode are two configurations", () => {
    const rows = perfect().map((r) =>
      r.arm === "rune"
        ? { ...r, roster: r.task === "c" ? ["model-r"] : ["model-big", "model-r"] }
        : r,
    );
    expect(refusal(rows)).toEqual([
      "product mode mixes 2 Rune configured rosters: [model-big, model-r] × 4, [model-r] × 2",
      "pass --allow-mixed-config to report across them: the report then says so and cannot PASS",
    ]);
  });

  test("where only some rows state a roster, all of them are held to the same models every run", () => {
    // Rows from before the field and rows from after it, in one report.
    const some = reviewedTwice().map((r) =>
      r.arm === "rune" && r.task !== "c" ? { ...r, roster: ["model-big", "model-r"] } : r,
    );
    expect(refusal(some)[0]).toBe(
      "product mode mixes 2 Rune model rosters: [model-big, model-r] × 2, [model-r] × 4",
    );
    const allowed = buildReport({ rows: some, inputs: [], now: NOW, b: B, allowMixedConfig: true });
    expect(allowed.rosters).toBeUndefined();
  });

  test("a comparator that states a roster is held to it the same way", () => {
    const helper = (model: string) =>
      withRoster(
        perfect((task) => [{}, task === "b" ? { models: ["model-c", model] } : {}]),
        "claude-code",
        ["model-c", "model-small"],
      );
    expect(refusal(helper("model-small"))).toEqual([]);
    expect(refusal(helper("model-other"))[0]).toBe(
      "product mode has claude-code runs that called a model outside the configured roster: model-other × 2",
    );
  });

  test("an empty roster states nothing: those rows are held to the same models every run", () => {
    // A row file is validated on the way in and cannot hold one; rows handed
    // straight to the report can.
    const uniform = withRoster(perfect(), "rune", []);
    expect(refusal(uniform)).toEqual([]);
    expect(refusal(withRoster(reviewedTwice(), "rune", []))[0]).toBe(
      "product mode mixes 2 Rune model rosters: [model-big, model-r] × 2, [model-r] × 4",
    );
  });

  test("a roster names at least one model, and a source build is a sha256", () => {
    const base = row({ task: "a", run: 1, arm: "rune" });
    const roster =
      "roster must be a non-empty string array: every model the arm's configuration names";
    expect(validateRow({ ...base, sourceBuild: "a".repeat(64), roster: ["model-r"] })).toEqual([]);
    expect(validateRow({ ...base, roster: [] })).toEqual([roster]);
    expect(validateRow({ ...base, roster: "model-r" })).toEqual([roster]);
    expect(validateRow({ ...base, sourceBuild: "abc" })).toEqual([
      "sourceBuild must be 64 lowercase hex characters",
    ]);
  });
});

describe("one Rune build per mode", () => {
  const { inputs, rows } = loadResults([MIXED_FILE]);

  // ── A tool run from source ──
  //
  // Rune's arm runs its TypeScript: no one file to hash, and every build of a
  // working tree answers the same `--version`. B1 and the first breadth sitting
  // ran on one source and everything after 2026-10-05 on another, and a report
  // over both would have passed this check. A row now names the source it ran.
  const SOURCE_A = "a".repeat(64);
  const SOURCE_B = "b".repeat(64);
  /** Six pairs with Rune's rows as a run from source writes them. */
  const fromSource = (build: (task: string) => string | null): ParityRunResult[] =>
    ["a", "b", "c"]
      .flatMap((task) => [1, 2].flatMap((run) => pair(task, run, {}, {})))
      .map((r) => {
        if (r.arm !== "rune") return r;
        const { binarySha256: _binary, ...rest } = r;
        const source = build(r.task);
        return source ? { ...rest, sourceBuild: source } : rest;
      });

  test("two source builds of Rune in one mode are refused", () => {
    const two = fromSource((task) => (task === "c" ? SOURCE_B : SOURCE_A));
    expect(mixedBuildProblems(two, "claude-code")).toEqual([
      "product mode mixes 2 Rune source builds (aaaaaaaaaaaa, bbbbbbbbbbbb)",
    ]);
    expect(() => buildReport({ rows: two, inputs: [], b: B })).toThrow(
      /mixes 2 Rune source builds/,
    );
    // Allowed, each build is listed with the rows that ran it.
    const allowed = buildReport({ rows: two, inputs: [], b: B, allowMixedVersions: true });
    expect(allowed.versions.product.rune!.map((v) => [v.sourceBuild, v.rows])).toEqual([
      [SOURCE_A, 4],
      [SOURCE_B, 2],
    ]);
  });

  test("rows that name no source build, beside rows that do, are not known to be the same build", () => {
    const some = fromSource((task) => (task === "c" ? null : SOURCE_A));
    expect(mixedBuildProblems(some, "claude-code")).toEqual([
      "product mode has 2 Rune row(s) that name no source build beside 4 that do: nothing shows they ran the same source",
    ]);
    expect(() => buildReport({ rows: some, inputs: [], b: B })).toThrow(/name no source build/);
  });

  test("one source build is one build, and the report names it", () => {
    const one = fromSource(() => SOURCE_A);
    expect(mixedBuildProblems(one, "claude-code")).toEqual([]);
    const report = buildReport({ rows: one, inputs: [], now: NOW, b: B });
    expect(report.versions.product.rune).toEqual([
      { version: "1.3.1", binarySha256: null, sourceBuild: SOURCE_A, models: ["model-r"], rows: 6 },
    ]);
    expect(renderMarkdown(report)).toContain(
      "- product · rune · 1.3.1 · source aaaaaaaaaaaa… · model-r · 6 row(s)",
    );
  });

  test("rows that never named one are read as they always were", () => {
    const none = fromSource(() => null);
    expect(mixedBuildProblems(none, "claude-code")).toEqual([]);
    const report = buildReport({ rows: none, inputs: [], now: NOW, b: B });
    expect(report.versions.product.rune).toEqual([
      { version: "1.3.1", binarySha256: null, models: ["model-r"], rows: 6 },
    ]);
  });

  test("two Rune binaries in one mode are refused", () => {
    expect(() => buildReport({ rows, inputs, b: B })).toThrow(/product mode mixes 2 Rune binaries/);
  });

  test("two Rune --version strings in one mode are refused too", () => {
    const vs = [
      row({ task: "a", run: 1, arm: "rune" }, { version: "1.3.0" }),
      row({ task: "a", run: 2, arm: "rune" }, { version: "1.3.1" }),
    ];
    expect(() => buildReport({ rows: vs, inputs: [], b: B })).toThrow(/mixes 2 Rune versions/);
  });

  test("--allow-mixed-versions reports across them, and says so", () => {
    const r = buildReport({ rows, inputs, b: B, allowMixedVersions: true });
    expect(r.mixedVersions.length).toBe(1);
    expect(r.reasons.some((x) => x.includes("allowed by --allow-mixed-versions"))).toBe(true);
    expect(r.versions.product.rune!.map((v) => v.binarySha256)).toEqual([RUNE_SHA, RUNE_SHA_2]);
  });

  test("the same binary in both modes is not mixing", () => {
    const both = [
      row({ task: "a", run: 1, arm: "rune" }),
      row({ task: "a", run: 1, arm: "rune", mode: "harness" }),
    ];
    expect(() => buildReport({ rows: both, inputs: [], b: B })).not.toThrow();
  });
});

describe("the CLI", () => {
  test("arguments", () => {
    expect(parseArgs(["--results", "a", "b", "--out", "o"])).toEqual({
      results: ["a", "b"],
      out: "o",
      comparator: "claude-code",
      seed: DEFAULT_SEED,
      allowMixedVersions: false,
      allowMixedConfig: false,
      allowUnfingerprinted: false,
    });
    expect(
      parseArgs([
        "--results",
        "a",
        "--out",
        "o",
        "--allow-mixed-config",
        "--allow-unfingerprinted",
        "--allow-mixed-versions",
      ]),
    ).toMatchObject({
      allowMixedVersions: true,
      allowMixedConfig: true,
      allowUnfingerprinted: true,
    });
    expect(parseArgs(["--results", "a", "--out", "o", "--comparator", "codex"])).toHaveProperty(
      "error",
    );
    expect(parseArgs(["--results", "a", "--out", "o", "--seed", "-1"])).toHaveProperty("error");
    expect(parseArgs(["--out", "o"])).toHaveProperty("error");
  });

  test("writes the JSON and the Markdown, then refuses to overwrite either", () => {
    const out = join(scratch, "cli");
    const q = quiet();
    expect(main(["--results", GOLDEN_FILE, "--out", out, "--seed", "5"], q.io)).toBe(0);
    const json = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as ParityReport;
    expect(json.kind).toBe("parity-report");
    expect(json.seed).toBe(5);
    expect(json.bootstrap.b).toBe(2000);
    expect(readFileSync(join(out, REPORT_MD), "utf8")).toContain("# Parity Index");
    const before = readFileSync(join(out, REPORT_JSON), "utf8");

    const again = quiet();
    expect(main(["--results", GOLDEN_FILE, "--out", out], again.io)).toBe(1);
    expect(again.err.join("\n")).toMatch(/refusing to overwrite/);
    expect(readFileSync(join(out, REPORT_JSON), "utf8")).toBe(before);
  });

  test("one existing output file is enough to write nothing", () => {
    const out = join(scratch, "half");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, REPORT_MD), "mine\n");
    expect(main(["--results", GOLDEN_FILE, "--out", out], quiet().io)).toBe(1);
    expect(existsSync(join(out, REPORT_JSON))).toBe(false);
    expect(readFileSync(join(out, REPORT_MD), "utf8")).toBe("mine\n");
  });

  test("refused inputs write nothing and exit 1", () => {
    const out = join(scratch, "refused");
    const q = quiet();
    expect(main(["--results", MIXED_FILE, "--out", out], q.io)).toBe(1);
    expect(q.err.join("\n")).toMatch(/mixes 2 Rune binaries/);
    expect(existsSync(join(out, REPORT_JSON))).toBe(false);
    expect(main(["--results", INVALID_FILE, "--out", out], quiet().io)).toBe(1);
    expect(main(["--out", out], quiet().io)).toBe(2);
  });

  test("runs as a script", () => {
    const out = join(scratch, "script");
    const script = join(import.meta.dir, "../../eval/parity/report.ts");
    const proc = Bun.spawnSync([process.execPath, script, "--results", GOLDEN_FILE, "--out", out], {
      env: process.env,
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toMatch(/^parity: (PASS|PROVISIONAL|FAIL)/);
    expect(existsSync(join(out, REPORT_JSON))).toBe(true);
  });
});
