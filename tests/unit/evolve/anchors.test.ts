/**
 * P7.9 — the external anchors.
 *
 * What is worth testing here is not arithmetic, it is the REFUSALS: that a
 * subset stays pinned, that a lift needs both arms from the same day, and that
 * an unscored task is excluded rather than counted as a failure. Those three
 * are the ways a benchmark number gets quietly flattered.
 */

import { describe, expect, it } from "bun:test";

import {
  ANCHORS,
  anchorLift,
  loadAnchor,
  planFor,
  resolveRate,
  type AnchorResult,
} from "../../../tests/eval/anchors";

function result(over: Partial<AnchorResult>): AnchorResult {
  return {
    benchmark: "SWE-bench Verified",
    arm: "pristine",
    at: "2026-09-02T00:00:00.000Z",
    model: "m",
    provider: "p",
    attempted: 50,
    resolved: 10,
    unscored: 0,
    listUsd: null,
    runeSha: "abc1234",
    ...over,
  };
}

describe("the pinned subsets", () => {
  it("declares both anchors with the sizes the docs promise", () => {
    expect(Object.keys(ANCHORS).sort()).toEqual(["swe-bench-verified-50", "terminal-bench-20"]);
    expect(loadAnchor("swe-bench-verified-50").task_ids).toHaveLength(50);
    expect(loadAnchor("terminal-bench-20").task_ids).toHaveLength(20);
  });

  it("has no duplicate ids — a duplicate quietly reweights the subset", () => {
    for (const name of Object.keys(ANCHORS)) {
      const ids = loadAnchor(name).task_ids;
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("records when each subset was pinned, so a change to the series is visible", () => {
    for (const name of Object.keys(ANCHORS)) {
      expect(loadAnchor(name).pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(loadAnchor(name).source.length).toBeGreaterThan(10);
    }
  });
});

describe("resolveRate", () => {
  it("excludes unscored tasks instead of counting them as failures", () => {
    // A quota that ran out mid-run is not a capability result. Same rule as the
    // eval suite's throttled tasks.
    expect(resolveRate(result({ resolved: 10, attempted: 50, unscored: 0 }))).toBeCloseTo(0.2);
    expect(resolveRate(result({ resolved: 10, attempted: 50, unscored: 10 }))).toBeCloseTo(0.25);
  });

  it("reports null, never zero, when nothing was scored", () => {
    expect(resolveRate(result({ attempted: 50, unscored: 50, resolved: 0 }))).toBeNull();
  });
});

describe("anchorLift", () => {
  it("refuses a lift with only the evolved arm", () => {
    // The failure mode this exists for: publishing the evolved number alone.
    expect(anchorLift([result({ arm: "evolved", resolved: 20 })], "SWE-bench Verified")).toBeNull();
  });

  it("refuses a lift with only the control arm", () => {
    expect(anchorLift([result({ arm: "pristine" })], "SWE-bench Verified")).toBeNull();
  });

  it("pairs the two arms from the same day", () => {
    const lift = anchorLift(
      [result({ arm: "pristine", resolved: 10 }), result({ arm: "evolved", resolved: 15 })],
      "SWE-bench Verified",
    );
    expect(lift).not.toBeNull();
    expect(lift!.pristine).toBeCloseTo(0.2);
    expect(lift!.evolved).toBeCloseTo(0.3);
    expect(lift!.lift).toBeCloseTo(0.1);
    expect(lift!.at).toBe("2026-09-02");
  });

  it("does not pair arms from different days", () => {
    expect(
      anchorLift(
        [
          result({ arm: "pristine", at: "2026-08-01T00:00:00.000Z" }),
          result({ arm: "evolved", at: "2026-09-02T00:00:00.000Z", resolved: 40 }),
        ],
        "SWE-bench Verified",
      ),
    ).toBeNull();
  });

  it("ignores another benchmark's rows", () => {
    expect(
      anchorLift(
        [
          result({ arm: "pristine" }),
          result({ arm: "evolved", benchmark: "Terminal-Bench", resolved: 40 }),
        ],
        "SWE-bench Verified",
      ),
    ).toBeNull();
  });
});

describe("planFor", () => {
  it("prints commands and downloads nothing", () => {
    for (const name of Object.keys(ANCHORS)) {
      for (const arm of ["pristine", "evolved"] as const) {
        const plan = planFor(name, arm).join("\n");
        expect(plan).toContain(arm);
        // The scaffolding must stay a plan. If this file ever grows a fetch or
        // a docker invocation, the numbers stop being the benchmark's.
        expect(plan).toContain("--record");
      }
    }
    expect(planFor("swe-bench-verified-50", "pristine").join("\n")).toContain("--pristine");
    expect(planFor("swe-bench-verified-50", "evolved").join("\n")).not.toContain("--pristine");
  });

  it("refuses an anchor it does not declare", () => {
    expect(() => planFor("made-up-bench", "pristine")).toThrow(/unknown anchor/);
  });
});
