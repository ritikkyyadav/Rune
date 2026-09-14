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

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Run `command` against the pre-change tree and report what happened.
 *
 * Never mutates the caller's working tree: the check runs inside a detached
 * worktree in the OS temp dir, which is removed in a finally block whatever
 * happens. Every failure path returns `inconclusive` rather than throwing —
 * an evidence probe that cannot answer must say so, not take the run down.
 */
export function runOnParentCommit(
  repoRoot: string,
  command: string,
  timeoutMs = 120_000,
): ParentCheckResult {
  const parent = resolveParentCommit(repoRoot);
  if (!parent) {
    return { status: "inconclusive", reason: "no parent commit to compare against" };
  }

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "rune-parent-check-"));
    const checkout = join(dir, "tree");
    const added = git(repoRoot, ["worktree", "add", "--detach", checkout, parent.sha], 60_000);
    if (!added.ok) {
      return {
        status: "inconclusive",
        commit: parent.sha,
        reason: `could not check out ${parent.ref}: ${added.stderr.slice(0, 160)}`,
      };
    }

    try {
      const res = spawnSync("bash", ["-c", command], {
        cwd: checkout,
        encoding: "utf8",
        timeout: timeoutMs,
        env: { ...process.env },
      });
      const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;

      if (res.signal || res.error) {
        return {
          status: "inconclusive",
          commit: parent.sha,
          reason: `check did not complete on ${parent.ref} (${res.signal ?? res.error?.message})`,
        };
      }
      const exitCode = res.status ?? 1;
      if (exitCode === 0) {
        return {
          status: "passed",
          commit: parent.sha,
          reason: `already passed on ${parent.ref} — this change is not why it passes`,
        };
      }
      if (looksLikeMissingEnvironment(exitCode, output)) {
        return {
          status: "inconclusive",
          commit: parent.sha,
          reason: `the ${parent.ref} tree is not set up to run this check (exit ${exitCode})`,
        };
      }
      // Before the exit code is read as a verdict: did the check RUN there?
      // A non-zero exit from a runner that collected nothing, or from a
      // command naming a file the parent commit never had, is a failure BY
      // ABSENCE — and absence is not evidence that this change is why the
      // check is green now.
      if (COULD_NOT_RUN.test(output)) {
        return {
          status: "not-applicable-on-parent",
          commit: parent.sha,
          reason: `the check did not run on ${parent.ref}: it collected nothing there (exit ${exitCode})`,
        };
      }
      const absent = namedPathsAbsentOnParent(repoRoot, parent.sha, command);
      if (absent.length > 0) {
        return {
          status: "not-applicable-on-parent",
          commit: parent.sha,
          reason:
            `${absent.slice(0, 3).join(", ")} did not exist on ${parent.ref}, so the check ` +
            `could not have run there (exit ${exitCode})`,
        };
      }
      return { status: "failed", commit: parent.sha, reason: `exit ${exitCode} on ${parent.ref}` };
    } finally {
      // Detach the worktree registration before the directory disappears, or
      // git keeps a stale entry in .git/worktrees forever.
      git(repoRoot, ["worktree", "remove", "--force", checkout], 30_000);
    }
  } catch (err) {
    return {
      status: "inconclusive",
      commit: parent.sha,
      reason: `parent check errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}
