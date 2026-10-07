/**
 * The parent-commit probe, against real git.
 *
 * `verified` claims "a test that failed on the parent commit passes now". The
 * runtime used to infer that from in-session red→green, which is a different
 * and much weaker fact. This module makes the measurement instead — in a
 * detached worktree, so the user's working tree is never touched — and these
 * tests hold it to the two properties that matter:
 *
 *   1. it distinguishes a genuine parent failure from a parent that was green;
 *   2. it refuses to call a missing environment a failure, because doing so
 *      would manufacture exactly the false receipt the probe exists to prevent.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { captureBaseline, type TaskBaseline } from "../../../packages/orchestrator/src/baseline";
import {
  couldNotRunOnParent,
  namedPathsAbsentOnParent,
  replayExistingCheck,
  replayWitness,
  runOnParentCommit,
  runOnPreTaskTree,
  resolveParentCommit,
  startedDirty,
  witnessFor,
  type Witness,
} from "../../../packages/orchestrator/src/parent-check";

let repo: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rune-parent-check-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Rune Test");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Commit a `check.sh` that exits with `code`. */
function commitCheck(code: number, message: string): void {
  writeFileSync(join(repo, "check.sh"), `#!/bin/sh\nexit ${code}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/**
 * POSIX-only: the fixture check IS `sh check.sh`, and the subject is "did this
 * check pass on the PARENT commit", not the shell that ran it. Windows has no
 * `sh`; a `.cmd` fixture would exercise the same logic through a different
 * shell, which is worth doing when someone runs Rune's verifier on Windows and
 * not before. Logged in docs/program/backlog.md.
 */
const POSIX_SHELL = process.platform !== "win32";

describe.skipIf(!POSIX_SHELL)("runOnParentCommit", () => {
  test("a check that FAILS on the parent commit is reported as failed", async () => {
    commitCheck(1, "broken check");
    // The working tree now "fixes" it — uncommitted, as agent work usually is.
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");

    const result = await runOnParentCommit(repo, "sh check.sh");
    expect(result.status).toBe("failed");
    expect(result.commit).toBe(git("rev-parse", "HEAD"));
  });

  test("a check that already PASSED on the parent is reported as passed", async () => {
    commitCheck(0, "green check");
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");

    const result = await runOnParentCommit(repo, "sh check.sh");
    expect(result.status).toBe("passed");
    expect(result.reason).toContain("not why it passes");
  });

  test("a missing program is INCONCLUSIVE, never a parent failure", async () => {
    // Exit 127. Under a naive implementation this reads as "the check failed
    // on the parent", which would mint `verified` for a change that fixed
    // nothing — the precise false receipt this module exists to prevent.
    commitCheck(0, "base");

    const result = await runOnParentCommit(repo, "rune-definitely-not-a-real-binary --version");
    expect(result.status).toBe("inconclusive");
  });

  test("a missing dependency is INCONCLUSIVE, not a parent failure", async () => {
    commitCheck(0, "base");

    const result = await runOnParentCommit(
      repo,
      "sh -c 'echo \"Error: Cannot find module foo\" >&2; exit 1'",
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("not set up");
  });

  test("the user's working tree is untouched, and no worktree is left behind", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(repo, "uncommitted-scratch.txt"), "precious");

    const before = git("status", "--porcelain");
    const result = await runOnParentCommit(repo, "sh check.sh");

    expect(result.status).toBe("failed");
    // Nothing stashed, nothing reverted, nothing swept.
    expect(git("status", "--porcelain")).toBe(before);
    expect(existsSync(join(repo, "uncommitted-scratch.txt"))).toBe(true);
    // And no stale registration in .git/worktrees.
    const wt = join(repo, ".git", "worktrees");
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });

  test("a repo with no commits cannot answer, and says so instead of guessing", async () => {
    const result = await runOnParentCommit(repo, "true");
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("no parent commit");
  });
});

describe.skipIf(!POSIX_SHELL)("resolveParentCommit", () => {
  test("HEAD is the pre-change tree when the agent's work is uncommitted", () => {
    commitCheck(0, "base");
    expect(resolveParentCommit(repo)).toEqual({ sha: git("rev-parse", "HEAD"), ref: "HEAD" });
  });

  test("a landed Rune auto-commit shifts the comparison to HEAD~1", () => {
    commitCheck(1, "base");
    const base = git("rev-parse", "HEAD");
    // [git] autoCommit lands the run as one commit with this exact prefix.
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "rune: fix the check");

    expect(resolveParentCommit(repo)).toEqual({ sha: base, ref: "HEAD~1" });
  });

  test("a Rune commit that is the repo's first commit has no parent to compare", () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "rune: initial");

    expect(resolveParentCommit(repo)).toBeNull();
  });
});

// ─── "It failed on the parent" must not be satisfiable by absence ───
//
// V-5B, F2: a brand-new test file exits non-zero at the parent commit because
// it is not there, and the ladder read that exit code as the reproduction of a
// bug. Two independent readings close it — what the runner SAID, and what the
// command NAMED — and both are held to examples here, because the vocabulary
// is the whole content of the distinction.

describe("couldNotRunOnParent", () => {
  const collectedNothing: Array<[string, string]> = [
    ["bun", "bun test v1.3.14\n\n 0 pass\n 0 fail\nRan 0 tests across 0 files."],
    ["pytest", "===== test session starts =====\ncollected 0 items\n\n==== no tests ran ===="],
    ["jest", "Test Suites: 0 total\nTests:       0 total\nSnapshots:   0 total"],
    ["cargo", "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored"],
    ["go", "?   example.com/pkg\t[no test files]"],
    ["npm script", 'npm error Missing script: "check:csv"'],
    ["python", "python3: can't open file '/tmp/x/new_check.py': [Errno 2] No such file"],
    ["node --test", "node --test\nno test files found"],
    ["an unknown subcommand", "error: unknown command 'verify'"],
    ["a usage error", "usage: check [-v] <path>"],
  ];
  for (const [runner, output] of collectedNothing) {
    test(`${runner} saying it ran nothing is not a parent failure`, () => {
      expect(couldNotRunOnParent(output)).toBe(true);
    });
  }

  test("a runner that ran and FAILED is left alone — this is the real evidence", () => {
    expect(couldNotRunOnParent(" 0 pass\n 3 fail\nRan 3 tests across 1 file.")).toBe(false);
    expect(couldNotRunOnParent("collected 12 items\n\nFAILED tests/test_csv.py::test_header")).toBe(
      false,
    );
    expect(couldNotRunOnParent("test result: FAILED. 4 passed; 1 failed; 0 ignored")).toBe(false);
    expect(couldNotRunOnParent("error TS2345: Argument of type X\n3 errors")).toBe(false);
  });
});

describe.skipIf(!POSIX_SHELL)("namedPathsAbsentOnParent", () => {
  test("a file the command names that the parent commit never had is reported", () => {
    commitCheck(0, "base");
    // Written but never committed — the shape of a brand-new test file.
    writeFileSync(join(repo, "forged.test.ts"), "// new\n");
    const sha = git("rev-parse", "HEAD");

    expect(namedPathsAbsentOnParent(repo, sha, "bun test forged.test.ts")).toEqual([
      "forged.test.ts",
    ]);
  });

  test("a file that existed at the parent draws no conclusion", () => {
    commitCheck(0, "base");
    const sha = git("rev-parse", "HEAD");
    expect(namedPathsAbsentOnParent(repo, sha, "sh check.sh")).toEqual([]);
  });

  test("a word that is not a file here is never read as a missing file there", () => {
    commitCheck(0, "base");
    const sha = git("rev-parse", "HEAD");
    // Flags, bare program names, a path missing on BOTH sides, and tokenising
    // artefacts all have to draw nothing, or every command names a ghost.
    expect(
      namedPathsAbsentOnParent(repo, sha, "node --test --reporter=dot console.log a,b,c ./nope.ts"),
    ).toEqual([]);
  });

  test("the end-to-end probe calls a new file's failure NOT-APPLICABLE, not failed", async () => {
    commitCheck(0, "base");
    // A check that did not exist at the parent commit: `sh new-check.sh` exits
    // non-zero there because the file is absent, which says nothing about the
    // change under test.
    writeFileSync(join(repo, "new-check.sh"), "#!/bin/sh\nexit 0\n");

    const result = await runOnParentCommit(repo, "sh new-check.sh 2>/dev/null; exit 1");
    expect(result.status).toBe("not-applicable-on-parent");
    expect(result.reason).toContain("new-check.sh");
  });
});

// ─── A test the run wrote, replayed on the tree the run started from ───
//
// R1. Before this a new regression test could not earn `verified` by any path,
// and the fix-verified gate asked for one anyway. What is held here is that a
// GENUINE one now can — and that every way of faking one still cannot.

const put = (files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
};

const BROKEN = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n - 1);\n";
const FIXED = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n);\n";
const REGRESSION =
  'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
  'test("lastN takes the last n", () => {\n  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n});\n';

/** A committed project with the bug in it; the tree a run would start from. */
function project(extra: Record<string, string> = {}): void {
  put({
    "package.json": '{ "name": "window", "type": "module" }\n',
    "window.ts": BROKEN,
    ...extra,
  });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

/** What the run did: the baseline taken first, as the loop takes it, then the files written. */
function run(written: Record<string, string>): TaskBaseline {
  const baseline = captureBaseline(repo);
  if (!baseline) throw new Error("no baseline could be taken");
  put(written);
  return baseline;
}

const eligible = (command: string): Witness => {
  const witness = witnessFor(repo, command);
  if ("ineligible" in witness) throw new Error(`no witness: ${witness.ineligible}`);
  return witness;
};
const replay = (baseline: TaskBaseline, command: string, over: object = {}) =>
  replayWitness({ workspaceRoot: repo, baseline, witness: eligible(command), ...over });

/** Trees and homes a replay lays out in the temp directory. */
const laidOut = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith("rune-baseline-") || name.startsWith("rune-replay-home-"))
    .sort();

describe.skipIf(!POSIX_SHELL)("witnessFor: the one shape that is replayed", () => {
  beforeEach(() => {
    project({ "window.regress.test.ts": REGRESSION, "tests/unit/a.spec.tsx": "// a\n" });
  });

  test("`bun test <test files>` has a witness: an argv, the files, and a digest of both", () => {
    const witness = eligible("bun test window.regress.test.ts ./tests/unit/a.spec.tsx");
    expect(witness.argv).toEqual([
      "bun",
      "test",
      "./window.regress.test.ts",
      "./tests/unit/a.spec.tsx",
    ]);
    expect(witness.files).toEqual(["window.regress.test.ts", "tests/unit/a.spec.tsx"]);
    expect(witness.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same command over the same bytes is the same witness, however it was spaced.
    expect(eligible("  bun   test ./window.regress.test.ts tests/unit/a.spec.tsx ").digest).toBe(
      witness.digest,
    );
    // Another file, or another set of files, is another witness.
    expect(eligible("bun test window.regress.test.ts").digest).not.toBe(witness.digest);
    // The same bytes under another name are another witness too: the name is
    // where it is laid over the old tree, and what its imports resolve against.
    put({ "copy.test.ts": REGRESSION });
    expect(eligible("bun test copy.test.ts").digest).not.toBe(
      eligible("bun test window.regress.test.ts").digest,
    );
  });

  test("the digest covers every byte of the test: edit it and it is another witness", () => {
    const before = eligible("bun test window.regress.test.ts").digest;
    put({ "window.regress.test.ts": REGRESSION.replace("[2, 3]", "[1, 2, 3]") });
    const weakened = eligible("bun test window.regress.test.ts").digest;
    expect(weakened).not.toBe(before);
    put({ "window.regress.test.ts": REGRESSION });
    expect(eligible("bun test window.regress.test.ts").digest).toBe(before);
  });

  test("the model's command is never replayed: anything but that shape has no witness", () => {
    const refused = (command: string) => {
      const witness = witnessFor(repo, command);
      return "ineligible" in witness ? witness.ineligible : "ELIGIBLE";
    };
    // Shell syntax of any kind: a second command, a redirect, a variable, a quote.
    for (const command of [
      "bun test window.regress.test.ts; exit 1",
      "bun test window.regress.test.ts || true",
      "bun test window.regress.test.ts && echo ok",
      "bun test window.regress.test.ts > /dev/null",
      "bun test window.regress.test.ts | tee log",
      "FORCE=1 bun test window.regress.test.ts",
      "bun test $(echo window.regress.test.ts)",
      "bun test `ls`",
      'bun test "window.regress.test.ts"',
      "bun test *.test.ts",
      "bun test window.regress.test.ts # ok",
      "bun test window.regress.test.ts\nrm -rf x",
    ])
      expect({ command, said: refused(command) }).toEqual({
        command,
        said: "the command uses shell syntax; only a plain `bun test <test files>` is replayed",
      });
    // Another program, or this one asked to do something else.
    for (const command of [
      "sh check.sh",
      "npx jest window.regress.test.ts",
      "bun run test",
      "bunx tsc --noEmit",
    ])
      expect(refused(command)).toBe(
        "only `bun test <test files>` is replayed for a test this run wrote",
      );
    expect(refused("bun test")).toBe("the command names no test file");
    // A flag changes what runs, and what it loads first.
    expect(refused("bun test --preload ./setup.ts window.regress.test.ts")).toBe(
      "--preload: a flag is not replayed",
    );
    expect(refused("bun test window.regress.test.ts -t lastN")).toBe("-t: a flag is not replayed");
    // A production file is not a test, whatever runs it.
    expect(refused("bun test window.ts")).toBe("window.ts: not a test file");
    expect(refused("bun test package.json")).toBe("package.json: not a test file");
    // Only what is in the workspace, as a regular file.
    expect(refused("bun test ../outside.test.ts")).toBe(
      "../outside.test.ts: not a path inside the workspace",
    );
    expect(refused("bun test /etc/x.test.ts")).toBe(
      "/etc/x.test.ts: not a path inside the workspace",
    );
    expect(refused("bun test absent.test.ts")).toBe("absent.test.ts: not in the workspace");
    expect(refused("bun test window.regress.test.ts window.regress.test.ts")).toBe(
      "window.regress.test.ts: named twice",
    );
    symlinkSync(join(repo, "window.ts"), join(repo, "linked.test.ts"));
    expect(refused("bun test linked.test.ts")).toBe("linked.test.ts: not a regular file");
    mkdirSync(join(repo, "dir.test.ts"));
    expect(refused("bun test dir.test.ts")).toBe("dir.test.ts: not a regular file");
    put({ "huge.test.ts": "// x\n".repeat(250_000) });
    expect(refused("bun test huge.test.ts")).toBe("huge.test.ts: too large to replay");
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}.test.ts`);
    put(Object.fromEntries(nine.map((name) => [name, "// t\n"])));
    expect(refused(`bun test ${nine.join(" ")}`)).toBe("the command names more than 8 files");
    expect(refused(`bun test ${nine.slice(0, 8).join(" ")}`)).toBe("ELIGIBLE");
  });
});

describe.skipIf(!POSIX_SHELL)("replayWitness", () => {
  test("a genuine new regression test: it fails on the pre-task tree and passes now", async () => {
    project();
    const before = laidOut();
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": REGRESSION });
    const status = git("status", "--porcelain");
    const witness = eligible("bun test window.regress.test.ts");
    const result = await replayWitness({ workspaceRoot: repo, baseline, witness });
    expect(result).toEqual({
      status: "failed",
      reason:
        "1 assertion failed on the pre-task tree and pass now: window.regress.test.ts :: lastN takes the last n",
      witness: witness.digest,
      baseline: baseline.tree,
      commit: git("rev-parse", "HEAD"),
    });
    // Nothing of the user's moved, nothing is registered, nothing is left behind.
    expect(git("status", "--porcelain")).toBe(status);
    const worktrees = join(repo, ".git", "worktrees");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(laidOut()).toEqual(before);
  }, 60_000);

  test("a test that passes on the pre-task tree too: the change is not why it passes", async () => {
    project();
    // The run "fixed" nothing the test can see: it asserts what was already true.
    const always =
      'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
      'test("lastN returns an array", () => {\n  expect(Array.isArray(lastN([1], 1))).toBe(true);\n});\n';
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": always });
    expect(await replay(baseline, "bun test window.regress.test.ts")).toMatchObject({
      status: "passed",
      reason: "the same test passes on the pre-task tree — this change is not why it passes",
    });
  }, 60_000);

  test("a fix copied into the test file is laid over the old tree with it, and proves nothing", async () => {
    project();
    // The "test" carries the fixed implementation and tests that.
    const selfContained =
      'import { expect, test } from "bun:test";\n' +
      "const lastN = <T>(items: T[], n: number): T[] => items.slice(-n);\n" +
      'test("lastN takes the last n", () => {\n  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n});\n';
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": selfContained });
    expect((await replay(baseline, "bun test window.regress.test.ts")).status).toBe("passed");
  }, 60_000);

  test("a test that needs a module the run created cannot load on the old tree: absence, not evidence", async () => {
    project();
    // The fix lives in a NEW production file. Only test files are laid over the
    // pre-task tree, so the fix does not ride along with its test.
    const viaNewModule = REGRESSION.replace('"./window"', '"./window-fixed"');
    const baseline = run({ "window-fixed.ts": FIXED, "window.regress.test.ts": viaNewModule });
    expect(await replay(baseline, "bun test window.regress.test.ts")).toMatchObject({
      status: "not-applicable-on-parent",
      reason:
        "the test could not load on the pre-task tree: something it needs is not there, and absence is not evidence",
    });
    // The same for a new export of an old module.
    const viaNewExport = REGRESSION.replaceAll("lastN", "lastItems");
    put({
      "window.ts": FIXED.replace("lastN", "lastItems"),
      "window.regress.test.ts": viaNewExport,
    });
    git("checkout", "-q", "--", "window.ts");
    const second = run({
      "window.ts": `${BROKEN}${FIXED.replace("lastN", "lastItems")}`,
      "window.regress.test.ts": viaNewExport,
    });
    expect((await replay(second, "bun test window.regress.test.ts")).status).toBe(
      "not-applicable-on-parent",
    );
  }, 60_000);

  test("a test that THROWS on the old tree did not fail an assertion there", async () => {
    project();
    // It reaches for something the old tree does not have, at run time.
    const throws =
      'import { expect, test } from "bun:test";\nimport * as w from "./window";\n' +
      'test("lastItems takes the last n", () => {\n' +
      "  expect((w as any).lastItems([1, 2, 3], 2)).toEqual([2, 3]);\n});\n";
    const baseline = run({
      "window.ts": `${BROKEN}${FIXED.replace("lastN", "lastItems")}`,
      "window.regress.test.ts": throws,
    });
    const result = await replay(baseline, "bun test window.regress.test.ts");
    expect(result.status).toBe("not-applicable-on-parent");
    expect(result.reason).toBe(
      "window.regress.test.ts :: lastItems takes the last n did not fail an assertion on the pre-task tree — it threw, timed out or could not reach what it tests",
    );
  }, 60_000);

  test("an Error the test raises itself is not read as an assertion either", async () => {
    project();
    // `error: lastN is wrong` is the runner reporting a throw. Only an `expect`
    // that did not hold is taken as the test saying what it found.
    const handRolled =
      'import { test } from "bun:test";\nimport { lastN } from "./window";\n' +
      'test("lastN takes the last n", () => {\n' +
      '  if (lastN([1, 2, 3], 2).length !== 2) throw new Error("lastN is wrong");\n});\n';
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": handRolled });
    const result = await replay(baseline, "bun test window.regress.test.ts");
    expect(result.status).toBe("not-applicable-on-parent");
    expect(result.reason).toContain("did not fail an assertion on the pre-task tree");
  }, 60_000);

  test("one real assertion beside one that threw is still not a clean failure", async () => {
    project();
    const mixed =
      REGRESSION +
      'import * as w from "./window";\n' +
      'test("and a new export exists", () => {\n  expect((w as any).lastItems([1], 1)).toEqual([1]);\n});\n';
    const baseline = run({
      "window.ts": `${FIXED}${FIXED.replace("lastN", "lastItems")}`,
      "window.regress.test.ts": mixed,
    });
    expect((await replay(baseline, "bun test window.regress.test.ts")).status).toBe(
      "not-applicable-on-parent",
    );
  }, 60_000);

  test("a test file that collects nothing measured nothing", async () => {
    project();
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": "export {};\n" });
    const result = await replay(baseline, "bun test window.regress.test.ts");
    expect(result.status).toBe("not-applicable-on-parent");
  }, 60_000);

  test("a test that exits without a report is not a failure anyone can read", async () => {
    project();
    // It ends the process itself: no test ran, and nothing the runner says can be parsed.
    const baseline = run({
      "window.ts": FIXED,
      "window.regress.test.ts": 'console.log("(fail) forged");\nprocess.exit(1);\n',
    });
    const result = await replay(baseline, "bun test window.regress.test.ts");
    expect(["inconclusive", "not-applicable-on-parent"]).toContain(result.status);
    expect(result.status).not.toBe("failed");
  }, 60_000);

  test("a changed manifest or lockfile: the two runs would not share an environment", async () => {
    for (const [file, text] of [
      ["package.json", '{ "name": "window", "type": "module", "dependencies": {} }\n'],
      ["bun.lock", "# changed\n"],
      ["bunfig.toml", '[test]\npreload = ["./setup.ts"]\n'],
    ] as const) {
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo);
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Rune Test");
      git("config", "commit.gpgsign", "false");
      project({ "bun.lock": "# base\n" });
      const baseline = run({
        "window.ts": FIXED,
        "window.regress.test.ts": REGRESSION,
        [file]: text,
      });
      const result = await replay(baseline, "bun test window.regress.test.ts");
      expect({ file, status: result.status, reason: result.reason }).toEqual({
        file,
        status: "inconclusive",
        reason: `${file} changed since the pre-task tree: the two runs would not share an environment`,
      });
    }
  }, 60_000);

  test("what the person had not committed is part of the tree the run started from", async () => {
    project();
    // Before the run began, the person had already fixed the bug and not committed it.
    put({ "window.ts": FIXED });
    // The run only adds the test. HEAD still has the bug; the pre-task tree does not.
    const baseline = run({ "window.regress.test.ts": REGRESSION });
    expect(git("show", "HEAD:window.ts")).toContain("-n - 1");
    const result = await replay(baseline, "bun test window.regress.test.ts");
    expect(result.status).toBe("passed");
    // And the other way round: the bug is in their uncommitted work, and the run fixes it.
    git("checkout", "-q", "--", "window.ts");
    rmSync(join(repo, "window.regress.test.ts"));
    put({ "window.ts": FIXED });
    git("commit", "-q", "-am", "fixed at HEAD");
    put({ "window.ts": BROKEN });
    const dirty = run({ "window.ts": FIXED, "window.regress.test.ts": REGRESSION });
    expect((await replay(dirty, "bun test window.regress.test.ts")).status).toBe("failed");
  }, 60_000);

  test("the replay sees no ambient credential", async () => {
    project();
    process.env.RUNE_REPLAY_SECRET = "s3cret";
    try {
      const guarded =
        REGRESSION +
        'test("no credential reaches a replay", () => {\n' +
        "  expect(process.env.RUNE_REPLAY_SECRET).toBeUndefined();\n" +
        "  expect(process.env.HOME).not.toBe(" +
        JSON.stringify(process.env.HOME ?? "") +
        ");\n});\n";
      const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": guarded });
      // Had the variable leaked, the second test would fail on BOTH trees and
      // the witness would not pass on the current one.
      const result = await replay(baseline, "bun test window.regress.test.ts");
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("1 assertion failed");
    } finally {
      delete process.env.RUNE_REPLAY_SECRET;
    }
  }, 60_000);

  test("a witness that does not pass on the current tree earns nothing", async () => {
    project();
    // The test fails before AND after: the "fix" does not fix it.
    const baseline = run({
      "window.ts": BROKEN + "// touched\n",
      "window.regress.test.ts": REGRESSION,
    });
    expect(await replay(baseline, "bun test window.regress.test.ts")).toMatchObject({
      status: "inconclusive",
      reason: "replayed on its own, the test does not pass on the current tree",
    });
  }, 60_000);

  test("a test that outlasts its deadline on the old tree is unknown, and nothing is left running", async () => {
    project();
    const slow =
      'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
      'test("slow", async () => {\n  await new Promise((r) => setTimeout(r, 30_000));\n' +
      "  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n}, 60_000);\n";
    const before = laidOut();
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": slow });
    const started = Date.now();
    const result = await replay(baseline, "bun test window.regress.test.ts", { timeoutMs: 1_500 });
    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "the test did not finish on the pre-task tree",
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(laidOut()).toEqual(before);
  }, 60_000);

  test("a cancelled replay stops, says so, and cleans up after itself", async () => {
    project();
    const slow =
      'import { expect, test } from "bun:test";\n' +
      'test("slow", async () => {\n  await new Promise((r) => setTimeout(r, 30_000));\n' +
      "  expect(1).toBe(2);\n}, 60_000);\n";
    const before = laidOut();
    const baseline = run({ "window.ts": FIXED, "window.regress.test.ts": slow });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 700);
    const result = await replay(baseline, "bun test window.regress.test.ts", {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: "inconclusive", reason: "the replay was cancelled" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(laidOut()).toEqual(before);
    // Cancelled before it began: nothing is laid out at all.
    const done = new AbortController();
    done.abort();
    expect(
      (await replay(baseline, "bun test window.regress.test.ts", { signal: done.signal })).reason,
    ).toBe("the replay was cancelled");
    expect(laidOut()).toEqual(before);
  }, 60_000);
});

// ─── A check that existed before the run, when the run began on uncommitted work ───
//
// The commit is not the tree a run starts from when the person's working tree
// is ahead of it. What they had already fixed is not the run's to be credited
// with — and the old probe, asking only the commit, credited it.

const baselineNow = (): TaskBaseline => {
  const baseline = captureBaseline(repo);
  if (!baseline) throw new Error("no baseline could be taken");
  return baseline;
};
const GREEN = "#!/bin/sh\nexit 0\n";

describe.skipIf(!POSIX_SHELL)("replayExistingCheck", () => {
  test("clean when the run began: the commit IS the tree, and is asked as it always was", async () => {
    commitCheck(1, "broken check");
    const baseline = baselineNow();
    expect(startedDirty(baseline)).toBe(false);
    const before = laidOut();
    writeFileSync(join(repo, "check.sh"), GREEN); // the run's fix
    const result = await replayExistingCheck({
      workspaceRoot: repo,
      command: "sh check.sh",
      baseline,
    });
    expect(result).toEqual({
      status: "failed",
      commit: git("rev-parse", "HEAD"),
      reason: "exit 1 on HEAD",
    });
    // Nothing was laid out: there was no second tree to ask.
    expect(laidOut()).toEqual(before);
  });

  test("the person had already fixed it and not committed: the run is not why it passes", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "check.sh"), GREEN); // the PERSON's uncommitted fix
    const baseline = baselineNow(); // the run begins here
    expect(startedDirty(baseline)).toBe(true);
    writeFileSync(join(repo, "notes.txt"), "the run wrote something else\n");
    // At the commit it fails — which is all the old probe ever asked.
    expect((await runOnParentCommit(repo, "sh check.sh")).status).toBe("failed");
    const before = laidOut();
    expect(
      await replayExistingCheck({ workspaceRoot: repo, command: "sh check.sh", baseline }),
    ).toEqual({
      status: "passed",
      commit: git("rev-parse", "HEAD"),
      reason:
        "it fails at the commit and already passed on the tree this run started from — uncommitted work that was there before the run is why, not this change",
    });
    expect(laidOut()).toEqual(before);
  });

  test("uncommitted work that did not fix it: the run is still why", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "wip.txt"), "the person's unrelated work\n");
    const baseline = baselineNow();
    expect(startedDirty(baseline)).toBe(true);
    writeFileSync(join(repo, "check.sh"), GREEN);
    expect(
      await replayExistingCheck({ workspaceRoot: repo, command: "sh check.sh", baseline }),
    ).toEqual({ status: "failed", commit: git("rev-parse", "HEAD"), reason: "exit 1 on HEAD" });
  });

  test("a staged change is uncommitted work too", () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "check.sh"), GREEN);
    git("add", "check.sh");
    expect(startedDirty(baselineNow())).toBe(true);
  });

  test("a check that did not fail at the commit, or a run with no baseline, is asked nothing more", async () => {
    commitCheck(0, "green check");
    writeFileSync(join(repo, "wip.txt"), "x\n");
    const before = laidOut();
    // Green at the commit is the whole answer: the starting tree is not asked.
    expect(
      await replayExistingCheck({
        workspaceRoot: repo,
        command: "sh check.sh",
        baseline: baselineNow(),
      }),
    ).toMatchObject({
      status: "passed",
      reason: "already passed on HEAD — this change is not why it passes",
    });
    git("add", "-A");
    git("commit", "-q", "-m", "more");
    writeFileSync(join(repo, "check.sh"), "#!/bin/sh\nexit 1\n");
    git("commit", "-q", "-am", "broken");
    writeFileSync(join(repo, "check.sh"), GREEN);
    expect(
      (await replayExistingCheck({ workspaceRoot: repo, command: "sh check.sh", baseline: null }))
        .status,
    ).toBe("failed");
    expect(laidOut()).toEqual(before);
  });

  test("a starting tree that cannot answer leaves the question open, and says which question", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "wip.txt"), "x\n");
    // A starting tree git no longer has: it cannot be laid out, so it cannot say.
    const baseline = { ...baselineNow(), tree: "0".repeat(40) };
    expect(
      await replayExistingCheck({ workspaceRoot: repo, command: "sh check.sh", baseline }),
    ).toEqual({
      status: "inconclusive",
      commit: git("rev-parse", "HEAD"),
      reason:
        "it fails at the commit, but this run began on uncommitted work and that tree gave no answer: the pre-task tree could not be laid out: the baseline tree could not be checked out",
    });
  });

  test("a cancel reaches the replay at the commit too: nothing is run there", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "ran.txt"), "");
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await replayExistingCheck({
        workspaceRoot: repo,
        // It would say so if it ran.
        command: `echo ran >> ${join(repo, "ran.txt")}; sh check.sh`,
        baseline: baselineNow(),
        signal: stopped.signal,
      }),
    ).toEqual({
      status: "inconclusive",
      commit: git("rev-parse", "HEAD"),
      reason: "the replay was cancelled",
    });
    expect(readFileSync(join(repo, "ran.txt"), "utf8")).toBe("");
  });
});

describe.skipIf(!POSIX_SHELL)("the replay at the commit does not hold the process", () => {
  const parentTrees = (): string[] =>
    readdirSync(tmpdir()).filter((name) => name.startsWith("rune-parent-check-"));

  test("a cancel during it stops the whole of it, and its worktree is taken back out", async () => {
    commitCheck(1, "broken check");
    const before = parentTrees();
    const stopped = new AbortController();
    let ticks = 0;
    // If the replay held the event loop, neither of these would run until it ended.
    const ticking = setInterval(() => ticks++, 20);
    setTimeout(() => stopped.abort(), 200);

    const startedAt = performance.now();
    const result = await runOnParentCommit(repo, "sleep 20; sh check.sh", 60_000, stopped.signal);
    clearInterval(ticking);

    expect(result).toEqual({
      status: "inconclusive",
      commit: git("rev-parse", "HEAD"),
      reason: "the replay was cancelled",
    });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(3);
    // Nothing registered in the repository, nothing left in the temp directory.
    const wt = join(repo, ".git", "worktrees");
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
    expect(parentTrees()).toEqual(before);
  });

  test("a process stopped mid-replay takes the replay with it: nothing left running, nothing left registered", async () => {
    commitCheck(1, "broken check");
    const before = parentTrees();
    const scratch = mkdtempSync(join(tmpdir(), "rune-stopper-"));
    try {
      // The replayed command writes a beat every 100 ms for as long as it lives.
      const beat = join(scratch, "beat");
      const beats = () => (existsSync(beat) ? readFileSync(beat, "utf8").length : 0);
      const stopper = join(scratch, "stopper.ts");
      const source = join(import.meta.dir, "../../../packages/orchestrator/src/parent-check.ts");
      writeFileSync(
        stopper,
        `import { runOnParentCommit } from ${JSON.stringify(source)};\n` +
          `void runOnParentCommit(${JSON.stringify(repo)}, ${JSON.stringify(
            `while :; do echo x >> ${beat}; sleep 0.1; done`,
          )});\n` +
          // No `finally` runs after this: the process is simply told to leave.
          `setTimeout(() => process.exit(0), 700);\n`,
      );
      execFileSync("bun", [stopper], { stdio: "ignore", timeout: 30_000 });

      // It was running —
      expect(beats()).toBeGreaterThan(0);
      // — and it is not any more.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const then = beats();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(beats()).toBe(then);
      // The worktree it had registered in the repository is gone with it.
      const wt = join(repo, ".git", "worktrees");
      expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
      expect(parentTrees()).toEqual(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("its deadline stops the whole of it too, and is unknown rather than a failure", async () => {
    commitCheck(1, "broken check");
    const startedAt = performance.now();
    const result = await runOnParentCommit(repo, "sleep 20; sh check.sh", 300);
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("check did not complete on HEAD (it outlasted its deadline)");
    // `sleep` was the shell's child: stopping only the shell left it running
    // and the read waiting on it.
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });
});

describe.skipIf(!POSIX_SHELL)("runOnPreTaskTree", () => {
  test("the commit probe's own readings, on the tree the run started from", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "was-here.sh"), "#!/bin/sh\nexit 1\n"); // untracked before the run
    const baseline = baselineNow();
    const on = (command: string) => runOnPreTaskTree({ workspaceRoot: repo, baseline, command });
    expect(await on("sh check.sh")).toEqual({
      status: "failed",
      commit: git("rev-parse", "HEAD"),
      reason: "exit 1 on the pre-task tree",
    });
    expect(await on("true")).toMatchObject({
      status: "passed",
      reason: "already passed on the pre-task tree — this change is not why it passes",
    });
    // A missing program or dependency is not a failure of the check.
    expect((await on("rune-definitely-not-a-real-binary --version")).status).toBe("inconclusive");
    expect((await on("sh -c 'echo \"Error: Cannot find module foo\" >&2; exit 1'")).status).toBe(
      "inconclusive",
    );
    // A runner that collected nothing did not run.
    expect((await on("sh -c 'echo \"collected 0 items\"; exit 5'")).status).toBe(
      "not-applicable-on-parent",
    );
    // A file the run created was not on that tree; one the person had lying there was.
    writeFileSync(join(repo, "new-check.sh"), GREEN);
    const absent = await on("sh new-check.sh 2>/dev/null; exit 1");
    expect(absent.status).toBe("not-applicable-on-parent");
    expect(absent.reason).toBe(
      "new-check.sh did not exist on the pre-task tree, so the check could not have run there (exit 1)",
    );
    expect((await on("sh was-here.sh")).status).toBe("failed");
  }, 60_000);

  test("nothing of the user's moves and nothing is left behind; a deadline and a cancel stop it", async () => {
    commitCheck(1, "broken check");
    writeFileSync(join(repo, "uncommitted-scratch.txt"), "precious");
    const baseline = baselineNow();
    const status = git("status", "--porcelain");
    const before = laidOut();
    expect(
      (await runOnPreTaskTree({ workspaceRoot: repo, baseline, command: "sh check.sh" })).status,
    ).toBe("failed");
    expect(git("status", "--porcelain")).toBe(status);
    const worktrees = join(repo, ".git", "worktrees");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(laidOut()).toEqual(before);

    const started = Date.now();
    expect(
      await runOnPreTaskTree({
        workspaceRoot: repo,
        baseline,
        command: "sleep 30; exit 1",
        timeoutMs: 800,
      }),
    ).toMatchObject({
      status: "inconclusive",
      reason: "check did not complete on the pre-task tree",
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    expect(
      await runOnPreTaskTree({
        workspaceRoot: repo,
        baseline,
        command: "sleep 30; exit 1",
        signal: controller.signal,
      }),
    ).toMatchObject({ status: "inconclusive", reason: "the replay was cancelled" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(laidOut()).toEqual(before);
  }, 60_000);
});
