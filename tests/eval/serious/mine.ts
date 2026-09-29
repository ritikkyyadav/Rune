/**
 * The serious-task miner: real fixes from this repo's history, SWE-bench style.
 *
 *   bun tests/eval/serious/mine.ts candidates
 *   bun tests/eval/serious/mine.ts validate [--jobs 3] [--only sha,sha] [--out DIR] [--force]
 *   bun tests/eval/serious/mine.ts dossier --out FILE [--mined DIR] [--only sha,sha]
 *   bun tests/eval/serious/mine.ts write-tasks --prompts FILE [--mined DIR]
 *   bun tests/eval/serious/mine.ts check
 *
 * A candidate is a non-merge commit reachable from HEAD since 2026-06-01 that
 * changes at least one `packages/<pkg>/src/**` file AND adds or changes at least
 * one `tests/(unit|integration)/**\/*.test.ts` file. Some candidates are skipped
 * without being run: commits whose `bun.lock` differs from their parent's (the
 * arm could not install the fix's dependencies), commits touching more than six
 * `src` files, and `release:` / `docs:` commits. `validate` runs f2p.ts on the
 * rest, at most three at a time. `dossier` prints what a prompt writer needs
 * for each kept candidate. `write-tasks` joins hand-written prompts with the
 * mining results into `tasks/<sha>.json`. `check` validates every task file,
 * including the leak check (leak.ts), and exits non-zero on any problem.
 *
 * Nothing here calls a model.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateCandidate, type ValidationResult } from "./f2p";
import { interfaceProblems, newNames, revisionText, taskLeaks } from "./leak";
import {
  loadSpecs,
  repoRootOf,
  specProblems,
  TASKS_DIR,
  type SeriousTaskSpec,
  type Shape,
} from "./source";

export const SINCE = "2026-06-01";
export const MAX_SRC_FILES = 6;
export const MAX_JOBS = 3;

export const SRC_FILE = /^packages\/[^/]+\/src\//;
export const TEST_FILE = /^tests\/(?:unit|integration)\/.+\.test\.ts$/;
/** What is copied from the fix commit at grading time: its tests and what they lean on. */
export const HIDDEN_FILE = /^tests\/(?:unit|integration|helpers|fixtures)\//;
export const FIX_FILE = /^packages\//;
const LOCKFILE = /^bun\.lockb?$/;
const RELEASE_OR_DOCS = /^(?:release|docs)(?:\([^)]*\))?!?:/i;

export interface NameStatus {
  status: string;
  path: string;
}

/** `--name-status --no-renames` lines (`M<TAB>path`) → entries; other lines are ignored. */
export function parseNameStatus(text: string): NameStatus[] {
  return text
    .split("\n")
    .filter((line) => /^[A-Z]\t/.test(line))
    .map((line) => ({ status: line[0]!, path: line.slice(2) }));
}

export interface LoggedCommit {
  sha: string;
  parent: string;
  date: string;
  subject: string;
}

/**
 * One `git log --format=%x1e%H%x1f%P%x1f%cI%x1f%s --name-status` → each commit
 * with its changes against its first parent (the only one: merges are not
 * logged). Commits without a parent are dropped.
 */
export function parseLog(text: string): { commit: LoggedCommit; changes: NameStatus[] }[] {
  const out: { commit: LoggedCommit; changes: NameStatus[] }[] = [];
  for (const chunk of text.split("\x1e")) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf("\n");
    const header = newline < 0 ? chunk : chunk.slice(0, newline);
    const [sha, parents, date, subject] = header.split("\x1f");
    const parent = parents?.split(" ")[0];
    if (!sha || !parent) continue;
    out.push({
      commit: { sha, parent, date: date ?? "", subject: subject ?? "" },
      changes: parseNameStatus(newline < 0 ? "" : chunk.slice(newline + 1)),
    });
  }
  return out;
}

export interface Candidate {
  sha: string;
  parent: string;
  date: string;
  subject: string;
  /** `packages/*\/src/**` paths the commit touched (any status). */
  srcFiles: string[];
  /** Every `packages/**` path the commit touched: the reference fix. */
  fixFiles: string[];
  /** Added or modified files under tests/(unit|integration|helpers|fixtures). */
  hiddenFiles: string[];
  /** The `.test.ts` files among them. */
  testFiles: string[];
  /** The workspace packages owning `srcFiles`. */
  packages: string[];
  lockChanged: boolean;
}

export function toCandidate(commit: LoggedCommit, changes: NameStatus[]): Candidate {
  const added = (entry: NameStatus) => entry.status === "A" || entry.status === "M";
  const srcFiles = changes.filter((c) => SRC_FILE.test(c.path)).map((c) => c.path);
  const hiddenFiles = changes
    .filter((c) => added(c) && HIDDEN_FILE.test(c.path))
    .map((c) => c.path);
  return {
    ...commit,
    srcFiles,
    fixFiles: changes.filter((c) => FIX_FILE.test(c.path)).map((c) => c.path),
    hiddenFiles,
    testFiles: hiddenFiles.filter((path) => TEST_FILE.test(path)),
    packages: [...new Set(srcFiles.map((path) => path.split("/")[1]!))].sort(),
    lockChanged: changes.some((c) => LOCKFILE.test(c.path)),
  };
}

/** A candidate: touches a package's src and adds or changes a unit or integration test. */
export function isCandidate(candidate: Candidate): boolean {
  return candidate.srcFiles.length > 0 && candidate.testFiles.length > 0;
}

export type SkipReason = "lockfile-changed" | "too-many-src-files" | "release-or-docs";

/** Why a candidate is not run at all, or null when it is. */
export function screen(candidate: Candidate): SkipReason | null {
  if (candidate.lockChanged) return "lockfile-changed";
  if (candidate.srcFiles.length > MAX_SRC_FILES) return "too-many-src-files";
  if (RELEASE_OR_DOCS.test(candidate.subject)) return "release-or-docs";
  return null;
}

function git(repoRoot: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${(run.stderr || "").trim()}`);
  return run.stdout;
}

export interface Listing {
  commits: number;
  candidates: Candidate[];
  skipped: { candidate: Candidate; reason: SkipReason }[];
  toValidate: Candidate[];
}

/** Every candidate since SINCE, newest first, screened. */
export function listCandidates(repoRoot: string, since = SINCE): Listing {
  const commits = parseLog(
    git(repoRoot, [
      "-c",
      "core.quotePath=false",
      "log",
      "--no-merges",
      `--since=${since}`,
      "--format=%x1e%H%x1f%P%x1f%cI%x1f%s",
      "--name-status",
      "--no-renames",
      "HEAD",
    ]),
  );
  const listing: Listing = { commits: commits.length, candidates: [], skipped: [], toValidate: [] };
  for (const { commit, changes } of commits) {
    const candidate = toCandidate(commit, changes);
    if (!isCandidate(candidate)) continue;
    listing.candidates.push(candidate);
    const reason = screen(candidate);
    if (reason) listing.skipped.push({ candidate, reason });
    else listing.toValidate.push(candidate);
  }
  return listing;
}

function count<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

// ── CLI ──

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const DEFAULT_OUT = join(process.env.TMPDIR || tmpdir(), "serious-mining");

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

function readResults(dir: string): ValidationResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "result.json")))
    .map((name) => JSON.parse(readFileSync(join(dir, name, "result.json"), "utf8")));
}

function summarise(listing: Listing, results: ValidationResult[]) {
  const kept = results.filter((r) => r.keep);
  return {
    at: new Date().toISOString(),
    since: SINCE,
    commits: listing.commits,
    candidates: listing.candidates.length,
    skipped: count(listing.skipped.map((s) => s.reason)),
    validated: results.length,
    kept: kept.length,
    rejected: count(results.filter((r) => !r.keep).map((r) => r.reason ?? "error")),
    keptByPackage: count(kept.flatMap((r) => r.packages)),
    rows: [
      ...listing.skipped.map((s) => ({
        sha: s.candidate.sha.slice(0, 7),
        subject: s.candidate.subject,
        packages: s.candidate.packages,
        verdict: `skipped: ${s.reason}`,
      })),
      ...results.map((r) => ({
        sha: r.sha.slice(0, 7),
        subject: r.subject,
        packages: r.packages,
        verdict: r.keep ? "kept" : `rejected: ${r.reason}`,
        detail: r.keep
          ? `f2p ${r.classification?.f2p.length}, p2p ${r.classification?.p2p.length}, impossible ${r.classification?.impossible.length}, flaky ${r.classification?.flaky.length}`
          : r.detail?.slice(0, 200),
        wallMs: r.wallMs,
      })),
    ],
  };
}

async function validateCommand(repoRoot: string, args: string[]): Promise<void> {
  const out = flag(args, "--out") ?? DEFAULT_OUT;
  const jobs = Math.min(MAX_JOBS, Number(flag(args, "--jobs") ?? MAX_JOBS));
  const only = flag(args, "--only")?.split(",");
  const force = args.includes("--force");
  const listing = listCandidates(repoRoot);
  let queue = listing.toValidate;
  if (only) queue = queue.filter((c) => only.some((sha) => c.sha.startsWith(sha)));
  mkdirSync(out, { recursive: true });
  const todo = queue.filter(
    (c) => force || !existsSync(join(out, c.sha.slice(0, 12), "result.json")),
  );
  console.log(
    `${listing.commits} commits, ${listing.candidates.length} candidates, ${listing.skipped.length} skipped, ${queue.length} to validate (${todo.length} not yet done), ${jobs} at a time → ${out}`,
  );
  let done = 0;
  await pool(todo, jobs, async (candidate) => {
    const result = await validateCandidate(
      repoRoot,
      candidate,
      join(out, candidate.sha.slice(0, 12)),
    );
    done++;
    const verdict = result.keep
      ? `KEPT f2p=${result.classification?.f2p.length} p2p=${result.classification?.p2p.length} impossible=${result.classification?.impossible.length}`
      : `rejected ${result.reason}: ${result.detail?.slice(0, 120)}`;
    console.log(
      `[${done}/${todo.length}] ${candidate.sha.slice(0, 7)} ${candidate.packages.join(",")} ${Math.round(result.wallMs / 1000)}s ${verdict} — ${candidate.subject.slice(0, 70)}`,
    );
  });
  const doneShas = new Set(queue.map((c) => c.sha));
  const results = readResults(out).filter((r) => doneShas.has(r.sha));
  const summary = summarise(listing, results);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
}

function dossierCommand(repoRoot: string, args: string[]): void {
  const mined = flag(args, "--mined") ?? DEFAULT_OUT;
  const outFile = flag(args, "--out");
  if (!outFile) throw new Error("dossier needs --out FILE");
  const only = flag(args, "--only")?.split(",");
  let kept = readResults(mined).filter((r) => r.keep);
  if (only) kept = kept.filter((r) => only.some((sha) => r.sha.startsWith(sha)));
  kept.sort((a, b) => a.date.localeCompare(b.date));
  const parts: string[] = [];
  for (const r of kept) {
    const c = r.classification!;
    const names = newNames(repoRoot, r);
    parts.push(
      [
        `${"=".repeat(100)}`,
        `### ${r.sha.slice(0, 7)} [${r.packages.join(", ")}] ${r.subject}`,
        `f2p ${c.f2p.length} | p2p ${c.p2p.length} | impossible ${c.impossible.length} | flaky ${c.flaky.length} | typecheck ${JSON.stringify(r.typecheck)}`,
        `src: ${r.srcFiles.join(", ")}`,
        `tests: ${r.testFiles.join(", ")}`,
        `new names the tests reference (interface candidates): ${names.referenced.join(", ") || "-"}`,
        `new names the tests do NOT reference (keep out of the prompt): ${names.hidden.join(", ") || "-"}`,
        "",
        "F2P:",
        ...c.f2p.map((k) => `  ${k}`),
        "IMPOSSIBLE:",
        ...c.impossible.map((k) => `  ${k}`),
        "",
        "--- commit message ---",
        git(repoRoot, ["log", "-1", "--format=%B", r.sha]).trim(),
        "",
        "--- src diff stat ---",
        git(repoRoot, ["diff", "--stat=100", r.parent, r.sha, "--", "packages/"]).trim(),
        "",
        "--- hidden test diff ---",
        git(repoRoot, ["diff", "--no-color", r.parent, r.sha, "--", ...r.hiddenFiles]).trim(),
        "",
      ].join("\n"),
    );
  }
  writeFileSync(outFile, parts.join("\n"));
  console.log(`dossier: ${kept.length} kept candidates → ${outFile}`);
}

/** The hand-written half of a task: everything the miner cannot know. */
export interface PromptEntry {
  slug: string;
  shape: Shape;
  prompt: string;
  interface?: string[];
}

export function specFrom(
  result: ValidationResult,
  entry: PromptEntry,
  minedAt: string = new Date().toISOString().slice(0, 10),
): SeriousTaskSpec {
  const c = result.classification!;
  const typecheck = result.typecheck ?? {};
  const spec: SeriousTaskSpec = {
    id: `f7-${result.sha.slice(0, 7)}-${entry.slug}`,
    sha: result.sha,
    parent: result.parent,
    subject: result.subject,
    packages: result.packages,
    shape: entry.shape,
    family: "F7",
    prompt: entry.prompt,
    ...(entry.interface?.length ? { interface: entry.interface } : {}),
    f2p: c.f2p,
    p2p: c.p2p,
    impossible: c.impossible,
    typecheckPackages: Object.keys(typecheck).sort(),
    typecheckBaseClean: Object.fromEntries(Object.entries(typecheck).map(([p, t]) => [p, t.base])),
    typecheckFixedClean: Object.fromEntries(
      Object.entries(typecheck).map(([p, t]) => [p, t.fixed]),
    ),
    timeLimit: "serious",
    hiddenFiles: result.hiddenFiles,
    testFiles: result.testFiles,
    fixFiles: result.fixFiles,
    ...(c.flaky.length ? { flaky: c.flaky } : {}),
    mined: {
      at: minedAt,
      bun: result.bun,
      baseWallMs: result.runs.filter((r) => r.label.startsWith("base")).map((r) => r.wallMs),
      fixedWallMs: result.runs.filter((r) => r.label.startsWith("fixed")).map((r) => r.wallMs),
    },
  };
  return spec;
}

function writeTasksCommand(args: string[]): void {
  const mined = flag(args, "--mined") ?? DEFAULT_OUT;
  const promptsFile = flag(args, "--prompts");
  if (!promptsFile) throw new Error("write-tasks needs --prompts FILE");
  const prompts = JSON.parse(readFileSync(promptsFile, "utf8")) as Record<string, PromptEntry>;
  const results = readResults(mined).filter((r) => r.keep);
  // The day the candidates were validated, which is what `mined.at` records —
  // not the day the prompts were joined to them.
  const summaryFile = join(mined, "summary.json");
  const minedAt = existsSync(summaryFile)
    ? String(JSON.parse(readFileSync(summaryFile, "utf8")).at ?? "").slice(0, 10) || undefined
    : undefined;
  mkdirSync(TASKS_DIR, { recursive: true });
  const written: string[] = [];
  for (const [sha, entry] of Object.entries(prompts)) {
    const result = results.find((r) => r.sha.startsWith(sha));
    if (!result) throw new Error(`no kept mining result for ${sha}`);
    const spec = specFrom(result, entry, minedAt);
    const file = join(TASKS_DIR, `${sha.slice(0, 7)}.json`);
    writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
    written.push(file);
  }
  // The task files are committed, and the repository's format gate is
  // `prettier --check .`, which lays short arrays out on one line.
  const formatted = spawnSync("bunx", ["prettier", "--write", ...written], { encoding: "utf8" });
  if (formatted.status !== 0)
    console.error(`prettier --write failed; run it on ${TASKS_DIR} before committing`);
  console.log(`wrote ${written.length} task files to ${TASKS_DIR}`);
}

function checkCommand(repoRoot: string): number {
  const specs = loadSpecs();
  let failures = 0;
  for (const spec of specs) {
    const problems = specProblems(spec);
    const leaks = taskLeaks(repoRoot, spec);
    const testText = revisionText(repoRoot, spec.sha, spec.hiddenFiles);
    problems.push(...interfaceProblems(spec.interface ?? [], spec.prompt, testText));
    for (const leak of leaks.leaks) problems.push(`leak: ${JSON.stringify(leak)}`);
    if (problems.length) failures++;
    console.log(
      `${problems.length ? "FAIL" : "ok  "} ${spec.id} (${spec.packages.join(", ")}, ${spec.shape}; f2p ${spec.f2p.length}, p2p ${spec.p2p.length}, impossible ${spec.impossible.length})${
        leaks.interfaceNames.length
          ? ` interface in prompt: ${leaks.interfaceNames.join(", ")}`
          : ""
      }`,
    );
    for (const problem of problems) console.log(`       ${problem}`);
  }
  console.log(`${specs.length} tasks, ${failures} failing`);
  return failures ? 1 : 0;
}

if (import.meta.main) {
  const [command = "candidates", ...args] = process.argv.slice(2);
  const repoRoot = repoRootOf();
  if (command === "candidates") {
    const listing = listCandidates(repoRoot);
    console.log(
      JSON.stringify(
        {
          commits: listing.commits,
          candidates: listing.candidates.length,
          skipped: count(listing.skipped.map((s) => s.reason)),
          toValidate: listing.toValidate.length,
          toValidateByPackage: count(listing.toValidate.flatMap((c) => c.packages)),
        },
        null,
        2,
      ),
    );
  } else if (command === "validate") await validateCommand(repoRoot, args);
  else if (command === "dossier") dossierCommand(repoRoot, args);
  else if (command === "write-tasks") writeTasksCommand(args);
  else if (command === "check") process.exit(checkCommand(repoRoot));
  else {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
}
