#!/usr/bin/env bun
/**
 * What every request carries before the conversation starts, and what an easy
 * task costs on top of its own work — as numbers, taken the same way each time.
 *
 * Run it before a change to the prompt, a tool description or a gate, and again
 * after. The two files are the comparison; this script draws no conclusion.
 *
 *   bun scripts/prompt-snapshot.ts --out <file.json> [--label <text>] [--overhead <file.json>]
 *
 * It measures three things:
 *
 *   fixed text     the doctrine (every section on, and with nothing gated),
 *                  the tool schemas a first request actually ships, and the
 *                  descriptions of the bookkeeping tools on their own
 *   an easy task   `tests/helpers/easy-task.ts`: a one-line fix by a scripted
 *                  model that calls no bookkeeping tool. Completions, tool
 *                  calls, and every turn the HARNESS added
 *   by role        with `--overhead`, `scripts/overhead-report.ts` run over
 *                  that one session database — always an explicit `--db`,
 *                  never the default, which is a person's whole history
 *
 * What it does NOT measure, and must not be read as measuring: what a real
 * model does with the text. A shorter description that buys a recovery call is
 * not an improvement, and a cache hit rate follows from repeated real requests,
 * not from byte counts. Those need a live comparison.
 *
 * Zero model calls, zero network. Writes only `--out` (and `--overhead`).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { RECORD_EVIDENCE_SCHEMA, READ_BACK_SCHEMA } from "../packages/orchestrator/src/brief";
import {
  NOTE_HYPOTHESIS_SCHEMA,
  RECORD_DECISION_SCHEMA,
} from "../packages/orchestrator/src/narrative-tools";
import {
  AGENT_DOCTRINE,
  FULL_DOCTRINE_CONTEXT,
  renderDoctrine,
} from "../packages/orchestrator/src/prompts";
import { countTokens, tokenCounter } from "../packages/orchestrator/src/tokenizer";
import { TODO_WRITE_SCHEMA } from "../packages/tool-registry/src/tools/todo-write";
import { BOOKKEEPING_TOOLS, runEasyTask } from "../tests/helpers/easy-task";
import { resolveRuneToolsBinary } from "../tests/helpers/native-binary";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const out = flag("out");
if (!out) {
  console.error(
    "usage: bun scripts/prompt-snapshot.ts --out <file.json> [--label <text>] [--overhead <file.json>]",
  );
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "..");
const git = (...args: string[]): string =>
  spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim();

tokenCounter.resetCalibrations();
const size = (text: string) => ({ bytes: Buffer.byteLength(text), tokens: countTokens(text) });

// Every size is taken BEFORE the run below: a session calibrates the shared
// token counter against the provider's own usage numbers, and a count taken
// afterwards is on that session's scale, not the one the budget test uses.
const doctrine = {
  doctrineFull: size(renderDoctrine(FULL_DOCTRINE_CONTEXT)),
  doctrineMinimal: size(
    renderDoctrine({ canDelegate: false, greenfield: false, buildsInterfaces: false }),
  ),
  doctrineSource: size(AGENT_DOCTRINE),
};
const bookkeeping = [
  READ_BACK_SCHEMA,
  RECORD_EVIDENCE_SCHEMA,
  TODO_WRITE_SCHEMA,
  NOTE_HYPOTHESIS_SCHEMA,
  RECORD_DECISION_SCHEMA,
]
  .filter((s) => BOOKKEEPING_TOOLS.has(s.name))
  .map((s) => ({
    name: s.name,
    description: size(s.description),
    schema: size(JSON.stringify(s)),
  }));

const native = resolveRuneToolsBinary();
if (!native.exists) {
  console.error(`needs the native tools binary (${native.path})`);
  process.exit(2);
}
const run = await runEasyTask(native.path);

let overhead: unknown;
const overheadOut = flag("overhead");
if (overheadOut) {
  const res = spawnSync(
    "bun",
    [
      "scripts/overhead-report.ts",
      "--db",
      run.dbPath,
      "--out",
      resolve(overheadOut),
      "--no-pilots",
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  overhead = { written: res.status === 0 ? overheadOut : null, exit: res.status };
}

const { dispose, dbPath: _db, ...easyTask } = run;
dispose();

const snapshot = {
  schema: "rune-prompt-snapshot@1",
  label: flag("label") ?? null,
  at: new Date().toISOString(),
  head: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  bun: Bun.version,
  modelCalls: 0,
  fixedText: {
    ...doctrine,
    bookkeepingTools: bookkeeping,
    bookkeepingDescriptionBytes: bookkeeping.reduce((n, t) => n + t.description.bytes, 0),
  },
  easyTask: {
    ...easyTask,
    // What the harness added to the four completions the work needs.
    completionsBeyondTheWork: easyTask.requests - 4,
  },
  ...(overhead ? { overheadReport: overhead } : {}),
};

mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  JSON.stringify({ fixedText: snapshot.fixedText, easyTask: snapshot.easyTask }, null, 1),
);
