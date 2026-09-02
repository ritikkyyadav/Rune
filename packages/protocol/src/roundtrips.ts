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
   * Required for `verified`: the same check was run on the parent commit and
   * FAILED there. Without this a green test proves only that it is green now,
   * not that this change is why.
   */
  parentCommitFailed?: boolean;
  /** The parent commit the check was run against, for the receipt. */
  parentCommit?: string;
}

export interface Criterion {
  /** What must be true, in the person's own frame. Set once, never rewritten. */
  text: string;
  /** null until an event moves it. The model can never set this directly. */
  rung: ClaimRung | null;
  evidence?: Evidence;
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
