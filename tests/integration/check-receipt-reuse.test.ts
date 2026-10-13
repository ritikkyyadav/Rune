/**
 * A suite the agent ran itself is not run again when it finishes — end to end,
 * through a real Engine.
 *
 * `tests/unit/orchestrator/verifier-receipt-reuse.test.ts` holds the verifier
 * to the rule with a ledger it was handed. This holds the wiring: that a shell
 * command's own result reaches the ledger, with the tree it passed on, and
 * that the verifier the Engine builds asks it.
 *
 * The project is real and so is its suite: one test file that appends a mark
 * to a git-ignored file each time it runs. Ignored, so the mark is not an edit
 * to the tree; inside the workspace, because the agent's shell is sandboxed
 * and may write nowhere else. The scripted agent fixes a one-line bug and runs
 * the suite the way the recorded runs did, through `tail`. How many times the
 * suite ran is then a count of marks, not a claim.
 *
 * Zero live model calls. Needs the native tools binary.
 */

import { describe, expect, test } from "bun:test";

import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { call, runScripted } from "../helpers/small-page";

const native = resolveRuneToolsBinary();

const BROKEN = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n - 1);\n";
const FIXED = "export const lastN = <T>(items: T[], n: number): T[] => items.slice(-n);\n";
const MARKS = ".marks/ran";
const FILES = {
  "package.json": JSON.stringify({ name: "window", scripts: { test: "bun test" } }),
  "bun.lock": "",
  // The mark file is ignored, and its folder is committed: a check's own
  // generated files are cleared when it ends, and a folder that was already
  // there is not one of them.
  ".gitignore": ".marks/ran\n",
  ".marks/.keep": "",
  "window.ts": BROKEN,
  "window.test.ts":
    'import { expect, test } from "bun:test";\nimport { lastN } from "./window";\n' +
    'test("lastN takes the last n", () => {\n' +
    `  require("node:fs").appendFileSync("${MARKS}", "x");\n` +
    "  expect(lastN([1, 2, 3], 2)).toEqual([2, 3]);\n});\n",
};
const REQUEST =
  "In window.ts, lastN returns one item too many: lastN([1, 2, 3], 2) gives [1, 2, 3]. Fix it so it returns the last n items.";
const DONE = [
  { type: "text" as const, text: "lastN now takes exactly the last n. The suite passes." },
];

describe.skipIf(!native.exists)(
  "a suite the agent ran itself, on a tree it then left alone",
  () => {
    test("is run once: the verifier takes the agent's own pass, and says whose it was", async () => {
      const line = "set -o pipefail; bun test 2>&1 | tail -n 8";
      const run = await runScripted(
        native.path,
        REQUEST,
        [
          [call("write_file", { path: "window.ts", content: FIXED })],
          [call("bash", { command: line })],
          DONE,
        ],
        FILES,
      );
      try {
        expect(run.toolFailures).toEqual([]);
        expect(run.stopReason).toBe("end_turn");
        // The suite ran when the agent ran it, and not again at the end.
        expect(run.read(MARKS).length).toBe(1);
        expect(run.verification).toEqual(["passed"]);
        expect(run.verificationReports[0]).toContain("this run already ran it");
        expect(run.verificationReports[0]).toContain(`as \`${line}\``);
        expect(run.verificationReports[0]).toContain("not run again");
      } finally {
        run.dispose();
      }
    }, 120_000);

    test("is run again when the agent changed a file after its own run", async () => {
      const run = await runScripted(
        native.path,
        REQUEST,
        [
          [call("write_file", { path: "window.ts", content: FIXED })],
          [call("bash", { command: "bun test" })],
          // One more edit, after the green run: that pass is about another tree.
          [call("write_file", { path: "window.ts", content: `${FIXED}// tidy\n` })],
          DONE,
        ],
        FILES,
      );
      try {
        expect(run.read(MARKS).length).toBe(2);
        expect(run.verification).toEqual(["passed"]);
        expect(run.verificationReports[0]).not.toContain("already ran it");
      } finally {
        run.dispose();
      }
    }, 120_000);

    test("is run again when the agent's line could have hidden a failure", async () => {
      const run = await runScripted(
        native.path,
        REQUEST,
        [
          [call("write_file", { path: "window.ts", content: FIXED })],
          // A pipe with nothing guarding it: exit 0 is `tail`'s.
          [call("bash", { command: "bun test 2>&1 | tail -n 8" })],
          DONE,
        ],
        FILES,
      );
      try {
        expect(run.read(MARKS).length).toBe(2);
        expect(run.verificationReports[0]).not.toContain("already ran it");
      } finally {
        run.dispose();
      }
    }, 120_000);

    test("a suite the agent ran red is run again, and the failure is the verifier's to report", async () => {
      const run = await runScripted(
        native.path,
        REQUEST,
        // No fix: the suite fails when the agent runs it, and again at the end.
        [
          [call("bash", { command: "bun test" })],
          [call("write_file", { path: "extra.ts", content: "export const extra = 1;\n" })],
          DONE,
        ],
        FILES,
      );
      try {
        expect(run.verification[0]).toBe("failed");
        expect(run.verificationReports[0]).not.toContain("already ran it");
      } finally {
        run.dispose();
      }
    }, 120_000);
  },
);
