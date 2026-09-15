// ─── The Claude Code arm ───
//
// `claude --print --output-format json` in the fixture directory, at the
// version installed on this machine (2.1.270 when this was written — the arm
// records whatever `claude --version` says into every result, because a number
// produced by an unrecorded version is not evidence).
//
// The permission mechanism is the tool's own, and it is the part worth reading
// closely, because "let it work, but only here" is four flags rather than one:
//
//   --permission-mode acceptEdits   file edits proceed without a prompt
//   --allowedTools Bash,Edit,…      the tools the task needs, pre-approved, so
//                                   nothing that the task legitimately does
//                                   waits on an approval nobody can give
//   --disallowedTools WebFetch,WebSearch
//                                   the spec's "no network beyond the model
//                                   host" — the corpus tasks need none, and a
//                                   web fetch would make the run unrepeatable
//   --permission-prompts none       ANYTHING else that would prompt is denied
//                                   automatically. With no `--add-dir`, the
//                                   working directory is the only directory
//                                   the file tools may write, and a write
//                                   outside it is a prompt, which is a denial.
//
// That is the confinement, stated exactly: edits and shell inside the fixture,
// nothing outside it that needs asking. It is the same posture the OpenCode arm
// runs with (`permission: "allow"` inside `--dir`), one notch stricter.
//
// `--strict-mcp-config` (no MCP servers from the founder's machine),
// `--no-session-persistence` (the comparison writes no sessions into the
// founder's history) and `--max-budget-usd` (the tool's own per-task dollar
// ceiling, the closest thing any comparator has to Rune's reserve) complete it.
//
// NOTHING HERE HAS BEEN RUN LIVE. Every flag above is read from
// `claude --help` at the installed version; the parser is validated against
// synthetic captures written from the documented envelope. The first authorised
// run is also the first test of the flag set, and the README says so.

import { existsSync, mkdirSync, readFileSync } from "node:fs";

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
  armEnv,
  failureCategory,
  priceUsage,
  probeVersion,
  unscored,
  workspaceOf,
} from "./types";

/** Claude Code's own auth: the subscription's OAuth token, or an API key. */
export const CLAUDE_CODE_AUTH_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * The tools the arm pre-approves.
 *
 * Passed as ONE comma-separated token rather than as the variadic list the
 * help also accepts: a variadic option followed by a positional prompt is a
 * parser question nobody should have to answer at 3am.
 */
export const CLAUDE_CODE_ALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  "TodoWrite",
];

export const CLAUDE_CODE_DISALLOWED_TOOLS = ["WebFetch", "WebSearch"];

/** What this arm cannot match, stated where the argv is built. */
export const CLAUDE_CODE_PARITY_GAPS = [
  "model family: Claude Code runs Anthropic models only, so it cannot be pointed at the model the Codex or OpenCode arms run. A row against it is a HARNESS comparison across model families, never a same-model one.",
  "reasoning: --effort takes low|medium|high|xhigh|max, which is a coarser ladder than the provider-level effort Rune sends; the levels are named the same and are not proven to mean the same.",
  "tools and orchestration: subagents, skills, hooks and the built-in tool set are Claude Code's own and are not matched to Rune's.",
  "subscription: on a Max plan the run spends quota, not dollars. total_cost_usd is the tool's list-price reconstruction and is not an invoice.",
];

export function claudeCodeArgv(prompt: string, limits: ArmLimits): string[] {
  const bin = limits.command ?? ["claude"];
  return [
    ...bin,
    "--print",
    "--output-format",
    "json",
    ...(limits.model ? ["--model", limits.model] : []),
    ...(limits.reasoningEffort ? ["--effort", limits.reasoningEffort] : []),
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    CLAUDE_CODE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    CLAUDE_CODE_DISALLOWED_TOOLS.join(","),
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    String(limits.budgetUsd),
    prompt,
  ];
}

// ─── The envelope ───
//
// `--output-format json` prints ONE object when the turn ends:
//
//   {"type":"result","subtype":"success","is_error":false,"duration_ms":…,
//    "num_turns":…,"result":"…","session_id":"…","total_cost_usd":…,
//    "usage":{"input_tokens":…,"output_tokens":…,
//             "cache_creation_input_tokens":…,"cache_read_input_tokens":…},
//    "modelUsage":{"<model>":{…}},"permission_denials":[…]}
//
// `subtype` is "success", or an error kind ("error_max_turns",
// "error_during_execution"). A refusal that happens BEFORE a turn can start —
// an expired login, an exhausted quota — usually never reaches the envelope at
// all: the process exits non-zero with prose on stderr. Both shapes are read.

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeCodeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
}

/**
 * The result envelope on stdout, or nothing.
 *
 * Scans FORWARD and takes the first object whose `type` is `"result"`. It used
 * to walk backwards and take the last object of any shape, which made anything
 * the CLI prints after the envelope — a hook's output, a telemetry line, a
 * notice — the envelope, and recorded a completed scored run with real usage as
 * `error: unexpected envelope type undefined`. The rig has never captured this
 * stream live (the samples are transcribed), so "the envelope is the last line"
 * was an assumption about a format nobody here has observed.
 *
 * An object with no `type` is still taken if no `result` object is found, so a
 * transcribed sample that omits the field parses as it always did.
 */
function lastJsonObject(stdout: string): ClaudeCodeEnvelope | undefined {
  const objects: ClaudeCodeEnvelope[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value))
        objects.push(value as ClaudeCodeEnvelope);
    } catch {
      // A partial line is not an envelope. Keep reading.
    }
  }
  if (!objects.length) {
    const trimmed = stdout.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      return JSON.parse(trimmed) as ClaudeCodeEnvelope;
    } catch {
      return undefined;
    }
  }
  return objects.find((value) => value.type === "result") ?? objects[objects.length - 1];
}

/**
 * The error subtypes that are still the comparator's answer to the task.
 *
 * Exactly one: a turn ceiling means the tool was working and ran out of turns,
 * which is a result. `error_during_execution` and anything else is the tool
 * falling over.
 */
export const SCORED_ERROR_SUBTYPES: readonly string[] = ["error_max_turns"];

function usageOf(envelope: ClaudeCodeEnvelope): ArmUsage | null {
  const usage = envelope.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    // Claude Code reports thinking inside output_tokens; there is no separate
    // reasoning counter to add, and inventing one would double-count.
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function parseClaudeCodeOutput(capture: ArmCapture): ParsedArm {
  const envelope = lastJsonObject(capture.stdout);
  const usage = envelope ? usageOf(envelope) : null;
  const models = envelope?.modelUsage ? Object.keys(envelope.modelUsage) : [];
  const base: ParsedArm = {
    outcome: "scored",
    resultText: typeof envelope?.result === "string" ? envelope.result : null,
    turns: typeof envelope?.num_turns === "number" ? envelope.num_turns : null,
    reportedCostUsd: typeof envelope?.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    usage,
    models,
  };

  // A killed tree is infrastructure whatever it left on stdout. Usage stays.
  if (capture.stopped === "timeout")
    return { ...base, outcome: unscored("timeout"), unscoredReason: "timeout", detail: "timeout" };
  if (capture.stopped)
    return {
      ...base,
      outcome: unscored("cost_limit"),
      unscoredReason: "cost_limit",
      detail: capture.stopped,
    };

  if (!envelope) {
    // No envelope: the run never reached a result. The only text there is, is
    // the tool's own failure, so it IS the tool's error text — read it.
    const category = failureCategory(`${capture.stderr}\n${capture.stdout}`);
    if (category) return { ...base, outcome: unscored(category), unscoredReason: category };
    return {
      ...base,
      outcome: "error",
      detail: capture.exitCode === 0 ? "malformed envelope" : "no envelope; exited non-zero",
    };
  }

  const failed = envelope.is_error === true || (envelope.subtype ?? "success") !== "success";
  if (failed) {
    // ONLY an error envelope's text is asked about a quota. A successful run
    // whose answer discusses rate limits is evidence about the task.
    const category = failureCategory(`${envelope.result ?? ""}\n${capture.stderr}`);
    if (category) return { ...base, outcome: unscored(category), unscoredReason: category };
    // A turn ceiling is the comparator failing the task, not the provider
    // failing the comparator: it stays scored, and the acceptance decides.
    //
    // Every OTHER subtype is the tool's own crash. Scoring those — which this
    // branch used to do for anything without quota or auth text in it — grades
    // `error_during_execution` as Claude Code failing the corpus task, and runs
    // the acceptance over a workspace the tool never finished writing. An
    // allow-list, so a subtype nobody has seen yet is unscored rather than
    // silently counted against the comparator.
    if (SCORED_ERROR_SUBTYPES.includes(envelope.subtype ?? ""))
      return { ...base, outcome: "scored", detail: envelope.subtype ?? "error" };
    return {
      ...base,
      outcome: unscored("harness_error"),
      unscoredReason: "harness_error",
      detail: envelope.subtype ?? "error",
    };
  }
  if (envelope.type !== "result")
    return { ...base, outcome: "error", detail: `unexpected envelope type ${envelope.type}` };
  return base;
}

export const claudeCodeArm: ComparatorArm = {
  name: "claude-code",
  version: (limits) => probeVersion(limits?.command ?? ["claude"]),
  plan(task, dir, limits): ArmPlan {
    return {
      arm: "claude-code",
      command: claudeCodeArgv(task.prompt, limits),
      cwd: workspaceOf(dir),
      env: armEnv(CLAUDE_CODE_AUTH_VARS),
      parityGaps: CLAUDE_CODE_PARITY_GAPS,
    };
  },
  parse: parseClaudeCodeOutput,
  async runArm(task, dir, limits): Promise<ArmResult> {
    const plan = this.plan(task, dir, limits);
    mkdirSync(dir, { recursive: true });
    const stdoutPath = `${dir}/stdout.json`;
    const stderrPath = `${dir}/stderr.log`;
    const process_ = await runProcess({
      command: plan.command,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: limits.timeoutMs,
      stdoutPath,
      stderrPath,
    });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const parsed = parseClaudeCodeOutput({
      stdout: read(stdoutPath),
      stderr: read(stderrPath),
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
    });
    const priced = priceUsage(parsed.models[0] ?? limits.model ?? "", "anthropic", parsed.usage);
    return {
      ...parsed,
      arm: "claude-code",
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
