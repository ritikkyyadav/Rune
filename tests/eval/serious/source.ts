/**
 * The serious family (F7) as parity tasks: real fixes mined from this repo's
 * history, one `tasks/<sha>.json` per task. See README.md here and
 * docs/program/serious-corpus.md.
 *
 * `prepare` seeds the workspace with the fix commit's PARENT tree. The tree comes
 * from `git archive`, so it carries no history in which to find the fix. It has
 * `.rune/config.toml` removed (that file configures one of the arms only), is
 * committed as "base", and is installed with `bun install --frozen-lockfile`.
 *
 * `grade` copies the fix commit's hidden test files over whatever the arm left,
 * runs them with the runner the miner used (grade.ts), and typechecks the
 * packages the fix touched. It reads the tree only and never looks at anything
 * the arm said about its work.
 *
 * Nothing here calls a model.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Outcome, ParityTask } from "../parity/types";
import {
  fileOfKey,
  heldPackages,
  outcomeOf,
  runHiddenTests,
  scrubbedEnv,
  spawnCapture,
  tail,
  typecheck,
  type GradeSpec,
  type TestResults,
} from "./grade";

export const TASKS_DIR = join(import.meta.dir, "tasks");

export type Shape = "fix" | "feature" | "refactor";

/** One `tasks/<sha>.json`. */
export interface SeriousTaskSpec extends GradeSpec {
  id: string;
  /** The fix commit, and its first parent: the tree the arm starts from. */
  sha: string;
  parent: string;
  subject: string;
  /** The workspace packages whose `src/` the fix changed (`orchestrator`, `shared`, …). */
  packages: string[];
  shape: Shape;
  family: "F7";
  /** Sent to every arm verbatim. */
  prompt: string;
  /** Symbols the hidden tests call that do not exist at the parent (`Class#method`). */
  interface?: string[];
  timeLimit: "serious";
  /** Files copied from the fix commit over the tree at grading time. */
  hiddenFiles: string[];
  /** The `.test.ts` files among them: the ones that are run. */
  testFiles: string[];
  /** The fix itself (every `packages/**` path the commit changed). Never shown to an arm. */
  fixFiles: string[];
  /** Checks whose two runs disagreed at mining time: excluded everywhere, listed for the record. */
  flaky?: string[];
  mined: {
    at: string;
    bun: string;
    baseWallMs: number[];
    fixedWallMs: number[];
  };
}

/** Project config files an arm must not inherit from the parent tree (one per name the project had). */
export const STRIPPED_CONFIG = [".rune/config.toml", ".gear/config.toml", ".alan/config.toml"];

const GIT_IDENTITY = [
  "-c",
  "user.name=Serious Base",
  "-c",
  "user.email=base@serious.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "init.defaultBranch=main",
];

function git(cwd: string, args: string[], input?: string): string {
  const run = spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
    env: scrubbedEnv(),
  });
  if (run.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(run.stderr || "").trim()}`);
  return run.stdout;
}

/** The repository this file belongs to: where the fix commits are. */
export function repoRootOf(dir: string = import.meta.dir): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).trim();
}

export class BaseTreeError extends Error {
  constructor(
    readonly stage: "archive" | "install",
    message: string,
  ) {
    super(message);
  }
}

export interface BaseTree {
  /** Config files removed from the parent's tree. */
  stripped: string[];
  installMs: number;
  installLog: string;
}

/**
 * Build `rev`'s tree in `dest` with no history: archive, extract, strip the
 * project config, `git init` and commit it as "base", then install.
 */
export async function buildBaseTree(
  repoRoot: string,
  rev: string,
  dest: string,
  options: { install?: boolean; installTimeoutMs?: number } = {},
): Promise<BaseTree> {
  mkdirSync(dest, { recursive: true });
  if (readdirSync(dest).length > 0)
    throw new BaseTreeError(
      "archive",
      `${dest} is not empty: a base tree needs an empty directory`,
    );
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "serious-archive-"));
  try {
    const tar = join(scratch, "base.tar");
    const archive = spawnSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tar, rev], {
      encoding: "utf8",
    });
    if (archive.status !== 0)
      throw new BaseTreeError("archive", `git archive ${rev}: ${(archive.stderr || "").trim()}`);
    const extract = spawnSync("tar", ["-xf", tar, "-C", dest], { encoding: "utf8" });
    if (extract.status !== 0)
      throw new BaseTreeError("archive", `tar: ${(extract.stderr || "").trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stripped = STRIPPED_CONFIG.filter((path) => existsSync(join(dest, path)));
  for (const path of stripped) rmSync(join(dest, path));
  git(dest, ["init", "-q"]);
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "--no-verify", "-m", "base"]);
  if (options.install === false) return { stripped, installMs: 0, installLog: "" };
  const install = await spawnCapture("bun", ["install", "--frozen-lockfile"], {
    cwd: dest,
    timeoutMs: options.installTimeoutMs ?? 600_000,
  });
  if (install.exitCode !== 0 || install.timedOut)
    throw new BaseTreeError(
      "install",
      `bun install --frozen-lockfile: ${tail(install.output, 30)}`,
    );
  return { stripped, installMs: install.wallMs, installLog: tail(install.output, 20) };
}

/**
 * Make `paths` in `tree` what they are at `rev`: written byte for byte, or
 * removed when `rev` does not have them. Used for the hidden-test overlay (from
 * the fix commit), for applying the reference fix, and for taking it back out.
 */
export function writeRevisionFiles(
  repoRoot: string,
  rev: string,
  paths: string[],
  tree: string,
): void {
  for (const path of paths) {
    const target = join(tree, path);
    const show = spawnSync("git", ["-C", repoRoot, "show", `${rev}:${path}`], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (show.status === 0) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, show.stdout);
      continue;
    }
    const exists = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${rev}:${path}`]);
    if (exists.status === 0)
      throw new Error(`git show ${rev}:${path} failed: ${show.stderr.toString().trim()}`);
    rmSync(target, { force: true });
  }
}

// ── Task files ──

export function loadSpecs(dir: string = TASKS_DIR): SeriousTaskSpec[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SeriousTaskSpec);
}

export const INTERFACE_HEADING = "Interface the fix must provide";

/** Everything structurally wrong with a task file. Empty = well formed. */
export function specProblems(spec: SeriousTaskSpec): string[] {
  const problems: string[] = [];
  const need = (ok: unknown, what: string) => {
    if (!ok) problems.push(what);
  };
  need(/^[0-9a-f]{40}$/.test(spec.sha ?? ""), "sha is a full commit id");
  need(/^[0-9a-f]{40}$/.test(spec.parent ?? ""), "parent is a full commit id");
  need(typeof spec.id === "string" && spec.id.startsWith("f7-"), "id starts with f7-");
  need(spec.family === "F7", 'family is "F7"');
  need(spec.timeLimit === "serious", 'timeLimit is "serious"');
  need(["fix", "feature", "refactor"].includes(spec.shape), "shape is fix | feature | refactor");
  need(typeof spec.prompt === "string" && spec.prompt.trim().length >= 80, "prompt is written");
  need(Array.isArray(spec.f2p) && spec.f2p.length >= 1, "at least one fail-to-pass check");
  need(Array.isArray(spec.p2p), "p2p is a list");
  need(Array.isArray(spec.impossible), "impossible is a list");
  need(Array.isArray(spec.packages) && spec.packages.length >= 1, "packages named");
  need(Array.isArray(spec.testFiles) && spec.testFiles.length >= 1, "test files named");
  const lists = [spec.f2p ?? [], spec.p2p ?? [], spec.impossible ?? [], spec.flaky ?? []];
  const seen = new Set<string>();
  for (const key of lists.flat()) {
    need(!seen.has(key), `check listed twice: ${key}`);
    seen.add(key);
    need(spec.testFiles?.includes(fileOfKey(key)), `check outside the test files: ${key}`);
  }
  for (const file of spec.testFiles ?? [])
    need(spec.hiddenFiles?.includes(file), `test file not hidden: ${file}`);
  for (const pkg of spec.typecheckPackages ?? [])
    need(typeof spec.typecheckBaseClean?.[pkg] === "boolean", `base typecheck recorded: ${pkg}`);
  const hasSection = spec.prompt?.includes(INTERFACE_HEADING) ?? false;
  const hasInterface = (spec.interface?.length ?? 0) > 0;
  need(
    hasSection === hasInterface,
    hasInterface
      ? `the prompt has an "${INTERFACE_HEADING}" section for its interface`
      : `the prompt has no "${INTERFACE_HEADING}" section without an interface`,
  );
  return problems;
}

// ── Grading ──

export interface Graded {
  outcome: Outcome;
  results: TestResults;
  typecheck: Record<string, boolean>;
  wallMs: number;
}

/** Overlay the hidden tests on `tree`, run them, typecheck, and score. */
export async function gradeTree(
  spec: SeriousTaskSpec,
  repoRoot: string,
  tree: string,
  evidenceDir?: string,
): Promise<Graded> {
  const started = Date.now();
  writeRevisionFiles(repoRoot, spec.sha, spec.hiddenFiles, tree);
  const run = await runHiddenTests(tree, spec.testFiles, { evidenceDir, label: "grade" });
  const typecheckNow: Record<string, boolean> = {};
  for (const pkg of heldPackages(spec)) typecheckNow[pkg] = (await typecheck(tree, pkg)).clean;
  const outcome = outcomeOf(spec, run.results, typecheckNow);
  const graded = {
    outcome,
    results: run.results,
    typecheck: typecheckNow,
    wallMs: Date.now() - started,
  };
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const status = (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, run.results[key] ?? "absent"]));
    writeFileSync(
      join(evidenceDir, "grade.json"),
      JSON.stringify(
        {
          task: spec.id,
          outcome,
          f2p: status(spec.f2p),
          p2p: status(spec.p2p),
          typecheck: typecheckNow,
          reportMissing: run.reportMissing,
          timedOut: run.timedOut,
          wallMs: graded.wallMs,
        },
        null,
        2,
      ),
    );
  }
  return graded;
}

/**
 * What grades a mined task, as one digest: the fix commit its hidden tests are
 * copied from, which files those are, and every check's pinned role — to pass,
 * to stay passing, impossible here, flaky — with the typecheck it is held to.
 * The files' bytes are the commit's, so its id stands for them.
 */
export function seriousGraderSha256(spec: SeriousTaskSpec): string {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  const held = (clean: Record<string, boolean> | undefined) =>
    Object.entries(clean ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(
      JSON.stringify({
        sha: spec.sha,
        hiddenFiles: sorted(spec.hiddenFiles),
        testFiles: sorted(spec.testFiles),
        f2p: sorted(spec.f2p),
        p2p: sorted(spec.p2p),
        impossible: sorted(spec.impossible),
        flaky: sorted(spec.flaky),
        typecheckPackages: sorted(spec.typecheckPackages),
        typecheckBaseClean: held(spec.typecheckBaseClean),
        typecheckFixedClean: held(spec.typecheckFixedClean),
      }),
    )
    .digest("hex");
}

/** One mined task as a ParityTask. */
export function seriousTask(
  spec: SeriousTaskSpec,
  options: { repoRoot?: string } = {},
): ParityTask {
  const repoRoot = options.repoRoot ?? repoRootOf();
  return {
    id: spec.id,
    family: "F7",
    prompt: spec.prompt,
    size: "serious",
    grader: seriousGraderSha256(spec),
    async prepare(workspace: string) {
      await buildBaseTree(repoRoot, spec.parent, workspace);
    },
    async grade(workspace: string, evidenceDir: string) {
      return (await gradeTree(spec, repoRoot, workspace, evidenceDir)).outcome;
    },
  };
}

/** Every task in `tasks/`, in id order. */
export function seriousTasks(options: { repoRoot?: string; dir?: string } = {}): ParityTask[] {
  const repoRoot = options.repoRoot ?? repoRootOf();
  return loadSpecs(options.dir)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((spec) => seriousTask(spec, { repoRoot }));
}
