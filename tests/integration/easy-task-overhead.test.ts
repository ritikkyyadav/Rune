/**
 * P1 — an easy task costs its own four completions and nothing more.
 *
 * `tests/helpers/easy-task.ts` is a one-line fix done by a scripted model that
 * calls no bookkeeping tool: read the file, make the edit, run the test, say
 * so. Anything else that happens in the run is the harness's doing, so this is
 * where a NEWLY MANDATORY bookkeeping call would show up — a gate that refuses
 * the finish until a list is written, a nudge that demands a read-back, a
 * re-prompt asking for a citation.
 *
 * It pins the harness's side only. What a real model chooses to call after
 * reading the prompt is a different question, and not one a script can answer.
 *
 * Zero live model calls. Needs the native tools binary.
 */

import { describe, expect, test } from "bun:test";

import { runEasyTask } from "../helpers/easy-task";
import { resolveRuneToolsBinary } from "../helpers/native-binary";

const native = resolveRuneToolsBinary();

describe.skipIf(!native.exists)("an easy task, done with no bookkeeping", () => {
  test("is four completions, three tool calls, one green check — and no turn the harness added", async () => {
    const run = await runEasyTask(native.path);
    try {
      // The work: read, edit, test, report.
      expect(run.tools).toEqual(["read_file", "write_file", "bash"]);
      expect(run.requests).toBe(4);
      expect(run.roles).toEqual(["primary", "primary", "primary", "primary"]);
      // Nothing the harness asked for on top of it.
      expect(run.harnessTurns).toEqual([]);
      expect(run.notices).toEqual([]);
      expect(run.bookkeepingCalls).toBe(0);
      // It was checked, by the project's own test, and it finished.
      expect(run.verification).toEqual(["passed"]);
      expect(run.stopReason).toBe("end_turn");
      expect(run.testExit).toBe(0);
    } finally {
      run.dispose();
    }
  }, 120_000);
});
