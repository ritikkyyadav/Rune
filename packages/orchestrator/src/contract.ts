// ─── The task contract, and the verdict every exit owes it ───
//
// Phase 5B. Until this module there was no HARNESS intake at all: a request
// became a brief only if the MODEL decided to call `read_back` on its opening
// turn, and four of the thirteen terminal exits emitted no terminal event of
// any kind, so `engine.ts` invented one afterwards. Completion was judged —
// when it was judged — against the model's own restatement of the request.
//
// The contract is created by the runtime at intake, before the first model
// call, from the one scope that already holds the verbatim message, the
// resolved budget and the workspace revision. It exists whether or not the
// model ever reads back. The read-back AMENDS it; nothing replaces it, and
// `intent` — the user's own words — is never rewritten.
//
// The verdict is computed from the same three runtime records the gates read:
// the brief ledger's rungs (only `BriefLedger.record` can move one, and only
// from the check log), the plan's open steps, and the checks the runtime ran.
// No model prose reaches it, which is the same rule `rungForCommand` keeps.
//
// In THIS lane the verdict is advisory: it writes its row, rides
// `turn_complete`, and refuses nothing. Phase 5C's arbiter is what gives it
// teeth.

import type {
  Brief,
  CompletionVerdict,
  Criterion,
  CriterionOutcome,
  CriterionStatus,
  DeclaredGap,
} from "@rune/protocol";

import type { CheckRun } from "./brief";
import { statusFromStopReason, treeMovedUnder, type StampedRevision } from "./lifecycle";
import { GOAL_CAP } from "./task-state";
import { normalizeCommand } from "./verification-command";

export type {
  CompletionVerdict,
  CriterionOutcome,
  CriterionStatus,
  DeclaredGap,
} from "@rune/protocol";

/**
 * What shape of deliverable was asked for.
 *
 * The mechanical guess at intake, from the words the user typed — not the
 * `TaskKind` the intent interpreter sets, which costs a model call and can
 * arrive after the contract must already exist. `fix` is the one that gates:
 * it is the same predicate the fix-verified gate uses (`isFixShaped`), passed
 * in rather than imported so the gate and the contract can never disagree and
 * so this module stays free of the loop.
 */
export type TaskShape = "fix" | "feature" | "question" | "plan" | "chat" | "unknown";

/**
 * Asks for a PLAN, not the work.
 *
 * The first draft matched `plan|design|outline|propose|proposal|strategy|
 * approach` anywhere in the first 120 characters, which made `Implement a
 * design system` a planning task because of a noun in the thing being built.
 * A plan is asked for in one of two ways: the sentence opens with the verb, or
 * the plan itself is the object. Everything else that merely mentions design
 * is work.
 */
const PLAN_VERB_RE = /^(?:please\s+)?(?:plan|outline|propose|sketch)\b/i;
const PLAN_OBJECT_RE =
  /\b(?:a|an|the|some|your)\s+(?:high[- ]level\s+|rough\s+|detailed\s+)?(?:plan|proposal|strategy|approach|rfc|design doc(?:ument)?|roadmap)\b/i;

/**
 * Asks for work, in the ways a person actually asks for it.
 *
 * Three shapes, and the order they are tested in is the order they occur in
 * real messages: the polite wrapper (`can you implement login?` — a question
 * mark on an instruction), the bare imperative (`ship it`), and the second
 * half of a mixed ask (`explain the parser, then fix the off-by-one`). The
 * third is why this runs BEFORE the question test: a message that asks for an
 * explanation and then for a fix is a message with a deliverable in it, and
 * the deliverable is the half a contract has to hold.
 */
const WORK_VERB =
  "implement|build|create|write|add|fix|repair|patch|refactor|rewrite|rename|remove|delete|drop|update|upgrade|change|modify|migrate|port|convert|ship|deploy|release|publish|install|configure|wire|hook|set up|setup|make|move|generate|extract|split|merge|revert|undo|restore|clean up|cleanup|optimi[sz]e|speed up|harden|handle|support|enable|disable|replace|run|apply|finish|complete|land|commit";
const POLITE_WORK_RE = new RegExp(
  `^(?:please\\s+|pls\\s+)?(?:can|could|would|will|wanna|want to)\\s+(?:you|we|u)\\s+(?:please\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);
const IMPERATIVE_WORK_RE = new RegExp(`^(?:please\\s+|pls\\s+|now\\s+|also\\s+)?(?:${WORK_VERB})\\b`, "i");
const FOLLOW_ON_WORK_RE = new RegExp(
  `(?:^|[,;.]\\s*|\\s)(?:then|and then|after that|next|now|also|and)\\s+(?:please\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);

/**
 * Asks a question: opens with an interrogative, asks to be told something, or
 * ends in a question mark having asked for no work.
 *
 * `explain|describe|tell me|walk me through|what is` are question-shaped
 * however imperatively they are phrased — the deliverable is an answer, and a
 * contract that calls that a feature spends the whole run looking for a file
 * that was never going to be written.
 */
const QUESTION_RE =
  /^(?:please\s+)?(what|why|how|when|where|which|who|is|are|was|were|does|do|did|can|should|could|explain|describe|clarify|summari[sz]e|tell me|show me|walk me through|help me understand|any idea|thoughts)\b/i;

/**
 * Every word a message can be made of and still be asking for nothing.
 *
 * "thanks, that looks right" after a clean finish is a turn with no
 * deliverable, and a verdict vocabulary that answers it with `unmet` is
 * teaching its reader to stop reading verdicts. Membership is required of
 * EVERY word, which is what keeps "ok, now delete the cache" out: one word
 * that asks for work and the message is work.
 */
const CHAT_WORDS = new Set([
  "thanks", "thank", "thanx", "thx", "ty", "you", "cheers", "appreciated", "appreciate", "it",
  "ok", "okay", "k", "kk", "cool", "nice", "great", "perfect", "awesome", "excellent", "lovely",
  "brilliant", "beautiful", "good", "fine", "right", "correct", "exactly", "lgtm", "got",
  "sounds", "looks", "look", "seems", "works", "worked", "makes", "sense", "that", "this",
  "these", "those", "all", "is", "are", "was", "were", "yes", "yep", "yeah", "yup", "sure",
  "no", "nope", "nah", "done", "well", "much", "very", "so", "and", "now", "then", "i", "we",
  "my", "me", "am", "happy", "glad", "love", "like", "super", "it's", "its", "one",
]);
// `ship` used to be in that set, which made `ship it` an acknowledgement —
// a message asking for a deployment classified as a message asking for
// nothing. Every remaining member is a noun, a pronoun, an adjective or a
// copula; the working rule is that a word earns its place here only if no
// sentence can ask for work with it, and the work test below runs first
// anyway.

/** A message built only of acknowledgement: no deliverable, nothing to verify. */
function chatShaped(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z']+/g);
  // Eight words is the length past which an acknowledgement is a paragraph,
  // and a paragraph usually contains an ask.
  if (!words || words.length === 0 || words.length > 8) return false;
  return words.every((word) => CHAT_WORDS.has(word));
}

/**
 * The shape of the request, from the request alone.
 *
 * From the REQUEST alone, deliberately: the classifier never reads the
 * conversation's position, so a follow-up is shaped by its own words exactly
 * as an opening message is. The alternative — "a message after a clean finish
 * is conversational" — would call `fix the header, it is still wrong` a chat
 * turn because of what came before it, which is the one mistake a contract
 * cannot make.
 *
 * ADVISORY, and only advisory. The shape picks a verdict vocabulary for a run
 * that stated no criteria; it authorises nothing, skips no verification, opens
 * no permission and closes no step. A mechanical read of a sentence is not a
 * safe input to any of those, which is why the one branch that reads it
 * (`computeVerdict`, on a contract with zero criteria and nothing written)
 * cannot make a run look MORE complete than it is.
 */
export function contractShape(intent: string, fixShaped: boolean): TaskShape {
  const text = intent.trim();
  if (!text) return "unknown";
  if (fixShaped) return "fix";
  const head = text.slice(0, 200);
  if (PLAN_VERB_RE.test(head) || PLAN_OBJECT_RE.test(head)) return "plan";
  if (POLITE_WORK_RE.test(head) || IMPERATIVE_WORK_RE.test(head) || FOLLOW_ON_WORK_RE.test(head)) {
    return "feature";
  }
  if (text.endsWith("?") || QUESTION_RE.test(text)) return "question";
  if (chatShaped(text)) return "chat";
  // Nothing in the words says what this is: a bare noun phrase, a pasted
  // stack trace, a fragment. `unknown` is the honest answer, and it is the
  // reason this enum has one: guessing `feature` put a deliverable on the
  // contract that the user never asked for, and the verdict then measured
  // the run against it.
  return "unknown";
}

/** One recorded change to the contract's criteria, and who made it. */
export interface ContractAmendment {
  /** The contract revision this amendment produced. */
  revision: number;
  at: string;
  /**
   * `model` is a read-back; `user` is a person editing the brief or stating
   * acceptance; `runtime` is the harness loading evaluator criteria or
   * carrying an interrupted run's contract forward. Only `user` may remove.
   */
  origin: "model" | "user" | "runtime";
  added: string[];
  /**
   * The `user`/`evaluator` criteria this amendment OMITTED and the runtime
   * retained anyway. The whole point of recording an amendment: a model that
   * quietly drops a requirement it did not meet is the failure mode, and
   * `kept` is where it shows up as a fact rather than as a missing line.
   */
  kept: string[];
  /** Removed for real — reachable only from `user` origin. */
  removed: string[];
}

/**
 * What the run is FOR, as the runtime recorded it at intake.
 *
 * Criteria are required BY DEFAULT and only a `user`-sourced one can be made
 * optional: the `done_when` list is 1–6 model-authored strings with no
 * structure, and a per-criterion strength the MODEL could set would put it
 * back inside the ladder it is kept out of everywhere else. `partial` with a
 * declared gap is still the normal honest shape of a successful run.
 */
export interface TaskContract {
  version: 1;
  /** The user's message, verbatim. Never rewritten, never summarised. */
  intent: string;
  scope: { touch: string[]; leave: string[] };
  shape: TaskShape;
  /** Empty at intake; promoted from the read-back on amendment. */
  criteria: Criterion[];
  budget: {
    turns: number;
    secondWinds: number;
    costUsd: number | null;
    deadlineMs: number | null;
  };
  stop: { onHalt: true; onSpendCap: true; onCriteriaMet: boolean };
  createdAt: string;
  /**
   * What the brief read the request back AS, when that is not what was asked.
   *
   * `Brief.request` is verbatim and exists for exactly this check. Written
   * only on amendment, only by the runtime, and only when the two differ —
   * the drift is a fact about the run, not a correction to the intent.
   */
  drift?: string;
  /**
   * 1 at intake, +1 on every amendment that changes the digest. What makes
   * "the contract the verdict was taken against" nameable rather than implied.
   */
  revision: number;
  /**
   * The `leave` list plus every `user`-sourced constraint. Carried forward by
   * `carryForward` and never dropped by a model amendment: a constraint the
   * person stated is not the model's to forget between turns.
   */
  constraints: string[];
  /** Every change to the criteria, with its origin. Newest last, bounded. */
  amendments: ContractAmendment[];
  /**
   * Required criteria with no bound evidence at verdict time. Written by
   * `computeVerdict`'s caller from the verdict it returns; named in the gaps
   * as `no check bound`, which is the fact a reader needs and the one a
   * "0 of 2 verified" count hides.
   */
  uncovered: string[];
}

export interface CreateContractInput {
  intent: string;
  /** `isFixShaped(intent)` — the loop's own predicate, passed in. */
  fixShaped: boolean;
  turns: number;
  secondWinds: number;
  costUsd?: number | null;
  deadlineMs?: number | null;
  now?: () => number;
}

/** The contract as intake leaves it: an intent, a budget, and no criteria. */
export function createContract(input: CreateContractInput): TaskContract {
  return {
    version: 1,
    intent: input.intent,
    scope: { touch: [], leave: [] },
    shape: contractShape(input.intent, input.fixShaped),
    criteria: [],
    budget: {
      turns: input.turns,
      secondWinds: input.secondWinds,
      costUsd: input.costUsd ?? null,
      deadlineMs: input.deadlineMs ?? null,
    },
    stop: { onHalt: true, onSpendCap: true, onCriteriaMet: false },
    createdAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    revision: 1,
    constraints: [],
    amendments: [],
    uncovered: [],
  };
}

/** The M1 fields, defaulted — a contract read back off an older session row. */
export function normalizeContract(contract: TaskContract): TaskContract {
  return {
    ...contract,
    revision: typeof contract.revision === "number" ? contract.revision : 1,
    constraints: Array.isArray(contract.constraints) ? contract.constraints : [],
    amendments: Array.isArray(contract.amendments) ? contract.amendments : [],
    uncovered: Array.isArray(contract.uncovered) ? contract.uncovered : [],
  };
}

/**
 * The read-back's reading of the request, when it is not the request.
 *
 * Compared LIKE WITH LIKE: `Brief.request` is `taskState.currentRequest()`,
 * the store's own copy of the message, truncated at `GOAL_CAP`. Comparing it
 * against the untruncated intent recorded a `drift` on every request over
 * 24 KB whose read-back was perfect — and the drift written into the contract
 * row, the digest and `rune audit`'s "read back as" was a 24,000-character
 * copy of the user's own words (V-5B, F3). The user's words are never the
 * model's misreading, so a `read` that is exactly the front of `asked` is not
 * drift at any length.
 */
export function briefDrift(contract: TaskContract, brief: Brief): string | null {
  const asked = contract.intent.trim();
  const read = (brief.request ?? "").trim();
  if (!read || read === asked) return null;
  if (asked.length > GOAL_CAP && asked.slice(0, GOAL_CAP).trim() === read) return null;
  return read;
}

/**
 * Fold the brief into the contract. AMENDED, never replaced.
 *
 * The criteria and the scope come from the read-back because that is where
 * the model says what it understood the work to be; `intent`, `shape`, the
 * budget and `createdAt` are the runtime's and stay put. The criteria objects
 * are the LEDGER's — the same objects `BriefLedger.record` mutates — so a rung
 * earned after the amendment is on the contract without a second write.
 */
export function amendContract(contract: TaskContract, brief: Brief): TaskContract {
  const drift = briefDrift(contract, brief);
  return { ...carryForward(contract, brief), ...(drift ? { drift } : {}) };
}

/**
 * The criteria a RESUMED run inherits from the run it is continuing.
 *
 * A run that died with work open left its acceptance criteria in force: the
 * next message continues the same task, and a contract that started empty
 * would report "no criteria stated" while the ledger held verified ones — the
 * verdict contradicting the record it is computed from.
 *
 * No drift is recorded: `Brief.request` is the check on what the model read
 * back, and nothing was read back here.
 */
export function carryForward(contract: TaskContract, brief: Brief): TaskContract {
  return {
    ...contract,
    scope: { touch: [...brief.touch], leave: [...brief.leave] },
    criteria: brief.criteria,
  };
}

/**
 * A stable fingerprint of everything a reader would act on.
 *
 * Latest-wins dedupe, exactly as `persistBrief` does it: an amendment that
 * changes nothing must not write a row, or the log grows one contract per
 * turn. Rungs are IN the digest — a criterion reaching `verified` is a change
 * to the contract's state worth a row.
 */
export function contractDigest(contract: TaskContract): string {
  return JSON.stringify([
    contract.version,
    contract.intent,
    contract.shape,
    contract.scope.touch,
    contract.scope.leave,
    contract.criteria.map((c) => [
      c.text,
      c.rung,
      c.evidence?.source ?? null,
      // The M1 facts a reader would act on: who stated it, whether it has to
      // hold, and which execution settled it. A criterion whose SOURCE changed
      // is a different contract even when its text did not.
      c.id ?? null,
      c.source ?? null,
      c.required ?? null,
      c.evidence?.executionId ?? null,
      c.evidence?.result ?? null,
    ]),
    contract.budget,
    contract.drift ?? null,
    contract.revision ?? 1,
    contract.constraints ?? [],
    contract.uncovered ?? [],
  ]);
}

/**
 * Everything the verdict is computed FROM. Every field is runtime-observed.
 *
 * The contract itself is deliberately absent: the verdict answers "what is
 * true of the criteria", and the criteria here ARE the contract's — the same
 * objects, held by the ledger. What binds a verdict to the contract it was
 * taken against is `contractDigest` on the row, not a copy in the input.
 */
export interface VerdictInputs {
  /** The ledger's live criteria, rungs included. */
  criteria: readonly Criterion[];
  /** Every check the runtime ran this session, with the verdict IT read. */
  checks: readonly CheckRun[];
  openSteps: number;
  totalSteps: number;
  /** How the run ended, in the loop's own vocabulary. */
  stopReason: string;
  /**
   * The contract's shape, for the one question the criteria cannot answer:
   * what does a run with NO criteria owe? Absent means the caller holds no
   * contract shape, and the answer is the one it always was.
   */
  shape?: TaskShape;
  /** Whether this task wrote any file at all — `taskState.writtenFiles`. */
  wrote?: boolean;
  /**
   * The workspace revision the verdict is being taken AT, scoped to the same
   * files the evidence was stamped against. Absent means the caller holds no
   * revision, and then nothing can be shown to have moved — a claim is never
   * called stale on a measurement that was not taken.
   */
  revision?: StampedRevision | null;
}

/**
 * The half of the verdict's inputs only the ENGINE holds.
 *
 * The loop knows how the run ended and what the plan looks like; the ledger
 * and the check log live on the Engine. Null from the accessor means no
 * contract is in scope at all — a sub-agent loop, or a caller driving
 * `AgentLoop` directly — and then the loop emits no verdict rather than an
 * empty one.
 */
export interface ContractRecord {
  criteria: readonly Criterion[];
  checks: readonly CheckRun[];
  /** The shape the contract recorded at intake. */
  shape?: TaskShape;
  /** Whether the task has written any file this run. */
  wrote?: boolean;
  /** The revision to date the evidence against, taken at verdict time. */
  revision?: StampedRevision | null;
}

/**
 * Checks whose LATEST run failed, newest command first.
 *
 * A check that failed and was never re-run is a gap whether or not any
 * criterion mentions it: "the tests are red" is not a state a finished task
 * is in. Only `kind: "check"` counts — an ordinary shell command that exited
 * non-zero is an action, not a verdict.
 *
 * Two commands are the same check when `normalizeCommand` says they are — the
 * same quote-preserving identity `rungForCommand` uses, so the ledger and the
 * verdict cannot disagree about what ran. Collapsing whitespace blindly made
 * `node --test "checks/a  b.test.js"` and `node --test "checks/a b.test.js"`
 * one command, and a pass of the second erased the failure of the first:
 * a DIFFERENT check quietly superseding a red one, and the run reported `met`
 * (review finding 1). Re-running the SAME command still supersedes its own
 * earlier failure, which is what a fix looks like.
 */
function failingChecks(checks: readonly CheckRun[]): string[] {
  const latest = new Map<string, CheckRun>();
  for (const run of checks) {
    if ((run.kind ?? "check") !== "check") continue;
    latest.set(normalizeCommand(run.command), run);
  }
  return [...latest.entries()].filter(([, run]) => !run.passed).map(([command]) => command);
}

/**
 * The shapes that can end with nothing to verify, and what the verdict says
 * about each. Absent from this map — `fix`, `feature`, `unknown` — means a
 * deliverable was asked for, and a run that stated no criteria for it is
 * `unmet` exactly as before.
 */
const NO_DELIVERABLE_REASON: Partial<Record<TaskShape, string>> = {
  question: "a question, answered: no acceptance criteria were stated and no file was written",
  plan: "a plan was asked for: no acceptance criteria were stated and no file was written",
  chat: "nothing was asked for: no acceptance criteria were stated and no file was written",
};

// ─── Is a criterion ACCEPTED? ───
//
// The one idea of M1. Until here a single fact — the rung — answered three
// questions: did a check pass, is this change why it passes, and is the
// criterion accepted. So `verified` (which requires a failure on the parent
// commit) was the acceptance policy, and a legitimate new feature could never
// be `met`: there is nothing to fail on a parent commit that never had the
// feature. The facts are stored separately now and acceptance is DERIVED.

/**
 * The run of the check this evidence is bound to, latest first.
 *
 * By `executionId` when the evidence carries one — an execution, not a string
 * — and by the command's normalised identity otherwise, which is the same
 * identity `rungForCommand` and `failingChecks` use, so the three cannot
 * disagree about what ran.
 */
function boundRun(
  criterion: Criterion,
  checks: readonly CheckRun[],
): { command: string; latest: CheckRun } | null {
  const evidence = criterion.evidence;
  if (!evidence) return null;
  let command: string | undefined;
  if (evidence.executionId) {
    for (let i = checks.length - 1; i >= 0; i--) {
      if (checks[i]!.executionId === evidence.executionId) {
        command = checks[i]!.command;
        break;
      }
    }
  }
  command ??= evidence.source;
  if (!command) return null;
  const key = normalizeCommand(command);
  let latest: CheckRun | undefined;
  for (const run of checks) if (normalizeCommand(run.command) === key) latest = run;
  return latest ? { command: key, latest } : null;
}

/** True when this evidence predates M1 — no execution id and no result. */
function legacyEvidence(criterion: Criterion): boolean {
  const e = criterion.evidence;
  return !!e && !e.executionId && !e.result;
}

/**
 * Whether a criterion holds, from the runtime's own records and nothing else.
 *
 * Read top to bottom; the first line that answers wins, and every line is a
 * fact the runtime saw:
 *
 *   review method                      → needs_review  (only a person settles it)
 *   no evidence                        → unassessed
 *   the citation was SET ASIDE         → unassessed    (an unrelated check moves nothing)
 *   the verifier recorded a failure    → failed
 *   the bound check's LATEST run failed→ failed        (a green run superseded by a red one)
 *   the tree moved under the evidence  → stale
 *   the evidence cannot be dated       → needs_review
 *   a legacy row                       → mapped conservatively, never upgraded
 *   otherwise                          → satisfied
 *
 * `now` is the revision the verdict is being taken AT, scoped to the same
 * files the evidence was stamped against. Null means the caller holds no
 * revision — a unit call site, an embedder outside git — and then nothing can
 * be shown to have moved, which is the reading that keeps an honest claim.
 *
 * The legacy map is the review's "map conservatively; do not silently upgrade
 * saved sessions": a stored `verified`/`reproduced` still means the check
 * passed and is therefore `satisfied`, but a stored `observed` might be an
 * execution receipt rather than a check, and there is no way left to tell —
 * so it is `needs_review`, not `satisfied`.
 */
export function criterionStatus(
  criterion: Criterion,
  checks: readonly CheckRun[] = [],
  now: StampedRevision | null = null,
): CriterionStatus {
  if (criterion.method?.kind === "review") return "needs_review";
  const evidence = criterion.evidence;
  if (!evidence) return "unassessed";
  if (evidence.unrelated) return "unassessed";
  if (evidence.result === "failed") return "failed";
  const bound = boundRun(criterion, checks);
  if (bound && !bound.latest.passed) return "failed";
  const dated = evidence.head != null || evidence.digest != null;
  if (now && dated && treeMovedUnder(evidence, now)) return "stale";
  if (!dated) return "needs_review";
  if (legacyEvidence(criterion)) {
    if (criterion.rung === "verified" || criterion.rung === "reproduced") return "satisfied";
    if (criterion.rung === "observed") return "needs_review";
    return "unassessed";
  }
  return "satisfied";
}

/**
 * Whether a criterion counts toward `met`.
 *
 * An optional criterion is accepted whatever happened to it — that is what
 * optional means — and only a `user`-sourced criterion can be optional, which
 * is enforced where amendments are applied, not here.
 */
export function accepted(criterion: Criterion, status: CriterionStatus): boolean {
  return criterion.required === false || status === "satisfied";
}

/** Reported beside the status, gating nothing: is this change WHY it passes? */
function attributionOf(criterion: Criterion): "regression" | "none" {
  return criterion.evidence?.parentCommitFailed ? "regression" : "none";
}

/** The criterion as the run left it, with the derived status beside the rung. */
function outcomeOf(
  criterion: Criterion,
  checks: readonly CheckRun[],
  now: StampedRevision | null,
): CriterionOutcome {
  const status = criterionStatus(criterion, checks, now);
  return {
    text: criterion.text,
    rung: criterion.rung ?? null,
    ...(criterion.evidence?.source ? { evidence: criterion.evidence.source } : {}),
    status,
    source: criterion.source ?? "inferred",
    required: criterion.required !== false,
    attribution: attributionOf(criterion),
    ...(criterion.evidence?.verifier ? { verifier: criterion.evidence.verifier } : {}),
    ...(criterion.evidence?.executionId ? { executionId: criterion.evidence.executionId } : {}),
  };
}

/** Why a criterion that is not accepted is not accepted, in one clause. */
function gapWhy(criterion: Criterion, status: CriterionStatus): string {
  const detail = criterion.evidence?.detail?.replace(/\s+/g, " ").trim();
  switch (status) {
    case "failed":
      return `failed: ${detail || "the bound check did not pass"}`;
    case "stale":
      return "stale: the workspace moved since the evidence was taken";
    case "needs_review":
      return criterion.method?.kind === "review"
        ? "needs_review: only a person can settle this"
        : `needs_review: ${detail || "the evidence cannot be dated to this tree"}`;
    default:
      return criterion.evidence?.unrelated
        ? `no check bound: \`${criterion.evidence.source}\` was set aside — ${criterion.evidence.unrelated}`
        : "no check bound";
  }
}

/**
 * The verdict, from the runtime's own record and nothing else.
 *
 * `met` needs every criterion at `verified` AND a plan with nothing open: a
 * run that proved every criterion and abandoned four steps has not done what
 * was asked, and the open-steps gate already knows it.
 *
 * `unmet` is reserved for "nothing verified and no gap declared" — no
 * criterion ever reached a rung at all. A criterion that reached `observed`
 * and stopped IS a declared gap: the harness saw something, named it, and can
 * say how far short it fell. That distinction is the whole difference between
 * a run that fell short honestly and one that never engaged.
 *
 * `none` is the answer for a request that had no deliverable to hold a
 * criterion — a question, a plan, an acknowledgement — that stated none and
 * wrote nothing. Before it, the most common verdict on a conversational turn
 * was `unmet`: a run that did exactly what was asked, printing
 * `[verdict] unmet — 0 of 0 criteria verified` as the last line of `-P`
 * (V-5B, F4). A vocabulary whose commonest word is wrong teaches its reader
 * to skip the line, and then it protects no one. `none` cannot flatter a run:
 * it is reachable only with zero criteria and zero files written, and one
 * written file sends the same run back to `unmet`.
 */
export function computeVerdict(input: VerdictInputs): CompletionVerdict {
  const now = input.revision ?? null;
  const criteria = input.criteria.map((c) => outcomeOf(c, input.checks, now));
  // How the PROCESS ended, on every kind and never folded into `kind`. A run
  // that hit its turn ceiling with one criterion satisfied is `partial` AND
  // `budget`, and a consumer that sees only the first scores it as a task that
  // fell a little short rather than a run that was cut off.
  const execution = {
    stopReason: input.stopReason,
    status: statusFromStopReason(input.stopReason),
  };

  // Nothing was ever stated to be true. The audit's silent case: tests green,
  // typecheck green, and no statement anywhere of what the work was for.
  if (criteria.length === 0) {
    const asked = NO_DELIVERABLE_REASON[input.shape ?? "unknown"];
    if (asked && !input.wrote) return { kind: "none", criteria, reason: asked, execution };
    return { kind: "unmet", criteria, missing: ["no criteria stated"], execution };
  }

  const stepsOpen = input.openSteps > 0;
  const red = failingChecks(input.checks);
  const statusOf = new Map(input.criteria.map((c, i) => [i, criteria[i]!.status!] as const));
  const short = input.criteria
    .map((c, i) => ({ criterion: c, status: statusOf.get(i)! }))
    .filter(({ criterion, status }) => !accepted(criterion, status));

  // `met` — every REQUIRED criterion satisfied, no red check, no open step.
  // The rung is not consulted: a criterion settled by a bound, fresh, passing
  // check is accepted whether or not anything failed on the parent commit,
  // and the attribution rides the outcome for the reader instead of gating it.
  if (short.length === 0 && !stepsOpen && red.length === 0) {
    return { kind: "met", criteria, execution };
  }

  // Not one criterion was ever assessed, and nothing else is open to declare:
  // there is nothing to name a gap AGAINST.
  const assessed = criteria.filter((c) => c.status !== "unassessed");
  if (assessed.length === 0 && !stepsOpen && red.length === 0) {
    return { kind: "unmet", criteria, missing: criteria.map((c) => c.text), execution };
  }

  const gaps: DeclaredGap[] = short.map(({ criterion, status }) => ({
    criterion: criterion.text,
    why: gapWhy(criterion, status),
  }));
  if (stepsOpen) {
    gaps.push({
      criterion: "the plan",
      why: `${input.openSteps} of ${input.totalSteps} planned steps still open`,
    });
  }
  for (const command of red) {
    gaps.push({ criterion: "the checks", why: `\`${command}\` last failed` });
  }
  return { kind: "partial", criteria, gaps, execution };
}

/**
 * Required criteria with no bound evidence — the contract's `uncovered` list.
 *
 * Kept separate from the gaps because it answers a different question: not
 * "what fell short" but "what was never measured at all", which is the half a
 * count of verified criteria has never been able to say.
 */
export function uncoveredCriteria(verdict: CompletionVerdict): string[] {
  return verdict.criteria
    .filter((c) => c.required !== false && c.status === "unassessed")
    .map((c) => c.text);
}

/**
 * The one line a headless caller reads last.
 *
 * Deliberately one line and deliberately mechanical: a benchmark harness that
 * reads only the tail of stdout gets the verdict, the count, and the first
 * gap by name. Everything else is in the `verdict` row.
 */
export function verdictLine(verdict: CompletionVerdict): string {
  const total = verdict.criteria.length;
  // ACCEPTED, not verified. The count used to be "N of M criteria verified",
  // which named the rung — and the rung is the regression measurement, not the
  // acceptance one. A run whose every criterion was settled by a bound, fresh,
  // passing check and whose feature is new read "0 of 3 criteria verified"
  // beside `[verdict] met`, so the headline and its count disagreed.
  const met = verdict.criteria.filter(
    (c) => c.required === false || c.status === "satisfied",
  ).length;
  const regressions = verdict.criteria.filter((c) => c.attribution === "regression").length;
  const count = total === 0 ? "no criteria stated" : `${met} of ${total} accepted`;
  const attributed = regressions > 0 ? ` (${regressions} regression-attributed)` : "";
  // `none` says WHY there was nothing to verify. The count would read "no
  // criteria stated" on every one of them, which is the fact the reader
  // already has and not the one they need.
  if (verdict.kind === "none") return `[verdict] none — ${verdict.reason}`;
  if (verdict.kind === "met") return `[verdict] met — ${count}${attributed}`;
  if (verdict.kind === "partial") {
    const first = verdict.gaps[0];
    const rest = verdict.gaps.length - 1;
    const gap = first ? `; gap: ${first.criterion} (${first.why})` : "";
    return `[verdict] partial — ${count}${attributed}${gap}${rest > 0 ? ` +${rest} more` : ""}`;
  }
  return `[verdict] unmet — ${count}`;
}
