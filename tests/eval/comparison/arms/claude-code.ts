// ─── The Claude Code arm ───
//
// `claude --print --output-format json` in the fixture directory, at the
// version installed on this machine. Pinned: 2.1.284 (Claude Code), read on
// 2026-09-29 — it had auto-updated from the 2.1.283 the lane was briefed on
// overnight, which is also why the paired runner probes `--version` before
// EVERY run rather than once. Every flag below is in that version's
// `claude --help`. The arm records whatever `claude --version` says into every
// result, because a number produced by an unrecorded version is not evidence.
//
// Two modes, because the parity program asks two different questions
// (tests/eval/parity/types.ts, `ParityMode`):
//
//   product   Claude Code as a customer runs it: the founder's own plan, its
//             own best model. The login lives in a DEDICATED profile —
//             `CLAUDE_CONFIG_DIR` from `RUNE_PARITY_CLAUDE_CONFIG_DIR` — that
//             the founder signs into once by hand (`CLAUDE_CONFIG_DIR=<dir>
//             claude`, then `/login`). The arm refuses to run without it.
//             This replaces the first version, which ran on the founder's own
//             `~/.claude`: their settings, their hooks, their CLAUDE.md and
//             their plugins all took part in the measurement.
//   harness   `--bare`, on `ANTHROPIC_API_KEY` from the environment: no hooks,
//             no CLAUDE.md discovery, no keychain, no OAuth — the same model
//             Rune is pointed at, through the same kind of key. A fresh
//             scratch `CLAUDE_CONFIG_DIR` inside the evidence directory keeps
//             even the tool's own state files out of the founder's home.
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
// And the isolation, in both modes:
//
//   --setting-sources project       only the FIXTURE's settings load — never
//                                   the user's, never a local override
//   --strict-mcp-config             no MCP servers from anywhere but a
//                                   `--mcp-config` (and there is none)
//   --no-session-persistence        the comparison writes no sessions
//
// What is deliberately NOT here: `--max-budget-usd`. The parity rule is that
// no arm is capped by anything but the wall clock — Rune runs on its shipped
// defaults with no turn or dollar override, so a dollar ceiling on this side
// only would be a handicap the other arm does not carry. The series-level
// authorisation (`RUNE_EVAL_BUDGET_USD` / `RUNE_EVAL_QUOTA_PCT`) is the money
// gate, and it sits in front of the series, not inside a run.
//
// NOTHING HERE HAS BEEN RUN LIVE. Every flag is read from `claude --help` at
// the pinned version; the parser is validated against synthetic captures
// written from the documented envelope. The first authorised run is also the
// first test of the flag set, and the README says so.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ParityMode } from "../../parity/types";
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
  type ToolLimit,
  armEnv,
  binarySha256Of,
  failureCategory,
  judged,
  priceUsage,
  probeVersion,
  taskEnvNames,
  workspaceOf,
} from "./types";

/** The Claude Code version every flag in this file was read from. */
export const CLAUDE_CODE_PINNED_VERSION = "2.1.284";

/**
 * Where product mode's login lives: a Claude Code profile directory the
 * founder signed into ONCE, by hand, for evaluation and nothing else.
 */
export const CLAUDE_PARITY_CONFIG_ENV = "RUNE_PARITY_CLAUDE_CONFIG_DIR";

/**
 * The names each mode keeps beyond the neutral base (`armEnv`).
 *
 * Product mode keeps NO key: an `ANTHROPIC_API_KEY` in the founder's shell
 * would quietly turn a plan run into an API-billed one, and a
 * `CLAUDE_CODE_OAUTH_TOKEN` would bypass the evaluation profile. Its only
 * addition is `CLAUDE_CONFIG_DIR`, and that is never inherited — it is SET,
 * from `RUNE_PARITY_CLAUDE_CONFIG_DIR`, below.
 *
 * Harness mode keeps the API key, which is the whole of its auth under
 * `--bare` ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper").
 */
export const CLAUDE_CODE_ENV: Readonly<Record<ParityMode, readonly string[]>> = {
  product: ["CLAUDE_CONFIG_DIR"],
  harness: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
};

/** Every name either mode can keep — for a reader, and for the env tests. */
export const CLAUDE_CODE_AUTH_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] as const;

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
  "model family: Claude Code runs Anthropic models only. In product mode each tool runs its own best model, so a row against it compares products; only harness mode (both tools on one Anthropic model through one API key) is a same-model comparison.",
  "reasoning: --effort takes low|medium|high|xhigh|max, which is a coarser ladder than the provider-level effort Rune sends; the levels are named the same and are not proven to mean the same.",
  "tools and orchestration: subagents, skills, hooks and the built-in tool set are Claude Code's own and are not matched to Rune's.",
  "subscription: in product mode the run spends plan quota, not dollars. total_cost_usd is the tool's list-price reconstruction and is not an invoice.",
  "no ledger when killed: --output-format json prints one envelope at the end, so a run the clock kills leaves no record of its model calls. Whether it had worked is read from the workspace instead (see classifyOutcome).",
];

/** The mode a plan runs in; product unless the caller says harness. */
export const modeOf = (limits: ArmLimits): ParityMode => limits.mode ?? "product";

export function claudeCodeArgv(prompt: string, limits: ArmLimits): string[] {
  const bin = limits.command ?? ["claude"];
  return [
    ...bin,
    "--print",
    ...(modeOf(limits) === "harness" ? ["--bare"] : []),
    "--output-format",
    "json",
    ...(limits.model ? ["--model", limits.model] : []),
    ...(limits.reasoningEffort ? ["--effort", limits.reasoningEffort] : []),
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    CLAUDE_CODE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    CLAUDE_CODE_DISALLOWED_TOOLS.join(","),
    "--permission-prompts",
    "none",
    prompt,
  ];
}

/** The scratch profile harness mode points `CLAUDE_CONFIG_DIR` at. */
export const harnessConfigDir = (dir: string): string => join(dir, "claude-config");

/**
 * The child's environment for a mode, and why a live run would be refused.
 *
 * Product mode: the neutral base plus `CLAUDE_CONFIG_DIR`, set from
 * `RUNE_PARITY_CLAUDE_CONFIG_DIR`. Refused when that is unset, relative, or
 * not a directory — the arm never falls back to `~/.claude`. Only the
 * directory's existence is checked; nothing inside it is read.
 *
 * Harness mode: the neutral base plus `ANTHROPIC_API_KEY`, with
 * `CLAUDE_CONFIG_DIR` set to a scratch directory in the evidence folder.
 * Refused when there is no key.
 */
export function claudeCodeEnv(
  task: Pick<ArmTask, "browser">,
  dir: string,
  limits: ArmLimits,
): { env: NodeJS.ProcessEnv; refusal?: string } {
  const source = limits.env ?? process.env;
  const mode = modeOf(limits);
  const env = armEnv([...CLAUDE_CODE_ENV[mode], ...taskEnvNames(task)], source);
  if (mode === "harness") {
    env.CLAUDE_CONFIG_DIR = harnessConfigDir(dir);
    if (!source.ANTHROPIC_API_KEY)
      return {
        env,
        refusal:
          "Claude Code harness mode runs --bare on ANTHROPIC_API_KEY, and it is not set. Harness mode is an API-key comparison by definition; set the key, or run product mode.",
      };
    return { env };
  }
  const profile = source[CLAUDE_PARITY_CONFIG_ENV]?.trim();
  delete env.CLAUDE_CONFIG_DIR;
  if (!profile)
    return {
      env,
      refusal:
        `Claude Code product mode needs its own evaluation profile, and ${CLAUDE_PARITY_CONFIG_ENV} is not set. ` +
        "Create one and sign in to it ONCE by hand — `CLAUDE_CONFIG_DIR=<dir> claude`, then /login — and point " +
        `${CLAUDE_PARITY_CONFIG_ENV} at <dir>. The arm never runs on ~/.claude: your settings, hooks and CLAUDE.md are not part of the product being measured.`,
    };
  if (!isAbsolute(profile) || !existsSync(profile))
    return {
      env,
      refusal: `${CLAUDE_PARITY_CONFIG_ENV} must be an absolute path to an existing directory you have signed in to once (CLAUDE_CONFIG_DIR=<dir> claude, then /login); got ${JSON.stringify(profile)}.`,
    };
  env.CLAUDE_CONFIG_DIR = profile;
  return { env };
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
// "error_max_budget_usd", "error_during_execution"). A refusal that happens
// BEFORE a turn can start — an expired login, an exhausted quota — usually
// never reaches the envelope at all: the process exits non-zero with prose on
// stderr. Both shapes are read.

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
 * The error subtypes that are the tool's OWN ceiling — the tool failing the
 * task on its own terms, scored like Rune's `max_turns` and `budget` stops.
 *
 * `error_max_budget_usd` used to be a harness error (unscored) while Rune's
 * budget stop was a result: the same event, counted on one side only. Neither
 * ceiling is set by the parity argv, so in a parity row they only appear if a
 * profile sets one — and then they are the tool's answer, not an outage.
 */
export const CLAUDE_CODE_LIMIT_SUBTYPES: Readonly<Record<string, ToolLimit>> = {
  error_max_turns: "turns",
  error_max_budget_usd: "budget",
};

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

const tokensIn = (usage: ArmUsage | null): number =>
  usage
    ? usage.inputTokens +
      usage.outputTokens +
      usage.reasoningTokens +
      usage.cacheReadTokens +
      usage.cacheWriteTokens
    : 0;

export function parseClaudeCodeOutput(capture: ArmCapture): ParsedArm {
  const envelope = lastJsonObject(capture.stdout);
  const usage = envelope ? usageOf(envelope) : null;
  const models = envelope?.modelUsage ? Object.keys(envelope.modelUsage) : [];
  const turns = typeof envelope?.num_turns === "number" ? envelope.num_turns : null;
  const rest = {
    resultText: typeof envelope?.result === "string" ? envelope.result : null,
    turns,
    // `num_turns` is the tool's own count of its model turns, which is the
    // nearest thing it keeps to a call ledger.
    calls: turns,
    reportedCostUsd: typeof envelope?.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    usage,
    models,
  };

  const failed =
    !envelope ||
    envelope.is_error === true ||
    (envelope.subtype ?? "success") !== "success" ||
    envelope.type !== "result";
  // ONLY an error's text is asked about a quota: an error envelope's `result`,
  // or — when no envelope was printed at all and the tool ended BY ITSELF —
  // its own stderr/stdout, which is then nothing but its failure. When the rig
  // killed it there is no envelope by construction (`--output-format json`
  // prints one at the end), and whatever it had written to stderr was said by
  // a process that was still running, perhaps retrying: not a terminal report.
  // A successful run whose answer discusses rate limits is task evidence.
  const errorText = envelope
    ? failed
      ? `${envelope.result ?? ""}\n${capture.stderr}`
      : ""
    : capture.stopped
      ? ""
      : `${capture.stderr}\n${capture.stdout}`;
  const signals: OutcomeSignals = {
    ...(capture.stopped ? { stopped: capture.stopped } : {}),
    exitCode: capture.exitCode,
    claimedSuccess: !capture.stopped && capture.exitCode === 0 && !failed,
    // The envelope is the only ledger this tool leaves: with it, a turn or a
    // token says a call completed; without it, nobody can say.
    reachedModel: envelope ? (turns ?? 0) > 0 || tokensIn(usage) > 0 : null,
  };
  const provider = errorText ? failureCategory(errorText) : undefined;
  if (provider) signals.provider = provider;
  const limit = envelope?.subtype ? CLAUDE_CODE_LIMIT_SUBTYPES[envelope.subtype] : undefined;
  if (limit) signals.toolLimit = limit;

  const detail = capture.stopped
    ? capture.stopped
    : !envelope
      ? capture.exitCode === 0
        ? "malformed envelope"
        : "no envelope; exited non-zero"
      : failed
        ? (envelope.subtype ?? "error")
        : undefined;
  return judged(signals, { ...rest, ...(detail ? { detail } : {}) });
}

export const claudeCodeArm: ComparatorArm = {
  name: "claude-code",
  version: (limits) => probeVersion(limits?.command ?? ["claude"]),
  plan(task, dir, limits): ArmPlan {
    const { env, refusal } = claudeCodeEnv(task, dir, limits);
    return {
      arm: "claude-code",
      command: claudeCodeArgv(task.prompt, limits),
      cwd: workspaceOf(dir),
      env,
      parityGaps: CLAUDE_CODE_PARITY_GAPS,
      ...(refusal ? { refusal } : {}),
    };
  },
  parse: parseClaudeCodeOutput,
  async runArm(task, dir, limits): Promise<ArmResult> {
    const plan = this.plan(task, dir, limits);
    // Refused BEFORE anything is created or spawned: a run on the wrong
    // profile is not a run of the product this arm names.
    if (plan.refusal) throw new Error(plan.refusal);
    mkdirSync(dir, { recursive: true });
    if (modeOf(limits) === "harness") mkdirSync(harnessConfigDir(dir), { recursive: true });
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
    const binarySha256 = binarySha256Of(limits.command);
    return {
      ...parsed,
      arm: "claude-code",
      version: this.version(limits),
      ...(binarySha256 ? { binarySha256 } : {}),
      command: plan.command,
      cwd: plan.cwd,
      exitCode: process_.exitCode,
      durationMs: process_.durationMs,
      ...(process_.stopped ? { stopped: process_.stopped } : {}),
      ...priced,
      parityGaps: plan.parityGaps,
    };
  },
};
