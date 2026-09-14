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
export type TaskShape = "fix" | "feature" | "question" | "plan";

/** Asks for a plan, not the work. */
const PLAN_RE = /\b(plan|design|outline|propose|proposal|strategy|approach)\b/i;
/** Asks a question: opens with an interrogative, or ends in a question mark. */
const QUESTION_RE = /^(what|why|how|when|where|which|who|is|are|does|do|can|should|could)\b/i;

/** The shape of the request, from the request alone. */
export function contractShape(intent: string, fixShaped: boolean): TaskShape {
  const text = intent.trim();
  if (fixShaped) return "fix";
  if (text.endsWith("?") || QUESTION_RE.test(text)) return "question";
  if (PLAN_RE.test(text.slice(0, 120))) return "plan";
  return "feature";
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

/** The read-back's reading of the request, when it is not the request. */
export function briefDrift(contract: TaskContract, brief: Brief): string | null {
  const asked = contract.intent.trim();
  const read = (brief.request ?? "").trim();
  if (!read || read === asked) return null;
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
}

/**
 * Checks whose LATEST run failed, newest command first.
 *
 * A check that failed and was never re-run is a gap whether or not any
 * criterion mentions it: "the tests are red" is not a state a finished task
 * is in. Only `kind: "check"` counts — an ordinary shell command that exited
 * non-zero is an action, not a verdict.
 */
function failingChecks(checks: readonly CheckRun[]): string[] {
  const latest = new Map<string, CheckRun>();
  for (const run of checks) {
    if ((run.kind ?? "check") !== "check") continue;
    latest.set(run.command.replace(/\s+/g, " ").trim(), run);
  }
  return [...latest.entries()].filter(([, run]) => !run.passed).map(([command]) => command);
}

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
 */
export function computeVerdict(input: VerdictInputs): CompletionVerdict {
  const criteria = input.criteria.map(outcomeOf);

  // Nothing was ever stated to be true. The audit's silent case: tests green,
  // typecheck green, and no statement anywhere of what the work was for.
  if (criteria.length === 0) {
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
  if (verdict.kind === "met") return `[verdict] met — ${count}`;
  if (verdict.kind === "partial") {
    const first = verdict.gaps[0];
    const rest = verdict.gaps.length - 1;
    const gap = first ? `; gap: ${first.criterion} (${first.why})` : "";
    return `[verdict] partial — ${count}${gap}${rest > 0 ? ` +${rest} more` : ""}`;
  }
  return `[verdict] unmet — ${count}`;
}
