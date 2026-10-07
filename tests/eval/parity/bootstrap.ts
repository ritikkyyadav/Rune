// ─── The Parity Index bootstrap ───
//
// A paired bootstrap stratified by task: every replicate resamples each task's
// pairs WITH replacement, keeping the task's own count, so a replicate never
// trades one task's pairs for another's and a task with many runs cannot crowd
// out a task with few. The generator is seeded (mulberry32) and the seed goes
// into the report, so the same results files give the same interval on every
// machine (docs/program/parity-index.md).
//
// That interval answers one question: how far would the number move if THESE
// tasks were run again? It holds the tasks fixed, so it says nothing about
// tasks that were not run. `bootstrapClustered` answers the other one: each
// replicate draws whole TASKS with replacement, every drawn task bringing all
// its pairs. It is wider, often much wider, and with three tasks it is coarse
// — which is the fact it is there to show. The two are reported side by side
// under their own names; the gate reads the first, as it always has.
//
// Pure: no clock, no disk, no Math.random.

/** Replicates per interval. */
export const BOOTSTRAP_B = 2000;

/** The interval's quantiles: 80%, from the 10th to the 90th percentile. */
export const INTERVAL_QUANTILES = [0.1, 0.9] as const;

/** The task-level interval's quantiles: 95%, from the 2.5th to the 97.5th percentile. */
export const TASK_INTERVAL_QUANTILES = [0.025, 0.975] as const;

/** Fewer tasks than this and there is no spread across tasks to resample. */
export const MIN_TASKS_FOR_TASK_INTERVAL = 2;

/** The seed used when the caller does not name one (the contract's date). */
export const DEFAULT_SEED = 20260928;

/**
 * mulberry32: a 32-bit seeded generator, uniform on [0, 1).
 *
 * Small, fast and fully specified by its source, which is the point: the
 * interval in a report can be re-derived from the seed it records.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Items grouped by stratum, in a fixed order: strata sorted by key, items kept
 * in the order given. The caller sorts items first when their order should not
 * depend on the order the inputs were read in.
 */
export function strata<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.keys()].sort().map((k) => groups.get(k)!);
}

/**
 * One replicate: each stratum resampled with replacement to its own size.
 * The result holds exactly as many items from each stratum as the input did.
 */
export function resampleStratified<T>(groups: readonly (readonly T[])[], rng: () => number): T[] {
  const out: T[] = [];
  for (const group of groups) {
    const n = group.length;
    for (let i = 0; i < n; i++) out.push(group[Math.floor(rng() * n)]!);
  }
  return out;
}

/**
 * One task-level replicate: as many strata as the input has, each drawn whole
 * and with replacement. A stratum drawn twice brings its items twice; one not
 * drawn brings none, so a replicate's size varies with the strata it drew.
 */
export function resampleClusters<T>(groups: readonly (readonly T[])[], rng: () => number): T[] {
  const out: T[] = [];
  const k = groups.length;
  for (let i = 0; i < k; i++) out.push(...groups[Math.floor(rng() * k)]!);
  return out;
}

/**
 * The p-quantile of `values` by linear interpolation between order statistics
 * (the "type 7" rule numpy and R use by default). Null for an empty list.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

export interface Interval {
  lo: number;
  hi: number;
  /** Replicates the statistic was defined in (E can be undefined in some). */
  replicates: number;
}

export interface BootstrapOptions {
  seed: number;
  /** Replicates; BOOTSTRAP_B unless a test says otherwise. */
  b?: number;
}

/**
 * Bootstrap several named statistics at once over task-stratified resamples.
 *
 * `statistic` scores one replicate and returns a value per name (null when the
 * statistic is undefined for that replicate, e.g. E with too few successes).
 * Each name's interval is taken over the replicates where it was defined, and
 * is null where it never was.
 */
export function bootstrapStratified<T, K extends string>(
  items: readonly T[],
  stratumOf: (item: T) => string,
  statistic: (sample: T[]) => Record<K, number | null>,
  names: readonly K[],
  options: BootstrapOptions,
): Record<K, Interval | null> {
  return intervals(
    strata(items, stratumOf),
    resampleStratified,
    statistic,
    names,
    options,
    INTERVAL_QUANTILES,
  );
}

/**
 * The same statistics over task-level resamples (`resampleClusters`), as a 95%
 * interval. Every name is null with fewer than two tasks: one task resampled
 * is that task every time, and an interval of zero width would say the result
 * is certain when it is only unexamined.
 *
 * It starts its own generator from the same recorded seed, so asking for it
 * never moves a draw of `bootstrapStratified`'s.
 */
export function bootstrapClustered<T, K extends string>(
  items: readonly T[],
  clusterOf: (item: T) => string,
  statistic: (sample: T[]) => Record<K, number | null>,
  names: readonly K[],
  options: BootstrapOptions,
): Record<K, Interval | null> {
  const groups = strata(items, clusterOf);
  if (groups.length < MIN_TASKS_FOR_TASK_INTERVAL)
    return Object.fromEntries(names.map((n) => [n, null])) as Record<K, Interval | null>;
  return intervals(groups, resampleClusters, statistic, names, options, TASK_INTERVAL_QUANTILES);
}

function intervals<T, K extends string>(
  groups: readonly (readonly T[])[],
  resample: (groups: readonly (readonly T[])[], rng: () => number) => T[],
  statistic: (sample: T[]) => Record<K, number | null>,
  names: readonly K[],
  options: BootstrapOptions,
  quantiles: readonly [number, number],
): Record<K, Interval | null> {
  const b = options.b ?? BOOTSTRAP_B;
  const rng = mulberry32(options.seed);
  const draws = new Map<K, number[]>(names.map((n) => [n, []]));
  for (let i = 0; i < b; i++) {
    const values = statistic(resample(groups, rng));
    for (const n of names) {
      const v = values[n];
      if (v !== null && Number.isFinite(v)) draws.get(n)!.push(v);
    }
  }
  const out = {} as Record<K, Interval | null>;
  for (const n of names) {
    const d = draws.get(n)!;
    const lo = percentile(d, quantiles[0]);
    const hi = percentile(d, quantiles[1]);
    out[n] = lo === null || hi === null ? null : { lo, hi, replicates: d.length };
  }
  return out;
}
