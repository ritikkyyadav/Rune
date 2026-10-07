// ─── The Parity Index report ───
//
//   bun tests/eval/parity/report.ts --results <file...> --out <dir>
//       [--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions]
//       [--allow-mixed-config] [--allow-unfingerprinted]
//
// Reads results.jsonl files (the arms write them), scores product and harness
// mode separately, and writes <dir>/parity-report.json and
// <dir>/parity-report.md. It never overwrites: if either file already exists
// nothing is written. The number the release gate reads is `status` and
// `headline` in the JSON, which come from product mode only; harness mode is
// attribution (docs/program/parity-index.md).
//
// Exit codes: 0 report written (whatever it says), 1 inputs refused or output
// exists, 2 usage.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ParityInputError,
  comparabilityProblems,
  rosterLines,
  loadResults,
  mixedBuildProblems,
  pairRows,
  schemasSeen,
  versionsSeen,
  type Pairing,
  type ResultsInput,
  type VersionsByMode,
} from "./aggregate";
import {
  BOOTSTRAP_B,
  DEFAULT_SEED,
  INTERVAL_QUANTILES,
  TASK_INTERVAL_QUANTILES,
  type Interval,
} from "./bootstrap";
import { modeEconomics, type ArmEconomics, type ModeEconomics } from "./economics";
import {
  COMPARATORS,
  FAMILIES,
  GATE,
  PROPOSED_COMPLETE_RATE_FLOOR,
  WEIGHTS,
  EFFICIENCY_EXPONENTS,
  modelGaps,
  scoreMode,
  type AbsoluteStats,
  type Comparator,
  type Headline,
  type ModeScore,
  type OverallStatus,
} from "./score";
import {
  FAMILY_NAMES,
  type Family,
  type ParityMode,
  type ParityRunResult,
  type RowSchema,
} from "./types";

export const REPORT_KIND = "parity-report" as const;
/**
 * `parity-report/2` adds, beside everything `/1` had and without moving any of
 * it: the absolute counts per arm, the caveats they raise, the index under the
 * `parity-run/1` rules, the task-level interval, which row schemas were read,
 * and what was let in under an override. A `/1` report on disk is never
 * rewritten — this CLI refuses to overwrite any report.
 */
export const REPORT_SCHEMA = "parity-report/2" as const;
export const REPORT_JSON = "parity-report.json";
export const REPORT_MD = "parity-report.md";

export interface ModeReport extends ModeScore {
  unpaired: Pairing["unpaired"];
  otherArmRows: number;
  /** Null when an override admits multiple configurations or builds in this mode. */
  economics: ModeEconomics | null;
}

export interface ParityReport {
  kind: typeof REPORT_KIND;
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  comparator: Comparator;
  inputs: ResultsInput[];
  seed: number;
  bootstrap: {
    b: number;
    quantiles: readonly [number, number];
    stratifiedBy: "task";
    prng: "mulberry32";
    /** The second interval: whole tasks resampled. Reported, never gated. */
    taskLevel: { quantiles: readonly [number, number]; resamples: "tasks" };
  };
  weights: typeof WEIGHTS;
  efficiencyExponents: typeof EFFICIENCY_EXPONENTS;
  gate: typeof GATE;
  versions: VersionsByMode;
  /** How many rows were read under each row schema. */
  rowSchemas: Partial<Record<RowSchema, number>>;
  /** The share of gradable attempts complete the review proposed for a broad claim. Not a gate. */
  proposedCompleteRateFloor: number;
  /** Set only when --allow-mixed-versions let two builds of one arm into one mode. */
  mixedVersions: string[];
  /**
   * What each compared arm was configured to call and what it did call, where
   * its rows state a roster. Absent when none does.
   */
  rosters?: string[];
  /**
   * What an override let in. Each line is also a reason, and keeps every
   * family it touches from PASS: evidence reported across a gap in
   * comparability is at best PROVISIONAL.
   */
  allowed: { unfingerprinted: string[]; mixedConfig: string[] };
  modes: Record<ParityMode, ModeReport>;
  /** PI_harness − PI_product per family, where both were measured. */
  modelGap: Record<Family, number | null>;
  /** The weakest product-mode family. Null when no family was measured. */
  headline: (Headline & { mode: "product" }) | null;
  /** Product mode's status: the release gate. */
  status: OverallStatus;
  reasons: string[];
}

export interface BuildOptions {
  rows: readonly ParityRunResult[];
  inputs: readonly ResultsInput[];
  comparator?: Comparator;
  seed?: number;
  allowMixedVersions?: boolean;
  /** Report across one arm's several configurations or model rosters in a mode. */
  allowMixedConfig?: boolean;
  /** Report rows that carry no fingerprints: `parity-run/1` evidence. */
  allowUnfingerprinted?: boolean;
  now?: Date;
  /** Bootstrap replicates; tests only. The CLI always uses BOOTSTRAP_B. */
  b?: number;
}

/**
 * Score validated rows into a report. Throws ParityInputError on evidence that
 * cannot be shown comparable, every problem named and each with its override
 * where it has one.
 */
export function buildReport(o: BuildOptions): ParityReport {
  const comparator = o.comparator ?? "claude-code";
  const seed = o.seed ?? DEFAULT_SEED;
  const b = o.b ?? BOOTSTRAP_B;

  const mixed = mixedBuildProblems(o.rows, comparator);
  const comparable = comparabilityProblems(o.rows, comparator);
  const rosters = rosterLines(o.rows, comparator);
  const refused = [...comparable.mismatched];
  if (comparable.unfingerprinted.length > 0 && !o.allowUnfingerprinted)
    refused.push(
      ...comparable.unfingerprinted,
      "pass --allow-unfingerprinted to report them: the report then says so and cannot PASS",
    );
  if (comparable.mixedConfig.length > 0 && !o.allowMixedConfig)
    refused.push(
      ...comparable.mixedConfig,
      "pass --allow-mixed-config to report across them: the report then says so and cannot PASS",
    );
  if (mixed.length > 0 && !o.allowMixedVersions)
    refused.push(...mixed, "pass --allow-mixed-versions to report across them");
  if (refused.length > 0) throw new ParityInputError(refused);

  const modes = {} as Record<ParityMode, ModeReport>;
  for (const mode of ["product", "harness"] as const) {
    const pairing = pairRows(o.rows, mode, comparator);
    const score = scoreMode(mode, pairing.pairs, {
      seed,
      b,
      unpaired: pairing.unpairedByFamily,
      rows: pairing.rows,
      comparatorName: comparator,
      caps: [
        ...(pairing.pairs.some((p) => !p.rune.fingerprints || !p.comparator.fingerprints)
          ? ["rows without fingerprints (allowed by --allow-unfingerprinted)"]
          : []),
        ...comparable.mixedConfig
          .filter((line) => line.startsWith(`${mode} mode `))
          .map((line) => `${line} (allowed by --allow-mixed-config)`),
      ],
    });
    const mixedEconomics =
      mixed.some((line) => line.startsWith(`${mode} mode `)) ||
      comparable.mixedConfig.some((line) => line.startsWith(`${mode} mode `));
    modes[mode] = {
      ...score,
      unpaired: pairing.unpaired,
      otherArmRows: pairing.otherArmRows,
      economics: mixedEconomics ? null : modeEconomics(pairing),
    };
  }

  const product = modes.product;
  const reasons = [...product.reasons];
  if (product.families.every((f) => f.status === "UNMEASURED"))
    reasons.unshift("no product-mode family was measured; harness mode is never a gate");
  const unpaired = product.unpaired.rune.length + product.unpaired.comparator.length;
  if (unpaired > 0)
    reasons.push(
      `product mode: ${product.unpaired.rune.length} Rune row(s) and ${product.unpaired.comparator.length} ${comparator} row(s) have no partner and are not scored`,
    );
  if (mixed.length > 0)
    reasons.push(...mixed.map((line) => `${line} (allowed by --allow-mixed-versions)`));
  reasons.push(
    ...comparable.unfingerprinted.map((line) => `${line} (allowed by --allow-unfingerprinted)`),
    ...comparable.mixedConfig.map((line) => `${line} (allowed by --allow-mixed-config)`),
  );

  return {
    kind: REPORT_KIND,
    schema: REPORT_SCHEMA,
    generatedAt: (o.now ?? new Date()).toISOString(),
    comparator,
    inputs: [...o.inputs],
    seed,
    bootstrap: {
      b,
      quantiles: INTERVAL_QUANTILES,
      stratifiedBy: "task",
      prng: "mulberry32",
      taskLevel: { quantiles: TASK_INTERVAL_QUANTILES, resamples: "tasks" },
    },
    weights: WEIGHTS,
    efficiencyExponents: EFFICIENCY_EXPONENTS,
    gate: GATE,
    versions: versionsSeen(o.rows),
    rowSchemas: schemasSeen(o.rows),
    proposedCompleteRateFloor: PROPOSED_COMPLETE_RATE_FLOOR,
    mixedVersions: mixed,
    ...(rosters.length > 0 ? { rosters } : {}),
    allowed: { unfingerprinted: comparable.unfingerprinted, mixedConfig: comparable.mixedConfig },
    modes,
    modelGap: modelGaps(modes.product, modes.harness),
    headline: product.headline ? { mode: "product", ...product.headline } : null,
    status: product.status,
    reasons,
  };
}

// ── Markdown ──

const num = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? "—" : x.toFixed(digits);
const ratio = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${x.toFixed(2)}×`;
const span = (i: Interval | null | undefined) =>
  i ? `${i.lo.toFixed(1)}–${i.hi.toFixed(1)}` : "—";
const signed = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);

function modeSection(m: ModeReport, title: string, comparator: Comparator): string[] {
  const out: string[] = [];
  out.push(`## ${title}`, "");
  out.push(
    `Status: **${m.status}**` +
      (m.headline
        ? ` · weakest family ${m.headline.family} (${m.headline.name}) at PI ${num(m.headline.PI)}`
        : " · no family measured"),
    "",
  );
  out.push(
    "| Family | n | Tasks | O | E | R | S | PI | 80% within tasks | 95% across tasks | PI, v1 rules | Status |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|",
  );
  for (const f of m.families) {
    const e = f.axes ? (f.axes.E === null ? "insufficient" : num(f.axes.E)) : "—";
    const pi = f.PI === null ? "—" : `${num(f.PI)}${f.piRedistributed ? "*" : ""}`;
    const old = f.legacy.PI === null ? "—" : `${num(f.legacy.PI)}${f.legacy.differs ? "†" : ""}`;
    out.push(
      `| ${f.family} ${f.name} | ${f.n} | ${f.tasks.length} | ${num(f.axes?.O)} | ${e} | ${num(f.axes?.R)} | ${num(f.axes?.S)} | ${pi} | ${span(f.interval?.PI)} | ${span(f.taskInterval?.PI)} | ${old} | ${f.status} |`,
    );
  }
  out.push(
    "",
    "\\* PI with E's weight spread over O, R and S (E insufficient).",
    "",
    "80% within tasks: each task's runs resampled, the tasks held fixed — how far PI would move if THESE tasks were run again. The gate reads its lower bound. 95% across tasks: whole tasks resampled — how far it might move on other tasks like these. It is reported, not gated, is coarse with few tasks, and is — with fewer than two.",
    "",
    "PI, v1 rules: the same pairs scored as `parity-run/1` scored them — no scope rules for coding tasks, and a crash that ended fast counted as clean. † marks a family where that changes R or S. It is shown for continuity; the status reads PI.",
    "",
  );
  out.push(...absoluteSection(m, comparator));
  out.push(...economicsSection(m.economics, comparator));
  out.push(
    `Advantages (uncapped ratios, Rune ÷ ${comparator}; 1.00× is parity):`,
    "",
    "| Family | O | E | R | S |",
    "|---|---:|---:|---:|---:|",
  );
  for (const f of m.families) {
    if (!f.uncapped) continue;
    out.push(
      `| ${f.family} | ${ratio(f.uncapped.O)} | ${ratio(f.uncapped.E)} | ${ratio(f.uncapped.R)} | ${ratio(f.uncapped.S)} |`,
    );
  }
  out.push("");
  const notes = m.families.filter((f) => f.status !== "PASS");
  if (notes.length > 0) {
    out.push("Reasons:", "");
    for (const f of notes) out.push(`- ${f.family} ${f.status}: ${f.reasons.join("; ")}`);
    out.push("");
  }
  const tooHard = m.families.flatMap((f) => f.excluded.tooHardTasks);
  out.push(
    `Excluded from the index (and counted in the absolute table above): ${m.excluded.unscoredPairs} unscored pair(s), ${m.excluded.noHiddenChecks} with no hidden checks, ${m.excluded.tooHardPairs} both-zero pair(s)` +
      (tooHard.length > 0 ? ` (too hard: ${tooHard.join(", ")})` : "") +
      `; unpaired rows: ${m.unpaired.rune.length} Rune, ${m.unpaired.comparator.length} ${comparator}.`,
    "",
  );
  return out;
}

const share = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const money = (usd: number | null) =>
  usd === null ? "—" : usd === 0 ? "$0" : `$${Number(usd.toPrecision(4))}`;

function economicsRow(label: string, e: ArmEconomics): string {
  return `| ${label} | ${e.attempts} | ${e.cleanCompletions} | ${money(e.knownListUsd)} | ${e.unknownPriceAttempts} | ${money(e.usdPerCleanCompletion)} | ${e.medianWallMs === null ? "—" : minutes(e.medianWallMs)} | ${e.p90WallMs === null ? "—" : minutes(e.p90WallMs)} |`;
}

function economicsSection(e: ModeEconomics | null, comparator: Comparator): string[] {
  if (!e)
    return [
      "Attempt economics: unavailable because this mode combines configurations or builds under an override.",
      "",
    ];
  return [
    "Attempt economics — descriptive only; attempts include retries and unpaired rows:",
    "",
    "| Arm | Attempts | Clean complete | Known list cost | Price unknown | Cost / clean completion | Median wall | P90 wall |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    economicsRow("Rune", e.rune),
    economicsRow(comparator, e.comparator),
    "",
    `Jointly clean completed pairs: ${e.jointlyCleanPairs}. Median paired Rune ÷ ${comparator}: list cost ${ratio(e.pairedCostRatio)}, wall time ${ratio(e.pairedWallRatio)}.`,
    "",
    "List cost is an estimate, not an invoice. Known list cost sums priced attempts only; cost per clean completion includes every attempt and is unavailable if any price is unknown or no task completed cleanly. Paired ratios use latest attempts and require joint clean completion, complete price coverage, and positive denominators. — means unavailable.",
    "",
  ];
}

function absoluteRow(label: string, arm: string, a: AbsoluteStats): string {
  const unscored = Object.values(a.unscored).reduce((n, count) => n + (count ?? 0), 0);
  return (
    `| ${label} | ${arm} | ${a.attempts} | ${unscored} | ${a.gradable} | ${a.complete} | ${a.partial} | ${a.zero} | ${a.unverified} | ` +
    `${share(a.completeRate)} | ${a.cleanComplete} | ${a.regressions} | ${a.scopeViolations} | ${a.falseCompletions} | ` +
    `${a.terminal.crashed ?? 0} | ${a.terminal.stopped ?? 0} |`
  );
}

function absoluteTotals(arm: string, a: AbsoluteStats): string {
  const reasons = Object.entries(a.unscored)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([reason, count]) => `${reason} ${count}`);
  const endings = Object.entries(a.terminal)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([terminal, count]) => `${terminal} ${count}`);
  return (
    `- ${arm}: ${a.attempts} attempt(s), ${minutes(a.wallMs)} of wall time` +
    (reasons.length
      ? `, of which ${minutes(a.unscoredWallMs)} in unscored attempts (${reasons.join(", ")})`
      : "") +
    `; list cost $${a.listUsd.toFixed(2)}` +
    (a.costUnknown > 0 ? ` over the attempts that have one (${a.costUnknown} have none)` : "") +
    `; endings: ${endings.join(", ") || "none"}.`
  );
}

/**
 * What each arm did, counted over every attempt. The index above is a ratio and
 * cannot say this: two arms that each finished nothing score O = 100.
 */
function absoluteSection(m: ModeReport, comparator: Comparator): string[] {
  const out: string[] = [
    "Absolute outcomes — every attempt, counted; nothing here is a ratio against the other arm:",
    "",
    "| Family | Arm | Attempts | Unscored | Gradable | Complete | Partial | Zero | Unverified | Complete rate | Clean complete | Regressions | Out of scope | False completions | Crashed | Stopped |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const f of m.families) {
    if (f.absolute.rune.attempts + f.absolute.comparator.attempts === 0) continue;
    out.push(absoluteRow(f.family, "Rune", f.absolute.rune));
    out.push(absoluteRow(f.family, comparator, f.absolute.comparator));
  }
  out.push(absoluteRow("All", "Rune", m.absolute.rune));
  out.push(absoluteRow("All", comparator, m.absolute.comparator));
  out.push(
    "",
    "Complete is q = 1: every runnable hidden check passed, nothing regressed, the build whole. Partial credit is not a finished task. Unverified is a run nothing could check, and is never counted complete. Complete rate is complete ÷ gradable. Clean complete is complete, ended clean, and nothing out of scope.",
    "",
    absoluteTotals("Rune", m.absolute.rune),
    absoluteTotals(comparator, m.absolute.comparator),
    "",
  );
  const caveats = m.families.filter((f) => f.caveats.length > 0);
  if (caveats.length > 0) {
    out.push("Caveats (reported; none of them is part of a status):", "");
    for (const f of caveats) for (const caveat of f.caveats) out.push(`- ${f.family}: ${caveat}`);
    out.push("");
  }
  return out;
}

/** The same report as a Markdown page. */
export function renderMarkdown(r: ParityReport): string {
  const out: string[] = [];
  out.push(`# Parity Index — Rune vs ${r.comparator}`, "");
  out.push(
    `Generated ${r.generatedAt} · seed ${r.seed} · B = ${r.bootstrap.b} · 80% interval, paired bootstrap stratified by task · 95% task-level interval, tasks resampled`,
    "",
  );
  out.push(
    `**Status: ${r.status}**` +
      (r.headline
        ? ` · headline PI ${num(r.headline.PI)}, ${r.headline.family} (${r.headline.name})`
        : " · no headline: no product-mode family measured"),
    "",
  );
  if (r.reasons.length > 0) {
    for (const reason of r.reasons) out.push(`- ${reason}`);
    out.push("");
  }
  out.push(...modeSection(r.modes.product, "Product mode — the gate", r.comparator));
  out.push(
    ...modeSection(r.modes.harness, "Harness mode — attribution only, never a gate", r.comparator),
  );
  out.push("## Model gap (PI harness − PI product)", "");
  out.push("| Family | Gap |", "|---|---:|");
  for (const f of FAMILIES) out.push(`| ${f} ${FAMILY_NAMES[f]} | ${signed(r.modelGap[f])} |`);
  out.push("", "## Versions", "");
  for (const mode of ["product", "harness"] as const) {
    for (const [arm, list] of Object.entries(r.versions[mode])) {
      for (const v of list!) {
        out.push(
          `- ${mode} · ${arm} · ${v.version}` +
            (v.binarySha256 ? ` · sha256 ${v.binarySha256.slice(0, 12)}…` : "") +
            (v.sourceBuild ? ` · source ${v.sourceBuild.slice(0, 12)}…` : "") +
            ` · ${v.models.join(", ")} · ${v.rows} row(s)`,
        );
      }
    }
  }
  if (r.rosters?.length) {
    out.push("", "## Models called", "");
    for (const line of r.rosters) out.push(`- ${line}`);
  }
  out.push("", "## Inputs", "");
  for (const i of r.inputs) out.push(`- \`${i.path}\` · ${i.rows} row(s) · sha256 ${i.sha256}`);
  out.push(
    "",
    `Row schemas read: ${
      Object.entries(r.rowSchemas)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([schema, rows]) => `${schema} × ${rows}`)
        .join(", ") || "none"
    }. A \`parity-run/1\` row never recorded how its run ended, and its clean and scope flags are the v1 rules' own.`,
    "",
  );
  return out.join("\n");
}

// ── CLI ──

export interface CliOptions {
  results: string[];
  out: string;
  comparator: Comparator;
  seed: number;
  allowMixedVersions: boolean;
  allowMixedConfig: boolean;
  allowUnfingerprinted: boolean;
}

const USAGE =
  "usage: bun tests/eval/parity/report.ts --results <file...> --out <dir> " +
  "[--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions] " +
  "[--allow-mixed-config] [--allow-unfingerprinted]";

export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  const results: string[] = [];
  let out: string | undefined;
  let comparator: Comparator = "claude-code";
  let seed = DEFAULT_SEED;
  let allowMixedVersions = false;
  let allowMixedConfig = false;
  let allowUnfingerprinted = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--results") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) results.push(argv[++i]!);
    } else if (a === "--out") {
      out = argv[++i];
    } else if (a === "--comparator") {
      const c = argv[++i];
      if (!COMPARATORS.includes(c as Comparator))
        return { error: `--comparator must be one of ${COMPARATORS.join(", ")}` };
      comparator = c as Comparator;
    } else if (a === "--seed") {
      const s = argv[++i];
      if (s === undefined || !/^\d+$/.test(s) || Number(s) > 0xffffffff)
        return { error: "--seed must be an integer from 0 to 4294967295" };
      seed = Number(s);
    } else if (a === "--allow-mixed-versions") {
      allowMixedVersions = true;
    } else if (a === "--allow-mixed-config") {
      allowMixedConfig = true;
    } else if (a === "--allow-unfingerprinted") {
      allowUnfingerprinted = true;
    } else {
      return { error: `unknown argument ${a}` };
    }
  }
  if (results.length === 0) return { error: "--results needs at least one file" };
  if (!out) return { error: "--out needs a directory" };
  return {
    results,
    out,
    comparator,
    seed,
    allowMixedVersions,
    allowMixedConfig,
    allowUnfingerprinted,
  };
}

export function main(
  argv: readonly string[],
  io: { log: (s: string) => void; error: (s: string) => void } = console,
): number {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const jsonPath = join(args.out, REPORT_JSON);
  const mdPath = join(args.out, REPORT_MD);
  const existing = [jsonPath, mdPath].filter((p) => existsSync(p));
  if (existing.length > 0) {
    io.error(`refusing to overwrite ${existing.join(" and ")}; choose a new --out`);
    return 1;
  }
  let report: ParityReport;
  try {
    const { inputs, rows } = loadResults(args.results);
    report = buildReport({
      rows,
      inputs,
      comparator: args.comparator,
      seed: args.seed,
      allowMixedVersions: args.allowMixedVersions,
      allowMixedConfig: args.allowMixedConfig,
      allowUnfingerprinted: args.allowUnfingerprinted,
    });
  } catch (e) {
    if (e instanceof ParityInputError) {
      io.error(e.message);
      return 1;
    }
    throw e;
  }
  mkdirSync(args.out, { recursive: true });
  // `wx`: fail rather than overwrite, even if a file appeared since the check.
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(mdPath, renderMarkdown(report), { flag: "wx" });
  io.log(
    `parity: ${report.status}` +
      (report.headline
        ? ` · headline PI ${report.headline.PI.toFixed(1)} (${report.headline.family})`
        : " · no product-mode family measured") +
      `\n  ${jsonPath}\n  ${mdPath}`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
