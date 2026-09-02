#!/usr/bin/env bun
/**
 * External anchors: the yardstick nothing inside the loop may edit.
 *
 * Every other number in this phase is Gear measuring Gear. The variants
 * registry, the paired A/B, the lessons ladder — all of them compare this
 * system against itself on a suite this repository owns, and a suite you own is
 * a suite you can, over enough months, quietly shape to the thing you built.
 * The anchors exist so that drift has somewhere to show up.
 *
 * What this file IS: the runner scaffolding and two pinned subsets — 50
 * SWE-bench Verified instance ids and 20 Terminal-Bench task ids — plus the
 * arms (`--pristine` and evolved) and the report shape that `docs/benchmarks.md`
 * publishes.
 *
 * What this file is NOT, and deliberately: a downloader. It vendors no dataset,
 * fetches nothing, and starts no container. Both harnesses are large external
 * dependencies with their own execution models (SWE-bench needs per-repo Python
 * environments; Terminal-Bench needs Docker), and pretending to run them from
 * here would produce numbers that are not the benchmark's. `--plan` prints the
 * exact commands a person runs; `--record` ingests the results those commands
 * produce.
 *
 * The two arms are the point:
 *   · `pristine` — `gear --pristine`: no notebook, no playbook, no promoted
 *     config. What the harness scores with nothing learned.
 *   · `evolved`  — the machine as it stands, promotions and lessons included.
 * Publishing only the second is how a self-improving system convinces itself.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AnchorSet {
  benchmark: string;
  pinnedAt: string;
  source: string;
  note: string;
  selection: string;
  task_ids: string[];
}

export type AnchorArm = "pristine" | "evolved";

export interface AnchorResult {
  benchmark: string;
  arm: AnchorArm;
  /** ISO date the run happened. */
  at: string;
  model: string;
  provider: string;
  /** Tasks attempted — should equal the pinned subset's size. */
  attempted: number;
  resolved: number;
  /** Tasks that could not be scored (infrastructure, quota) — never counted as failures. */
  unscored: number;
  /** Metered-equivalent cost of the whole arm, USD. */
  listUsd: number | null;
  /** Commit of THIS repository the arm ran from. */
  gearSha: string;
  notes?: string;
}

export const ANCHOR_DIR = join(import.meta.dir, "anchors");
export const RESULTS_PATH = join(ANCHOR_DIR, "results.json");

export const ANCHORS: Record<string, string> = {
  "swe-bench-verified-50": join(ANCHOR_DIR, "swe-bench-verified-50.json"),
  "terminal-bench-20": join(ANCHOR_DIR, "terminal-bench-20.json"),
};

export function loadAnchor(name: string): AnchorSet {
  const path = ANCHORS[name];
  if (!path) {
    throw new Error(`unknown anchor "${name}" — one of: ${Object.keys(ANCHORS).join(", ")}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as AnchorSet;
}

export function loadResults(path = RESULTS_PATH): AnchorResult[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AnchorResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordResult(result: AnchorResult, path = RESULTS_PATH): AnchorResult[] {
  const all = [...loadResults(path), result];
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  return all;
}

/** resolved / (attempted − unscored). Null when nothing was scored. */
export function resolveRate(r: AnchorResult): number | null {
  const scored = r.attempted - r.unscored;
  return scored > 0 ? r.resolved / scored : null;
}

/**
 * The lift the evolved arm shows over pristine, for one benchmark on one date.
 * Null when either arm is missing — an evolved number with no control beside it
 * is exactly the claim this phase refuses to make.
 */
export function anchorLift(
  results: AnchorResult[],
  benchmark: string,
): { at: string; pristine: number; evolved: number; lift: number } | null {
  const byDate = new Map<string, Partial<Record<AnchorArm, AnchorResult>>>();
  for (const r of results) {
    if (r.benchmark !== benchmark) continue;
    const day = r.at.slice(0, 10);
    const row = byDate.get(day) ?? {};
    row[r.arm] = r;
    byDate.set(day, row);
  }
  const days = [...byDate.keys()].sort().reverse();
  for (const day of days) {
    const row = byDate.get(day)!;
    const p = row.pristine ? resolveRate(row.pristine) : null;
    const e = row.evolved ? resolveRate(row.evolved) : null;
    if (p === null || e === null) continue;
    return { at: day, pristine: p, evolved: e, lift: e - p };
  }
  return null;
}

/** The commands a person runs. Printed, never executed. */
export function planFor(name: string, arm: AnchorArm): string[] {
  const set = loadAnchor(name);
  const pristine = arm === "pristine" ? " --pristine" : "";
  if (set.benchmark.startsWith("SWE-bench")) {
    return [
      `# ${set.benchmark} · ${set.task_ids.length} pinned instances · arm: ${arm}`,
      `# Dataset is NOT vendored here. Clone the official harness first:`,
      `#   git clone https://github.com/princeton-nlp/SWE-bench && cd SWE-bench && pip install -e .`,
      ``,
      `# 1. Produce predictions with Gear, one instance per session:`,
      `for id in $(jq -r '.task_ids[]' ${ANCHORS[name]}); do`,
      `  gear -P${pristine} --workspace "$SWEBENCH_REPOS/$id" \\`,
      `    "Fix the issue described in the instance's problem statement. Do not modify tests." \\`,
      `    > "predictions/$id.patch"`,
      `done`,
      ``,
      `# 2. Score with the official harness (this repository does not score):`,
      `python -m swebench.harness.run_evaluation \\`,
      `  --dataset_name princeton-nlp/SWE-bench_Verified \\`,
      `  --predictions_path predictions/ --run_id gear-${arm}-$(date +%Y%m%d)`,
      ``,
      `# 3. Record the number here:`,
      `bun run tests/eval/anchors.ts --record ${name} --arm ${arm} \\`,
      `  --resolved <n> --attempted ${set.task_ids.length} --unscored <n> --model <id> --provider <id>`,
    ];
  }
  return [
    `# ${set.benchmark} · ${set.task_ids.length} pinned tasks · arm: ${arm}`,
    `# Needs Docker and the official harness; nothing here starts a container:`,
    `#   uv tool install terminal-bench`,
    ``,
    `tb run --agent custom --agent-import-path gear_agent:GearAgent \\`,
    `  --task-ids $(jq -r '.task_ids | join(",")' ${ANCHORS[name]}) \\`,
    `  --run-id gear-${arm}-$(date +%Y%m%d)${pristine ? "   # GEAR_PRISTINE=1" : ""}`,
    ``,
    `bun run tests/eval/anchors.ts --record ${name} --arm ${arm} \\`,
    `  --resolved <n> --attempted ${set.task_ids.length} --unscored <n> --model <id> --provider <id>`,
  ];
}

// ─── CLI ───

function arg(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.includes("--list") || argv.length === 0) {
    console.log(
      "\n  \x1b[1mExternal anchors\x1b[0m \x1b[2m— the yardstick the loop may not edit\x1b[0m\n",
    );
    for (const [name, path] of Object.entries(ANCHORS)) {
      const set = loadAnchor(name);
      console.log(
        `  ${name.padEnd(24)} ${set.task_ids.length} tasks  \x1b[2m${set.benchmark} · pinned ${set.pinnedAt}\x1b[0m`,
      );
      console.log(`  ${" ".repeat(24)} \x1b[2m${path}\x1b[0m`);
    }
    const results = loadResults();
    console.log(
      `\n  ${results.length} recorded run(s)${existsSync(RESULTS_PATH) ? ` \x1b[2m(${RESULTS_PATH})\x1b[0m` : ""}`,
    );
    for (const name of Object.keys(ANCHORS)) {
      const set = loadAnchor(name);
      const lift = anchorLift(results, set.benchmark);
      console.log(
        `  ${set.benchmark.padEnd(24)} ${
          lift
            ? `pristine ${(lift.pristine * 100).toFixed(1)}% → evolved ${(lift.evolved * 100).toFixed(1)}%  \x1b[2m(${lift.at})\x1b[0m`
            : "\x1b[2mno paired run — an evolved number with no control beside it is not a result\x1b[0m"
        }`,
      );
    }
    console.log(
      `\n  \x1b[2mNothing here downloads a dataset or starts a container. --plan <anchor> --arm <pristine|evolved>\n  prints the exact commands; --record ingests what they produce. See docs/benchmarks.md.\x1b[0m\n`,
    );
    return;
  }

  const plan = arg(argv, "plan");
  if (plan) {
    const armArg = arg(argv, "arm");
    const arm: AnchorArm = armArg === "evolved" ? "evolved" : "pristine";
    console.log();
    for (const line of planFor(plan, arm)) console.log(`  ${line}`);
    console.log();
    return;
  }

  const record = arg(argv, "record");
  if (record) {
    const set = loadAnchor(record);
    const armArg = arg(argv, "arm");
    const result: AnchorResult = {
      benchmark: set.benchmark,
      arm: armArg === "evolved" ? "evolved" : "pristine",
      at: new Date().toISOString(),
      model: arg(argv, "model") ?? "unknown",
      provider: arg(argv, "provider") ?? "unknown",
      attempted: Number(arg(argv, "attempted") ?? set.task_ids.length),
      resolved: Number(arg(argv, "resolved") ?? 0),
      unscored: Number(arg(argv, "unscored") ?? 0),
      listUsd: arg(argv, "cost") !== undefined ? Number(arg(argv, "cost")) : null,
      gearSha: arg(argv, "sha") ?? "unknown",
      notes: arg(argv, "notes"),
    };
    recordResult(result);
    const rate = resolveRate(result);
    console.log(
      `\n  Recorded ${result.benchmark} · ${result.arm} · ${result.resolved}/${result.attempted - result.unscored} = ${rate === null ? "no data" : `${(rate * 100).toFixed(1)}%`}\n  → ${RESULTS_PATH}\n  Update docs/benchmarks.md with the date and the model.\n`,
    );
    return;
  }

  console.log(
    "\n  Usage: bun run tests/eval/anchors.ts [--list | --plan <anchor> --arm <arm> | --record <anchor> ...]\n",
  );
}

if (import.meta.main) main();
