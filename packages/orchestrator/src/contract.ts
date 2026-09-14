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
  DeclaredGap,
} from "@rune/protocol";

import type { CheckRun } from "./brief";
import { GOAL_CAP } from "./task-state";
import { normalizeCommand } from "./verification-command";

export type { CompletionVerdict, CriterionOutcome, DeclaredGap } from "@rune/protocol";

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

/**
 * What the run is FOR, as the runtime recorded it at intake.
 *
 * Every criterion is required. There is deliberately no `required` flag: the
 * `done_when` list is 1–6 model-authored strings with no structure, so a
 * per-criterion strength would put the model back inside the ladder it is kept
 * out of everywhere else. `partial` with a declared gap is the normal honest
 * shape of a successful run, and that is the setting this decision makes.
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
    contract.criteria.map((c) => [c.text, c.rung, c.evidence?.source ?? null]),
    contract.budget,
    contract.drift ?? null,
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

/** The ladder, weakest first — `verified` is the only rung that is done. */
function outcomeOf(criterion: Criterion): CriterionOutcome {
  return {
    text: criterion.text,
    rung: criterion.rung ?? null,
    ...(criterion.evidence?.source ? { evidence: criterion.evidence.source } : {}),
  };
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
  const criteria = input.criteria.map(outcomeOf);

  // Nothing was ever stated to be true. The audit's silent case: tests green,
  // typecheck green, and no statement anywhere of what the work was for.
  if (criteria.length === 0) {
    const asked = NO_DELIVERABLE_REASON[input.shape ?? "unknown"];
    if (asked && !input.wrote) return { kind: "none", criteria, reason: asked };
    return { kind: "unmet", criteria, missing: ["no criteria stated"] };
  }

  const verified = criteria.filter((c) => c.rung === "verified");
  const moved = criteria.filter((c) => c.rung !== null);
  const stepsOpen = input.openSteps > 0;
  const red = failingChecks(input.checks);

  if (verified.length === criteria.length && !stepsOpen && red.length === 0) {
    return { kind: "met", criteria };
  }

  // Not one criterion has a rung, and nothing else is open to declare: there
  // is nothing to name a gap AGAINST.
  if (moved.length === 0 && !stepsOpen && red.length === 0) {
    return { kind: "unmet", criteria, missing: criteria.map((c) => c.text) };
  }

  const gaps: DeclaredGap[] = criteria
    .filter((c) => c.rung !== "verified")
    .map((c) => ({
      criterion: c.text,
      why: c.rung ? `reached ${c.rung}, not verified` : "no evidence recorded",
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
  return { kind: "partial", criteria, gaps };
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
  const met = verdict.criteria.filter((c) => c.rung === "verified").length;
  const count = total === 0 ? "no criteria stated" : `${met} of ${total} criteria verified`;
  // `none` says WHY there was nothing to verify. The count would read "no
  // criteria stated" on every one of them, which is the fact the reader
  // already has and not the one they need.
  if (verdict.kind === "none") return `[verdict] none — ${verdict.reason}`;
  if (verdict.kind === "met") return `[verdict] met — ${count}`;
  if (verdict.kind === "partial") {
    const first = verdict.gaps[0];
    const rest = verdict.gaps.length - 1;
    const gap = first ? `; gap: ${first.criterion} (${first.why})` : "";
    return `[verdict] partial — ${count}${gap}${rest > 0 ? ` +${rest} more` : ""}`;
  }
  return `[verdict] unmet — ${count}`;
}
