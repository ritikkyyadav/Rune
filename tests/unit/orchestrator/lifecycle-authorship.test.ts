// ─── The authorship witnesses, at the source ───
//
// Promoted from `tests/verification/v8-acceptance-authorship-unreachable.test.ts`
// and `v8-acceptance-committed-check.test.ts`.
//
// V7 finding 8 was answered with two witnesses — the write ledger and git — and
// both arrive through ONE producer:
//
//     CheckLog.record → authoredThisTask(commandProgramPaths(run.command))
//
// The third pass found the producer unwired for the only command shape anyone
// uses. `commandProgramPaths` returned the ENTRY SCRIPT, which is the first
// positional after a script host; a test runner's first positional is its
// SUBCOMMAND, so `bun test tests/mine.test.ts` returned `[]`, `authoredThisTask`
// returned on `paths.length === 0`, and `authoredBy` was never recorded. It
// survived because the lane's only test set `authoredBy` directly on a
// `CheckRun` — the defence proved at the consumer and unwired at the source.
// These tests go through the producer.
//
// And where a program WAS resolved, `git status` stopped being a witness the
// moment the run committed the check it wrote, which is how a task normally
// ends. A commit made during the task is the task's work.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notFromParentCommit, takeTaskEpoch } from "../../../packages/orchestrator/src/lifecycle";
import {
  commandProgramPaths,
  runsWholeSuite,
} from "../../../packages/orchestrator/src/verification-command";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=V8", "-c", "user.email=v8@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** A repo whose parent commit is `seed`, with the run's own check on top. */
function repo(commitAs: "none" | "model" | "rune"): { dir: string; seed: string } {
  const dir = mkdtempSync(join(tmpdir(), "v8-authorship-"));
  git(dir, "init", "-q", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-qm", "seed");
  const seed = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "check.mjs"), "console.log('1 pass, 0 fail');\n");
  if (commitAs !== "none") {
    git(dir, "add", "check.mjs");
    git(
      dir,
      "commit",
      "-qm",
      commitAs === "rune" ? "rune: add the acceptance check" : "chore: add the acceptance check",
    );
  }
  return { dir, seed };
}

describe("a test runner's arguments are the programs it runs (V8 critical 4)", () => {
  test("a bare script check still resolves its program — the control", () => {
    expect(commandProgramPaths("node ./check.mjs")).toEqual(["./check.mjs"]);
    expect(commandProgramPaths("./verify.sh")).toEqual(["./verify.sh"]);
  });

  test("every runner shape hands the witnesses a path", () => {
    expect(commandProgramPaths("bun test tests/mine.test.ts")).toEqual(["tests/mine.test.ts"]);
    expect(commandProgramPaths("bun test tests/unit tests/integration")).toEqual([
      "tests/unit",
      "tests/integration",
    ]);
    expect(commandProgramPaths("npx vitest run --dir tests")).toEqual(["tests"]);
    expect(commandProgramPaths("npx jest tests/api.test.js")).toEqual(["tests/api.test.js"]);
    expect(commandProgramPaths("python3 -m pytest tests/test_api.py")).toEqual([
      "tests/test_api.py",
    ]);
    expect(commandProgramPaths("node --test tests/unit")).toEqual(["tests/unit"]);
    expect(commandProgramPaths("npm test -- tests/mine.test.ts")).toEqual(["tests/mine.test.ts"]);
  });

  test("a shell wrapper is unwrapped, not handed to git whole", () => {
    // `bash -lc '…'` was worse than useless: `git status --porcelain --` got
    // the entire inner command as a `path`, which can never match anything.
    // The flag bundle is read by its letters, so -lc, -c and -ec all mean -c.
    expect(commandProgramPaths("bash -lc 'bun test tests/mine.test.ts'")).toEqual([
      "tests/mine.test.ts",
    ]);
    expect(commandProgramPaths("sh -c 'npx vitest run tests/a.test.ts'")).toEqual([
      "tests/a.test.ts",
    ]);
  });

  test("a glob is expanded against the tree, because the witnesses take paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "v8-glob-"));
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "a.test.ts"), "");
    writeFileSync(join(dir, "tests", "b.test.ts"), "");
    const paths = commandProgramPaths("bun test 'tests/**/*.test.ts'", { root: dir });
    expect(paths.sort()).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
    // Without a root there is nothing to expand against, and the pattern is
    // kept verbatim rather than invented away: it matches nothing downstream.
    expect(commandProgramPaths("bun test 'tests/**/*.test.ts'")).toEqual(["tests/**/*.test.ts"]);
  });

  test("a runner over the whole suite says so rather than saying nothing", () => {
    // No file to hand the witnesses — but the suite IS the program, so the
    // caller's write ledger can still answer. `[]` and "not a runner" were the
    // same answer before, and they are not the same fact.
    expect(commandProgramPaths("bun test")).toEqual([]);
    expect(runsWholeSuite("bun test")).toBe(true);
    expect(runsWholeSuite("npm test")).toBe(true);
    expect(runsWholeSuite("cargo test --locked --workspace")).toBe(true);
    expect(runsWholeSuite("bun test tests/mine.test.ts")).toBe(false);
    expect(runsWholeSuite("node ./check.mjs")).toBe(false);
  });
});

describe("a commit made during the task is the task's work (V8 critical 5)", () => {
  test("an uncommitted run-authored check is caught — the control", () => {
    const { dir } = repo("none");
    expect(notFromParentCommit(dir, ["check.mjs"])).toBe("check.mjs");
  });

  test("the run commits its own check, and the commit the task opened at sees it", () => {
    // `git status` is clean for a committed path, so the only witness left said
    // "not self-authored" about the file the run had just written. Everything
    // between the task's base commit and HEAD was committed DURING the task.
    const { dir, seed } = repo("model");
    expect(notFromParentCommit(dir, ["check.mjs"])).toBeUndefined();
    expect(notFromParentCommit(dir, ["check.mjs"], { since: seed })).toBe("check.mjs");
  });

  test("a Rune auto-commit is durable, so a NEW session still sees it", () => {
    // A brand-new `rune` invocation restores no contract row, so `since` is
    // HEAD and proves nothing. The auto-commit's own subject prefix survives in
    // git, which is where the work is.
    const { dir } = repo("rune");
    expect(notFromParentCommit(dir, ["check.mjs"])).toBe("check.mjs");
  });

  test("the repo's own program is not the run's, by either route", () => {
    // The cost of a wrong yes is a refused honest citation, so the seed commit's
    // own files stay the commit's files.
    const { dir, seed } = repo("model");
    expect(notFromParentCommit(dir, ["README.md"], { since: seed })).toBeUndefined();
    expect(notFromParentCommit(dir, ["README.md"])).toBeUndefined();
  });
});

// ─── V9 finding 8: the durable witness read the commit MESSAGE ───
//
// `since..HEAD` is exact and it is empty in a brand-new session, where
// `baseCommit` is HEAD. So across sessions the only witness left was
// `--grep='^rune: '` — and this repo's own commits are `docs:`, `ui:`, `ci:`,
// `install:`, `tests:`. A run that wrote its own oracle, committed it the way
// a task normally ends, and stopped was unattributed for every session after.
// A commit message is the one part of a commit its author chooses; the tree is
// not, so the second reading is a tree diff from the previous task's base.
describe("the durable witness reads the tree, not the subject (V9 finding 8)", () => {
  test("a `chore:` commit made during the task is the task's work in the NEXT session", () => {
    const { dir, seed } = repo("model"); // committed as "chore: add the acceptance check"
    const head = git(dir, "rev-parse", "HEAD").trim();
    // In-session: `since` is the parent, and it was already caught.
    expect(notFromParentCommit(dir, ["check.mjs"], { since: seed })).toBe("check.mjs");
    // A new session: `baseCommit` is HEAD, so `since..HEAD` is empty and the
    // subject says nothing. With the epoch — the base of the task before this
    // one — the tree answers.
    expect(notFromParentCommit(dir, ["check.mjs"], { since: head })).toBeUndefined();
    expect(notFromParentCommit(dir, ["check.mjs"], { since: head, epoch: seed })).toBe("check.mjs");
  });

  test("an amended subject does not change what the tree says", () => {
    const { dir, seed } = repo("rune");
    git(dir, "commit", "-q", "--amend", "-m", "chore: three");
    const head = git(dir, "rev-parse", "HEAD").trim();
    expect(notFromParentCommit(dir, ["check.mjs"], { since: head, epoch: seed })).toBe("check.mjs");
  });

  test("a file the epoch window never touched is still the repo's", () => {
    const { dir, seed } = repo("model");
    const head = git(dir, "rev-parse", "HEAD").trim();
    expect(notFromParentCommit(dir, ["README.md"], { since: head, epoch: seed })).toBeUndefined();
  });

  test("the epoch is the PREVIOUS task's base, recorded beside the database", () => {
    const { dir, seed } = repo("model");
    const state = mkdtempSync(join(tmpdir(), "v9-epoch-"));
    // First task ever in this workspace: nothing to look back to.
    expect(takeTaskEpoch(state, dir, seed)).toBeNull();
    const head = git(dir, "rev-parse", "HEAD").trim();
    // The next task opens at HEAD and is handed the base of the one before it.
    expect(takeTaskEpoch(state, dir, head)).toBe(seed);
    expect(takeTaskEpoch(state, dir, head)).toBe(head);
    // Another workspace is another epoch.
    expect(takeTaskEpoch(state, join(dir, "sub"), head)).toBeNull();
    // A head git cannot name records nothing and claims nothing.
    expect(takeTaskEpoch(state, dir, null)).toBe(head);
  });
});
