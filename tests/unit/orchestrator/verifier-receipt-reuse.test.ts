/**
 * A suite the run already ran green, on a tree nothing has touched since, is
 * not waited for again.
 *
 * Recorded 2026-10-08 (`~/rune-evidence/b2-s6-serious-fixed-20261008`,
 * startup-selection): the agent ran `set -o pipefail; bun test tests/unit/
 * 2>&1 | tail -n 8` — 4987 pass, 0 fail, 52 seconds — changed no file, and
 * finished. The verifier then started `bun run test`, which is that suite, was
 * killed at 120 seconds, and reported that nothing was measured. 125 of the
 * run's 573 seconds.
 *
 * The suite here is a real `bun test` over a real file that takes longer than
 * the limit, in a real git repository, and whether it was STARTED is read from
 * a marker the test file writes outside the tree. Nothing is mocked: what is
 * being pinned is that a process was not spawned.
 *
 * And from the other side, that a receipt is never more than it is: a pass on
 * another tree, a line that does not speak for the suite, and a pass of some
 * other check each leave the suite to run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PassLedger,
  equivalentCommands,
  workTreeFingerprint,
} from "../../../packages/orchestrator/src/check-receipts";
import { CommandVerifier } from "../../../packages/orchestrator/src/verifier";
import { rmTemp } from "../../helpers/tmp";

const made: string[] = [];
let marker = "";
let previousMarker: string | undefined;
beforeEach(() => {
  previousMarker = process.env.RUNE_TEST_RECEIPT_MARKER;
  const dir = mkdtempSync(join(tmpdir(), "rune-reuse-marker-"));
  made.push(dir);
  marker = join(dir, "started");
  process.env.RUNE_TEST_RECEIPT_MARKER = marker;
});
afterEach(() => {
  if (previousMarker === undefined) delete process.env.RUNE_TEST_RECEIPT_MARKER;
  else process.env.RUNE_TEST_RECEIPT_MARKER = previousMarker;
  for (const dir of made.splice(0)) rmTemp(dir);
});

/** How many times a test file of the fixture began to run. */
const starts = (): number => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0);

const MARK = 'require("node:fs").appendFileSync(process.env.RUNE_TEST_RECEIPT_MARKER, "x");';
const SLOW =
  'import { test } from "bun:test";\n' +
  `test("the suite", async () => { ${MARK} await new Promise((r) => setTimeout(r, 4000)); }, 20000);\n`;
const QUICK = `import { expect, test } from "bun:test";\ntest("the suite", () => { ${MARK} expect(1).toBe(1); });\n`;
const RED =
  'import { expect, test } from "bun:test";\ntest("red", () => { expect(1).toBe(2); });\n';

/** A project whose `test` script is `bun test`, committed, with one test file. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rune-reuse-"));
  made.push(root);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore" },
    );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "p", scripts: { test: "bun test" } }),
  );
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git("init", "-q", "--initial-branch=main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return root;
}

/** The verifier as the Engine builds it: receipts kept by tree, its own passes included. */
function session(
  root: string,
  opts: { timeoutMs?: number; commands?: string[]; reuse?: boolean } = {},
) {
  const ledger = new PassLedger(() => workTreeFingerprint(root), true);
  const logged: string[] = [];
  const verifier = new CommandVerifier({
    workspaceRoot: root,
    timeoutMs: opts.timeoutMs ?? 700,
    ...(opts.commands ? { commands: opts.commands } : {}),
    ...(opts.reuse === false
      ? {}
      : {
          priorPass: ({ command }: { command: string }) =>
            ledger.fresh(opts.commands ? [command] : equivalentCommands(root, command)),
        }),
    onCheck: (run) => {
      logged.push(`${run.command}:${run.passed ? "ok" : "red"}`);
      if (run.passed) ledger.noteCheck(run.command, { at: Date.now(), durationMs: run.durationMs });
    },
  });
  return { ledger, verifier, logged };
}

const THE_RECORDED_LINE = "set -o pipefail; bun test 2>&1 | tail -n 8";

describe("a suite that cannot finish under the limit", () => {
  test("with no pass on record it is started, killed at the limit, and measures nothing", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const { verifier } = session(root);
    const began = Date.now();
    const result = await verifier.verify();
    expect(starts()).toBe(1);
    expect(Date.now() - began).toBeGreaterThanOrEqual(600);
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toBe("timeout");
    expect(result.report).toContain("nothing was measured");
  }, 30_000);

  test("after the run ran it green itself and changed nothing, it is not started — and the pass says where it came from", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const { verifier, ledger, logged } = session(root);
    const at = Date.now() - 68_000;
    ledger.noteShell(THE_RECORDED_LINE, { at, durationMs: 51_970 });

    const began = Date.now();
    const result = await verifier.verify();
    // The process was never spawned.
    expect(starts()).toBe(0);
    expect(Date.now() - began).toBeLessThan(600);
    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs![0]).toMatchObject({
      command: "bun run test",
      passed: true,
      exitCode: 0,
      durationMs: 0,
      reused: { at, ranAs: THE_RECORDED_LINE, durationMs: 51_970 },
    });
    // Said as what it is: when, as what, and that it was not run now.
    expect(result.report).toContain("$ bun run test  (ok — this run already ran it");
    expect(result.report).toContain(`as \`${THE_RECORDED_LINE}\``);
    expect(result.report).toContain("1 minute ago in 52s");
    expect(result.report).toContain("nothing has changed since; not run again");
    // The earlier run is already on the log. It is not logged a second time.
    expect(logged).toEqual([]);
  }, 30_000);

  test("an edit after the pass, and the suite is started again; put the file back, and it is not", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const { verifier, ledger } = session(root);
    ledger.noteShell(THE_RECORDED_LINE, { at: Date.now() });

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    const moved = await verifier.verify();
    expect(starts()).toBe(1);
    expect(moved.status).toBe("inconclusive");
    expect(moved.runs![0]!.reused).toBeUndefined();

    // The tree it passed on, byte for byte.
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    const back = await verifier.verify();
    expect(starts()).toBe(1);
    expect(back.status).toBe("passed");
    expect(back.runs![0]!.reused).toBeDefined();
  }, 30_000);

  test("a new test file is an edit too", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const { verifier, ledger } = session(root);
    ledger.noteShell(THE_RECORDED_LINE, { at: Date.now() });
    writeFileSync(join(root, "added.test.ts"), RED);
    const result = await verifier.verify();
    expect(result.runs![0]!.reused).toBeUndefined();
    expect(result.status).not.toBe("passed");
  }, 30_000);

  const notThisPass: Array<[string, string]> = [
    ["a pipe with nothing guarding it", "bun test 2>&1 | tail -n 8"],
    ["a fallback after it", "bun test || true"],
    ["a different selection of tests", "set -o pipefail; bun test ./other.test.ts | tail -n 8"],
    ["the suite under an environment the script does not set", "CI=1 bun test"],
    ["the suite run somewhere else", "cd packages/x && bun test"],
    ["some other check", "bun run typecheck"],
  ];
  for (const [why, line] of notThisPass) {
    test(`a pass of ${why} is not a pass of the suite: ${line}`, async () => {
      const root = project({ "slow.test.ts": SLOW });
      const { verifier, ledger } = session(root);
      ledger.noteShell(line, { at: Date.now() });
      const result = await verifier.verify();
      expect(starts()).toBe(1);
      expect(result.status).toBe("inconclusive");
    }, 30_000);
  }

  test("with reuse switched off the suite runs, whatever is on record", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const { verifier, ledger } = session(root, { reuse: false });
    ledger.noteShell(THE_RECORDED_LINE, { at: Date.now() });
    const result = await verifier.verify();
    expect(starts()).toBe(1);
    expect(result.status).toBe("inconclusive");
  }, 30_000);

  test("a receipt that cannot be read is no receipt: the suite runs", async () => {
    const root = project({ "slow.test.ts": SLOW });
    const verifier = new CommandVerifier({
      workspaceRoot: root,
      timeoutMs: 700,
      priorPass: () => {
        throw new Error("the ledger is unreadable");
      },
    });
    const result = await verifier.verify();
    expect(starts()).toBe(1);
    expect(result.status).toBe("inconclusive");
  }, 30_000);
});

describe("a pass that is reused is one check's, and no more", () => {
  test("a reused pass beside a check that fails is a failure", async () => {
    const root = project({ "quick.test.ts": QUICK, "red.test.ts": RED });
    const commands = ["bun test ./quick.test.ts", "bun test ./red.test.ts"];
    const { verifier, ledger, logged } = session(root, { commands, timeoutMs: 20_000 });
    ledger.noteCheck("bun test ./quick.test.ts", { at: Date.now() });

    const result = await verifier.verify();
    expect(starts()).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.passed).toBe(false);
    expect(result.runs!.map((r) => [r.command, r.passed, Boolean(r.reused)])).toEqual([
      ["bun test ./quick.test.ts", true, true],
      ["bun test ./red.test.ts", false, false],
    ]);
    // Only the one that ran is logged.
    expect(logged).toEqual(["bun test ./red.test.ts:red"]);
  }, 30_000);

  test("a command the person wrote in [verify] commands is matched as written, never by a script's body", async () => {
    const root = project({ "quick.test.ts": QUICK });
    const { verifier, ledger } = session(root, { commands: ["bun run test"], timeoutMs: 20_000 });
    // The body of the `test` script — a match for a DETECTED check, not for theirs.
    ledger.noteShell("bun test", { at: Date.now() });
    const result = await verifier.verify();
    expect(starts()).toBe(1);
    expect(result.runs![0]!.reused).toBeUndefined();
    expect(result.status).toBe("passed");
  }, 30_000);

  test("the verifier's own green pass is a receipt for its next pass on the same tree, and only that tree", async () => {
    const root = project({ "quick.test.ts": QUICK });
    const { verifier, logged } = session(root, { timeoutMs: 20_000 });

    const first = await verifier.verify();
    expect(first.status).toBe("passed");
    expect(starts()).toBe(1);
    expect(first.runs![0]!.reused).toBeUndefined();

    const second = await verifier.verify();
    expect(second.status).toBe("passed");
    expect(starts()).toBe(1);
    expect(second.runs![0]!.reused).toBeDefined();

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    const third = await verifier.verify();
    expect(third.status).toBe("passed");
    expect(starts()).toBe(2);
    expect(third.runs![0]!.reused).toBeUndefined();
    // Two runs, two log lines: the reused pass in between wrote none.
    expect(logged).toEqual(["bun run test:ok", "bun run test:ok"]);
  }, 30_000);

  test("a red run leaves no receipt: it is run again on the same tree", async () => {
    const root = project({ "red.test.ts": RED });
    const { verifier } = session(root, { timeoutMs: 20_000 });
    const first = await verifier.verify();
    const second = await verifier.verify();
    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(second.runs![0]!.reused).toBeUndefined();
  }, 30_000);
});
