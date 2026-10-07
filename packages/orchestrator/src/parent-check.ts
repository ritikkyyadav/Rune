// ─── The parent-commit check ───
//
// `verified` is defined in brief.ts as "a test that failed on the parent
// commit passes now". The runtime used to award it from something weaker: the
// same command failing and then passing WITHIN one session. Those are not the
// same claim, and the gap between them is the most common shape of agent work
// there is — the agent edits, breaks a test, fixes its own break, and the test
// goes red→green without the change ever being the reason it passes now. The
// parent commit was green the whole time. The receipt said otherwise.
//
// So the runtime does the work instead of inferring it. It checks out the
// pre-change tree in a DETACHED WORKTREE — never `git stash`, never the user's
// working tree, which must survive a crash here untouched — runs the same
// command there, and reports what happened.
//
// The hard part is not running the command. It is refusing to lie when the
// answer is unclear: a parent tree has no node_modules, no build output, no
// virtualenv. A command that fails there because nothing is installed looks
// exactly like a command that fails there because the bug was real, and
// treating the first as the second manufactures the precise false receipt this
// module exists to abolish. Anything that smells of a missing environment
// comes back INCONCLUSIVE, and inconclusive never yields `verified`.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { changedSinceBaseline, materialiseBaseline, type TaskBaseline } from "./baseline";
import { attributable, parseBunTestRun, testLabel, type ParsedTestRun } from "./check-failures";
import { isManagedCommitSubject } from "./git-undo";

/**
 * What running a check against the pre-change tree established.
 *
 * `not-applicable-on-parent` is the one the first draft was missing, and it
 * is the difference between a measurement and a tautology. "It failed on the
 * parent" was satisfiable by ABSENCE: a test file that did not exist there
 * yet, a module the parent never had, a script the parent never shipped, a
 * command the parent's toolchain did not know. Each of those exits non-zero
 * without ever running the check, and a rung ladder that reads exit codes
 * alone spends `verified` on the novelty of a file. A check that could not RUN
 * on the parent measured nothing there, so it establishes nothing here.
 */
export type ParentCheckStatus = "failed" | "passed" | "inconclusive" | "not-applicable-on-parent";

export interface ParentCheckResult {
  status: ParentCheckStatus;
  /** The commit the check actually ran against. Absent when it never ran. */
  commit?: string;
  /** Why, in one line — for inconclusive, and for the receipt. */
  reason?: string;
}

function git(cwd: string, args: string[], timeoutMs = 30_000) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/**
 * Signatures of "this tree was never set up", as opposed to "this check
 * genuinely failed". Exit 127 is the strongest single signal (the shell could
 * not find the program at all); the rest catch the dependency managers whose
 * absence a fresh checkout guarantees.
 */
const ENV_FAILURE = new RegExp(
  [
    "command not found",
    "cannot find module",
    "module_not_found",
    "modulenotfounderror",
    "no such file or directory",
    "enoent",
    "is not recognized as an internal or external command",
    "could not determine executable to run",
    "no lockfile found",
    "cargo\\.lock.*not found",
    "go: cannot find main module",
    "virtualenv|no module named",
  ].join("|"),
  "i",
);

function looksLikeMissingEnvironment(exitCode: number, output: string): boolean {
  if (exitCode === 127) return true;
  return ENV_FAILURE.test(output);
}

/**
 * Signatures of a check that did not RUN on the parent tree, as opposed to one
 * that ran and failed.
 *
 * Every runner has its own way of saying "I collected nothing", and every one
 * of them exits non-zero when told to run a file that is not there. Those
 * strings are the difference between "the bug was real here" and "this file is
 * new" — the whole content of `verified`. `ZERO_TESTS` in
 * `verification-command.ts` lists the same runner vocabulary for the live
 * side; these are its parent-tree twin, plus the shapes that mean the command
 * line itself was not understood (an unknown subcommand, a usage error, a
 * script the parent's `package.json` never declared).
 */
const COULD_NOT_RUN = new RegExp(
  [
    // The runners' own words for "nothing was collected".
    "no tests? (?:found|ran|were found|to run|matched|detected)",
    "no test files? (?:found|matched)",
    "\\[no test files\\]", // go test
    "collected 0 items", // pytest
    "tests:\\s+0 total", // jest
    "test result: ok\\. 0 passed; 0 failed", // cargo, a target with no tests
    "0 pass[\\s\\S]{0,40}?0 fail", // bun, which prints both counts
    "0 (?:tests?|examples?|specs?) (?:ran|run|executed|completed)",
    // The command line itself was not understood there.
    "unknown (?:command|subcommand|option|argument|flag)",
    "unrecognized (?:option|arguments?|command)",
    "invalid (?:option|argument|subcommand)",
    "missing script:", // npm/bun: a package.json script the parent never had
    "no such (?:script|task|target|test)",
    "^\\s*usage:", // a usage error, which is a refusal to run
    "can't open file", // python, handed a path that is not there
    "could not find `?cargo\\.toml`?",
    "go: no go files|no go files listed|matched no packages",
  ].join("|"),
  "im",
);

/**
 * Whether this output is a runner saying it never ran, rather than a check
 * saying it failed. Exported for the tests that pin each runner's wording:
 * the vocabulary is the whole content of the distinction, so it is held to
 * examples rather than to the regexp's shape.
 */
export function couldNotRunOnParent(output: string): boolean {
  return COULD_NOT_RUN.test(output);
}

/**
 * Paths the command NAMES that exist in the working tree and did not exist at
 * the parent commit.
 *
 * The structural half of the same question, and the one no output pattern can
 * answer: a brand-new test file makes its runner exit non-zero on the parent
 * however politely the runner phrases it, and a fresh syntax error in a file
 * the parent never had looks exactly like a real failure. Conservative on
 * purpose — a word has to be a real file HERE before its absence THERE means
 * anything, so a tokenising artefact (`console.log`, `a,b,c`) draws no
 * conclusion, and a path that is missing on both sides draws none either.
 */
export function namedPathsAbsentOnParent(repoRoot: string, sha: string, command: string): string[] {
  const absent: string[] = [];
  for (const raw of command.split(/[\s;|&<>()]+/)) {
    const word = raw.replace(/^['"]+/, "").replace(/['"]+$/, "");
    if (!word || word.startsWith("-") || word.includes("..")) continue;
    // Absolute paths are outside the checkout by definition, and a word with
    // shell syntax in it is not a path the command named.
    if (word.startsWith("/") || /[*?$`{}\\]/.test(word)) continue;
    if (!/[./]/.test(word)) continue;
    const rel = word.replace(/^\.\//, "");
    if (!rel || !existsSync(join(repoRoot, rel))) continue;
    if (!git(repoRoot, ["cat-file", "-e", `${sha}:${rel}`], 10_000).ok && !absent.includes(rel)) {
      absent.push(rel);
    }
  }
  return absent;
}

/**
 * The commit representing the tree BEFORE this session's changes.
 *
 * Normally that is HEAD: the agent's edits are uncommitted, so HEAD is
 * untouched by them. The exception is a landed auto-commit — `[git] autoCommit`
 * makes each run one revertible commit, so when HEAD is a Rune commit the
 * pre-change tree is its parent.
 */
export function resolveParentCommit(repoRoot: string): { sha: string; ref: string } | null {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) return null;

  const subject = git(repoRoot, ["log", "-1", "--pretty=%s"]);
  if (subject.ok && isManagedCommitSubject(subject.stdout)) {
    const parent = git(repoRoot, ["rev-parse", "HEAD~1"]);
    // A Rune commit with no parent means the repo's first commit is ours;
    // there is no pre-change tree to compare against.
    if (!parent.ok || !parent.stdout) return null;
    return { sha: parent.stdout, ref: "HEAD~1" };
  }
  return { sha: head.stdout, ref: "HEAD" };
}

/**
 * What a finished run of a check on an earlier tree established. The order is
 * the point: before a non-zero exit is read as a verdict, was the tree set up
 * to run the check, and did the check RUN there?
 */
function readParentRun(
  exitCode: number,
  output: string,
  commit: string,
  ref: string,
  absentThere: () => string[],
): ParentCheckResult {
  if (exitCode === 0) {
    return {
      status: "passed",
      commit,
      reason: `already passed on ${ref} — this change is not why it passes`,
    };
  }
  if (looksLikeMissingEnvironment(exitCode, output)) {
    return {
      status: "inconclusive",
      commit,
      reason: `the ${ref} tree is not set up to run this check (exit ${exitCode})`,
    };
  }
  // A non-zero exit from a runner that collected nothing, or from a command
  // naming a file that tree never had, is a failure BY ABSENCE — and absence
  // is not evidence that this change is why the check is green now.
  if (COULD_NOT_RUN.test(output)) {
    return {
      status: "not-applicable-on-parent",
      commit,
      reason: `the check did not run on ${ref}: it collected nothing there (exit ${exitCode})`,
    };
  }
  const absent = absentThere();
  if (absent.length > 0) {
    return {
      status: "not-applicable-on-parent",
      commit,
      reason:
        `${absent.slice(0, 3).join(", ")} did not exist on ${ref}, so the check ` +
        `could not have run there (exit ${exitCode})`,
    };
  }
  return { status: "failed", commit, reason: `exit ${exitCode} on ${ref}` };
}

/** Worktrees a replay has registered in someone's repository and not yet removed. */
const liveWorktrees = new Map<string, string>();
/** Process groups a replay is running. */
const liveReplayGroups = new Set<number>();
let exitSweepInstalled = false;

/**
 * A process that is stopped mid-replay runs no `finally`. What a replay put in
 * the world — a process group, and a worktree REGISTERED IN THE USER'S
 * REPOSITORY — is taken back out on the way down, whatever the road.
 */
function sweepOnExit(): void {
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  process.on("exit", () => {
    for (const pid of liveReplayGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const [checkout, repoRoot] of liveWorktrees) {
      git(repoRoot, ["worktree", "remove", "--force", checkout], 10_000);
      try {
        rmSync(dirname(checkout), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

/**
 * Run `command` against the pre-change tree and report what happened.
 *
 * Never mutates the caller's working tree: the check runs inside a detached
 * worktree in the OS temp dir, which is removed in a finally block whatever
 * happens. Every failure path returns `inconclusive` rather than throwing —
 * an evidence probe that cannot answer must say so, not take the run down.
 *
 * It does not block. It ran through `spawnSync`, so for as long as the check
 * took — two minutes, at the deadline — the process could not repaint, could
 * not hear a cancel and could not hear SIGTERM: measured, a signal sent during
 * a 25-second replay was answered 25 seconds later. The check now runs in its
 * own process group, and a cancel or the deadline stops the whole of it.
 */
export async function runOnParentCommit(
  repoRoot: string,
  command: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ParentCheckResult> {
  const parent = resolveParentCommit(repoRoot);
  if (!parent) {
    return { status: "inconclusive", reason: "no parent commit to compare against" };
  }
  const cancelled = (): ParentCheckResult => ({
    status: "inconclusive",
    commit: parent.sha,
    reason: "the replay was cancelled",
  });
  if (signal?.aborted) return cancelled();

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "rune-parent-check-"));
    const checkout = join(dir, "tree");
    sweepOnExit();
    liveWorktrees.set(checkout, repoRoot);
    const added = git(repoRoot, ["worktree", "add", "--detach", checkout, parent.sha], 60_000);
    if (!added.ok) {
      return {
        status: "inconclusive",
        commit: parent.sha,
        reason: `could not check out ${parent.ref}: ${added.stderr.slice(0, 160)}`,
      };
    }

    try {
      const ran = await runWitness(
        ["bash", "-c", command],
        checkout,
        { ...process.env },
        timeoutMs,
        signal,
      );
      if (ran.aborted) return cancelled();
      if (ran.timedOut || ran.exitCode === null) {
        return {
          status: "inconclusive",
          commit: parent.sha,
          reason: `check did not complete on ${parent.ref} (${ran.timedOut ? "it outlasted its deadline" : "it could not be started"})`,
        };
      }
      return readParentRun(ran.exitCode, ran.output, parent.sha, parent.ref, () =>
        namedPathsAbsentOnParent(repoRoot, parent.sha, command),
      );
    } finally {
      // Detach the worktree registration before the directory disappears, or
      // git keeps a stale entry in .git/worktrees forever.
      git(repoRoot, ["worktree", "remove", "--force", checkout], 30_000);
      liveWorktrees.delete(checkout);
    }
  } catch (err) {
    return {
      status: "inconclusive",
      commit: parent.sha,
      reason: `parent check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (dir) {
      liveWorktrees.delete(join(dir, "tree"));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}

// ─── A test the run wrote, replayed on the tree the run started from ───
//
// Everything above answers one question about a check that ALREADY EXISTED:
// did it fail before this change? A check the run wrote itself was never
// asked. It was priced `observed` and not replayed at all, for a sound reason
// — a program the run authored prints whatever the run decided — and with an
// unsound consequence: the fix-verified gate tells the model "a real test file
// is best", the model writes one, and the one thing a regression test is FOR
// could not be established by any path. A turn was spent to earn a rung that
// was not on offer.
//
// A new test can be evidence, on one condition: that the SAME test, laid over
// the tree as the run found it, fails there — and fails by asserting something
// that tree gets wrong, not by being unable to run. That is a measurement, and
// the run cannot decide its result: it controls the test, and the pre-task
// tree is not its to change.
//
// What makes that safe is what is refused:
//
//   · the model's command is never replayed. The witness is REBUILT as an
//     argv from the one shape recognised — `bun test <test files>` — and run
//     with no shell. A command with a `;` in it, a redirect, a variable, a
//     flag, has no witness.
//   · only the named TEST files are laid over the pre-task tree. A production
//     file is never copied there, so a fix cannot ride along with its test.
//     A test that needs a module the run created cannot load on that tree,
//     and a test that cannot load proved nothing about it.
//   · a failure counts only when it is an ASSERTION (`expect(…)` said so). A
//     thrown TypeError, a missing export, a timeout, a file that would not
//     load: each is the old tree lacking something, which is absence, and
//     absence was never evidence (see `couldNotRunOnParent`).
//   · dependencies must not have moved. A changed manifest or lockfile means
//     the two runs do not share an environment, and the answer is "unknown".
//   · the replay gets no ambient credentials and a copy of the dependencies,
//     never the user's own.
//   · the result is a result OF one witness. Its digest covers the argv and
//     every byte of the test files: edit the test and the result is not about
//     it any more.
//
// Bun's report only, for the same reason `check-failures.ts` gives: it is the
// one runner whose words this code has been held to.

/** The pinned form of a cited check: what is replayed, and what a result is a result of. */
export interface Witness {
  /** Rebuilt from recognised parts and run without a shell. Never the model's text. */
  argv: string[];
  /** The workspace-relative test files it runs — the only files laid over the pre-task tree. */
  files: string[];
  /** sha256 over the argv and every byte of `files`. */
  digest: string;
}

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Anything that makes a command line more than a program and its paths. */
const SHELL_SYNTAX = /[;&|<>$`(){}\\*?'"!=~#\n\r]/;
const WITNESS_MAX_FILES = 8;
const WITNESS_MAX_BYTES = 1_000_000;

/**
 * The witness for a command, or the reason it has none.
 *
 * One shape: `bun test` followed by test files that exist, are regular files
 * inside the workspace, and look like tests. Everything else — a flag, a
 * glob, a second command — is not replayed; the citation then stands as it
 * always has.
 */
export function witnessFor(
  workspaceRoot: string,
  command: string,
): Witness | { ineligible: string } {
  const no = (ineligible: string) => ({ ineligible });
  if (SHELL_SYNTAX.test(command))
    return no("the command uses shell syntax; only a plain `bun test <test files>` is replayed");
  const words = command.trim().split(/[ \t]+/);
  if (words[0] !== "bun" || words[1] !== "test")
    return no("only `bun test <test files>` is replayed for a test this run wrote");
  const named = words.slice(2);
  if (named.length === 0) return no("the command names no test file");
  if (named.length > WITNESS_MAX_FILES)
    return no(`the command names more than ${WITNESS_MAX_FILES} files`);
  const files: string[] = [];
  const hash = createHash("sha256").update("bun test\0");
  for (const word of named) {
    if (word.startsWith("-")) return no(`${word}: a flag is not replayed`);
    const rel = word.replace(/^(?:\.\/)+/, "");
    if (!rel || isAbsolute(rel) || rel.split("/").includes(".."))
      return no(`${word}: not a path inside the workspace`);
    if (!TEST_FILE.test(rel)) return no(`${rel}: not a test file`);
    if (files.includes(rel)) return no(`${rel}: named twice`);
    let bytes: Buffer;
    try {
      const stat = lstatSync(join(workspaceRoot, rel));
      // A link is a path to somewhere else: what would be copied is not what was named.
      if (!stat.isFile()) return no(`${rel}: not a regular file`);
      if (stat.size > WITNESS_MAX_BYTES) return no(`${rel}: too large to replay`);
      bytes = readFileSync(join(workspaceRoot, rel));
    } catch {
      return no(`${rel}: not in the workspace`);
    }
    files.push(rel);
    hash.update(`${rel}\0`).update(bytes).update("\0");
  }
  return {
    argv: ["bun", "test", ...files.map((file) => `./${file}`)],
    files,
    digest: hash.digest("hex"),
  };
}

/** Manifests, lockfiles and the runner's own configuration: what the two runs must share. */
const ENVIRONMENT_FILE =
  /(?:^|\/)(?:package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bunfig\.toml)$/;

/** What a replay child may see: enough to run, and nothing that is a credential. */
function replayEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, CI: "1", NO_COLOR: "1", TERM: "dumb" };
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "BUN_INSTALL"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

interface WitnessRun {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Run an argv — no shell — in its own process group, and stop the whole group on a deadline or a cancel. */
function runWitness(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WitnessRun> {
  return new Promise((done) => {
    if (signal?.aborted)
      return done({ exitCode: null, output: "", timedOut: false, aborted: true });
    let output = "";
    let timedOut = false;
    let aborted = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = child.pid;
    if (group !== undefined) {
      sweepOnExit();
      liveReplayGroups.add(group);
    }
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const keep = (chunk: Buffer) => {
      if (output.length < 2_000_000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (group !== undefined) liveReplayGroups.delete(group);
      done({ exitCode, output, timedOut, aborted });
    };
    // This package's node typings give a piped child no emitter surface; the
    // two events are spelled out, as baseline.ts does.
    const events = child as unknown as {
      on(event: "error", listener: () => void): void;
      on(event: "close", listener: (code: number | null) => void): void;
    };
    events.on("error", () => finish(null));
    events.on("close", (code) => finish(code));
  });
}

/** A failing test whose own words are an `expect` that did not hold. */
const isAssertion = (signature: string): boolean => /^error: expect\(/m.test(signature);

export interface ReplayResult extends ParentCheckResult {
  /** The witness this is a result of. */
  witness: string;
  /** The pre-task tree it was replayed on. */
  baseline: string;
}

/**
 * Replay a pinned witness on the tree the run started from, and on the tree as
 * it is now.
 *
 * `failed` — the only status that can lift a rung — means every one of these
 * held: the pre-task tree and its environment could be laid out faithfully;
 * the test files, and nothing else, were laid over it; the runner reported at
 * least one failing test there, named every failure, and every one of them was
 * an assertion; and the same argv passes on the current tree with nothing
 * failing. Anything short of that is `passed` (it was green before: the
 * change is not why), `not-applicable-on-parent` (the test could not run
 * there), or `inconclusive` (nobody can say).
 *
 * The laid-out tree is removed whatever happens, a cancel included.
 */
export async function replayWitness(input: {
  workspaceRoot: string;
  baseline: TaskBaseline;
  witness: Witness;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ReplayResult> {
  const { workspaceRoot, baseline, witness, signal } = input;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const stamp = { witness: witness.digest, baseline: baseline.tree, commit: baseline.head };
  const answer = (status: ParentCheckStatus, reason: string): ReplayResult => ({
    status,
    reason,
    ...stamp,
  });
  const cancelled = () => answer("inconclusive", "the replay was cancelled");
  if (signal?.aborted) return cancelled();

  const changed = changedSinceBaseline(baseline);
  if (changed === null)
    return answer("inconclusive", "the pre-task tree can no longer be compared with this one");
  const moved = changed.filter((path) => ENVIRONMENT_FILE.test(path));
  if (moved.length > 0)
    return answer(
      "inconclusive",
      `${moved.slice(0, 3).join(", ")} changed since the pre-task tree: the two runs would not share an environment`,
    );

  const tree = await materialiseBaseline(baseline, {
    ...(signal ? { signal } : {}),
    budgetMs: 60_000,
  });
  if ("unavailable" in tree) {
    return signal?.aborted
      ? cancelled()
      : answer("inconclusive", `the pre-task tree could not be laid out: ${tree.unavailable}`);
  }
  let home: string | undefined;
  try {
    // The test files, and only them. Nothing else of the run's reaches this tree.
    for (const file of witness.files) {
      const target = join(tree.cwd, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(workspaceRoot, file), target);
    }
    home = mkdtempSync(join(tmpdir(), "rune-replay-home-"));
    const env = replayEnv(home);

    const before = await runWitness(witness.argv, tree.cwd, env, timeoutMs, signal);
    if (before.aborted) return cancelled();
    if (before.timedOut)
      return answer("inconclusive", "the test did not finish on the pre-task tree");
    if (before.exitCode === null)
      return answer("inconclusive", "the test could not be started on the pre-task tree");
    const then = parseBunTestRun(before.output, [tree.cwd]);
    if (!then)
      return answer("inconclusive", "the runner's report on the pre-task tree could not be read");
    if (before.exitCode === 0 && then.fail === 0 && then.errors === 0) {
      return then.pass === 0
        ? answer("not-applicable-on-parent", "the test collected nothing on the pre-task tree")
        : answer(
            "passed",
            "the same test passes on the pre-task tree — this change is not why it passes",
          );
    }
    const why = notAnAssertionFailure(then);
    if (why) return answer("not-applicable-on-parent", why);

    const after = await runWitness(witness.argv, workspaceRoot, env, timeoutMs, signal);
    if (after.aborted) return cancelled();
    const now = parseBunTestRun(after.output, [workspaceRoot]);
    if (
      after.timedOut ||
      after.exitCode !== 0 ||
      !now ||
      now.fail !== 0 ||
      now.errors !== 0 ||
      now.pass === 0
    )
      return answer(
        "inconclusive",
        "replayed on its own, the test does not pass on the current tree",
      );
    const names = then.failing.map(testLabel);
    return answer(
      "failed",
      `${names.length} assertion${names.length === 1 ? "" : "s"} failed on the pre-task tree and pass now: ${names.slice(0, 3).join("; ")}`,
    );
  } catch (err) {
    return answer(
      "inconclusive",
      `the replay errored: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    tree.dispose();
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Why a red run on the pre-task tree is not the test failing an assertion
 * there — or null when it is exactly that.
 */
function notAnAssertionFailure(run: ParsedTestRun): string | null {
  if (!attributable(run))
    return "the test could not load on the pre-task tree: something it needs is not there, and absence is not evidence";
  if (run.failing.length === 0) return "the runner named no failing test on the pre-task tree";
  const thrown = run.failing.filter((test) => !isAssertion(test.signature));
  if (thrown.length > 0)
    return `${testLabel(thrown[0]!)} did not fail an assertion on the pre-task tree — it threw, timed out or could not reach what it tests`;
  return null;
}

// ─── A check that existed before the run, on the tree the run started from ───
//
// `runOnParentCommit` checks out HEAD. HEAD is the last COMMIT, and a person's
// working tree is usually ahead of it: what they had fixed and not yet
// committed is not in HEAD, so a check that their own uncommitted work had
// already turned green "fails on the parent" — and the run is credited with a
// fix it found already made. The tree a run starts from is the one the loop
// captures before the first write (baseline.ts): HEAD, plus every uncommitted
// change and every untracked file, with a copy of the environment around it.
//
// The command, the classification and the refusal to read absence as evidence
// are `runOnParentCommit`'s own. What changes is the tree, that it is not a
// worktree registered in the user's repository, and that a cancel stops it.

const PRE_TASK = "the pre-task tree";

/** Paths the command names that exist now and were not in the pre-task tree. */
function namedPathsAbsentFromBaseline(
  workspaceRoot: string,
  baseline: TaskBaseline,
  command: string,
): string[] {
  const absent: string[] = [];
  for (const raw of command.split(/[\s;|&<>()]+/)) {
    const word = raw.replace(/^['"]+/, "").replace(/['"]+$/, "");
    if (!word || word.startsWith("-") || word.includes("..")) continue;
    if (word.startsWith("/") || /[*?$`{}\\]/.test(word)) continue;
    if (!/[./]/.test(word)) continue;
    const rel = word.replace(/^\.\//, "");
    if (!rel || !existsSync(join(workspaceRoot, rel))) continue;
    const there = `${baseline.tree}:${baseline.prefix ? `${baseline.prefix}/` : ""}${rel}`;
    if (!git(baseline.repoRoot, ["cat-file", "-e", there], 10_000).ok && !absent.includes(rel))
      absent.push(rel);
  }
  return absent;
}

/**
 * Run a check that existed before the run against the tree the run started
 * from. The laid-out tree is removed whatever happens, a cancel included.
 */
export async function runOnPreTaskTree(input: {
  workspaceRoot: string;
  baseline: TaskBaseline;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ParentCheckResult> {
  const { workspaceRoot, baseline, command, signal } = input;
  const commit = baseline.head;
  const unknown = (reason: string): ParentCheckResult => ({
    status: "inconclusive",
    commit,
    reason,
  });
  if (signal?.aborted) return unknown("the replay was cancelled");
  const tree = await materialiseBaseline(baseline, {
    ...(signal ? { signal } : {}),
    budgetMs: 60_000,
  });
  if ("unavailable" in tree)
    return unknown(
      signal?.aborted
        ? "the replay was cancelled"
        : `${PRE_TASK} could not be laid out: ${tree.unavailable}`,
    );
  try {
    const ran = await runWitness(
      ["bash", "-c", command],
      tree.cwd,
      { ...process.env },
      input.timeoutMs ?? 120_000,
      signal,
    );
    if (ran.aborted) return unknown("the replay was cancelled");
    if (ran.timedOut || ran.exitCode === null)
      return unknown(`check did not complete on ${PRE_TASK}`);
    return readParentRun(ran.exitCode, ran.output, commit, PRE_TASK, () =>
      namedPathsAbsentFromBaseline(workspaceRoot, baseline, command),
    );
  } catch (err) {
    return unknown(`parent check errored: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    tree.dispose();
  }
}

/** The run began on a tree ahead of its commit: uncommitted work was already there. */
export function startedDirty(baseline: TaskBaseline): boolean {
  const atCommit = git(baseline.repoRoot, [
    "rev-parse",
    "--verify",
    "-q",
    `${baseline.head}^{tree}`,
  ]);
  return !atCommit.ok || atCommit.stdout !== baseline.tree;
}

/**
 * A check that existed before the run, asked the whole question.
 *
 * At the commit first, as it always was. A failure there is the claim
 * `verified` makes — unless the run began on uncommitted work, in which case
 * the commit is not the tree the run started from, and what was already there
 * may be why the check passes. Then, and only then, it is asked of the
 * pre-task tree too:
 *
 *   fails there as well    the run is why it passes now — `failed`, as before
 *   passes there           it was already fixed when the run began — `passed`
 *   cannot be said         nobody can say the run is why — `inconclusive`
 *
 * "The tree the run started from" is this RUN's, and work an earlier run of
 * the same task left uncommitted is in it. That work is the task's, not the
 * person's, and "it already passed there" would then be said of the task's own
 * fix. So the caller hands this tree over only when nothing of the task's can
 * be in it (`personsStartingTree`, engine.ts) and passes null otherwise —
 * which asks the commit alone, as it always was.
 */
export async function replayExistingCheck(input: {
  workspaceRoot: string;
  command: string;
  baseline: TaskBaseline | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ParentCheckResult> {
  const { workspaceRoot, command, baseline, signal } = input;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const atCommit = await runOnParentCommit(workspaceRoot, command, timeoutMs, signal);
  if (atCommit.status !== "failed" || !baseline || !startedDirty(baseline)) return atCommit;
  const before = await runOnPreTaskTree({
    workspaceRoot,
    baseline,
    command,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (before.status === "failed") return atCommit;
  const commit = atCommit.commit ? { commit: atCommit.commit } : {};
  if (before.status === "passed")
    return {
      status: "passed",
      ...commit,
      reason:
        "it fails at the commit and already passed on the tree this run started from — uncommitted work that was there before the run is why, not this change",
    };
  return {
    status: "inconclusive",
    ...commit,
    reason: `it fails at the commit, but this run began on uncommitted work and that tree gave no answer: ${before.reason ?? "unknown"}`,
  };
}
