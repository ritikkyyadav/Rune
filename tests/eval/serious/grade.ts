/**
 * The serious family's grader: runs a task's hidden tests in a tree and reports
 * what happened to each one.
 *
 * The miner (f2p.ts) and the task source (source.ts) share this module. The
 * miner runs the fix commit's tests at the parent and at the fix to decide what a
 * task's checks are. The task source runs the same tests over the tree an arm
 * left behind. Both use one runner on purpose: a check is fail-to-pass because
 * THIS runner saw it fail at the parent and pass at the fix, twice each, so
 * grading an arm with any other runner would measure something else.
 *
 * When bun is not on a terminal it prints per-test lines only for failures, so
 * the runner reads bun's JUnit report instead. A test missing from the report did
 * not run (its file failed to load, bun crashed, or the run was killed), and it
 * counts as not passing.
 *
 * Nothing here calls a model.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Outcome } from "../parity/types";

export type TestStatus = "pass" | "fail" | "skip";

/** `<file> :: <describe> > … > <name>` → what the run said about that test. */
export type TestResults = Record<string, TestStatus>;

/** One `bun test` run over a task's hidden test files. */
export interface TestRun {
  results: TestResults;
  wallMs: number;
  exitCode: number | null;
  /** The run was killed at its timeout. */
  timedOut: boolean;
  /** Bun wrote no JUnit report: it never got as far as reporting. */
  reportMissing: boolean;
  /** The tail of bun's own output. */
  log: string;
}

/** The preload every suite in this repo runs under, when the tree has it. */
export const PRELOAD = "tests/scratch-home.ts";

/** A run is killed after this long. The miner's keep rule (120 s) is stricter. */
export const RUN_TIMEOUT_MS = 240_000;

export const TYPECHECK_TIMEOUT_MS = 300_000;

/** Between a check's test file and its describe path. */
export const KEY_SEPARATOR = " :: ";

export function testKey(file: string, path: string[]): string {
  return `${normaliseFile(file)}${KEY_SEPARATOR}${path.join(" > ")}`;
}

/** The test file a check's key names. */
export function fileOfKey(key: string): string {
  const at = key.indexOf(KEY_SEPARATOR);
  return at < 0 ? key : key.slice(0, at);
}

function normaliseFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

// ── JUnit ──

const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** One pass, so `&amp;lt;` decodes to `&lt;` and not to `<`. */
export function decodeXml(text: string): string {
  return text.replace(ENTITY, (_, dec: string, hex: string, name: string) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : NAMED_ENTITY[name]!,
  );
}

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decodeXml(m[2]!);
  return out;
}

const TAG =
  /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;

/**
 * Bun's JUnit report → one status per test.
 *
 * The outermost `<testsuite>` is the file and each nested one is a `describe`,
 * so a test's key is its file plus the describe path down to it. That is the
 * same `describe > name` path bun prints for a failure. A `<failure>` or
 * `<error>` inside a test makes it a failure and `<skipped>` a skip (a failure
 * wins). Two tests with the same path in one file keep both results: the second
 * becomes `… #2`, in report order. The describe names come from the suites'
 * `name` attributes because bun escapes the `classname` attribute twice.
 */
export function parseJunit(xml: string): TestResults {
  const results: TestResults = {};
  const suites: Record<string, string>[] = [];
  let open: { key: string; status: TestStatus } | null = null;
  const record = (key: string, status: TestStatus) => {
    let unique = key;
    for (let n = 2; unique in results; n++) unique = `${key} #${n}`;
    results[unique] = status;
  };
  for (const [, closing, tag, attrText, selfClosing] of xml.matchAll(TAG)) {
    if (tag === "testsuites") continue;
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attributes(attrText!));
      continue;
    }
    if (tag === "testcase") {
      if (closing) {
        if (open) record(open.key, open.status);
        open = null;
        continue;
      }
      const a = attributes(attrText!);
      const fileSuite = suites[0] ?? {};
      const file = a.file ?? fileSuite.file ?? fileSuite.name ?? "";
      const describes = suites.slice(1).map((s) => s.name ?? "");
      const test = {
        key: testKey(file, [...describes, a.name ?? ""]),
        status: "pass" as TestStatus,
      };
      if (selfClosing) record(test.key, test.status);
      else open = test;
      continue;
    }
    if (!open || closing) continue;
    if (tag === "skipped") {
      if (open.status === "pass") open.status = "skip";
    } else open.status = "fail";
  }
  return results;
}

// ── Processes ──

export interface Captured {
  exitCode: number | null;
  output: string;
  wallMs: number;
  timedOut: boolean;
}

/**
 * Spawn in a process group of its own, capture the output, and kill the whole
 * group when the run ends or times out. A test that starts a background process
 * and forgets it must not outlive the run, or hold its pipes open so that the
 * run never ends.
 */
export function spawnCapture(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs: number },
): Promise<Captured> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let done = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? scrubbedEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode, output, wallMs: Date.now() - started, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    // Bun's types for ChildProcess drop the EventEmitter half (as in
    // tests/eval/comparison/process.ts); the events are there at run time.
    const events = child as unknown as {
      on(event: "error", listener: (error: Error) => void): void;
      on(event: "exit" | "close", listener: (code: number | null) => void): void;
    };
    events.on("error", (error) => {
      output += `\n[spawn error] ${error.message}\n`;
      finish();
    });
    events.on("exit", (code) => {
      exitCode = code;
      killGroup();
      // `close` waits for the pipes; a straggler outside the group could hold
      // them open for ever, so the exit is enough after a grace.
      setTimeout(finish, 2_000);
    });
    events.on("close", (code) => {
      exitCode ??= code;
      finish();
    });
  });
}

export function tail(text: string, lines = 80): string {
  return text.split("\n").slice(-lines).join("\n");
}

// ── The environment a hidden test runs in ──

/** Credential-shaped variables never reach a graded run (or anything else here). */
const SECRET_NAME = /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET_KEY|_SECRET|_TOKEN|_PASSWORD)$/;

export function scrubbedEnv(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name) && name !== "RUNE_TEST_FAKE_API_KEY") continue;
    env[name] = value;
  }
  delete env.RUNE_EVAL_REAL;
  return env;
}

const GITCONFIG = [
  "[user]",
  "\tname = Serious Grader",
  "\temail = grader@serious.invalid",
  "[init]",
  "\tdefaultBranch = main",
  "[commit]",
  "\tgpgsign = false",
  "",
].join("\n");

/**
 * The environment of a hidden-test run: a scratch HOME with a git identity of
 * its own, and no credentials. Parents older than 2026-09-15 have no scratch
 * home preload, so the HOME is what keeps their suites off the real profile.
 * The identity is what lets suites that commit in a temporary repository do so
 * without a global git config.
 */
export function testEnv(
  scratch: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = scrubbedEnv(inherited);
  for (const name of ["RUNE_HOME", "GEAR_HOME", "ALAN_HOME", "BERNE_HOME"]) delete env[name];
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const gitconfig = join(scratch, "gitconfig");
  writeFileSync(gitconfig, GITCONFIG);
  env.HOME = home;
  env.GIT_CONFIG_GLOBAL = gitconfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

// ── Runs ──

export interface RunOptions {
  timeoutMs?: number;
  /** Where to keep the report and bun's output. Nothing is kept when absent. */
  evidenceDir?: string;
  /** The evidence files' name, e.g. `base-1`. */
  label?: string;
}

/**
 * `bun test [--preload ./tests/scratch-home.ts] <files>` in `tree`, read
 * through bun's JUnit report. The files are passed as `./` paths so bun treats
 * them as paths and not as name filters.
 */
export async function runHiddenTests(
  tree: string,
  files: string[],
  options: RunOptions = {},
): Promise<TestRun> {
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "serious-run-"));
  try {
    const report = join(scratch, "junit.xml");
    const args = ["test"];
    if (existsSync(join(tree, PRELOAD))) args.push("--preload", `./${PRELOAD}`);
    args.push("--reporter=junit", `--reporter-outfile=${report}`);
    args.push(...files.map((file) => `./${normaliseFile(file)}`));
    const run = await spawnCapture("bun", args, {
      cwd: tree,
      env: testEnv(scratch),
      timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS,
    });
    const reportMissing = !existsSync(report);
    const xml = reportMissing ? "" : readFileSync(report, "utf8");
    if (options.evidenceDir) {
      mkdirSync(options.evidenceDir, { recursive: true });
      const label = options.label ?? "run";
      if (!reportMissing) writeFileSync(join(options.evidenceDir, `${label}.junit.xml`), xml);
      writeFileSync(join(options.evidenceDir, `${label}.log`), tail(run.output, 400));
    }
    return {
      results: parseJunit(xml),
      wallMs: run.wallMs,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      reportMissing,
      log: tail(run.output),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `bunx tsc --noEmit -p <packageDir>` in `tree`. */
export async function typecheck(
  tree: string,
  packageDir: string,
  timeoutMs = TYPECHECK_TIMEOUT_MS,
): Promise<{ clean: boolean; wallMs: number; log: string }> {
  const run = await spawnCapture("bunx", ["tsc", "--noEmit", "-p", packageDir], {
    cwd: tree,
    timeoutMs,
  });
  return { clean: run.exitCode === 0 && !run.timedOut, wallMs: run.wallMs, log: tail(run.output) };
}

// ── Outcome ──

/** What a task's JSON says about its checks: the grader's whole input. */
export interface GradeSpec {
  f2p: string[];
  p2p: string[];
  impossible: string[];
  /** The packages the fix touched, as directories (`packages/shared`). */
  typecheckPackages: string[];
  /** Was each typecheck clean at the parent? */
  typecheckBaseClean: Record<string, boolean>;
  /** Was it clean with the reference fix applied? A check the reference fails holds no one. */
  typecheckFixedClean?: Record<string, boolean>;
}

/**
 * The packages whose typecheck can break the build: clean at the parent and
 * with the reference fix. The grader typechecks only these.
 */
export function heldPackages(spec: GradeSpec): string[] {
  return spec.typecheckPackages.filter(
    (pkg) => spec.typecheckBaseClean[pkg] === true && spec.typecheckFixedClean?.[pkg] !== false,
  );
}

/**
 * The Outcome of one graded tree.
 *
 * `hiddenTotal` counts the fail-to-pass checks only: a check pinned impossible
 * never enters it, even if it passes. A pass-to-pass check that does not pass
 * now is a regression. The build is broken only when a package that was clean at
 * the parent (and with the reference fix) no longer typechecks.
 */
export function outcomeOf(
  spec: GradeSpec,
  results: TestResults,
  typecheckNow: Record<string, boolean>,
): Outcome {
  const impossible = new Set(spec.impossible);
  const passed = (key: string) => results[key] === "pass";
  const f2p = spec.f2p.filter((key) => !impossible.has(key));
  const p2p = spec.p2p.filter((key) => !impossible.has(key));
  return {
    hiddenPassed: f2p.filter(passed).length,
    hiddenTotal: f2p.length,
    regressionsIntroduced: p2p.filter((key) => !passed(key)).length,
    buildBroken: heldPackages(spec).some((pkg) => typecheckNow[pkg] === false),
    impossible: [...spec.impossible],
  };
}
