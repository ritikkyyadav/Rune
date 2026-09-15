/**
 * The arbiter — a pure decision function over a versioned snapshot.
 *
 * `decide(state, event) → Decision` is a function of two values. It cannot
 * call a tool, sleep, mutate a counter, allocate a budget, produce a prompt,
 * or touch the gateway; it has no `this`, no module state, and no clock. That
 * is the entire contract of M2 (`docs/program/m2-shadow-controller.md`, "the
 * one rule"), and it is what makes the shadow lane honest: a decision function
 * that could act would not be observing the guards, it would be racing them.
 *
 * What it decides FROM is the inventory's six-class ladder
 * (`guard-inventory-20260914.md` §4.0):
 *
 * ```
 * 0  user            abort, interjection
 * 1  safety          supervisor halt, containment halt
 * 2  budget          spend cap, turn ceiling, sub-agent cost/deadline
 * 3  environment     provider lost, quota wall, context exhausted, empty completions
 * 4  contract        the completion verdict, and the gates that derive from it
 * 5  progress        loop detector, recurrence, barren, stale turns, breakers
 * ```
 *
 * Two rules on top of the ladder carry all its weight:
 *
 *   * **Class 5 never proposes `complete`.** A progress heuristic may stop a
 *     run; it may not declare it finished. That single rule is what turns G9
 *     — an empty completion accepted as a successful finish — from today's
 *     silent behaviour into a recorded disagreement.
 *   * **A terminal transition is absorbing for that run id.** Once a run has
 *     decided `complete(...)` or `abandoned(...)`, a later event on the same
 *     run decides `unknown: run already terminal`. The arbiter reads this from
 *     `state.phase`, which is why the phase is an input and not a field the
 *     function keeps.
 *
 * And one rule under it: **a missing input is an unknown, never agreement**
 * (the review's P1 row; M2 exit S5). Every predicate below names the inputs it
 * requires and answers `unknown` when one of them is absent.
 */

import { TERMINAL_PHASES, type RunState } from "./run-state";

// ─── Vocabulary ───

export type DecisionClass = 0 | 1 | 2 | 3 | 4 | 5;

/** Why a run ended without completing. Deliberately NOT `provider_lost`: four
 *  different exits used to record as a dead network, and naming them is half
 *  the value of the ladder (M2 exit S7). */
export type AbandonReason =
  "user_abort" | "halt" | "budget" | "environment" | "no_progress" | "blocked";

/**
 * A phase transition, as a canonical string.
 *
 * A string rather than a tagged object so that `decision.transition ===
 * actual.transition` is a literal comparison, a row is one short field, and a
 * replay hash is a plain `JSON.stringify` (M2 exit S1).
 */
export type Transition =
  | "working"
  | "verifying"
  | "repairing"
  | "blocked(ask)"
  | "blocked(halt)"
  | "unknown"
  | `complete(${string})`
  | `abandoned(${AbandonReason})`;

export function complete(kind: string): Transition {
  return `complete(${kind})`;
}

export function abandoned(reason: AbandonReason): Transition {
  return `abandoned(${reason})`;
}

export function isTerminalTransition(t: Transition): boolean {
  return t.startsWith("complete(") || t.startsWith("abandoned(");
}

/**
 * The guards this arbiter has a rule for, by the inventory's names.
 *
 * The sixteen that shadow cleanly (§4.3) minus R17, which fires only inside a
 * sub-agent loop (shadow is off there by design), plus E3 as the proof case,
 * plus G9 — the empty-completion acceptance the class-5 rule exists to catch —
 * plus the completion verdict, plus the four progress-class exits, which have
 * rules here so their proposals can be compared even though no site observes
 * them in M2.
 */
export type GuardId =
  | "E1"
  | "E2"
  | "E3"
  | "E4"
  | "E5"
  | "E6"
  | "E7"
  | "E8"
  | "E9"
  | "E10"
  | "E11"
  | "E12"
  | "G0"
  | "G3"
  | "G4"
  | "G5"
  | "G6"
  | "G7"
  | "G8"
  | "G9"
  | "R17"
  | "X2"
  | "VERDICT"
  // ── The six repair classes (M4) ──
  // One guard id per class in `repair.ts`, so the ladder's table stays a
  // straight `guard → class` map and a row names the class it acted on.
  | "REPAIR_TRANSPORT"
  | "REPAIR_CHECK"
  | "REPAIR_ACCEPTANCE"
  | "REPAIR_DEPENDENCY"
  | "REPAIR_DENIED"
  | "REPAIR_PROGRESS";

/** Guard → class, straight from §4.1. */
export const GUARD_CLASS: Readonly<Record<GuardId, DecisionClass>> = {
  E2: 0,
  G0: 0,
  E3: 1,
  E1: 2,
  E7: 2,
  X2: 2,
  R17: 2,
  E4: 3,
  E5: 3,
  E6: 3,
  E8: 3,
  G9: 3,
  G3: 4,
  G4: 4,
  G5: 4,
  G6: 4,
  G7: 4,
  G8: 4,
  VERDICT: 4,
  E9: 5,
  E10: 5,
  E11: 5,
  E12: 5,
  // M4. A repair's class is the class of the FAILURE, not of the repair: a
  // denied action is safety whatever the response is, a dead socket is
  // environment, a red check and a failed criterion are the contract, and a
  // rut is progress — which is why `REPAIR_PROGRESS` can never propose
  // `complete`.
  REPAIR_DENIED: 1,
  REPAIR_TRANSPORT: 3,
  REPAIR_DEPENDENCY: 3,
  REPAIR_CHECK: 4,
  REPAIR_ACCEPTANCE: 4,
  REPAIR_PROGRESS: 5,
};

export const GUARD_IDS = Object.keys(GUARD_CLASS) as GuardId[];

/**
 * The guards M2 does NOT shadow, with the reason from §4.3.
 *
 * Named rather than absent: "we did not observe this" is a decision, and a
 * decision that lives only in a gap looks exactly like an oversight. The
 * summary reports which of these a run actually hit.
 */
export const UNSHADOWED_GUARDS: ReadonlyMap<string, string> = new Map([
  ["X1", "the refund decides inside report(), an observability callback that mutates maxTurns"],
  ["R3", "a refused call substitutes a manufactured tool result"],
  ["R4", "the same-shape streak advances inside result processing"],
  ["E9", "the loop detector answers the repeated batch; shadowing it means letting it run"],
  ["E10", "the recurrence nudge rewrites the result it read"],
  [
    "E11",
    "the barren streak is advanced inside result processing, from refusal flags the site does not own",
  ],
  ["G1", "the only guard whose action costs real time — shadow the predicate, never the run"],
  ["G2", "the replan nudge appends a message and zeroes verifyAttempts"],
  ["E12", "seenResults.add() happens during the read — the predicate is not idempotent"],
  ["G4w", "three writers, one reader, and an equality between counters as the invariant"],
  ["N3", "the tool pacer sleeps invisibly"],
  ["R16", "the containment defer pushes onto AutoMode.deferrals"],
  ["R17", "fires only inside a sub-agent loop, where shadow is off by design"],
]);

// ─── Events and decisions ───

/** The predicate's own booleans and counters. Never message text, never tool
 *  arguments, never credentials — enforced by the sanitizer in
 *  `shadow-arbiter.ts` and grepped for by a test. */
export type GuardInputs = Readonly<Record<string, unknown>>;

export interface ShadowEvent {
  /** `${runId}:${seq}` — stable identity for the event and its decision. */
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  /** ISO timestamp. Recorded, never read by `decide` — a pure function of two
   *  values cannot depend on when it ran. */
  readonly at: string;
  readonly guard: GuardId;
  readonly class: DecisionClass;
  readonly inputs: GuardInputs;
}

export interface Decision {
  readonly id: string;
  readonly eventId: string;
  readonly transition: Transition;
  readonly class: DecisionClass;
  readonly reason: string;
  /**
   * Always false, in M3 as in M2: `decide` is a function, and a function
   * applies nothing. When a migrated SITE acts on a decision it writes an
   * `AppliedDecisionRow` — that row, and only that row, says `applied: true`.
   */
  readonly applied: false;
  /** Set by `arbitrate` when a lower-class event in the same step won. */
  readonly supersededBy?: string;
}

// ─── Authority (M3) ───

/**
 * The decisions the controller may OWN rather than shadow.
 *
 * `[controller] authority` names them. Empty — the default — means the
 * controller decides nothing and every guard keeps its own predicate, which is
 * exactly M2's behaviour and the rollback position for every branch M3
 * migrates (`docs/program/m3-first-migration.md`, "Migration mechanics").
 */
export const AUTHORITY_KEYS = [
  "E4",
  // The six repair classes (M4). Every one absent by default; each is its own
  // rollback switch, and the `legacy()` closure at its site is what stands
  // when it is absent.
  "transport",
  "check_failed",
  "acceptance",
  "missing_dependency",
  "denied",
  "no_progress",
] as const;
export type AuthorityKey = (typeof AUTHORITY_KEYS)[number];

/**
 * Read `[controller] authority` into a set.
 *
 * Accepts the TOML array (`authority = ["E4"]`) and the string the settings
 * writer persists (`authority = "E4"`, `"E4,acceptance"`). An unknown token is
 * DROPPED rather than throwing: a typo in a config file must not fail a run,
 * and a key this build does not know is a key it cannot honour. Matching is
 * case-insensitive on the token, never on the meaning.
 */
export function parseAuthority(
  /** `string | readonly string[]` in the type; ANY JSON/TOML scalar at runtime. */
  value: unknown,
): ReadonlySet<AuthorityKey> {
  const out = new Set<AuthorityKey>();
  if (value === undefined || value === null) return out;
  // The SHAPE is narrowed here, not only the tokens. `config.toml` is a file a
  // person edits by hand, and `authority = 4` arrives from the TOML reader as
  // the number 4: reaching `.flatMap` on it killed the run before its first
  // model call, on a line whose whole promise is that a typo is a no-op.
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const tokens = list.flatMap((t) => (typeof t === "string" ? [t.trim()] : []));
  for (const token of tokens) {
    if (token.length === 0) continue;
    const match = AUTHORITY_KEYS.find((k) => k.toLowerCase() === token.toLowerCase());
    if (match) out.add(match);
  }
  return out;
}

/**
 * What a site writes when it ACTS on a decision, before it acts.
 *
 * The row is the reconciliation record the resume path reads: a crash between
 * the row and the act leaves the row, and the act is idempotent, so the
 * resumed run does not do it twice (M3 mechanics 2). It is a row of its own
 * type — like `contract`, `verdict` and the shadow rows — and not an
 * `AgentTurnEvent`: no surface renders it and `replayEvents` skips it.
 *
 * `inputs` is sanitised by the same function the shadow rows use, so this row
 * cannot carry message text, tool arguments or credentials either.
 */
export interface AppliedDecisionRow {
  readonly type: "decision";
  readonly version: 1;
  readonly runId: string;
  readonly eventId: string;
  readonly decisionId: string;
  readonly guard: GuardId;
  readonly class: DecisionClass;
  readonly transition: Transition;
  readonly applied: true;
  readonly reason: string;
  readonly inputs: Record<string, unknown>;
  readonly at: string;
}

export const APPLIED_DECISION_ROW_VERSION = 1 as const;

/** What the guard's own code DID, recorded at the same site from the same booleans. */
export interface Actual {
  readonly eventId: string;
  readonly transition: Transition;
}

export function makeShadowEvent(
  runId: string,
  seq: number,
  guard: GuardId,
  inputs: GuardInputs,
  at: string,
): ShadowEvent {
  return {
    id: `${runId}:${seq}`,
    runId,
    seq,
    at,
    guard,
    class: GUARD_CLASS[guard],
    inputs,
  };
}

// ─── Input reading ───

/** A required boolean. `undefined` (or a non-boolean) is a missing input. */
function bool(inputs: GuardInputs, key: string): boolean | undefined {
  const v = inputs[key];
  return typeof v === "boolean" ? v : undefined;
}

/** A required finite number. Anything else is a missing input. */
function num(inputs: GuardInputs, key: string): number | undefined {
  const v = inputs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(inputs: GuardInputs, key: string): string | undefined {
  const v = inputs[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface Proposal {
  transition: Transition;
  reason: string;
}

/**
 * A number the SITE could read, or the snapshot's copy of it.
 *
 * The snapshot is the second input, not decoration: a site that cannot see a
 * counter (the verdict site does not hold the turn number) still decides from
 * state when the state holds it. Only when neither has it is the input
 * missing, and then the answer is `unknown`.
 */
function numOf(
  inputs: GuardInputs,
  key: string,
  fromState: number | undefined,
): number | undefined {
  return num(inputs, key) ?? fromState;
}

function boolOf(
  inputs: GuardInputs,
  key: string,
  fromState: boolean | undefined,
): boolean | undefined {
  return bool(inputs, key) ?? fromState;
}

/** The answer when a required input is absent. Counted as an unknown by the
 *  summary, and never as agreement — even when the guard happened to be right. */
function missing(...keys: string[]): Proposal {
  return {
    transition: "unknown",
    reason: `missing input: ${keys.join(", ")}`,
  };
}

// ─── The per-guard proposals (§4.1) ───

function propose(state: RunState | undefined, event: ShadowEvent): Proposal {
  const i = event.inputs;
  switch (event.guard) {
    // ── 0 user ──
    case "E2": {
      const aborted = bool(i, "aborted");
      if (aborted === undefined) return missing("aborted");
      return aborted
        ? { transition: abandoned("user_abort"), reason: "the user aborted the run" }
        : { transition: "working", reason: "no abort signalled" };
    }
    case "G0": {
      const pending = bool(i, "pending");
      if (pending === undefined) return missing("pending");
      return pending
        ? { transition: "working", reason: "the user steered mid-run; the finish is cancelled" }
        : { transition: "working", reason: "no interjection pending" };
    }

    // ── 1 safety ──
    case "E3": {
      const halted = bool(i, "halted");
      if (halted === undefined) return missing("halted");
      if (!halted) return { transition: "working", reason: "no halt latched" };
      const granted = bool(i, "reportGranted");
      if (granted === undefined) return missing("reportGranted");
      return granted
        ? {
            transition: complete("report_only"),
            reason: "the halted run wrote its report; nothing else may run",
          }
        : {
            transition: "blocked(halt)",
            reason: "the safety broker halted the run; one tool-free report turn is owed",
          };
    }

    // ── 2 budget ──
    case "E1": {
      const turn = numOf(i, "turn", state?.budget.turn);
      const maxTurns = numOf(i, "maxTurns", state?.budget.maxTurns);
      const wind = bool(i, "secondWindAvailable");
      if (turn === undefined || maxTurns === undefined || wind === undefined) {
        return missing("turn", "maxTurns", "secondWindAvailable");
      }
      if (turn < maxTurns) return { transition: "working", reason: "turns remain" };
      return wind
        ? { transition: "working", reason: "the ceiling extended itself" }
        : {
            transition: abandoned("budget"),
            reason: `the turn ceiling (${maxTurns}) was reached and no wind was available`,
          };
    }
    case "E7": {
      const refused = bool(i, "admissionRefused");
      if (refused === undefined) return missing("admissionRefused");
      return refused
        ? {
            transition: abandoned("budget"),
            reason: "the gateway refused admission on budget before the request was sent",
          }
        : { transition: "working", reason: "admission granted" };
    }
    case "X2": {
      const granted = bool(i, "granted");
      if (granted === undefined) return missing("granted");
      return granted
        ? { transition: "working", reason: "the plan is open and moving; the ceiling extends" }
        : { transition: abandoned("budget"), reason: "no wind available at the ceiling" };
    }
    case "R17": {
      const breached = bool(i, "breached");
      if (breached === undefined) return missing("breached");
      return breached
        ? {
            transition: abandoned("budget"),
            reason: "the delegated child ran past its cost or time budget; its result is retained",
          }
        : { transition: "working", reason: "the child is inside its budget" };
    }

    // ── 3 environment ──
    case "E4": {
      const seen = num(i, "emptyCompletions");
      const max = num(i, "maxEmpty");
      const stands = bool(i, "workStands");
      if (seen === undefined || max === undefined || stands === undefined) {
        return missing("emptyCompletions", "maxEmpty", "workStands");
      }
      if (seen < max) {
        return { transition: "working", reason: `empty completion ${seen} of ${max} — retrying` };
      }
      // At the allowance with work standing the loop stops retrying and falls
      // into the finish path; the verdict there decides whether the run is
      // done. M2 answered `working` here and left the finish to G9's rule —
      // true of the loop, but not a transition anyone could act on, and M3
      // acts on this one (`docs/program/m3-first-migration.md`).
      return stands
        ? {
            transition: "verifying",
            reason: "the work stands; the finish path decides whether it completed",
          }
        : {
            transition: abandoned("environment"),
            reason: `${max} empty completions in a row and nothing to stand on`,
          };
    }
    case "G9": {
      // An empty completion is an ENVIRONMENT fault, and an environment fault
      // may never itself declare a run complete: only a verdict says what was
      // completed. What the site does when work stands is stop retrying and
      // fall into the finish path, so the honest transition is `verifying` —
      // the verdict below decides (M3, `docs/program/m3-first-migration.md`).
      // With nothing standing there is nothing to verify and the run is
      // abandoned on the environment.
      const stands = bool(i, "workStands");
      const hasVerdict = bool(i, "hasVerdict");
      if (stands === undefined || hasVerdict === undefined) {
        return missing("workStands", "hasVerdict");
      }
      if (!hasVerdict) {
        return stands
          ? {
              transition: "verifying",
              reason:
                "the work stands and no verdict is in hand here — the finish path decides " +
                "whether it completed; an empty completion is not itself a completion",
            }
          : {
              transition: abandoned("environment"),
              reason:
                "the model returned nothing and there is no work to stand on — " +
                "an empty completion is not a completion",
            };
      }
      const kind = str(i, "verdictKind");
      if (kind === undefined) return missing("verdictKind");
      return {
        transition: complete(kind),
        reason: `the run's own verdict is ${kind}, so the empty completion stands on it`,
      };
    }
    case "E5": {
      const errors = num(i, "consecutiveErrors");
      const max = num(i, "maxConsecutiveErrors");
      const planClosed = bool(i, "planClosed");
      if (errors === undefined || max === undefined || planClosed === undefined) {
        return missing("consecutiveErrors", "maxConsecutiveErrors", "planClosed");
      }
      if (errors < max) return { transition: "working", reason: "inside the error budget" };
      return planClosed
        ? {
            transition: complete("end_turn"),
            reason: "the provider stopped answering after every planned step was done",
          }
        : {
            transition: abandoned("environment"),
            reason: `${errors} consecutive provider errors with the plan still open`,
          };
    }
    case "E6": {
      const retryable = bool(i, "retryable");
      if (retryable === undefined) return missing("retryable");
      return retryable
        ? { transition: "working", reason: "the provider error is retryable" }
        : {
            transition: abandoned("environment"),
            reason: "the provider failed non-retryably and no retry window was advertised",
          };
    }
    case "E8": {
      const retries = num(i, "truncationRetries");
      const max = num(i, "maxTruncationRetries");
      if (retries === undefined || max === undefined) {
        return missing("truncationRetries", "maxTruncationRetries");
      }
      return retries < max
        ? { transition: "working", reason: "asking the model to continue past the token limit" }
        : {
            transition: abandoned("environment"),
            reason: `the response hit the output-token limit ${retries} times`,
          };
    }

    // ── 4 contract ──
    case "G3": {
      const scopes = num(i, "delegatedScopes");
      const unread = num(i, "unreadScopes");
      const fired = num(i, "fired");
      if (scopes === undefined || unread === undefined || fired === undefined) {
        return missing("delegatedScopes", "unreadScopes", "fired");
      }
      return unread > 0 && fired < 1
        ? {
            transition: "verifying",
            reason: `${unread} of ${scopes} delegated scopes were never read`,
          }
        : { transition: "working", reason: "the delegation gate has nothing to refuse" };
    }
    case "G4": {
      const wrote = boolOf(i, "anyWritesThisRun", state?.evidence.anyWritesThisRun);
      const executed = boolOf(i, "executedSinceWrite", state?.evidence.executedSinceWrite);
      const checks = boolOf(i, "projectChecksPassed", state?.evidence.projectChecksPassed);
      const settled = boolOf(i, "planSettled", state?.evidence.planSettled);
      const fired = num(i, "fired");
      if (
        wrote === undefined ||
        executed === undefined ||
        checks === undefined ||
        settled === undefined ||
        fired === undefined
      ) {
        return missing(
          "anyWritesThisRun",
          "executedSinceWrite",
          "projectChecksPassed",
          "planSettled",
          "fired",
        );
      }
      return !settled && wrote && !executed && !checks && fired < 1
        ? { transition: "verifying", reason: "files were written and nothing was ever executed" }
        : { transition: "working", reason: "the execution gate has nothing to refuse" };
    }
    case "G5": {
      const total = numOf(i, "criteriaTotal", state?.evidence.criteriaTotal);
      const verified = numOf(i, "criteriaVerified", state?.evidence.criteriaVerified);
      const fixShaped = bool(i, "fixShaped");
      const fired = num(i, "fired");
      if (
        total === undefined ||
        verified === undefined ||
        fixShaped === undefined ||
        fired === undefined
      ) {
        return missing("criteriaTotal", "criteriaVerified", "fixShaped", "fired");
      }
      return fixShaped && total > 0 && verified === 0 && fired < 1
        ? { transition: "verifying", reason: "a fix-shaped task with zero verified criteria" }
        : { transition: "working", reason: "the fix-verified gate has nothing to refuse" };
    }
    case "G6": {
      const required = bool(i, "required");
      const reviewed = bool(i, "reviewed");
      const fired = num(i, "fired");
      if (required === undefined || reviewed === undefined || fired === undefined) {
        return missing("required", "reviewed", "fired");
      }
      return required && !reviewed && fired < 1
        ? { transition: "verifying", reason: "the run wrote something a person will look at" }
        : { transition: "working", reason: "the product-sight gate has nothing to refuse" };
    }
    case "G7": {
      const open = numOf(i, "openSteps", state?.evidence.openSteps);
      const total = numOf(i, "totalSteps", state?.evidence.totalSteps);
      const fired = num(i, "fired");
      if (open === undefined || total === undefined || fired === undefined) {
        return missing("openSteps", "totalSteps", "fired");
      }
      if (open === 0) return { transition: "working", reason: "no planned step is open" };
      return fired < 1
        ? { transition: "repairing", reason: `${open} of ${total} planned steps are still open` }
        : {
            transition: complete("partial"),
            reason: `the run ends with ${open} of ${total} steps open — partial, on the record`,
          };
    }
    case "G8": {
      const accepted = bool(i, "accepted");
      if (accepted === undefined) return missing("accepted");
      return accepted
        ? { transition: "working", reason: "the step ledger accepted the completion" }
        : { transition: "working", reason: "the step ledger refused the completion; not closed" };
    }
    case "VERDICT": {
      const hasVerdict = bool(i, "hasVerdict");
      if (hasVerdict === undefined) return missing("hasVerdict");
      if (!hasVerdict) {
        return {
          transition: "unknown",
          reason: "no contract is in scope, so there is no verdict to decide from",
        };
      }
      const kind = str(i, "verdictKind");
      if (kind === undefined) return missing("verdictKind");
      return { transition: complete(kind), reason: `the completion verdict is ${kind}` };
    }

    // ── 5 progress ──
    case "E9":
      return {
        transition: abandoned("no_progress"),
        reason: "the same tool batch returned the same answers with nothing written between",
      };
    case "E10":
      return {
        transition: abandoned("no_progress"),
        reason: "the same result came back across varying calls at an unchanged write count",
      };
    case "E11":
      return {
        transition: abandoned("blocked"),
        reason: "every tool call was refused before it ran, for three turns",
      };
    case "E12":
      return {
        transition: abandoned("no_progress"),
        reason: "no new result and no write for twice the stale-turn limit",
      };
    // ── The six repair classes (M4) ──
    //
    // Each one bounded by the class table in
    // `docs/program/m4-repair-and-delegation.md`: a limit the SITE passes in
    // (it is the one that counts, durably, on the run's own rows) and one
    // response. None of them invents a second route, and none of them reads a
    // string.
    case "REPAIR_TRANSPORT": {
      const attempts = num(i, "attempts");
      const max = num(i, "maxAttempts");
      if (attempts === undefined || max === undefined) return missing("attempts", "maxAttempts");
      if (attempts < max) {
        return {
          transition: "working",
          reason: `transport failure ${attempts} of ${max} — waiting or backing off, then retrying`,
        };
      }
      return {
        transition: abandoned("environment"),
        reason: `${attempts} transport failures in a row; the work is not what failed`,
      };
    }
    case "REPAIR_CHECK": {
      const failed = bool(i, "checkFailed");
      const turns = num(i, "repairTurns");
      const max = num(i, "maxRepairTurns");
      if (failed === undefined || turns === undefined || max === undefined) {
        return missing("checkFailed", "repairTurns", "maxRepairTurns");
      }
      if (!failed) return { transition: "working", reason: "the checks are green" };
      if (turns < max) {
        return {
          transition: "repairing",
          reason: `one repair turn for the failing check (${turns} of ${max} spent)`,
        };
      }
      // The bound is spent. The finish path below decides, and the verdict
      // there is what makes the run a named `partial` rather than a silent
      // retry forever (M4 exit R7).
      return {
        transition: "verifying",
        reason: `${turns} repair turns are spent; the finish decides with the gap named`,
      };
    }
    case "REPAIR_ACCEPTANCE": {
      const failed = bool(i, "failed");
      const used = num(i, "repromptsUsed");
      const max = num(i, "maxReprompts");
      const turnsLeft = numOf(i, "turnsLeft", undefined);
      if (failed === undefined || used === undefined || max === undefined) {
        return missing("failed", "repromptsUsed", "maxReprompts");
      }
      if (!failed) return { transition: "working", reason: "no evaluator criterion failed" };
      if (turnsLeft === undefined) return missing("turnsLeft");
      if (used < max && turnsLeft > 0) {
        return {
          transition: "repairing",
          reason: "one re-prompt naming the failed criterion's text and the tail of its output",
        };
      }
      return {
        transition: complete("partial"),
        reason:
          turnsLeft > 0
            ? "the one acceptance re-prompt is spent; the finish is partial with the gap named"
            : "no turn is left for a re-prompt; the finish is partial with the gap named",
      };
    }
    case "REPAIR_DEPENDENCY": {
      const missingRunner = bool(i, "missingRunner");
      if (missingRunner === undefined) return missing("missingRunner");
      if (!missingRunner) return { transition: "working", reason: "the runner is available" };
      // No retry, and nothing installed. A runner that is not here is not a
      // failure of the work, and the criterion it was bound to derives
      // `needs_review` on its own (`contract.ts`) — the controller's job is
      // only to refuse to spend a turn on it.
      return {
        transition: "verifying",
        reason: "the runner is not available here; nothing is retried and nothing is installed",
      };
    }
    case "REPAIR_DENIED": {
      const halted = bool(i, "halted");
      const denied = bool(i, "denied");
      if (halted === undefined || denied === undefined) return missing("halted", "denied");
      if (halted) {
        return {
          transition: "blocked(halt)",
          reason: "a containment halt stopped this action; there is no route around a boundary",
        };
      }
      if (denied) {
        return {
          transition: "blocked(ask)",
          reason: "the action was refused at the boundary; no alternative route is attempted",
        };
      }
      return { transition: "working", reason: "the boundary allowed this action" };
    }
    case "REPAIR_PROGRESS": {
      const changed = bool(i, "evidenceChanged");
      const nudges = num(i, "nudges");
      const max = num(i, "maxNudges");
      if (changed === undefined || nudges === undefined || max === undefined) {
        return missing("evidenceChanged", "nudges", "maxNudges");
      }
      if (changed) return { transition: "working", reason: "the evidence moved; this is progress" };
      if (nudges < max) {
        return { transition: "working", reason: `one nudge (${nudges} of ${max} spent)` };
      }
      return {
        transition: abandoned("no_progress"),
        reason: "the nudge is spent and nothing moved; a re-read is not progress",
      };
    }
    default: {
      // A guard with no rule is an unknown, not a guess.
      const never: never = event.guard;
      void never;
      return { transition: "unknown", reason: "no rule for this guard" };
    }
  }
}

/**
 * The ladder's own rules, applied to a proposal after the guard made it.
 *
 * Exported because it is the rule the whole class system exists for, and a
 * rule that can only be tested through twenty guards is a rule nobody tests.
 */
export function enforceClassRules(cls: DecisionClass, proposal: Proposal): Proposal {
  if (cls === 5 && proposal.transition.startsWith("complete(")) {
    return {
      transition: "unknown",
      reason: "class 5 (progress) may stop a run but never declare it complete",
    };
  }
  return proposal;
}

/**
 * Decide what the arbiter WOULD do. Pure: same two values in, same Decision
 * out, every time, on any machine, in any order.
 */
export function decide(state: RunState | undefined, event: ShadowEvent): Decision {
  const base = {
    id: `d:${event.id}`,
    eventId: event.id,
    class: event.class,
    applied: false as const,
  };
  // The absorbing rule comes FIRST: a run that has already ended does not get
  // a second opinion out of a later guard.
  if (state && TERMINAL_PHASES.has(state.phase)) {
    return { ...base, transition: "unknown", reason: "run already terminal" };
  }
  const proposal = enforceClassRules(event.class, propose(state, event));
  return { ...base, transition: proposal.transition, reason: proposal.reason };
}

// ─── Simultaneity ───

export interface Arbitration {
  readonly winner: Decision;
  /** The losers, each carrying `supersededBy` = the winner's decision id. */
  readonly superseded: Decision[];
}

/**
 * Resolve several events that arrived in the same step.
 *
 * Lowest class wins — a halt during a failing verification round is a halt, an
 * abort during a halt is an abort, budget exhaustion beside a verdict is
 * budget. Within a class the earlier `seq` wins, so the result does not depend
 * on the order the loop happened to observe them in (M2 exit S1, S2).
 */
export function arbitrate(
  decisions: readonly Decision[],
  events: readonly ShadowEvent[],
): Arbitration {
  if (decisions.length === 0) throw new Error("arbitrate: no decisions");
  const seqOf = new Map(events.map((e) => [e.id, e.seq]));
  const ranked = [...decisions].sort((a, b) => {
    if (a.class !== b.class) return a.class - b.class;
    const sa = seqOf.get(a.eventId) ?? 0;
    const sb = seqOf.get(b.eventId) ?? 0;
    if (sa !== sb) return sa - sb;
    return a.eventId.localeCompare(b.eventId);
  });
  const winner = ranked[0]!;
  const superseded = ranked.slice(1).map((d) => ({ ...d, supersededBy: winner.id }));
  return { winner, superseded };
}

/**
 * A byte-stable rendering of a decision sequence, for replay comparison.
 *
 * Deliberately `JSON.stringify` over named fields rather than a hash: when a
 * replay disagrees, the diff has to be readable, and a hash says only "no".
 */
export function decisionFingerprint(decisions: readonly Decision[]): string {
  return JSON.stringify(
    decisions.map((d) => [d.eventId, d.transition, d.class, d.reason, d.supersededBy ?? null]),
  );
}
