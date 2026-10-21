#!/usr/bin/env bun
// ─── The offline corpus runner ───
//
// Twelve tasks × five scenarios through the REAL `Engine`, with a scripted
// provider replaying hand-written turns against a materialised fixture under a
// scratch RUNE_HOME. Zero model calls, zero dollars, `~/.rune` never opened.
//
// What it measures is the harness's DETECTION: given a run that did the work,
// left half of it out, did the wrong thing plausibly, said nothing at all, or
// was cut off, what verdict does the runtime reach? A false completion is a
// run the harness called `met` that was not done. Nothing here says anything
// about a model's ability — the "model" is a fixed script.
//
//   bun run tests/eval/corpus/run-offline.ts --out docs/evidence/corpus-offline-<date>.json
//
// `--tasks a,b` and `--scenarios correct,omission` narrow a debugging run; the
// report records what it actually attempted, so a narrowed run cannot be read
// as the whole corpus.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentTurnEvent } from "../../../packages/protocol/src/index";
import type { ContentBlock, InferenceRequest } from "../../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { UsageProvider } from "../../helpers/usage-provider";
import { homedir } from "node:os";
import type { InferenceResponse } from "../../../packages/llm-gateway/src/types";
import { parseRequestCheck } from "../../../packages/orchestrator/src/request-check";

/**
 * `--request-check-live`: the request check (A3) answered by a real model,
 * one child process per call (`tests/eval/request-check/ask-live.ts`), while
 * every other call stays scripted. The child is given the founder's sign-ins
 * only through the credential paths, in an environment built here and not
 * inherited — the parity rig's rule — and a scratch Rune home of its own.
 */
const ASK_LIVE = join(dirname(new URL(import.meta.url).pathname), "../request-check/ask-live.ts");

function liveChecker(profile: string): (system: string, user: string) => string {
  const real = join(homedir(), ".rune");
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    RUNE_HOME: profile,
    RUNE_DB_PATH: join(profile, "rune.db"),
    RUNE_CREDENTIALS_PATH: join(real, "credentials.json"),
    RUNE_CREDENTIAL_INDEX_PATH: join(real, "credentials.index.json"),
    RUNE_SECRETS_PATH: join(real, "secrets.json"),
  };
  return (system, user) => {
    const child = spawnSync("bun", [ASK_LIVE], {
      input: JSON.stringify({ system, user }),
      env,
      encoding: "utf8",
      timeout: 240_000,
    });
    return child.status === 0 ? child.stdout : "";
  };
}

/** The scripted model, with the request check answered by `checker` when one is given. */
class CorpusProvider extends UsageProvider {
  readonly requestChecks: Array<{ sent: string; answer: string }> = [];
  constructor(private readonly checker?: (system: string, user: string) => string) {
    super();
  }
  override async infer(request: Parameters<UsageProvider["infer"]>[0]): Promise<InferenceResponse> {
    if (request.role !== "request_check" || !this.checker) return super.infer(request);
    const sent = request.messages
      .map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
      .join("\n");
    const answer = this.checker(request.system ?? "", sent);
    this.requestChecks.push({ sent, answer });
    return {
      id: "request-check",
      model: request.model,
      content: [{ type: "text", text: answer }],
      stopReason: "end_turn",
      usage: this.usage,
    };
  }
}

import {
  SCENARIOS,
  armsFor,
  TASK_IDS,
  browserAvailable,
  loadAcceptance,
  loadScenario,
  loadTask,
  materialise,
  type CorpusScenario,
  type CorpusTask,
  type ScenarioName,
} from "./corpus";

const repoRoot = resolve(import.meta.dir, "../../..");

/** The one classification, fixed in README.md before the first run. */
export type Classification =
  "detected" | "false completion" | "false negative" | "under-claimed" | "cut off" | "skipped";

type TurnVerdict = Extract<AgentTurnEvent, { type: "turn_complete" }>["verdict"];

/**
 * What a verdict says about itself beyond its kind. Since the self-evidence
 * rule ("a check the run authored cannot settle a criterion") a correct run
 * that proves its fix with a test it wrote ends `partial`, the kind a wrong
 * run gets too, so the kind alone stopped separating them: the 2026-09-27 run
 * graded all ten correct rows `partial`. WHY a verdict fell short still does:
 * every defective row there left an evaluator criterion unsatisfied, and every
 * correct row left only its own criteria at `needs_review`.
 */
export interface VerdictFacts {
  kind: string | undefined;
  /** Evaluator criteria the runtime did not find satisfied. */
  evaluatorFailed: number;
  /** At least one criterion is unsatisfied, and each is the run's own, at `needs_review`. */
  needsReviewOnly: boolean;
}

export function verdictFacts(verdict: TurnVerdict | undefined): VerdictFacts {
  // An absent status is a criterion the runtime never assessed: unsatisfied.
  const unsatisfied = (verdict?.criteria ?? []).filter(
    (criterion) => criterion.status !== "satisfied",
  );
  return {
    kind: verdict?.kind,
    evaluatorFailed: unsatisfied.filter((criterion) => criterion.source === "evaluator").length,
    needsReviewOnly:
      unsatisfied.length > 0 &&
      unsatisfied.every(
        (criterion) => criterion.source !== "evaluator" && criterion.status === "needs_review",
      ),
  };
}

export function classify(
  scenario: ScenarioName,
  facts: VerdictFacts,
): Exclude<Classification, "skipped"> {
  // `met` and `done` both say the work is finished (A3, 2026-10-21): `done`
  // rests on the project's own checks rather than on every criterion shown,
  // and a wrong run that reaches it is a false completion exactly as `met`
  // would be. Every other kind is not a claim of completion.
  const claimsDone = facts.kind === "met" || facts.kind === "done";
  if (scenario === "correct") return claimsDone ? "detected" : "false negative";
  // A run that never finished cannot be a completed task, so `stopped` ending
  // in a completion claim is a false completion too; anything else about it is
  // just "cut off", which is neither a hit nor a miss.
  if (claimsDone) return "false completion";
  return scenario === "stopped" ? "cut off" : "detected";
}

function toolsBinary(): string {
  const fromEnv = process.env.RUNE_TOOLS_BIN ?? process.env.RUNE_TOOLS_BINARY;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const bin = join(repoRoot, "target", "debug", "rune-tools");
  if (!existsSync(bin)) throw new Error(`needs the native tools binary: ${bin}`);
  return bin;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() ?? "";
}

/** A scenario turn, in the blocks the gateway speaks. */
function blocksFor(task: CorpusTask, scenario: CorpusScenario, index: number): ContentBlock[] {
  const turn = scenario.turns[index];
  if (!turn) return [{ type: "text", text: "Done for now." }];
  return turn.map((block, at) => {
    if ("text" in block) return { type: "text", text: block.text };
    const input = { ...block.input };
    if (block.contentFrom) input.content = readFileSync(join(task.dir, block.contentFrom), "utf8");
    return {
      type: "tool_use",
      toolCallId: `corpus-${index}-${at}`,
      toolName: block.tool,
      toolInput: input,
    };
  });
}

/**
 * A harness re-prompt: a request after the first whose last message is the
 * runtime's own words rather than a tool result. A finish gate, a loop nudge
 * or a second wind all land here, and each one is a turn the model did not ask
 * for. Counted from the wire so it needs no engine internals.
 */
function harnessRePrompts(requests: InferenceRequest[]): number {
  let count = 0;
  for (const [index, request] of requests.entries()) {
    if (index === 0) continue;
    const last = request.messages.at(-1);
    if (last?.role !== "user") continue;
    if (last.content.some((block) => block.type === "text")) count += 1;
  }
  return count;
}

interface Row {
  task: string;
  family: string;
  scenario: ScenarioName;
  note: string;
  /** What each request check (A3) answered: the asks, and the ones it called missing. */
  requestChecks?: Array<{ asks: number; missing: string[] } | { unreadable: true }>;
  classification: Classification;
  skippedReason?: string;
  verdict?: string;
  execution?: { status: string; stopReason: string };
  criteria?: Array<{
    id?: string;
    text: string;
    status: string;
    source?: string;
    required?: boolean;
  }>;
  gaps?: Array<{ criterion: string; why: string }>;
  evaluatorFailed?: string[];
  harnessRePrompts?: number;
  completions?: number;
  providerTurns?: number;
  modelCalls: 0;
  wallMs?: number;
  error?: string;
}

async function runRow(
  task: CorpusTask,
  name: ScenarioName,
  verify = false,
  withAcceptance = true,
  checker?: (system: string, user: string) => string,
): Promise<Row> {
  const scenario = loadScenario(task, name);
  const base: Row = {
    task: task.id,
    family: task.family,
    scenario: name,
    note: scenario.note,
    classification: "skipped",
    modelCalls: 0,
  };

  if (task.browser && !browserAvailable())
    return {
      ...base,
      skippedReason: "no RUNE_BENCH_PLAYWRIGHT: the browser acceptance cannot run here",
    };

  const scratch = mkdtempSync(join(tmpdir(), `corpus-${task.id}-${name}-`));
  const home = join(scratch, "home");
  const root = join(scratch, "workspace");
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  const started = Date.now();
  let engine: Engine | undefined;
  try {
    materialise(task, root);
    // `--no-acceptance` runs with no outside check at all, as a person's run
    // has none: then only the project's own checks stand between a wrong run
    // and `done`, which is the risk A3 takes and the number it owes.
    const acceptance = withAcceptance ? loadAcceptance(task) : [];
    engine = new Engine({
      model: "claude-sonnet-5",
      provider: "anthropic",
      workspaceRoot: root,
      dbPath: join(home, "rune.db"),
      toolsBinaryPath: toolsBinary(),
      permissionMode: "gear-4",
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      // Off by default, as M1's acceptance tests run. `--verify` turns the
      // end-of-turn check on, so a run can reach `done` (A3) and the corpus
      // can say whether a wrong one does.
      enableVerification: verify,
      context: { repoMap: false },
      evolve: { playbook: false },
      memory: { enabled: false },
      acceptance,
      ...(scenario.maxTurns
        ? { reliability: { maxTurns: scenario.maxTurns, secondWinds: 0 } }
        : {}),
    } as ConstructorParameters<typeof Engine>[0]);

    const provider = new CorpusProvider(checker);
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
    // What the RUNTIME put in front of the model: the first request in full
    // (nothing the model wrote is in it yet) and every system prompt. Later
    // request bodies echo the model's own tool inputs back, so a criterion
    // whose wording a scripted turn happens to reuse would look like a leak
    // there — and a check that cries wolf is not a check.
    const runtimeText: string[] = [];
    provider.onRequest = (request, index) => {
      if (index === 1) runtimeText.push(JSON.stringify(request));
      else if (request.system) runtimeText.push(request.system);
      return blocksFor(task, scenario, index - 1);
    };

    const events: AgentTurnEvent[] = [];
    for await (const event of engine.chat(engine.createSession(), task.prompt)) events.push(event);

    // The oracle property, asserted rather than assumed: if a criterion's text
    // or its command ever reached a prompt, the run was measuring the model's
    // compliance with the answer sheet.
    for (const criterion of acceptance)
      for (const needle of [criterion.text, criterion.command ?? ""].filter(Boolean))
        if (runtimeText.some((body) => body.includes(needle)))
          throw new Error(`acceptance leaked into a prompt: ${needle.slice(0, 60)}`);

    const completions = events.filter((event) => event.type === "turn_complete");
    const terminal = completions.at(-1) as
      Extract<AgentTurnEvent, { type: "turn_complete" }> | undefined;
    const verdict = terminal?.verdict;
    const gaps = verdict?.kind === "partial" ? verdict.gaps : [];

    return {
      ...base,
      classification: classify(name, verdictFacts(verdict)),
      ...(verdict?.kind ? { verdict: verdict.kind } : {}),
      ...(verdict?.execution ? { execution: verdict.execution } : {}),
      criteria: (verdict?.criteria ?? []).map((criterion) => ({
        text: criterion.text,
        // A criterion with no derived status is a row the runtime never
        // assessed; saying so is better than dropping it.
        status: criterion.status ?? "unassessed",
        ...(criterion.source ? { source: criterion.source } : {}),
        ...(criterion.required === undefined ? {} : { required: criterion.required }),
      })),
      gaps: gaps.map((gap) => ({ criterion: gap.criterion, why: gap.why })),
      evaluatorFailed: (verdict?.criteria ?? [])
        .filter((criterion) => criterion.source === "evaluator" && criterion.status !== "satisfied")
        .map((criterion) => `${criterion.text} → ${criterion.status}`),
      harnessRePrompts: harnessRePrompts(provider.requests),
      ...(provider.requestChecks.length > 0
        ? {
            requestChecks: provider.requestChecks.map(({ answer }) => {
              const outcome = parseRequestCheck(answer);
              return outcome
                ? { asks: outcome.asks, missing: outcome.missing.map((m) => m.ask) }
                : { unreadable: true as const };
            }),
          }
        : {}),
      completions: completions.length,
      providerTurns: provider.requests.length,
      wallMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      classification: "skipped",
      skippedReason: "the run threw",
      error: String(error instanceof Error ? error.message : error).slice(0, 600),
      wallMs: Date.now() - started,
    };
  } finally {
    engine?.close();
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Rates never travel without their denominators. */
function tally(rows: Row[]) {
  const attempted = rows.filter((row) => row.classification !== "skipped");
  const correct = attempted.filter((row) => row.scenario === "correct");
  const wrongish = attempted.filter((row) => row.scenario !== "correct");
  const falseCompletions = attempted.filter((row) => row.classification === "false completion");
  const falseNegatives = correct.filter((row) => row.classification === "false negative");
  const underClaimed = correct.filter((row) => row.classification === "under-claimed");
  const rate = (top: number, bottom: number) =>
    bottom === 0 ? null : Number((top / bottom).toFixed(4));
  return {
    rows: rows.length,
    attempted: attempted.length,
    skipped: rows.length - attempted.length,
    falseCompletions: falseCompletions.length,
    falseCompletionDenominator: wrongish.length,
    falseCompletionRate: rate(falseCompletions.length, wrongish.length),
    falseNegatives: falseNegatives.length,
    correctAttempted: correct.length,
    falseNegativeRate: rate(falseNegatives.length, correct.length),
    underClaimed: underClaimed.length,
    underClaimRate: rate(underClaimed.length, correct.length),
    cutOff: attempted.filter((row) => row.classification === "cut off").length,
    detected: attempted.filter((row) => row.classification === "detected").length,
  };
}

export async function runOffline(options: {
  out: string;
  tasks?: string[];
  scenarios?: ScenarioName[];
  /** Run the end-of-turn check, as a shipped engine does. */
  verify?: boolean;
  /** False: no `--acceptance` criteria, as a person's own run has none. */
  acceptance?: boolean;
  /** The request check answered by a live model (Codex, the founder's subscription). */
  requestCheckLive?: boolean;
}) {
  const liveProfile = options.requestCheckLive
    ? mkdtempSync(join(tmpdir(), "rune-request-check-live-"))
    : undefined;
  const checker = liveProfile ? liveChecker(liveProfile) : undefined;
  const ids = TASK_IDS.filter((id) => !options.tasks || options.tasks.includes(id));
  const tasks = ids.map(loadTask);
  // The arms a run actually drives: the pinned five for every task, plus the
  // attack arms a task declares. `arms` below is the union, for the protocol
  // block; each task is driven with its own list.
  const armsOf = (task: CorpusTask): ScenarioName[] =>
    armsFor(task).filter((name) => !options.scenarios || options.scenarios.includes(name));
  const arms = [...new Set(tasks.flatMap(armsOf))];
  if (!ids.length || !arms.length) throw new Error("no such task or scenario");

  const rows: Row[] = [];
  for (const task of tasks) {
    const id = task.id;
    for (const name of armsOf(task)) {
      const row = await runRow(
        task,
        name,
        options.verify === true,
        options.acceptance !== false,
        checker,
      );
      rows.push(row);
      const detail =
        row.classification === "skipped"
          ? (row.error ?? row.skippedReason ?? "")
          : `${row.verdict} / ${row.execution?.status}`;
      console.log(`${id.padEnd(30)} ${name.padEnd(9)} ${row.classification.padEnd(17)} ${detail}`);
    }
  }

  const families = [...new Set(rows.map((row) => row.family))].sort();
  const report = {
    schema: 1,
    kind: "corpus-offline",
    generatedAt: new Date().toISOString(),
    measures:
      "the harness's ability to tell a finished task from an unfinished one. The provider is a fixed script: nothing here measures a model.",
    modelCalls: 0,
    spendUsd: 0,
    provenance: {
      head: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      dirtyPatchSha256: sha256(git(["diff", "HEAD"])),
      toolsBinary: toolsBinary(),
      toolsBinarySha256: sha256(readFileSync(toolsBinary())),
      bun: Bun.version,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      playwright: {
        available: browserAvailable(),
        module: process.env.RUNE_BENCH_PLAYWRIGHT ?? null,
      },
    },
    protocol: {
      tasks: ids,
      scenarios: arms,
      complete:
        ids.length === TASK_IDS.length &&
        tasks.every((task) => armsOf(task).length === armsFor(task).length),
      engine: options.verify
        ? "checkpoints, security, rate limiting, hooks, MCP, skills, repo map, playbook and memory off; the end-of-turn check ON (`--verify`), so a run can end `done`."
        : "checkpoints, security, rate limiting, hooks, MCP, skills, verification, repo map, playbook and memory off — the same configuration M1's acceptance integration tests use, so the rows are comparable to those.",
      verification: options.verify === true,
      acceptance: options.acceptance !== false,
      requestCheck: options.requestCheckLive
        ? `live: codex ${process.env.RUNE_REQUEST_CHECK_MODEL ?? "gpt-6-sol"}`
        : "scripted (answers nothing the check can read)",
      classification: {
        "false completion":
          "an omission / wrong / silent / stopped run whose verdict is `met` or `done`",
        "false negative": "a correct run whose verdict is neither `met` nor `done`",
        "cut off": "a stopped run that did not report `met`",
        detected: "the verdict matched what the arm actually was",
        skipped: "the acceptance could not run here; excluded from every denominator",
      },
    },
    totals: tally(rows),
    families: Object.fromEntries(
      families.map((family) => [family, tally(rows.filter((row) => row.family === family))]),
    ),
    scenarios: Object.fromEntries(
      arms.map((name) => [name, tally(rows.filter((row) => row.scenario === name))]),
    ),
    rows,
  };

  if (liveProfile) rmSync(liveProfile, { recursive: true, force: true });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `\n${report.totals.attempted} attempted, ${report.totals.skipped} skipped · ` +
      `false completions ${report.totals.falseCompletions}/${report.totals.falseCompletionDenominator} · ` +
      `false negatives ${report.totals.falseNegatives}/${report.totals.correctAttempted}\n${options.out}`,
  );
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const at = args.indexOf(`--${key}`);
    return at < 0 ? undefined : args[at + 1];
  };
  // The default used to be a fixed, dated evidence file, so a bare run wrote
  // over the 2026-09-14 record. A run names its own day, and evidence already
  // on disk is never replaced without `--force` (README Changes, 2026-09-28).
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const out = resolve(get("out") ?? join(repoRoot, `docs/evidence/corpus-offline-${stamp}.json`));
  if (existsSync(out) && !args.includes("--force")) {
    console.error(`${out} already exists — evidence is never overwritten. Pass --out or --force.`);
    process.exit(2);
  }
  await runOffline({
    out,
    ...(get("tasks") ? { tasks: get("tasks")!.split(",") } : {}),
    ...(get("scenarios") ? { scenarios: get("scenarios")!.split(",") as ScenarioName[] } : {}),
    ...(args.includes("--verify") ? { verify: true } : {}),
    ...(args.includes("--no-acceptance") ? { acceptance: false } : {}),
    ...(args.includes("--request-check-live") ? { requestCheckLive: true } : {}),
  });
}
