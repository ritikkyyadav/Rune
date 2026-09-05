// ─── Verification ───
//
// Turns "the agent stopped" into "the agent's work actually checks out" by
// running the project's own checks (typecheck / tests / cargo check / go build)
// after the agent claims it's done, and feeding any failure back so it can
// self-correct.
//
// Design notes:
//  - If we cannot detect any check for a workspace, verification PASSES
//    trivially (ran:false). We never fail a task just because we couldn't
//    figure out how to verify it.
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

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";

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
  timedOut?: boolean;
}

export interface VerifyResult {
  /** true when checks pass OR no checks are applicable. */
  passed: boolean;
  /** true when at least one check command actually ran. */
  ran: boolean;
  /** Human-readable report (command + trimmed output) to feed back to the agent. */
  report: string;
  /**
   * Per-command record: what ran, its exit code, how long it took. The evidence
   * ledger reads this instead of scraping the report, which it used to do with
   * a regex over `$ ` lines.
   */
  runs?: CheckRunRecord[];
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
  verify(signal?: AbortSignal, touched?: string[]): Promise<VerifyResult>;
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
    out.push(["test", pm === "npm" ? "npm test" : `${pm} test`]);
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

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; timedOut: boolean; durationMs: number }> {
  const started = Date.now();
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

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
  }
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
    const owners = projects.filter((p) => file.startsWith(p.dir === "" ? "" : `${p.dir}/`));
    if (owners.length === 0) continue;
    // Every owner's dir is a prefix of the same path, so the longest is the
    // innermost, and equal lengths are the same directory.
    const innermost = Math.max(...owners.map((p) => p.dir.length));
    for (const p of owners) {
      if (p.dir.length === innermost && !out.includes(p)) out.push(p);
    }
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
  constructor(private readonly config: CommandVerifierConfig) {}

  private overridden(): string[] | null {
    return this.config.commands && this.config.commands.length > 0 ? this.config.commands : null;
  }

  private detectOptions(): DetectOptions {
    return { ecosystems: this.config.ecosystems };
  }

  /**
   * Every check for this workspace, as the structured records the ledger wants
   * — narrowed to the project(s) `touched` belongs to when it names any.
   *
   * An explicit `[verify] commands` override is never narrowed: the user said
   * exactly what to run, and that is what runs.
   */
  private checks(touched?: readonly string[]): DetectedCheck[] {
    const override = this.overridden();
    if (override) {
      return override.map((command) => ({
        ecosystem: "js" as Ecosystem,
        kind: classifyCommand(command),
        project: "",
        command,
      }));
    }
    const projects = detectProjects(this.config.workspaceRoot, this.detectOptions());
    const rel = relativizeTouched(this.config.workspaceRoot, touched ?? []);
    // No usable file list (an older caller, or a run that wrote nothing inside
    // the workspace): grade the whole workspace, exactly as before.
    if (rel.length === 0) return orderChecks(projects.flatMap((p) => p.checks));

    const scoped = projectsForRun(projects, rel);
    // The run wrote real files that belong to no detected project — a folder of
    // static files beside other people's projects. There is no check for what
    // this run made, and the siblings' checks say nothing about it. Returning
    // none makes `run()` report "nothing runnable detected", which is both true
    // and the signal the doctrine already teaches: static files, not a project.
    // Grading the siblings instead is what sent one run to install pandas for a
    // stranger's test suite.
    return orderChecks(scoped.flatMap((p) => p.checks));
  }

  private commands(): string[] {
    return (
      this.overridden() ?? detectVerifyCommands(this.config.workspaceRoot, this.detectOptions())
    );
  }

  async verify(signal?: AbortSignal, touched?: string[]): Promise<VerifyResult> {
    return this.run(this.checks(touched), this.config.timeoutMs ?? 120_000, signal);
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
    const chosen = scoped.length > 0 ? scoped : projects;

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
    return this.run(fast, timeout, signal);
  }

  private async run(
    checks: DetectedCheck[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<VerifyResult> {
    if (checks.length === 0) {
      // Word this as the finding it is: after a session that WROTE files,
      // "nothing runnable" usually means the work produced static files, not a
      // project — the exact signature of a mock delivered as an app. The report
      // reaches both the task-state block and the UI's verification line.
      return {
        passed: true,
        ran: false,
        runs: [],
        report:
          "Nothing runnable detected — no manifest, test, or build configuration found, so no command was executed.",
      };
    }

    const reports: string[] = [];
    const runs: CheckRunRecord[] = [];
    /** Report every command we ran to the check log — pass or fail, always. */
    const note = (record: CheckRunRecord): void => {
      runs.push(record);
      if (record.skipped) return; // a command that never ran is not evidence
      try {
        this.config.onCheck?.({
          command: record.command,
          passed: record.passed,
          summary: record.timedOut
            ? `timed out after ${timeoutMs}ms`
            : record.passed
              ? "ok"
              : `exit ${record.exitCode}`,
          exitCode: record.exitCode ?? undefined,
          durationMs: record.durationMs,
        });
      } catch {
        // Evidence bookkeeping must never break verification itself.
      }
    };

    for (const check of checks) {
      if (signal?.aborted) break;
      const cmd = check.command;
      const { exitCode, output, timedOut, durationMs } = await runCommand(
        cmd,
        this.config.workspaceRoot,
        timeoutMs,
        signal,
      );
      const base = { command: cmd, ecosystem: check.ecosystem, kind: check.kind, durationMs };
      if (timedOut) {
        note({ ...base, exitCode, passed: false, timedOut: true });
        reports.push(`$ ${cmd}\n[timed out after ${timeoutMs}ms]`);
        return { passed: false, ran: true, runs, report: reports.join("\n\n") };
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
        return { passed: false, ran: true, runs, report: reports.join("\n\n") };
      }
      note({ ...base, exitCode, passed: true });
      reports.push(`$ ${cmd}  (ok)`);
    }

    const actuallyRan = runs.some((r) => !r.skipped);
    if (!actuallyRan) {
      return {
        passed: true,
        ran: false,
        runs,
        report:
          runs.length > 0
            ? `No check could run — ${runs
                .map((r) => r.skipped)
                .filter(Boolean)
                .join("; ")}.`
            : "Nothing runnable detected — no command was executed.",
      };
    }
    return { passed: true, ran: true, runs, report: reports.join("\n\n") };
  }
}

function noFastCheck(): VerifyResult {
  return {
    passed: true,
    ran: false,
    runs: [],
    report: "No compile-class check detected for a step check.",
  };
}
