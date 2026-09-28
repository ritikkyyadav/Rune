// ─── Parity Index fixtures: synthetic rows with hand-derivable numbers ───
//
// `golden.jsonl` and `mixed-rune.jsonl` beside this file are written from these
// builders by `write-fixtures.ts`; parity-report.test.ts checks they still
// match, so the checked-in files and the numbers the tests derive by hand
// cannot drift apart.

import type {
  Family,
  ParityArm,
  ParityMode,
  ParityRunResult,
  UnscoredReason,
} from "../../eval/parity/types";

export const RUNE_SHA = "a".repeat(64);
export const RUNE_SHA_2 = "b".repeat(64);
export const CC_SHA = "c".repeat(64);

/** One arm's side of a pair. Quality is `passed / total` (total 4 by default). */
export interface ArmSpec {
  passed?: number;
  total?: number;
  regressions?: number;
  buildBroken?: boolean;
  clean?: boolean;
  scope?: 0 | 0.5 | 1;
  wallMs?: number;
  calls?: number | null;
  listUsd?: number | null;
  scored?: boolean;
  unscoredReason?: UnscoredReason;
  version?: string;
  binarySha256?: string;
  model?: string;
}

export interface RowKey {
  task: string;
  run: number;
  arm: ParityArm;
  family?: Family;
  mode?: ParityMode;
}

export function row(k: RowKey, s: ArmSpec = {}): ParityRunResult {
  const mode = k.mode ?? "product";
  const scored = s.scored ?? true;
  const passed = s.passed ?? 4;
  const r: ParityRunResult = {
    schema: "parity-run/1",
    task: k.task,
    family: k.family ?? "F1",
    run: k.run,
    arm: k.arm,
    mode,
    model: s.model ?? (mode === "harness" ? "model-h" : k.arm === "rune" ? "model-r" : "model-c"),
    version: s.version ?? (k.arm === "rune" ? "1.3.1" : "2.1.0"),
    scored,
    outcome: {
      hiddenPassed: passed,
      hiddenTotal: s.total ?? 4,
      regressionsIntroduced: s.regressions ?? 0,
      buildBroken: s.buildBroken ?? false,
      impossible: [],
    },
    clean: s.clean ?? true,
    falseCompletion: false,
    scope: s.scope ?? 1,
    wallMs: s.wallMs ?? 100,
    calls: s.calls === undefined ? 10 : s.calls,
    listUsd: s.listUsd === undefined ? null : s.listUsd,
    exitCode: 0,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:00:01.000Z",
    evidence: `evidence/${mode}/${k.task}-${k.run}-${k.arm}`,
  };
  const sha =
    s.binarySha256 ?? (k.arm === "rune" ? RUNE_SHA : k.arm === "claude-code" ? CC_SHA : undefined);
  if (sha) r.binarySha256 = sha;
  if (!scored) r.unscoredReason = s.unscoredReason ?? "provider_outage";
  return r;
}

export interface PairOptions {
  family?: Family;
  mode?: ParityMode;
  comparator?: ParityArm;
}

/** Rune's row and the comparator's row for one (task, run, mode). */
export function pair(
  task: string,
  run: number,
  rune: ArmSpec,
  comp: ArmSpec,
  o: PairOptions = {},
): ParityRunResult[] {
  const base = { task, run, family: o.family, mode: o.mode };
  return [
    row({ ...base, arm: "rune" }, rune),
    row({ ...base, arm: o.comparator ?? "claude-code" }, comp),
  ];
}

/**
 * The golden family: six scored pairs over tasks a, b, c (F1). By hand:
 *
 *   q     Rune 1,1,1,1,.5,1 → 5.5/6   CC 1,1,1,1,1,.75 → 5.75/6
 *         O = 100 · 5.5/5.75 = 95.652…                  (uncapped 0.9565)
 *   clean Rune 4/6, CC 5/6 → R = 80                     (uncapped 0.8)
 *   scope Rune 5.5/6, CC 5/6 → ratio 1.1 → S = 100      (uncapped 1.1: the cap)
 *   E     both succeeded in a1 a2 b1 b2 (product: wall^.5 · calls^.5, CC÷Rune):
 *           a1  1                      → 0
 *           a2  wall .5                → .5·ln .5  = −.5 ln2
 *           b1  calls .25              → .5·ln .25 = −ln2
 *           b2  Rune calls null → wall only, exponent 1: wall 2 → ln2
 *         mean log = −ln2/8 → E = 100 · 2^(−1/8) = 91.700…
 *         c1 (Rune failed, CC 8× slower) and c2 (CC failed) stay out of E.
 *   PI = .4·95.652 + .25·91.700 + .2·80 + .15·100 = 92.186…
 */
export function goldenPairs(o: PairOptions = {}, extra: ArmSpec = {}): ParityRunResult[] {
  const x = (s: ArmSpec): ArmSpec => ({ ...extra, ...s });
  return [
    ...pair("a", 1, x({ wallMs: 100, calls: 10 }), x({ wallMs: 100, calls: 10 }), o),
    ...pair("a", 2, x({ clean: false, wallMs: 200, calls: 10 }), x({ wallMs: 100, calls: 10 }), o),
    ...pair("b", 1, x({ wallMs: 100, calls: 40 }), x({ scope: 0, wallMs: 100, calls: 10 }), o),
    ...pair(
      "b",
      2,
      x({ wallMs: 100, calls: null }),
      x({ clean: false, wallMs: 200, calls: 10 }),
      o,
    ),
    ...pair(
      "c",
      1,
      x({ passed: 2, clean: false, scope: 0.5, wallMs: 50, calls: null }),
      x({ wallMs: 400, calls: null }),
      o,
    ),
    ...pair("c", 2, x({ wallMs: 100, calls: 10 }), x({ passed: 3, wallMs: 100, calls: 10 }), o),
  ];
}

/** Hand-derived golden numbers for `goldenPairs` in product mode. */
export const GOLDEN = {
  O: (100 * 5.5) / 5.75,
  E: 100 * 2 ** (-1 / 8),
  R: 80,
  S: 100,
  uncapped: { O: 5.5 / 5.75, E: 2 ** (-1 / 8), R: 0.8, S: 1.1 },
  get PI() {
    return 0.4 * this.O + 0.25 * this.E + 0.2 * this.R + 0.15 * this.S;
  },
} as const;

/**
 * Harness mode, the same six pairs with a list cost of 1 on every row
 * (wall^.4 · calls^.3 · cost^.3):
 *   a2 −.4 ln2 · b1 .3·ln .25 = −.6 ln2 · b2 calls dropped → wall .4/.7 → (4/7) ln2
 *   mean log = −(3/7) ln2 / 4 = −(3/28) ln2 → E = 100 · 2^(−3/28)
 */
export const GOLDEN_HARNESS_E = 100 * 2 ** (-3 / 28);

/** Pairs that must be excluded, each for its own reason. */
export function exclusionPairs(o: PairOptions = {}): ParityRunResult[] {
  return [
    // Unscored on one side: out, and counted. Scored, they would move O.
    ...pair(
      "c",
      3,
      { passed: 1 },
      { passed: 0, scored: false, unscoredReason: "provider_outage" },
      o,
    ),
    ...pair(
      "c",
      4,
      { passed: 0, scored: false, unscoredReason: "provider_quota" },
      { passed: 4 },
      o,
    ),
    // No runnable hidden check on one side or both.
    ...pair("d", 1, { passed: 0, total: 0 }, { passed: 0, total: 0 }, o),
    ...pair("d", 2, { passed: 4 }, { passed: 0, total: 0 }, o),
    // Both zero: out, and task e flagged too hard.
    ...pair("e", 1, { passed: 0 }, { passed: 0 }, o),
  ];
}

/** Everything golden.jsonl holds. */
export function goldenFile(): ParityRunResult[] {
  return [
    ...goldenPairs(),
    ...exclusionPairs(),
    ...goldenPairs({ mode: "harness" }, { listUsd: 1 }),
    // A third arm: ignored when the comparator is Claude Code.
    row({ task: "a", run: 1, arm: "opencode" }, { version: "0.9.0", model: "model-o" }),
    // Rune ran F2's task f; the comparator did not: unpaired, never scored.
    row({ task: "f", run: 1, arm: "rune", family: "F2" }),
  ];
}

/** Golden pairs, but two of Rune's product rows came from a different binary. */
export function mixedRuneFile(): ParityRunResult[] {
  return goldenPairs().map((r) =>
    r.arm === "rune" && r.task === "c" ? { ...r, binarySha256: RUNE_SHA_2 } : r,
  );
}

export const toJsonl = (rows: readonly ParityRunResult[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
