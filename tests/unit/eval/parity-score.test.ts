/**
 * The Parity Index scorer, against numbers derived by hand.
 *
 * The golden family (tests/fixtures/parity/rows.ts) is built so that each rule
 * moves a different number: swapping the arms changes every axis, letting a
 * failed pair into E pushes E past 100, dropping the cap turns S into 110, and
 * counting an unscored pair moves O. The gate is tested at its edges, one
 * threshold at a time.
 */

import { describe, expect, test } from "bun:test";

import { pairRows } from "../../eval/parity/aggregate";
import {
  GATE,
  classifyPairs,
  computeAxes,
  efficiencyLog,
  gateFamily,
  headlineOf,
  overallStatus,
  parityIndex,
  scoreFamily,
  scoreMode,
  type AxisValues,
  type FamilyScore,
  type ScoredPair,
} from "../../eval/parity/score";
import type { ParityMode, ParityRunResult } from "../../eval/parity/types";
import {
  GOLDEN,
  GOLDEN_HARNESS_E,
  exclusionPairs,
  goldenPairs,
  pair,
  row,
} from "../../fixtures/parity/rows";

const pairsOf = (rows: ParityRunResult[], mode: ParityMode = "product") =>
  pairRows(rows, mode, "claude-code").pairs;

const included = (rows: ParityRunResult[], mode: ParityMode = "product") =>
  classifyPairs(pairsOf(rows, mode)).included;

const B = 400;

describe("the golden family, by hand", () => {
  const point = computeAxes(included(goldenPairs()), "product")!;

  test("O is Rune's mean quality as a share of the comparator's", () => {
    expect(point.axes.O).toBeCloseTo(GOLDEN.O, 9);
    expect(point.axes.O).toBeCloseTo(95.6521739, 6);
    expect(point.uncapped.O).toBeCloseTo(GOLDEN.uncapped.O, 9);
  });

  test("E is the geometric mean over pairs where BOTH arms succeeded", () => {
    expect(point.efficiencyPairs).toBe(4);
    expect(point.axes.E).toBeCloseTo(GOLDEN.E, 9);
    expect(point.axes.E).toBeCloseTo(91.7004043, 6);
    expect(point.uncapped.E).toBeCloseTo(GOLDEN.uncapped.E, 9);
    // b2: Rune kept no call count, so the calls factor was dropped for that pair.
    expect(point.droppedFactors).toEqual({ calls: 1, cost: 0 });
  });

  test("R is the clean-rate ratio", () => {
    expect(point.axes.R).toBeCloseTo(80, 9);
    expect(point.uncapped.R).toBeCloseTo(0.8, 9);
  });

  test("S is capped at 100; the uncapped advantage is 1.1", () => {
    expect(point.axes.S).toBe(100);
    expect(point.uncapped.S).toBeCloseTo(1.1, 9);
  });

  test("PI = .40·O + .25·E + .20·R + .15·S", () => {
    expect(point.PI).toBeCloseTo(GOLDEN.PI, 9);
    expect(point.PI).toBeCloseTo(92.18597, 5);
  });

  test("the arms are not interchangeable: Rune is r, the comparator is c", () => {
    const swapped = computeAxes(
      included(goldenPairs()).map((p) => ({ ...p, r: p.c, c: p.r })),
      "product",
    )!;
    // Scored from the comparator's side, every axis lands somewhere else.
    expect(swapped.axes.O).toBe(100);
    expect(swapped.axes.E).toBe(100);
    expect(swapped.axes.R).toBe(100);
    expect(swapped.axes.S).toBeCloseTo((100 * 5) / 5.5, 9);
    expect(point.axes.O).not.toBe(swapped.axes.O);
  });

  test("harness mode prices cost and renormalises when a factor is missing", () => {
    const h = computeAxes(
      included(goldenPairs({ mode: "harness" }, { listUsd: 1 }), "harness"),
      "harness",
    )!;
    expect(h.axes.E).toBeCloseTo(GOLDEN_HARNESS_E, 9);
    expect(h.droppedFactors).toEqual({ calls: 1, cost: 0 });
  });
});

describe("which pairs count", () => {
  const all = [...goldenPairs(), ...exclusionPairs()];
  const { included: inc, excluded } = classifyPairs(pairsOf(all));

  test("a pair with either row unscored is out, and counted", () => {
    expect(excluded.unscoredPairs).toBe(2);
    expect(inc.some((p) => p.task === "c" && (p.run === 3 || p.run === 4))).toBe(false);
  });

  test("a pair where either quality is null is out as 'no hidden checks'", () => {
    expect(excluded.noHiddenChecks).toBe(2);
    expect(inc.some((p) => p.task === "d")).toBe(false);
  });

  test("a both-zero pair is out and its task flagged too hard", () => {
    expect(excluded.tooHardPairs).toBe(1);
    expect(excluded.tooHardTasks).toEqual(["e"]);
  });

  test("the exclusions do not move the golden numbers", () => {
    expect(inc.length).toBe(6);
    const point = computeAxes(inc, "product")!;
    expect(point.axes.O).toBeCloseTo(GOLDEN.O, 9);
    expect(point.PI).toBeCloseTo(GOLDEN.PI, 9);
  });

  test("an unscored comparator row is not a failure of the comparator", () => {
    // c3: Rune 0.25 against an outage. Scored as a 0, it would lift Rune's O.
    const f = scoreFamily("F1", "product", pairsOf(all), { seed: 1, b: B });
    expect(f.n).toBe(6);
    expect(f.tasks).toEqual(["a", "b", "c"]);
    expect(f.excluded.unscoredPairs).toBe(2);
  });
});

describe("E is measured only where both arms succeeded", () => {
  test("a pair where one arm failed contributes nothing, however lopsided its times", () => {
    // Golden c1: Rune failed but was 8× faster. Counting it would push E past 100.
    const point = computeAxes(included(goldenPairs()), "product")!;
    expect(point.axes.E).toBeLessThan(100);
    expect(point.efficiencyPairs).toBe(4);
  });

  test("E is capped at 100 like the others; the advantage is not", () => {
    // Four pairs, Rune twice as fast, the same calls: geomean = 2^.5 = √2.
    const rows = [1, 2, 3, 4].flatMap((run) =>
      pair(`t${run}`, run, { wallMs: 100 }, { wallMs: 200 }),
    );
    const point = computeAxes(included(rows), "product")!;
    expect(point.axes.E).toBe(100);
    expect(point.uncapped.E).toBeCloseTo(Math.SQRT2, 12);
    expect(point.PI).toBe(100);
  });

  test("fewer than four both-succeeded pairs: E insufficient, PI redistributed", () => {
    const rows = [
      ...pair("a", 1, {}, {}),
      ...pair("a", 2, {}, {}),
      ...pair("b", 1, {}, {}),
      ...pair("b", 2, { passed: 3 }, {}),
      ...pair("c", 1, { passed: 2 }, {}),
      ...pair("c", 2, {}, { passed: 2 }),
    ];
    const point = computeAxes(included(rows), "product")!;
    expect(point.efficiencyPairs).toBe(3);
    expect(point.axes.E).toBeNull();
    expect(point.uncapped.E).toBeNull();
    expect(point.PI).toBeCloseTo(parityIndex({ ...point.axes, E: null }), 12);
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: 1, b: B });
    expect(f.efficiency.status).toBe("insufficient");
    expect(f.piRedistributed).toBe(true);
    expect(f.interval!.E).toBeNull();
    expect(f.status).not.toBe("PASS");
  });

  test("the factors, one pair at a time", () => {
    const p = (r: Partial<ScoredPair["r"]>, c: Partial<ScoredPair["c"]>): ScoredPair => {
      const base = { q: 1, clean: true, scope: 1, wallMs: 100, calls: 10, listUsd: 1 };
      return { task: "t", run: 1, family: "F1", r: { ...base, ...r }, c: { ...base, ...c } };
    };
    const ln2 = Math.log(2);
    // wall 2, calls 4: product .5·ln2 + .5·2ln2 = 1.5 ln2; cost has exponent 0.
    expect(efficiencyLog(p({}, { wallMs: 200, calls: 40 }), "product")!.log).toBeCloseTo(
      1.5 * ln2,
      12,
    );
    // harness, cost 8 too: .4 ln2 + .3·2ln2 + .3·3ln2 = 1.9 ln2.
    expect(
      efficiencyLog(p({}, { wallMs: 200, calls: 40, listUsd: 8 }), "harness")!.log,
    ).toBeCloseTo(1.9 * ln2, 12);
    // harness, cost missing on one side: .4/.7·ln2 + .3/.7·2ln2 = (10/7) ln2.
    const noCost = efficiencyLog(p({ listUsd: null }, { wallMs: 200, calls: 40 }), "harness")!;
    expect(noCost.log).toBeCloseTo((10 / 7) * ln2, 12);
    expect(noCost.dropped).toEqual({ calls: false, cost: true });
    // A zero cost (a free model) is dropped like a missing one, not divided by.
    expect(efficiencyLog(p({ listUsd: 0 }, { wallMs: 200 }), "harness")!.dropped.cost).toBe(true);
  });
});

describe("the axes' comparator-at-zero rules", () => {
  test("O = 100 when the comparator's mean quality is 0 and Rune's is not", () => {
    const rows = [...pair("a", 1, { passed: 1 }, { passed: 0 })];
    const point = computeAxes(included(rows), "product")!;
    expect(point.axes.O).toBe(100);
    expect(point.uncapped.O).toBeNull();
  });

  test("R = 100 · Rune's clean rate when the comparator never ran clean", () => {
    const rows = [
      ...pair("a", 1, { clean: true }, { clean: false }),
      ...pair("a", 2, { clean: false }, { clean: false }),
    ];
    const point = computeAxes(included(rows), "product")!;
    expect(point.axes.R).toBeCloseTo(50, 12);
    expect(point.uncapped.R).toBeNull();
  });

  test("S = 100 · Rune's mean scope when the comparator's is 0", () => {
    const rows = [
      ...pair("a", 1, { scope: 0.5 }, { scope: 0 }),
      ...pair("a", 2, { scope: 1 }, { scope: 0 }),
    ];
    expect(computeAxes(included(rows), "product")!.axes.S).toBeCloseTo(75, 12);
  });
});

describe("PI with E's weight redistributed", () => {
  test("(.40·O + .20·R + .15·S) / .75", () => {
    expect(parityIndex({ O: 90, E: null, R: 60, S: 100 })).toBeCloseTo(84, 12);
    expect(parityIndex({ O: 90, E: 80, R: 60, S: 100 })).toBeCloseTo(36 + 20 + 12 + 15, 12);
  });
});

describe("the gate, one threshold at a time", () => {
  const all100: AxisValues = { O: 100, E: 100, R: 100, S: 100 };
  const input = (axes: AxisValues, over: Partial<Parameters<typeof gateFamily>[0]> = {}) => ({
    axes,
    PI: parityIndex(axes),
    piLower: 95,
    n: GATE.minPairs,
    tasks: GATE.minTasks,
    efficiencyPairs: 6,
    ...over,
  });

  test("every threshold met, exactly at its edge: PASS", () => {
    const axes = { O: 95, E: 100, R: 100, S: 100 };
    expect(gateFamily(input(axes, { piLower: 85 }))).toEqual({ status: "PASS", reasons: [] });
  });

  test("O below 95 fails even when PI is 97.96", () => {
    const axes = { ...all100, O: 94.9 };
    const g = gateFamily(input(axes));
    expect(parityIndex(axes)).toBeGreaterThan(90);
    expect(g.status).toBe("FAIL");
    expect(g.reasons).toContain("O 94.9 < 95");
  });

  test("PI below 90 fails", () => {
    const g = gateFamily(input({ O: 100, E: 70, R: 70, S: 70 }));
    expect(g.status).toBe("FAIL");
    expect(g.reasons).toContain("PI 82.0 < 90");
  });

  test("E, R or S below 70 fails", () => {
    for (const k of ["E", "R", "S"] as const) {
      const g = gateFamily(input({ ...all100, [k]: 69 }));
      expect(g.status).toBe("FAIL");
      expect(g.reasons).toContain(`${k} 69.0 < 70`);
    }
  });

  test("short evidence is PROVISIONAL, not PASS and not FAIL", () => {
    expect(gateFamily(input(all100, { n: 5 })).status).toBe("PROVISIONAL");
    expect(gateFamily(input(all100, { tasks: 2 })).status).toBe("PROVISIONAL");
    expect(gateFamily(input(all100, { piLower: 84.9 })).status).toBe("PROVISIONAL");
    const noE = { ...all100, E: null };
    const g = gateFamily(input(noE, { efficiencyPairs: 3 }));
    expect(g.status).toBe("PROVISIONAL");
    expect(g.reasons[0]).toMatch(/^E insufficient: 3 pair/);
  });

  test("E insufficient does not rescue a failed guard-rail", () => {
    expect(gateFamily(input({ ...all100, E: null, O: 90 })).status).toBe("FAIL");
  });

  // Dropping the bad half of a pair would raise the number; the founder's rule
  // (2026-09-28) is that a family with any partnerless row cannot PASS.
  test("an unpaired row caps an otherwise passing family at PROVISIONAL", () => {
    const g = gateFamily(input(all100, { unpaired: 1 }));
    expect(g.status).toBe("PROVISIONAL");
    expect(g.reasons[0]).toMatch(/^1 unpaired row/);
    expect(gateFamily(input(all100, { unpaired: 0 })).status).toBe("PASS");
  });
});

describe("partnerless rows are counted per family, on both sides", () => {
  test("a Rune row and a comparator row without partners land in their own families", () => {
    const rows = [
      ...pair("a", 1, {}, {}, { family: "F2" }),
      row({ task: "b", run: 1, arm: "rune", family: "F2" }),
      row({ task: "c", run: 1, arm: "claude-code", family: "F7" }),
    ];
    const p = pairRows(rows, "product", "claude-code");
    expect(p.pairs).toHaveLength(1);
    expect(p.unpairedByFamily).toEqual({ F2: 1, F7: 1 });
  });

  test("scoreMode carries the count to the family's gate", () => {
    const rows = [...goldenPairs(), row({ task: "z", run: 1, arm: "rune" })];
    const p = pairRows(rows, "product", "claude-code");
    const f1 = scoreMode("product", p.pairs, {
      seed: 7,
      b: B,
      unpaired: p.unpairedByFamily,
    }).families.find((f) => f.family === "F1")!;
    expect(f1.status).not.toBe("PASS");
    expect(f1.reasons.some((r) => r.startsWith("1 unpaired row"))).toBe(true);
  });
});

describe("the headline and the overall status", () => {
  const fam = (family: FamilyScore["family"], status: FamilyScore["status"], PI: number | null) =>
    ({ family, name: family, status, reasons: [], PI }) as unknown as FamilyScore;
  const seven = (statuses: FamilyScore["status"][]) =>
    statuses.map((s, i) => fam(`F${i + 1}` as FamilyScore["family"], s, 90 + i));

  test("PASS only when all seven families pass", () => {
    expect(overallStatus(seven(Array(7).fill("PASS"))).status).toBe("PASS");
    expect(overallStatus(seven(Array(6).fill("PASS"))).status).toBe("PROVISIONAL");
  });

  test("any FAIL fails; else any PROVISIONAL or unmeasured family is PROVISIONAL", () => {
    const s = (list: FamilyScore["status"][]) => overallStatus(seven(list)).status;
    expect(s(["PASS", "PASS", "PROVISIONAL", "UNMEASURED", "FAIL", "PASS", "PASS"])).toBe("FAIL");
    expect(s(["PASS", "PASS", "PASS", "UNMEASURED", "PASS", "PASS", "PASS"])).toBe("PROVISIONAL");
    expect(s(["PASS", "PASS", "PASS", "PROVISIONAL", "PASS", "PASS", "PASS"])).toBe("PROVISIONAL");
  });

  test("the headline is the minimum PI, naming its family; unmeasured families are skipped", () => {
    const list = [fam("F1", "PASS", 97), fam("F2", "FAIL", 71.5), fam("F3", "UNMEASURED", null)];
    expect(headlineOf(list)).toEqual({ family: "F2", name: "F2", PI: 71.5 });
    expect(headlineOf([fam("F3", "UNMEASURED", null)])).toBeNull();
  });

  test("scoreMode lists all seven families, the unmeasured ones included", () => {
    const m = scoreMode("product", pairsOf(goldenPairs()), { seed: 1, b: B });
    expect(m.families.map((f) => f.family)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
    expect(m.families.slice(1).every((f) => f.status === "UNMEASURED")).toBe(true);
    expect(m.status).not.toBe("PASS");
    expect(m.headline?.family).toBe("F1");
    expect(m.headline?.PI).toBeCloseTo(GOLDEN.PI, 9);
  });
});
