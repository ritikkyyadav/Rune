// ─── The Parity Index aggregator ───
//
// results.jsonl files in, validated rows and pairs out. Every row is checked
// against the frozen contract (types.ts) before anything is scored: a row the
// scorer cannot trust is an error that stops the report, never a row that
// quietly drops out of a denominator. Duplicates and a task filed under two
// families are errors too.
//
// And so is evidence that cannot be shown COMPARABLE (`comparabilityProblems`,
// `mixedBuildProblems`): one task run from two starting points or graded by two
// sets of checks, rows of two schemas, rows that say nothing of what graded
// them, one arm on two builds or two configurations in a mode. The first three
// are refused outright; each of the others has its own override, named in the
// refusal, and a report made under one says so and cannot PASS.
//
// The only impure function here is `loadResults`, which reads the files and
// hashes their bytes; the rest is pure.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Comparator, RawPair } from "./score";
import {
  READABLE_SCHEMAS,
  SCHEMA,
  TERMINALS,
  type Family,
  type ParityArm,
  type ParityMode,
  type ParityRunResult,
  type RowSchema,
  type Terminal,
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
const SCHEMA_SET: ReadonlySet<string> = new Set(READABLE_SCHEMAS);
const TERMINAL_SET: ReadonlySet<Terminal> = new Set(TERMINALS);
const isScope = (v: unknown): boolean => v === 0 || v === 0.5 || v === 1;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

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

/**
 * What a row written under the CURRENT schema owes beyond the old one: how its
 * run ended, and what the old rules said of it — and that the three flags it
 * carries do not contradict each other. A row that says it crashed and was
 * clean, or that it never claimed success and falsely completed, was not
 * written by `parityRow`, and is refused rather than averaged.
 */
function currentRowProblems(v: Record<string, unknown>): string[] {
  const p: string[] = [];
  const terminal = v.terminal as Terminal;
  if (!TERMINAL_SET.has(terminal)) {
    p.push(
      `terminal ${JSON.stringify(v.terminal)} unknown: a ${SCHEMA} row says how its run ended`,
    );
    return p;
  }
  const ended = terminal === "completed" || terminal === "incomplete";
  if (v.clean === true && !ended) p.push(`a run that ended ${terminal} cannot be clean`);
  if (v.falseCompletion === true && terminal !== "completed")
    p.push(`a false completion needs a success claim, and this run ended ${terminal}`);
  if (v.clean === true && v.falseCompletion === true) p.push("a false completion cannot be clean");
  if ((terminal === "refused" || terminal === "not_started") && v.scored === true)
    p.push(`a run that ended ${terminal} cannot be scored`);
  const legacy = v.legacy;
  if (!isObj(legacy) || typeof legacy.clean !== "boolean" || !isScope(legacy.scope))
    p.push(
      `legacy must be { clean: boolean, scope: 0 | 0.5 | 1 }: what parity-run/1 said of this run`,
    );
  if (!isStrArray(v.models))
    p.push("models must be a string array: every model the tool reported using, or [] for none");
  if (v.reasoningEffort !== undefined && !isStr(v.reasoningEffort))
    p.push("reasoningEffort must be a string");
  const prints = v.fingerprints;
  if (!isObj(prints)) {
    p.push(
      "fingerprints missing: a row that does not say what it was given or graded by is not evidence",
    );
    return p;
  }
  // Only a run whose tree could not be prepared has no task to fingerprint.
  if (!(isDigest(prints.task) || (prints.task === null && terminal === "not_started")))
    p.push("fingerprints.task must be a sha256, or null on a run that never started");
  if (!isDigest(prints.grader)) p.push("fingerprints.grader must be a sha256");
  if (!isDigest(prints.config)) p.push("fingerprints.config must be a sha256");
  return p;
}

/** What is wrong with one parsed line, against `ParityRunResult`. Empty = valid. */
export function validateRow(v: unknown): string[] {
  if (!isObj(v)) return ["not a JSON object"];
  const p: string[] = [];
  if (!SCHEMA_SET.has(v.schema as string))
    p.push(
      `schema is ${JSON.stringify(v.schema)}, expected ${READABLE_SCHEMAS.map((name) => `"${name}"`).join(" or ")}`,
    );
  if (!isNonEmptyStr(v.task)) p.push("task must be a non-empty string");
  if (!FAMILY_SET.has(v.family as Family)) p.push(`family ${JSON.stringify(v.family)} unknown`);
  if (!isNonNegInt(v.run)) p.push("run must be a non-negative integer");
  if (v.attempt !== undefined && !(Number.isInteger(v.attempt) && (v.attempt as number) >= 1))
    p.push("attempt must be a whole number of at least 1");
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
  if (v.sourceBuild !== undefined && !isDigest(v.sourceBuild))
    p.push("sourceBuild must be 64 lowercase hex characters");
  if (v.roster !== undefined && !(isStrArray(v.roster) && v.roster.length > 0))
    p.push("roster must be a non-empty string array: every model the arm's configuration names");

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
  if (!isScope(v.scope)) p.push("scope must be 0, 0.5 or 1");
  if (v.scopeNotes !== undefined && !isStrArray(v.scopeNotes))
    p.push("scopeNotes must be a string array");
  if (v.schema === SCHEMA) p.push(...currentRowProblems(v));

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
const attemptOf = (r: ParityRunResult) => r.attempt ?? 1;

/**
 * The row that counts for each (mode, arm, task, run): its latest attempt.
 * An earlier attempt — an unscored first try that was retried — is evidence:
 * it is never paired or scored, and it is still one of the arm's attempts.
 */
export function latestAttempts(rows: readonly ParityRunResult[]): {
  counted: ParityRunResult[];
  superseded: ParityRunResult[];
} {
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(rowKey(r), Math.max(latest.get(rowKey(r)) ?? 0, attemptOf(r)));
  const counted: ParityRunResult[] = [];
  const superseded: ParityRunResult[] = [];
  for (const r of rows) (attemptOf(r) === latest.get(rowKey(r)) ? counted : superseded).push(r);
  return { counted, superseded };
}

/**
 * Two rows for the same (mode, arm, task, run) AND the same attempt, or one
 * task filed under two families: either makes the pairing ambiguous, so both
 * are errors.
 */
export function consistencyProblems(rows: readonly ParityRunResult[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${rowKey(r)}|${attemptOf(r)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) {
      const [mode, arm, task, run, attempt] = k.split("|");
      problems.push(
        `${n} rows for ${arm} on ${task} run ${run}${attempt === "1" ? "" : `, attempt ${attempt}`} (${mode}); a pair needs exactly one`,
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
  /**
   * Every row each side wrote in this mode: partnerless ones included, and a
   * first attempt that was later retried too. They are the arm's attempts.
   */
  rows: { rune: ParityRunResult[]; comparator: ParityRunResult[] };
}

/** Pair Rune's rows with the comparator's for one mode, on (task, run). */
export function pairRows(
  rows: readonly ParityRunResult[],
  mode: ParityMode,
  comparator: Comparator,
): Pairing {
  const inMode = rows.filter((r) => r.mode === mode);
  const { counted, superseded } = latestAttempts(inMode);
  const rune = new Map<string, ParityRunResult>();
  const comp = new Map<string, ParityRunResult>();
  let otherArmRows = 0;
  for (const r of counted) {
    const key = `${r.task}#${r.run}`;
    if (r.arm === "rune") rune.set(key, r);
    else if (r.arm === comparator) comp.set(key, r);
    else otherArmRows++;
  }
  otherArmRows += superseded.filter((r) => r.arm !== "rune" && r.arm !== comparator).length;
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
  return {
    pairs,
    unpaired,
    unpairedByFamily,
    otherArmRows,
    rows: {
      rune: inMode.filter((r) => r.arm === "rune"),
      comparator: inMode.filter((r) => r.arm === comparator),
    },
  };
}

/** How many rows were written under each schema. */
export function schemasSeen(rows: readonly ParityRunResult[]): Partial<Record<RowSchema, number>> {
  const out: Partial<Record<RowSchema, number>> = {};
  for (const r of rows) out[r.schema] = (out[r.schema] ?? 0) + 1;
  return out;
}

// ── Versions ──

export interface VersionSeen {
  version: string;
  binarySha256: string | null;
  /** The source it was run from, where its rows name one (`sourceBuild`). */
  sourceBuild?: string;
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
    const source = r.sourceBuild;
    const key = `${r.mode}|${r.arm}|${r.version}|${sha ?? ""}|${source ?? ""}`;
    let seen = index.get(key);
    if (!seen) {
      seen = {
        version: r.version,
        binarySha256: sha,
        ...(source ? { sourceBuild: source } : {}),
        models: [],
        rows: 0,
      };
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
          ? `${a.binarySha256 ?? ""}|${a.sourceBuild ?? ""}`.localeCompare(
              `${b.binarySha256 ?? ""}|${b.sourceBuild ?? ""}`,
            )
          : a.version.localeCompare(b.version),
      );
      for (const v of list!) v.models.sort();
    }
  }
  return out;
}

const armLabel = (arm: ParityArm): string => (arm === "rune" ? "Rune" : arm);

/**
 * One build per arm per mode. Two different `binarySha256` values — or two
 * different `--version` strings — among one arm's rows in one mode mean two
 * builds were measured as one, and the index would average them without saying
 * so. Held for Rune AND for the comparator: a comparator that updated itself
 * half way through a series is two tools.
 *
 * A tool run from source has no one file to hash, and every build of a working
 * tree answers the same `--version`: its build is `sourceBuild`. Two of those
 * are two builds. So is a set in which some rows name one and some name none —
 * nothing shows the unnamed rows ran the source the others did.
 */
export function mixedBuildProblems(
  rows: readonly ParityRunResult[],
  comparator: Comparator,
): string[] {
  const problems: string[] = [];
  for (const mode of ["product", "harness"] as const)
    for (const arm of ["rune", comparator] as const) {
      const mine = rows.filter((r) => r.mode === mode && r.arm === arm);
      const shas = [...new Set(mine.map((r) => r.binarySha256).filter(isStr))].sort();
      const versions = [...new Set(mine.map((r) => r.version))].sort();
      if (shas.length > 1)
        problems.push(
          `${mode} mode mixes ${shas.length} ${armLabel(arm)} binaries (${shas.map((s) => s.slice(0, 12)).join(", ")})`,
        );
      if (versions.length > 1)
        problems.push(
          `${mode} mode mixes ${versions.length} ${armLabel(arm)} versions (${versions.join(", ")})`,
        );
      const sources = [...new Set(mine.map((r) => r.sourceBuild).filter(isStr))].sort();
      if (sources.length > 1)
        problems.push(
          `${mode} mode mixes ${sources.length} ${armLabel(arm)} source builds (${sources.map((s) => s.slice(0, 12)).join(", ")})`,
        );
      const unnamed = mine.filter((r) => !isStr(r.sourceBuild)).length;
      if (sources.length > 0 && unnamed > 0)
        problems.push(
          `${mode} mode has ${unnamed} ${armLabel(arm)} row(s) that name no source build beside ${mine.length - unnamed} that do: nothing shows they ran the same source`,
        );
    }
  return problems;
}

/** Why a set of rows cannot be scored as one comparison, by what can be done about it. */
export interface Comparability {
  /**
   * Refused, always: one task run from two starting points, one task graded by
   * two sets of checks, or rows of two schemas. No flag makes these one exam.
   */
  mismatched: string[];
  /** Rows that say nothing of what they were given or graded by (`parity-run/1`). */
  unfingerprinted: string[];
  /** One arm, one mode, more than one configuration or model roster. */
  mixedConfig: string[];
}

const short = (digest: string) => digest.slice(0, 12);
const counted = (values: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => `${value} × ${count}`)
    .join(", ");
};

/**
 * What stands between these rows and one comparison. Read from the two arms
 * being compared; a third arm's rows are not scored and are not held to it.
 */
export function comparabilityProblems(
  rows: readonly ParityRunResult[],
  comparator: Comparator,
): Comparability {
  const mine = rows.filter((r) => r.arm === "rune" || r.arm === comparator);
  const out: Comparability = { mismatched: [], unfingerprinted: [], mixedConfig: [] };

  const schemas = [...new Set(mine.map((r) => r.schema))].sort();
  if (schemas.length > 1)
    out.mismatched.push(
      `${schemas.join(" and ")} rows cannot be scored together: clean and scope mean different things in each`,
    );
  const bare = mine.filter((r) => !r.fingerprints);
  if (bare.length > 0)
    out.unfingerprinted.push(
      `${bare.length} row(s) carry no fingerprints (${counted(bare.map((r) => r.schema))}): nothing shows they were given the same task or graded by the same checks`,
    );

  const byTask = new Map<string, ParityRunResult[]>();
  for (const r of mine) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  for (const [task, list] of [...byTask].sort(([a], [b]) => a.localeCompare(b))) {
    const starts = [...new Set(list.map((r) => r.fingerprints?.task).filter(isStr))].sort();
    if (starts.length > 1)
      out.mismatched.push(
        `task ${task} was run from ${starts.length} different starting points (prompt, tree, uncommitted work or wall limit): ${starts.map(short).join(", ")}`,
      );
    const graders = [...new Set(list.map((r) => r.fingerprints?.grader).filter(isStr))].sort();
    if (graders.length > 1)
      out.mismatched.push(
        `task ${task} was graded by ${graders.length} different sets of checks: ${graders.map(short).join(", ")}`,
      );
  }

  for (const mode of ["product", "harness"] as const)
    for (const arm of ["rune", comparator] as const) {
      const list = mine.filter((r) => r.mode === mode && r.arm === arm);
      const settings = list.map(
        (r) =>
          `${r.model}${r.provider ? ` via ${r.provider}` : ""}${r.reasoningEffort ? `, effort ${r.reasoningEffort}` : ""}`,
      );
      if (new Set(settings).size > 1)
        out.mixedConfig.push(
          `${mode} mode mixes ${new Set(settings).size} ${armLabel(arm)} configurations: ${counted(settings)}`,
        );
      // What each run CALLED. Where every row states the roster its arm was
      // configured with, the calls are held to that: one roster on every row,
      // and no call outside it. A configured helper that one run needed and
      // another did not is then one configuration — which is what it is.
      if (list.length > 0 && list.every(statesRoster)) {
        const configured = list.map((r) => bracketed(r.roster!));
        if (new Set(configured).size > 1)
          out.mixedConfig.push(
            `${mode} mode mixes ${new Set(configured).size} ${armLabel(arm)} configured rosters: ${counted(configured)}`,
          );
        const outside = list.flatMap((r) =>
          [...new Set(r.models ?? [])].filter((model) => !r.roster!.includes(model)),
        );
        if (outside.length > 0)
          out.mixedConfig.push(
            `${mode} mode has ${armLabel(arm)} runs that called a model outside the configured roster: ${counted(outside)}`,
          );
        continue;
      }
      // Rows that state none — and a set in which only some do — are held to
      // the same models on every run. A tool that named no model on a run
      // (killed before its report, or one that never names any) says nothing
      // about which it used.
      const rosters = list
        .map((r) => r.models)
        .filter((models): models is string[] => Array.isArray(models) && models.length > 0)
        .map(bracketed);
      if (new Set(rosters).size > 1)
        out.mixedConfig.push(
          `${mode} mode mixes ${new Set(rosters).size} ${armLabel(arm)} model rosters: ${counted(rosters)}`,
        );
    }
  return out;
}

const statesRoster = (r: ParityRunResult): boolean =>
  Array.isArray(r.roster) && r.roster.length > 0;
const bracketed = (models: readonly string[]): string => `[${[...models].sort().join(", ")}]`;

/**
 * What each compared arm was configured to call and what it did call, where
 * its rows say: one line per arm and mode. The rule above lets a configured
 * helper come and go between runs; this is where that is still on the page.
 */
export function rosterLines(rows: readonly ParityRunResult[], comparator: Comparator): string[] {
  const lines: string[] = [];
  for (const mode of ["product", "harness"] as const)
    for (const arm of ["rune", comparator] as const) {
      const list = rows.filter((r) => r.mode === mode && r.arm === arm);
      if (list.length === 0 || !list.every(statesRoster)) continue;
      const configured = [...new Set(list.map((r) => bracketed(r.roster!)))].sort();
      const called = list.map((r) => bracketed(r.models ?? []));
      lines.push(
        `${mode} · ${armLabel(arm)} · configured ${configured.join(" and ")} · called ${counted(called)}`,
      );
    }
  return lines;
}
