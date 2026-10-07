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
//   2. under the same wall-clock limit as every other arm,
//   3. at the same reasoning setting where the tool exposes one — and it says
//      so in `parityGaps` where the tool does not,
//   4. with no environment beyond its OWN auth (see `armEnv`), and
//   5. it is judged by ONE classifier (`classifyOutcome`, below) that every
//      arm shares — the arm only reports what happened, never what it means.
//
// Nothing in this file spawns anything, except `probeVersion`, which asks a
// tool for `--version` and nothing else.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { CostTracker } from "../../../../packages/llm-gateway/src/cost-tracker";
import type { ProviderName } from "../../../../packages/llm-gateway/src/types";
import type { ParityMode, Terminal, UnscoredReason } from "../../parity/types";

export type { UnscoredReason } from "../../parity/types";

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
  /** Wall clock for the whole process tree. The same number for every arm. */
  timeoutMs: number;
  /**
   * A per-task dollar ceiling, for the legacy series (`run-arms.ts`) only.
   *
   * The parity profile has none, for any arm: the contract's rule is that no
   * arm is capped by anything but the clock (tests/eval/parity/types.ts), so a
   * parity run leaves this unset and the series-level authorisation is the only
   * money gate. Where it IS set, the OpenCode arm's rig-side watcher enforces
   * it, and nothing else reads it.
   */
  budgetUsd?: number;
  /** The primary model id, in the comparator's own spelling. */
  model?: string;
  /** The provider route, for the arms that take one (Rune, OpenCode). */
  provider?: string;
  /** `high` unless the founder says otherwise. */
  reasoningEffort?: string;
  /**
   * `product` (each tool on its own account and best model — the gate) or
   * `harness` (one API key, one model — attribution only). Only the Claude
   * Code arm's argv and environment depend on it. Default: product.
   */
  mode?: ParityMode;
  /** Override the executable, for a pinned build or a test fixture. */
  command?: string[];
  /**
   * The environment the PLAN reads its inputs from — the eval-profile path,
   * the API key's presence. Default `process.env`. A test passes a fake here
   * instead of mutating the process it runs in.
   */
  env?: NodeJS.ProcessEnv;
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
  /**
   * Why a LIVE run of this plan would be refused, if it would be.
   *
   * A plan is always buildable, so a dry run can show the argv of an arm whose
   * profile is not set up yet; `runArm` refuses a plan that carries one of
   * these before it spawns anything.
   */
  refusal?: string;
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

export type ArmOutcome = "scored" | `unscored:${UnscoredReason}`;

// ─── The one classifier ───
//
// Before this, each arm decided for itself what counted, and they disagreed.
// The Claude Code and Codex parsers made a timeout UNSCORED ("infrastructure
// whatever it left on stdout") while `runPilot` let a Rune timeout go to the
// acceptance as a scored failure; `error_max_budget_usd` was a Claude Code
// harness error (unscored) while Rune's own budget stop was a result; a
// comparator's crash after an hour of work vanished from the denominator while
// Rune's stayed in it. Every one of those asymmetries moved rows out of the
// comparator's column and left Rune's in, and each was locally reasonable.
//
// So an arm's parser now reports FACTS in one neutral vocabulary
// (`OutcomeSignals`) and this function alone says what they mean, for every
// arm. `parity-fairness.test.ts` feeds the same synthetic situations through
// every arm's parser and asserts they come out identical.
//
// The rule, from the contract (tests/eval/parity/types.ts):
//
//   SCORED failures (the tool failing the task):
//     · the wall clock ran out — every arm has the same limit;
//     · the tool's own turn or budget ceiling (Claude Code's
//       `error_max_turns` / `error_max_budget_usd`, Rune's `max_turns` /
//       `budget`, the rig's watcher standing in for OpenCode's missing one);
//     · a crash, or any other unfinished ending, after the first model call.
//
//   UNSCORED, for every arm alike (nothing about the tool was measured):
//     · a terminal provider refusal the tool itself reported — outage (5xx,
//       dropped socket, a stall with no completion possible), quota, auth;
//     · a crash before the first model call;
//     · the measured source changed under the run (`source_changed`).
//   (`grader_infrastructure` is the grader's, and is decided by the caller that
//   grades, never by an arm.)

/** A terminal provider refusal, in the tool's own error channel. */
export type ProviderFailure = "quota" | "auth" | "outage";

/** The ceiling a tool stopped itself at. */
export type ToolLimit = "turns" | "budget";

/**
 * What happened, in words every arm can say.
 *
 * A parser fills this from the tool's own output and ledger; the rig adds
 * `workspaceTouched` when it knows. Nothing here is a judgement.
 */
export interface OutcomeSignals {
  /** `runProcess`'s reason for killing the tree, if the rig killed it. */
  stopped?: string;
  exitCode: number | null;
  /** A TERMINAL provider refusal the tool reported — never prose in an answer. */
  provider?: ProviderFailure;
  /** The tool ended at its own turn or budget ceiling. */
  toolLimit?: ToolLimit;
  /**
   * The tool stopped ITSELF short of finishing and said so, in its own terminal
   * report, by a name other than a turn or budget ceiling (Rune's `stopReason`:
   * open steps, a stall, a halt, a detected loop). The name, verbatim. A tool
   * with no such report never sets it. It does not change whether a run is
   * scored — only what its ending is called (`terminalOf`).
   */
  selfStopped?: string;
  /**
   * The tool said it finished: it ended by itself, exited 0, and its own
   * report says success (Claude Code `subtype: "success"`, Rune `ok: true`,
   * Codex `turn.completed` with no failure, OpenCode exit 0 with a ledger).
   */
  claimedSuccess: boolean;
  /**
   * Whether a model call completed, from the tool's own ledger or usage.
   * `null` when the tool leaves nothing to read (Claude Code killed before it
   * printed its envelope).
   */
  reachedModel: boolean | null;
  /**
   * The rig's own evidence of work, independent of any ledger: the task's
   * files changed (tool-state directories such as `.rune/` excluded, because
   * a tool writes those at startup before any model call).
   */
  workspaceTouched?: boolean;
  /** The measured build changed while it ran — the row measured two things. */
  sourceChanged?: boolean;
}

/** Why a SCORED run did not finish. Detail for the report, never a score. */
export type FailureKind = "timeout" | "turn_limit" | "budget_limit" | "stopped" | "unfinished";

export interface Classification {
  scored: boolean;
  /** Set exactly when `scored` is false. */
  unscoredReason?: UnscoredReason;
  /** Set on a scored run the tool did not finish; absent on a claimed success. */
  failure?: FailureKind;
}

const PROVIDER_REASON: Readonly<Record<ProviderFailure, UnscoredReason>> = {
  quota: "provider_quota",
  auth: "provider_auth",
  outage: "provider_outage",
};

/**
 * The one decision: does this run count, and if it failed, how.
 *
 * The order is the rule's precedence, and each step is there for a reason:
 *
 *   1. A changed source means the row measured two builds. Nothing else about
 *      it can be trusted, so it goes first.
 *   2. A claimed success is graded, whatever else the run printed on the way:
 *      a provider hiccup the tool recovered from is not an outage.
 *   3. A terminal provider refusal is the provider failing the tool, even when
 *      the clock also ran out afterwards — a tool waiting on a refused request
 *      was not going to finish.
 *   4. The clock, then the tool's own ceilings: the tool failing the task.
 *   5. Any other unfinished ending counts only when the tool had got as far
 *      as the model. Before the first model call there is nothing of the
 *      tool's work to grade; after it, the crash is the tool's.
 */
export function classifyOutcome(signals: OutcomeSignals): Classification {
  if (signals.sourceChanged) return { scored: false, unscoredReason: "source_changed" };
  if (signals.claimedSuccess && !signals.stopped) return { scored: true };
  if (signals.provider) return { scored: false, unscoredReason: PROVIDER_REASON[signals.provider] };
  if (signals.stopped === "timeout") return { scored: true, failure: "timeout" };
  if (signals.toolLimit === "turns") return { scored: true, failure: "turn_limit" };
  // The rig's cost watcher is the tool's budget ceiling for a tool that has
  // none of its own (OpenCode): the same failure as Claude Code's own.
  if (signals.toolLimit === "budget" || signals.stopped === "cost limit")
    return { scored: true, failure: "budget_limit" };
  const worked = signals.reachedModel === true || signals.workspaceTouched === true;
  if (!worked) return { scored: false, unscoredReason: "crash_before_first_call" };
  return { scored: true, failure: signals.stopped ? "stopped" : "unfinished" };
}

/**
 * How the run ENDED, in the row's vocabulary — the same facts, and the same
 * precedence, as `classifyOutcome`: a claimed success first, a terminal
 * provider refusal ahead of the clock.
 *
 * `incomplete` and `crashed` are the two the old rule could not tell apart.
 * Both end without a success claim and without the rig's hand. The difference
 * is whether the tool SAID it was stopping: its own ceiling, or its own named
 * stop, is an honest "not finished"; a process that just ended — no report, or
 * a report holding only an error — is a crash.
 */
export function terminalOf(signals: OutcomeSignals): Terminal {
  if (signals.claimedSuccess && !signals.stopped) return "completed";
  if (signals.provider) return "refused";
  if (signals.stopped === "timeout") return "stopped";
  // The rig's cost watcher is the budget ceiling of a tool that has none: the
  // same ending as a tool stopping at its own, as the classifier above holds.
  if (signals.toolLimit || signals.stopped === "cost limit") return "incomplete";
  if (signals.stopped) return "stopped";
  if (signals.selfStopped) return "incomplete";
  return "crashed";
}

/** `unscored:<reason>`, spelled once. */
export const unscored = (reason: UnscoredReason): ArmOutcome => `unscored:${reason}`;

/** A classification as the one-word outcome a report prints. */
export const outcomeOf = (c: Classification): ArmOutcome =>
  c.scored ? "scored" : unscored(c.unscoredReason!);

/** What a parser can say about a capture, without knowing how it was produced. */
export interface ParsedArm extends Classification {
  outcome: ArmOutcome;
  /** The facts the classification was made from — re-classified by a rig that knows more. */
  signals: OutcomeSignals;
  /** The tool reported success (the same bit as `signals.claimedSuccess`). */
  claimedSuccess: boolean;
  /** Why the parser said what it said — for the report, never for a score. */
  detail?: string;
  /** The tool's final answer text, when it prints one. */
  resultText: string | null;
  /** The tool's own turn count, where it reports one. */
  turns: number | null;
  /** Model calls, from the tool's own ledger. Null when it keeps none. */
  calls: number | null;
  /** The tool's own dollar figure, where it prints one. Not an invoice. */
  reportedCostUsd: number | null;
  usage: ArmUsage | null;
  models: string[];
  /** Share of the subscription window used, when the tool reports one. */
  quotaPct?: number | null;
}

/**
 * The classification step every parser ends with.
 *
 * Kept as ONE function so no parser can spell the outcome differently from the
 * classification it came from.
 */
export function judged(
  signals: OutcomeSignals,
  rest: Omit<ParsedArm, keyof Classification | "outcome" | "signals" | "claimedSuccess">,
): ParsedArm {
  const classification = classifyOutcome(signals);
  return {
    ...rest,
    ...classification,
    outcome: outcomeOf(classification),
    signals,
    claimedSuccess: signals.claimedSuccess,
  };
}

export interface ArmResult extends ParsedArm {
  arm: ArmName;
  /** The comparator's reported version string, recorded in EVERY result. */
  version: string | null;
  /** sha256 of the executable, when the command is one file on disk. */
  binarySha256?: string;
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
  /**
   * Every model this arm's configuration names for a session on `spec` — what
   * it MAY call, in the names its `models` uses. An arm that states one has its
   * rows held to it; an arm that states none (absent, or null) has them held to
   * using the same models on every run.
   */
  roster?(spec: { model: string; provider?: string }): string[] | null;
  plan(task: ArmTask, dir: string, limits: ArmLimits): ArmPlan;
  parse(capture: ArmCapture): ParsedArm;
  runArm(task: ArmTask, dir: string, limits: ArmLimits): Promise<ArmResult>;
}

/** The workspace inside an evidence directory — the rig's own convention. */
export const workspaceOf = (dir: string): string => `${dir}/workspace`;

// ─── When a series stops ───
//
// Every runner used to stop at the FIRST unscored row (`break tasksRun` in
// `runPilot`, `if (!result.scored) break` in `runArmSeries`). One provider
// blip then ended a twelve-task series and left eleven tasks unmeasured — and
// since a quota wall is usually hit by whichever arm runs more, the stop fell
// unevenly on the arms. The rule now, for every runner: an unscored row is
// recorded and the series goes on, and it stops only once MORE than a quarter
// of what was planned has come back unscored — by then the series is measuring
// the provider, not the tools.

export const UNSCORED_STOP_SHARE = 0.25;

/** More than a quarter of the planned units (rows or pairs) came back unscored. */
export function tooManyUnscored(unscoredCount: number, planned: number): boolean {
  return unscoredCount > planned * UNSCORED_STOP_SHARE;
}

// ─── The environment the comparator gets ───
//
// An ALLOW-list, after a deny-list turned out to be a redirect path.
//
// The first version of this scrub removed every credential-shaped name and
// passed the rest of the shell through. The v7 verification pass pointed out
// what that leaves: `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` (the arm talks
// to any host, and the fixture and the prompt go with it), `ANTHROPIC_MODEL`
// (the recorded `model` is not what ran), `CLAUDE_CODE_USE_BEDROCK` (a
// different auth path entirely), `HTTP_PROXY`/`HTTPS_PROXY` (every request
// rerouted), and `NODE_OPTIONS=--require /tmp/x.js` — arbitrary code into a
// Node CLI. None of those ends in a secret suffix, so none of them was caught.
//
// A deny-list over a namespace nobody controls can only ever be a list plus an
// omission. So the child gets a NAMED set: the handful of neutral variables a
// CLI needs to start at all, plus the names the arm declares as its own auth.
// Everything else — including every `RUNE_*` variable pointing at the measuring
// instrument — is simply not there.
//
// The consequence is deliberate: a variable an arm genuinely needs has to be
// named by that arm (`CODEX_HOME` is the worked example), which makes the
// dependency reviewable in the plan instead of implicit in the founder's shell.

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
 * The neutral variables a CLI needs to start, and nothing else.
 *
 * `PATH` finds the executable; `HOME` is where a tool keeps its own config and
 * plan login; `TMPDIR`/`TMP`/`TEMP` are where it writes scratch files;
 * `LANG`/`LC_*`/`LANGUAGE` and `TERM` decide how it renders text. Not one of
 * them can point the arm at a different host, a different model, or a
 * different auth path.
 *
 * `HOME` earns its place with a caveat worth stating: a tool's config file
 * lives under it, which is why every arm points its tool at an isolated profile
 * (`CLAUDE_CONFIG_DIR`, `RUNE_HOME`, `XDG_*`) or passes its own "ignore the
 * user's config" flag (`--ignore-user-config`, `--setting-sources project`).
 * Removing `HOME` instead would break the subscription logins these arms exist
 * to measure.
 */
export const NEUTRAL_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "LANG",
  "LANGUAGE",
] as const;

/** Locale variables, which come as a family (`LC_ALL`, `LC_CTYPE`, …). */
const NEUTRAL_ENV_PREFIXES = ["LC_"];

export function neutralEnvName(name: string): boolean {
  return (
    (NEUTRAL_ENV_NAMES as readonly string[]).includes(name) ||
    NEUTRAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The child's environment: a named neutral base, plus the arm's own auth.
 *
 * `keep` is the arm's OWN auth and configuration, named by the arm — the only
 * way anything beyond the neutral base reaches the child. A name in `keep`
 * survives whether or not it is credential-shaped; naming it is the point.
 *
 * Nothing else is inherited. There is no suffix predicate to get wrong here,
 * because nothing arrives unless it was written down.
 */
export function armEnv(
  keep: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!neutralEnvName(name) && !keep.includes(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * What a TASK adds to every arm's environment, the same for all of them.
 *
 * A browser task tells the model to import the Playwright module named by
 * `RUNE_BENCH_PLAYWRIGHT`. The prompt also carries the path (the tool sandboxes
 * filter environment variables), but an arm that could read the variable and
 * an arm that could not would not be doing the same task — so every arm gets
 * both names, or none does.
 */
export function taskEnvNames(task: Pick<ArmTask, "browser">): string[] {
  return task.browser ? ["RUNE_BENCH_PLAYWRIGHT", "PLAYWRIGHT_BROWSERS_PATH"] : [];
}

// ─── Reading a refusal ───
//
// Only a TERMINAL provider error moves a row out of the scored set. Prose that
// mentions a quota is task evidence — a model writing about rate limits is not
// a rate limit — so a parser only asks these questions of text the tool itself
// marked as an error, and a successful envelope is scored whatever its prose
// says.

const QUOTA =
  /usage limit|rate.?limit|too many requests|credit balance is too low|insufficient[_ ]quota|quota (?:exceeded|exhausted)|out of (?:credits|quota)|(?:status(?: code)?|http)[ :]*429/i;

const AUTHENTICATION =
  /invalid api.?key|invalid.bearer.token|authentication(?:_error| failed| error)|unauthorized|not (?:logged in|authenticated)|please run .?\/login|(?:oauth |refresh )?token (?:has )?expired|(?:status(?: code)?|http)[ :]*401/i;

/**
 * The provider not answering: a 5xx, an overloaded model, a dropped socket, a
 * stream that died before it completed. "Stall with no completion possible" is
 * how the tools word it when they give up on a request that never answered.
 */
const UNAVAILABLE =
  /overloaded|service unavailable|internal server error|bad gateway|gateway time-?out|(?:status(?: code)?|http)[ :]*5\d\d|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|connection (?:error|reset|refused|closed)|network (?:error|failure)|fetch failed|stream disconnected|disconnected before completion|request timed out|temporarily unavailable/i;

/**
 * The category of a terminal failure, from the tool's own error text.
 *
 * Returns a category, never the text: provider error bodies carry headers and
 * request ids, and the rig's reports are meant to be publishable.
 */
export function failureCategory(text: string): ProviderFailure | undefined {
  if (QUOTA.test(text)) return "quota";
  if (AUTHENTICATION.test(text)) return "auth";
  if (UNAVAILABLE.test(text)) return "outage";
  return undefined;
}

/**
 * A provider refusal in one event of a tool's JSON stream, or nothing.
 *
 * This was `runPilot`'s `providerFailureReason`, and it is the ONE reading
 * now: the OpenCode arm, the Rune arm and the legacy runner all ask it. Only
 * an event whose type is `error` is asked at all — a tool result that failed,
 * or text that talks about quotas, is task evidence. An error the tool itself
 * marks `recoverable` (Rune does) is one it is about to get past, and is not
 * terminal. A status code decides before any text does.
 */
export function providerFailureInEvent(event: unknown): ProviderFailure | undefined {
  if (!event || typeof event !== "object") return;
  const row = event as Record<string, unknown>;
  if (row.type !== "error") return;
  if (row.recoverable === true) return;
  const error = row.error;
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data =
    detail.data && typeof detail.data === "object" ? (detail.data as Record<string, unknown>) : {};
  const status = data.statusCode ?? detail.statusCode ?? detail.status ?? row.status;
  const message = [
    typeof error === "string" ? error : "",
    row.message,
    detail.message,
    data.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (status === 429) return "quota";
  if (status === 401) return "auth";
  const category = failureCategory(message);
  if (category) return category;
  if (typeof status === "number" && status >= 500) return "outage";
  return undefined;
}

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

/**
 * sha256 of the executable measured, when the command is exactly one file.
 *
 * `[bun, rune-cli.ts]` is two tokens and a source tree, not a binary; a bare
 * name like `claude` is whatever PATH says today. Neither is hashed, because a
 * hash of the wrong file is worse than no hash. The contract makes the field
 * optional for exactly that reason.
 */
export function binarySha256Of(command: readonly string[] | undefined): string | undefined {
  if (!command || command.length !== 1) return undefined;
  const path = command[0]!;
  if (!/[\\/]/.test(path) || !existsSync(path)) return undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}
