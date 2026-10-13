/**
 * A run's own ledger says what effort each call was made at — and under "task"
 * routing that is one effort, with at most one move.
 *
 * `tests/unit/orchestrator/agent-loop-task-effort.test.ts` holds the loop to
 * the shape of its request trace. This holds the two things that sit either
 * side of the loop: that the `[llm] effortRouting` setting reaches it through
 * a real Engine, and that the effort of every call it then makes is written to
 * the session database, which is where a comparison of two runs is read from.
 *
 * Before 2026-10-14 a cost row carried no effort at all. A run at `medium` and
 * a run at `high` left identical rows, and a turn whose effort had changed —
 * the thing that costs the prompt cache on Codex — showed only as a row with
 * no cached tokens and no reason.
 *
 * Zero live model calls. Needs the native tools binary.
 */

import { describe, expect, test } from "bun:test";

import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { call, runScripted } from "../helpers/small-page";

const native = resolveRuneToolsBinary();

const FILES = {
  "package.json": JSON.stringify({ name: "notes", scripts: { test: "bun test" } }),
  "bun.lock": "",
  "notes.ts": "export interface Note { id: string; text: string }\n",
  "notes.test.ts":
    'import { expect, test } from "bun:test";\nimport * as notes from "./notes";\n' +
    'test("the module loads", () => { expect(notes).toBeDefined(); });\n',
};
const SMALL = "Add a `tags: string[]` field to Note in notes.ts.";
const WITH_TAGS = "export interface Note { id: string; text: string; tags: string[] }\n";
const DONE = [{ type: "text" as const, text: "Note has a tags field now." }];
const WORK = [
  [call("read_file", { path: "notes.ts" })],
  [call("write_file", { path: "notes.ts", content: WITH_TAGS })],
  [call("bash", { command: "bun test" })],
  DONE,
];

const primary = (costs: Array<{ role: string; effort: string | undefined }>) =>
  costs.filter((c) => c.role === "primary").map((c) => c.effort);
const moves = (efforts: Array<string | undefined>) =>
  efforts.filter((e, i) => i > 0 && e !== efforts[i - 1]).length;

describe.skipIf(!native.exists)("the effort of every call, on the run's own ledger", () => {
  test("under task routing a small task is one effort from first call to last", async () => {
    const run = await runScripted(native.path, SMALL, WORK, FILES, {
      effortRouting: "task",
      reasoningEffort: "high",
    });
    try {
      const efforts = primary(run.costs);
      expect(efforts.length).toBe(run.primaryRequests);
      expect(efforts.length).toBeGreaterThanOrEqual(4);
      // Every call carries one, and it is the notch below the ceiling.
      expect(new Set(efforts)).toEqual(new Set(["medium"]));
      expect(moves(efforts)).toBe(0);
      expect(run.verification).toEqual(["passed"]);
    } finally {
      run.dispose();
    }
  }, 120_000);

  test("a fix starts at the ceiling under the same setting", async () => {
    const run = await runScripted(
      native.path,
      "notes.ts is broken: fix the Note type so the test passes.",
      WORK,
      FILES,
      { effortRouting: "task", reasoningEffort: "high" },
    );
    try {
      expect(new Set(primary(run.costs))).toEqual(new Set(["high"]));
    } finally {
      run.dispose();
    }
  }, 120_000);

  test("a check that fails raises it once, and the ledger shows where", async () => {
    const run = await runScripted(
      native.path,
      SMALL,
      [
        [call("read_file", { path: "notes.ts" })],
        // A change that breaks the suite: the test imports a module that no longer parses.
        [call("write_file", { path: "notes.ts", content: "export interface Note {\n" })],
        DONE, // the end-of-turn check fails here
        [call("write_file", { path: "notes.ts", content: WITH_TAGS })],
        DONE,
      ],
      FILES,
      { effortRouting: "task", reasoningEffort: "high" },
    );
    try {
      const efforts = primary(run.costs);
      expect(run.verification[0]).toBe("failed");
      expect(efforts.slice(0, 3)).toEqual(["medium", "medium", "medium"]);
      expect(efforts.at(-1)).toBe("high");
      // One move, upward, and nothing after it comes back down.
      expect(moves(efforts)).toBe(1);
      expect(efforts.slice(efforts.indexOf("high")).every((e) => e === "high")).toBe(true);
    } finally {
      run.dispose();
    }
  }, 120_000);

  test("the default routing is untouched: the same task with no setting is not run a notch down by this", async () => {
    const run = await runScripted(native.path, SMALL, WORK, FILES, { reasoningEffort: "high" });
    try {
      const efforts = primary(run.costs);
      // "conservative" on a host where a change of effort is free: the
      // planning turn at the ceiling, as it has been.
      expect(efforts[0]).toBe("high");
      expect(efforts.every((e) => e === "high" || e === "medium")).toBe(true);
    } finally {
      run.dispose();
    }
  }, 120_000);
});
