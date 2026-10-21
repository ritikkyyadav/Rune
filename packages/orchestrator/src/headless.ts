// ─── Headless runs ───
//
// Until this existed, nothing could drive Rune without a terminal. Every path
// through the CLI ended in the TUI, which is why the eval suite has to import
// Engine and drive it in-process, and why the external anchors its README
// scopes as P1 — Terminal-Bench, SWE-bench — were never built: the benchmark
// harnesses shell out to an agent command, and there was no command to shell
// out to.
//
// So this is not a benchmark adapter. It is the thing every benchmark adapter,
// CI step, git hook and shell pipeline needs first: one prompt in, an answer
// and an exit code out, no cursor addressing, no prompts to answer.

import { filesChangedFrom } from "./lifecycle";
import type { Engine } from "./engine";
import type {
  AgentTurnEvent,
  CompletionVerdict,
  PermissionPrompt,
  TaskLifecycle,
  UserPermissionDecision,
} from "@rune/protocol";
import { assertNeverSoft } from "@rune/protocol";
import { CHECKS_GAP, PLAN_GAP, REQUEST_GAP, verdictLine } from "./contract";

export interface HeadlessOptions {
  /** Emit a JSON envelope instead of plain text — for machine consumers. */
  json?: boolean;
  /**
   * Auto-approve every permission request.
   *
   * OFF by default, and that default matters: a headless run has nobody to ask,
   * so the alternative to denying is silently granting whatever the model
   * requests to a process nobody is watching. A benchmark inside a container
   * turns this on deliberately.
   */
  autoApprove?: boolean;
  /** Sink for progress; defaults to nothing. Never stdout — that is the answer. */
  onProgress?: (line: string) => void;
  /**
   * Emit every event as it happens, for `--stream-json`.
   *
   * A headless run reported one envelope after several minutes of silence: for
   * CI, a benchmark harness or a watching human, "still working" and "wedged"
   * looked identical. This is the same typed union every other surface reads,
   * one JSON object per line, so a consumer can render progress with the
   * protocol package and nothing else.
   */
  onEvent?: (event: AgentTurnEvent) => void;
}

export interface HeadlessResult {
  /** The assistant's final text. */
  text: string;
  /**
   * True when execution finished and no verdict made it a failure — see
   * `unfinishedVerdict` for the runs a `partial` or `unmet` verdict fails.
   */
  ok: boolean;
  /** Why it failed, when it did. */
  error?: string;
  /**
   * How the turn ENDED, verbatim from the loop's terminal event.
   *
   * `ok` is one bit and the outcomes are five: completed, incomplete (the turn
   * or token ceiling), blocked (halted), cancelled (aborted) and provider-lost.
   * Only the first is a finished task, and a consumer that cannot tell them
   * apart scores four different things as the same thing. Absent when the run
   * ended without a terminal event (a thrown turn).
   */
  stopReason?: string;
  /**
   * What the run did against what was asked (Phase 5B).
   *
   * `stopReason` says how the loop ended; this says whether it finished the
   * TASK. They are different questions and a benchmark harness was only ever
   * given the first: a run with 0 of 6 stated criteria verified ended
   * `end_turn`, `ok: true`, exit 0. Absent when no contract was in scope.
   */
  verdict?: CompletionVerdict;
  /**
   * Epoch ms when a run that stopped at a `quota_wall` can go on — the
   * provider's reset, off the terminal event. Absent on every other ending.
   */
  resumeAt?: number;
  toolCalls: number;
  toolErrors: number;
  /** Workspace-relative paths the run wrote or edited. */
  filesChanged: string[];
  /** Permission requests refused because nobody was there to approve them. */
  permissionsDenied: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  /**
   * The run's lifecycle projection, as of its last boundary.
   *
   * Before it, a machine consumer got text, two counters and a token triple:
   * the turns the run used, what it spent, which acceptance criteria it met,
   * what its plan still had open and which children it dispatched were all
   * either absent or recoverable only by reading the database. Absent when the
   * engine produced no lifecycle event (an older host, or a thrown turn).
   */
  lifecycle?: TaskLifecycle;
}

/**
 * Process exit codes: how the run ENDED, so a caller can tell why it stopped.
 *
 * Until 2026-10-14 a finished run whose own verdict was `partial` or `unmet`
 * exited 1, the same code as a crash. Every live run in the October sittings
 * did exactly that on work that passed every hidden check, and none of the
 * 163 runs recorded since 14 September ever exited 0 that way. Whether the
 * TASK was met is in the envelope (`ok`, `verdict`, `shortfall`), unchanged;
 * the exit code is execution only, as Claude Code's `-p` does it.
 * `--strict-verdict` restores the old rule for a caller that wants it.
 */
export const HEADLESS_EXIT = {
  /** The run ended on its own: the model finished its turn. */
  ok: 0,
  /** Execution failed: an error, a stall, a stopped loop, open steps, a safety halt. */
  failed: 1,
  /**
   * The run stopped because it needed permission and had no way to ask.
   * Separate from a plain failure: the fix is a flag, not a retry.
   */
  needsPermission: 3,
  /** The run stopped at a limit: turns, output tokens or budget. */
  limit: 4,
  /** The provider could not go on: a usage cap (see `resumeAt`) or lost after retries. */
  provider: 5,
  /** The run was cancelled. A signal's own code (129, 130, 143) wins over this. */
  cancelled: 130,
} as const;

/**
 * A permission handler for a run with no human attached.
 *
 * Denies by default and counts the denials, so the caller can exit with a code
 * that says "this needed approval" rather than reporting a mysterious refusal
 * as a capability failure.
 */
export function headlessPermissionHandler(
  autoApprove: boolean,
  onDenied: (prompt: PermissionPrompt) => void,
): (prompt: PermissionPrompt) => Promise<UserPermissionDecision> {
  return async (prompt) => {
    if (autoApprove) return { kind: "allow_session" };
    onDenied(prompt);
    return { kind: "deny" };
  };
}

/**
 * Run one turn to completion and return what happened.
 *
 * Deliberately consumes the same event stream the TUI does, rather than a
 * parallel "simple" path — a headless mode that diverges from the interactive
 * one measures something the product does not actually do.
 */
export async function runHeadless(
  engine: Engine,
  sessionId: string,
  prompt: string,
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const started = Date.now();
  const filesChanged = new Set<string>();
  let text = "";
  let toolCalls = 0;
  let toolErrors = 0;
  let permissionsDenied = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  // The FIRST non-recoverable error, which is the root cause; the ones after
  // it are usually consequences of the same failure.
  let fatalError: string | undefined;
  // The loop's own terminal verdict. Last one wins: a turn emits exactly one.
  let stopReason: string | undefined;
  // What the run did against the contract, off the same terminal event.
  let verdict: CompletionVerdict | undefined;
  // When a run paused at a quota wall can go on, off the same terminal event.
  let resumeAt: number | undefined;
  // The lifecycle projection, latest wins — the last one carries the ending.
  let lifecycle: TaskLifecycle | undefined;

  engine.setPermissionHandler(
    headlessPermissionHandler(opts.autoApprove === true, (p) => {
      permissionsDenied++;
      opts.onProgress?.(`permission denied (no approver): ${p.toolName} ${p.argsSummary}`);
    }),
  );

  try {
    for await (const event of engine.chat(sessionId, prompt) as AsyncIterable<AgentTurnEvent>) {
      // Before the reducer, so a consumer sees the raw event whatever this
      // function chooses to count.
      opts.onEvent?.(event);
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        // A retry or provider failover re-streams the answer from the top. The
        // TUI clears its buffer here; so must this, or a fallback mid-turn
        // yields the answer twice concatenated.
        case "stream_reset":
          text = "";
          break;
        case "tool_call_start":
          // A delegation runs for minutes; its start is news. An ordinary
          // tool's start was a bare "→ read_file" that said nothing the
          // finished row does not say better; the CLI prints that row from
          // the end event (this module is engine-side and draws nothing).
          if (event.toolName === "task" || event.toolName === "worker") {
            opts.onProgress?.(`→ ${event.toolName}`);
          }
          break;
        case "tool_call_end": {
          toolCalls++;
          if (!event.output?.success) toolErrors++;
          // One predicate, shared with the transcript, the footer and the
          // auto-commit scope. This counted `write_file|edit_file|multi_edit`
          // and nothing else, so a run whose writes came from a worker or an
          // `apply_patch` reported `filesChanged: []` while the engine's own
          // commit contained every one of them.
          if (event.output?.success) {
            for (const path of filesChangedFrom(
              event.output.toolName,
              event.args,
              event.output.result,
            )) {
              filesChanged.add(path);
            }
          }
          break;
        }
        case "usage":
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          cacheReadTokens += event.cacheReadTokens ?? 0;
          break;
        case "notice":
        case "context_warning":
          opts.onProgress?.(event.message);
          break;

        // ── Named and deliberately not counted ──
        // A headless run reports what the turn DID: text, tools, files, usage.
        // These carry no counter of their own here, but they are named rather
        // than defaulted so a member added upstream is a compile error until
        // this reducer has decided what it means for a machine consumer.
        // ── A terminal error fails the run ──
        // This case used to sit in the ignored group below, so a provider
        // failure (no credits, a retired model, a bad key) was swallowed: the
        // loop completed, `ok` came back true and the process exited 0 with an
        // empty answer. A benchmark harness shelling out to `rune -P` scored
        // every one of those as a pass. Only NON-recoverable errors count —
        // the engine retries and falls back on its own, and treating a
        // recovered error as a failure would fail runs that in fact succeeded.
        case "error":
          if (!event.recoverable && fatalError === undefined) {
            fatalError = event.error;
            opts.onProgress?.(`error: ${event.error}`);
          }
          break;

        // ── The terminal verdict ──
        // It used to sit in the ignored group, so a run the user CANCELLED,
        // one the supervisor HALTED and one that ran out of turns all
        // reported ok:true and exited 0 with whatever partial text they had.
        // Nothing about that says the task was done.
        case "turn_complete":
          stopReason = event.stopReason;
          if (event.verdict) verdict = event.verdict;
          resumeAt = event.resumeAt;
          break;

        // ── The lifecycle projection ──
        // Latest wins: the run emits one at every boundary and the last is the
        // one that describes how it ended. Carried into the envelope so a
        // machine consumer reads the turns, the spend, the plan and the
        // children from the same projection the TUI drew.
        case "lifecycle":
          lifecycle = event.lifecycle;
          break;

        case "thinking_delta":
        case "tool_call_args_delta":
        case "verification_started":
        case "verification_completed":
        case "todo_updated":
        case "step_check":
        case "fallback":
        case "retry":
        case "compaction":
        case "checkpoint_saved":
        case "handoff":
        case "replanning":
        case "tool_progress":
        // The narrative is state, and a headless consumer reads it from the
        // session log (`rune audit --record`, the signed export) rather than
        // from a stream it may have joined halfway through. `--stream-json`
        // still carries every one of these on the wire; this is the runner's
        // own summary, and a hypothesis is not one of its counters.
        case "task_kind":
        case "hypothesis":
        case "hypothesis_updated":
        case "decision":
        case "artifact":
        case "pending_decision":
        case "decision_resolved":
        case "decision_record":
          break;

        default:
          // Compile-time exhaustiveness (see @rune/protocol assertNever).
          assertNeverSoft(event, undefined);
          break;
      }
    }
  } catch (err) {
    return {
      text,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(stopReason ? { stopReason } : {}),
      ...(verdict ? { verdict } : {}),
      ...(resumeAt !== undefined ? { resumeAt } : {}),
      toolCalls,
      toolErrors,
      filesChanged: [...filesChanged],
      permissionsDenied,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      durationMs: Date.now() - started,
      ...(lifecycle ? { lifecycle } : {}),
    };
  }

  const unfinished = stopReason ? UNFINISHED_STOP[stopReason] : undefined;
  const error = fatalError ?? unfinished ?? unfinishedVerdict(verdict, [...filesChanged]);
  return {
    // The verdict is the LAST line of the answer, so `rune -P "…"` — whose
    // stdout is `text` verbatim — ends by saying what the run did against what
    // was asked. Appended only when a contract was in scope; a caller driving
    // the engine without one reads exactly what it read before.
    text: verdict ? `${text}${text.endsWith("\n") ? "" : "\n"}${verdictLine(verdict)}` : text,
    ok: error === undefined,
    ...(error === undefined ? {} : { error }),
    ...(stopReason ? { stopReason } : {}),
    ...(verdict ? { verdict } : {}),
    ...(resumeAt !== undefined ? { resumeAt } : {}),
    toolCalls,
    toolErrors,
    filesChanged: [...filesChanged],
    permissionsDenied,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    durationMs: Date.now() - started,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

/**
 * Terminal verdicts that are NOT a completed task, and the one line each one
 * owes the caller. `end_turn` is the only finished outcome; `provider_lost`
 * already raises its own non-recoverable error and keeps that wording.
 */
export const UNFINISHED_STOP: Record<string, string | undefined> = {
  aborted: "The run was cancelled before it finished; the output above is partial.",
  halted: "The run was halted before it finished; the output above is its report.",
  max_turns: "The run hit its turn ceiling without finishing; the output above is partial.",
  max_tokens: "The response hit the output-token limit; the output above is partial.",
  // The plan said N steps and the run ended with some of them open, after the
  // gate had already refused the finish once. This reported `ok: true` and
  // exit 0 — a benchmark harness shelling out to `rune -P` scored a run that
  // abandoned half its plan as a completed task.
  open_steps: "The run ended with planned steps still open; the task is not finished.",
  // The provider stopped answering after the retry budget. It raises its own
  // non-recoverable error, but a run whose plan was already closed ends here
  // with no error at all, and silence read as success.
  provider_lost:
    "The provider stopped answering before the run finished; the output above is partial.",
  // The gateway's own sentence already says when; this is the line a run owes
  // when that error was not the first one recorded.
  quota_wall:
    "The provider's usage limit was reached and the run paused; it can resume when the limit resets.",
  // Nothing new happened for many turns and the loop stopped it. Both stall
  // paths used to emit no terminal event whatsoever, so the envelope carried
  // an `error` and no `stopReason` key — JSON.stringify drops undefined.
  stalled: "The run stopped because nothing new was happening; the task is not finished.",
  // ── What the HARNESS stopped (Phase 5B) ──
  // All three emitted no terminal event at all, so the envelope carried an
  // `error` with no `stopReason` key and the lifecycle row read `provider_lost`
  // — a benchmark harness could not tell a killed loop from a dead network.
  loop_detected:
    "The harness stopped a repeating tool loop; nothing was progressing and the task is not finished.",
  barren:
    "Every tool call was refused before it ran; the run could not reach the workspace and the task is not finished.",
  budget:
    "The request was refused before it was sent because the run was out of budget; the task is not finished.",
};

/**
 * A verdict that makes a finished run a FAILED one — and what has to be true
 * before it can.
 *
 * `partial` and `unmet` are about a promise: the run was held to terms and did
 * not show all of them. So there has to have been a promise, and something it
 * was about.
 *
 *   - No criteria at all: nothing was promised. A greeting, a first prompt and
 *     a one-line answer end `unmet` ("no criteria stated") by construction.
 *   - Only the run's own read-back, and no file changed: an answer, a review, a
 *     plan. Its criteria describe an ANSWER, there is nothing to run, and the
 *     best verdict such a run can reach is `partial` (see `VerdictEvaluators`).
 *
 * Both are judged by whether they ran, as they were before this rule existed.
 * The first version of it had none of this, and a plain "hello", a fresh
 * install's first prompt and the pull-request review all exited 1.
 *
 * A criterion from OUTSIDE the run — the person's, or an `--acceptance` check —
 * is held whether or not anything changed: a run asked to build something that
 * changed nothing is the clearest failure there is.
 */
export function unfinishedVerdict(
  verdict: CompletionVerdict | undefined,
  filesChanged: readonly string[],
): string | undefined {
  if (verdict?.kind !== "unmet" && verdict?.kind !== "partial") return undefined;
  if (verdict.criteria.length === 0) return undefined;
  const ownWordsOnly = verdict.criteria.every((c) => (c.source ?? "inferred") === "inferred");
  if (ownWordsOnly && filesChanged.length === 0) return undefined;
  return `The task is ${verdict.kind}; the completion criteria were not all satisfied.`;
}

/**
 * Why a finished run's verdict is short of `met` — three different facts that
 * `partial` and `unmet` each cover, and that a reader has until now had to
 * work out from the gap text.
 *
 *   observed_failure   something was SEEN to fall short: a criterion's bound
 *                      check failed, a check's last run failed, or planned
 *                      steps were left open.
 *   outside_terms      nothing was seen to fail, and a criterion from outside
 *                      the run — the person's, or an `--acceptance` check — is
 *                      not satisfied.
 *   own_terms_unshown  nothing was seen to fail, and every criterion that is
 *                      short is one the run wrote for itself and could not
 *                      show: no check bound, evidence that only a person can
 *                      settle, a test the run authored.
 *
 * Recorded 2026-10-07 to 2026-10-09 on six benchmark runs
 * (`~/rune-evidence/b2-s5…`, `b2-s6…`, `design-ab2…`): five ended `partial`
 * and all five were the third kind but one, which also had a red check. In an
 * empty folder there is no check that existed before the run, so a build from
 * nothing that reads its plan back can reach no other ending.
 *
 * This changes nothing about what a run exits with: `unfinishedVerdict` is
 * exactly as it was. It is the same verdict, said so that "could not show its
 * own terms" and "a check failed" are not one word.
 */
export type VerdictShortfall = "observed_failure" | "outside_terms" | "own_terms_unshown";

export function verdictShortfall(
  verdict: CompletionVerdict | undefined,
): VerdictShortfall | undefined {
  if (verdict?.kind !== "unmet" && verdict?.kind !== "partial") return undefined;
  if (verdict.criteria.length === 0) return undefined;
  const seenToFail =
    verdict.criteria.some((c) => c.status === "failed") ||
    (verdict.kind === "partial" &&
      verdict.gaps.some(
        (g) =>
          g.criterion === PLAN_GAP || g.criterion === CHECKS_GAP || g.criterion === REQUEST_GAP,
      ));
  if (seenToFail) return "observed_failure";
  const outside = verdict.criteria.some(
    (c) =>
      (c.source ?? "inferred") !== "inferred" && c.required !== false && c.status !== "satisfied",
  );
  return outside ? "outside_terms" : "own_terms_unshown";
}

/**
 * How a headless run ended, in one word — the envelope's `subtype`, named as
 * Claude Code's `-p` result names its own.
 *
 *   success                 the model finished its turn. Whether the TASK was
 *                           met is the verdict's to say, not this.
 *   error_max_turns         the turn ceiling
 *   error_max_tokens        the output-token limit
 *   error_budget            the run's budget refused the next request
 *   error_quota             a provider usage cap; `resumeAt` says when it lifts
 *   error_provider          the provider stopped answering after the retries
 *   error_halted            the safety broker halted the run
 *   error_open_steps        the loop ended the run with its own planned steps
 *                           still open, after refusing the finish once (G21)
 *   error_cancelled         the run was cancelled
 *   error_during_execution  anything else: an error, a stall, a stopped loop
 *
 * `open_steps` is an ending, not a verdict: the loop itself stopped a run that
 * left its own plan undone. What the exit code no longer follows is a verdict
 * the run could not SHOW (`partial` or `unmet` on terms it wrote itself).
 */
export type HeadlessSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_tokens"
  | "error_budget"
  | "error_quota"
  | "error_provider"
  | "error_halted"
  | "error_open_steps"
  | "error_cancelled"
  | "error_during_execution";

const SUBTYPE_OF_STOP: Record<string, HeadlessSubtype> = {
  end_turn: "success",
  open_steps: "error_open_steps",
  max_turns: "error_max_turns",
  max_tokens: "error_max_tokens",
  budget: "error_budget",
  quota_wall: "error_quota",
  provider_lost: "error_provider",
  halted: "error_halted",
  aborted: "error_cancelled",
  stalled: "error_during_execution",
  loop_detected: "error_during_execution",
  barren: "error_during_execution",
};

export function headlessSubtype(r: HeadlessResult): HeadlessSubtype {
  const fromStop = r.stopReason ? SUBTYPE_OF_STOP[r.stopReason] : undefined;
  // A provider's own stop words (`tool_use`, `stop`) are an ordinary finish,
  // exactly as `statusFromStopReason` reads them. No terminal event at all is
  // a host older than it, judged by whether it raised: a thrown turn always
  // carries an error.
  const subtype = fromStop ?? (r.stopReason || r.ok ? "success" : "error_during_execution");
  // A finish that carries an error the loop did not attribute — a provider
  // refusal, a thrown turn — is not a success. A verdict-only shortfall is.
  if (
    subtype === "success" &&
    r.error &&
    r.error !== unfinishedVerdict(r.verdict, r.filesChanged)
  ) {
    const own = r.stopReason ? UNFINISHED_STOP[r.stopReason] : undefined;
    if (r.error !== own) return "error_during_execution";
  }
  return subtype;
}

const EXIT_OF_SUBTYPE: Record<HeadlessSubtype, number> = {
  success: HEADLESS_EXIT.ok,
  error_max_turns: HEADLESS_EXIT.limit,
  error_max_tokens: HEADLESS_EXIT.limit,
  error_budget: HEADLESS_EXIT.limit,
  error_quota: HEADLESS_EXIT.provider,
  error_provider: HEADLESS_EXIT.provider,
  error_halted: HEADLESS_EXIT.failed,
  error_open_steps: HEADLESS_EXIT.failed,
  error_cancelled: HEADLESS_EXIT.cancelled,
  error_during_execution: HEADLESS_EXIT.failed,
};

/**
 * The exit code a result deserves: how it ended (`headlessSubtype`).
 *
 * `strictVerdict` is the rule before 2026-10-14 for a caller that wants it: a
 * finished run whose verdict is short of what it was held to exits 1.
 */
export function headlessExitCode(
  r: HeadlessResult,
  opts: { strictVerdict?: boolean } = {},
): number {
  // Checked BEFORE everything, because a denied permission does not raise: the
  // turn completes, the model explains it could not write the file, and `ok`
  // is true. Observed exactly that — a run that created nothing exiting 0.
  // A caller reading only the exit code would record a success.
  //
  // A blocked run is a configuration problem, not a capability one, and a
  // benchmark that cannot tell them apart scores the agent for the harness's
  // missing flag.
  if (r.permissionsDenied > 0) return HEADLESS_EXIT.needsPermission;
  const subtype = headlessSubtype(r);
  if (subtype === "success" && opts.strictVerdict) {
    if (!r.ok || unfinishedVerdict(r.verdict, r.filesChanged)) return HEADLESS_EXIT.failed;
  }
  return EXIT_OF_SUBTYPE[subtype];
}

/**
 * What a machine consumer reads off stdout.
 *
 * `compact` matters for `--stream-json`: every line of that output must be one
 * JSON object, and a pretty-printed envelope spread over eighteen lines is not
 * NDJSON — a consumer reading line by line would choke on the last record.
 * `--json` on its own keeps the indented form, which is what a person reads.
 */
export function headlessEnvelope(
  r: HeadlessResult,
  opts: { compact?: boolean; sessionId?: string } = {},
): string {
  return JSON.stringify(
    {
      ok: r.ok && !unfinishedVerdict(r.verdict, r.filesChanged),
      // The session this run wrote, so a caller can read it back with
      // `rune audit <id>`. CI otherwise has to guess with `rune audit last`,
      // which on a shared runner is a different session's page.
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      text: r.text,
      error: r.error ?? unfinishedVerdict(r.verdict, r.filesChanged),
      // How it ended, so "cancelled", "out of turns" and "done" are three
      // different answers to a machine consumer, not one boolean.
      stopReason: r.stopReason,
      // …the same, in the words the exit code is chosen by.
      subtype: headlessSubtype(r),
      // …and, for a run paused at a usage cap, when it can go on (epoch ms).
      ...(r.resumeAt !== undefined ? { resumeAt: r.resumeAt } : {}),
      // …and what it did against what was ASKED, which is a different
      // question: `end_turn` with none of the stated criteria verified is a
      // finished loop and an unfinished task.
      verdict: r.verdict,
      // …and, when it is short of `met`, which of three things that means.
      ...(verdictShortfall(r.verdict) ? { shortfall: verdictShortfall(r.verdict) } : {}),
      toolCalls: r.toolCalls,
      toolErrors: r.toolErrors,
      filesChanged: r.filesChanged,
      permissionsDenied: r.permissionsDenied,
      usage: {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
      },
      durationMs: r.durationMs,
      // The lifecycle projection: the id, the objective, the constraints and
      // their rungs, the workspace revision, the budget actually used, the
      // plan as it stands and the children this run dispatched. Omitted
      // entirely when there is none, so the envelope never carries a null
      // shape a consumer would have to special-case.
      ...(r.lifecycle ? { lifecycle: r.lifecycle } : {}),
    },
    null,
    opts.compact ? undefined : 2,
  );
}
