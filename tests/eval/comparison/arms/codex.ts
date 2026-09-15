// ─── The Codex arm ───
//
// `codex exec --json` in the fixture directory, at the version installed on
// this machine (codex-cli 0.154.0 when this was written — recorded into every
// result by `codex --version`, same rule as the other arms).
//
// `codex exec` is the non-interactive form at this version; `codex e` is its
// alias, and the bare `codex <prompt>` form starts the TUI. The flags, all read
// from `codex exec --help` at 0.154.0:
//
//   --json                       events as JSONL on stdout, which is where the
//                                usage comes from
//   --sandbox workspace-write    the tool's own workspace-write level: writes
//                                land in the fixture and nowhere else
//   -c sandbox_workspace_write.network_access=false
//                                the spec's "no network beyond the model host",
//                                said explicitly rather than trusted to a
//                                default
//   -C <dir>                     the working root — the fixture
//   -m <model>                   the primary model
//   -c model_reasoning_effort="high"
//                                the reasoning setting; Codex has no flag for
//                                it, only this config override
//   --ignore-user-config         the founder's ~/.codex/config.toml does not
//                                get to steer a measurement (auth still reads
//                                CODEX_HOME, so the plan login still works)
//   --color never                no ANSI in a recorded capture
//   --output-last-message <file> the final answer as text, beside the evidence
//
// Approvals: `codex exec` is non-interactive and never prompts, so there is no
// approval flag here and no `--dangerously-bypass-approvals-and-sandbox` —
// that flag turns the sandbox OFF, which is the opposite of what an arm wants.
//
// NOTHING HERE HAS BEEN RUN LIVE. The event vocabulary below is read out of the
// installed binary (`thread.started`, `turn.started`, `turn.completed`,
// `turn.failed`, `item.started`, `item.updated`, `item.completed`, and the
// `TokenUsage` field names), and the parser is validated against synthetic
// captures built from it.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runProcess } from "../process";
import {
  type ArmCapture,
  type ArmLimits,
  type ArmPlan,
  type ArmResult,
  type ArmTask,
  type ArmUsage,
  type ComparatorArm,
  type ParsedArm,
  NO_USAGE,
  armEnv,
  failureCategory,
  priceUsage,
  probeVersion,
  unscored,
  workspaceOf,
} from "./types";

/**
 * Codex's own auth: the plan login in `CODEX_HOME`, or an OpenAI API key.
 *
 * `CODEX_HOME` is named here because `armEnv` is an allow-list: it does not end
 * in a secret suffix, so the old deny-list passed it through by accident, and
 * an allow-list would drop it and silently send a founder with a relocated
 * Codex profile back to an unauthenticated `~/.codex`.
 */
export const CODEX_AUTH_VARS = ["OPENAI_API_KEY", "CODEX_HOME"] as const;

/** The file `--output-last-message` writes, relative to the evidence directory. */
export const CODEX_LAST_MESSAGE = "last-message.txt";

export const CODEX_PARITY_GAPS = [
  "model family: the Codex CLI runs OpenAI models, so a row against the Claude Code arm crosses model families. Same-model parity is available only against the Rune and OpenCode arms, which can both be pointed at an OpenAI model.",
  "no dollar ceiling: Codex has no --max-budget-usd. The only per-task cap this arm has is the wall clock, so its spend is bounded by time, not by money.",
  "reasoning: set through -c model_reasoning_effort, not a flag; the ladder is the provider's and is not proven equal to Rune's.",
  "subscription: on a ChatGPT plan the run spends quota, not dollars, and Codex prints no cost figure at all — the listUsd on this arm is Rune's pricing table applied to Codex's reported tokens, which is a reconstruction and not an invoice.",
];

export function codexArgv(prompt: string, workspace: string, limits: ArmLimits): string[] {
  const bin = limits.command ?? ["codex"];
  return [
    ...bin,
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=false",
    ...(limits.reasoningEffort ? ["-c", `model_reasoning_effort="${limits.reasoningEffort}"`] : []),
    ...(limits.model ? ["-m", limits.model] : []),
    "--ignore-user-config",
    "--color",
    "never",
    "-C",
    workspace,
    prompt,
  ];
}

// ─── The event stream ───
//
// One JSON object per line. The types, from the binary's own serde tags:
//
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":…,
//        "cached_input_tokens":…,"cache_write_input_tokens":…,
//        "output_tokens":…,"reasoning_output_tokens":…,"total_tokens":…}}
//   {"type":"turn.failed","error":{"message":"…"}}
//
// The item discriminator is read as `type` OR `item_type`: the tag spelling is
// the one thing here that could differ at another version, and an arm that
// silently reports "no answer text" because a field was renamed is worse than
// one that reads both.

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: CodexUsage;
  error?: { message?: string } | string;
  message?: string;
  item?: { type?: string; item_type?: string; text?: string };
}

/** `tokens used: 12,345` — the non-JSON form's usage line, as a fallback. */
const TOKENS_USED = /tokens used:?\s*([\d,]+)/i;

export function parseCodexOutput(capture: ArmCapture): ParsedArm {
  const events: CodexEvent[] = [];
  for (const line of capture.stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object") events.push(value as CodexEvent);
    } catch {
      // Codex interleaves plain log lines with its event stream; a line that
      // does not parse is not an event and is not a failure.
    }
  }

  const totals: ArmUsage = { ...NO_USAGE };
  let sawUsage = false;
  let resultText: string | null = capture.lastMessage?.trim() || null;
  let turns = 0;
  let failure: string | undefined;
  for (const event of events) {
    if (event.type === "turn.started") turns++;
    if (event.type === "turn.completed" && event.usage) {
      const u = event.usage;
      sawUsage = true;
      totals.inputTokens += u.input_tokens ?? 0;
      totals.outputTokens += u.output_tokens ?? 0;
      totals.reasoningTokens += u.reasoning_output_tokens ?? 0;
      totals.cacheReadTokens += u.cached_input_tokens ?? 0;
      totals.cacheWriteTokens += u.cache_write_input_tokens ?? 0;
    }
    if (event.type === "item.completed") {
      const kind = event.item?.type ?? event.item?.item_type;
      if (kind === "agent_message" && typeof event.item?.text === "string")
        resultText = event.item.text;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const error = event.error;
      failure = [typeof error === "string" ? error : error?.message, event.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
    }
  }

  // The plain (non-`--json`) form prints a usage line instead of events. Read
  // it rather than reporting no usage at all — an arm with no usage is an
  // unscored row, and "the flag was missing" is not an infrastructure failure.
  // A total is not a breakdown, so it lands in `inputTokens` and the pricing
  // that follows is a floor, not a figure to quote.
  if (!sawUsage) {
    const match = TOKENS_USED.exec(capture.stdout) ?? TOKENS_USED.exec(capture.stderr);
    if (match) {
      sawUsage = true;
      totals.inputTokens += Number(match[1]!.replace(/,/g, ""));
    }
  }
  const usage: ArmUsage | null = sawUsage ? totals : null;

  const base: ParsedArm = {
    outcome: "scored",
    resultText,
    turns: turns || null,
    // Codex prints no dollar figure at any version this arm has seen.
    reportedCostUsd: null,
    usage,
    models: [],
  };

  if (capture.stopped === "timeout")
    return { ...base, outcome: unscored("timeout"), unscoredReason: "timeout", detail: "timeout" };
  if (capture.stopped)
    return {
      ...base,
      outcome: unscored("cost_limit"),
      unscoredReason: "cost_limit",
      detail: capture.stopped,
    };

  if (failure !== undefined) {
    const category = failureCategory(failure);
    if (category) return { ...base, outcome: unscored(category), unscoredReason: category };
    // A failed turn that is not a provider outage is the comparator failing
    // the task. It stays scored; the acceptance decides what it was worth.
    return { ...base, outcome: "scored", detail: "turn.failed" };
  }

  if (!events.length) {
    const category = failureCategory(`${capture.stderr}\n${capture.stdout}`);
    if (category) return { ...base, outcome: unscored(category), unscoredReason: category };
    return {
      ...base,
      outcome: "error",
      detail: capture.exitCode === 0 ? "no events on stdout" : "no events; exited non-zero",
    };
  }
  if (!events.some((event) => event.type === "turn.completed"))
    return { ...base, outcome: "error", detail: "event stream ended without turn.completed" };
  return base;
}

export const codexArm: ComparatorArm = {
  name: "codex",
  version: (limits) => probeVersion(limits?.command ?? ["codex"]),
  plan(task, dir, limits): ArmPlan {
    const workspace = workspaceOf(dir);
    const lastMessage = join(dir, CODEX_LAST_MESSAGE);
    const command = codexArgv(task.prompt, workspace, limits);
    // `--output-last-message` writes OUTSIDE the workspace, beside the other
    // evidence, so the answer text never becomes a file the acceptance grades.
    command.splice(command.length - 1, 0, "--output-last-message", lastMessage);
    return {
      arm: "codex",
      command,
      cwd: workspace,
      env: armEnv(CODEX_AUTH_VARS),
      artifacts: { lastMessage },
      parityGaps: CODEX_PARITY_GAPS,
    };
  },
  parse: parseCodexOutput,
  async runArm(task, dir, limits): Promise<ArmResult> {
    const plan = this.plan(task, dir, limits);
    mkdirSync(dir, { recursive: true });
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
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const parsed = parseCodexOutput({
      stdout: read(stdoutPath),
      stderr: read(stderrPath),
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      lastMessage: read(plan.artifacts!.lastMessage!),
    });
    const priced = priceUsage(limits.model ?? "", "openai", parsed.usage);
    return {
      ...parsed,
      arm: "codex",
      version: this.version(limits),
      command: plan.command,
      cwd: plan.cwd,
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      ...priced,
      scored: parsed.outcome === "scored",
      parityGaps: plan.parityGaps,
    };
  },
};
