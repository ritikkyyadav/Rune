// ─── What a comparator arm is ───
//
// The comparison rig had two arms — Rune and OpenCode — and both were written
// inline in `runPilot`'s loop, so "add an arm" meant "edit the loop". The M5
// review's rule is that a comparator counts only once its adapter is VALIDATED,
// and an adapter written inside a loop that spawns a real harness cannot be
// validated without spending money. So the arm is a value now: a plan (argv,
// cwd, env) that can be asserted offline, a parser that can be fed a recorded
// capture, and a `runArm` that is only those two either side of a spawn.
//
// Every arm answers the same five questions the spec asks of a comparator
// (docs/program/comparator-adapters.md):
//
//   1. it runs the task's prompt VERBATIM in the fixture directory,
//   2. under the same wall-clock limit as the Rune arm,
//   3. at the same reasoning setting where the tool exposes one — and it says
//      so in `parityGaps` where the tool does not,
//   4. with no environment beyond its OWN auth (see `armEnv`), and
//   5. it reports an infrastructure interruption as `unscored:<reason>` with
//      the usage retained — never as a failure of the comparator, never as a
//      success.
//
// Nothing in this file spawns anything.

import { spawnSync } from "node:child_process";

import { CostTracker } from "../../../../packages/llm-gateway/src/cost-tracker";
import type { ProviderName } from "../../../../packages/llm-gateway/src/types";

export type ArmName = "rune" | "opencode" | "claude-code" | "codex";

/** The part of a comparison task an arm needs. `ComparisonTask` satisfies it. */
export interface ArmTask {
  id: string;
  prompt: string;
  browser?: boolean;
}

/**
 * The limits every arm is held to, so the arms are comparable.
 *
 * `model` and `reasoningEffort` are passed to the tool where the tool exposes
 * them. Where it does not, the arm records the gap rather than pretending: see
 * `parityGaps` on the result.
 */
export interface ArmLimits {
  /** Wall clock for the whole process tree — the Rune arm's `--timeout-seconds`. */
  timeoutMs: number;
  /** The per-task dollar ceiling, enforced by the tool where the tool has one. */
  budgetUsd: number;
  /** The primary model id, in the comparator's own spelling. */
  model?: string;
  /** `high` unless the founder says otherwise. */
  reasoningEffort?: string;
  /** Override the executable, for a pinned build or a test fixture. */
  command?: string[];
}

/** Tokens, in the one shape the rig prices with. */
export interface ArmUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: ArmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** What an arm intends to do, before it does it. `--dry-run` prints this. */
export interface ArmPlan {
  arm: ArmName;
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Files the arm asks the tool to write beside the workspace, if any. */
  artifacts?: Record<string, string>;
  /** What this arm cannot match about the others, stated at plan time. */
  parityGaps: string[];
}

/** A finished process, as the parser sees it. Nothing here needs a provider. */
export interface ArmCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  /** `runProcess`'s reason for killing the tree: "timeout", "cost limit", … */
  stopped?: string;
  /** The `--output-last-message` file, where the tool writes one. */
  lastMessage?: string;
}

export type ArmOutcome = "scored" | "error" | `unscored:${string}`;

/** The reasons a run is infrastructure rather than evidence. */
export type UnscoredReason =
  | "provider_quota"
  | "provider_authentication"
  | "provider_unavailable"
  | "timeout"
  | "cost_limit"
  | "no_model_usage";

/** What a parser can say about a capture, without knowing how it was produced. */
export interface ParsedArm {
  outcome: ArmOutcome;
  /** Set exactly when `outcome` starts with `unscored:`. */
  unscoredReason?: UnscoredReason;
  /** Why the parser said what it said — for the report, never for a score. */
  detail?: string;
  /** The tool's final answer text, when it prints one. */
  resultText: string | null;
  /** The tool's own turn count, where it reports one. */
  turns: number | null;
  /** The tool's own dollar figure, where it prints one. Not an invoice. */
  reportedCostUsd: number | null;
  usage: ArmUsage | null;
  models: string[];
}

export interface ArmResult extends ParsedArm {
  arm: ArmName;
  /** The comparator's reported version string, recorded in EVERY result. */
  version: string | null;
  command: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stopped?: string;
  /** Rune's pricing table applied to the arm's own reported tokens. Null when
   * the model is not in the table — never a guess, never a zero. */
  listUsd: number | null;
  estimated: boolean;
  /** How many priced entries the figure above came from. */
  entries: number;
  scored: boolean;
  parityGaps: string[];
}

/** The interface the runner talks to. Four arms, one shape. */
export interface ComparatorArm {
  name: ArmName;
  /** `--version` only. Never a turn. */
  version(limits?: ArmLimits): string | null;
  plan(task: ArmTask, dir: string, limits: ArmLimits): ArmPlan;
  parse(capture: ArmCapture): ParsedArm;
  runArm(task: ArmTask, dir: string, limits: ArmLimits): Promise<ArmResult>;
}

/** The workspace inside an evidence directory — the rig's own convention. */
export const workspaceOf = (dir: string): string => `${dir}/workspace`;

// ─── The environment the comparator gets ───
//
// The predicate is the capture rig's, transcribed rather than reinvented
// (scripts/tui-capture/capture.py, "the capture rig scrubs by a stated
// predicate, not by a roster of two suffixes"): a name is credential-shaped
// when it ends in a secret suffix or is one of the documented credential-chain
// variables. An arm keeps the handful of names that are ITS OWN auth and loses
// every other one, so a Claude Code arm cannot quietly authenticate as OpenAI,
// a Codex arm cannot read the founder's Anthropic key, and neither inherits a
// key for some third provider that happens to be exported in this shell.

export const SECRET_SUFFIXES = [
  "_API_KEY",
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_CREDENTIAL",
  "_CREDENTIALS",
  "_AUTH",
] as const;

export const CREDENTIAL_CHAIN = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_VERTEX_LOCATION",
] as const;

export function credentialShaped(name: string): boolean {
  return (
    SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    (CREDENTIAL_CHAIN as readonly string[]).includes(name)
  );
}

/**
 * Rune's own variables, which a comparator has no business reading.
 *
 * Not a secret — a contaminant. `RUNE_HOME` and friends point at the rig's
 * isolated profile, and a comparator that picked one up would be reading the
 * measuring instrument.
 */
const RUNE_PREFIXES = ["RUNE_", "GEAR_", "ALAN_"];

/**
 * The child's environment: the caller's, minus every credential the arm does
 * not own, minus Rune's own configuration.
 *
 * `keep` is the arm's OWN auth, named by the arm. A name in `keep` survives
 * even though it is credential-shaped; that is the whole point of naming it.
 */
export function armEnv(
  keep: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (RUNE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (credentialShaped(name) && !keep.includes(name)) continue;
    env[name] = value;
  }
  return env;
}

// ─── Reading a refusal ───
//
// The stance is `providerFailureReason`'s, one layer up: only a TERMINAL
// provider error moves a row out of the scored set. Prose that mentions a quota
// is task evidence — a model writing about rate limits is not a rate limit —
// so a parser only asks these questions of text the tool itself marked as an
// error, and a successful envelope is scored whatever its prose says.

const QUOTA =
  /usage limit|rate.?limit|too many requests|credit balance is too low|insufficient[_ ]quota|quota (?:exceeded|exhausted)|out of (?:credits|quota)|(?:status(?: code)?|http)[ :]*429/i;

const AUTHENTICATION =
  /invalid api.?key|invalid.bearer.token|authentication(?:_error| failed| error)|unauthorized|not (?:logged in|authenticated)|please run .?\/login|(?:oauth |refresh )?token (?:has )?expired|(?:status(?: code)?|http)[ :]*401/i;

const UNAVAILABLE =
  /overloaded|service unavailable|internal server error|bad gateway|(?:status(?: code)?|http)[ :]*5\d\d/i;

/**
 * The category of a terminal failure, from the tool's own error text.
 *
 * Returns a category, never the text: provider error bodies carry headers and
 * request ids, and the rig's reports are meant to be publishable.
 */
export function failureCategory(text: string): UnscoredReason | undefined {
  if (QUOTA.test(text)) return "provider_quota";
  if (AUTHENTICATION.test(text)) return "provider_authentication";
  if (UNAVAILABLE.test(text)) return "provider_unavailable";
  return undefined;
}

/** `unscored:<reason>`, spelled once. */
export const unscored = (reason: UnscoredReason): ArmOutcome => `unscored:${reason}`;

// ─── Pricing a competitor's tokens ───

/**
 * Rune's versioned pricing table, applied to an arm's reported usage.
 *
 * Same treatment `opencodeCost` gives OpenCode's ledger: every row is the
 * competitor's own turn as far as this side can tell, so `role: "primary"`; an
 * unpriced model yields `null` rather than a zero, because a missing price is
 * not free. This is a list-price reconstruction and NOT an invoice — and on a
 * subscription arm it is not what the run cost the founder at all.
 */
export function priceUsage(
  model: string,
  provider: ProviderName,
  usage: ArmUsage | null,
): { listUsd: number | null; estimated: boolean; entries: number } {
  if (!usage) return { listUsd: null, estimated: false, entries: 0 };
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;
  if (total === 0) return { listUsd: null, estimated: false, entries: 0 };
  const tracker = new CostTracker();
  tracker.record(
    model,
    provider,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens + usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheWriteTokens,
    },
    { role: "primary" },
  );
  const breakdown = tracker.getBreakdown();
  return {
    listUsd: breakdown.unpricedModels.length ? null : breakdown.totalListCostUsd,
    estimated: breakdown.hasEstimatedRates,
    entries: 1,
  };
}

/** `<bin> --version`, and nothing else. Never a turn, never a prompt. */
export function probeVersion(command: string[]): string | null {
  const result = spawnSync(command[0]!, [...command.slice(1), "--version"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const text = `${result.stdout ?? ""}`.trim();
  return text ? text.split("\n").pop()!.trim() : null;
}
