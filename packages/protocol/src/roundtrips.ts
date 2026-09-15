// ─── The five round-trips ───
//
// Every human-in-the-loop path the engine has. Each is already dependency-
// inverted through a handler setter on `Engine`; this file is the wire form of
// the same five conversations, so a client that is not the terminal can hold
// all of them.
//
// Before Phase 2 the host wired exactly one (permission). `ask_user` failed
// with "No interactive user is available" for every desktop and detached run,
// and held steps were invisible off-terminal.

// ─── 1. Permission ───

export type PermissionScope = "once" | "session" | "project" | "global";

export interface PermissionPrompt {
  toolName: string;
  argsSummary: string;
  suggestedScope: PermissionScope;
  rawArgs: Record<string, unknown>;
  /** Present when classifier-backed Auto mode paused for human review. */
  safety?: {
    reason: string;
    risk: string;
    tier: string;
    source: string;
    reviewer?: { provider: string; model: string };
  };
  /** "Allow session" is deliberately narrowed to this exact payload in Auto. */
  exactSessionGrant?: boolean;
  /**
   * True when a session grant would be a lie: critical/guardrail circuit
   * breakers require a fresh human decision on every occurrence, so the card
   * must not offer "allow for session" at all.
   */
  sessionGrantUnavailable?: boolean;
  /** Live per-minute rate-limit occupancy for this tool, for the risk row. */
  rateLimit?: { used: number; limit: number };
}

export type PermissionDecisionKind = "allow_once" | "allow_session" | "deny";

export type UserPermissionDecision =
  { kind: "allow_once" } | { kind: "allow_session" } | { kind: "deny" };

// ─── 2. ask_user ───

export interface UserQuestion {
  question: string;
  options: string[];
  /**
   * Where this question sits in the round, 0-based, and how many there are.
   * Frontends render them as `2 of 4`; a frontend that ignores them is
   * unaffected.
   */
  index?: number;
  total?: number;
}

// ─── 3. Brief (read-back) ───

/** How much an assertion is worth. Ordered weakest → strongest. */
export type ClaimRung = "suspected" | "observed" | "reproduced" | "verified";

/**
 * Evidence that moved a criterion. Every field is something the RUNTIME saw —
 * a command it ran, a file it touched, an exit code it read. None of it is
 * model prose, which is the whole point: a surface that never reads what the
 * model said cannot be made to claim something the model merely asserted.
 */
export interface Evidence {
  /** The command or operation that produced this, verbatim. */
  source: string;
  /** A short quotable excerpt of what came back. */
  detail?: string;
  /**
   * The `CheckRun` this evidence was priced from (`chk-<n>` in the check log).
   *
   * A command string is not an execution: the same command runs many times in
   * a session, and "the check passed" is a claim about ONE of those runs. With
   * only the command on the evidence, a criterion settled by a run that later
   * went red still read as settled, because the only thing that could be
   * re-checked was a string. The id is assigned by `CheckLog.record`, so it
   * exists for every run the runtime saw and for none that it did not.
   *
   * Its absence is also what marks a LEGACY row — evidence written before M1 —
   * which the status derivation maps conservatively rather than upgrading.
   */
  executionId?: string;
  /**
   * Who assessed it, and at what version. `check-log@1` is a command the model
   * ran, read back off the runtime's own log; `parent-probe@1` is the
   * attribution measurement; `acceptance-command@1` is the runtime running an
   * evaluator criterion's own command itself.
   *
   * Producer output and verifier assessment are separate records: the check's
   * summary stays on the `CheckRun`, and this is the assessment of it.
   */
  verifier?: string;
  /**
   * What the verifier saw. Until M1 evidence existed only for a pass, so a
   * failure had no receipt and `failed` could not be told from "never ran".
   */
  result?: "passed" | "failed";
  /**
   * A short toolchain fingerprint (runtime + version + platform) taken when
   * the assessment was made, so a claim can be told from a claim taken on a
   * different toolchain. Deliberately cheap — this is not a dependency graph.
   */
  env?: string;
  /**
   * Required for `verified`: the same check was run on the parent commit and
   * FAILED there. Without this a green test proves only that it is green now,
   * not that this change is why.
   */
  parentCommitFailed?: boolean;
  /** The parent commit the check was run against, for the receipt. */
  parentCommit?: string;
  /**
   * Why this citation was SET ASIDE: the runtime ran the command and priced
   * it, and then could not see that it speaks to this criterion.
   *
   * The rung stays where it was — an unrelated citation moves nothing — and
   * the reason is kept rather than dropped, because "the model cited
   * `node check.mjs` for the CSV header and the harness would not take it" is
   * a fact about the run that the verdict's gap text and the audit both owe
   * the reader. Written only by the runtime, from `checkRelatedness`.
   */
  unrelated?: string;
  /**
   * The workspace revision this evidence was taken at, and whether the tree
   * was dirty then. A rung is a claim about a TREE: after HEAD moves, or after
   * a clean tree is edited, the claim is about a tree that no longer exists.
   * `demoteStaleCriteria` is what acts on it.
   */
  head?: string;
  dirty?: boolean;
  /**
   * A content digest of the files the claim is about, taken at the same
   * moment as `head`. HEAD alone cannot date a claim on a DIRTY tree — the
   * ordinary agent run never commits mid-run, so every rung would be stamped
   * against one unchanging revision however much its own file was rewritten.
   * The digest is what makes "the tree moved under this claim" measurable
   * while HEAD stands still. Absent outside a git repository, and absent when
   * the brief names no files.
   */
  digest?: string;
  /**
   * The revision that already cost this criterion a rung. Written by
   * `demoteStaleCriteria` so one change demotes once: without it the same
   * unchanged fact decayed one rung on every call — verified → reproduced →
   * observed — which is the "demoting every criterion on every resume" the
   * rule exists to avoid.
   */
  staleAt?: string;
}

/**
 * WHO stated a criterion — the fact that decides what a model amendment may
 * do to it.
 *
 * `inferred` is the read-back's own reading, which the model may reword and
 * drop. `user` is a criterion the person stated (an edited brief, or an
 * `--acceptance` entry marked `user`). `evaluator` is an independent
 * acceptance check the model never sees and cannot cite. Absent means
 * `inferred`: every criterion that existed before M1 came from a read-back.
 */
export type CriterionSource = "user" | "inferred" | "evaluator";

/**
 * How a criterion is settled, when something other than a citation settles it.
 *
 * `command` is an evaluator criterion the RUNTIME runs itself at the finish
 * gate. `review` marks a criterion only a person can settle — it derives
 * `needs_review` and is never `satisfied` by the runtime, which is the honest
 * answer for "the copy reads well" rather than a rung nobody measured.
 */
export type AcceptanceMethod = { kind: "command"; command: string } | { kind: "review" };

/**
 * Whether a criterion is ACCEPTED, derived from the facts rather than asserted.
 *
 * Separate from `ClaimRung`, which keeps its own meaning: the rung says how
 * strong a receipt is (`verified` = it failed on the parent commit), and the
 * status says whether the criterion holds. Conflating them made a legitimate
 * new feature unable to reach `met` — nothing failed on the parent, because
 * the feature was never there — while an unrelated green command could.
 */
export type CriterionStatus = "unassessed" | "satisfied" | "failed" | "stale" | "needs_review";

export interface Criterion {
  /** What must be true, in the person's own frame. Set once, never rewritten. */
  text: string;
  /** null until an event moves it. The model can never set this directly. */
  rung: ClaimRung | null;
  evidence?: Evidence;
  /**
   * Stable across amendments (`c1`, `c2`, … within a contract). Assigned by the
   * runtime at promotion; an amendment that keeps a criterion's text keeps its
   * id, which is what lets "the model dropped a requirement" be a fact rather
   * than a diff of two prose lists.
   */
  id?: string;
  /** Who stated it. Absent means `inferred`. */
  source?: CriterionSource;
  /**
   * Absent means `true`. Only a `user`-sourced criterion can be optional: the
   * `read_back` schema has no such field, so the model has no way to reach it.
   */
  required?: boolean;
  /** For an evaluator criterion, the command the runtime runs itself. */
  method?: AcceptanceMethod;
}

export interface Brief {
  /**
   * The agent's reading of what the person wants — the SYMPTOM they described,
   * not the command they typed.
   */
  reading: string;
  /** Files or areas that will be touched. */
  touch: string[];
  /** What will deliberately NOT be touched, and why. */
  leave: string[];
  /** How the agent will know it is finished. */
  criteria: Criterion[];
  /** Verbatim request this was read back FROM, so drift is checkable. */
  request: string;
  createdAt: string;
}

/** What a client answers a `brief_request` with. */
export interface BriefDecision {
  accepted: boolean;
  edited?: Brief;
  note?: string;
}

// ─── 3b. The completion verdict (Phase 5B) ───
//
// `BriefLedger.complete` already computed this and nothing read it: a run with
// 0 of 6 criteria verified ended `end_turn`, `ok: true`, exit 0, and printed
// "not done — 0 of 6" underneath. The verdict is that answer, as a value, on
// the terminal event — so every exit says what it did against what was asked.
//
// It lives here rather than in the orchestrator because it rides
// `turn_complete` across the wire. Everything that COMPUTES it (the contract,
// the digest, the amendment rule) belongs to `orchestrator/src/contract.ts`.
//
// Nothing here is model prose. `rung` comes from `BriefLedger.record`, which
// only the runtime's own check log can move, and `evidence` is the command
// that moved it, verbatim.

/** One criterion as the run left it. */
export interface CriterionOutcome {
  text: string;
  rung: ClaimRung | null;
  /** The command that moved it, verbatim. Absent when nothing did. */
  evidence?: string;
  /**
   * Whether it is ACCEPTED, derived by `criterionStatus`. Absent only on a
   * verdict written before M1.
   */
  status?: CriterionStatus;
  /** Who stated it, and whether it has to hold for the run to be `met`. */
  source?: CriterionSource;
  required?: boolean;
  /**
   * Whether this change is demonstrably WHY the check passes: `regression`
   * when the same check was run on the parent commit and failed there.
   *
   * Reported, never required. It was the acceptance policy until M1, which is
   * why a new feature — nothing to fail on the parent, because the feature was
   * not there — could not be accepted at all.
   */
  attribution?: "regression" | "none";
  /** The verifier that assessed it, and the run it was priced from. */
  verifier?: string;
  executionId?: string;
}

/** Something the run did not do, named — the honest half of `partial`. */
export interface DeclaredGap {
  /** The criterion it belongs to, or `the plan` for open steps. */
  criterion: string;
  /** What the HARNESS saw: a rung short of verified, or steps left open. */
  why: string;
}

/**
 * How the run ended against what was asked.
 *
 * `met` — every criterion at `verified`, and no planned step left open.
 * `partial` — evidence exists and the shortfall is NAMED. The normal honest
 *   outcome of a successful run: `verified` is unreachable outside a git
 *   repository (`brief.ts`, `parent-check.ts`), so a verdict that could only
 *   be `met` or `unmet` would read `unmet` on runs that succeeded.
 * `unmet` — nothing verified and no gap declared: no criterion ever reached a
 *   rung, including the run that stated no criteria at all.
 * `none` — the request had no deliverable to hold a criterion: a question, a
 *   plan, a conversational follow-up. Not a shortfall, and not a success
 *   either; there was nothing to verify. Without it the most common verdict
 *   on a conversational turn was `unmet`, which teaches the reader to ignore
 *   the word — the one failure this vocabulary cannot afford.
 */
export type CompletionVerdict =
  | {
      kind: "met";
      criteria: CriterionOutcome[];
      execution?: VerdictExecution;
      evaluators?: VerdictEvaluators;
    }
  | {
      kind: "partial";
      criteria: CriterionOutcome[];
      gaps: DeclaredGap[];
      execution?: VerdictExecution;
      evaluators?: VerdictEvaluators;
    }
  | {
      kind: "unmet";
      criteria: CriterionOutcome[];
      missing: string[];
      execution?: VerdictExecution;
      evaluators?: VerdictEvaluators;
    }
  | {
      kind: "none";
      criteria: CriterionOutcome[];
      reason: string;
      execution?: VerdictExecution;
      evaluators?: VerdictEvaluators;
    };

/**
 * What the INDEPENDENT ORACLE said, counted on its own (V6 finding 21).
 *
 * `met` is unchanged and means what it always meant: every required criterion
 * satisfied, no red check, no open step. But a question or a plan cannot reach
 * it — the inferred criteria a read-back states about an ANSWER derive
 * `needs_review` ("execution receipt only"), because there is nothing to run —
 * so a consumer reading `kind` alone scores a correct, fully-accepted research
 * run as `partial` and cannot tell it from one that fell short.
 *
 * These two numbers are the half a consumer can count: the evaluator criteria
 * the runtime ran itself, and how many it settled. They gate nothing and they
 * do not change `met`; they are the acceptance measurement stated separately
 * from the completion one. Absent when no acceptance was configured.
 */
export interface VerdictEvaluators {
  /** Evaluator criteria the runtime's own run settled. */
  satisfied: number;
  /** Evaluator criteria on the contract. */
  total: number;
}

/**
 * How the RUN ended, beside what it achieved — and never folded into it.
 *
 * `kind` answers "was the task done"; this answers "did the process finish".
 * They are different questions, and a run that hit its turn ceiling with one
 * criterion satisfied must not enter a success metric merely because it
 * emitted a final answer. Optional on the wire so a verdict row written before
 * M1 still parses; every verdict `computeVerdict` produces carries it.
 */
export interface VerdictExecution {
  /** The loop's own terminal vocabulary, verbatim. */
  stopReason: string;
  /** The same thing in the lifecycle vocabulary (`statusFromStopReason`). */
  status: import("./events").TaskLifecycleStatus;
}

// ─── 4. Auto-mode approval notice (push, not a question) ───

/**
 * Payload for the inline Auto-mode chip. Every Auto decision prints one — an
 * approval, a containment, a deferral, a halt — because a mode that never
 * interrupts you has to be legible in the scrollback instead.
 */
export interface AutoApprovalNotice {
  toolName: string;
  argsSummary: string;
  risk: string;
  tier: string;
  /** Which decision this was. Absent means the historical "approved". */
  kind?: "approved" | "contained" | "redirected" | "deferred" | "halted";
  /** For a non-approval: the containment route that produced it. */
  route?: string;
  /** For a redirect: the command offered in place of the one that stopped. */
  substitute?: string;
}

// ─── 5. Held steps (the end-of-turn ledger) ───

export type ContainmentKind = "extend" | "contain" | "redirect" | "defer" | "halt";

/**
 * An outward, irreversible step Auto declined to take unattended.
 *
 * The wire form differs from the in-process one in exactly two ways, both
 * deliberate. `at` is an ISO string, not a `Date` — JSON has no Date, and a
 * client that received `{}` for a timestamp could not sort the ledger. And
 * `args` is NOT carried: it is raw and unredacted by design and stays
 * in-process, so a client refers to a held step by `id` and the host runs the
 * arguments it already holds. Every displayed form uses `summary`, which is
 * bounded and secret-scrubbed.
 */
export interface HeldStep {
  /** Stable within the session; what `run_held_step` refers to. */
  id: string;
  toolName: string;
  /** The command or a bounded, secret-scrubbed argument summary. */
  summary: string;
  /** Which containment route produced it, for the audit row. */
  route: string;
  /** One line the user reads: what would have happened, and why it did not. */
  reason: string;
  /** ISO-8601. */
  at: string;
  /**
   * Which route family held it. A `defer` left the step entirely undone; a
   * `redirect` already ran a safe stand-in, so only the real effect is
   * outstanding.
   */
  kind: ContainmentKind;
  /** `redirect` — the stand-in that ran instead. */
  substitute?: string;
}

/** The outcome of running one held step at the user's explicit request. */
export interface HeldStepRunResult {
  /** True when the step executed (successfully or not); false when refused before running. */
  ran: boolean;
  /** Why it was refused: signed org policy, a configured deny rule, a hook veto, a live run. */
  refusal?: string;
  /** The tool's output when it ran. */
  output?: import("./tool").ToolCallOutput;
}

// ─── What a pending round-trip is worth when nobody answers ───

/**
 * Why a pending round-trip resolved without a human.
 *
 * The policy is stated rather than implied because the failure mode it
 * replaces was silent: a permission promise with no timeout and no rejection
 * on disconnect left a detached run wedged forever, holding a tool call open
 * with no client left to answer it.
 */
export type UnattendedReason = "timeout" | "no_clients";

/**
 * The unattended policy, one line per round-trip. This is the contract P2.2
 * implements and `docs/protocol.md` publishes.
 *
 *  - permission → `deny`. The alternative to denying is silently granting
 *    whatever a model asked for to a process nobody is watching.
 *  - question   → the "no answer" instruction, so the model proceeds on its
 *    best judgment instead of stalling on an answer that is never coming.
 *  - brief      → accepted as stated. The read-back is a chance to correct a
 *    reading, not a gate; refusing it unattended would stop work that was
 *    never in doubt.
 *  - held steps → stay in the ledger, unrun. A deferral exists precisely
 *    because it must not happen without a human.
 */
export const UNATTENDED_POLICY = {
  permission: "deny",
  question: "no-answer",
  brief: "accept",
  held_step: "hold",
} as const;

/** What `ask_user` resolves to when the round-trip went unanswered. */
export const NO_ANSWER_TEXT =
  "(no answer — nobody was attached to this run; proceed on your best judgment " +
  "and state the assumption you made)";
