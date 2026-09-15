// ─── The live-spend authorisation, on every door and on no other ───
//
// Promoted from tests/verification/v6-rec-m5-budget-guard-reds-the-unit-gate.ts
// and v6-m5-live-spend-entry-points-unguarded.ts (V6 findings 6 and 7).
//
// Two failures of the same guard, in opposite directions:
//
//   * It refused too much. `authorisedBudgetUsd()` sat at the top of
//     `runPilot`, so it fired for a caller supplying its own scripted
//     `runeCommand`/`opencodeCommand` — two local bun fixtures that write a
//     sqlite row and exit, zero model calls, zero dollars — and turned
//     `bun test tests/unit`, a required CI job, red. A guard that refuses runs
//     which cannot spend is not a safety property; it is the reason guards get
//     deleted.
//   * It refused too little. `swebench.ts --real` spawns the real rune CLI over
//     fifty SWE-bench instances and asked nothing; `tests/eval/runner.ts` takes
//     `RUNE_EVAL_REAL=1` as well as `--real`, so an ENV VARIABLE opened a live
//     run, gated only on a key existing. For a founder with no credits that is
//     exactly the difference the guard was written to make.
//
// The rule now: spending is refused without `RUNE_EVAL_BUDGET_USD` on every
// route that can spend, and asked about on none that cannot.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPilot } from "../../eval/comparison/runner";
import { rmTemp } from "../../helpers/tmp";

const repo = join(import.meta.dir, "../../..");

/** A scripted "harness" that reaches no provider: it writes one cost row and exits. */
function scriptedArm(dir: string, name: string): string[] {
  const file = join(dir, name);
  writeFileSync(
    file,
    `import {Database} from 'bun:sqlite';
    if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
    const db = new Database(process.env.RUNE_HOME+'/rune.db');
    db.exec('CREATE TABLE events (payload_json TEXT)');
    db.prepare('INSERT INTO events VALUES (?)').run(JSON.stringify({type:'cost',payload:{model:'gpt-5.6-sol',provider:'codex',priced:true,listCostUsd:0.2}}));
    db.close();
    console.log(JSON.stringify({type:'error',error:'Quota exceeded after one completed request'}));
    process.exit(1);`,
  );
  return [process.execPath, file];
}

test("a scripted pilot that cannot spend is never asked for a budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spend-route-"));
  const previous = process.env.RUNE_EVAL_BUDGET_USD;
  delete process.env.RUNE_EVAL_BUDGET_USD;
  try {
    const report = await runPilot({
      out: join(dir, "report"),
      model: "gpt-5.6-sol",
      runeProvider: "codex",
      opencodeProvider: "openai",
      budgetUsd: 1,
      timeoutMs: 2000,
      runs: 1,
      tasks: ["csv-state-machine"],
      runeCommand: scriptedArm(dir, "rune-arm.ts"),
      opencodeCommand: scriptedArm(dir, "opencode-arm.ts"),
    });
    expect(report.results).toHaveLength(1);
  } finally {
    if (previous !== undefined) process.env.RUNE_EVAL_BUDGET_USD = previous;
    rmTemp(dir);
  }
});

test("swebench --real asks whether spending is authorised before it touches the disk", async () => {
  const previous = process.env.RUNE_EVAL_BUDGET_USD;
  delete process.env.RUNE_EVAL_BUDGET_USD;
  try {
    const { runSWE } = await import("../../eval/comparison/swebench");
    let thrown = "";
    // Nothing here makes a model call: the dataset does not exist, so an
    // unguarded runner throws while READING A FILE. The refusal has to arrive
    // first, or a missing dataset is what stands between the founder's account
    // and fifty live instances.
    await runSWE({
      out: join(repo, "tests/unit/eval/never-created-swe"),
      dataset: join(repo, "tests/unit/eval/no-such-dataset.jsonl"),
      repos: join(repo, "tests/unit/eval/no-such-repos"),
      model: "nothing",
      runeProvider: "codex",
      opencodeProvider: "openai",
      budgetUsd: 2,
      timeoutMs: 1000,
      runs: 1,
      runeCommand: ["false"],
      opencodeCommand: ["false"],
    } as Parameters<typeof runSWE>[0]).catch((error: unknown) => {
      thrown = error instanceof Error ? error.message : String(error);
    });
    expect(thrown).toMatch(/not authorised|RUNE_EVAL_BUDGET_USD/i);
  } finally {
    if (previous === undefined) delete process.env.RUNE_EVAL_BUDGET_USD;
    else process.env.RUNE_EVAL_BUDGET_USD = previous;
  }
});

test("every --real entry point in tests/eval asks for the budget authorisation", () => {
  const unguarded = [
    "tests/eval/comparison/swebench.ts",
    "tests/eval/runner.ts",
    "tests/eval/comparison/runner.ts",
  ].filter((path) => {
    const source = readFileSync(join(repo, path), "utf8");
    return source.includes("--real") && !source.includes("authorisedBudgetUsd");
  });
  expect(unguarded).toEqual([]);
});
