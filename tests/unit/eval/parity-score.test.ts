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
  PROPOSED_COMPLETE_RATE_FLOOR,
  absoluteCaveats,
  absoluteStats,
  classifyPairs,
  computeAxes,
  efficiencyLog,
  gateFamily,
  headlineOf,
  overallStatus,
  parityIndex,
  scoreFamily,
  scoreMode,
  type AbsoluteStats,
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

  // Evidence reported under an override that let incomparable rows in.
  test("a cap keeps a passing family at PROVISIONAL, and rescues nothing", () => {
    const capped = gateFamily(
      input(all100, { caps: ["rows without fingerprints", "mixed rosters"] }),
    );
    expect(capped).toEqual({
      status: "PROVISIONAL",
      reasons: ["rows without fingerprints", "mixed rosters"],
    });
    expect(gateFamily(input(all100, { caps: [] })).status).toBe("PASS");
    const failing = gateFamily(input({ ...all100, O: 90 }, { caps: ["mixed rosters"] }));
    expect(failing.status).toBe("FAIL");
    expect(failing.reasons).toEqual(["O 90.0 < 95", "mixed rosters"]);
  });

  test("scoreMode hands a mode's caps to every family it measured", () => {
    const perfect = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, {}, {})),
    );
    const open = scoreMode("product", pairsOf(perfect), { seed: 1, b: B });
    expect(open.families[0]).toMatchObject({ status: "PASS", reasons: [] });
    const capped = scoreMode("product", pairsOf(perfect), { seed: 1, b: B, caps: ["why not"] });
    expect(capped.families[0]).toMatchObject({ status: "PROVISIONAL", reasons: ["why not"] });
    expect(capped.families[0]!.PI).toBe(open.families[0]!.PI);
    // A family nothing was measured in has nothing to cap.
    expect(capped.families[1]).toMatchObject({
      status: "UNMEASURED",
      reasons: ["no scored pairs"],
    });
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

describe("absolute outcomes: every attempt, counted", () => {
  const rune = (run: number, spec: Parameters<typeof row>[1] = {}) =>
    row({ task: "t", run, arm: "rune" }, spec);

  test("each attempt lands in exactly one outcome class, and the classes add up", () => {
    const stats = absoluteStats([
      rune(1), // complete
      rune(2, { passed: 2 }), // partial
      rune(3, { passed: 0 }), // zero
      rune(4, { regressions: 1 }), // every check passes, one regression: q = .5
      rune(5, { buildBroken: true }), // a broken build is q = 0, whatever passed
      rune(6, { passed: 0, total: 0 }), // nothing could check it
      rune(7, { scored: false, unscoredReason: "provider_quota" }),
      rune(8, { scored: false, unscoredReason: "provider_quota" }),
      rune(9, { scored: false, unscoredReason: "grader_infrastructure" }),
    ]);
    expect(stats).toMatchObject({
      attempts: 9,
      scored: 6,
      unscored: { provider_quota: 2, grader_infrastructure: 1 },
      gradable: 5,
      unverified: 1,
      complete: 1,
      partial: 2,
      zero: 2,
      regressions: 1,
      buildBroken: 1,
    });
    expect(stats.complete + stats.partial + stats.zero).toBe(stats.gradable);
    expect(stats.gradable + stats.unverified).toBe(stats.scored);
    expect(stats.completeRate).toBeCloseTo(1 / 5, 12);
  });

  test("a run nothing could check is never complete, whatever it claimed", () => {
    const stats = absoluteStats([
      rune(1, { passed: 0, total: 0 }),
      rune(2, { passed: 0, total: 0 }),
    ]);
    expect(stats).toMatchObject({ scored: 2, gradable: 0, unverified: 2, complete: 0 });
    expect(stats.completeRate).toBeNull();
    expect(absoluteStats([]).completeRate).toBeNull();
  });

  test("a clean completion is complete, ended clean, and nothing out of scope", () => {
    const stats = absoluteStats([
      rune(1),
      rune(2, { scope: 0.5 }), // leftovers are not a breach
      rune(3, { scope: 0 }), // complete, out of scope
      rune(4, { clean: false }), // complete, but the run did not end clean
      rune(5, { passed: 3 }), // clean and in scope, and not complete
      rune(6, { passed: 3, clean: false, falseCompletion: true }),
    ]);
    expect(stats).toMatchObject({
      complete: 4,
      cleanComplete: 2,
      scopeViolations: 1,
      leftovers: 1,
      falseCompletions: 1,
    });
  });

  test("unscored attempts keep their time, and cost is summed only where it is known", () => {
    const stats = absoluteStats([
      rune(1, { wallMs: 1000, listUsd: 0.5 }),
      rune(2, { wallMs: 2000, listUsd: 0.25 }),
      rune(3, { wallMs: 4000, scored: false, unscoredReason: "provider_outage" }),
    ]);
    expect(stats).toMatchObject({
      wallMs: 7000,
      unscoredWallMs: 4000,
      listUsd: 0.75,
      costUnknown: 1,
    });
  });

  test("how runs ended is counted as recorded; a parity-run/1 row never said", () => {
    const stats = absoluteStats([
      rune(1),
      rune(2, { passed: 1, terminal: "incomplete" }),
      rune(3, { passed: 1, terminal: "crashed" }),
      rune(4, { passed: 1, terminal: "stopped" }),
      rune(5, { scored: false, terminal: "not_started", unscoredReason: "grader_infrastructure" }),
      row({ task: "t", run: 6, arm: "rune", v1: true }),
    ]);
    expect(stats.terminal).toEqual({
      completed: 1,
      incomplete: 1,
      crashed: 1,
      stopped: 1,
      not_started: 1,
      unrecorded: 1,
    });
  });

  test("the scorer counts each arm's own rows, the partnerless and the excluded included", () => {
    const rows = [
      ...goldenPairs(),
      ...exclusionPairs(),
      row({ task: "z", run: 1, arm: "rune" }, { passed: 0 }),
    ];
    const p = pairRows(rows, "product", "claude-code");
    const f = scoreFamily("F1", "product", p.pairs, { seed: 1, b: B, rows: p.rows });
    expect(f.absolute.rune.attempts).toBe(12);
    expect(f.absolute.comparator.attempts).toBe(11);
    // Given only the pairs, the partnerless row is not there to count.
    const fromPairs = scoreFamily("F1", "product", p.pairs, { seed: 1, b: B });
    expect(fromPairs.absolute.rune.attempts).toBe(11);
    expect(fromPairs.PI).toBe(f.PI);
    // A row of another family or mode is not this family's attempt.
    const other = scoreFamily("F2", "product", p.pairs, { seed: 1, b: B, rows: p.rows });
    expect(other.absolute.rune.attempts).toBe(0);
    const mode = scoreMode("product", p.pairs, { seed: 1, b: B, rows: p.rows });
    expect(mode.absolute.rune.attempts).toBe(12);
    expect(mode.absolute.comparator.attempts).toBe(11);
    // Handed both modes' pairs, a mode counts its own attempts only.
    const harness = pairsOf(goldenPairs({ mode: "harness" }, { listUsd: 1 }), "harness");
    const mixed = scoreMode("product", [...p.pairs, ...harness], { seed: 1, b: B });
    expect(mixed.absolute.rune.attempts).toBe(11);
    expect(mixed.families[0]!.absolute.rune.attempts).toBe(11);
    // …and the same when it is handed both modes' ROWS.
    const everyRow = {
      rune: [...p.rows.rune, ...harness.map((x) => x.rune)],
      comparator: [...p.rows.comparator, ...harness.map((x) => x.comparator)],
    };
    const counted = scoreFamily("F1", "product", p.pairs, { seed: 1, b: B, rows: everyRow });
    expect(counted.absolute.rune.attempts).toBe(12);
    expect(counted.absolute.comparator.attempts).toBe(11);
  });
});

describe("what the ratio hides: caveats, which never gate", () => {
  const stats = (over: Partial<AbsoluteStats>): AbsoluteStats => ({
    ...absoluteStats([]),
    ...over,
  });
  const arm = (complete: number, gradable: number, over: Partial<AbsoluteStats> = {}) =>
    stats({
      attempts: gradable,
      scored: gradable,
      gradable,
      complete,
      cleanComplete: complete,
      completeRate: gradable ? complete / gradable : null,
      ...over,
    });
  const axes: AxisValues = { O: 100, E: 100, R: 100, S: 100 };

  test("the floor is the review's proposal, and is met at exactly 80%", () => {
    expect(PROPOSED_COMPLETE_RATE_FLOOR).toBe(0.8);
    expect(absoluteCaveats(axes, arm(8, 10), arm(8, 10), "claude-code")).toEqual([]);
    expect(absoluteCaveats(axes, arm(10, 10), arm(1, 10), "claude-code")).toEqual([]);
    expect(absoluteCaveats(axes, arm(0, 0), arm(0, 0), "claude-code")).toEqual([]);
  });

  test("a good ratio over poor outcomes is named for what it is", () => {
    expect(absoluteCaveats(axes, arm(7, 10), arm(7, 10), "claude-code")).toEqual([
      "relative O is 100.0, but Rune completed 7 of 10 gradable attempt(s) (70%) and claude-code 7 of 10 gradable attempt(s) (70%), both under the proposed 80% floor: the ratio is parity at a low level",
    ]);
    // The comparator did well: Rune's own number is the caveat.
    expect(absoluteCaveats({ ...axes, O: 95 }, arm(7, 10), arm(9, 10), "opencode")).toEqual([
      "relative O is 95.0, but Rune completed 7 of 10 gradable attempt(s) (70%), under the proposed 80% floor",
    ]);
    // A ratio that already fails its own floor needs no warning about looking good.
    expect(absoluteCaveats({ ...axes, O: 94.9 }, arm(7, 10), arm(9, 10), "opencode")).toEqual([
      "Rune completed 7 of 10 gradable attempt(s) (70%), under the proposed 80% floor",
    ]);
    expect(absoluteCaveats(null, arm(1, 3), arm(0, 0), "opencode")).toEqual([
      "Rune completed 1 of 3 gradable attempt(s) (33%), under the proposed 80% floor",
    ]);
  });

  test("integrity counts are caveats of their own", () => {
    expect(
      absoluteCaveats(
        axes,
        arm(10, 10, {
          cleanComplete: 8,
          scopeViolations: 2,
          falseCompletions: 1,
          terminal: { completed: 9, crashed: 1 },
        }),
        arm(10, 10),
        "claude-code",
      ),
    ).toEqual([
      "2 Rune attempt(s) changed something out of scope",
      "2 of Rune's 10 complete attempt(s) ended unclean or out of scope",
      "1 Rune attempt(s) claimed success on unfinished work",
      "1 Rune attempt(s) crashed",
    ]);
  });

  test("a caveat changes no status: the gate reads the same inputs with or without one", () => {
    const half = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) => pair(task, run, { passed: 2 }, { passed: 2 })),
    );
    const f = scoreFamily("F1", "product", pairsOf(half), { seed: 1, b: B });
    expect(f.caveats.length).toBe(1);
    const gated = gateFamily({
      axes: f.axes!,
      PI: f.PI!,
      piLower: f.interval!.PI!.lo,
      n: f.n,
      tasks: f.tasks.length,
      efficiencyPairs: f.efficiency.pairs,
    });
    expect({ status: f.status, reasons: f.reasons }).toEqual(gated);
  });
});

describe("the old rules, beside the new", () => {
  test("R and S read the row's own flags, or what parity-run/1 said of the same run", () => {
    const rows = [
      // Rune crashed: not clean now, clean under v1. Out of scope now, in scope under v1.
      ...pair(
        "a",
        1,
        { clean: false, terminal: "crashed", legacyClean: true, scope: 0, legacyScope: 1 },
        {},
      ),
      ...pair("a", 2, {}, {}),
    ];
    const inc = included(rows);
    const now = computeAxes(inc, "product")!;
    const old = computeAxes(inc, "product", "v1")!;
    expect(now.axes).toMatchObject({ O: 100, R: 50, S: 50 });
    expect(old.axes).toMatchObject({ O: 100, R: 100, S: 100 });
    expect(computeAxes(inc, "product", "current")).toEqual(now);
    // O and E never depend on the rule set.
    expect(old.axes.O).toBe(now.axes.O);
    expect(old.efficiencyPairs).toBe(now.efficiencyPairs);
  });

  test("a parity-run/1 pair has one set of flags, and both rule sets read it", () => {
    const rows = pair("a", 1, { clean: false, scope: 0.5 }, {}, { v1: true });
    const inc = included(rows);
    expect(inc[0]!.r.legacyClean).toBeUndefined();
    expect(computeAxes(inc, "product", "v1")).toEqual(computeAxes(inc, "product")!);
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: 1, b: B });
    expect(f.legacy).toEqual({ PI: f.PI, R: f.axes!.R, S: f.axes!.S, differs: false });
  });

  test("the family carries the old index, and says when it differs", () => {
    const rows = ["a", "b", "c"].flatMap((task) =>
      [1, 2].flatMap((run) =>
        pair(
          task,
          run,
          run === 1 ? { clean: false, terminal: "crashed", legacyClean: true } : {},
          {},
        ),
      ),
    );
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: 1, b: B });
    expect(f.axes!.R).toBe(50);
    expect(f.legacy).toMatchObject({ R: 100, S: 100, differs: true });
    expect(f.legacy.PI).toBe(100);
    // The status reads the current index, not the old one.
    expect(f.status).toBe("FAIL");
    expect(f.reasons).toContain("R 50.0 < 70");
    // An unmeasured family has no old index either.
    expect(scoreFamily("F2", "product", pairsOf(rows), { seed: 1, b: B }).legacy).toEqual({
      PI: null,
      R: null,
      S: null,
      differs: false,
    });
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
