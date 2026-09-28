// ─── The Parity Index report ───
//
//   bun tests/eval/parity/report.ts --results <file...> --out <dir>
//       [--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions]
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
  loadResults,
  mixedRuneProblems,
  pairRows,
  versionsSeen,
  type Pairing,
  type ResultsInput,
  type VersionsByMode,
} from "./aggregate";
import { BOOTSTRAP_B, DEFAULT_SEED, INTERVAL_QUANTILES, type Interval } from "./bootstrap";
import {
  COMPARATORS,
  FAMILIES,
  GATE,
  WEIGHTS,
  EFFICIENCY_EXPONENTS,
  modelGaps,
  scoreMode,
  type Comparator,
  type Headline,
  type ModeScore,
  type OverallStatus,
} from "./score";
import { FAMILY_NAMES, type Family, type ParityMode, type ParityRunResult } from "./types";

export const REPORT_KIND = "parity-report" as const;
export const REPORT_SCHEMA = "parity-report/1" as const;
export const REPORT_JSON = "parity-report.json";
export const REPORT_MD = "parity-report.md";

export interface ModeReport extends ModeScore {
  unpaired: Pairing["unpaired"];
  otherArmRows: number;
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
  };
  weights: typeof WEIGHTS;
  efficiencyExponents: typeof EFFICIENCY_EXPONENTS;
  gate: typeof GATE;
  versions: VersionsByMode;
  /** Set only when --allow-mixed-versions let two Rune builds into one mode. */
  mixedVersions: string[];
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
  now?: Date;
  /** Bootstrap replicates; tests only. The CLI always uses BOOTSTRAP_B. */
  b?: number;
}

/** Score validated rows into a report. Throws ParityInputError on mixed Rune builds. */
export function buildReport(o: BuildOptions): ParityReport {
  const comparator = o.comparator ?? "claude-code";
  const seed = o.seed ?? DEFAULT_SEED;
  const b = o.b ?? BOOTSTRAP_B;

  const mixed = mixedRuneProblems(o.rows);
  if (mixed.length > 0 && !o.allowMixedVersions)
    throw new ParityInputError([...mixed, "pass --allow-mixed-versions to report across them"]);

  const modes = {} as Record<ParityMode, ModeReport>;
  for (const mode of ["product", "harness"] as const) {
    const pairing = pairRows(o.rows, mode, comparator);
    const score = scoreMode(mode, pairing.pairs, {
      seed,
      b,
      unpaired: pairing.unpairedByFamily,
    });
    modes[mode] = { ...score, unpaired: pairing.unpaired, otherArmRows: pairing.otherArmRows };
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
    reasons.push(...mixed.map((m) => `${m} (allowed by --allow-mixed-versions)`));

  return {
    kind: REPORT_KIND,
    schema: REPORT_SCHEMA,
    generatedAt: (o.now ?? new Date()).toISOString(),
    comparator,
    inputs: [...o.inputs],
    seed,
    bootstrap: { b, quantiles: INTERVAL_QUANTILES, stratifiedBy: "task", prng: "mulberry32" },
    weights: WEIGHTS,
    efficiencyExponents: EFFICIENCY_EXPONENTS,
    gate: GATE,
    versions: versionsSeen(o.rows),
    mixedVersions: mixed,
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
    "| Family | n | Tasks | O | E | R | S | PI | 80% interval | Status |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|---|",
  );
  for (const f of m.families) {
    const e = f.axes ? (f.axes.E === null ? "insufficient" : num(f.axes.E)) : "—";
    const pi = f.PI === null ? "—" : `${num(f.PI)}${f.piRedistributed ? "*" : ""}`;
    out.push(
      `| ${f.family} ${f.name} | ${f.n} | ${f.tasks.length} | ${num(f.axes?.O)} | ${e} | ${num(f.axes?.R)} | ${num(f.axes?.S)} | ${pi} | ${span(f.interval?.PI)} | ${f.status} |`,
    );
  }
  out.push("", "\\* PI with E's weight spread over O, R and S (E insufficient).", "");
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
    `Excluded: ${m.excluded.unscoredPairs} unscored pair(s), ${m.excluded.noHiddenChecks} with no hidden checks, ${m.excluded.tooHardPairs} both-zero pair(s)` +
      (tooHard.length > 0 ? ` (too hard: ${tooHard.join(", ")})` : "") +
      `; unpaired rows: ${m.unpaired.rune.length} Rune, ${m.unpaired.comparator.length} ${comparator}.`,
    "",
  );
  return out;
}

/** The same report as a Markdown page. */
export function renderMarkdown(r: ParityReport): string {
  const out: string[] = [];
  out.push(`# Parity Index — Rune vs ${r.comparator}`, "");
  out.push(
    `Generated ${r.generatedAt} · seed ${r.seed} · B = ${r.bootstrap.b} · 80% interval, paired bootstrap stratified by task`,
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
            ` · ${v.models.join(", ")} · ${v.rows} row(s)`,
        );
      }
    }
  }
  out.push("", "## Inputs", "");
  for (const i of r.inputs) out.push(`- \`${i.path}\` · ${i.rows} row(s) · sha256 ${i.sha256}`);
  out.push("");
  return out.join("\n");
}

// ── CLI ──

export interface CliOptions {
  results: string[];
  out: string;
  comparator: Comparator;
  seed: number;
  allowMixedVersions: boolean;
}

const USAGE =
  "usage: bun tests/eval/parity/report.ts --results <file...> --out <dir> " +
  "[--comparator claude-code|opencode] [--seed N] [--allow-mixed-versions]";

export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  const results: string[] = [];
  let out: string | undefined;
  let comparator: Comparator = "claude-code";
  let seed = DEFAULT_SEED;
  let allowMixedVersions = false;
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
    } else {
      return { error: `unknown argument ${a}` };
    }
  }
  if (results.length === 0) return { error: "--results needs at least one file" };
  if (!out) return { error: "--out needs a directory" };
  return { results, out, comparator, seed, allowMixedVersions };
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
