/**
 * A small page, built with no bookkeeping, costs its own completions and
 * nothing more — and is told nothing that contradicts itself.
 *
 * `tests/helpers/small-page.ts` is the first of the three prompts recorded on
 * 2026-10-09, done by a scripted model in four completions: write the page,
 * write its stylesheet and script, check them, say so. In those recordings
 * Rune made 27 to 39 model calls a page; the scripted work is four. Whatever
 * else a run here pays for, the harness asked for.
 *
 * Three things the recordings showed the harness asking for are pinned:
 *
 *   · a reviewer call for the page's own check, because the script printed the
 *     word "render" and said `delete`;
 *   · a read-back, because the note about the missing browser opened with one;
 *   · a search, a question and a rewrite, because the art-direction tripwire
 *     fired on the first screen of a run it had already told nobody was there.
 *
 * It pins the harness's side only. What a real model chooses to call after
 * reading these requests is measured by a live run.
 *
 * Zero live model calls. Needs the native tools binary, and a machine that can
 * contain a shell command (without one every command is reviewed, by design).
 */

import { describe, expect, test } from "bun:test";

import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { PAGE_REQUEST, PAGE_SCRIPT, call, runScripted } from "../helpers/small-page";

const native = resolveRuneToolsBinary();

describe.skipIf(!native.exists)("a small page, built with no bookkeeping", () => {
  test("is four completions and four tool calls — no reviewer call, no turn the harness added", async () => {
    const run = await runScripted(native.path, PAGE_REQUEST, PAGE_SCRIPT);
    try {
      // The work: the page, its stylesheet and script, one check, the report.
      expect(run.toolFailures).toEqual([]);
      expect(run.tools).toEqual(["write_file", "write_file", "write_file", "bash"]);
      expect(run.primaryRequests).toBe(4);
      // Nothing the harness asked for on top of it. The one row it wrote is
      // the opening notes, which ride the first request: no gate refused the
      // finish and nothing was re-prompted, or there would be a fifth completion.
      expect(run.harnessTurns).toEqual(["nudge:harness-notes"]);
      expect(run.bookkeepingCalls).toBe(0);
      // The check is a script on standard input that says "render" and
      // `delete`. It is ordinary work, and no model is asked about it.
      if (run.contained) expect(run.reviewerRoles).toEqual([]);
      // It finished, and said what it could not do rather than refusing over it.
      expect(run.stopReason).toBe("end_turn");
      expect(run.notices.some((n) => n.startsWith("Pre-flight: no browser in this run"))).toBe(
        true,
      );
      expect(run.notices.some((n) => n.startsWith("UI not viewed"))).toBe(true);
      expect(run.notices).toHaveLength(2);
      // No criteria were stated, so nothing was promised and nothing is unmet:
      // a headless caller is told the run finished.
      expect(run.criteria).toBe(0);
      expect(run.unfinished).toBeUndefined();
    } finally {
      run.dispose();
    }
  }, 120_000);

  test("is told once that nobody is there, and never to stop and ask", async () => {
    const run = await runScripted(native.path, PAGE_REQUEST, PAGE_SCRIPT);
    try {
      expect(run.firstRequest).toContain("nobody is here to answer questions");
      expect(run.firstRequest).toContain("do not research one");
      expect(run.firstRequest).toContain("State in your final report");
      // The opening that every recorded run answered with a read_back call.
      expect(run.firstRequest).not.toContain("Say so in your read-back");
      // The tripwire that told the same run, on its first screen, to ask.
      expect(run.everythingShown).not.toContain("TWO OR THREE concrete directions");
      expect(run.everythingShown).not.toContain("search how that genre looks today");
      expect(run.everythingShown).not.toContain("rewrite this file to it");
      // Three files of one page are not a plan's worth of steps.
      expect(run.everythingShown).not.toContain("If this task has 3+ steps");
    } finally {
      run.dispose();
    }
  }, 120_000);

  // The other half of what the count above means. An instrument that reads
  // zero reviewer calls has to be one that would have read one.
  test("a command that does delete something remote is still put to the reviewer", async () => {
    const run = await runScripted(native.path, "Tidy up the old gists.", [
      [call("bash", { command: "gh gist delete abc123 --yes" })],
      [{ type: "text", text: "Could not delete it." }],
    ]);
    try {
      expect(run.reviewerRoles).toContain("classifier");
    } finally {
      run.dispose();
    }
  }, 120_000);
});
