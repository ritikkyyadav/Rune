/**
 * The verifier, asked about trees whose answer is already known.
 *
 * Batch A changed what the end-of-turn verifier says — a deadline is no longer
 * a failure, a co-located project can be left out, a pre-existing failure is
 * named as one. Each of those is a way to say "not failed", so the question
 * this file asks is the one that matters about any of them: **is a correct fix
 * ever called failed, and is a known regression ever called a pass?**
 *
 * The answers come from the mined corpus (`tasks/*.json`), where they are not
 * opinions: each task is a real commit of this repository whose own tests were
 * seen to FAIL at its parent and PASS at the fix, twice each, by the corpus's
 * runner. For a small fixed sample of those, this builds the trees and runs
 * the product's `CommandVerifier` over six situations:
 *
 *   reference-fix        the fix commit                            → passed
 *   base-plus-tests      the parent, with the fix's tests added    → failed
 *   known-regression     the fix, then its source put back         → failed, new
 *   inherited-failure    already red when the "run" starts; the
 *                        run then edits something unrelated        → failed, pre-existing
 *   missing-runner       the fix, with no test runner on PATH      → inconclusive
 *   forced-timeout       the fix, with a 1 ms deadline             → inconclusive
 *
 * plus one more that is reported rather than asserted, because what it shows
 * is a known limit: the fix with its dependencies removed.
 *
 * `inconclusive` is counted on its own line. It is never added to "correct" —
 * a verifier that answered "inconclusive" to everything would otherwise score
 * perfectly.
 *
 * Nothing here calls a model, installs a package or touches the repository it
 * runs from: trees are `git archive`d into a temp directory, and dependencies
 * are a copy-on-write clone of the ones already installed (the sample is
 * limited to commits whose lockfile is byte-identical to HEAD's).
 *
 *   bun tests/eval/serious/verifier-oracle.ts [--out <file.json>] [--task <id>]…
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { classify as classifyRepair } from "../../../packages/orchestrator/src/repair";
import {
  CommandVerifier,
  verifyOutcome,
  type VerifyResult,
} from "../../../packages/orchestrator/src/verifier";
import { PRELOAD } from "./grade";
import { loadSpecs, repoRootOf, type SeriousTaskSpec } from "./source";

/** Fixed, not sampled: fast unit suites across four packages, lockfile equal to HEAD's. */
export const SAMPLE = [
  "f7-7d1d42a-todo-write-cleanup",
  "f7-08d9beb-windows-path-candidates",
  "f7-653698d-toml-config",
  "f7-865950a-fixed-overhead-first-last",
  "f7-5553813-tilde-user-home",
];

type Expected = "passed" | "failed" | "inconclusive" | "reported";

export interface OracleRow {
  task: string;
  situation: string;
  expected: Expected;
  status: string;
  reason?: string;
  /** For a failure: how many failing tests were pre-existing, and how many new. */
  existing?: number;
  introduced?: number;
  /** For a failure with no attribution: why. */
  attribution?: string;
  /** What the loop's repair classifier calls this failure. */
  repairClass?: string;
  /** Whether the loop would buy a repair turn for it, with `[controller] authority` empty. */
  repairTurn: boolean;
  /** Checks that ran to completion, of the checks selected. */
  coverage: string;
  wallMs: number;
  /** `ok` — the expected answer; `wrong` — a false failure or a false pass. */
  verdict: "ok" | "wrong" | "inconclusive" | "reported";
  note?: string;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "oracle",
  GIT_AUTHOR_EMAIL: "oracle@example.invalid",
  GIT_COMMITTER_NAME: "oracle",
  GIT_COMMITTER_EMAIL: "oracle@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The installed dependency directories, relative to the repository root. */
function dependencyDirs(repoRoot: string): string[] {
  return git(
    repoRoot,
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  )
    .split("\0")
    .filter(
      (p) => /(?:^|\/)node_modules\/$/.test(p) && !p.split("/").some((s) => s.startsWith(".")),
    )
    .map((p) => p.replace(/\/$/, ""));
}

function clone(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const argv =
    process.platform === "darwin"
      ? ["cp", "-cR", src, dst]
      : ["cp", "-a", "--reflink=auto", src, dst];
  const res = spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore" });
  if (res.status !== 0) throw new Error(`could not clone ${src}`);
}

/** `rev`'s tree in a fresh directory, with dependencies, as a one-commit repository. */
function buildTree(
  repoRoot: string,
  rev: string,
  deps: string[],
  holder: string,
  name: string,
): string {
  const tree = join(holder, name);
  mkdirSync(tree, { recursive: true });
  const tar = join(holder, `${name}.tar`);
  git(repoRoot, "archive", "--format=tar", "-o", tar, rev);
  execFileSync("tar", ["-xf", tar, "-C", tree]);
  rmSync(tar);
  for (const dir of deps) clone(join(repoRoot, dir), join(tree, dir));
  git(tree, "init", "-q");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", `oracle: ${rev.slice(0, 7)}`);
  return tree;
}

/** The check the corpus graded this task with: its own tests, through bun. */
function checkCommand(tree: string, spec: SeriousTaskSpec): string {
  const preload = existsSync(join(tree, PRELOAD)) ? ` --preload ./${PRELOAD}` : "";
  return `bun test${preload} ${spec.testFiles.map((f) => `./${f}`).join(" ")}`;
}

/** Every file `rev` has at `paths`, written into `tree`. */
function overlay(repoRoot: string, rev: string, paths: string[], tree: string): void {
  for (const path of paths) {
    const exists =
      spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${rev}:${path}`]).status === 0;
    if (!exists) {
      rmSync(join(tree, path), { force: true });
      continue;
    }
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(
      join(tree, path),
      execFileSync("git", ["-C", repoRoot, "show", `${rev}:${path}`], {
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  }
}

function row(
  task: string,
  situation: string,
  expected: Expected,
  result: VerifyResult,
  wallMs: number,
  note?: string,
): OracleRow {
  const outcome = verifyOutcome(result);
  const runs = result.runs ?? [];
  const completed = runs.filter((r) => !r.skipped && !r.timedOut && !r.cancelled).length;
  const selected = result.selection?.commands.length ?? runs.length;
  const a = result.attribution;
  const worst = runs.find((r) => !r.passed);
  const repairClass =
    outcome.status === "failed"
      ? (classifyRepair({
          kind: "check_run",
          command: worst?.command ?? "",
          exitCode: worst?.exitCode ?? 1,
          output: result.report,
        })?.cls ?? "none")
      : undefined;
  // What the loop does with `[controller] authority` empty: a failure buys a
  // repair turn unless every failing test predates the run.
  const inherited = a?.known === true && a.introduced.length === 0 && a.existing.length > 0;
  const repairTurn = outcome.status === "failed" && !inherited;
  const verdict: OracleRow["verdict"] =
    expected === "reported"
      ? "reported"
      : outcome.status === "inconclusive"
        ? expected === "inconclusive"
          ? "ok"
          : "inconclusive"
        : outcome.status === expected
          ? "ok"
          : "wrong";
  return {
    task,
    situation,
    expected,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(a?.known ? { existing: a.existing.length, introduced: a.introduced.length } : {}),
    ...(a && !a.known ? { attribution: a.why } : {}),
    ...(repairClass ? { repairClass } : {}),
    repairTurn,
    coverage: `${completed}/${selected}`,
    wallMs: Math.round(wallMs),
    verdict,
    ...(note ? { note } : {}),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const value = await fn();
  return [value, performance.now() - t];
}

export async function runTask(
  repoRoot: string,
  spec: SeriousTaskSpec,
  deps: string[],
): Promise<OracleRow[]> {
  const holder = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "verifier-oracle-"));
  const rows: OracleRow[] = [];
  try {
    const fixed = buildTree(repoRoot, spec.sha, deps, holder, "fixed");
    const base = buildTree(repoRoot, spec.parent, deps, holder, "base");
    // The trees were written a moment ago. The verifier treats an environment
    // file whose inode changed after the run began — give or take a coarse
    // file system's clock — as an environment the run changed, so a tree built
    // inside that margin would have every baseline refused. In use, the
    // environment predates the run by far more than this.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const command = checkCommand(fixed, spec);
    const verifier = (tree: string, timeoutMs?: number) =>
      new CommandVerifier({
        workspaceRoot: tree,
        commands: [command],
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    const f2p = spec.f2p.length;

    // 1. The fix itself. A correct fix must never be called failed.
    {
      const v = verifier(fixed);
      v.beginChanges();
      const [r, ms] = await timed(() => v.verify());
      rows.push(row(spec.id, "reference-fix", "passed", r, ms));
    }

    // 2. The parent with the fix's tests and no fix: the corpus saw these fail.
    overlay(repoRoot, spec.sha, spec.testFiles, base);
    {
      const v = verifier(base);
      const [r, ms] = await timed(() => v.verify());
      rows.push(
        row(spec.id, "base-plus-tests", "failed", r, ms, `${f2p} fail-to-pass in the corpus`),
      );
    }

    // 3. Already red when the run starts; the run then edits something else.
    //    The failures are inherited, and no repair turn should be bought.
    git(base, "add", "-A");
    git(base, "commit", "-q", "-m", "oracle: the tests, with no fix");
    {
      const v = verifier(base);
      v.beginChanges();
      writeFileSync(
        join(base, "ORACLE-NOTE.md"),
        "an edit that has nothing to do with the tests\n",
      );
      const [r, ms] = await timed(() => v.verify());
      rows.push(row(spec.id, "inherited-failure", "failed", r, ms));
    }

    // 4. The fix, then its source put back to the parent's: the run broke it.
    {
      const v = verifier(fixed);
      v.beginChanges();
      overlay(repoRoot, spec.parent, spec.fixFiles, fixed);
      const [r, ms] = await timed(() => v.verify());
      rows.push(row(spec.id, "known-regression", "failed", r, ms));
      git(fixed, "checkout", "-q", "--", ".");
      git(fixed, "clean", "-fdq");
    }

    // 5. No test runner on PATH. Nothing was measured.
    {
      const path = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const [r, ms] = await timed(() => verifier(fixed).verify());
        rows.push(row(spec.id, "missing-runner", "inconclusive", r, ms));
      } finally {
        process.env.PATH = path;
      }
    }

    // 6. A deadline the check cannot meet.
    {
      const [r, ms] = await timed(() => verifier(fixed, 1).verify());
      rows.push(row(spec.id, "forced-timeout", "inconclusive", r, ms));
    }

    // 7. The fix with its dependencies gone. Reported, not asserted: a module
    //    that will not resolve is a `failed` check at the verifier — it cannot
    //    tell an uninstalled dependency from an import the run got wrong — and
    //    the repair classifier is where the two are told apart.
    {
      const stash = join(holder, "deps-aside");
      mkdirSync(stash);
      const moved: Array<[string, string]> = [];
      try {
        deps.forEach((dir, i) => {
          if (!existsSync(join(fixed, dir))) return;
          const aside = join(stash, String(i));
          renameSync(join(fixed, dir), aside);
          moved.push([join(fixed, dir), aside]);
        });
        const [r, ms] = await timed(() => verifier(fixed).verify());
        rows.push(
          row(
            spec.id,
            "missing-dependencies",
            "reported",
            r,
            ms,
            "a correct fix; nothing installed",
          ),
        );
      } finally {
        for (const [home, aside] of moved) renameSync(aside, home);
      }
    }
    return rows;
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
}

export function summarise(rows: OracleRow[]) {
  const asserted = rows.filter((r) => r.expected !== "reported");
  const of = (situation: string) => rows.filter((r) => r.situation === situation);
  return {
    asserted: asserted.length,
    ok: asserted.filter((r) => r.verdict === "ok").length,
    // The two errors that matter, named for what they are.
    correctFixCalledFailed: of("reference-fix").filter((r) => r.status === "failed").length,
    regressionCalledPassed: rows.filter((r) => r.expected === "failed" && r.status === "passed")
      .length,
    // Counted apart: an answer of "inconclusive" where a verdict was expected.
    inconclusiveWhereAVerdictWasExpected: asserted.filter((r) => r.verdict === "inconclusive")
      .length,
    inheritedFailuresThatBoughtARepairTurn: of("inherited-failure").filter((r) => r.repairTurn)
      .length,
    regressionsThatBoughtNoRepairTurn: of("known-regression").filter((r) => !r.repairTurn).length,
    wallMs: {
      total: rows.reduce((n, r) => n + r.wallMs, 0),
      median:
        [...rows].map((r) => r.wallMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0,
      // What attribution costs: a failing verification with and without it.
      attributedFailureMedian:
        rows
          .filter((r) => r.existing !== undefined)
          .map((r) => r.wallMs)
          .sort((a, b) => a - b)[
          Math.floor(rows.filter((r) => r.existing !== undefined).length / 2)
        ] ?? null,
      plainFailureMedian:
        of("base-plus-tests")
          .map((r) => r.wallMs)
          .sort((a, b) => a - b)[Math.floor(of("base-plus-tests").length / 2)] ?? null,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  const only = args.flatMap((a, i) => (a === "--task" && args[i + 1] ? [args[i + 1]!] : []));
  const repoRoot = repoRootOf();
  const headLock = git(repoRoot, "rev-parse", "HEAD:bun.lock").trim();
  const deps = dependencyDirs(repoRoot);
  const specs = loadSpecs().filter((s) => (only.length ? only : SAMPLE).includes(s.id));
  const rows: OracleRow[] = [];
  for (const spec of specs) {
    for (const rev of [spec.sha, spec.parent]) {
      if (git(repoRoot, "rev-parse", `${rev}:bun.lock`).trim() !== headLock) {
        throw new Error(
          `${spec.id}: ${rev.slice(0, 7)} has a different lockfile; installed deps do not apply`,
        );
      }
    }
    process.stderr.write(`${spec.id}\n`);
    for (const r of await runTask(repoRoot, spec, deps)) {
      rows.push(r);
      const detail =
        r.existing !== undefined
          ? ` existing=${r.existing} new=${r.introduced}`
          : r.attribution
            ? ` (unattributed: ${r.attribution})`
            : "";
      process.stderr.write(
        `  ${r.verdict.padEnd(12)} ${r.situation.padEnd(22)} → ${r.status}${r.reason ? `(${r.reason})` : ""}` +
          `${detail}${r.repairClass ? ` class=${r.repairClass}` : ""} repair=${r.repairTurn ? "yes" : "no"}` +
          ` cover=${r.coverage} ${r.wallMs}ms\n`,
      );
    }
  }
  const report = {
    schema: "rune-verifier-oracle@1",
    at: new Date().toISOString(),
    head: git(repoRoot, "rev-parse", "HEAD").trim(),
    dirty: git(repoRoot, "status", "--porcelain").trim().length > 0,
    bun: Bun.version,
    platform: `${process.platform}/${process.arch}`,
    modelCalls: 0,
    sample: specs.map((s) => s.id),
    summary: summarise(rows),
    rows,
  };
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`written: ${out}\n`);
  }
  const s = report.summary;
  process.exit(s.correctFixCalledFailed + s.regressionCalledPassed > 0 ? 1 : 0);
}
