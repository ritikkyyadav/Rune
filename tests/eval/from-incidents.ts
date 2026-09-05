#!/usr/bin/env bun
/**
 * Incident → eval flywheel: turn the black box's recurring failure classes into
 * regression evals.
 *
 * Every class that keeps firing is a reliability defect the scripted suite does
 * not cover. Before this the pipeline was built and empty: `covered.json` was
 * `{}`, `tasks-from-incidents.ts` exported `[]`, and nothing failed when a class
 * crossed the threshold — so the input side of the flywheel existed and never
 * turned.
 *
 * Three moving parts, and the split matters:
 *
 *   · MINING reads `~/.rune/blackbox.db` on a real machine. Read-only, always.
 *   · A SNAPSHOT (`from-incidents/classes.json`) is what gets committed. CI has
 *     no black box, so the gate has to run against a recorded set of counts
 *     rather than a live database — and writing that snapshot is a human act
 *     from a machine that has been used, not something the loop does for itself.
 *   · The CHECK (`--check`) compares the snapshot against `covered.json` and
 *     fails when an eval-able class over the threshold has no task. That is the
 *     CI gate, and it is deterministic on a runner with nothing in ~/.rune.
 *
 * Usage:
 *   bun run tests/eval/from-incidents.ts                 # report top recurring classes
 *   bun run tests/eval/from-incidents.ts --snapshot      # record counts for CI (human act)
 *   bun run tests/eval/from-incidents.ts --check         # CI gate; no database needed
 *   bun run tests/eval/from-incidents.ts --scaffold      # write task stubs for uncovered ones
 *   bun run tests/eval/from-incidents.ts --db <path> --min-count 3 --since-days 30
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { BlackboxStore } from "@rune/telemetry";

const SCAFFOLD_DIR = join(__dirname, "from-incidents");
const COVERED_PATH = join(SCAFFOLD_DIR, "covered.json");
const CLASSES_PATH = join(SCAFFOLD_DIR, "classes.json");

/**
 * The classes a deterministic eval can reproduce AND that represent a defect in
 * the harness rather than in the world.
 *
 * The distinction is the whole filter. `provider.rate_limit` has fired 446
 * times on this machine and is not a bug: it is a quota, and an eval that
 * "covered" it would be testing OpenAI's billing. `loop.user_abort` is a person
 * pressing Ctrl-C. `tool.sandbox_denial` is the sandbox working.
 * `provider.fallback_triggered` is the fallback working. What belongs here is
 * the set where the harness's own RECOVERY is the thing under test.
 */
export const FLYWHEEL_CLASSES: ReadonlySet<string> = new Set([
  "crash.uncaught_exception",
  "crash.unhandled_rejection",
  "crash.dirty_exit",
  "crash.store_corruption",
  "provider.stream_error",
  "provider.malformed_tool_json_fatal",
  "provider.empty_completion",
  "context.budget_overflow",
  "loop.consecutive_errors",
  "tool.mcp_error",
]);

/** Occurrences before a class demands a regression eval. */
export const DEFAULT_MIN_COUNT = 3;

interface CliArgs {
  db: string;
  minCount: number;
  sinceDays: number | undefined;
  scaffold: boolean;
  snapshot: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    db: join(homedir(), ".rune", "blackbox.db"),
    minCount: DEFAULT_MIN_COUNT,
    sinceDays: 30,
    scaffold: false,
    snapshot: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a.startsWith("--db=")) args.db = a.slice("--db=".length);
    else if (a === "--min-count") args.minCount = Number(argv[++i]);
    else if (a.startsWith("--min-count=")) args.minCount = Number(a.slice("--min-count=".length));
    else if (a === "--since-days") args.sinceDays = Number(argv[++i]);
    else if (a.startsWith("--since-days="))
      args.sinceDays = Number(a.slice("--since-days=".length));
    else if (a === "--all-time") args.sinceDays = undefined;
    else if (a === "--scaffold") args.scaffold = true;
    else if (a === "--snapshot") args.snapshot = true;
    else if (a === "--check") args.check = true;
  }
  return args;
}

/**
 * Class → the eval task that covers it. Keyed by CLASS, not by fingerprint: a
 * fingerprint is one stack trace, and what an eval reproduces is the shape.
 * Legacy fingerprint keys are still read so an old file keeps working.
 */
export interface CoveredFile {
  /**
   * Classes acknowledged as un-reproducible, with a reason and a date.
   *
   * A waiver is NOT coverage and does not pretend to be: it is a person saying
   * "this class is real, the suite cannot reproduce it, and here is why". The
   * gate exists to stop a recurring failure being forgotten, and a silent
   * exclusion list would defeat it — so waivers are printed loudly on every
   * run, counted separately, and each one has to carry a reason.
   */
  waivers?: Record<string, { reason: string; at: string }>;
  [classOrFingerprint: string]: string | Record<string, { reason: string; at: string }> | undefined;
}

/** The task covering a class, if any. Ignores the `waivers` key. */
export function taskFor(covered: CoveredFile, cls: string): string | null {
  const v = covered[cls];
  return typeof v === "string" ? v : null;
}

/**
 * A committed count per class, from a machine that has actually been used. This
 * is what CI reads; it never touches a database.
 */
export interface ClassSnapshot {
  recordedAt: string;
  /** Days of history the counts cover, or null for all time. */
  windowDays: number | null;
  counts: Record<string, number>;
}

export async function loadCovered(path = COVERED_PATH): Promise<CoveredFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CoveredFile;
  } catch {
    return {};
  }
}

export async function loadSnapshot(path = CLASSES_PATH): Promise<ClassSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ClassSnapshot;
    return parsed && typeof parsed.counts === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which eval-able classes cross the threshold with nothing covering them. Pure,
 * so the CI gate and the report agree and the unit test can drive it directly.
 */
export function uncoveredClasses(
  counts: Record<string, number>,
  covered: CoveredFile,
  minCount = DEFAULT_MIN_COUNT,
): Array<{ class: string; count: number }> {
  const waivers = covered.waivers ?? {};
  return Object.entries(counts)
    .filter(
      ([cls, n]) =>
        FLYWHEEL_CLASSES.has(cls) && n >= minCount && !taskFor(covered, cls) && !waivers[cls],
    )
    .map(([cls, n]) => ({ class: cls, count: n }))
    .sort((a, b) => b.count - a.count);
}

/** A fingerprint is hex; the first 12 chars are unique enough for a filename. */
const short = (fp: string) => fp.slice(0, 12);

function scaffoldSource(fp: {
  fingerprint: string;
  class: string;
  component: string;
  messageSample: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}): string {
  // Bake the incident's identity into the stub so the finished eval stays
  // traceable back to the failure it reproduces.
  return `/**
 * Regression eval scaffold — generated by from-incidents.ts. FINISH ME.
 *
 * Incident class:   ${fp.class}
 * Component:        ${fp.component}
 * Fired:            ${fp.count}× (${fp.firstSeen} → ${fp.lastSeen})
 * Fingerprint:      ${fp.fingerprint}
 * Message sample:   ${fp.messageSample.replace(/\*\//g, "*\\/").slice(0, 200)}
 *
 * To finish:
 *  1. Write setup() building the smallest workspace that reproduces the shape.
 *  2. Script the tool sequence that used to trigger the failure. The mock
 *     provider can now fail a stream part way (\`streamError\`) and emit broken
 *     tool arguments (\`rawToolArgs\`), which covers most provider-side shapes.
 *  3. verify() must check ARTIFACTS (files, session rows, exit codes) — never
 *     model prose — and it must assert RECOVERY, not the absence of the
 *     failure: a stream will always sometimes die.
 *  4. Export the task from tasks-from-incidents.ts and add
 *     "${fp.class}": "<task name>" to from-incidents/covered.json.
 */
import type { EvalTask } from "../harness";

export const TASK: EvalTask = {
  name: "incident_${short(fp.fingerprint)}",
  category: "core",
  description: ${JSON.stringify(`Reproduces incident class ${fp.class} (${fp.component})`)},
  setup: async ({ workspace: _workspace }) => {
    throw new Error("scaffold not finished — see header comment");
  },
  script: [],
  prompts: ["TODO"],
  verify: async () => ({ pass: false, reason: "scaffold not finished" }),
};
`;
}

/** The CI gate: snapshot + covered.json, no database. */
async function runCheck(minCount: number): Promise<number> {
  const snapshot = await loadSnapshot();
  const covered = await loadCovered();
  console.log(`\n  \x1b[1mIncident coverage check\x1b[0m\n`);
  if (!snapshot) {
    console.log(
      `  No class snapshot at ${CLASSES_PATH}. Record one from a machine that has been used:\n` +
        `    \x1b[2mbun run tests/eval/from-incidents.ts --snapshot\x1b[0m\n`,
    );
    // Not a failure: a fresh checkout has nothing to check against, and failing
    // here would mean CI could never go green on a new clone.
    return 0;
  }
  const uncovered = uncoveredClasses(snapshot.counts, covered, minCount);
  const evalable = Object.entries(snapshot.counts).filter(([c]) => FLYWHEEL_CLASSES.has(c));
  console.log(
    `  \x1b[2msnapshot ${snapshot.recordedAt.slice(0, 10)} · ${evalable.length} eval-able class(es) · threshold ${minCount}\x1b[0m\n`,
  );
  const waivers = covered.waivers ?? {};
  for (const [cls, n] of evalable.sort((a, b) => b[1] - a[1])) {
    const task = taskFor(covered, cls);
    const mark = task
      ? `\x1b[32m${task}\x1b[0m`
      : waivers[cls]
        ? `\x1b[33mWAIVED\x1b[0m`
        : n >= minCount
          ? "\x1b[31mTODO\x1b[0m"
          : "\x1b[2m—\x1b[0m";
    console.log(`  ${String(n).padEnd(7)}${cls.padEnd(40)}${mark}`);
  }
  const waived = Object.entries(waivers).filter(([c]) => (snapshot.counts[c] ?? 0) >= minCount);
  if (waived.length > 0) {
    // Printed every time, on purpose. An exclusion list nobody reads is how a
    // gate stops being a gate.
    console.log(
      `\n  \x1b[33m${waived.length} waived class(es)\x1b[0m — real, not reproducible here:`,
    );
    for (const [cls, w] of waived) {
      console.log(`    · ${cls} \x1b[2m(${w.at})\x1b[0m\n      ${w.reason}`);
    }
  }
  console.log();
  if (uncovered.length === 0) {
    console.log("  Every recurring failure class the suite can reproduce has an eval.\n");
    return 0;
  }
  console.log(
    `  \x1b[31m${uncovered.length} class(es) over the threshold with no regression eval:\x1b[0m`,
  );
  for (const u of uncovered) console.log(`    · ${u.class} (${u.count}×)`);
  console.log(
    `\n  Write one in tests/eval/tasks-from-incidents.ts and record it in\n` +
      `  from-incidents/covered.json. A failure that keeps happening and is not\n` +
      `  in the suite will keep happening.\n`,
  );
  return 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    process.exit(await runCheck(args.minCount));
  }

  if (!existsSync(args.db)) {
    console.log(`\n  No black box at ${args.db} — nothing to mine yet.`);
    console.log(`  (Pass --db <path> to read a different incident store.)\n`);
    return;
  }

  // READ-ONLY, always: this is the user's record of everything that has gone
  // wrong, and the flywheel's job is to read it, never to tidy it.
  const store = new BlackboxStore(args.db);
  const top = store.top({ limit: 200, sinceDays: args.sinceDays });
  const covered = await loadCovered();

  const counts: Record<string, number> = {};
  for (const f of top) counts[f.class] = (counts[f.class] ?? 0) + f.count;

  const recurring = top.filter((f) => f.count >= args.minCount);
  const uncovered = uncoveredClasses(counts, covered, args.minCount);

  const window = args.sinceDays !== undefined ? `last ${args.sinceDays} days` : "all time";
  console.log(
    `\n  \x1b[1mIncident → eval pipeline\x1b[0m \x1b[2m(${window}, min count ${args.minCount})\x1b[0m\n`,
  );

  if (recurring.length === 0) {
    console.log("  No incident class fired often enough to demand an eval. Good.\n");
    return;
  }

  const header = "  Count".padEnd(9) + "Class".padEnd(36) + "Eval-able".padEnd(12) + "Covered by";
  console.log(`\x1b[2m${header}\x1b[0m`);
  console.log(`\x1b[2m${"─".repeat(90)}\x1b[0m`);
  const waiverMap = covered.waivers ?? {};
  for (const [cls, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const evalable = FLYWHEEL_CLASSES.has(cls);
    const task = taskFor(covered, cls);
    const cov = task
      ? `\x1b[32m${task}\x1b[0m`
      : waiverMap[cls]
        ? "\x1b[33mWAIVED\x1b[0m"
        : evalable && n >= args.minCount
          ? "\x1b[31mTODO\x1b[0m"
          : "\x1b[2m—\x1b[0m";
    console.log(
      `  ${String(n).padEnd(7)}${cls.slice(0, 34).padEnd(36)}${(evalable ? "yes" : "no").padEnd(12)}${cov}`,
    );
  }
  console.log(
    `\n  \x1b[2m"Eval-able" is the filter that matters: a rate limit is a quota, not a` +
      ` defect,\n  and an eval that covered it would be testing someone else's billing.\x1b[0m\n`,
  );

  if (args.snapshot) {
    await mkdir(SCAFFOLD_DIR, { recursive: true });
    const snapshot: ClassSnapshot = {
      recordedAt: new Date().toISOString(),
      windowDays: args.sinceDays ?? null,
      counts,
    };
    await writeFile(CLASSES_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`  Snapshot written to ${CLASSES_PATH} — commit it; CI checks against it.\n`);
    return;
  }

  if (!args.scaffold) {
    if (uncovered.length > 0) {
      console.log(
        `  ${uncovered.length} eval-able class(es) uncovered — run with \x1b[1m--scaffold\x1b[0m to generate task stubs.\n`,
      );
    }
    return;
  }

  await mkdir(SCAFFOLD_DIR, { recursive: true });
  const uncoveredClassSet = new Set(uncovered.map((u) => u.class));
  let written = 0;
  for (const f of recurring) {
    if (!uncoveredClassSet.has(f.class)) continue;
    const path = join(SCAFFOLD_DIR, `${short(f.fingerprint)}.task.ts`);
    if (existsSync(path)) continue; // never clobber an in-progress stub
    await writeFile(path, scaffoldSource(f));
    console.log(`  scaffolded ${path}`);
    written++;
    uncoveredClassSet.delete(f.class); // one stub per class, not per fingerprint
  }
  if (!existsSync(COVERED_PATH)) {
    await writeFile(COVERED_PATH, "{}\n");
  }
  console.log(
    written > 0
      ? `\n  ${written} stub(s) written. Finish them, promote into tasks-from-incidents.ts, and record the CLASS in covered.json.\n`
      : "\n  Nothing new to scaffold (every uncovered class already has a stub in progress).\n",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(2);
  });
}
