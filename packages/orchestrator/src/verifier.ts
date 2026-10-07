// ─── Verification ───
//
// Turns "the agent stopped" into "the agent's work actually checks out" by
// running the project's own checks (typecheck / tests / cargo check / go build)
// after the agent claims it's done, and feeding any failure back so it can
// self-correct.
//
// Design notes:
//  - If we cannot detect any check for a workspace, verification is
//    INCONCLUSIVE (`no_checks`). We never fail a task just because we couldn't
//    figure out how to verify it — and we never call it verified either.
//  - A check that did not finish (its deadline, a cancelled run) is
//    inconclusive too. Only a check that RAN TO COMPLETION and went red is a
//    failure, because only that says anything about the code.
//  - Commands run scoped to the workspace, with a hard timeout, capturing both
//    stdout and stderr so the report is useful to the model.
//  - Detection reads REAL signals — go.mod, Cargo.toml, pyproject.toml,
//    build.gradle, pom.xml, package.json workspaces, turbo/nx config — and
//    never emits a command that would install anything.
//  - A missing toolchain is "cannot check", not "check failed". `go build` on
//    a machine without Go exits 127; treating that as a verification failure
//    would fail every Go task on every machine that has no Go, which is the
//    opposite of what a verifier is for. Such a command is recorded as SKIPPED
//    with its reason; a real non-zero exit still fails.
//
// P10.4 — before this, detection covered JS/TS with a Rust and Go afterthought
// and scanned one directory. A Go, Python, Rust or Java repository, and any
// monorepo whose real project sits one level down, verified as `ran: false` —
// so the plan ledger could never close a step on a real check.

import { execFile, execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "fs";
import { lstat, rm, rmdir, unlink } from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import type { VerificationInconclusiveReason, VerificationStatus } from "@rune/protocol";
import {
  baselineIsCurrent,
  captureBaseline,
  changedSinceBaseline,
  materialiseBaseline,
  type TaskBaseline,
} from "./baseline";
import { envFingerprint } from "./brief";
import {
  attributable,
  attributeFailures,
  parseBunTestRun,
  testLabel,
  type ParsedTestRun,
} from "./check-failures";
import { isHarnessOwnedPath } from "./lifecycle";
import { ownersOf, selectProjects, type ProjectDecision, type ScopeFacts } from "./verify-scope";

/** The stacks detection knows how to verify. `jvm` covers Java and Kotlin. */
export type Ecosystem = "js" | "go" | "python" | "rust" | "jvm";

export const ECOSYSTEMS: readonly Ecosystem[] = ["js", "go", "python", "rust", "jvm"];

/**
 * Config aliases. `[verify.ecosystems.java]` and `.kotlin` both address the JVM
 * ecosystem — they share gradle and maven, so they share one detector, but
 * nobody writing config should have to know that.
 */
const ECOSYSTEM_ALIASES: Record<string, Ecosystem> = {
  js: "js",
  javascript: "js",
  ts: "js",
  typescript: "js",
  node: "js",
  go: "go",
  golang: "go",
  python: "python",
  py: "python",
  rust: "rust",
  cargo: "rust",
  jvm: "jvm",
  java: "jvm",
  kotlin: "jvm",
  gradle: "jvm",
  maven: "jvm",
};

export function resolveEcosystem(name: string): Ecosystem | null {
  return ECOSYSTEM_ALIASES[name.trim().toLowerCase()] ?? null;
}

/**
 * What a check is for. The order below is the order checks run in: the
 * cheapest failing signal first, functional failures before style.
 */
export type CheckKind = "typecheck" | "build" | "test" | "lint";

const KIND_ORDER: Record<CheckKind, number> = { typecheck: 0, build: 1, test: 2, lint: 3 };

/** Compile-class kinds: fast, deterministic, and enough to know it still builds. */
const FAST_KINDS = new Set<CheckKind>(["typecheck", "build"]);

export interface DetectedCheck {
  ecosystem: Ecosystem;
  kind: CheckKind;
  /** Project directory relative to the workspace root; "" for the root. */
  project: string;
  /** The command as run FROM the workspace root (cd-prefixed when nested). */
  command: string;
}

export interface DetectedProject {
  ecosystem: Ecosystem;
  /** Relative directory; "" for the workspace root. */
  dir: string;
  /** The file that identified it — go.mod, Cargo.toml, pom.xml, … */
  marker: string;
  checks: DetectedCheck[];
}

/** One command the verifier actually attempted, and what came of it. */
export interface CheckRunRecord {
  command: string;
  ecosystem?: Ecosystem;
  kind?: CheckKind;
  /** null when the command never ran (toolchain absent). */
  exitCode: number | null;
  durationMs: number;
  passed: boolean;
  /** Set when the command was not run at all; the value is why. */
  skipped?: string;
  /** The command was killed at its deadline. It measured nothing. */
  timedOut?: boolean;
  /** The run was cancelled while this command was executing. It measured nothing. */
  cancelled?: boolean;
}

/**
 * What a verification established.
 *
 *   passed        every check that could run here ran, and none went red
 *   failed        a check ran to completion and went red — a real negative
 *   inconclusive  no verdict was reached; `reason` says why
 *
 * Two booleans used to carry this, and they have four cells for what are three
 * outcomes: a check killed at its deadline landed on `(ran, !passed)`, the cell
 * a real assertion failure lives in, so the loop bought a repair turn for a
 * clock; and a verification cancelled between two checks fell through to
 * `(ran, passed)` — green, for work nobody finished measuring.
 *
 * The wire's own type (`verification_completed.status`), so the verifier and
 * every surface that renders its result cannot grow different vocabularies.
 */
export type VerifyStatus = VerificationStatus;

/**
 * Why nothing was established. None of these is a failure of the work, and
 * none of them is a receipt for it either.
 *
 *   timeout         a check was killed at its deadline
 *   cancelled       the run was aborted before or during the checks
 *   missing_runner  every selected check's toolchain is absent on this machine
 *   no_checks       nothing runnable was detected for what the run wrote
 *   not_required    a decision: only documentation changed, and no check reads it
 */
export type InconclusiveReason = VerificationInconclusiveReason;

export interface VerifyOutcome {
  status: VerifyStatus;
  /** Set exactly when `status` is `inconclusive`. */
  reason?: InconclusiveReason;
}

export interface VerifyResult {
  /**
   * The outcome, and the only field that says what happened. Absent only on a
   * result from an embedder's own pre-tri-state `Verifier`; `verifyOutcome`
   * reads either shape and is what every consumer goes through.
   */
  status?: VerifyStatus;
  /** Set exactly when `status` is `inconclusive`. */
  reason?: InconclusiveReason;
  /**
   * @deprecated Read `verifyOutcome(result).status`. On a result this file
   * built, this is `status === "passed"` and nothing else — it is never true
   * for a verification that reached no verdict.
   */
  passed: boolean;
  /**
   * @deprecated Read `verifyOutcome(result).status`. On a result this file
   * built, this is `status !== "inconclusive"`: a verdict was reached.
   */
  ran: boolean;
  /** Human-readable report (command + trimmed output) to feed back to the agent. */
  report: string;
  /**
   * Per-command record: what ran, its exit code, how long it took. The evidence
   * ledger reads this instead of scraping the report, which it used to do with
   * a regex over `$ ` lines.
   */
  runs?: CheckRunRecord[];
  /** Which checks were chosen for this verification, and why. */
  selection?: CheckSelection;
  /**
   * For a `failed` result: whether the failing tests were already failing on
   * the tree the run started from. Absent when nothing failed.
   */
  attribution?: FailureAttribution;
  /**
   * Git-ignored paths these checks generated in the workspace, removed again
   * once they had run. Absent when there were none.
   *
   * Beside the result and never in the report, for the reason `selection` is:
   * the report's last line is shown as a failure's own words.
   */
  removed?: string[];
}

/**
 * Whose failures these are.
 *
 * `known` only when every failing thing is a named test and the same check
 * could be run, faithfully, on the tree the run started from. Each test is
 * then either `existing` — the same test, in an unchanged file, failing with
 * the same assertion there — or `introduced`. `existing` is never a pass: the
 * check is red and the result says so. It is only not this run's doing.
 *
 * Anything short of that is `known: false` with the reason, and a caller
 * treats the failure exactly as it always did.
 */
export type FailureAttribution =
  { known: true; existing: string[]; introduced: string[] } | { known: false; why: string };

/**
 * How a verification's check set was chosen.
 *
 * Kept beside the result rather than in the report: the report's first and
 * last lines are read as the failure's own words, and a note about what was
 * NOT run is not one of them.
 */
export interface CheckSelection {
  /**
   * `override`  the user's `[verify] commands`, never narrowed
   * `workspace` no usable file list, so every detected project
   * `touched`   the projects the run's changes select
   * `impacted`  the commands a repair turn was about
   */
  scope: "override" | "workspace" | "touched" | "impacted";
  /** The commands selected, in the order they run. */
  commands: string[];
  /** One entry per project that owns a changed file — selected or left out. */
  decisions: ProjectDecision[];
}

/**
 * The outcome of a verification, whichever shape produced it.
 *
 * A result from `CommandVerifier` carries its `status` and that is returned as
 * it stands. A result without one — an embedder's verifier written against the
 * two-boolean contract — is read the way that contract always meant it, with
 * one correction: a run the verifier marked `timedOut` did not fail.
 */
export function verifyOutcome(
  result: Pick<VerifyResult, "status" | "reason" | "passed" | "ran" | "runs">,
): VerifyOutcome {
  if (result.status === "passed" || result.status === "failed") return { status: result.status };
  if (result.status === "inconclusive") {
    return { status: "inconclusive", reason: result.reason ?? "no_checks" };
  }
  if (!result.ran) return { status: "inconclusive", reason: "no_checks" };
  if (result.passed) return { status: "passed" };
  const undone = (result.runs ?? []).find((r) => r.timedOut || r.cancelled);
  if (undone) return { status: "inconclusive", reason: undone.cancelled ? "cancelled" : "timeout" };
  return { status: "failed" };
}

/** A run that finished: it was started, and it was neither killed nor skipped. */
export function runCompleted(run: CheckRunRecord): boolean {
  return !run.skipped && !run.timedOut && !run.cancelled;
}

/**
 * Build a result. The one place the legacy pair is written, so it cannot
 * disagree with the status it is derived from.
 */
function settle(outcome: VerifyOutcome, runs: CheckRunRecord[], report: string): VerifyResult {
  return {
    status: outcome.status,
    ...(outcome.status === "inconclusive" ? { reason: outcome.reason ?? "no_checks" } : {}),
    passed: outcome.status === "passed",
    ran: outcome.status !== "inconclusive",
    runs,
    report,
  };
}

export interface Verifier {
  /**
   * The full check set, run when the model finishes a turn that edited files.
   *
   * `touched` is what the run actually wrote. In a workspace that holds
   * several projects it selects the ones to grade, for the same reason
   * `verifyFast` does: a run that built one folder must not be failed by a
   * sibling it never opened. Measured (session 01a067b8): a static site built
   * in `bangla-sweets/` was graded against every sibling under the workspace
   * root, so the run was told "verification failed" by a Python test needing
   * pandas, a gradle build with no JDK, and a socket-binding test the sandbox
   * denies — then spent roughly fifty completions and eight minutes trying to
   * fix code it had never touched. Omitted or unmatched, the whole workspace
   * is graded exactly as before.
   */
  verify(signal?: AbortSignal, touched?: string[], only?: string[]): Promise<VerifyResult>;
  /**
   * The cheap tier only — compile-class checks (typecheck, cargo check, go
   * build), never the test suite. Run at a STEP boundary rather than at the
   * end of the run, so a step that broke the build is caught while it is
   * still the step being worked on. Optional: verifiers without a cheap tier
   * simply have no step check.
   *
   * `touched` is the files the step wrote. In a workspace with several
   * projects it selects the one to check — a step that edited `api/main.go`
   * gets `go build`, not every project in the tree.
   */
  verifyFast?(signal?: AbortSignal, touched?: string[]): Promise<VerifyResult>;
  /**
   * The run is about to make its first change: the workspace as it stands now
   * is what "before the task" will mean. Called once per run, before the first
   * tool call that can write. A verifier that keeps no baseline ignores it.
   */
  beginChanges?(): void;
  /**
   * Workspace-relative paths that differ from where this run began — whoever
   * changed them and however: a file tool, a shell command, a deletion. `null`
   * when that cannot be said. Read by the loop to hold a run to a boundary the
   * request set.
   */
  changedThisRun?(): string[] | null;
  /**
   * The tree this run started from, uncommitted work included, for a replay of
   * a check on it (parent-check.ts). Null when none was taken.
   */
  baselineForReplay?(): TaskBaseline | null;
}

/**
 * Compile-class commands: fast, deterministic, and enough to know the tree
 * still builds. Kept as a string predicate because callers (the worker tool)
 * hold plain command lists with no provenance.
 */
const FAST_CHECK_RE =
  /\b(typecheck|tsc|cargo\s+check|go\s+build|javac|py_compile|compileall|pyright|mypy|gradlew?\s+(--\S+\s+)*classes|mvnw?\s+(-\S+\s+)*compile)\b/;

/** The step-check subset of a command list: compile-class checks only. */
export function fastCheckCommands(commands: string[]): string[] {
  return commands.filter((c) => FAST_CHECK_RE.test(c));
}

// ─── Config ───

/** `[verify.ecosystems.<name>]` — a bare boolean, or a table with an override. */
export type EcosystemSetting = boolean | { enabled?: boolean; commands?: string[] };

export interface DetectOptions {
  /** Per-ecosystem enable/disable and command overrides. */
  ecosystems?: Record<string, EcosystemSetting>;
  /** How far below the workspace root to look for projects. Default 3. */
  maxDepth?: number;
}

function settingFor(
  opts: DetectOptions | undefined,
  eco: Ecosystem,
): { enabled: boolean; commands?: string[] } {
  const raw = opts?.ecosystems;
  if (!raw) return { enabled: true };
  let hit: EcosystemSetting | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (resolveEcosystem(key) === eco) hit = value;
  }
  if (hit === undefined) return { enabled: true };
  if (typeof hit === "boolean") return { enabled: hit };
  return {
    enabled: hit.enabled !== false,
    commands: hit.commands && hit.commands.length > 0 ? hit.commands : undefined,
  };
}

export interface CommandVerifierConfig {
  workspaceRoot: string;
  /** Explicit override commands. When set and non-empty, detection is skipped. */
  commands?: string[];
  /** Per-command timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Per-ecosystem enable/disable and command overrides (`[verify.ecosystems]`). */
  ecosystems?: Record<string, EcosystemSetting>;
  /**
   * Leave what the checks generate in the workspace (`[verify] keepGenerated`).
   * Default false: git-ignored paths a pass of detected checks created are
   * removed when it ends — see `removeGenerated`. What a command in `commands`
   * builds is always left.
   */
  keepGenerated?: boolean;
  /**
   * When this session began, in epoch ms. A file the working tree shows as
   * changed but whose inode has not changed since then was dirty before the
   * session started and is not this run's doing. Defaults to construction.
   */
  sessionStartMs?: number;
  /**
   * Called once per command the verifier actually ran, with the exit code IT
   * read. Wired by the Engine to the same CheckLog the `bash` tool feeds.
   *
   * Without this there were two verification systems that never spoke: the
   * end-of-turn verifier ran the project's checks through its own spawner,
   * while the evidence ledger only ever saw checks the MODEL chose to run.
   * A criterion therefore could not cite the very checks the harness ran on
   * its behalf. Both now write to one log, so a rung can be derived from
   * either source.
   */
  onCheck?: (run: {
    command: string;
    passed: boolean;
    summary?: string;
    exitCode?: number;
    durationMs?: number;
  }) => void;
}

// ─── Shared filesystem helpers ───

// Directories a detection walk must never descend into.
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".mvn",
  ".tox",
  "Pods",
]);

function dirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !WALK_SKIP.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Bounded recursive scan for files matching `pattern`. The old detection was a
 * NON-recursive readdir of the workspace root — a repo with tests in `tests/`
 * or `src/**` read as having none, so "run the tests" verification silently
 * never fired on most real projects.
 */
function walkHas(root: string, pattern: RegExp, maxDepth = 4, budget = { n: 2000 }): boolean {
  if (maxDepth < 0 || budget.n <= 0) return false;
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (budget.n-- <= 0) return false;
    if (e.isFile() && pattern.test(e.name)) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !WALK_SKIP.has(e.name) && !e.name.startsWith(".")) {
      if (walkHas(join(root, e.name), pattern, maxDepth - 1, budget)) return true;
    }
  }
  return false;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ─── JS / TypeScript ───

type Pm = "bun" | "pnpm" | "yarn" | "npm";

function detectPm(workspaceRoot: string): Pm {
  const has = (f: string) => existsSync(join(workspaceRoot, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

/** The "run a package binary" form for each package manager (for tsc, etc.). */
function pmx(pm: Pm): string {
  switch (pm) {
    case "bun":
      return "bunx";
    case "pnpm":
      return "pnpm dlx";
    case "yarn":
      return "yarn dlx";
    default:
      return "npx";
  }
}

const JS_TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function readScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function isJsMonorepoRoot(dir: string): boolean {
  if (existsSync(join(dir, "turbo.json")) || existsSync(join(dir, "nx.json"))) return true;
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    return pkg.workspaces != null;
  } catch {
    return false;
  }
}

/**
 * The command that runs the project's DECLARED `test` script.
 *
 * For npm, pnpm and yarn, `<pm> test` is the script runner. For Bun it is not:
 * `bun test` is Bun's own test runner, which collects every test file under
 * the directory and never reads `scripts.test`. A project whose script was
 * `bun test unit` was graded on suites it had deliberately left out, and the
 * run was then told its change had failed them.
 */
function testScriptCommand(pm: Pm): string {
  return pm === "bun" ? "bun run test" : `${pm} test`;
}

/** Checks for one JS/TS project directory (root or a nested app). */
function jsChecks(dir: string, isMonorepoRoot: boolean): Array<[CheckKind, string]> {
  const out: Array<[CheckKind, string]> = [];
  const has = (f: string) => existsSync(join(dir, f));
  const pm = detectPm(dir);
  const scripts = readScripts(dir);

  // 1. Typecheck (fast, deterministic).
  if (scripts.typecheck) out.push(["typecheck", `${pm} run typecheck`]);
  else if (has("tsconfig.json")) out.push(["typecheck", `${pmx(pm)} tsc --noEmit`]);

  // 2. Tests. In a monorepo, ONLY trust root scripts (they fan out properly);
  // running `bun test` over the whole tree would double-run packages.
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    out.push(["test", testScriptCommand(pm)]);
  } else if (!scripts.test && !isMonorepoRoot && walkHas(dir, JS_TEST_FILE)) {
    // Scriptless project with raw test files — Rune runs on Bun, which can
    // execute bun:test files directly.
    out.push(["test", "bun test"]);
  }

  // 3. Lint, when the project declares it (last: functional failures first).
  if (scripts.lint) out.push(["lint", `${pm} run lint`]);

  // 4. Build as a compile-at-least fallback when nothing else was detected.
  if (out.length === 0 && scripts.build) out.push(["build", `${pm} run build`]);

  return out;
}

// ─── Go ───

function goChecks(dir: string): Array<[CheckKind, string]> {
  const out: Array<[CheckKind, string]> = [
    ["build", "go build ./..."],
    // `go vet` reports suspicious constructs — Go's lint-shaped tool, so it
    // runs after the functional checks, like every other lint here.
    ["lint", "go vet ./..."],
  ];
  if (walkHas(dir, /_test\.go$/)) out.push(["test", "go test ./..."]);
  return out;
}

// ─── Rust ───

function rustChecks(dir: string): Array<[CheckKind, string]> {
  const out: Array<[CheckKind, string]> = [
    ["typecheck", "cargo check --quiet"],
    ["test", "cargo test --quiet"],
  ];
  const manifest = readText(join(dir, "Cargo.toml"));
  const clippyConfigured =
    existsSync(join(dir, "clippy.toml")) ||
    existsSync(join(dir, ".clippy.toml")) ||
    /\[(workspace\.)?lints\.clippy\]/.test(manifest);
  if (clippyConfigured) out.push(["lint", "cargo clippy --quiet"]);
  return out;
}

// ─── Python ───

const PY_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "tox.ini",
];

/**
 * How to reach the project's own interpreter. A virtualenv or `uv` is the
 * difference between running the project's pytest and running whatever happens
 * to be on PATH — and installing nothing either way.
 */
function pythonRunner(dir: string): { uv: boolean; python: string; binDir: string | null } {
  const pyproject = readText(join(dir, "pyproject.toml"));
  if (existsSync(join(dir, "uv.lock")) || /\[tool\.uv\]/.test(pyproject)) {
    return { uv: true, python: "uv run python", binDir: null };
  }
  for (const venv of [".venv", "venv"]) {
    const bin = join(dir, venv, "bin");
    if (existsSync(join(bin, "python"))) {
      return { uv: false, python: `${venv}/bin/python`, binDir: bin };
    }
  }
  return { uv: false, python: "python3", binDir: null };
}

function pythonChecks(dir: string): Array<[CheckKind, string]> {
  const out: Array<[CheckKind, string]> = [];
  const run = pythonRunner(dir);
  const pyproject = readText(join(dir, "pyproject.toml"));
  const setupCfg = readText(join(dir, "setup.cfg"));
  const toxIni = readText(join(dir, "tox.ini"));
  const requirements = readText(join(dir, "requirements.txt"));
  const has = (f: string) => existsSync(join(dir, f));

  /** The project's own entry point for a tool, without installing it. */
  const tool = (name: string, args: string): string => {
    if (run.binDir && existsSync(join(run.binDir, name))) {
      const venv = run.python.startsWith(".venv") ? ".venv" : "venv";
      return `${venv}/bin/${name} ${args}`.trim();
    }
    if (run.uv) return `uv run ${name} ${args}`.trim();
    return `${run.python} -m ${name} ${args}`.trim();
  };

  // Typecheck — pyright first (it is the one Rune's own LSP layer speaks),
  // mypy when that is what the project configured. Never both.
  const pyrightConfigured = has("pyrightconfig.json") || /\[tool\.pyright\]/.test(pyproject);
  const mypyConfigured =
    has("mypy.ini") ||
    has(".mypy.ini") ||
    /\[tool\.mypy\]/.test(pyproject) ||
    /\[mypy\]/.test(setupCfg);
  if (pyrightConfigured) {
    out.push(["typecheck", run.uv ? "uv run pyright" : tool("pyright", "").trim()]);
  } else if (mypyConfigured) {
    out.push(["typecheck", tool("mypy", ".")]);
  }

  // Tests — pytest when the project configured it, stdlib unittest otherwise.
  // `python -m unittest` is always available; pytest is not, and guessing it
  // would be guessing an install.
  const pytestConfigured =
    has("pytest.ini") ||
    has("conftest.py") ||
    /\[tool\.pytest\.ini_options\]/.test(pyproject) ||
    /\[tool:pytest\]/.test(setupCfg) ||
    /\[pytest\]/.test(toxIni) ||
    /(^|\n)\s*pytest\b/i.test(requirements) ||
    /["']pytest[<>=~!\s"']/.test(pyproject);
  const hasTests = walkHas(dir, /^(test_.*|.*_test)\.py$/, 3);
  if (pytestConfigured) out.push(["test", tool("pytest", "-q")]);
  else if (hasTests) out.push(["test", `${run.python} -m unittest discover -q`]);

  // Lint — ruff, when configured.
  const ruffConfigured =
    has("ruff.toml") ||
    has(".ruff.toml") ||
    /\[tool\.ruff/.test(pyproject) ||
    /(^|\n)\s*ruff\b/i.test(requirements);
  if (ruffConfigured) out.push(["lint", tool("ruff", "check .")]);

  return out;
}

// ─── JVM (Java + Kotlin) ───

const JVM_MARKERS = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pom.xml",
];

function jvmChecks(dir: string): Array<[CheckKind, string]> {
  const out: Array<[CheckKind, string]> = [];
  const has = (f: string) => existsSync(join(dir, f));
  const gradleBuild =
    has("build.gradle") ||
    has("build.gradle.kts") ||
    has("settings.gradle") ||
    has("settings.gradle.kts");

  if (has("gradlew") && gradleBuild) {
    // `classes` compiles the main source sets for both the java and the
    // kotlin-jvm plugins, so one task covers both languages.
    out.push(["build", "./gradlew --quiet classes"]);
    out.push(["test", "./gradlew --quiet test"]);
  } else if (has("mvnw") && has("pom.xml")) {
    out.push(["build", "./mvnw -q -B compile"]);
    out.push(["test", "./mvnw -q -B test"]);
  } else if (gradleBuild) {
    out.push(["build", "gradle --quiet classes"]);
    out.push(["test", "gradle --quiet test"]);
  } else if (has("pom.xml")) {
    out.push(["build", "mvn -q -B compile"]);
    out.push(["test", "mvn -q -B test"]);
  } else {
    // Java sources with no build tool at all: javac into a throwaway
    // directory is the whole check. Nothing is installed and nothing is kept.
    out.push([
      "build",
      `javac -d "$(mktemp -d)" $(find . -name '*.java' -not -path '*/build/*' -not -path '*/out/*')`,
    ]);
  }
  return out;
}

// ─── Project discovery ───

interface Marker {
  ecosystem: Ecosystem;
  /** The file that identifies a project of this ecosystem, if present in `dir`. */
  find: (dir: string) => string | null;
  checks: (dir: string, isRoot: boolean) => Array<[CheckKind, string]>;
}

const first = (dir: string, names: string[]): string | null =>
  names.find((n) => existsSync(join(dir, n))) ?? null;

/** Files directly in `dir` (no recursion) matching `pattern`. */
function hasDirectFile(dir: string, pattern: RegExp): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isFile() && pattern.test(e.name),
    );
  } catch {
    return false;
  }
}

const ALL_MARKER_FILES = [
  "package.json",
  "tsconfig.json",
  "go.mod",
  "Cargo.toml",
  ...PY_MARKERS,
  ...JVM_MARKERS,
];

const JVM_SOURCE = /\.(java|kt)$/;

/**
 * A bare Java/Kotlin tree — sources and no build file — is still a project. The
 * claim is deliberately narrow: sources directly in the directory or under a
 * conventional `src/`, and no other ecosystem's marker in the same directory.
 * Without that guard a JS repo carrying one `.kt` fixture would be "a Java
 * project" and every step check would shell out to javac.
 */
function bareJvmTree(dir: string): boolean {
  if (first(dir, ALL_MARKER_FILES)) return false;
  if (hasDirectFile(dir, JVM_SOURCE)) return true;
  const src = join(dir, "src");
  return existsSync(src) && walkHas(src, JVM_SOURCE, 3);
}

const MARKERS: Marker[] = [
  {
    ecosystem: "js",
    find: (d) =>
      first(d, ["package.json", "tsconfig.json"]) ??
      // No manifest, raw `*.test.ts` files: Rune runs on Bun and can execute
      // them directly. This is the greenfield "wrote tests, never wrote a
      // package.json" shape.
      (walkHas(d, JS_TEST_FILE, 3) ? "*.test.ts" : null),
    checks: (d) => jsChecks(d, isJsMonorepoRoot(d)),
  },
  { ecosystem: "go", find: (d) => first(d, ["go.mod"]), checks: (d) => goChecks(d) },
  { ecosystem: "rust", find: (d) => first(d, ["Cargo.toml"]), checks: (d) => rustChecks(d) },
  { ecosystem: "python", find: (d) => first(d, PY_MARKERS), checks: (d) => pythonChecks(d) },
  {
    ecosystem: "jvm",
    find: (d) => first(d, JVM_MARKERS) ?? (bareJvmTree(d) ? "*.java" : null),
    checks: (d) => jvmChecks(d),
  },
];

const DEFAULT_MAX_DEPTH = 3;

/**
 * Every project under `workspaceRoot`, with the check set for each.
 *
 * The walk is bounded (depth 3 by default) and skips node_modules, target,
 * vendor, .git and friends. A marker claims its subtree: a `go.mod` at the root
 * means `go build ./...` covers the module, so nested Go directories are not
 * separate projects; the same for a cargo workspace, a gradle root project and
 * a JS monorepo root.
 */
export function detectProjects(workspaceRoot: string, opts?: DetectOptions): DetectedProject[] {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const found: DetectedProject[] = [];
  /** Ecosystems whose subtree has already been claimed at or above this dir. */
  const walk = (dir: string, rel: string, depth: number, claimed: Set<Ecosystem>): void => {
    const claimedHere = new Set(claimed);
    for (const marker of MARKERS) {
      if (claimedHere.has(marker.ecosystem)) continue;
      const setting = settingFor(opts, marker.ecosystem);
      if (!setting.enabled) {
        claimedHere.add(marker.ecosystem); // disabled: never look again
        continue;
      }
      const hit = marker.find(dir);
      if (!hit) continue;
      const raw: Array<[CheckKind, string]> = setting.commands
        ? setting.commands.map((c) => [classifyCommand(c), c] as [CheckKind, string])
        : marker.checks(dir, rel === "");
      claimedHere.add(marker.ecosystem);
      // A project with NO project-wide check is still a project. A Python
      // package that configured neither pyright nor mypy has nothing to run
      // over the whole tree, and dropping it here is what made the file-scoped
      // `py_compile` step check unreachable — the code existed and had no
      // project to attach to.
      found.push({
        ecosystem: marker.ecosystem,
        dir: rel,
        marker: hit,
        checks: raw.map(([kind, command]) => ({
          ecosystem: marker.ecosystem,
          kind,
          project: rel,
          command: rel === "" ? command : `cd ${rel} && ${command}`,
        })),
      });
    }
    if (depth >= maxDepth) return;
    // Nothing left to look for — stop descending.
    if (ECOSYSTEMS.every((e) => claimedHere.has(e))) return;
    for (const name of dirs(dir)) {
      walk(join(dir, name), rel === "" ? name : `${rel}/${name}`, depth + 1, claimedHere);
    }
  };
  walk(workspaceRoot, "", 0, new Set());
  return found;
}

/** Guess a kind for a hand-written override command, for ordering only. */
export function classifyCommand(command: string): CheckKind {
  if (/\b(lint|clippy|vet|ruff|eslint|fmt)\b/.test(command)) return "lint";
  if (/\b(test|pytest|unittest)\b/.test(command)) return "test";
  if (FAST_CHECK_RE.test(command))
    return /\b(build|javac|classes|compile)\b/.test(command) ? "build" : "typecheck";
  return "build";
}

/** Cheapest-signal-first, stable within a kind. */
function orderChecks(checks: DetectedCheck[]): DetectedCheck[] {
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || a.i - b.i)
    .map((x) => x.c);
}

/** Every detected check, ordered cheapest-signal-first. */
export function detectChecks(workspaceRoot: string, opts?: DetectOptions): DetectedCheck[] {
  return orderChecks(detectProjects(workspaceRoot, opts).flatMap((p) => p.checks));
}

/**
 * Detect sensible verification commands for a workspace.
 *
 * Kept as the string-list entry point for callers that only want commands
 * (the worker tool's per-worktree checks, `[verify] commands` comparison).
 * Returns [] when nothing is detected.
 */
export function detectVerifyCommands(workspaceRoot: string, opts?: DetectOptions): string[] {
  const out: string[] = [];
  for (const c of detectChecks(workspaceRoot, opts)) {
    if (!out.includes(c.command)) out.push(c.command);
  }
  return out;
}

// ─── Command execution ───

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[${s.length - max} more chars]` : s;
}

/**
 * Operating-system stubs: a binary that exists on PATH purely to tell you the
 * toolchain is not installed. macOS ships `/usr/bin/javac` on every machine and
 * it exits 1 with the message below when no JDK is present, so exit 127 alone
 * does not catch it — and a verifier that reported "Java checks FAILED" on a Mac
 * with no JDK would be lying about the code.
 */
const OS_STUB_MESSAGES: Array<{ re: RegExp; reason: string }> = [
  { re: /Unable to locate a Java Runtime/i, reason: "no JDK is installed on this machine" },
  {
    re: /xcrun: error: invalid active developer path|no developer tools were found/i,
    reason: "the Xcode command line tools are not installed on this machine",
  },
];

/**
 * "The toolchain isn't here" as told by a shell. `bash -c` exits 127 and says
 * which name it could not find; we only accept that as a skip when the missing
 * name is the command's own leading binary, so a project script that exits 127
 * for its own reasons still fails.
 */
function missingToolchain(command: string, exitCode: number, output: string): string | null {
  for (const stub of OS_STUB_MESSAGES) {
    if (stub.re.test(output)) return stub.reason;
  }
  if (exitCode !== 127) return null;
  const m = output.match(/(?:^|\n).*?([\w.\-/]+):?\s*(?:command not found|not found)/i);
  const missing = m?.[1];
  if (!missing) return null;
  const head = command.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
  const bin = head.split(/\s+/)[0]?.replace(/^\.\//, "") ?? "";
  const missingBin = missing.replace(/^\.\//, "").split("/").pop() ?? missing;
  const wantBin = bin.split("/").pop() ?? bin;
  if (missingBin !== wantBin) return null;
  return `${wantBin} is not installed on this machine`;
}

/**
 * Check commands still running, by the pid that leads each one's process
 * group. Killed when this process exits, so a run that is stopped mid-check
 * does not leave a test suite running behind it.
 */
const liveCheckGroups = new Set<number>();
let exitReaperInstalled = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Not a group leader here (a platform without process groups), or the
    // group is already gone. The leader-only kill is the best that is left.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  /** Laid over the inherited environment — where generated state goes. */
  extraEnv?: Record<string, string>,
): Promise<{ exitCode: number; output: string; timedOut: boolean; durationMs: number }> {
  const started = Date.now();
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    // A verifier has no interactive user. Inheriting a terminal lets test
    // runners or subprocesses wait for input until the entire check expires.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
    // detached → the shell leads its own process group, so the deadline and a
    // cancelled run stop the WHOLE tree. Killing only the shell orphaned
    // whatever it had started, and the orphan kept the output pipes open: the
    // read below then waited for the suite to finish on its own. Measured:
    // `true && sleep 3` under a 200ms deadline returned after 3011ms — and
    // every nested project's check is that shape (`cd api && go test ./...`),
    // so for those the deadline never bounded anything.
    detached: true,
  });
  liveCheckGroups.add(proc.pid);
  if (!exitReaperInstalled) {
    exitReaperInstalled = true;
    process.on("exit", () => {
      for (const pid of liveCheckGroups) killGroup(pid);
    });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc.pid);
  }, timeoutMs);

  const onAbort = () => killGroup(proc.pid);
  signal?.addEventListener("abort", onAbort, { once: true });
  // Cancelled before the listener was attached: `abort` will not fire again.
  if (signal?.aborted) onAbort();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      exitCode,
      output: `${stdout}${stderr}`.trim(),
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    liveCheckGroups.delete(proc.pid);
  }
}

// ─── Where a check's own generated state goes ───

/** Session caches still on disk, removed when the process exits. */
const liveCaches = new Set<string>();
let cacheSweepInstalled = false;

/** Whether cargo has been told, by a config file, where to build. */
function cargoTargetConfigured(projectDir: string, env: NodeJS.ProcessEnv): boolean {
  const configs: string[] = [];
  for (let dir = projectDir; ; dir = dirname(dir)) {
    configs.push(join(dir, ".cargo", "config.toml"), join(dir, ".cargo", "config"));
    if (dirname(dir) === dir) break;
  }
  const cargoHome = env.CARGO_HOME ?? join(homedir(), ".cargo");
  configs.push(join(cargoHome, "config.toml"), join(cargoHome, "config"));
  return configs.some((path) => /^\s*target-dir\s*=/m.test(readText(path)));
}

/** Whether a `target/` already sits beside this manifest or one above it — a workspace's is at its root. */
function hasCargoTarget(projectDir: string): boolean {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "Cargo.toml")) && existsSync(join(dir, "target"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Environment that keeps a check's generated state out of the project — for a
 * project that has nowhere of its own for it yet.
 *
 * The first `cargo check` in a crate that has never been built creates
 * `target/` in the middle of the task tree; a Python compile leaves
 * `__pycache__` beside every source it touches. Neither is the run's work, and
 * both then show up as changes to it. So when the project has no such
 * directory and the person has not said where it goes, it goes to `cache`.
 *
 * Never against a choice already made: a variable that is set stays as it is,
 * a `target/` that exists is used (it is the person's build cache, and warm),
 * and a `target-dir` in a cargo config is theirs to decide. Only runners with
 * a supported switch are here — gradle and maven have none that covers their
 * build directory, and are left alone.
 */
export function generatedStateEnv(
  projectDir: string,
  ecosystem: Ecosystem,
  env: NodeJS.ProcessEnv,
  cache: () => string,
): Record<string, string> {
  const unset = (name: string): boolean => !env[name];
  const absent = (name: string): boolean => !existsSync(join(projectDir, name));
  const out: Record<string, string> = {};
  if (ecosystem === "rust") {
    if (
      unset("CARGO_TARGET_DIR") &&
      unset("CARGO_BUILD_TARGET_DIR") &&
      !hasCargoTarget(projectDir) &&
      !cargoTargetConfigured(projectDir, env)
    ) {
      out.CARGO_TARGET_DIR = join(cache(), "cargo-target");
    }
  }
  if (ecosystem === "python") {
    if (unset("PYTHONPYCACHEPREFIX")) out.PYTHONPYCACHEPREFIX = join(cache(), "pycache");
    // pytest's own cache has no relocation variable, but it can be switched
    // off, and a check run has no use for `--last-failed`.
    if (unset("PYTEST_ADDOPTS") && absent(".pytest_cache")) {
      out.PYTEST_ADDOPTS = "-p no:cacheprovider";
    }
    if (unset("MYPY_CACHE_DIR") && absent(".mypy_cache")) {
      out.MYPY_CACHE_DIR = join(cache(), "mypy");
    }
    if (unset("RUFF_CACHE_DIR") && absent(".ruff_cache")) {
      out.RUFF_CACHE_DIR = join(cache(), "ruff");
    }
  }
  return out;
}

// ─── What a pass of checks leaves in the tree ───
//
// B1, 2026-10-05. The end-of-turn `bun run typecheck` of a turbo workspace
// builds every package, and left 129 new git-ignored paths — `.turbo/`, a
// `dist/` in each package — in the person's repository. The environment above
// keeps cargo's and Python's generated state out of the tree; a JavaScript
// build has no such switch. So what a pass generated is removed when it ends.
//
// Only this: a path git ignores now, that git listed neither as ignored nor
// as untracked before the pass, and that the file system says was created
// during it. All three, because "newly ignored" is not "new":
//
//   - an ignore rule written during the pass makes a folder that was always
//     there read as newly ignored;
//   - an empty folder that the checks put only ignored files in reads to git
//     as an ignored folder from then on.
//
// Either would be a person's own directory deleted. A new file git does NOT
// ignore is left where it is: that one is a visible change, for the person to
// see. And a path whose name says it is not build output is never taken.

/** Installed dependencies, and what installing leaves: costly to make again, and needed next. */
const KEPT_NAMES = new Set(["node_modules", ".venv", "venv", "vendor", "Pods"]);
/**
 * A person's, or another tool's, wherever git files them: environment files,
 * an editor's project folder, another agent's settings, the Finder's view of
 * a folder. Each can first appear while a check happens to be running.
 */
const KEPT_SHAPES = /^(?:\.env.*|\.idea|\.vscode|\.claude|\.DS_Store|.+\.egg-info)$/;

function keptByName(path: string): boolean {
  if (isHarnessOwnedPath(path)) return true;
  return path.split("/").some((segment) => KEPT_NAMES.has(segment) || KEPT_SHAPES.test(segment));
}

/**
 * Paths under `root` that git does not track — the ignored ones, or the ones
 * it would offer to add. A directory with nothing tracked in it is one entry,
 * with a trailing `/`. `null` when git cannot say: not a repository, or the
 * listing failed.
 *
 * Not the synchronous call: this runs around every pass of checks, and a git
 * that is slow to answer must not hold the terminal still while it does.
 */
function untracked(root: string, which: "ignored" | "unignored"): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        "ls-files",
        "--others",
        ...(which === "ignored" ? ["--ignored"] : []),
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => resolve(error ? null : new Set(stdout.split("\0").filter(Boolean))),
    );
  });
}

/** The git-ignored paths under `root`; `null` outside a repository. */
export function ignoredPaths(root: string): Promise<Set<string> | null> {
  return untracked(root, "ignored");
}

/** What git did not track under a workspace at one moment. */
export interface TreeBefore {
  /** Epoch ms, read before either listing was taken. */
  at: number;
  ignored: Set<string>;
  unignored: Set<string>;
}

/** Taken before a pass of checks. `null` when there is no telling what it will have generated. */
export async function treeBefore(root: string): Promise<TreeBefore | null> {
  const at = Date.now();
  const [ignored, unignored] = await Promise.all([
    untracked(root, "ignored"),
    untracked(root, "unignored"),
  ]);
  return ignored && unignored ? { at, ignored, unignored } : null;
}

/** File systems that keep times to the second, or two, exist. */
const BIRTH_SLACK_MS = 2_000;

/**
 * Remove what was generated under `root` since `before`, and return it — as
 * git names it, sorted, a folder that went whole as one entry. Never throws,
 * and with no `before` removes nothing.
 *
 * A link is unlinked, never followed. A path that will not go is left, and is
 * not in the answer.
 */
export async function removeGenerated(root: string, before: TreeBefore | null): Promise<string[]> {
  if (!before) return [];
  const now = await untracked(root, "ignored");
  if (!now) return [];
  const listed = [...now].sort();

  /** Where `path` is, when it is the pass's to remove; `null` when it is not. */
  const generated = async (path: string): Promise<{ full: string; link: boolean } | null> => {
    if (before.ignored.has(path) || before.unignored.has(path) || keptByName(path)) return null;
    // No trailing slash: with one, a link is followed to what it points at.
    const full = join(root, path.replace(/\/+$/, ""));
    const entry = await lstat(full);
    // On disk before the pass began, whatever git called it then. A file
    // system with no creation times reports zero, which decides nothing.
    if (entry.birthtimeMs > 0 && entry.birthtimeMs < before.at - BIRTH_SLACK_MS) return null;
    return { full, link: entry.isSymbolicLink() };
  };

  const removed: string[] = [];
  // A folder no rule names, listed because all it holds is ignored, has what
  // it holds listed after it. Those are decided one by one — what is kept by
  // name inside it stays — and the folder goes last, if that left it empty.
  const holders: string[] = [];
  for (const [index, path] of listed.entries()) {
    if (path.endsWith("/") && listed[index + 1]?.startsWith(path)) {
      holders.push(path);
      continue;
    }
    try {
      const it = await generated(path);
      if (!it) continue;
      if (it.link) await unlink(it.full);
      else await rm(it.full, { recursive: true });
      removed.push(path);
    } catch {
      // It would not go, or is already gone.
    }
  }
  for (const path of holders.reverse()) {
    try {
      const it = await generated(path);
      if (!it) continue;
      await rmdir(it.full);
      removed.push(path);
    } catch {
      // Not empty: something in it was kept.
    }
  }

  const whole: string[] = [];
  for (const path of removed.sort()) {
    const above = whole[whole.length - 1];
    if (above?.endsWith("/") && path.startsWith(above)) continue;
    whole.push(path);
  }
  return whole;
}

/** What a pass removed, as one line of the run's audit trail. */
export function removedNote(removed: readonly string[]): string {
  const more = removed.length > 6 ? `, and ${removed.length - 6} more` : "";
  return (
    `removed ${removed.length} git-ignored path${removed.length === 1 ? "" : "s"} ` +
    `the checks generated: ${removed.slice(0, 6).join(", ")}${more}`
  );
}

// ─── Per-step compile checks ───

/**
 * Touched files, as workspace-relative POSIX paths.
 *
 * The model names files however it likes — `styles.css`, `./styles.css`,
 * `~/Project/code/shop/styles.css`, `/Users/…/shop/styles.css` — while a
 * `DetectedProject.dir` is always relative to the workspace root. Matching the
 * two without normalising is how scoping silently failed: an absolute path
 * never starts with `shop/`, `projectForFiles` returned nothing, and the
 * caller fell back to checking EVERY project in the tree. Anything outside the
 * workspace is dropped — it belongs to no project here.
 */
export function relativizeTouched(workspaceRoot: string, touched: readonly string[]): string[] {
  const root = resolve(workspaceRoot);
  const out: string[] = [];
  for (const raw of touched) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    let p = raw.replace(/\\/g, "/").trim();
    if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    const rel = insideRoot(root, abs);
    // null is outside the workspace; "" is the root itself. Neither is a file.
    if (rel === null || rel === "") continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** The default file systems of macOS and Windows compare paths case-blind. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function outsideRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/** `abs` as a path under `root`, or null when it is not inside it. */
function insideRoot(root: string, abs: string): string | null {
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!outsideRoot(rel)) return rel;
  // The same folder arrives as `~/Project/Alan` from one source and
  // `~/project/alan` from another (a shell cwd typed in lowercase, a mission
  // file that spells it the other way). On a case-blind file system they are
  // one folder, so the containment test is retried case-blind; the path
  // returned keeps the file's own spelling.
  if (!CASE_INSENSITIVE_FS) return null;
  const folded = relative(root.toLowerCase(), abs.toLowerCase()).replace(/\\/g, "/");
  if (outsideRoot(folded)) return null;
  return folded === "" ? "" : abs.replace(/\\/g, "/").slice(root.length + 1);
}

/**
 * Every project a RUN touched: each file attributed to the innermost project
 * that contains it, unioned.
 *
 * Distinct from `projectForFiles`, which answers a different question — one
 * step's files, one project, deepest wins. Over a whole run the files can
 * legitimately span projects, and taking only the deepest would drop the
 * others; taking every containing project would grade a nested package twice,
 * once through its own manifest and once through the monorepo root above it.
 * Innermost-per-file, unioned, is the only rule that gets both right.
 *
 * "Innermost" is a DIRECTORY, not a project: one directory can host several
 * ecosystems (this repository has `package.json` and `Cargo.toml` side by
 * side at its root, two projects at depth zero), and every project at that
 * depth owns the file. The first version kept one and silently dropped
 * `cargo check` for every Rust edit in a mixed root.
 *
 * An empty result is meaningful, not a failure: the run wrote files that
 * belong to no project here. See `CommandVerifier.checks`.
 */
export function projectsForRun(
  projects: DetectedProject[],
  touched: readonly string[],
): DetectedProject[] {
  const out: DetectedProject[] = [];
  for (const file of touched) {
    for (const p of ownersOf(projects, file)) {
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}

// ─── What a selection has to ask the file system ───

/** Build files that can invoke another ecosystem's toolchain, per ecosystem. */
const BUILD_FILES: Partial<Record<Ecosystem, RegExp>> = {
  rust: /^(?:Cargo\.toml|build\.rs)$/,
  jvm: /^(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml)$/,
};

/**
 * The words by which a build file calls a script toolchain. Bounded on both
 * sides by something that is not a name character, so `tree-sitter-python` (a
 * crate) is not Python and `napi` (a dependency) is JS.
 */
const TOOLCHAIN_WORDS: Partial<Record<Ecosystem, RegExp>> = {
  js: /(?<![\w-])(?:npm|npx|pnpm|yarn|bunx?|node|deno|wasm-bindgen|wasm-pack|napi|neon|tauri|trunk)(?![\w-])/i,
  python: /(?<![\w-])(?:python3?|pip3?|pyo3|maturin|poetry)(?![\w-])/i,
};

/**
 * Where each ecosystem would say that its checks read documentation, and the
 * words it would say it with.
 *
 *   rust    `#![doc = include_str!("../README.md")]` — the README is compiled
 *           and its examples run as doctests
 *   python  a doctest glob, or a docs build, in the test configuration
 *   jvm     a documentation task wired into the build
 *
 * JS is read from `package.json` itself (below), and Go has no entry: an
 * `//go:embed` can pull any file into a test from inside a source file, so a
 * Go project is always taken to read documentation.
 */
const DOC_READERS: Partial<Record<Ecosystem, { files: RegExp; words: RegExp }>> = {
  rust: {
    files: /^(?:lib|main)\.rs$/,
    words: /include_str!\s*\(\s*"[^"]*\.(?:md|markdown|txt|rst)"/,
  },
  python: {
    files:
      /^(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|noxfile\.py|mkdocs\.ya?ml|conf\.py)$/,
    words: /doctest|sphinx|mkdocs/i,
  },
  jvm: {
    files: /^(?:build\.gradle(?:\.kts)?|pom\.xml)$/,
    words: /asciidoctor|dokka|javadoc|markdown/i,
  },
};

/** A script that hands the work to other packages: what THEY run is not visible from here. */
const FANS_OUT =
  /\b(?:turbo|nx|lerna|rush|wsrun)\b|\b(?:pnpm|yarn|npm|bun)\b[^&|;]*(?:-r\b|--recursive|--filter|workspaces?\b)/;
/** Tools that read prose. */
const DOC_TOOLS =
  /\b(?:markdownlint|remark|mdx|doctest|typedoc|docusaurus|vitepress|vale|cspell|textlint|prettier)\b|\.mdx?\b|\bdocs?\b/i;

/**
 * Whether a JS project's own checks read documentation: one of the scripts the
 * verifier runs names a tool that does, or hands the work to packages whose
 * scripts cannot be seen from the root.
 */
function jsReadsDocumentation(dir: string): boolean {
  const scripts = readScripts(dir);
  return ["typecheck", "test", "lint", "build"].some((name) => {
    const text = scripts[name] ?? "";
    return FANS_OUT.test(text) || DOC_TOOLS.test(text);
  });
}

/**
 * Whether any build file under `root` names the toolchain. Bounded like every
 * other walk here: a few levels, the usual skips, a fixed number of files —
 * and when a budget runs out before the answer is known, the answer is "yes",
 * because "could not rule it out" must keep the project, not drop it.
 */
function buildFilesCall(root: string, files: RegExp, words: RegExp): boolean {
  const budget = { dirents: 4000, reads: 64 };
  const walk = (dir: string, depth: number): boolean => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (budget.dirents-- <= 0) return true;
      if (!e.isFile() || !files.test(e.name)) continue;
      if (budget.reads-- <= 0) return true;
      if (words.test(readText(join(dir, e.name)).slice(0, 256_000))) return true;
    }
    if (depth <= 0) return false;
    for (const e of entries) {
      if (e.isDirectory() && !WALK_SKIP.has(e.name) && !e.name.startsWith(".")) {
        if (walk(join(dir, e.name), depth - 1)) return true;
      }
    }
    return false;
  };
  return walk(root, 4);
}

/** File systems that keep times to the second, or two, exist. */
const CLOCK_SLACK_MS = 2_000;

/**
 * Files that decide what a JS check resolves and how it is run. If one of
 * these changed during the run, the environment a baseline would be run in is
 * no longer the one it had, and no comparison is made.
 */
const DEPENDENCY_FILE =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|bunfig\.toml|tsconfig(?:\.[\w.-]+)?\.json|jsconfig\.json|\.npmrc)$/;

const NO_FAILURES: ParsedTestRun = { failing: [], pass: 0, fail: 0, errors: 0 };

/** A directory under both of its names: as given, and as the kernel knows it. */
function bothNames(dir: string): string[] {
  try {
    const real = realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}

/**
 * Workspace-relative paths the working tree shows as changed since `sinceMs`,
 * or `null` when git cannot say (not a repository, no commit yet, no git).
 *
 * "Changed" is the inode's change time, not the content's modification time:
 * `mv` keeps a file's mtime, so a renamed source would read as old. A path
 * that is gone cannot be dated and always counts.
 */
function changedSince(root: string, sinceMs: number): string[] | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch {
      return null;
    }
  };
  // Tracked changes against the commit the work started from, both sides of a
  // rename; then everything untracked that is not ignored.
  const tracked = git(["diff", "--name-only", "-z", "--relative", "--no-renames", "HEAD"]);
  if (tracked === null) return null;
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked === null) return null;
  const out: string[] = [];
  for (const path of `${tracked}${untracked}`.split("\0")) {
    if (!path || isHarnessOwnedPath(path)) continue;
    let changedAt: number | null;
    try {
      const st = statSync(join(root, path));
      changedAt = Math.max(st.mtimeMs, st.ctimeMs);
    } catch {
      changedAt = null;
    }
    if (changedAt === null || changedAt >= sinceMs - CLOCK_SLACK_MS) out.push(path);
  }
  return out;
}

/** Which project a step's files belong to: the deepest project dir containing one. */
export function projectForFiles(projects: DetectedProject[], touched: string[]): DetectedProject[] {
  if (touched.length === 0) return [];
  const norm = touched.map((t) => t.replace(/^\.\//, "").replace(/\\/g, "/"));
  const hits: DetectedProject[] = [];
  for (const p of projects) {
    const prefix = p.dir === "" ? "" : `${p.dir}/`;
    if (norm.some((f) => f.startsWith(prefix))) hits.push(p);
  }
  if (hits.length === 0) return [];
  // Deepest first: a file under `api/` belongs to the `api` project, not to
  // the root one that also contains it.
  const deepest = Math.max(...hits.map((p) => p.dir.split("/").filter(Boolean).length));
  return hits.filter((p) => p.dir.split("/").filter(Boolean).length === deepest);
}

/** Files a per-file compile check applies to, by extension. */
const PY_FILE = /\.py$/;
const JAVA_FILE = /\.java$/;

/**
 * A file-scoped compile check for a project whose ecosystem has no cheap
 * project-wide one. Python without pyright/mypy configured compiles the touched
 * files; a bare Java tree compiles the touched file into a throwaway directory.
 * Returns null when the project already has a compile-class check of its own.
 */
function fileScopedCheck(
  workspaceRoot: string,
  project: DetectedProject,
  touched: string[],
): DetectedCheck | null {
  if (project.checks.some((c) => FAST_KINDS.has(c.kind))) return null;
  const prefix = project.dir === "" ? "" : `${project.dir}/`;
  const inProject = touched
    .map((t) => t.replace(/^\.\//, "").replace(/\\/g, "/"))
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter(Boolean);
  const quote = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  const wrap = (cmd: string) => (project.dir === "" ? cmd : `cd ${project.dir} && ${cmd}`);

  if (project.ecosystem === "python") {
    const files = inProject.filter((f) => PY_FILE.test(f)).slice(0, 20);
    if (files.length === 0) return null;
    const python = pythonRunner(join(workspaceRoot, project.dir)).python;
    return {
      ecosystem: "python",
      kind: "build",
      project: project.dir,
      command: wrap(`${python} -m py_compile ${files.map(quote).join(" ")}`),
    };
  }
  if (project.ecosystem === "jvm") {
    const files = inProject.filter((f) => JAVA_FILE.test(f)).slice(0, 20);
    if (files.length === 0) return null;
    return {
      ecosystem: "jvm",
      kind: "build",
      project: project.dir,
      command: wrap(`javac -d "$(mktemp -d)" ${files.map(quote).join(" ")}`),
    };
  }
  return null;
}

// ─── CommandVerifier ───

export class CommandVerifier implements Verifier {
  private overridden(): string[] | null {
    return this.config.commands && this.config.commands.length > 0 ? this.config.commands : null;
  }

  private detectOptions(): DetectOptions {
    return { ecosystems: this.config.ecosystems };
  }

  private readonly sessionStartMs: number;
  /** The tree this run started from; `null` when none could be taken. */
  private baseline: TaskBaseline | null = null;
  /** What a check reported on a baseline tree, by tree + command + toolchain. */
  private readonly baselineRuns = new Map<string, ParsedTestRun>();
  /** This session's directory for state a check generates; made on first use. */
  private cache: string | null = null;

  private cacheDir(): string {
    if (!this.cache) {
      this.cache = mkdtempSync(join(tmpdir(), "rune-check-cache-"));
      liveCaches.add(this.cache);
      if (!cacheSweepInstalled) {
        cacheSweepInstalled = true;
        process.on("exit", () => {
          for (const dir of liveCaches) rmSync(dir, { recursive: true, force: true });
        });
      }
    }
    return this.cache;
  }

  constructor(private readonly config: CommandVerifierConfig) {
    this.sessionStartMs = config.sessionStartMs ?? Date.now();
  }

  beginChanges(): void {
    try {
      this.baseline = captureBaseline(this.config.workspaceRoot);
    } catch {
      this.baseline = null; // no baseline is an answer; a thrown one is not
    }
  }

  baselineForReplay(): TaskBaseline | null {
    return this.baseline;
  }

  /**
   * Whether the tests failing in `failed` were already failing where the run
   * started. Every way this can fall short returns `known: false` with the
   * reason — the caller then treats the failure as it always has.
   */
  private async attribute(
    failed: { check: DetectedCheck; output: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FailureAttribution> {
    const unknown = (why: string): FailureAttribution => ({ known: false, why });
    const baseline = this.baseline;
    if (!baseline)
      return unknown("no snapshot of the tree was taken before the run's first change");

    const now = parseBunTestRun(failed.output, bothNames(this.config.workspaceRoot));
    if (!now) return unknown("the check's output is not a test report this can read");
    if (!attributable(now) || now.failing.length === 0) {
      return unknown("something failed that the report does not name as a test");
    }

    const current = baselineIsCurrent(baseline);
    if (!current.ok) return unknown(current.why);
    const changed = changedSinceBaseline(baseline);
    if (changed === null) {
      return unknown("the working tree could not be compared with where the run began");
    }
    const dependency = changed.find((p) => DEPENDENCY_FILE.test(p));
    if (dependency) return unknown(`dependencies changed during the run (${dependency})`);

    // The runner names a test file from where it ran; the comparison names it
    // from the repository root.
    const where = [baseline.prefix, failed.check.project].filter(Boolean).join("/");
    const changedHere = new Set(
      where === ""
        ? changed
        : changed.filter((p) => p.startsWith(`${where}/`)).map((p) => p.slice(where.length + 1)),
    );
    const known = (before: ParsedTestRun): FailureAttribution => {
      const { existing, introduced } = attributeFailures(now, before, changedHere);
      return {
        known: true,
        existing: existing.map(testLabel),
        introduced: introduced.map(testLabel),
      };
    };
    // Every failing test sits in a file the run changed: they are the run's,
    // and there is nothing to ask the baseline.
    if (now.failing.every((t) => changedHere.has(t.file))) return known(NO_FAILURES);

    const key = [baseline.tree, failed.check.command, envFingerprint()].join("\0");
    let before = this.baselineRuns.get(key);
    if (!before) {
      const ran = await this.runOnBaseline(baseline, failed.check, timeoutMs, signal);
      if ("unknown" in ran) return unknown(ran.unknown);
      before = ran;
      this.baselineRuns.set(key, before);
    }
    return known(before);
  }

  /** The same command, on the tree the run started from. */
  private async runOnBaseline(
    baseline: TaskBaseline,
    check: DetectedCheck,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ParsedTestRun | { unknown: string }> {
    const laid = await materialiseBaseline(baseline, { signal });
    if ("unavailable" in laid) return { unknown: laid.unavailable };
    try {
      const { exitCode, output, timedOut } = await runCommand(
        check.command,
        laid.cwd,
        timeoutMs,
        signal,
      );
      if (signal?.aborted) return { unknown: "cancelled" };
      if (timedOut) return { unknown: "the check did not finish on the tree the run started from" };
      const parsed = parseBunTestRun(output, bothNames(laid.cwd));
      if (!parsed) {
        return {
          unknown: "the check's output on the starting tree is not a test report this can read",
        };
      }
      // A file that would not load there, a total that does not add up, an
      // exit code that disagrees with the report, or nothing collected at all:
      // the starting tree did not give an answer that can be matched against.
      if (!attributable(parsed)) {
        return { unknown: "something failed on the starting tree that its report does not name" };
      }
      if ((exitCode === 0) !== (parsed.fail === 0)) {
        return { unknown: "the starting tree's exit code and its report disagree" };
      }
      if (parsed.pass + parsed.fail === 0) {
        return { unknown: "the check collected no tests on the starting tree" };
      }
      return parsed;
    } finally {
      laid.dispose();
    }
  }

  /**
   * The two facts a selection needs from disk, for one verification. Fresh
   * each time — a build file the run just edited must be read as it is now —
   * and each answered at most once within it.
   */
  private scopeFacts(): ScopeFacts {
    const root = this.config.workspaceRoot;
    const calls = new Map<string, boolean>();
    let elsewhere: readonly string[] | null | undefined;
    return {
      callsToolchain: (project, toolchain) => {
        const key = `${project.ecosystem}\0${project.dir}\0${toolchain}`;
        let answer = calls.get(key);
        if (answer === undefined) {
          const files = BUILD_FILES[project.ecosystem];
          const words = TOOLCHAIN_WORDS[toolchain];
          // No way to look means no way to rule it out.
          answer = !files || !words ? true : buildFilesCall(join(root, project.dir), files, words);
          calls.set(key, answer);
        }
        return answer;
      },
      readsDocumentation: (project) => {
        const key = `docs\0${project.ecosystem}\0${project.dir}`;
        let answer = calls.get(key);
        if (answer === undefined) {
          const dir = join(root, project.dir);
          const reader = DOC_READERS[project.ecosystem];
          answer =
            project.ecosystem === "js"
              ? jsReadsDocumentation(dir)
              : // No way to look means no way to rule it out.
                !reader || buildFilesCall(dir, reader.files, reader.words);
          calls.set(key, answer);
        }
        return answer;
      },
      changedElsewhere: () => {
        if (elsewhere === undefined) elsewhere = this.changedThisRun();
        return elsewhere;
      },
    };
  }

  /**
   * Workspace-relative paths that changed since this run began — or, with no
   * snapshot of where it began, since this session did.
   *
   * The snapshot is the better answer and is used whenever there is one: it
   * is exact, where the session clock also counts whatever the person or an
   * earlier run in the same session changed.
   */
  changedThisRun(): string[] | null {
    const baseline = this.baseline;
    if (baseline && baselineIsCurrent(baseline).ok) {
      const changed = changedSinceBaseline(baseline);
      if (changed !== null) {
        const prefix = baseline.prefix === "" ? "" : `${baseline.prefix}/`;
        return changed
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length))
          .filter((p) => !isHarnessOwnedPath(p));
      }
    }
    return changedSince(this.config.workspaceRoot, this.sessionStartMs);
  }

  /**
   * Every check for this workspace, as the structured records the ledger wants
   * — narrowed to the project(s) `touched` selects when it names any — and the
   * record of how that set was chosen.
   *
   * An explicit `[verify] commands` override is never narrowed: the user said
   * exactly what to run, and that is what runs.
   */
  private select(touched?: readonly string[]): {
    checks: DetectedCheck[];
    selection: CheckSelection;
    /** Every changed file is documentation and no check reads it. */
    documentationOnly?: boolean;
  } {
    const chosen = (
      scope: CheckSelection["scope"],
      checks: DetectedCheck[],
      decisions: ProjectDecision[] = [],
    ) => ({ checks, selection: { scope, commands: checks.map((c) => c.command), decisions } });

    const override = this.overridden();
    if (override) {
      return chosen(
        "override",
        override.map((command) => ({
          ecosystem: "js" as Ecosystem,
          kind: classifyCommand(command),
          project: "",
          command,
        })),
      );
    }
    const projects = detectProjects(this.config.workspaceRoot, this.detectOptions());
    const rel = relativizeTouched(this.config.workspaceRoot, touched ?? []);
    // No usable file list (an older caller, or a run that wrote nothing inside
    // the workspace): grade the whole workspace, exactly as before.
    if (rel.length === 0)
      return chosen("workspace", orderChecks(projects.flatMap((p) => p.checks)));

    // The run wrote real files that belong to no detected project — a folder of
    // static files beside other people's projects. There is no check for what
    // this run made, and the siblings' checks say nothing about it. Returning
    // none makes `run()` report "nothing runnable detected", which is both true
    // and the signal the doctrine already teaches: static files, not a project.
    // Grading the siblings instead is what sent one run to install pandas for a
    // stranger's test suite.
    //
    // And within a directory several ecosystems share, only the ones the
    // change can reach (verify-scope.ts): a TypeScript edit beside a
    // `Cargo.toml` does not run cargo.
    const picked = selectProjects(projects, rel, this.scopeFacts());
    return {
      ...chosen("touched", orderChecks(picked.projects.flatMap((p) => p.checks)), picked.decisions),
      documentationOnly: picked.documentationOnly,
    };
  }

  private commands(): string[] {
    return (
      this.overridden() ?? detectVerifyCommands(this.config.workspaceRoot, this.detectOptions())
    );
  }

  async verify(signal?: AbortSignal, touched?: string[], only?: string[]): Promise<VerifyResult> {
    const picked = this.select(touched);
    if (picked.documentationOnly) {
      // A decision, and said as one: not "nothing runnable" (there is a
      // project here, with checks) and not a pass (nothing ran).
      return {
        ...settle(
          { status: "inconclusive", reason: "not_required" },
          [],
          "No check applies — only documentation changed, and none of this project's checks read it.",
        ),
        selection: picked.selection,
      };
    }
    let checks = picked.checks;
    let selection = picked.selection;
    // ── The impacted set, not the suite (M4 exit R1) ──
    //
    // `only` names the commands a repair turn was about. Re-running the whole
    // check set after a one-command fix is how a run's remaining budget went
    // to suites it never touched: the bounded response to `check_failed` is
    // "one repair turn, then re-verify what failed", and this is the second
    // half of that sentence. An `only` that matches nothing is ignored rather
    // than obeyed — verifying nothing and calling it green is the one outcome
    // worse than verifying too much.
    if (only && only.length > 0) {
      const wanted = new Set(only);
      const narrowed = checks.filter((c) => wanted.has(c.command));
      if (narrowed.length > 0) {
        checks = narrowed;
        selection = { ...selection, scope: "impacted", commands: narrowed.map((c) => c.command) };
      }
    }
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const failure: { failed?: { check: DetectedCheck; output: string } } = {};
    const result = await this.run(checks, timeoutMs, signal, failure);
    if (result.status !== "failed" || !failure.failed) return { ...result, selection };
    // A real failure. Before it is handed back as the run's to repair: were
    // these tests already failing where the run started?
    let attribution: FailureAttribution;
    try {
      attribution = await this.attribute(failure.failed, timeoutMs, signal);
    } catch (err) {
      attribution = {
        known: false,
        why: `could not be determined (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    return { ...result, selection, attribution };
  }

  /**
   * Step check: the compile-class subset, on a tighter clock (a minute — a
   * typecheck that takes longer than that is not a step-boundary tool). When
   * the project has no such check, `ran: false` and the caller moves on.
   *
   * `touched` narrows a multi-project workspace to the project the step
   * actually edited: four services in one repo should not all rebuild because
   * one of them changed.
   */
  async verifyFast(signal?: AbortSignal, touched?: string[]): Promise<VerifyResult> {
    const timeout = Math.min(this.config.timeoutMs ?? 120_000, 60_000);
    const override = this.overridden();
    if (override) {
      const fast = fastCheckCommands(override).map((command) => ({
        ecosystem: "js" as Ecosystem,
        kind: classifyCommand(command),
        project: "",
        command,
      }));
      return fast.length === 0 ? noFastCheck() : this.run(fast, timeout, signal);
    }

    const projects = detectProjects(this.config.workspaceRoot, this.detectOptions());
    // Normalised first: the model writes absolute and `~`-prefixed paths, and
    // a project dir is workspace-relative. Matching them raw never hit, so
    // every step check quietly widened to the whole tree.
    const rel = relativizeTouched(this.config.workspaceRoot, touched ?? []);
    const scoped = projectForFiles(projects, rel);
    // The same narrowing the end-of-turn check gets: a step that edited a
    // TypeScript file in a root that also holds a `Cargo.toml` does not need
    // `cargo check` to close.
    const picked = scoped.length > 0 ? selectProjects(scoped, rel, this.scopeFacts()) : null;
    const chosen = picked ? picked.projects : projects;

    const fast: DetectedCheck[] = [];
    for (const p of chosen) {
      const own = p.checks.filter((c) => FAST_KINDS.has(c.kind));
      if (own.length > 0) {
        fast.push(...own);
      } else if (rel.length > 0) {
        const scopedCheck = fileScopedCheck(this.config.workspaceRoot, p, rel);
        if (scopedCheck) fast.push(scopedCheck);
      }
    }
    if (fast.length === 0) return noFastCheck();
    fast.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    return {
      ...(await this.run(fast, timeout, signal)),
      selection: {
        scope: picked ? "touched" : "workspace",
        commands: fast.map((c) => c.command),
        decisions: picked?.decisions ?? [],
      },
    };
  }

  private async run(
    checks: DetectedCheck[],
    timeoutMs: number,
    signal?: AbortSignal,
    /** Filled with the check that went red and everything it printed. */
    failure?: { failed?: { check: DetectedCheck; output: string } },
  ): Promise<VerifyResult> {
    if (checks.length === 0) {
      // Word this as the finding it is: after a session that WROTE files,
      // "nothing runnable" usually means the work produced static files, not a
      // project — the exact signature of a mock delivered as an app. The report
      // reaches both the task-state block and the UI's verification line.
      return settle(
        { status: "inconclusive", reason: "no_checks" },
        [],
        "Nothing runnable detected — no manifest, test, or build configuration found, so no command was executed.",
      );
    }

    // One pass: every check in it sees what the ones before it built, and what
    // the pass generated goes when the pass ends — however it ends. A check
    // that was killed half-way left half a build.
    //
    // For the checks Rune chose. A command the person wrote in `[verify]
    // commands` is theirs, and so is what it builds: the same line H1b draws.
    const root = this.config.workspaceRoot;
    const before = this.config.keepGenerated || this.overridden() ? null : await treeBefore(root);
    let result: VerifyResult;
    let removed: string[];
    try {
      result = await this.runChecks(checks, timeoutMs, signal, failure);
    } finally {
      removed = await removeGenerated(root, before);
    }
    return removed.length > 0 ? { ...result, removed } : result;
  }

  private async runChecks(
    checks: DetectedCheck[],
    timeoutMs: number,
    signal?: AbortSignal,
    failure?: { failed?: { check: DetectedCheck; output: string } },
  ): Promise<VerifyResult> {
    const reports: string[] = [];
    const runs: CheckRunRecord[] = [];
    /**
     * Report every command that FINISHED to the check log — pass or fail.
     *
     * A command that never started (toolchain absent), or that was killed at
     * its deadline or by a cancelled run, measured nothing. Logging the last
     * two as failed checks is what put "`bun run test` last failed" in a
     * verdict about a suite that was simply slow: the log is read as evidence
     * about the code, and a kill says nothing about the code.
     */
    const note = (record: CheckRunRecord): void => {
      runs.push(record);
      if (!runCompleted(record)) return;
      try {
        this.config.onCheck?.({
          command: record.command,
          passed: record.passed,
          summary: record.passed ? "ok" : `exit ${record.exitCode}`,
          exitCode: record.exitCode ?? undefined,
          durationMs: record.durationMs,
        });
      } catch {
        // Evidence bookkeeping must never break verification itself.
      }
    };
    const report = (): string => reports.join("\n\n");
    const cancelled = (): VerifyResult => {
      reports.push("[cancelled — the remaining checks did not run]");
      return settle({ status: "inconclusive", reason: "cancelled" }, runs, report());
    };

    for (const check of checks) {
      // Cancelled between two checks. The ones before this point may all be
      // green; the set as a whole was not finished, so it is not a pass.
      if (signal?.aborted) return cancelled();
      const cmd = check.command;
      const { exitCode, output, timedOut, durationMs } = await runCommand(
        cmd,
        this.config.workspaceRoot,
        timeoutMs,
        signal,
        // By the check's ecosystem — which only a DETECTED check has. A command
        // the person wrote in `[verify] commands` carries none of its own (it
        // is filed under JS, which has no switch), so it runs in exactly the
        // environment they wrote it for.
        generatedStateEnv(
          join(this.config.workspaceRoot, check.project),
          check.ecosystem,
          process.env,
          () => this.cacheDir(),
        ),
      );
      const base = { command: cmd, ecosystem: check.ecosystem, kind: check.kind, durationMs };
      if (signal?.aborted) {
        // Cancelled while this command was running: it was killed, and the
        // exit code of a killed process is not a verdict on the code.
        note({ ...base, exitCode: null, passed: false, cancelled: true });
        reports.push(`$ ${cmd}\n[cancelled]`);
        return cancelled();
      }
      if (timedOut) {
        note({ ...base, exitCode: null, passed: false, timedOut: true });
        reports.push(`$ ${cmd}\n[timed out after ${timeoutMs}ms — nothing was measured]`);
        return settle({ status: "inconclusive", reason: "timeout" }, runs, report());
      }
      if (exitCode !== 0) {
        const absent = missingToolchain(cmd, exitCode, output);
        if (absent) {
          // Cannot check ≠ check failed. Recorded, reported, and stepped over.
          note({ ...base, exitCode: null, passed: true, skipped: absent });
          reports.push(`$ ${cmd}  (skipped — ${absent})`);
          continue;
        }
        note({ ...base, exitCode, passed: false });
        reports.push(`$ ${cmd}  (exit ${exitCode})\n${truncate(output, 2000)}`);
        if (failure) failure.failed = { check, output };
        return settle({ status: "failed" }, runs, report());
      }
      note({ ...base, exitCode, passed: true });
      reports.push(`$ ${cmd}  (ok)`);
    }

    if (!runs.some(runCompleted)) {
      // Every selected check was stepped over for an absent toolchain.
      return settle(
        { status: "inconclusive", reason: "missing_runner" },
        runs,
        `No check could run — ${runs
          .map((r) => r.skipped)
          .filter(Boolean)
          .join("; ")}.`,
      );
    }
    return settle({ status: "passed" }, runs, report());
  }
}

function noFastCheck(): VerifyResult {
  return settle(
    { status: "inconclusive", reason: "no_checks" },
    [],
    "No compile-class check detected for a step check.",
  );
}
