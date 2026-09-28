// ─── The Parity Index aggregator ───
//
// results.jsonl files in, validated rows and pairs out. Every row is checked
// against the frozen contract (types.ts) before anything is scored: a row the
// scorer cannot trust is an error that stops the report, never a row that
// quietly drops out of a denominator. Duplicates, a task filed under two
// families, and two different Rune builds in one mode are errors too — the
// last one unless the caller says `--allow-mixed-versions`.
//
// The only impure function here is `loadResults`, which reads the files and
// hashes their bytes; the rest is pure.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Comparator, RawPair } from "./score";
import {
  SCHEMA,
  type Family,
  type ParityArm,
  type ParityMode,
  type ParityRunResult,
  type UnscoredReason,
} from "./types";

const FAMILY_SET: ReadonlySet<Family> = new Set(["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
const ARM_SET: ReadonlySet<ParityArm> = new Set(["rune", "claude-code", "opencode", "codex"]);
const MODE_SET: ReadonlySet<ParityMode> = new Set(["product", "harness"]);
const UNSCORED_SET: ReadonlySet<UnscoredReason> = new Set([
  "provider_outage",
  "provider_quota",
  "provider_auth",
  "crash_before_first_call",
  "grader_infrastructure",
  "source_changed",
]);

/** Everything wrong with the inputs, collected, so one run shows all of it. */
export class ParityInputError extends Error {
  constructor(readonly problems: string[]) {
    super(`parity inputs refused:\n  ${problems.join("\n  ")}`);
    this.name = "ParityInputError";
  }
}

// ── One row ──

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** What is wrong with one parsed line, against `ParityRunResult`. Empty = valid. */
export function validateRow(v: unknown): string[] {
  if (!isObj(v)) return ["not a JSON object"];
  const p: string[] = [];
  if (v.schema !== SCHEMA) p.push(`schema is ${JSON.stringify(v.schema)}, expected "${SCHEMA}"`);
  if (!isNonEmptyStr(v.task)) p.push("task must be a non-empty string");
  if (!FAMILY_SET.has(v.family as Family)) p.push(`family ${JSON.stringify(v.family)} unknown`);
  if (!isNonNegInt(v.run)) p.push("run must be a non-negative integer");
  if (!ARM_SET.has(v.arm as ParityArm)) p.push(`arm ${JSON.stringify(v.arm)} unknown`);
  if (!MODE_SET.has(v.mode as ParityMode)) p.push(`mode ${JSON.stringify(v.mode)} unknown`);
  if (!isStr(v.model)) p.push("model must be a string");
  if (v.provider !== undefined && !isStr(v.provider)) p.push("provider must be a string");
  if (!isNonEmptyStr(v.version)) p.push("version missing: a row without it is not evidence");
  if (
    v.binarySha256 !== undefined &&
    !(isStr(v.binarySha256) && /^[0-9a-f]{64}$/.test(v.binarySha256))
  )
    p.push("binarySha256 must be 64 lowercase hex characters");

  if (typeof v.scored !== "boolean") p.push("scored must be a boolean");
  else if (v.scored === false && !UNSCORED_SET.has(v.unscoredReason as UnscoredReason))
    p.push(`an unscored row needs a known unscoredReason, got ${JSON.stringify(v.unscoredReason)}`);
  else if (v.scored === true && v.unscoredReason !== undefined)
    p.push("a scored row carries an unscoredReason");

  const o = v.outcome;
  if (!isObj(o)) p.push("outcome must be an object");
  else {
    if (!isNonNegInt(o.hiddenPassed)) p.push("outcome.hiddenPassed must be a non-negative integer");
    if (!isNonNegInt(o.hiddenTotal)) p.push("outcome.hiddenTotal must be a non-negative integer");
    if (isNonNegInt(o.hiddenPassed) && isNonNegInt(o.hiddenTotal) && o.hiddenPassed > o.hiddenTotal)
      p.push("outcome.hiddenPassed exceeds outcome.hiddenTotal");
    if (!isNonNegInt(o.regressionsIntroduced))
      p.push("outcome.regressionsIntroduced must be a non-negative integer");
    if (typeof o.buildBroken !== "boolean") p.push("outcome.buildBroken must be a boolean");
    if (!isStrArray(o.impossible)) p.push("outcome.impossible must be a string array");
  }

  if (typeof v.clean !== "boolean") p.push("clean must be a boolean");
  if (typeof v.falseCompletion !== "boolean") p.push("falseCompletion must be a boolean");
  if (v.scope !== 0 && v.scope !== 0.5 && v.scope !== 1) p.push("scope must be 0, 0.5 or 1");
  if (v.scopeNotes !== undefined && !isStrArray(v.scopeNotes))
    p.push("scopeNotes must be a string array");

  if (!isFiniteNum(v.wallMs) || v.wallMs < 0) p.push("wallMs must be a finite number ≥ 0");
  else if (v.scored === true && v.wallMs === 0) p.push("a scored row has wallMs 0");
  if (v.calls !== null && !isNonNegInt(v.calls))
    p.push("calls must be null or a non-negative integer");
  if (v.listUsd !== null && !(isFiniteNum(v.listUsd) && v.listUsd >= 0))
    p.push("listUsd must be null or a finite number ≥ 0");
  if (v.quotaPct !== undefined && v.quotaPct !== null && !isFiniteNum(v.quotaPct))
    p.push("quotaPct must be null or a finite number");
  if (v.exitCode !== null && !Number.isInteger(v.exitCode))
    p.push("exitCode must be null or an integer");
  if (v.stopped !== undefined && !isStr(v.stopped)) p.push("stopped must be a string");
  if (!isNonEmptyStr(v.startedAt)) p.push("startedAt must be a non-empty string");
  if (!isNonEmptyStr(v.completedAt)) p.push("completedAt must be a non-empty string");
  if (!isStr(v.evidence)) p.push("evidence must be a string");
  return p;
}

/** Parse one results.jsonl body. Blank lines are skipped; every bad line is named. */
export function parseResults(
  text: string,
  source: string,
): { rows: ParityRunResult[]; problems: string[] } {
  const rows: ParityRunResult[] = [];
  const problems: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    const where = `${source}:${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      problems.push(`${where}: not JSON (${(e as Error).message})`);
      continue;
    }
    const bad = validateRow(value);
    if (bad.length > 0) problems.push(...bad.map((b) => `${where}: ${b}`));
    else rows.push(value as ParityRunResult);
  }
  return { rows, problems };
}

export interface ResultsInput {
  path: string;
  sha256: string;
  rows: number;
}

/** Read, hash and validate results files. Throws ParityInputError on any problem. */
export function loadResults(paths: readonly string[]): {
  inputs: ResultsInput[];
  rows: ParityRunResult[];
} {
  const inputs: ResultsInput[] = [];
  const rows: ParityRunResult[] = [];
  const problems: string[] = [];
  if (paths.length === 0) problems.push("no results files given");
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      problems.push(`${path}: cannot read (${(e as Error).message})`);
      continue;
    }
    const parsed = parseResults(bytes.toString("utf8"), path);
    problems.push(...parsed.problems);
    rows.push(...parsed.rows);
    inputs.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rows: parsed.rows.length,
    });
  }
  problems.push(...consistencyProblems(rows));
  if (problems.length > 0) throw new ParityInputError(problems);
  return { inputs, rows };
}

// ── Across rows ──

const rowKey = (r: ParityRunResult) => `${r.mode}|${r.arm}|${r.task}|${r.run}`;

/**
 * Two rows for the same (mode, arm, task, run), or one task filed under two
 * families: either makes the pairing ambiguous, so both are errors.
 */
export function consistencyProblems(rows: readonly ParityRunResult[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(rowKey(r), (seen.get(rowKey(r)) ?? 0) + 1);
  for (const [k, n] of seen) {
    if (n > 1) {
      const [mode, arm, task, run] = k.split("|");
      problems.push(
        `${n} rows for ${arm} on ${task} run ${run} (${mode}); a pair needs exactly one`,
      );
    }
  }
  const families = new Map<string, Set<Family>>();
  for (const r of rows) {
    const set = families.get(r.task) ?? new Set<Family>();
    set.add(r.family);
    families.set(r.task, set);
  }
  for (const [task, set] of families) {
    if (set.size > 1) problems.push(`task ${task} is filed under ${[...set].sort().join(" and ")}`);
  }
  return problems;
}

export interface Pairing {
  pairs: RawPair[];
  /** `task#run` of rows with no partner, by side. */
  unpaired: { rune: string[]; comparator: string[] };
  /** How many partnerless rows each family has — each one caps it at PROVISIONAL. */
  unpairedByFamily: Partial<Record<Family, number>>;
  /** Rows from arms that are neither Rune nor this comparator. */
  otherArmRows: number;
}

/** Pair Rune's rows with the comparator's for one mode, on (task, run). */
export function pairRows(
  rows: readonly ParityRunResult[],
  mode: ParityMode,
  comparator: Comparator,
): Pairing {
  const inMode = rows.filter((r) => r.mode === mode);
  const rune = new Map<string, ParityRunResult>();
  const comp = new Map<string, ParityRunResult>();
  let otherArmRows = 0;
  for (const r of inMode) {
    const key = `${r.task}#${r.run}`;
    if (r.arm === "rune") rune.set(key, r);
    else if (r.arm === comparator) comp.set(key, r);
    else otherArmRows++;
  }
  const pairs: RawPair[] = [];
  const unpaired = { rune: [] as string[], comparator: [] as string[] };
  const unpairedByFamily: Partial<Record<Family, number>> = {};
  const count = (r: ParityRunResult) =>
    void (unpairedByFamily[r.family] = (unpairedByFamily[r.family] ?? 0) + 1);
  for (const [key, r] of rune) {
    const c = comp.get(key);
    if (!c) {
      unpaired.rune.push(key);
      count(r);
      continue;
    }
    pairs.push({ task: r.task, family: r.family, run: r.run, mode, rune: r, comparator: c });
  }
  for (const [key, c] of comp)
    if (!rune.has(key)) {
      unpaired.comparator.push(key);
      count(c);
    }
  pairs.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : a.run - b.run));
  unpaired.rune.sort();
  unpaired.comparator.sort();
  return { pairs, unpaired, unpairedByFamily, otherArmRows };
}

// ── Versions ──

export interface VersionSeen {
  version: string;
  binarySha256: string | null;
  models: string[];
  rows: number;
}

export type VersionsByMode = Record<ParityMode, Partial<Record<ParityArm, VersionSeen[]>>>;

/** Every (version, binary) each arm ran as, per mode, with the models it ran on. */
export function versionsSeen(rows: readonly ParityRunResult[]): VersionsByMode {
  const out: VersionsByMode = { product: {}, harness: {} };
  const index = new Map<string, VersionSeen>();
  for (const r of rows) {
    const sha = r.binarySha256 ?? null;
    const key = `${r.mode}|${r.arm}|${r.version}|${sha ?? ""}`;
    let seen = index.get(key);
    if (!seen) {
      seen = { version: r.version, binarySha256: sha, models: [], rows: 0 };
      index.set(key, seen);
      (out[r.mode][r.arm] ??= []).push(seen);
    }
    seen.rows++;
    if (!seen.models.includes(r.model)) seen.models.push(r.model);
  }
  for (const mode of Object.values(out)) {
    for (const list of Object.values(mode)) {
      list!.sort((a, b) =>
        a.version === b.version
          ? (a.binarySha256 ?? "").localeCompare(b.binarySha256 ?? "")
          : a.version.localeCompare(b.version),
      );
      for (const v of list!) v.models.sort();
    }
  }
  return out;
}

/**
 * One Rune per mode. Two different `binarySha256` values — or two different
 * `--version` strings — among Rune's rows in one mode mean two builds were
 * measured as one, and the index would average them without saying so.
 */
export function mixedRuneProblems(rows: readonly ParityRunResult[]): string[] {
  const problems: string[] = [];
  for (const mode of ["product", "harness"] as const) {
    const rune = rows.filter((r) => r.mode === mode && r.arm === "rune");
    const shas = [...new Set(rune.map((r) => r.binarySha256).filter(isStr))].sort();
    const versions = [...new Set(rune.map((r) => r.version))].sort();
    if (shas.length > 1)
      problems.push(
        `${mode} mode mixes ${shas.length} Rune binaries (${shas.map((s) => s.slice(0, 12)).join(", ")})`,
      );
    if (versions.length > 1)
      problems.push(`${mode} mode mixes ${versions.length} Rune versions (${versions.join(", ")})`);
  }
  return problems;
}
