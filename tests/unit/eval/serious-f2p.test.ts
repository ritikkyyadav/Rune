// ─── Fail-to-pass validation of a mined candidate ───
//
// tests/eval/serious/f2p.ts sorts every hidden test into exactly one class from
// two runs at the parent and two with the fix applied, and keeps a candidate
// only when a check exists that the fix turns from red to green, reliably and
// quickly. A wrong class here puts a check that nobody can pass, or one that
// was already passing, into an arm's score.

import { describe, expect, test } from "bun:test";

import { classify, FIXED_RUN_LIMIT_MS, keepVerdict } from "../../eval/serious/f2p";
import type { TestResults } from "../../eval/serious/grade";

const P = "pass" as const;
const F = "fail" as const;
const S = "skip" as const;

describe("four runs → one class per test", () => {
  const base: TestResults[] = [
    { f2p: F, p2p: P, impossible: F, broken: P, "flaky-base": P, "flaky-fix": F, skipped: F },
    { f2p: F, p2p: P, impossible: F, broken: P, "flaky-base": F, "flaky-fix": F, skipped: F },
  ];
  const fixed: TestResults[] = [
    {
      f2p: P,
      p2p: P,
      impossible: F,
      broken: F,
      "flaky-base": P,
      "flaky-fix": P,
      skipped: S,
      "new-in-fix": P,
    },
    {
      f2p: P,
      p2p: P,
      impossible: F,
      broken: F,
      "flaky-base": P,
      "flaky-fix": F,
      skipped: S,
      "new-in-fix": P,
    },
  ];
  const c = classify(base, fixed);

  test("fail-to-pass: failing at the parent both times, passing with the fix both times", () => {
    expect(c.f2p).toEqual(["f2p", "new-in-fix"]);
  });

  test("a test that did not run at the parent failed there", () => {
    expect(c.f2p).toContain("new-in-fix");
  });

  test("pass-to-pass: passing in all four runs", () => {
    expect(c.p2p).toEqual(["p2p"]);
  });

  test("impossible: not passing with the fix, whatever it did at the parent", () => {
    expect(c.impossible).toEqual(["broken", "impossible"]);
  });

  test("flaky: two runs of one tree disagree, at the parent or with the fix", () => {
    expect(c.flaky).toEqual(["flaky-base", "flaky-fix"]);
  });

  test("skipped with the fix is no check at all", () => {
    expect(c.skipped).toEqual(["skipped"]);
  });

  test("every test lands in exactly one class", () => {
    const all = [...c.f2p, ...c.p2p, ...c.impossible, ...c.flaky, ...c.skipped];
    expect(all.sort()).toEqual(Object.keys({ ...base[0], ...fixed[0] }).sort());
  });
});

describe("keep or reject", () => {
  const withF2p = { f2p: ["a"], p2p: [], impossible: [], flaky: [], skipped: [] };
  const fast = [
    { wallMs: 1_000, timedOut: false },
    { wallMs: 2_000, timedOut: false },
  ];

  test("kept: a fail-to-pass check, and each fixed-tree run under 120 s", () => {
    expect(keepVerdict(withF2p, fast)).toEqual({ keep: true });
    expect(keepVerdict(withF2p, [{ wallMs: FIXED_RUN_LIMIT_MS - 1, timedOut: false }])).toEqual({
      keep: true,
    });
  });

  test("rejected without a fail-to-pass check, however much else there is", () => {
    const verdict = keepVerdict({ ...withF2p, f2p: [], p2p: ["b"], impossible: ["c"] }, fast);
    expect(verdict).toMatchObject({ keep: false, reason: "no-f2p" });
  });

  test("rejected when either fixed-tree run takes 120 s or more, or was killed", () => {
    const slow = [fast[0]!, { wallMs: FIXED_RUN_LIMIT_MS, timedOut: false }];
    expect(keepVerdict(withF2p, slow)).toMatchObject({ keep: false, reason: "slow" });
    const killed = [{ wallMs: 5_000, timedOut: true }];
    expect(keepVerdict(withF2p, killed)).toMatchObject({ keep: false, reason: "slow" });
  });
});
