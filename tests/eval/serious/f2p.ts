/**
 * Fail-to-pass validation of one mined candidate.
 *
 * The candidate's parent tree is built as an arm would get it (source.ts), and
 * the fix commit's hidden test files are copied over it. The tests run twice at
 * the parent. Then the fix commit's `packages/**` changes are applied and the
 * tests run twice more. From those four runs:
 *
 *   fail-to-pass  failing at the parent in both runs, passing with the fix in both
 *   pass-to-pass  passing at the parent and with the fix, in all four runs
 *   impossible    failing (or not running) even with the fix, in both of its runs.
 *                 A sandbox that forbids what the test needs lands here; so does a
 *                 test that needs a change outside `packages/`.
 *   flaky         two runs of the same tree disagree: excluded from everything
 *   skipped       skipped with the fix: no check at all
 *
 * A candidate is kept when it has at least one fail-to-pass check and each run of
 * the fixed tree finishes in under 120 s. For a kept candidate, the packages the
 * fix touched are typechecked with the fix and at the parent. The grader holds
 * an arm only to the typechecks that were clean in both.
 *
 * Nothing here calls a model.
 */

import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { runHiddenTests, typecheck, type TestResults, type TestRun } from "./grade";
import type { Candidate } from "./mine";
import { BaseTreeError, buildBaseTree, writeRevisionFiles } from "./source";

export const FIXED_RUN_LIMIT_MS = 120_000;

export interface Classification {
  f2p: string[];
  p2p: string[];
  impossible: string[];
  flaky: string[];
  skipped: string[];
}

/**
 * Sort every test seen in any run into exactly one class. A test missing from a
 * run did not pass in it. `base` and `fixed` hold the repetitions of each tree.
 */
export function classify(base: TestResults[], fixed: TestResults[]): Classification {
  const out: Classification = { f2p: [], p2p: [], impossible: [], flaky: [], skipped: [] };
  const keys = new Set<string>();
  for (const run of [...base, ...fixed]) for (const key of Object.keys(run)) keys.add(key);
  for (const key of [...keys].sort()) {
    const atBase = base.map((run) => run[key] === "pass");
    const withFix = fixed.map((run) => run[key] === "pass");
    if (fixed.length > 0 && fixed.every((run) => run[key] === "skip")) {
      out.skipped.push(key);
      continue;
    }
    const agrees = (runs: boolean[]) => runs.every((passed) => passed === runs[0]);
    if (!agrees(atBase) || !agrees(withFix)) {
      out.flaky.push(key);
      continue;
    }
    if (!withFix[0]) out.impossible.push(key);
    else if (atBase[0]) out.p2p.push(key);
    else out.f2p.push(key);
  }
  return out;
}

export type Rejection =
  "base-tree-failed" | "install-failed" | "already-passing" | "no-f2p" | "slow" | "error";

export type Verdict = { keep: true } | { keep: false; reason: Rejection; detail: string };

/** Keep = at least one fail-to-pass check and every fixed-tree run under the limit. */
export function keepVerdict(
  classification: Classification,
  fixedRuns: Pick<TestRun, "wallMs" | "timedOut">[],
  limitMs = FIXED_RUN_LIMIT_MS,
): Verdict {
  const slowest = Math.max(0, ...fixedRuns.map((run) => run.wallMs));
  if (fixedRuns.some((run) => run.timedOut) || slowest >= limitMs)
    return { keep: false, reason: "slow", detail: `fixed-tree run took ${slowest} ms` };
  const { f2p, p2p, impossible, flaky } = classification;
  if (f2p.length === 0)
    return {
      keep: false,
      reason: "no-f2p",
      detail: `p2p ${p2p.length}, impossible ${impossible.length}, flaky ${flaky.length}`,
    };
  return { keep: true };
}

/** Where a run stood, without its per-test results (those live in the classification). */
export interface RunSummary {
  label: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  reportMissing: boolean;
  tests: number;
  passed: number;
}

export interface ValidationResult {
  sha: string;
  parent: string;
  subject: string;
  date: string;
  packages: string[];
  srcFiles: string[];
  fixFiles: string[];
  hiddenFiles: string[];
  testFiles: string[];
  keep: boolean;
  reason?: Rejection;
  detail?: string;
  classification?: Classification;
  runs: RunSummary[];
  typecheck?: Record<string, { base: boolean; fixed: boolean; baseMs: number; fixedMs: number }>;
  stripped?: string[];
  installMs?: number;
  wallMs: number;
  bun: string;
}

function summary(label: string, run: TestRun): RunSummary {
  const statuses = Object.values(run.results);
  return {
    label,
    wallMs: run.wallMs,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    reportMissing: run.reportMissing,
    tests: statuses.length,
    passed: statuses.filter((status) => status === "pass").length,
  };
}

/** Every test in a run reported, and every one passed or was skipped. */
function allPassing(run: TestRun): boolean {
  return (
    run.exitCode === 0 &&
    !run.reportMissing &&
    Object.values(run.results).length > 0 &&
    Object.values(run.results).every((status) => status !== "fail")
  );
}

/**
 * Build, run, classify, typecheck. `workDir` gets the tree (removed afterwards
 * unless `keepTree`) and the runs' reports and logs.
 */
export async function validateCandidate(
  repoRoot: string,
  candidate: Candidate,
  workDir: string,
  options: { keepTree?: boolean; log?: (line: string) => void } = {},
): Promise<ValidationResult> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const tree = join(workDir, "tree");
  const evidence = join(workDir, "runs");
  mkdirSync(evidence, { recursive: true });
  const result: ValidationResult = {
    sha: candidate.sha,
    parent: candidate.parent,
    subject: candidate.subject,
    date: candidate.date,
    packages: candidate.packages,
    srcFiles: candidate.srcFiles,
    fixFiles: candidate.fixFiles,
    hiddenFiles: candidate.hiddenFiles,
    testFiles: candidate.testFiles,
    keep: false,
    runs: [],
    wallMs: 0,
    bun: Bun.version,
  };
  const reject = (reason: Rejection, detail: string) => {
    result.reason = reason;
    result.detail = detail;
    return result;
  };
  try {
    try {
      const base = await buildBaseTree(repoRoot, candidate.parent, tree);
      result.stripped = base.stripped;
      result.installMs = base.installMs;
    } catch (error) {
      const stage = error instanceof BaseTreeError ? error.stage : "archive";
      return reject(stage === "install" ? "install-failed" : "base-tree-failed", String(error));
    }
    writeRevisionFiles(repoRoot, candidate.sha, candidate.hiddenFiles, tree);
    const run = async (label: string) => {
      const out = await runHiddenTests(tree, candidate.testFiles, { evidenceDir: evidence, label });
      const row = summary(label, out);
      result.runs.push(row);
      log(`${candidate.sha.slice(0, 7)} ${label}: ${row.passed}/${row.tests} in ${out.wallMs} ms`);
      return out;
    };
    const base1 = await run("base-1");
    // Nothing fails at the parent: no fix can turn anything from red to green.
    if (allPassing(base1))
      return reject("already-passing", "every hidden test passes at the parent");
    const base2 = await run("base-2");
    writeRevisionFiles(repoRoot, candidate.sha, candidate.fixFiles, tree);
    const fixed1 = await run("fixed-1");
    const stillPossible = Object.entries(fixed1.results).some(
      ([key, status]) =>
        status === "pass" && base1.results[key] !== "pass" && base2.results[key] !== "pass",
    );
    const fixedRuns = [fixed1];
    const fixed = [fixed1.results];
    if (stillPossible) {
      const fixed2 = await run("fixed-2");
      fixedRuns.push(fixed2);
      fixed.push(fixed2.results);
    }
    result.classification = classify([base1.results, base2.results], fixed);
    // Without a second fixed run the classification has no fail-to-pass check
    // (none passed in the first), so the verdict is a rejection either way.
    const verdict = keepVerdict(result.classification, fixedRuns);
    if (!verdict.keep) return reject(verdict.reason, verdict.detail);

    result.typecheck = {};
    const fixedCheck: Record<string, { clean: boolean; wallMs: number }> = {};
    for (const pkg of candidate.packages)
      fixedCheck[pkg] = await typecheck(tree, `packages/${pkg}`);
    writeRevisionFiles(repoRoot, candidate.parent, candidate.fixFiles, tree);
    for (const pkg of candidate.packages) {
      const atBase = await typecheck(tree, `packages/${pkg}`);
      result.typecheck[`packages/${pkg}`] = {
        base: atBase.clean,
        fixed: fixedCheck[pkg]!.clean,
        baseMs: atBase.wallMs,
        fixedMs: fixedCheck[pkg]!.wallMs,
      };
    }
    result.keep = true;
    return result;
  } catch (error) {
    return reject("error", error instanceof Error ? `${error.message}` : String(error));
  } finally {
    result.wallMs = Date.now() - started;
    writeFileSync(join(workDir, "result.json"), JSON.stringify(result, null, 2));
    if (!options.keepTree) rmSync(tree, { recursive: true, force: true });
  }
}
