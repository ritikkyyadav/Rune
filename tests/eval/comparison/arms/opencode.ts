// ─── The OpenCode arm, in the arm interface ───
//
// The OpenCode arm was not a module: it was a branch of `prepareHarness` and a
// stretch of `runPilot`'s loop. That is fine for one comparator and wrong for
// three, and it is why the new arms could have drifted into a different shape
// without anyone noticing.
//
// So this file expresses the EXISTING arm through `ComparatorArm` — and it
// expresses it by CALLING the existing code, not by copying it. The argv comes
// from `prepareHarness("opencode", …)`, the spawn from `runProcess`, the cap
// from `openCodeBudgetWatcher`, the cost from `opencodeCost`, the refusal
// reading from `providerFailureReason`. Nothing about what OpenCode is sent or
// how its ledger is read changes here; `runPilot` still composes the same
// helpers itself, and `tests/unit/eval/comparator-arms.test.ts` asserts the two
// compositions produce the identical argv and env for the same task.
//
// What this file adds is one thing: a shape the Claude Code and Codex arms can
// be held to.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { opencodeCost, prepareHarness } from "../harness";
import { runProcess } from "../process";
import { type PilotOptions, openCodeBudgetWatcher, providerFailureReason } from "../runner";
import {
  type ArmCapture,
  type ArmLimits,
  type ArmPlan,
  type ArmResult,
  type ArmTask,
  type ComparatorArm,
  type ParsedArm,
  type UnscoredReason,
  probeVersion,
  unscored,
  workspaceOf,
} from "./types";

export const OPENCODE_PARITY_GAPS = [
  "same model, different harness: OpenCode can be pointed at the model the Rune arm runs, so this is the one arm a same-model claim is available against. Tools, orchestration, prompts and helper routing remain its own.",
  "reasoning: --variant high, which is OpenCode's name for the setting, not a proven equal of Rune's effort level.",
  "no dollar ceiling of its own: the rig stops the tree after a REPORTED step crosses the ceiling, so an overshoot is possible and is recorded rather than hidden.",
];

/**
 * The options `prepareHarness` reads for the opencode branch.
 *
 * Only `model`, `opencodeProvider` and `opencodeCommand` are read on that
 * branch; the rest of `PilotOptions` exists for the Rune branch and for the
 * report. They are filled with values that cannot reach a provider, so that a
 * misuse of this shim is a crash rather than a spend.
 */
function pilotOptionsFor(limits: ArmLimits, provider: string): PilotOptions {
  return {
    out: "",
    model: limits.model ?? "",
    runeProvider: "",
    opencodeProvider: provider,
    budgetUsd: limits.budgetUsd,
    timeoutMs: limits.timeoutMs,
    runs: 1,
    runeCommand: [],
    opencodeCommand: limits.command ?? ["opencode"],
    route: "live",
  };
}

/** The provider route the OpenCode arm uses unless the runner says otherwise. */
export const OPENCODE_PROVIDER = "openai";

export function parseOpenCodeOutput(
  capture: ArmCapture,
  cost: ReturnType<typeof opencodeCost>,
): ParsedArm {
  const base: ParsedArm = {
    outcome: "scored",
    // OpenCode's answer text lives in its own session store, not on stdout in
    // a shape this side should depend on; the tree and the ledger are what the
    // rig grades. Stated, rather than left looking like a parse failure.
    resultText: null,
    turns: null,
    reportedCostUsd: null,
    // Its usage is a sqlite ledger re-priced by `opencodeCost`, not a token
    // roll-up on stdout, so this arm reports dollars without tokens.
    usage: null,
    models: cost.models,
  };
  let providerFailure: UnscoredReason | undefined;
  for (const line of capture.stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const reason = providerFailureReason(JSON.parse(text));
      if (reason) providerFailure = reason as UnscoredReason;
    } catch {
      // Harnesses interleave plain log lines with their event stream.
    }
  }
  if (capture.stopped === "timeout")
    return { ...base, outcome: unscored("timeout"), unscoredReason: "timeout", detail: "timeout" };
  if (capture.stopped)
    return {
      ...base,
      outcome: unscored("cost_limit"),
      unscoredReason: "cost_limit",
      detail: capture.stopped,
    };
  // `runPilot`'s rule, unchanged: a terminal provider error counts only when
  // the process also failed, and a run with no recorded usage is not a row.
  if (capture.exitCode !== 0 && providerFailure)
    return { ...base, outcome: unscored(providerFailure), unscoredReason: providerFailure };
  if (cost.entries === 0)
    return {
      ...base,
      outcome: unscored("no_model_usage"),
      unscoredReason: "no_model_usage",
    };
  return base;
}

export const opencodeArm: ComparatorArm = {
  name: "opencode",
  version: (limits) => probeVersion(limits?.command ?? ["opencode"]),
  plan(task, dir, limits): ArmPlan {
    const workspace = workspaceOf(dir);
    const prepared = prepareHarness(
      "opencode",
      pilotOptionsFor(limits, OPENCODE_PROVIDER),
      dir,
      workspace,
      task.prompt,
    );
    return {
      arm: "opencode",
      command: prepared.command,
      cwd: workspace,
      env: prepared.env,
      artifacts: { data: join(dir, "data") },
      parityGaps: OPENCODE_PARITY_GAPS,
    };
  },
  parse: (capture) =>
    parseOpenCodeOutput(capture, { listUsd: null, models: [], entries: 0, estimated: false }),
  async runArm(task, dir, limits): Promise<ArmResult> {
    const plan = this.plan(task, dir, limits);
    const stdoutPath = join(dir, "events.jsonl");
    const stderrPath = join(dir, "stderr.log");
    const budget = openCodeBudgetWatcher(limits.model ?? "", limits.budgetUsd);
    const process_ = await runProcess({
      command: plan.command,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: limits.timeoutMs,
      stdoutPath,
      stderrPath,
      onLine(line) {
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
    return {
      ...parsed,
      ...(costError ? { detail: costError } : {}),
      arm: "opencode",
      version: this.version(limits),
      command: plan.command,
      cwd: plan.cwd,
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      listUsd: cost.listUsd,
      estimated: cost.estimated,
      entries: cost.entries,
      scored: parsed.outcome === "scored",
      parityGaps: plan.parityGaps,
    };
  },
};
