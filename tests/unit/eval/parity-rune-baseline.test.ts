/**
 * Two Rune builds in one series (R8 of the reliability plan): `rune` and
 * `rune-baseline` launch the same way, each from its own binary, on the
 * shipped defaults, and both are on the metered account.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ARMS, parseCli, planPairs } from "../../../tests/eval/parity/run-pairs";

const base = [
  "--dry-run",
  "--out",
  "/tmp/x",
  "--arms",
  "rune,rune-baseline",
  "--model",
  "m",
  "--tasks",
  "csv-state-machine",
  "--rune-bin",
  "/opt/new/rune",
  "--rune-baseline-bin",
  "/opt/old/rune",
];

describe("rune against rune-baseline", () => {
  test("is a series of two arms, each with its own binary", () => {
    const options = parseCli(base)!;
    expect(options.arms).toEqual(["rune", "rune-baseline"]);
    expect(options.specs.rune?.command).toEqual([resolve("/opt/new/rune")]);
    expect(options.specs["rune-baseline"]?.command).toEqual([resolve("/opt/old/rune")]);
  });

  test("neither takes an effort: both run on the shipped defaults", () => {
    const options = parseCli([...base, "--effort", "high", "--rune-baseline-effort", "high"])!;
    expect(options.specs.rune?.reasoningEffort).toBeUndefined();
    expect(options.specs["rune-baseline"]?.reasoningEffort).toBeUndefined();
  });

  test("both arms launch Rune and name their own rows", () => {
    expect(ARMS["rune-baseline"].name).toBe("rune-baseline");
    const plan = ARMS["rune-baseline"].plan(
      { id: "t", prompt: "p" } as never,
      "/tmp/evidence/t/run-1/rune-baseline",
      { model: "m", command: ["/opt/old/rune"], timeoutMs: 1000 } as never,
    );
    expect(plan.arm).toBe("rune-baseline");
    expect(plan.command[0]).toBe("/opt/old/rune");
    expect(plan.command).toContain("-P");
    expect(plan.command).toContain("--pristine");
  });

  test("the first arm alternates, as for any pair", () => {
    const options = parseCli(base)!;
    const jobs = planPairs(
      [...options.tasks, ...options.tasks.map((t) => ({ ...t, id: `${t.id}-2` }))],
      options.arms,
      1,
    );
    expect(jobs.map((job) => job.order[0])).toEqual(["rune", "rune-baseline"]);
  });
});

describe("the budget watches both Rune arms", () => {
  test("rune-baseline reports the meter, so a series of two Rune builds needs no --bounded", async () => {
    const { METERED_ARMS } = await import("../../../tests/eval/parity/series-budget");
    expect(METERED_ARMS.has("rune")).toBe(true);
    expect(METERED_ARMS.has("rune-baseline")).toBe(true);
  });
});
