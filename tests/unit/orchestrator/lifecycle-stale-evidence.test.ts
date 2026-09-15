/**
 * A criterion whose evidence was taken against a different tree drops one
 * rung — including the two shapes an ordinary agent run actually produces.
 *
 * The rule shipped "covered by construction", with no test anywhere. Written
 * by an independent verifier, and both of its red cases are now fixed: a
 * claim taken on a DIRTY tree could never go stale while HEAD stood still
 * (which is every run — nothing commits mid-run), and a demotion re-fired on
 * every call, decaying one rung per resume with nothing having changed.
 */

import { describe, expect, test } from "bun:test";
import { changesTheWork, demoteStaleCriteria } from "../../../packages/orchestrator/src/lifecycle";
import type { Criterion } from "../../../packages/protocol/src/index";

function criterion(rung: Criterion["rung"], head: string | null, dirty: boolean): Criterion {
  return {
    text: "the exporter writes every row",
    rung,
    evidence: {
      source: "bun test",
      ...(head ? { head } : {}),
      dirty,
    },
  } as unknown as Criterion;
}

describe("demoteStaleCriteria", () => {
  test("HEAD moving drops one rung, as claimed", () => {
    const c = [criterion("verified", "aaa", false)];
    expect(demoteStaleCriteria(c, { head: "bbb", dirty: false })).toEqual([
      { text: "the exporter writes every row", from: "verified", to: "reproduced" },
    ]);
    expect(c[0]!.rung).toBe("reproduced");
  });

  test("observed and suspected cannot go stale, as claimed", () => {
    for (const rung of ["suspected", "observed"] as const) {
      const c = [criterion(rung, "aaa", false)];
      expect(demoteStaleCriteria(c, { head: "bbb", dirty: true })).toEqual([]);
      expect(c[0]!.rung).toBe(rung);
    }
  });

  test("a claim recorded on a DIRTY tree goes stale even while HEAD stands still", () => {
    // The ordinary agent loop: the tree already has uncommitted work when the
    // run starts and nothing commits before it ends, so HEAD never moves.
    // With no digest on either side nothing can be shown to have held, so the
    // claim drops a rung rather than standing forever on an unmoving HEAD.
    const c = [criterion("verified", "aaa", true)];
    expect(demoteStaleCriteria(c, { head: "aaa", dirty: true })).toEqual([
      { text: "the exporter writes every row", from: "verified", to: "reproduced" },
    ]);
  });

  test("one change costs one rung: the same revision never demotes twice", () => {
    // The demotion is keyed by the revision that caused it (`evidence.staleAt`)
    // rather than re-stamping `evidence.head`, which still says truly where
    // the evidence was taken. Without the key the identical fact demoted
    // again on every resume — verified → reproduced → observed — which is the
    // "demoting every criterion on every resume" the rule exists to avoid.
    const c = [criterion("verified", "aaa", false)];
    const now = { head: "bbb", dirty: false };
    expect(demoteStaleCriteria(c, now)).toHaveLength(1);
    expect(c[0]!.rung).toBe("reproduced");
    // Second resume, same workspace, nothing has changed since:
    expect(demoteStaleCriteria(c, now)).toEqual([]);
    expect(c[0]!.rung).toBe("reproduced");
  });

  test("a claim taken before revisions were tracked is left alone, as claimed", () => {
    const c = [criterion("verified", null, false)];
    expect(demoteStaleCriteria(c, { head: "bbb", dirty: true })).toEqual([]);
    expect(c[0]!.rung).toBe("verified");
  });
});

describe("the harness's own footprint is not the tree moving (V7 finding 10)", () => {
  // Rune writes `<workspace>/.rune/tool-children.jsonl` DURING a run. In any
  // project whose `.gitignore` has not been told about `.rune/` that made the
  // tree dirty between the check and the verdict, so `treeMovedUnder` fired on
  // Rune's own evidence and a genuinely passing acceptance read `stale`.
  // Measured end to end in `acceptance-across-sessions.test.ts`; this is the
  // porcelain reading underneath it.
  const dirtyFrom = (porcelain: string): boolean =>
    porcelain.split("\n").some((line) => changesTheWork(line));

  test("Rune's own directory is not dirt, in any of its spellings", () => {
    expect(dirtyFrom("?? .rune/")).toBe(false);
    expect(dirtyFrom("?? .rune/tool-children.jsonl")).toBe(false);
    expect(dirtyFrom(" M .gear/mission.md")).toBe(false);
    expect(dirtyFrom("")).toBe(false);
  });

  test("everything else still is, including what the model left untracked", () => {
    expect(dirtyFrom("?? mine.test.ts")).toBe(true);
    expect(dirtyFrom(" M api.ts")).toBe(true);
    expect(dirtyFrom('?? "spaced name.ts"')).toBe(true);
    // A rename reads its DESTINATION, which is where the content now is.
    expect(dirtyFrom("R  old.ts -> new.ts")).toBe(true);
    expect(dirtyFrom("R  api.ts -> .rune/api.ts")).toBe(false);
    // One harness line beside one real change is still a changed tree.
    expect(dirtyFrom("?? .rune/\n M api.ts")).toBe(true);
  });
});
