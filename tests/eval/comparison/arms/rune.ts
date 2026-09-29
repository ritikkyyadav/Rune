// ─── The Rune arm ───
//
// Rune through the same interface as every comparator, so the parity runner
// holds it to the same plan / parse / classify path as the tool it is measured
// against. It used to live only inside `runPilot`'s loop, which is why the Rune
// row and the comparator row were produced by different code and judged by
// different rules (a Rune timeout was a scored failure; a comparator timeout
// was unscored). Now both sides report facts and `classifyOutcome` decides.
//
// What it runs is the `parity` harness profile (harness.ts): Rune on its
// SHIPPED defaults — no turn ceiling override, no second-wind override, no
// dollar ceiling, no effort override — isolated in a fresh profile per run:
//
//   <bin> -P <prompt> --workspace <fixture> --provider P --model M
//         --gear auto --auto-approve --pristine --stream-json
//
// with RUNE_HOME, RUNE_DB_PATH and RUNE_CONFIG_PATH pointing into the evidence
// directory and the founder's saved sign-ins read, never copied, through the
// credential paths.
//
// What it reads back:
//
//   · stdout is NDJSON (`--stream-json`): every engine event, one per line,
//     and the headless envelope LAST — `{ok, text, error, stopReason, usage,
//     …}` (packages/orchestrator/src/headless.ts). `ok: true` from a process
//     that exited 0 by itself is Rune claiming success.
//   · the profile's rune.db holds one `cost` event per priced model call — the
//     tool's own ledger, and the only place a call count comes from.
//   · `stopReason` says how the loop ended: `max_turns` and `budget` are Rune's
//     own ceilings (scored, like Claude Code's `error_max_turns`), and
//     `provider_lost` is the provider giving up on it (unscored, like a 5xx).
//
// NOTHING HERE HAS BEEN RUN LIVE against a model by this arm. The argv is the
// one `runPilot` has run since 2026-09-08 minus the pilot's caps; the parser is
// validated against synthetic captures built from `headlessEnvelope` and the
// `AgentTurnEvent` union.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { materialiseHarness, planParityHarness, runeCost, sourceDigest } from "../harness";
import { runProcess } from "../process";
import {
  type ArmCapture,
  type ArmLimits,
  type ArmPlan,
  type ArmResult,
  type ArmTask,
  type ArmUsage,
  type ComparatorArm,
  type OutcomeSignals,
  type ParsedArm,
  type ProviderFailure,
  binarySha256Of,
  failureCategory,
  judged,
  probeVersion,
  providerFailureInEvent,
  taskEnvNames,
  workspaceOf,
} from "./types";

const repo = resolve(import.meta.dir, "../../../..");

/** The source entrypoint, when no pinned build is named. */
export const RUNE_SOURCE_COMMAND: readonly string[] = [
  process.execPath,
  join(repo, "packages/orchestrator/src/bin/rune-cli.ts"),
];

/** The route `runPilot` has always defaulted to. */
export const RUNE_DEFAULT_PROVIDER = "codex";

/** Why a plan with no model is refused. */
export const RUNE_NEEDS_MODEL =
  "The Rune arm needs a --model: it never runs a default it did not record.";

export const RUNE_PARITY_GAPS = [
  "shipped defaults: Rune runs with no config override — its own turn ceiling and second winds, its own effort, its OS sandbox on. The pilot profile's 24-turn cap is gone, because the comparator it now faces has no cap either.",
  "isolation: a fresh RUNE_HOME, database and config per run and --pristine (no learned tactics), with the founder's saved sign-ins read through the credential paths, never copied.",
  "quota: Rune does not yet report what share of a subscription window a run used, so quotaPct is null on its rows unless a future build emits one — and a series authorised by RUNE_EVAL_QUOTA_PCT alone stops rather than run unmetered.",
];

export type RuneLedger = ReturnType<typeof runeCost>;

export const EMPTY_LEDGER: RuneLedger = { listUsd: null, models: [], entries: 0, estimated: false };

/** The headless envelope, as far as this side reads it. */
interface RuneEnvelope {
  ok?: boolean;
  text?: string;
  error?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

/** The ceilings Rune stops itself at, by the loop's own stop reason. */
export const RUNE_LIMIT_STOPS: Readonly<Record<string, "turns" | "budget">> = {
  max_turns: "turns",
  budget: "budget",
};

/**
 * A share-of-window figure, if an event carries one.
 *
 * Rune at f29a771 emits none (nothing under packages/ reads a provider's
 * window headers) — this reads the field names a future build would most
 * plausibly use (`quotaPct`, `usedPercent`, on the event or its payload), so
 * the RUNE_EVAL_QUOTA_PCT gate starts working the day it does, and until then
 * the gate knows it is blind.
 */
function quotaPctIn(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  for (const holder of [row, row.payload, row.quota]) {
    if (!holder || typeof holder !== "object") continue;
    const h = holder as Record<string, unknown>;
    for (const key of ["quotaPct", "usedPercent", "used_percent"]) {
      const n = h[key];
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function parseRuneOutput(
  capture: ArmCapture,
  ledger: RuneLedger,
  extra: { sourceChanged?: boolean } = {},
): ParsedArm {
  let envelope: RuneEnvelope | undefined;
  let provider: ProviderFailure | undefined;
  let usageEvents = 0;
  let totalTurns: number | null = null;
  let eventStop: string | undefined;
  let quotaPct: number | undefined;
  let events = 0;
  for (const line of capture.stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    // The envelope is the one object with a boolean `ok` and no event `type`.
    if (typeof row.ok === "boolean" && row.type === undefined) {
      envelope = row as RuneEnvelope;
      continue;
    }
    events++;
    provider = providerFailureInEvent(row) ?? provider;
    if (row.type === "usage") usageEvents++;
    if (row.type === "turn_complete") {
      if (typeof row.totalTurns === "number") totalTurns = row.totalTurns;
      if (typeof row.stopReason === "string") eventStop = row.stopReason;
    }
    const q = quotaPctIn(row);
    if (q !== undefined) quotaPct = Math.max(quotaPct ?? q, q);
  }
  const stop = envelope?.stopReason ?? eventStop;
  // The envelope's `error` is the run's own terminal error; when there is no
  // stream at all and the process ended by itself, the only text there is IS
  // the failure. When the rig killed it, nothing it printed was a terminal
  // report — the same rule every other arm's parser applies.
  if (!provider && envelope?.ok === false && envelope.error)
    provider = failureCategory(envelope.error);
  if (!provider && !envelope && !events && !capture.stopped)
    provider = failureCategory(`${capture.stderr}\n${capture.stdout}`);
  if (!provider && stop === "provider_lost") provider = "outage";

  const reachedModel = ledger.entries > 0 || usageEvents > 0;
  const signals: OutcomeSignals = {
    ...(capture.stopped ? { stopped: capture.stopped } : {}),
    exitCode: capture.exitCode,
    claimedSuccess: !capture.stopped && capture.exitCode === 0 && envelope?.ok === true,
    reachedModel,
    ...(provider ? { provider } : {}),
    ...(stop && RUNE_LIMIT_STOPS[stop] ? { toolLimit: RUNE_LIMIT_STOPS[stop] } : {}),
    ...(extra.sourceChanged ? { sourceChanged: true } : {}),
  };
  const usage: ArmUsage | null = envelope?.usage
    ? {
        inputTokens: envelope.usage.inputTokens ?? 0,
        outputTokens: envelope.usage.outputTokens ?? 0,
        reasoningTokens: 0,
        cacheReadTokens: envelope.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: 0,
      }
    : null;
  const detail = capture.stopped
    ? capture.stopped
    : !envelope
      ? capture.exitCode === 0
        ? "no envelope on stdout"
        : "no envelope; exited non-zero"
      : envelope.ok
        ? undefined
        : (stop ?? "error");
  return judged(signals, {
    resultText: typeof envelope?.text === "string" ? envelope.text : null,
    turns: totalTurns,
    // The ledger is the count. A run whose ledger could not be read falls back
    // to the usage events it streamed, which are one per completed request.
    calls: ledger.entries > 0 ? ledger.entries : usageEvents,
    reportedCostUsd: ledger.listUsd,
    usage,
    models: ledger.models,
    quotaPct: quotaPct ?? null,
    ...(detail ? { detail } : {}),
  });
}

/** The command a plan runs: a pinned build, or the source entrypoint. */
const commandOf = (limits: ArmLimits): string[] => limits.command ?? [...RUNE_SOURCE_COMMAND];

function harnessPlan(task: ArmTask, dir: string, limits: ArmLimits) {
  return planParityHarness(
    "rune",
    {
      command: commandOf(limits),
      provider: limits.provider ?? RUNE_DEFAULT_PROVIDER,
      model: limits.model ?? "",
      ...(limits.env ? { env: limits.env } : {}),
      taskEnv: taskEnvNames(task),
    },
    dir,
    workspaceOf(dir),
    task.prompt,
  );
}

/**
 * What the measured build IS, before and after the run: the binary's hash for
 * a pinned build, the source tree's digest for anything else. A difference is
 * `source_changed` — the row measured two builds (another session editing the
 * checkout mid-run is the case this exists for).
 */
export function buildFingerprint(command: readonly string[]): string {
  return binarySha256Of(command) ?? sourceDigest();
}

export const runeArm: ComparatorArm = {
  name: "rune",
  version: (limits) => probeVersion(limits ? commandOf(limits) : [...RUNE_SOURCE_COMMAND]),
  plan(task, dir, limits): ArmPlan {
    const planned = harnessPlan(task, dir, limits);
    return {
      arm: "rune",
      command: planned.command,
      cwd: workspaceOf(dir),
      env: planned.env,
      artifacts: { profile: join(dir, "profile") },
      parityGaps: RUNE_PARITY_GAPS,
      ...(limits.model ? {} : { refusal: RUNE_NEEDS_MODEL }),
    };
  },
  parse: (capture) => parseRuneOutput(capture, EMPTY_LEDGER),
  async runArm(task, dir, limits): Promise<ArmResult> {
    const plan = this.plan(task, dir, limits);
    if (plan.refusal) throw new Error(plan.refusal);
    materialiseHarness(harnessPlan(task, dir, limits));
    const command = commandOf(limits);
    // Before the spawn a failure to fingerprint throws: nothing has run, and
    // the paired runner re-runs an arm that produced no row.
    const before = buildFingerprint(command);
    const stdoutPath = join(dir, "events.jsonl");
    const stderrPath = join(dir, "stderr.log");
    const process_ = await runProcess({
      command: plan.command,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: limits.timeoutMs,
      stdoutPath,
      stderrPath,
    });
    // After it, the tool has already spent: a build that can no longer be
    // fingerprinted is a build nobody can vouch for, which is what
    // `source_changed` means — not a reason to throw the run away and pay again.
    let after: string;
    try {
      after = buildFingerprint(command);
    } catch (error) {
      after = `unreadable: ${String(error)}`;
    }
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    let ledger: RuneLedger;
    let costError: string | undefined;
    try {
      ledger = runeCost(join(dir, "profile"));
    } catch (error) {
      ledger = EMPTY_LEDGER;
      costError = String(error);
    }
    const parsed = parseRuneOutput(
      {
        stdout: read(stdoutPath),
        stderr: read(stderrPath),
        exitCode: process_.exitCode,
        durationMs: process_.durationMs,
        ...(process_.stopped ? { stopped: process_.stopped } : {}),
      },
      ledger,
      { sourceChanged: before !== after },
    );
    const binarySha256 = binarySha256Of(command);
    return {
      ...parsed,
      ...(costError ? { detail: costError } : {}),
      arm: "rune",
      version: this.version(limits),
      ...(binarySha256 ? { binarySha256 } : {}),
      command: plan.command,
      cwd: plan.cwd,
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      listUsd: ledger.listUsd,
      estimated: ledger.estimated,
      entries: ledger.entries,
      parityGaps: plan.parityGaps,
    };
  },
};
