// ─── The OpenCode arm, in the arm interface ───
//
// The OpenCode arm was not a module: it was a branch of `prepareHarness` and a
// stretch of `runPilot`'s loop. That is fine for one comparator and wrong for
// three, and it is why the new arms could have drifted into a different shape
// without anyone noticing.
//
// So this file expresses the arm through `ComparatorArm` — and it expresses it
// by CALLING the harness code, not by copying it. The argv and environment come
// from `planParityHarness("opencode", …)` (the parity profile: OpenCode as it
// ships, no `steps` cap, an allow-listed environment), the spawn from
// `runProcess`, the cost from `opencodeCost`, the refusal reading from the
// shared `providerFailureInEvent`, and the verdict from the one classifier
// every arm shares (`classifyOutcome`). `runPilot` keeps its own `pilot`
// profile; `tests/unit/eval/comparator-arms.test.ts` asserts this arm's plan is
// the parity harness's plan, byte for byte.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  materialiseHarness,
  openCodeBudgetWatcher,
  opencodeCost,
  planParityHarness,
} from "../harness";
import { runProcess } from "../process";
import {
  type ArmCapture,
  type ArmLimits,
  type ArmPlan,
  type ArmResult,
  type ComparatorArm,
  type OutcomeSignals,
  type ParsedArm,
  type ProviderFailure,
  binarySha256Of,
  judged,
  probeVersion,
  providerFailureInEvent,
  taskEnvNames,
  workspaceOf,
} from "./types";

export const OPENCODE_PARITY_GAPS = [
  "same model, different harness: OpenCode can be pointed at the model the Rune arm runs, so this is the one arm a same-model claim is available against in product mode. Tools, orchestration, prompts and helper routing remain its own.",
  "reasoning: --variant high, which is OpenCode's name for the setting, not a proven equal of Rune's effort level.",
  "no dollar ceiling of its own: under the parity profile it has none, like every other arm. Where a legacy series sets --budget-usd, the rig stops the tree after a REPORTED step crosses it, so an overshoot is possible and is recorded rather than hidden.",
];

/** The provider route the OpenCode arm uses unless the limits say otherwise. */
export const OPENCODE_PROVIDER = "openai";

/** The parity harness plan for this arm — pure, so a dry run writes nothing. */
function harnessPlan(task: { prompt: string; browser?: boolean }, dir: string, limits: ArmLimits) {
  return planParityHarness(
    "opencode",
    {
      command: limits.command ?? ["opencode"],
      provider: limits.provider ?? OPENCODE_PROVIDER,
      model: limits.model ?? "",
      ...(limits.env ? { env: limits.env } : {}),
      taskEnv: taskEnvNames(task),
    },
    dir,
    workspaceOf(dir),
    task.prompt,
  );
}

export function parseOpenCodeOutput(
  capture: ArmCapture,
  cost: ReturnType<typeof opencodeCost>,
): ParsedArm {
  let reported: ProviderFailure | undefined;
  let steps = 0;
  for (const line of capture.stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      // Harnesses interleave plain log lines with their event stream.
      continue;
    }
    reported = providerFailureInEvent(event) ?? reported;
    const row = event as { type?: string; part?: { tokens?: unknown } };
    if (row?.type === "step_finish" && row.part?.tokens) steps++;
  }
  // OpenCode's error events carry no `recoverable` flag (Rune's do), so one is
  // TERMINAL only when the process then failed by itself — `runPilot`'s rule
  // since the pilot began. An error it recovered from, in a run that exited 0,
  // is not an outage; an error followed by the rig's kill was said by a
  // process that was still going, and the clock is what ended it.
  const provider = !capture.stopped && capture.exitCode !== 0 ? reported : undefined;
  // OpenCode prints no success marker, so its claim is the process's: exited
  // 0 by itself, with a ledger that shows the model was reached.
  const reachedModel = cost.entries > 0 || steps > 0;
  const signals: OutcomeSignals = {
    ...(capture.stopped ? { stopped: capture.stopped } : {}),
    exitCode: capture.exitCode,
    claimedSuccess: !capture.stopped && capture.exitCode === 0 && reachedModel,
    reachedModel,
    ...(provider ? { provider } : {}),
  };
  return judged(signals, {
    // OpenCode's answer text lives in its own session store, not on stdout in
    // a shape this side should depend on; the tree and the ledger are what the
    // rig grades. Stated, rather than left looking like a parse failure.
    resultText: null,
    turns: null,
    // One ledger row per assistant message that carried tokens: its calls. A
    // ledger that could not be read falls back to the steps it streamed.
    calls: cost.entries > 0 ? cost.entries : steps,
    reportedCostUsd: null,
    // Its usage is a sqlite ledger re-priced by `opencodeCost`, not a token
    // roll-up on stdout, so this arm reports dollars without tokens.
    usage: null,
    models: cost.models,
    ...(capture.stopped ? { detail: capture.stopped } : {}),
  });
}

export const opencodeArm: ComparatorArm = {
  name: "opencode",
  version: (limits) => probeVersion(limits?.command ?? ["opencode"]),
  plan(task, dir, limits): ArmPlan {
    const planned = harnessPlan(task, dir, limits);
    return {
      arm: "opencode",
      command: planned.command,
      cwd: workspaceOf(dir),
      env: planned.env,
      artifacts: { data: join(dir, "data") },
      parityGaps: OPENCODE_PARITY_GAPS,
    };
  },
  parse: (capture) =>
    parseOpenCodeOutput(capture, { listUsd: null, models: [], entries: 0, estimated: false }),
  async runArm(task, dir, limits): Promise<ArmResult> {
    const planned = harnessPlan(task, dir, limits);
    materialiseHarness(planned);
    const plan = this.plan(task, dir, limits);
    const stdoutPath = join(dir, "events.jsonl");
    const stderrPath = join(dir, "stderr.log");
    // Only a legacy series sets a per-task ceiling; a parity run has none.
    const budget =
      limits.budgetUsd !== undefined
        ? openCodeBudgetWatcher(limits.model ?? "", limits.budgetUsd)
        : undefined;
    const process_ = await runProcess({
      command: plan.command,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: limits.timeoutMs,
      stdoutPath,
      stderrPath,
      onLine(line) {
        if (!budget) return false;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return false;
        }
        return budget.observe(event);
      },
    });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    let cost: ReturnType<typeof opencodeCost>;
    let costError: string | undefined;
    try {
      cost = opencodeCost(join(dir, "data"), limits.model ?? "");
    } catch (error) {
      cost = { listUsd: null, models: [], entries: 0, estimated: false };
      costError = String(error);
    }
    const parsed = parseOpenCodeOutput(
      {
        stdout: read(stdoutPath),
        stderr: read(stderrPath),
        exitCode: process_.exitCode,
        durationMs: process_.durationMs,
        ...(process_.stopped ? { stopped: process_.stopped } : {}),
      },
      cost,
    );
    const binarySha256 = binarySha256Of(limits.command);
    return {
      ...parsed,
      ...(costError ? { detail: costError } : {}),
      arm: "opencode",
      version: this.version(limits),
      ...(binarySha256 ? { binarySha256 } : {}),
      command: plan.command,
      cwd: plan.cwd,
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      listUsd: cost.listUsd,
      estimated: cost.estimated,
      entries: cost.entries,
      parityGaps: plan.parityGaps,
    };
  },
};
