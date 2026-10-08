/**
 * V4 — a failure the run was handed is not a failure the run made.
 *
 * Before this, every red check was sent back as "Automated verification failed
 * after your changes" and bought a repair turn — including a suite that was
 * already red when the run started and that the run never touched.
 *
 * Three layers, each held on its own:
 *
 *   the report   `parseBunTestRun` reads WHICH tests failed, by name
 *   the rule     `attributeFailures` calls one pre-existing only when the same
 *                test, in an unchanged file, failed with the same assertion
 *   the whole    a real `CommandVerifier`, a real repository, real `bun test`
 *                runs on the working tree and on the tree the run started from
 *
 * and then the loop: what it does with "all pre-existing", with "one old and
 * one new", and with "could not tell".
 *
 * Zero model calls. The gateway is a script; the only processes are git and
 * the test runner.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { toUpdate } from "../../../packages/orchestrator/src/bin/acp-cli";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import {
  attributable,
  attributeFailures,
  parseBunTestRun,
  type ParsedTestRun,
} from "../../../packages/orchestrator/src/check-failures";
import { projectChildEvent } from "../../../packages/orchestrator/src/subagent-events";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  CommandVerifier,
  type FailureAttribution,
  type VerifyResult,
} from "../../../packages/orchestrator/src/verifier";

// ─── The report ───

/** Bun 1.3's own output for a run with nested, thrown, timed-out and unloadable tests. */
const REPORT = `bun test v1.3.14 (0d9b296a)

unit/c.test.ts:
(fail) slow [52.33ms]
  ^ this test timed out after 50ms.

unit/a.test.ts:
error: expect(received).toBe(expected)

Expected: 3
Received: 2

(fail) outer > inner > with arrow > adds [1.71ms]
2 | describe("outer", () => {
7 |   test("top level of outer", () => { throw new Error("boom"); });
                                                               ^
error: boom
      at <anonymous> (/ws/app/unit/a.test.ts:7:60)
(fail) outer > top level of outer [0.59ms]
error: expect(received).toBe(expected)

Expected: "b"
Received: "a"

(fail) bare test (fail) lookalike [1.37ms]

 2 pass
 1 skip
 4 fail
 4 expect() calls
Ran 7 tests across 2 files. [133.00ms]
`;

const UNLOADABLE = `bun test v1.3.14 (0d9b296a)

unit/a.test.ts:
error: expect(received).toBe(expected)

Expected: 3
Received: 2

(fail) adds [1.71ms]

unit/nested/b.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './does-not-exist' from '/ws/app/unit/nested/b.test.ts'
-------------------------------


 0 pass
 2 fail
 1 error
 1 expect() calls
Ran 2 tests across 2 files. [20.00ms]
`;

/**
 * Bun 1.3's own output inside GitHub Actions (`GITHUB_ACTIONS=true`): every
 * file opened and closed by a workflow command, every error said twice.
 */
const ANNOTATED = `bun test v1.3.14 (0d9b296a)

::group::unit/old.test.ts:
3 | test("was never true", () => { expect(value).toBe(41); });
                                                 ^
error: expect(received).toBe(expected)

Expected: 41
Received: 1

      at <anonymous> (/ws/app/unit/old.test.ts:3:46)

::error file=unit/old.test.ts,line=3,col=46,title=error: expect(received).toBe(expected)::Expected: 41%0AReceived: 1%0A%0A      at <anonymous> (/ws/app/unit/old.test.ts:3:46)
(fail) was never true [2.68ms]

::endgroup::

::group::unit/nested/b.test.ts:
error: boom
      at <anonymous> (/ws/app/unit/nested/b.test.ts:2:72)

::error file=unit/nested/b.test.ts,line=2,col=72,title=error: boom::%0A      at <anonymous> (/ws/app/unit/nested/b.test.ts:2:72)
(fail) outer > throws [0.18ms]
(pass) outer > fine [0.01ms]
::error title=error: Test "slow" timed out after 50ms::
(fail) outer > slow [50.64ms]
  ^ this test timed out after 50ms.

::endgroup::

 1 pass
 3 fail
 2 expect() calls
Ran 4 tests across 2 files. [115.00ms]
`;

describe("parseBunTestRun", () => {
  test("inside GitHub Actions the workflow commands are not part of any name", () => {
    const annotated = parseBunTestRun(ANNOTATED, ["/ws/app"])!;
    expect(annotated.failing.map((t) => [t.file, t.name])).toEqual([
      ["unit/old.test.ts", "was never true"],
      ["unit/nested/b.test.ts", "outer > throws"],
      ["unit/nested/b.test.ts", "outer > slow"],
    ]);
    expect(attributable(annotated)).toBe(true);
    // The same run with the workflow commands taken out reads identically:
    // a failure is the same failure whichever of the two wrote it down.
    const plain = ANNOTATED.split("\n")
      .filter((line) => !/^::(?:error|endgroup)\b/.test(line))
      .map((line) => line.replace(/^::group::/, ""))
      .join("\n");
    expect(plain).not.toContain("::group::");
    expect(annotated).toEqual(parseBunTestRun(plain, ["/ws/app"])!);
  });

  test("a file is named with `/`, however the runner's platform writes it", () => {
    // Windows: `unit\a.test.ts:` — and, in a workflow there, `::group::unit\a.test.ts:`.
    const windows = REPORT.replace(/^unit\/(.+:)$/gm, "unit\\$1");
    expect(windows).toContain("unit\\a.test.ts:");
    expect(parseBunTestRun(windows)!.failing).toEqual(parseBunTestRun(REPORT)!.failing);
    const both = ANNOTATED.replace(
      /^(::group::)(.+:)$/gm,
      (_, command: string, path: string) => command + path.replaceAll("/", "\\"),
    );
    expect(both).toContain("::group::unit\\nested\\b.test.ts:");
    expect(parseBunTestRun(both)!.failing.map((t) => t.file)).toEqual([
      "unit/old.test.ts",
      "unit/nested/b.test.ts",
      "unit/nested/b.test.ts",
    ]);
  });

  test("names every failing test by file and describe path", () => {
    const run = parseBunTestRun(REPORT)!;
    expect(run.failing.map((t) => [t.file, t.name])).toEqual([
      ["unit/c.test.ts", "slow"],
      ["unit/a.test.ts", "outer > inner > with arrow > adds"],
      ["unit/a.test.ts", "outer > top level of outer"],
      ["unit/a.test.ts", "bare test (fail) lookalike"],
    ]);
    expect([run.pass, run.fail, run.errors]).toEqual([2, 4, 0]);
    expect(attributable(run)).toBe(true);
  });

  test("keeps each failure's own words, and nothing that moves between two runs", () => {
    const run = parseBunTestRun(REPORT, ["/ws/app"])!;
    const by = Object.fromEntries(run.failing.map((t) => [t.name, t.signature]));
    expect(by["outer > inner > with arrow > adds"]).toBe(
      "error: expect(received).toBe(expected)\nExpected: 3\nReceived: 2",
    );
    expect(by["outer > top level of outer"]).toBe("error: boom");
    expect(by["slow"]).toBe("this test timed out after 50ms.");
    // No duration, no source line number, no stack frame.
    for (const s of Object.values(by)) expect(s).not.toMatch(/\d+ms\]|:\d+:\d+|\|/);
  });

  test("a checkout's own path is cut out, so two trees say the same thing", () => {
    const here = parseBunTestRun(UNLOADABLE.replaceAll("/ws/app", "/Users/me/app"), [
      "/Users/me/app",
    ])!;
    const there = parseBunTestRun(UNLOADABLE.replaceAll("/ws/app", "/tmp/base/tree"), [
      "/tmp/base/tree",
    ])!;
    expect(here.failing).toEqual(there.failing);
  });

  test("a file that would not load is a failure with no name: not attributable", () => {
    const run = parseBunTestRun(UNLOADABLE)!;
    expect(run.errors).toBe(1);
    expect(run.failing.length).toBe(1);
    expect(run.fail).toBe(2);
    expect(attributable(run)).toBe(false);
  });

  test("a green run parses to no failures", () => {
    const run = parseBunTestRun(
      "$ bun test unit\nbun test v1.3.14 (0d9b296a)\n\n 3 pass\n 0 fail\n 3 expect() calls\nRan 3 tests across 1 file. [9.00ms]\n",
    )!;
    expect(run.failing).toEqual([]);
    expect([run.pass, run.fail]).toEqual([3, 0]);
    expect(attributable(run)).toBe(true);
  });

  test("output that is not Bun's report is unknown, not an empty list", () => {
    expect(
      parseBunTestRun("FAIL src/a.test.ts\n  ✕ adds (3 ms)\nTests: 1 failed, 1 total"),
    ).toBeNull();
    expect(parseBunTestRun("error TS2307: Cannot find module './b'")).toBeNull();
    expect(parseBunTestRun("")).toBeNull();
    // Bun's header with no summary — a run that was cut off.
    expect(
      parseBunTestRun("bun test v1.3.14 (0d9b296a)\n\nunit/a.test.ts:\n(fail) adds [1ms]\n"),
    ).toBeNull();
  });
});

// ─── The rule ───

const run = (
  ...failing: Array<[file: string, name: string, signature?: string]>
): ParsedTestRun => ({
  failing: failing.map(([file, name, signature]) => ({
    file,
    name,
    signature: signature ?? "error: x",
  })),
  pass: 1,
  fail: failing.length,
  errors: 0,
});
const names = (tests: Array<{ file: string; name: string }>) =>
  tests.map((t) => `${t.file}::${t.name}`);

describe("attributeFailures", () => {
  test("the same test, same assertion, unchanged file: it was already failing", () => {
    const out = attributeFailures(run(["a.test.ts", "old"]), run(["a.test.ts", "old"]), new Set());
    expect(names(out.existing)).toEqual(["a.test.ts::old"]);
    expect(out.introduced).toEqual([]);
  });

  test("an old failure does not excuse a new one beside it in the same file", () => {
    const out = attributeFailures(
      run(["a.test.ts", "old"], ["a.test.ts", "new"]),
      run(["a.test.ts", "old"]),
      new Set(),
    );
    expect(names(out.existing)).toEqual(["a.test.ts::old"]);
    expect(names(out.introduced)).toEqual(["a.test.ts::new"]);
  });

  test("a renamed test is a new failure — the old name excuses nothing", () => {
    const out = attributeFailures(
      run(["a.test.ts", "adds two"]),
      run(["a.test.ts", "adds"]),
      new Set(),
    );
    expect(out.existing).toEqual([]);
    expect(names(out.introduced)).toEqual(["a.test.ts::adds two"]);
  });

  test("the same test failing for a DIFFERENT reason is a new failure", () => {
    const out = attributeFailures(
      run(["a.test.ts", "adds", "error: expect\nExpected: 3\nReceived: 99"]),
      run(["a.test.ts", "adds", "error: expect\nExpected: 3\nReceived: 2"]),
      new Set(),
    );
    expect(out.existing).toEqual([]);
    expect(out.introduced.length).toBe(1);
  });

  test("a test in a file the run changed is the run's, whatever the baseline said", () => {
    const out = attributeFailures(
      run(["a.test.ts", "old"], ["b.test.ts", "old"]),
      run(["a.test.ts", "old"], ["b.test.ts", "old"]),
      new Set(["a.test.ts"]),
    );
    expect(names(out.existing)).toEqual(["b.test.ts::old"]);
    expect(names(out.introduced)).toEqual(["a.test.ts::old"]);
  });

  test("the same name in another file is another test", () => {
    const out = attributeFailures(
      run(["b.test.ts", "adds"]),
      run(["a.test.ts", "adds"]),
      new Set(),
    );
    expect(out.existing).toEqual([]);
  });

  test("two failures with one name are not both excused by one old failure", () => {
    const out = attributeFailures(
      run(["a.test.ts", "case"], ["a.test.ts", "case"]),
      run(["a.test.ts", "case"]),
      new Set(),
    );
    expect(out.existing.length).toBe(1);
    expect(out.introduced.length).toBe(1);
  });

  test("a green baseline means every failure is new", () => {
    const out = attributeFailures(run(["a.test.ts", "x"]), run(), new Set());
    expect(out.existing).toEqual([]);
    expect(out.introduced.length).toBe(1);
  });
});

// ─── The whole thing, on a real tree ───

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T = (name: string, body: string) =>
  `import { test, expect } from "bun:test";\nimport { value } from "../src/value";\ntest(${JSON.stringify(name)}, () => { ${body} });\n`;

/**
 * A Bun project, committed, whose suite is ALREADY RED: `unit/old.test.ts`
 * asserts something that was never true. `unit/ok.test.ts` passes and depends
 * on `src/value.ts`, so changing that file is how a run breaks it.
 */
function project(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "rune-attr-"));
  made.push(root);
  put(root, {
    "package.json": JSON.stringify({ name: "app", scripts: { test: "bun test unit" } }),
    "bun.lock": "",
    "src/value.ts": "export const value = 1;\n",
    "src/other.ts": "export const other = 1;\n",
    "unit/ok.test.ts": T("value is one", "expect(value).toBe(1);"),
    "unit/old.test.ts": T("was never true", "expect(value).toBe(41);"),
    ...extra,
  });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/**
 * An ignored environment reaches the starting tree by being cloned, which
 * `baseline.ts` can do on macOS and Linux. Elsewhere the answer is "unknown",
 * said in so many words — `baseline.test.ts` holds it to that.
 */
const CLONES = process.platform === "darwin" || process.platform === "linux";

const OLD = "unit/old.test.ts :: was never true";
const OK = "unit/ok.test.ts :: value is one";
const known = (a: FailureAttribution | undefined) => {
  if (!a?.known) throw new Error(`expected a known attribution, got: ${a ? a.why : "none"}`);
  return a;
};
const why = (a: FailureAttribution | undefined): string => (a && !a.known ? a.why : "(known)");

describe("CommandVerifier — whose failures are these", () => {
  test("an existing failure is reported as existing: red, and not the run's", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n"); // the run's unrelated edit
    const r = await v.verify(undefined, [join(root, "src/other.ts")]);
    // Still red. Nothing here calls the suite green.
    expect(r.status).toBe("failed");
    expect(r.passed).toBe(false);
    const a = known(r.attribution);
    expect(a.existing).toEqual([OLD]);
    expect(a.introduced).toEqual([]);
  });

  test("a new failing assertion is the run's — and the old one is not dismissed with it", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/value.ts"), "export const value = 2;\n"); // breaks ok.test.ts
    const a = known((await v.verify(undefined, [join(root, "src/value.ts")])).attribution);
    // `ok` is newly red. And `old` still fails, but now with `Received: 2`
    // where the starting tree had `Received: 1`: the run changed what it fails
    // WITH, so it is not excused either. Same name is not same failure.
    expect(a.introduced.sort()).toEqual([OK, OLD].sort());
    expect(a.existing).toEqual([]);
  });

  test("one old and one new, with the old one untouched: each is called what it is", async () => {
    const root = project({
      "src/flag.ts": "export const flag = true;\n",
      "unit/flag.test.ts":
        'import { test, expect } from "bun:test";\nimport { flag } from "../src/flag";\ntest("flag is on", () => { expect(flag).toBe(true); });\n',
    });
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/flag.ts"), "export const flag = false;\n");
    const a = known((await v.verify(undefined, [join(root, "src/flag.ts")])).attribution);
    expect(a.existing).toEqual([OLD]);
    expect(a.introduced).toEqual(["unit/flag.test.ts :: flag is on"]);
  });

  test("a clean baseline: every failure is new", async () => {
    const root = project({ "unit/old.test.ts": T("was never true", "expect(value).toBe(1);") });
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/value.ts"), "export const value = 2;\n");
    const a = known((await v.verify(undefined, [join(root, "src/value.ts")])).attribution);
    expect(a.existing).toEqual([]);
    expect(a.introduced.sort()).toEqual([OK, OLD].sort());
  });

  test("the person's own uncommitted break is part of the baseline, not of the run", async () => {
    // HEAD is green. The person broke `value` before starting the run and did
    // not commit. `HEAD` as the baseline would blame the run for it.
    const root = project({ "unit/old.test.ts": T("was never true", "expect(value).toBe(1);") });
    writeFileSync(join(root, "src/value.ts"), "export const value = 7; // their WIP\n");
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
    const a = known((await v.verify(undefined, [join(root, "src/other.ts")])).attribution);
    expect(a.introduced).toEqual([]);
    expect(a.existing.sort()).toEqual([OK, OLD].sort());
  });

  test("a mutated witness: the run edited the failing test, so it is the run's", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(
      join(root, "unit/old.test.ts"),
      `${T("was never true", "expect(value).toBe(41);")}// touched\n`,
    );
    const a = known((await v.verify(undefined, [join(root, "unit/old.test.ts")])).attribution);
    expect(a.existing).toEqual([]);
    expect(a.introduced).toEqual([OLD]);
  });

  test("a renamed test is a new failure", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(
      join(root, "unit/old.test.ts"),
      T("was never true (renamed)", "expect(value).toBe(41);"),
    );
    const a = known((await v.verify(undefined, [join(root, "unit/old.test.ts")])).attribution);
    expect(a.existing).toEqual([]);
    expect(a.introduced).toEqual(["unit/old.test.ts :: was never true (renamed)"]);
  });

  test("inside GitHub Actions the report is annotated, and each failure is still called what it is", async () => {
    // Bun wraps every file in `::group::` there. The prefix used to stay on the
    // file's name, so a failing test in a file the run had edited matched no
    // changed file — and was excused as someone else's.
    // `AGENT=0`: Bun leaves the annotations out when it thinks an agent reads.
    const saved = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, AGENT: process.env.AGENT };
    process.env.GITHUB_ACTIONS = "true";
    process.env.AGENT = "0";
    try {
      const untouched = project();
      const v = new CommandVerifier({ workspaceRoot: untouched });
      v.beginChanges();
      writeFileSync(join(untouched, "src/other.ts"), "export const other = 2;\n");
      const r = await v.verify(undefined, [join(untouched, "src/other.ts")]);
      expect(r.report).toContain("::group::"); // the annotated report is what was read
      expect(known(r.attribution)).toEqual({ known: true, existing: [OLD], introduced: [] });

      const edited = project();
      const w = new CommandVerifier({ workspaceRoot: edited });
      w.beginChanges();
      writeFileSync(
        join(edited, "unit/old.test.ts"),
        `${T("was never true", "expect(value).toBe(41);")}// touched\n`,
      );
      const a = known((await w.verify(undefined, [join(edited, "unit/old.test.ts")])).attribution);
      expect(a).toEqual({ known: true, existing: [], introduced: [OLD] });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("changed dependencies: no comparison is made", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        scripts: { test: "bun test unit" },
        dependencies: { leftpad: "1" },
      }),
    );
    const r = await v.verify(undefined, [join(root, "package.json")]);
    expect(r.status).toBe("failed");
    expect(why(r.attribution)).toContain("dependencies changed during the run");
  });

  test("missing collection: a file that would not load on the starting tree voids it", async () => {
    // At baseline `unit/load.test.ts` imports a module that does not exist yet.
    const root = project({
      "unit/load.test.ts":
        'import { test, expect } from "bun:test";\nimport { later } from "../src/later";\ntest("uses later", () => { expect(later).toBe(1); });\n',
    });
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    put(root, { "src/later.ts": "export const later = 1;\n" }); // the run adds it
    const r = await v.verify(undefined, [join(root, "src/later.ts")]);
    expect(r.status).toBe("failed");
    expect(why(r.attribution)).toContain("starting tree");
  });

  test("a failure with no name on the working tree is not attributed either", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    put(root, {
      "unit/broken.test.ts":
        'import { test } from "bun:test";\nimport "../src/nowhere";\ntest("x", () => {});\n',
    });
    const r = await v.verify(undefined, [join(root, "unit/broken.test.ts")]);
    expect(why(r.attribution)).toContain("does not name as a test");
  });

  test("a stale baseline: the branch moved during the run", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    put(root, { "src/mine.ts": "export const mine = 1;\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "feat: the person commits");
    const r = await v.verify(undefined, [join(root, "src/other.ts")]);
    expect(why(r.attribution)).toContain("the branch moved");
  });

  test("no baseline was taken: unknown — never assumed", async () => {
    const root = project();
    const r = await new CommandVerifier({ workspaceRoot: root }).verify(undefined, [
      join(root, "src/other.ts"),
    ]);
    expect(r.status).toBe("failed");
    expect(why(r.attribution)).toContain("no snapshot");
  });

  test("a check that is not a test report: unknown", async () => {
    const root = project();
    const v = new CommandVerifier({
      workspaceRoot: root,
      commands: ["echo 'tsc: error TS2307' && exit 2"],
    });
    v.beginChanges();
    const r = await v.verify();
    expect(r.status).toBe("failed");
    expect(why(r.attribution)).toContain("not a test report");
  });

  test("the environment changed during the run: unknown", async () => {
    const root = project({ ".gitignore": "vendor/\n" });
    put(root, { "vendor/lib.js": "module.exports = 1;\n" });
    await new Promise((resolve) => setTimeout(resolve, 2_100)); // let the fixture age past the clock's slack
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "vendor/lib.js"), "module.exports = 2;\n"); // a rebuilt artifact
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
    const r = await v.verify(undefined, [join(root, "src/other.ts")]);
    expect(why(r.attribution)).toContain("environment changed during the run");
  }, 20_000);

  test("a passing verification carries no attribution at all", async () => {
    const root = project({ "unit/old.test.ts": T("was never true", "expect(value).toBe(1);") });
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    const r = await v.verify(undefined, [join(root, "src/other.ts")]);
    expect(r.status).toBe("passed");
    expect(r.attribution).toBeUndefined();
  });

  test("the baseline run is not evidence about the work: only the real check reaches the log", async () => {
    const root = project();
    const logged: Array<[string, boolean]> = [];
    const v = new CommandVerifier({
      workspaceRoot: root,
      onCheck: (run) => logged.push([run.command, run.passed]),
    });
    v.beginChanges();
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
    known((await v.verify(undefined, [join(root, "src/other.ts")])).attribution);
    // One entry, red — the working tree's. The final verdict reads this log,
    // so an existing failure is still named there as a red check.
    expect(logged).toEqual([["bun run test", false]]);
  });

  test("nothing of the person's is touched, and nothing is left on disk", async () => {
    const root = project();
    writeFileSync(join(root, "src/value.ts"), "export const value = 1; // WIP\n");
    put(root, { "staged.ts": "export {};\n" });
    git(root, "add", "staged.ts");
    const fingerprint = () =>
      [
        git(root, "status", "--porcelain=v1"),
        createHash("sha256")
          .update(readFileSync(join(root, ".git/index")))
          .digest("hex"),
        git(root, "stash", "list"),
        git(root, "for-each-ref"),
        git(root, "worktree", "list"),
      ].join("\n--\n");
    const temps = () =>
      readdirSync(tmpdir())
        .filter((n) => /^rune-(baseline|index)-/.test(n))
        .sort();
    const v = new CommandVerifier({ workspaceRoot: root });
    const before = { tree: fingerprint(), temps: temps() };
    v.beginChanges();
    known((await v.verify(undefined, [join(root, "src/value.ts")])).attribution);
    expect(fingerprint()).toBe(before.tree);
    expect(temps()).toEqual(before.temps);
  });

  test.skipIf(!CLONES)(
    "the starting tree is asked once: a second failure reuses what it said",
    async () => {
      const root = project({ ".gitignore": "vendor/\n" });
      put(root, { "vendor/lib.js": "module.exports = 1;\n" });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const v = new CommandVerifier({ workspaceRoot: root });
      v.beginChanges();
      writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
      expect(
        known((await v.verify(undefined, [join(root, "src/other.ts")])).attribution).existing,
      ).toEqual([OLD]);
      // Now the environment moves. A fresh baseline run would refuse — but what
      // the starting tree said was said before that, and is still what it said.
      writeFileSync(join(root, "vendor/lib.js"), "module.exports = 2;\n");
      expect(
        known((await v.verify(undefined, [join(root, "src/other.ts")])).attribution).existing,
      ).toEqual([OLD]);
    },
    20_000,
  );

  test("a new run takes a new baseline: last run's break is this run's inheritance", async () => {
    const root = project({ "unit/old.test.ts": T("was never true", "expect(value).toBe(1);") });
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/value.ts"), "export const value = 2;\n");
    const first = known((await v.verify(undefined, [join(root, "src/value.ts")])).attribution);
    expect(first.introduced.length).toBe(2);
    // The next run starts from the tree as it now is.
    v.beginChanges();
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
    const second = known((await v.verify(undefined, [join(root, "src/other.ts")])).attribution);
    expect(second.introduced).toEqual([]);
    expect(second.existing.length).toBe(2);
  });

  test("cancelled while the starting tree is being consulted: unknown, and nothing left behind", async () => {
    const root = project();
    const ac = new AbortController();
    const temps = () =>
      readdirSync(tmpdir())
        .filter((n) => /^rune-baseline-/.test(n))
        .sort();
    const before = temps();
    const v = new CommandVerifier({
      workspaceRoot: root,
      // The real check has finished and been logged; the run is cancelled then.
      onCheck: () => ac.abort(),
    });
    v.beginChanges();
    writeFileSync(join(root, "src/other.ts"), "export const other = 2;\n");
    const r = await v.verify(ac.signal, [join(root, "src/other.ts")]);
    expect(why(r.attribution)).toBe("cancelled");
    expect(temps()).toEqual(before);
  });
});

// ─── What the loop does with it ───

type Step =
  { kind: "tool"; tool: string; args?: Record<string, unknown> } | { kind: "text"; text: string };

function makeGateway(script: Step[]) {
  let i = 0;
  return {
    inferStream: async function* () {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.kind === "tool") {
        yield { type: "tool_use_start", toolCallId: `c${i}`, toolName: step.tool };
        yield { type: "tool_use_stop", toolCallId: `c${i}`, toolInput: step.args ?? {} };
        yield { type: "message_stop", stopReason: "tool_use" };
        return;
      }
      yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
      yield { type: "message_stop", stopReason: "end_turn" };
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: () => [{ name: "bash", description: "", inputSchema: {} }],
    list: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const red = (attribution?: FailureAttribution): VerifyResult => ({
  status: "failed",
  passed: false,
  ran: true,
  report: "$ bun run test  (exit 1)\n(fail) was never true\n\n 1 pass\n 1 fail",
  runs: [{ command: "bun run test", exitCode: 1, durationMs: 5, passed: false }],
  ...(attribution ? { attribution } : {}),
});
const GREEN: VerifyResult = {
  status: "passed",
  passed: true,
  ran: true,
  report: "$ bun run test  (ok)",
  runs: [{ command: "bun run test", exitCode: 0, durationMs: 5, passed: true }],
};

async function runLoop(options: { script: Step[]; authority?: string[]; results: VerifyResult[] }) {
  const incidents: string[] = [];
  const taskState = new TaskStateStore();
  /** Each `beginChanges()`, by how many tools had executed when it was called. */
  const announced: number[] = [];
  let executed = 0;
  let verifyCalls = 0;
  const registry = makeRegistry();
  const execute = registry.execute;
  registry.execute = async (input: { toolName: string; callId: string }) => {
    executed++;
    return execute(input);
  };
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
      verifier: {
        beginChanges: () => announced.push(executed),
        verify: async () => options.results[Math.min(verifyCalls++, options.results.length - 1)]!,
      },
      effortRouting: "conservative",
      thinkingEffort: "high",
      onIncident: (i: { class: string }) => incidents.push(i.class),
      controller: { runId: "run#1", authority: new Set(options.authority ?? []) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(options.script),
    registry,
    async () => ({ allowed: true }),
  );
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("add the parser", "s1", "/tmp")) events.push(e);
  const notes = loop
    .getMessages()
    .flatMap((m) =>
      m.role === "user"
        ? m.content.flatMap((b) => (b.type === "text" ? [(b as { text: string }).text] : []))
        : [],
    );
  return {
    events,
    incidents,
    taskState,
    announced,
    verifyCalls,
    notices: events.flatMap((e) => (e.type === "notice" ? [e.message] : [])),
    repairs: notes.filter((t) => t.includes("Automated verification failed")),
    completed: events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "verification_completed" }> =>
        e.type === "verification_completed",
    ),
    stopReason: (
      events.find((e) => e.type === "turn_complete") as { stopReason?: string } | undefined
    )?.stopReason,
  };
}

const WRITE_RUN_FINISH: Step[] = [
  { kind: "tool", tool: "read_file", args: { path: "src/parser.ts" } },
  { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "x" } },
  { kind: "tool", tool: "bash", args: { command: "bun test src/parser.test.ts" } },
  { kind: "text", text: "done" },
  { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "y" } },
  { kind: "text", text: "fixed" },
];

const ONLY_OLD: FailureAttribution = { known: true, existing: [OLD], introduced: [] };
const MIXED: FailureAttribution = { known: true, existing: [OLD], introduced: [OK] };
const ALL_NEW: FailureAttribution = { known: true, existing: [], introduced: [OK] };
const UNKNOWN: FailureAttribution = { known: false, why: "dependencies changed during the run" };

describe.each([
  ["authority empty", [] as string[]],
  ["authority enabled", ["check_failed", "missing_dependency"]],
])("the loop — failures the run was handed (%s)", (_label, authority) => {
  test("all pre-existing: no repair turn, no effort escalation, and the run ends", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, results: [red(ONLY_OLD)] });
    expect(out.repairs).toEqual([]);
    expect(out.verifyCalls).toBe(1);
    expect(out.stopReason).toBe("end_turn");
    expect(out.incidents).not.toContain("loop.verification_failed");
    expect(out.incidents).not.toContain("loop.effort_latched");
    expect(out.incidents).toContain("loop.verification_preexisting");
  });

  test("…and it is still called red, by name, everywhere it is written down", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, results: [red(ONLY_OLD)] });
    const event = out.completed[0]!;
    expect(event.status).toBe("failed");
    expect(event.passed).toBe(false);
    expect(event.preexisting).toBe(true);
    // The reader is told which tests, and that they are not new.
    const notice = out.notices.find((n) => n.includes("already failing before it began"))!;
    expect(notice).toContain(OLD);
    expect(notice).toContain("checks are red");
    // The state the next turn reads does not say "failed" as an instruction.
    const state = out.taskState.snapshot();
    expect(state.verification.status).toBe("preexisting");
    const block = out.taskState.renderBlock()!;
    expect(block).toContain("red before this run began");
    expect(block).not.toContain("Verification: failed");
    expect(block).not.toContain("Verification: passed");
    // The red command is on the record as red.
    expect(
      (state.checks ?? []).filter((c) => c.source === "harness").map((c) => [c.command, c.passed]),
    ).toEqual([["bun run test", false]]);
    expect((state.log ?? []).some((e) => e.text.includes("already failing before this run"))).toBe(
      true,
    );
  });

  test("one old and one new: repaired, and the model is told which is which", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(MIXED), GREEN],
    });
    expect(out.repairs.length).toBe(1);
    const repair = out.repairs[0]!;
    expect(repair.indexOf("New since this run began")).toBeGreaterThan(-1);
    expect(repair.indexOf(OK)).toBeGreaterThan(repair.indexOf("New since this run began"));
    expect(repair.indexOf("Already failing before this run began")).toBeGreaterThan(
      repair.indexOf(OK),
    );
    expect(repair.indexOf(OLD)).toBeGreaterThan(
      repair.indexOf("Already failing before this run began"),
    );
    expect(out.completed[0]!.preexisting).toBeUndefined();
    expect(out.incidents).toContain("loop.verification_failed");
  });

  test("the old one left after the repair does not buy a second one", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(MIXED), red(ONLY_OLD)],
    });
    expect(out.repairs.length).toBe(1);
    expect(out.completed.map((e) => e.preexisting ?? false)).toEqual([false, true]);
    expect(out.taskState.snapshot().verification.status).toBe("preexisting");
    expect(out.stopReason).toBe("end_turn");
  });

  test("all new: repaired exactly as before, with nothing added to the message", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(ALL_NEW), GREEN],
    });
    expect(out.repairs.length).toBe(1);
    expect(out.repairs[0]).not.toContain("Already failing before this run began");
  });

  test("could not tell: repaired exactly as before", async () => {
    for (const attribution of [UNKNOWN, undefined]) {
      const out = await runLoop({
        script: WRITE_RUN_FINISH,
        authority,
        results: [red(attribution), GREEN],
      });
      expect(out.repairs.length).toBe(1);
      expect(out.repairs[0]).not.toContain("Already failing before this run began");
      expect(out.completed[0]!.preexisting).toBeUndefined();
      expect(out.incidents).not.toContain("loop.verification_preexisting");
    }
  });

  test("could not tell: the reason is written down, and the model's message is not changed", async () => {
    // Measured 2026-10-07: a live run was asked to repair a test that had been
    // red before it began, and nothing recorded why the comparison that would
    // have said so gave no answer. The reason was computed and dropped.
    const told = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(UNKNOWN), GREEN],
    });
    expect(told.completed[0]!.attributionUnknown).toBe(UNKNOWN.why);
    expect(told.notices.find((n) => n.startsWith("Verification failed"))).toContain(UNKNOWN.why);
    // Not said to the model: the repair it is asked for is word for word the
    // one a run with no attribution at all is asked for.
    const untold = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(undefined), GREEN],
    });
    expect(told.repairs).toEqual(untold.repairs);
    expect(told.repairs[0]).not.toContain(UNKNOWN.why);
    expect(untold.completed[0]!.attributionUnknown).toBeUndefined();
    expect(untold.notices.find((n) => n.startsWith("Verification failed"))).toBe(
      "Verification failed — asking the agent to fix it.",
    );

    // An answer, either way, is not an unknown.
    for (const known of [ONLY_OLD, MIXED, ALL_NEW]) {
      const out = await runLoop({
        script: WRITE_RUN_FINISH,
        authority,
        results: [red(known), GREEN],
      });
      expect(out.completed[0]!.attributionUnknown).toBeUndefined();
    }
  });

  test("could not tell: the saved state keeps the reason until a later check replaces it", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, results: [red(UNKNOWN)] });
    // Every check in this run comes back the same red, so the state it ends
    // on is the failed one.
    const failed = out.taskState.snapshot().verification;
    expect(failed.status).toBe("failed");
    expect(failed.attributionUnknown).toBe(UNKNOWN.why);
    // And never in the block the model reads.
    expect(out.taskState.renderBlock() ?? "").not.toContain(UNKNOWN.why);

    const green = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      results: [red(UNKNOWN), GREEN],
    });
    expect(green.taskState.snapshot().verification.attributionUnknown).toBeUndefined();
  });

  test("a verifier that says `existing` about a result it also calls unknown is not believed", async () => {
    // `known: false` carries no lists. A malformed mix of the two must not be
    // read as "all pre-existing".
    const odd = {
      known: false,
      why: "x",
      existing: [OLD],
      introduced: [],
    } as unknown as FailureAttribution;
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, results: [red(odd), GREEN] });
    expect(out.repairs.length).toBe(1);
    // Not in the repair, not on the wire, not in the state.
    expect(out.completed[0]!.preexisting).toBeUndefined();
    expect(out.incidents).not.toContain("loop.verification_preexisting");
    expect(out.notices.some((n) => n.includes("already failing before it began"))).toBe(false);
  });
});

describe("the loop — when the baseline is taken", () => {
  test("once, before the first call that can write, and after the reads", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, results: [GREEN] });
    // One read had executed; the write had not.
    expect(out.announced).toEqual([1]);
  });

  test("a run that only reads never takes one", async () => {
    const out = await runLoop({
      script: [
        { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
        { kind: "text", text: "it does X" },
      ],
      results: [GREEN],
    });
    expect(out.announced).toEqual([]);
  });

  test("a shell command counts: it can write", async () => {
    const out = await runLoop({
      script: [
        { kind: "tool", tool: "bash", args: { command: "sed -i '' s/a/b/ x.ts" } },
        { kind: "text", text: "done" },
      ],
      results: [GREEN],
    });
    expect(out.announced).toEqual([0]);
  });
});

describe("every surface says the same thing about an inherited failure", () => {
  const event = {
    type: "verification_completed",
    attempt: 1,
    status: "failed",
    preexisting: true,
    ran: true,
    passed: false,
    report: "$ bun run test  (exit 1)\n(fail) was never true\n\n 1 pass\n 1 fail",
  } as AgentTurnEvent;

  test("the editor stream and the parent's row: failed, before this run, nothing new", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acp = (toUpdate(event as any)?.content as { text?: string }).text ?? "";
    const child = projectChildEvent("w1", event) ?? "";
    for (const said of [acp, child]) {
      expect(said).toContain("failed before this run (nothing new)");
      expect(said).not.toMatch(/passed/);
    }
  });

  test("the terminal draws it red, says whose it is, and does not call the turn a failure", () => {
    const commits: string[] = [];
    const sink: TurnSink = { commit: (block) => commits.push(block), preview: () => {} };
    const turn = new TurnRenderer(sink, { getCost: () => 0 });
    turn.onEvent(event);
    turn.onEvent({ type: "text_delta", text: "Done." });
    turn.finish();
    const out = stripAnsi(commits.join("\n"));
    expect(out).toContain("already failing before this run began");
    expect(out).not.toContain("✓ check");
    expect(out).not.toContain("stopped on an error");
  });

  test("without the flag, a failure is still just a failure", () => {
    const plain = { ...event, preexisting: undefined } as AgentTurnEvent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acp = (toUpdate(plain as any)?.content as { text?: string }).text ?? "";
    expect(acp).toContain("verification: FAILED");
    expect(projectChildEvent("w1", plain)).toContain("checks failed");
    expect(projectChildEvent("w1", plain)).not.toContain("before this run");
  });
});
