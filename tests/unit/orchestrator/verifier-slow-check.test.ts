/**
 * A check that cannot finish.
 *
 * Measured 2026-10-07: on two of three live runs the project's whole test
 * suite was started at the end of the turn, killed at the 120 s limit, and
 * reported as "nothing was measured". Two rules came out of that, and this
 * file holds them to what they say:
 *
 *   1. a command that did not finish is not waited for again — for this
 *      workspace, under the limit it failed, for a day;
 *   2. when it is the test suite, the test files the change touched are run
 *      in its place, and what they say is recorded as what it is.
 *
 * Neither may turn "did not finish" into a pass.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CommandVerifier } from "../../../packages/orchestrator/src/verifier";
import { rmTemp } from "../../helpers/tmp";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmTemp(dir);
});
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const HOUR = 60 * 60 * 1000;
/** [command, timed out, not started] for each run of a result. */
const shape = (r: {
  runs?: Array<{ command: string; timedOut?: boolean; notStarted?: boolean }>;
}) => (r.runs ?? []).map((x) => [x.command, x.timedOut ?? false, x.notStarted ?? false]);

describe("a command that did not finish twice running is not waited for a third time", () => {
  test("in one session: once may be the machine, twice is the command — then it is not started, and says so", async () => {
    const root = scratch("rune-slow-");
    const logged: string[] = [];
    const v = new CommandVerifier({
      workspaceRoot: root,
      commands: ["sleep 2"],
      timeoutMs: 300,
      onCheck: (run) => logged.push(run.command),
    });

    const first = await v.verify();
    expect(first.status).toBe("inconclusive");
    expect(first.reason).toBe("timeout");
    expect(shape(first)).toEqual([["sleep 2", true, false]]);
    expect(first.runs![0]!.durationMs).toBeGreaterThanOrEqual(250);

    // Once is not enough to take a check away: it is started again.
    expect(shape(await v.verify())).toEqual([["sleep 2", true, false]]);

    const startedAt = Date.now();
    const second = await v.verify();
    // The same answer, and none of the wait.
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(second.status).toBe("inconclusive");
    expect(second.reason).toBe("timeout");
    expect(second.passed).toBe(false);
    expect(second.ran).toBe(false);
    expect(shape(second)).toEqual([["sleep 2", true, true]]);
    expect(second.runs![0]!.durationMs).toBe(0);
    expect(second.report).toContain("not started");
    expect(second.report).toContain("did not finish in 300ms");
    expect(second.report).toContain("nothing was measured");
    // A command that measured nothing is not evidence, started or not.
    expect(logged).toEqual([]);
  });

  test("across sessions it is remembered for this workspace, for a day, under the limit it failed", async () => {
    const root = scratch("rune-slow-");
    const other = scratch("rune-slow-other-");
    const memory = join(scratch("rune-slow-home-"), "nested", "verify-slow.json");
    let now = Date.UTC(2026, 9, 8, 6, 0, 0);
    const session = (workspaceRoot: string, timeoutMs = 300) =>
      new CommandVerifier({
        workspaceRoot,
        commands: ["sleep 2"],
        timeoutMs,
        slowChecksPath: memory,
        now: () => now,
      });

    expect(shape(await session(root).verify())).toEqual([["sleep 2", true, false]]);
    // A second session: still started — one failure to finish proves little.
    expect(shape(await session(root).verify())).toEqual([["sleep 2", true, false]]);

    // A third, an hour on: not started.
    now += HOUR;
    const later = await session(root).verify();
    expect(shape(later)).toEqual([["sleep 2", true, true]]);
    expect(later.report).toContain("60 minutes ago");

    // Another project's command of the same name was never timed here.
    expect(shape(await session(other).verify())).toEqual([["sleep 2", true, false]]);

    // Under a longer limit than the one it failed, it has not been tried.
    expect(shape(await session(root, 600).verify())).toEqual([["sleep 2", true, false]]);
    // …and that failure, under the longer limit, now covers both.
    expect(shape(await session(root, 600).verify())).toEqual([["sleep 2", true, true]]);
    expect(shape(await session(root, 300).verify())).toEqual([["sleep 2", true, true]]);

    // A day after it last failed to finish, it is tried again — once, and a
    // command with this history is believed at its first failure.
    now += 24 * HOUR;
    expect(shape(await session(root, 300).verify())).toEqual([["sleep 2", true, false]]);
    expect(shape(await session(root, 300).verify())).toEqual([["sleep 2", true, true]]);
  });

  test("finishing once forgets it", async () => {
    const root = scratch("rune-slow-");
    const memory = join(scratch("rune-slow-home-"), "verify-slow.json");
    const session = (timeoutMs: number) =>
      new CommandVerifier({
        workspaceRoot: root,
        commands: ["sleep 0.6"],
        timeoutMs,
        slowChecksPath: memory,
      });

    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, false]]);
    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, false]]);
    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, true]]);
    expect(readFileSync(memory, "utf8")).toContain("sleep 0.6");

    // Given the time it needs, it finishes — and is no longer a check that cannot.
    const finished = await session(5_000).verify();
    expect(finished.status).toBe("passed");
    expect(readFileSync(memory, "utf8")).not.toContain("sleep 0.6");

    // So under the short limit it is started again, not skipped on an old
    // record — and its count begins again from nothing.
    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, false]]);
    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, false]]);
    expect(shape(await session(200).verify())).toEqual([["sleep 0.6", true, true]]);
  });

  test("a memory that cannot be read or written costs a wait, never an answer", async () => {
    const root = scratch("rune-slow-");
    const home = scratch("rune-slow-home-");
    const memory = join(home, "verify-slow.json");
    writeFileSync(memory, "{ not json");
    const v = new CommandVerifier({
      workspaceRoot: root,
      commands: ["sleep 2"],
      timeoutMs: 200,
      slowChecksPath: memory,
    });
    expect(shape(await v.verify())).toEqual([["sleep 2", true, false]]);

    // A path that is a directory: nothing can be written there.
    const w = new CommandVerifier({
      workspaceRoot: root,
      commands: ["sleep 2"],
      timeoutMs: 200,
      slowChecksPath: home,
    });
    expect((await w.verify()).reason).toBe("timeout");
  });
});

// ─── The suite did not finish: what the change touched is measured instead ───

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

const T = (name: string, body: string) =>
  `import { test, expect } from "bun:test";\ntest(${JSON.stringify(name)}, () => { ${body} });\n`;

/** A Bun project whose suite takes far longer than any limit used here. */
function project(testScript: string, files: Record<string, string> = {}): string {
  const root = scratch("rune-slow-suite-");
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app", scripts: { test: testScript } }),
    "bun.lock": "",
    "src/value.ts": "export const value = 1;\n",
    "unit/a.test.ts": T("a holds", "expect(1).toBe(1);"),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const SUITE = "bun run test";
const SLOW_BUN = "sleep 30 && bun test unit";
const LIMIT = 8_000;
/**
 * For the one test that really waits for the limit. On Windows a check killed
 * at its limit is not stopped — the verifier returns when the command's own
 * children exit (seen on the CI runner, 2026-10-08) — so this sleep is one the
 * test can afford to sit through in full.
 */
const SLOW_BUN_ONCE = "sleep 9 && bun test unit";

/** The suite, already known not to finish here: nothing in these tests waits for it. */
function known(root: string, limitMs = LIMIT): string {
  const memory = join(scratch("rune-slow-home-"), "verify-slow.json");
  writeFileSync(
    memory,
    JSON.stringify({
      version: 1,
      entries: { [`${root}\0${SUITE}`]: { at: Date.now(), limitMs, times: 2 } },
    }),
  );
  return memory;
}

describe("the suite did not finish: the test files the change touched are run in its place", () => {
  test("a real timeout: the touched file is measured, green is recorded, and the pass is still unfinished", async () => {
    const root = project(SLOW_BUN_ONCE);
    const logged: Array<[string, boolean]> = [];
    const v = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: 4_000,
      onCheck: (run) => logged.push([run.command, run.passed]),
    });
    const r = await v.verify(undefined, [join(root, "unit/a.test.ts"), join(root, "src/value.ts")]);

    // Not a pass: the suite as a whole said nothing.
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toBe("timeout");
    expect(r.passed).toBe(false);
    const scoped = "bun test './unit/a.test.ts'";
    expect(shape(r)).toEqual([
      [SUITE, true, false],
      [scoped, false, false],
    ]);
    expect(r.runs![1]!.passed).toBe(true);
    // The one command that measured something is the one on the record.
    expect(logged).toEqual([[scoped, true]]);
    expect(r.report).toContain("timed out after 4000ms");
    expect(r.report).toContain("The test files this change touched, run in its place:");
    expect(r.report).toContain(`$ ${scoped}  (ok)`);
    expect(r.report).toContain("the suite as a whole was not measured");
  }, 60_000);

  test("red in a touched test file is a failed check, not an unfinished one", async () => {
    const root = project(SLOW_BUN, { "unit/b.test.ts": T("b is wrong", "expect(1).toBe(2);") });
    const v = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: LIMIT,
      slowChecksPath: known(root),
    });
    const r = await v.verify(undefined, [join(root, "unit/b.test.ts")]);
    expect(r.status).toBe("failed");
    expect(r.passed).toBe(false);
    expect(shape(r)).toEqual([
      [SUITE, true, true],
      ["bun test './unit/b.test.ts'", false, false],
    ]);
    expect(r.runs![1]!.exitCode).not.toBe(0);
    expect(r.report).toContain("b is wrong");
    // A real failure is asked whose it is, like any other.
    expect(r.attribution).toBeDefined();
  }, 30_000);

  test("only the touched file is run: a path is not a filter", async () => {
    // `bun test unit/a.test.ts` would also match `unit/a.test.ts.extra/…` and,
    // as a bare word, any file with that text in its path. The red file beside
    // the touched one must not be run.
    const root = project(SLOW_BUN, {
      "unit/aa.test.ts": T("aa is wrong", "expect(1).toBe(2);"),
      "unit/a.test.tsx": T("tsx is wrong", "expect(1).toBe(2);"),
    });
    const v = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: LIMIT,
      slowChecksPath: known(root),
    });
    const r = await v.verify(undefined, [join(root, "unit/a.test.ts")]);
    expect(r.status).toBe("inconclusive");
    expect(r.runs![1]!.passed).toBe(true);
    expect(r.report).not.toContain("is wrong");
  }, 30_000);

  test("nothing to run in its place: no touched test file, a deleted one, or a runner this does not know", async () => {
    const root = project(SLOW_BUN);
    const v = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: LIMIT,
      slowChecksPath: known(root),
    });
    // The change touched source only.
    expect(shape(await v.verify(undefined, [join(root, "src/value.ts")]))).toEqual([
      [SUITE, true, true],
    ]);
    // It deleted a test file: there is nothing there to run.
    expect(shape(await v.verify(undefined, [join(root, "unit/gone.test.ts")]))).toEqual([
      [SUITE, true, true],
    ]);

    // Another runner: its file arguments are not known here to mean "only these".
    const node = project("sleep 30 && vitest run");
    const w = new CommandVerifier({
      workspaceRoot: node,
      timeoutMs: LIMIT,
      slowChecksPath: known(node),
    });
    const r = await w.verify(undefined, [join(node, "unit/a.test.ts")]);
    expect(shape(r)).toEqual([[SUITE, true, true]]);
    expect(r.status).toBe("inconclusive");

    // Two runners in one script: a touched file may belong to either, and
    // running a browser spec under `bun test` would be a red of this tool's
    // own making.
    const mixed = project("sleep 30 && bun test unit && playwright test");
    const x = new CommandVerifier({
      workspaceRoot: mixed,
      timeoutMs: LIMIT,
      slowChecksPath: known(mixed),
    });
    expect(shape(await x.verify(undefined, [join(mixed, "unit/a.test.ts")]))).toEqual([
      [SUITE, true, true],
    ]);
  }, 30_000);

  test("a check that is not the suite is not replaced by tests", async () => {
    // A typecheck that cannot finish says nothing a test file could say for it.
    const root = project(SLOW_BUN);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", scripts: { typecheck: "sleep 30 && bun test unit" } }),
    );
    const memory = join(scratch("rune-slow-home-"), "verify-slow.json");
    writeFileSync(
      memory,
      JSON.stringify({
        version: 1,
        entries: { [`${root}\0bun run typecheck`]: { at: Date.now(), limitMs: LIMIT, times: 2 } },
      }),
    );
    const v = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: LIMIT,
      slowChecksPath: memory,
    });
    const r = await v.verify(undefined, [join(root, "unit/a.test.ts")]);
    expect(shape(r)).toEqual([["bun run typecheck", true, true]]);
  }, 30_000);
});
