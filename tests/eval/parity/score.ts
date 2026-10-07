// ─── The Parity Index scorer ───
//
// Pairs in, a number and a status per family out. A pair is two arms' rows for
// the same (task, run, mode): Rune and the comparator (Claude Code for the
// headline, OpenCode by option). Four axes per family, each Rune's result as a
// share of the comparator's, capped at 100 so that beating the comparator on
// one axis cannot pay for losing on another:
//
//   O  outcome     mean quality, from types.ts `quality()`
//   E  efficiency  geometric mean of wall / calls / cost ratios, over pairs
//                  where BOTH arms fully succeeded
//   R  reliability clean-run rate
//   S  scope       mean scope score
//
//   PI = 0.40·O + 0.25·E + 0.20·R + 0.15·S
//
// The uncapped ratios are reported beside them as "advantages". The gate and
// every rule here are specified in docs/program/parity-index.md; a change to a
// rule is a change to what the release gate means, and goes in its Changes
// section.
//
// Every axis is a RATIO, so it cannot say how good either tool was: two arms
// that each got half of every task score O = 100. `absoluteStats` is the other
// half of the answer — what each arm did across ALL its attempts, counted and
// not divided by the other arm — and it is reported beside the index, never
// folded into it.
//
// Pure: no clock, no disk, no Math.random. The bootstrap is seeded.

import { BOOTSTRAP_B, bootstrapClustered, bootstrapStratified, type Interval } from "./bootstrap";
import {
  FAMILY_NAMES,
  quality,
  type Family,
  type ParityMode,
  type ParityRunResult,
  type Terminal,
  type UnscoredReason,
} from "./types";

export type Comparator = "claude-code" | "opencode";
export const COMPARATORS: readonly Comparator[] = ["claude-code", "opencode"];

export const FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"];
export const MODES: readonly ParityMode[] = ["product", "harness"];

/** The axis weights in PI. They sum to 1. */
export const WEIGHTS = { O: 0.4, E: 0.25, R: 0.2, S: 0.15 } as const;

/**
 * The efficiency exponents per mode: wall time, model calls, list cost.
 * Product mode ignores cost (each tool runs on its own account and plan);
 * harness mode, on one model via one API key, prices it.
 */
export const EFFICIENCY_EXPONENTS: Readonly<
  Record<ParityMode, { wall: number; calls: number; cost: number }>
> = {
  product: { wall: 0.5, calls: 0.5, cost: 0 },
  harness: { wall: 0.4, calls: 0.3, cost: 0.3 },
};

/** The gate's thresholds. */
export const GATE = {
  /** PI_f at the point estimate. */
  pi: 90,
  /** O is held to its own, higher floor: quality is not traded for speed. */
  outcome: 95,
  /** E, R and S each. */
  axisFloor: 70,
  /** The bootstrap's lower bound (10th percentile) of PI_f. */
  lowerBound: 85,
  minPairs: 6,
  minTasks: 3,
  /** Pairs where both arms succeeded, below which E is "insufficient". */
  minEfficiencyPairs: 4,
} as const;

/** Threshold comparisons forgive float noise this small, and nothing larger. */
const EPSILON = 1e-9;
const atLeast = (value: number, threshold: number) => value >= threshold - EPSILON;

// ── Pairs ──

/** Two arms' rows for one (task, run, mode), as the aggregator found them. */
export interface RawPair {
  task: string;
  family: Family;
  run: number;
  mode: ParityMode;
  rune: ParityRunResult;
  comparator: ParityRunResult;
}

/** One arm's side of a scored pair: only what the axes read. */
export interface Side {
  q: number;
  clean: boolean;
  scope: number;
  /**
   * The same run under the `parity-run/1` rules, where the row recorded them
   * (`legacy`). Absent on a `parity-run/1` row, whose `clean` and `scope` ARE
   * those rules' values.
   */
  legacyClean?: boolean;
  legacyScope?: number;
  wallMs: number;
  calls: number | null;
  listUsd: number | null;
}

export interface ScoredPair {
  task: string;
  run: number;
  family: Family;
  /** Rune. */
  r: Side;
  /** The comparator. */
  c: Side;
}

export interface Exclusions {
  /** Pairs where either row is unscored (an outage, quota, auth, …). */
  unscoredPairs: number;
  /** Pairs where either row has no runnable hidden check (q is null). */
  noHiddenChecks: number;
  /** Pairs where both arms scored q = 0. */
  tooHardPairs: number;
  /** Tasks with at least one both-zero pair, flagged "too hard". */
  tooHardTasks: string[];
}

const side = (row: ParityRunResult, q: number): Side => ({
  q,
  clean: row.clean,
  scope: row.scope,
  ...(row.legacy ? { legacyClean: row.legacy.clean, legacyScope: row.legacy.scope } : {}),
  wallMs: row.wallMs,
  calls: row.calls,
  listUsd: row.listUsd,
});

/**
 * Which pairs count. In order: a pair with either row unscored is out (and
 * counted); a pair where either quality is null is out (no hidden checks); a
 * pair where both qualities are 0 is out and its task flagged "too hard".
 */
export function classifyPairs(pairs: readonly RawPair[]): {
  included: ScoredPair[];
  excluded: Exclusions;
} {
  const included: ScoredPair[] = [];
  let unscoredPairs = 0;
  let noHiddenChecks = 0;
  let tooHardPairs = 0;
  const tooHard = new Set<string>();
  for (const p of pairs) {
    if (!p.rune.scored || !p.comparator.scored) {
      unscoredPairs++;
      continue;
    }
    const qR = quality(p.rune.outcome);
    const qC = quality(p.comparator.outcome);
    if (qR === null || qC === null) {
      noHiddenChecks++;
      continue;
    }
    if (qR === 0 && qC === 0) {
      tooHardPairs++;
      tooHard.add(p.task);
      continue;
    }
    included.push({
      task: p.task,
      run: p.run,
      family: p.family,
      r: side(p.rune, qR),
      c: side(p.comparator, qC),
    });
  }
  included.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : a.run - b.run));
  return {
    included,
    excluded: {
      unscoredPairs,
      noHiddenChecks,
      tooHardPairs,
      tooHardTasks: [...tooHard].sort(),
    },
  };
}

// ── Axes ──

export interface AxisValues {
  O: number;
  /** Null when fewer than GATE.minEfficiencyPairs pairs had both arms succeed. */
  E: number | null;
  R: number;
  S: number;
}

/**
 * The same four ratios without the cap: 1 is parity, above 1 is Rune ahead.
 * Null where the comparator's figure is 0 (the ratio is unbounded) or, for E,
 * where E is insufficient.
 */
export interface Advantages {
  O: number | null;
  E: number | null;
  R: number | null;
  S: number | null;
}

export interface PointScore {
  axes: AxisValues;
  uncapped: Advantages;
  PI: number;
  /** Pairs where both arms succeeded (q = 1): E's denominator. */
  efficiencyPairs: number;
  /**
   * Factors dropped from E because a side had no figure (null) or a zero one,
   * counted per pair, for factors whose exponent in this mode is not zero.
   */
  droppedFactors: { calls: number; cost: number };
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 100·min(1, r/c), with the comparator-at-zero rule the axis names. */
const capped = (r: number, c: number, whenComparatorZero: number) =>
  c > 0 ? 100 * Math.min(1, r / c) : whenComparatorZero;

const usable = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;

/**
 * One both-succeeded pair's efficiency, as a log: Σ wᵢ·ln(comparator / Rune)
 * over the factors both sides have, the weights renormalised to sum to 1.
 * Null when no factor survives (a pair with no usable wall time).
 */
export function efficiencyLog(
  pair: ScoredPair,
  mode: ParityMode,
): { log: number; dropped: { calls: boolean; cost: boolean } } | null {
  const x = EFFICIENCY_EXPONENTS[mode];
  const factors: { ratio: number; w: number }[] = [];
  const dropped = { calls: false, cost: false };
  if (usable(pair.r.wallMs) && usable(pair.c.wallMs) && x.wall > 0) {
    factors.push({ ratio: pair.c.wallMs / pair.r.wallMs, w: x.wall });
  }
  if (x.calls > 0) {
    if (usable(pair.r.calls) && usable(pair.c.calls)) {
      factors.push({ ratio: pair.c.calls / pair.r.calls, w: x.calls });
    } else dropped.calls = true;
  }
  if (x.cost > 0) {
    if (usable(pair.r.listUsd) && usable(pair.c.listUsd)) {
      factors.push({ ratio: pair.c.listUsd / pair.r.listUsd, w: x.cost });
    } else dropped.cost = true;
  }
  const total = factors.reduce((s, f) => s + f.w, 0);
  if (total <= 0) return null;
  const log = factors.reduce((s, f) => s + (f.w / total) * Math.log(f.ratio), 0);
  return { log, dropped };
}

/** PI from the four axes; with E null, E's weight is spread over the rest. */
export function parityIndex(axes: AxisValues): number {
  if (axes.E === null) {
    const w = WEIGHTS.O + WEIGHTS.R + WEIGHTS.S;
    return (WEIGHTS.O * axes.O + WEIGHTS.R * axes.R + WEIGHTS.S * axes.S) / w;
  }
  return WEIGHTS.O * axes.O + WEIGHTS.E * axes.E + WEIGHTS.R * axes.R + WEIGHTS.S * axes.S;
}

/**
 * Which rules `clean` and `scope` are read under. `current` is the row's own
 * fields. `v1` is what `parity-run/1` said of the same run: no coding-task
 * scope, and a crash that ended fast was clean. O and E do not depend on it.
 */
export type RuleSet = "current" | "v1";

const cleanUnder = (s: Side, rules: RuleSet) =>
  rules === "v1" ? (s.legacyClean ?? s.clean) : s.clean;
const scopeUnder = (s: Side, rules: RuleSet) =>
  rules === "v1" ? (s.legacyScope ?? s.scope) : s.scope;

/** The point estimate over a set of included pairs. Null for an empty set. */
export function computeAxes(
  pairs: readonly ScoredPair[],
  mode: ParityMode,
  rules: RuleSet = "current",
): PointScore | null {
  if (pairs.length === 0) return null;

  const qR = mean(pairs.map((p) => p.r.q));
  const qC = mean(pairs.map((p) => p.c.q));
  const O = capped(qR, qC, qR > 0 ? 100 : 0);

  const cleanR = mean(pairs.map((p) => (cleanUnder(p.r, rules) ? 1 : 0)));
  const cleanC = mean(pairs.map((p) => (cleanUnder(p.c, rules) ? 1 : 0)));
  const R = capped(cleanR, cleanC, 100 * cleanR);

  const sR = mean(pairs.map((p) => scopeUnder(p.r, rules)));
  const sC = mean(pairs.map((p) => scopeUnder(p.c, rules)));
  const S = capped(sR, sC, 100 * sR);

  const logs: number[] = [];
  const droppedFactors = { calls: 0, cost: 0 };
  for (const p of pairs) {
    if (p.r.q !== 1 || p.c.q !== 1) continue;
    const e = efficiencyLog(p, mode);
    if (!e) continue;
    logs.push(e.log);
    if (e.dropped.calls) droppedFactors.calls++;
    if (e.dropped.cost) droppedFactors.cost++;
  }
  const geomean = logs.length >= GATE.minEfficiencyPairs ? Math.exp(mean(logs)) : null;
  const E = geomean === null ? null : 100 * Math.min(1, geomean);

  const axes: AxisValues = { O, E, R, S };
  return {
    axes,
    uncapped: {
      O: qC > 0 ? qR / qC : null,
      E: geomean,
      R: cleanC > 0 ? cleanR / cleanC : null,
      S: sC > 0 ? sR / sC : null,
    },
    PI: parityIndex(axes),
    efficiencyPairs: logs.length,
    droppedFactors,
  };
}

// ── Absolute outcomes ──

/**
 * What one arm did across ALL its attempts in a family — scored or not, paired
 * or not, in a both-zero pair or not. Counts, never ratios against the other
 * arm, so "equally poor" cannot read as "at parity".
 *
 * `complete` is the only count that is a finished task: every runnable hidden
 * check passed, nothing regressed, the build is whole (q = 1). `partial` is
 * diagnostic. `unverified` is a run nothing could check, and it is never
 * counted as complete, whatever the tool said about it.
 */
export interface AbsoluteStats {
  attempts: number;
  scored: number;
  /** Unscored attempts by reason: they say nothing about the tool, and cost time and quota. */
  unscored: Partial<Record<UnscoredReason, number>>;
  /** Scored, with at least one runnable hidden check: what the rates divide by. */
  gradable: number;
  /** Scored, with no runnable hidden check. */
  unverified: number;
  complete: number;
  partial: number;
  zero: number;
  /** complete / gradable. Null when nothing was gradable. */
  completeRate: number | null;
  /** Complete, AND the run ended clean, AND nothing was out of scope. */
  cleanComplete: number;
  /** Gradable attempts that broke a check passing at base. */
  regressions: number;
  buildBroken: number;
  /** Scored attempts with scope 0. */
  scopeViolations: number;
  /** Scored attempts that left leftovers only (scope 0.5). */
  leftovers: number;
  falseCompletions: number;
  /** How the runs ended. `unrecorded` is a `parity-run/1` row, which never said. */
  terminal: Partial<Record<Terminal | "unrecorded", number>>;
  /** Wall time over every attempt, and the part of it unscored attempts used. */
  wallMs: number;
  unscoredWallMs: number;
  /** List cost over the attempts that have one, and how many have none. */
  listUsd: number;
  costUnknown: number;
}

const bump = <K extends string>(counts: Partial<Record<K, number>>, key: K): void =>
  void (counts[key] = (counts[key] ?? 0) + 1);

/** One arm's rows in one family and mode, counted. Pure. */
export function absoluteStats(rows: readonly ParityRunResult[]): AbsoluteStats {
  const stats: AbsoluteStats = {
    attempts: rows.length,
    scored: 0,
    unscored: {},
    gradable: 0,
    unverified: 0,
    complete: 0,
    partial: 0,
    zero: 0,
    completeRate: null,
    cleanComplete: 0,
    regressions: 0,
    buildBroken: 0,
    scopeViolations: 0,
    leftovers: 0,
    falseCompletions: 0,
    terminal: {},
    wallMs: 0,
    unscoredWallMs: 0,
    listUsd: 0,
    costUnknown: 0,
  };
  for (const row of rows) {
    bump(stats.terminal, row.terminal ?? "unrecorded");
    stats.wallMs += row.wallMs;
    if (row.listUsd === null) stats.costUnknown++;
    else stats.listUsd += row.listUsd;
    if (!row.scored) {
      if (row.unscoredReason) bump(stats.unscored, row.unscoredReason);
      stats.unscoredWallMs += row.wallMs;
      continue;
    }
    stats.scored++;
    if (row.scope === 0) stats.scopeViolations++;
    else if (row.scope === 0.5) stats.leftovers++;
    if (row.falseCompletion) stats.falseCompletions++;
    const q = quality(row.outcome);
    if (q === null) {
      stats.unverified++;
      continue;
    }
    stats.gradable++;
    if (row.outcome.regressionsIntroduced > 0) stats.regressions++;
    if (row.outcome.buildBroken) stats.buildBroken++;
    if (q === 1) {
      stats.complete++;
      if (row.clean && row.scope !== 0) stats.cleanComplete++;
    } else if (q === 0) stats.zero++;
    else stats.partial++;
  }
  stats.completeRate = stats.gradable > 0 ? stats.complete / stats.gradable : null;
  return stats;
}

/**
 * The review of 2026-09-30 proposed, for a BROAD claim, at least this share of
 * gradable attempts complete in every family. It is not part of the gate: no
 * status here reads it. It decides one thing only — whether a family whose
 * relative numbers look fine carries a caveat saying its absolute ones do not.
 * Making it a rule is the founder's decision, to freeze before a claim-bearing
 * series (docs/program/parity-index.md, Changes).
 */
export const PROPOSED_COMPLETE_RATE_FLOOR = 0.8;

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * What the relative numbers hide. One line per fact; empty when there is none.
 * A caveat never changes a status.
 */
export function absoluteCaveats(
  axes: AxisValues | null,
  rune: AbsoluteStats,
  comparator: AbsoluteStats,
  comparatorName: string,
): string[] {
  const out: string[] = [];
  const low = (s: AbsoluteStats) =>
    s.completeRate !== null && s.completeRate < PROPOSED_COMPLETE_RATE_FLOOR - EPSILON;
  const said = (s: AbsoluteStats) =>
    `${s.complete} of ${s.gradable} gradable attempt(s) (${pct(s.completeRate!)})`;
  const floor = `under the proposed ${pct(PROPOSED_COMPLETE_RATE_FLOOR)} floor`;
  if (axes && atLeast(axes.O, GATE.outcome) && low(rune))
    out.push(
      `relative O is ${f1(axes.O)}, but Rune completed ${said(rune)}` +
        (low(comparator)
          ? ` and ${comparatorName} ${said(comparator)}, both ${floor}: the ratio is parity at a low level`
          : `, ${floor}`),
    );
  else if (low(rune)) out.push(`Rune completed ${said(rune)}, ${floor}`);
  if (rune.scopeViolations > 0)
    out.push(`${rune.scopeViolations} Rune attempt(s) changed something out of scope`);
  if (rune.complete > rune.cleanComplete)
    out.push(
      `${rune.complete - rune.cleanComplete} of Rune's ${rune.complete} complete attempt(s) ended unclean or out of scope`,
    );
  if (rune.falseCompletions > 0)
    out.push(`${rune.falseCompletions} Rune attempt(s) claimed success on unfinished work`);
  const crashed = rune.terminal.crashed ?? 0;
  if (crashed > 0) out.push(`${crashed} Rune attempt(s) crashed`);
  return out;
}

// ── The gate ──

export type FamilyStatus = "PASS" | "PROVISIONAL" | "FAIL" | "UNMEASURED";
export type OverallStatus = "PASS" | "PROVISIONAL" | "FAIL";

export interface GateInput {
  axes: AxisValues;
  PI: number;
  /** The bootstrap's 10th percentile of PI_f. */
  piLower: number | null;
  n: number;
  tasks: number;
  efficiencyPairs: number;
  /** Rows in this family with no partner from the other arm. */
  unpaired?: number;
  /**
   * Why this evidence cannot carry a PASS however it scores: it was reported
   * under an override that let incomparable rows in. Each is a reason.
   */
  caps?: readonly string[];
}

const f1 = (x: number) => x.toFixed(1);

/**
 * PASS: PI ≥ 90, O ≥ 95, E, R, S ≥ 70, the lower bound ≥ 85, and at least
 * 6 scored pairs over 3 distinct tasks. PROVISIONAL: the point PI and the
 * guard-rails hold but the evidence is short (n, tasks, the lower bound, or
 * E insufficient). FAIL: anything else.
 */
export function gateFamily(g: GateInput): { status: FamilyStatus; reasons: string[] } {
  const hard: string[] = [];
  if (!atLeast(g.PI, GATE.pi)) hard.push(`PI ${f1(g.PI)} < ${GATE.pi}`);
  if (!atLeast(g.axes.O, GATE.outcome)) hard.push(`O ${f1(g.axes.O)} < ${GATE.outcome}`);
  if (g.axes.E !== null && !atLeast(g.axes.E, GATE.axisFloor))
    hard.push(`E ${f1(g.axes.E)} < ${GATE.axisFloor}`);
  if (!atLeast(g.axes.R, GATE.axisFloor)) hard.push(`R ${f1(g.axes.R)} < ${GATE.axisFloor}`);
  if (!atLeast(g.axes.S, GATE.axisFloor)) hard.push(`S ${f1(g.axes.S)} < ${GATE.axisFloor}`);

  const short: string[] = [];
  if (g.axes.E === null)
    short.push(
      `E insufficient: ${g.efficiencyPairs} pair(s) where both arms succeeded, need ${GATE.minEfficiencyPairs}`,
    );
  if (g.n < GATE.minPairs) short.push(`n ${g.n} < ${GATE.minPairs} scored pairs`);
  if (g.tasks < GATE.minTasks) short.push(`${g.tasks} task(s) < ${GATE.minTasks}`);
  if (g.piLower === null) short.push("no bootstrap lower bound");
  else if (!atLeast(g.piLower, GATE.lowerBound))
    short.push(`PI lower bound ${f1(g.piLower)} < ${GATE.lowerBound}`);
  // A run whose partner is missing is not scored, so dropping the bad half of
  // a pair would raise the number. The founder's rule (2026-09-28): a family
  // with any partnerless row can be PROVISIONAL at best, never PASS.
  if ((g.unpaired ?? 0) > 0)
    short.push(`${g.unpaired} unpaired row(s): re-run the missing arm before this family can pass`);
  short.push(...(g.caps ?? []));

  if (hard.length > 0) return { status: "FAIL", reasons: [...hard, ...short] };
  if (short.length > 0) return { status: "PROVISIONAL", reasons: short };
  return { status: "PASS", reasons: [] };
}

// ── Families and modes ──

export interface FamilyIntervals {
  PI: Interval | null;
  O: Interval | null;
  E: Interval | null;
  R: Interval | null;
  S: Interval | null;
}

export interface FamilyScore {
  family: Family;
  name: string;
  mode: ParityMode;
  status: FamilyStatus;
  reasons: string[];
  /** Scored pairs: those the axes were computed over. */
  n: number;
  /** Distinct tasks among the scored pairs. */
  tasks: string[];
  axes: AxisValues | null;
  uncapped: Advantages | null;
  PI: number | null;
  /** PI was computed with E's weight redistributed (E insufficient). */
  piRedistributed: boolean;
  /** 80%, runs resampled within each task: would THESE tasks give this again? The gate reads it. */
  interval: FamilyIntervals | null;
  /**
   * 95%, whole tasks resampled: how far might it move on other tasks like
   * these? Reported, never gated. Null with fewer than two tasks.
   */
  taskInterval: FamilyIntervals | null;
  efficiency: {
    pairs: number;
    status: "measured" | "insufficient" | "unmeasured";
    droppedFactors: { calls: number; cost: number };
  };
  excluded: Exclusions;
  /** What each arm did over ALL its attempts in this family, counted. */
  absolute: { rune: AbsoluteStats; comparator: AbsoluteStats };
  /** What the relative numbers hide. Reported; never changes `status`. */
  caveats: string[];
  /**
   * The index over the same pairs under the `parity-run/1` rules — the number
   * this family would have shown before coding-task scope and before a crash
   * stopped being clean. `differs` when any pair's R or S inputs changed.
   */
  legacy: { PI: number | null; R: number | null; S: number | null; differs: boolean };
}

export interface ScoreOptions {
  seed: number;
  /** Bootstrap replicates; BOOTSTRAP_B unless a test says otherwise. */
  b?: number;
  /** Partnerless rows per family (aggregate.ts `pairRows`). */
  unpaired?: Partial<Record<Family, number>>;
  /**
   * Every row each arm wrote in this mode, partnerless ones included: what the
   * absolute counts are taken over. Without it they are taken over the pairs'
   * own rows, which is all a caller holding only pairs can know.
   */
  rows?: { rune: readonly ParityRunResult[]; comparator: readonly ParityRunResult[] };
  /** The comparator's name, for the caveats' wording. */
  comparatorName?: string;
  /** Reasons no family in this mode can PASS (`GateInput.caps`). */
  caps?: readonly string[];
}

type IntervalName = "PI" | "O" | "E" | "R" | "S";
const INTERVAL_NAMES: readonly IntervalName[] = ["PI", "O", "E", "R", "S"];

/**
 * One family in one mode: classify, score the point, bootstrap the interval,
 * gate. Each family's bootstrap starts from the same recorded seed, so one
 * family's interval does not move when another family's rows are added.
 */
export function scoreFamily(
  family: Family,
  mode: ParityMode,
  raw: readonly RawPair[],
  options: ScoreOptions,
): FamilyScore {
  const mine = raw.filter((p) => p.family === family && p.mode === mode);
  const { included, excluded } = classifyPairs(mine);
  const point = computeAxes(included, mode);
  const tasks = [...new Set(included.map((p) => p.task))].sort();
  const inFamily = (rows: readonly ParityRunResult[]) =>
    rows.filter((r) => r.family === family && r.mode === mode);
  const absolute = {
    rune: absoluteStats(inFamily(options.rows?.rune ?? mine.map((p) => p.rune))),
    comparator: absoluteStats(inFamily(options.rows?.comparator ?? mine.map((p) => p.comparator))),
  };
  const caveats = absoluteCaveats(
    point?.axes ?? null,
    absolute.rune,
    absolute.comparator,
    options.comparatorName ?? "the comparator",
  );
  const old = computeAxes(included, mode, "v1");
  const legacy = {
    PI: old?.PI ?? null,
    R: old?.axes.R ?? null,
    S: old?.axes.S ?? null,
    differs: included.some((p) =>
      [p.r, p.c].some(
        (s) =>
          (s.legacyClean !== undefined && s.legacyClean !== s.clean) ||
          (s.legacyScope !== undefined && s.legacyScope !== s.scope),
      ),
    ),
  };
  const base = {
    family,
    name: FAMILY_NAMES[family],
    mode,
    n: included.length,
    tasks,
    excluded,
    absolute,
    caveats,
    legacy,
  };

  if (!point) {
    return {
      ...base,
      status: "UNMEASURED",
      reasons: ["no scored pairs"],
      axes: null,
      uncapped: null,
      PI: null,
      piRedistributed: false,
      interval: null,
      taskInterval: null,
      efficiency: { pairs: 0, status: "unmeasured", droppedFactors: { calls: 0, cost: 0 } },
    };
  }

  const statistic = (sample: ScoredPair[]): Record<IntervalName, number | null> => {
    const s = computeAxes(sample, mode)!;
    return { PI: s.PI, O: s.axes.O, E: s.axes.E, R: s.axes.R, S: s.axes.S };
  };
  const draw = { seed: options.seed, b: options.b ?? BOOTSTRAP_B };
  const boot = bootstrapStratified(included, (p) => p.task, statistic, INTERVAL_NAMES, draw);
  // E's interval describes E only where E exists at the point.
  const interval: FamilyIntervals = { ...boot, E: point.axes.E === null ? null : boot.E };
  const across = bootstrapClustered(included, (p) => p.task, statistic, INTERVAL_NAMES, draw);
  const taskInterval: FamilyIntervals | null =
    across.PI === null ? null : { ...across, E: point.axes.E === null ? null : across.E };

  const gate = gateFamily({
    axes: point.axes,
    PI: point.PI,
    piLower: interval.PI?.lo ?? null,
    n: included.length,
    tasks: tasks.length,
    efficiencyPairs: point.efficiencyPairs,
    unpaired: options.unpaired?.[family] ?? 0,
    caps: options.caps ?? [],
  });

  return {
    ...base,
    status: gate.status,
    reasons: gate.reasons,
    axes: point.axes,
    uncapped: point.uncapped,
    PI: point.PI,
    piRedistributed: point.axes.E === null,
    interval,
    taskInterval,
    efficiency: {
      pairs: point.efficiencyPairs,
      status: point.axes.E === null ? "insufficient" : "measured",
      droppedFactors: point.droppedFactors,
    },
  };
}

export interface Headline {
  family: Family;
  name: string;
  PI: number;
}

/** The weakest measured family: the minimum PI_f, first in family order on a tie. */
export function headlineOf(families: readonly FamilyScore[]): Headline | null {
  let best: FamilyScore | null = null;
  for (const f of families) {
    if (f.PI === null) continue;
    if (best === null || f.PI < best.PI!) best = f;
  }
  return best ? { family: best.family, name: best.name, PI: best.PI! } : null;
}

/**
 * FAIL if any family fails; else PROVISIONAL if any family is provisional or
 * unmeasured; else PASS. Nothing is PASS until all seven families pass.
 */
export function overallStatus(
  families: readonly Pick<FamilyScore, "family" | "status" | "reasons">[],
): { status: OverallStatus; reasons: string[] } {
  const reasons: string[] = [];
  for (const f of families) {
    if (f.status === "PASS") continue;
    if (f.status === "UNMEASURED") reasons.push(`${f.family} unmeasured`);
    else reasons.push(`${f.family} ${f.status}: ${f.reasons.join("; ")}`);
  }
  if (families.some((f) => f.status === "FAIL")) return { status: "FAIL", reasons };
  if (families.length < FAMILIES.length || families.some((f) => f.status !== "PASS"))
    return { status: "PROVISIONAL", reasons };
  return { status: "PASS", reasons };
}

export interface ModeScore {
  mode: ParityMode;
  families: FamilyScore[];
  headline: Headline | null;
  status: OverallStatus;
  reasons: string[];
  excluded: { unscoredPairs: number; noHiddenChecks: number; tooHardPairs: number };
  /** Each arm's attempts across every family in this mode, counted. */
  absolute: { rune: AbsoluteStats; comparator: AbsoluteStats };
}

/** Every family in one mode, in family order, with the mode's headline and status. */
export function scoreMode(
  mode: ParityMode,
  raw: readonly RawPair[],
  options: ScoreOptions,
): ModeScore {
  const families = FAMILIES.map((f) => scoreFamily(f, mode, raw, options));
  const overall = overallStatus(families);
  const sum = (k: "unscoredPairs" | "noHiddenChecks" | "tooHardPairs") =>
    families.reduce((s, f) => s + f.excluded[k], 0);
  const inMode = (side: "rune" | "comparator") =>
    (options.rows?.[side] ?? raw.map((p) => p[side])).filter((r) => r.mode === mode);
  return {
    mode,
    families,
    headline: headlineOf(families),
    status: overall.status,
    reasons: overall.reasons,
    excluded: {
      unscoredPairs: sum("unscoredPairs"),
      noHiddenChecks: sum("noHiddenChecks"),
      tooHardPairs: sum("tooHardPairs"),
    },
    absolute: {
      rune: absoluteStats(inMode("rune")),
      comparator: absoluteStats(inMode("comparator")),
    },
  };
}

/** PI_harness − PI_product per family, where both modes measured it. */
export function modelGaps(product: ModeScore, harness: ModeScore): Record<Family, number | null> {
  const out = {} as Record<Family, number | null>;
  for (const family of FAMILIES) {
    const p = product.families.find((f) => f.family === family)?.PI ?? null;
    const h = harness.families.find((f) => f.family === family)?.PI ?? null;
    out[family] = p === null || h === null ? null : h - p;
  }
  return out;
}
