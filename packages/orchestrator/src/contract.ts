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

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { CheckRun } from "./brief";
import { statusFromStopReason, treeMovedUnder, type StampedRevision } from "./lifecycle";
import { couldNotRunOnParent } from "./parent-check";
import { GOAL_CAP } from "./task-state";
import { commandPaths, isNoOpCommand, normalizeCommand } from "./verification-command";

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
const IMPERATIVE_WORK_RE = new RegExp(
  `^(?:please\\s+|pls\\s+|now\\s+|also\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);
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
  "thanks",
  "thank",
  "thanx",
  "thx",
  "ty",
  "you",
  "cheers",
  "appreciated",
  "appreciate",
  "it",
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "nice",
  "great",
  "perfect",
  "awesome",
  "excellent",
  "lovely",
  "brilliant",
  "beautiful",
  "good",
  "fine",
  "right",
  "correct",
  "exactly",
  "lgtm",
  "got",
  "sounds",
  "looks",
  "look",
  "seems",
  "works",
  "worked",
  "makes",
  "sense",
  "that",
  "this",
  "these",
  "those",
  "all",
  "is",
  "are",
  "was",
  "were",
  "yes",
  "yep",
  "yeah",
  "yup",
  "sure",
  "no",
  "nope",
  "nah",
  "done",
  "well",
  "much",
  "very",
  "so",
  "and",
  "now",
  "then",
  "i",
  "we",
  "my",
  "me",
  "am",
  "happy",
  "glad",
  "love",
  "like",
  "super",
  "it's",
  "its",
  "one",
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
   * The commit the task OPENED at, when the workspace is a git repository.
   *
   * V8 critical 5. "Did this task write the program this check runs?" was asked
   * of `git status`, which answers "no" the moment the run commits the check it
   * wrote — and committing is how a task normally ends. Everything between this
   * commit and HEAD was committed DURING the task, which is the task's work by
   * any reading. Written once at intake and never rewritten, so it survives the
   * crash and the resume the write ledger does not.
   */
  baseCommit?: string;
  /**
   * Required criteria with no bound evidence at verdict time. Written by
   * `computeVerdict`'s caller from the verdict it returns; named in the gaps
   * as `no check bound`, which is the fact a reader needs and the one a
   * "0 of 2 verified" count hides.
   */
  uncovered: string[];
  /**
   * Each staged acceptance script's sha256 as of the FIRST intake against this
   * workspace, and what the stage did about it (V7 finding 3).
   *
   * The record half of the pin: the vault beside the database holds the bytes
   * and survives the run, this says what they hashed to and is in the session
   * log, so `rune audit` can answer "was the oracle this run measured with the
   * one the person stated" from the record rather than from the filesystem.
   * Absent when no acceptance is configured, which is every run today.
   */
  acceptance?: {
    pins: Array<{ path: string; digest: string }>;
    /** Empty on an honest run; one line per script staged from its pin. */
    notes: string[];
  };
}

export interface CreateContractInput {
  intent: string;
  /** The commit HEAD is at right now, when there is one. See `baseCommit`. */
  baseCommit?: string | null;
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
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
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
export function amendContract(
  contract: TaskContract,
  brief: Brief,
  origin: ContractAmendment["origin"] = "model",
): TaskContract {
  const drift = briefDrift(contract, brief);
  return { ...carryForward(contract, brief, origin), ...(drift ? { drift } : {}) };
}

/** Two criteria are the same requirement when their words are. */
function criterionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The next free `c<n>` for a contract, so an id is never reused. */
function nextCriterionId(existing: readonly Criterion[]): () => string {
  let max = 0;
  for (const c of existing) {
    const m = /^c(\d+)$/.exec(c.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return () => `c${++max}`;
}

/**
 * A criterion the MODEL may not touch: the person stated it, or the runtime's
 * own evaluator did.
 *
 * `inferred` is the read-back's own reading, and rewording it is the model's
 * job. Everything else is somebody else's statement of what done means.
 */
function protectedCriterion(c: Criterion): boolean {
  return c.source === "user" || c.source === "evaluator";
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
export function carryForward(
  contract: TaskContract,
  brief: Brief,
  origin: ContractAmendment["origin"] = "model",
): TaskContract {
  const before = contract.criteria;
  const stated = brief.criteria;
  const assignId = nextCriterionId([...before, ...stated]);
  const statedKeys = new Set(stated.map((c) => criterionKey(c.text)));
  const beforeByKey = new Map(before.map((c) => [criterionKey(c.text), c] as const));

  // ── What the model restated, with its identity preserved ──
  //
  // An amendment that keeps a criterion's TEXT keeps its id, its source and
  // its strength. Without that, a read-back that repeated a user-stated
  // criterion word for word downgraded it to the model's own — so the
  // protection lasted exactly one turn, which is worse than no protection at
  // all because the record says it held.
  for (const c of stated) {
    const prior = beforeByKey.get(criterionKey(c.text));
    if (prior) {
      c.id ??= prior.id;
      c.source ??= prior.source;
      if (prior.required !== undefined) c.required = prior.required;
      if (prior.method !== undefined) c.method = prior.method;
      // A rung already earned against this exact requirement is not lost to a
      // reword of the surrounding brief.
      if (c.rung == null && prior.rung != null) {
        c.rung = prior.rung;
        c.evidence ??= prior.evidence;
      }
    }
    c.id ??= assignId();
    c.source ??= "inferred";
  }

  // ── What it OMITTED, and the runtime put back ──
  //
  // The failure this exists for: a model that cannot meet a requirement
  // drops it from its next read-back, and the contract it is measured
  // against quietly becomes the work it managed to do. `kept` makes that a
  // recorded fact rather than a missing line. Only a `user` amendment can
  // actually remove one.
  const kept: Criterion[] = before.filter(
    (c) => protectedCriterion(c) && !statedKeys.has(criterionKey(c.text)),
  );
  const keptHere = origin === "user" ? [] : kept;
  const criteria = [...stated, ...keptHere];

  // ── Constraints ──
  //
  // The `leave` list plus everything a person stated. Union, never a
  // replacement: a constraint the user gave on turn one is not the model's to
  // forget on turn four by omitting it from a read-back.
  const constraints = [
    ...new Set([
      ...(contract.constraints ?? []),
      ...brief.leave.map((s) => String(s).trim()).filter(Boolean),
      ...criteria.filter((c) => c.source === "user").map((c) => c.text),
    ]),
  ];

  const amended: TaskContract = {
    ...normalizeContract(contract),
    scope: { touch: [...brief.touch], leave: [...brief.leave] },
    criteria,
    constraints,
  };

  // A revision is bumped only by a change a reader would act on — the same
  // rule `persistContract` dedupes rows by, so the two cannot disagree about
  // whether anything happened.
  //
  // With ONE addition: a read-back that omitted a protected criterion changes
  // nothing about the contract (the runtime put it straight back) and is
  // nevertheless the most important thing this function can report. Without
  // this clause the attempt left no trace at all, because a contract that
  // successfully refused to shrink is byte-identical to one nobody attacked.
  const unchanged = contractDigest(amended) === contractDigest(normalizeContract(contract));
  if (unchanged && keptHere.length === 0) return amended;

  const added = stated.filter((c) => !beforeByKey.has(criterionKey(c.text))).map((c) => c.text);
  const removed = before
    .filter((c) => !protectedCriterion(c) && !statedKeys.has(criterionKey(c.text)))
    .map((c) => c.text)
    .concat(origin === "user" ? kept.map((c) => c.text) : []);
  const revision = (contract.revision ?? 1) + 1;
  amended.revision = revision;
  amended.amendments = [
    ...(contract.amendments ?? []),
    {
      revision,
      at: new Date().toISOString(),
      origin,
      added,
      kept: keptHere.map((c) => c.text),
      removed,
    },
  ].slice(-AMENDMENT_CAP);
  // The criteria array the LEDGER holds must be the one the contract holds, or
  // a rung earned after the amendment lands on an object nothing reads. The
  // ledger reads `brief.criteria` on every access, so replacing the array is
  // enough — and it is what puts the kept criteria back in front of
  // `record_evidence`'s indexes as well as in front of the verdict.
  brief.criteria = criteria;
  return amended;
}

/** Amendments carried on the contract row. A run with more is pathological. */
const AMENDMENT_CAP = 32;

// ─── The independent oracle: acceptance the model never sees ───
//
// Every criterion up to here originated with the model's read-back, which
// means the run's own account of what done meant was written by the thing
// being measured. That is fine for most work and useless for the one question
// the review asks first: does a known OMITTED feature fail acceptance despite
// green existing tests? It cannot, if the only acceptance on record is the
// list the model wrote after deciding what it was going to build.
//
// An acceptance spec is stated OUTSIDE the run — `--acceptance <file>`, or an
// embedder's config — loaded at intake, never rendered into any prompt, never
// citable, and run by the runtime itself at the finish gate.

/** One externally stated acceptance criterion. */
export interface AcceptanceSpec {
  /** Stable name, for a reader comparing runs. Defaults to `a1`, `a2`, … */
  id?: string;
  /** What must be true, in the person's words. */
  text: string;
  /**
   * The command the RUNTIME runs to settle it. Absent means only a person can
   * settle it, which derives `needs_review` and is never `satisfied`.
   */
  command?: string;
  /** Absent means required. */
  required?: boolean;
  /** `evaluator` (the default) or `user`. Never `inferred` — nobody inferred this. */
  source?: "user" | "evaluator";
  /**
   * Extra workspace files the command needs, so they are staged with it.
   *
   * `stageAcceptance` already copies out every script the command NAMES. A
   * script that loads a sibling module names it nowhere the runtime can read,
   * so the author names it here: paths relative to the workspace root, files
   * or directories. This is the documented seam a fixture generator builds
   * against — see `stageAcceptance` for the two rules it must keep.
   */
  files?: string[];
}

/**
 * Read an acceptance file: a JSON array, or an object with a `criteria` array.
 *
 * Refuses rather than guesses. A malformed acceptance file that silently
 * loaded zero criteria would be the worst possible failure of this feature —
 * the run would report `met` against nothing, and the file's author would
 * have no way to tell that from a run that passed.
 */
export function parseAcceptanceSpecs(raw: string, where = "the acceptance file"): AcceptanceSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { criteria?: unknown } | null)?.criteria ?? null);
  if (!Array.isArray(list)) {
    throw new Error(`${where} must be a JSON array of criteria, or { "criteria": [ … ] }`);
  }
  const specs: AcceptanceSpec[] = [];
  list.forEach((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const text = String(row.text ?? "").trim();
    if (!text) throw new Error(`${where}: criterion ${i} has no \`text\``);
    const command = String(row.command ?? "").trim();
    const source = row.source === "user" ? "user" : "evaluator";
    specs.push({
      id: String(row.id ?? "").trim() || undefined,
      text,
      ...(command ? { command } : {}),
      ...(row.required === false ? { required: false } : {}),
      source,
      ...(Array.isArray(row.files) && row.files.length > 0
        ? {
            files: row.files
              .map((f) => String(f ?? "").trim())
              .filter((f): f is string => f.length > 0),
          }
        : {}),
    });
  });
  if (specs.length === 0) throw new Error(`${where} states no criteria`);
  return specs;
}

/** The specs as criteria, ready to go on the contract. Ids never collide with `c<n>`. */
export function acceptanceCriteria(specs: readonly AcceptanceSpec[]): Criterion[] {
  return specs.map((spec, i) => ({
    text: spec.text,
    rung: null,
    id: spec.id ?? `a${i + 1}`,
    source: spec.source ?? "evaluator",
    ...(spec.required === false ? { required: false } : {}),
    method: spec.command
      ? ({ kind: "command", command: spec.command } as const)
      : ({ kind: "review" } as const),
  }));
}

// ─── Staging: the oracle out of the thing it measures ───
//
// V6 finding 1. The citation path was closed — `record_evidence` refuses an
// evaluator criterion — and the FILESYSTEM path was wide open. An acceptance
// command runs "through the registry's `bash`, which means the same sandbox,
// the same cwd", so a command naming a script inside the workspace ran a file
// the model could overwrite with `write_file`. It did not need to have seen
// the command: `ls -a` finds the script, and one `write_file` turns the
// independent oracle into `console.log('1 pass, 0 fail')`. The run then
// reported `met` with nothing built.
//
// So the runtime stages the acceptance OUT of the workspace at intake and
// runs it from there. Three properties, and each one is load-bearing:
//
//  · OUTSIDE. The staged copy lives under a directory the workspace does not
//    contain, so `write_file` and `read_file` — both scoped to the workspace —
//    cannot reach it at all.
//  · UNNAMED. The directory is `mkdtemp`'d, so its path is not derivable from
//    anything the model can see, and the rewritten command never reaches a
//    prompt (the same rule that already keeps the criterion text out).
//  · PINNED. Every staged file's sha256 is recorded at intake and re-read
//    before the gate runs. A staged file that changed anyway is not measured
//    with; the criterion derives `needs_review`. This is the belt to the
//    other two braces, and it is what makes the guarantee checkable rather
//    than argued.
//
// **The staging rule, for a fixture author** (`tests/eval/corpus`, or anyone
// writing an `--acceptance` file):
//
//  1. A staged script runs with **cwd = the workspace**. Address the tree
//     under test by RELATIVE path (`readFileSync('api.ts')`) or through
//     `process.cwd()`. A path resolved from `import.meta.url` / `__dirname`
//     now points at the staging directory, not the workspace, and will not
//     find the file it is looking for — which derives `needs_review`, not a
//     false `satisfied`, but it is still not the check you meant to write.
//  2. Anything the entry script LOADS must be named in the spec's `files`,
//     because the runtime only sees what the command itself names. Paths are
//     workspace-relative; a directory is copied whole (bounded).
//
// A command naming a file OUTSIDE the workspace is left exactly as written:
// it is already out of the model's reach, which is the property this is for.

/** Scripts are staged by shape; anything else must be named in `files`. */
const STAGEABLE = /\.(?:[cm]?[jt]s|sh|bash|zsh|py|rb|pl|php|lua|exp|mjs|cjs)$/i;
const STAGE_MAX_FILES = 200;
const STAGE_MAX_BYTES = 4 * 1024 * 1024;

/** What `stageAcceptance` produced: where it lives, and what to run instead. */
export interface StagedAcceptance {
  /** The staging directory. Never inside the workspace. */
  root: string;
  /** The same specs, with every in-workspace script rewritten to its copy. */
  specs: AcceptanceSpec[];
  /** Staged absolute path → sha256 at intake. Re-read before the gate runs. */
  digests: Record<string, string>;
  /** Workspace-relative → staged absolute, for the record and for a reader. */
  staged: Array<{ from: string; to: string }>;
  /**
   * Workspace-relative → the sha256 pinned at the FIRST intake for this
   * workspace, for the contract row and for a reader (V7 finding 3).
   */
  pins: Array<{ path: string; digest: string }>;
  /**
   * What the stage did that the caller must see: a script whose workspace copy
   * no longer matches its pin, staged from the pinned copy instead. Empty on
   * every honest run.
   */
  notes: string[];
  /**
   * The criteria that CANNOT be measured on this tree: a pin exists for a
   * script they name and its bytes are gone from the vault (V8 critical 3).
   *
   * The gate skips these rather than running them. Staging the workspace copy
   * of a script the pin says was rewritten is the fail-OPEN the pin exists to
   * prevent, and it is worse than the hole it replaced because the code has
   * already computed the mismatch and would be staging a rewrite it detected.
   */
  unmeasurable: Array<{ criterion: string; path: string }>;
}

/**
 * The durable copy of every acceptance script, and its digest, kept OUTSIDE
 * the workspace across runs.
 *
 * V7 finding 3 — V6's first critical, reopening one session later.
 * `installAcceptance` runs `stagedAcceptance ??= stageAcceptance(specs, …)` at
 * the intake of EVERY Engine, seeded from the workspace AS IT STANDS THEN. The
 * staging directory is discarded at the end of the run, so the in-workspace
 * copy of the oracle was still the seed of every future stage: session 1 built
 * nothing and rewrote `.rune-acceptance/check.mjs` to `console.log('1 pass, 0
 * fail')` — honest `partial`, the shipped guarantee holding — and session 2, a
 * new `rune` invocation on the same workspace with the same `--acceptance`,
 * staged the tampered file and reported `met` with the tree byte-identical to
 * HEAD.
 *
 * "The command that runs at the finish gate is one no tool IN THIS RUN could
 * have edited" was the guarantee as written, and it is narrower than the
 * property anyone reading it assumes. So the pin is the property: the first
 * intake records each script's digest AND keeps its bytes here; every later
 * intake stages from the workspace only while the workspace copy still hashes
 * to the pin, and otherwise stages the pinned copy and says so. Editing the
 * oracle in the workspace then changes nothing, in this run or in any after
 * it — which is what a person who states an acceptance means by stating one.
 *
 * A person who legitimately revises their acceptance file deletes this
 * directory, or points `--acceptance` at the revised file: the pin is per
 * workspace and per relative path, and `rm -rf` on a directory beside the
 * database is a thing a person can do and a run cannot reach.
 */
export interface AcceptanceVault {
  /** Where the pinned copies and the manifest live. Never inside the workspace. */
  dir: string;
  /**
   * The task this pin belongs to — the contract's id (V8 finding 12).
   *
   * The manifest was keyed by workspace-relative path alone, forever. Two tasks
   * in one workspace naming the same `check.mjs` with different, entirely
   * legitimate bytes meant task B was staged from task A's pin and the note
   * reported the revision as tampering, with no re-pin short of deleting a
   * directory the person has not been told exists. A pin is a statement about
   * ONE task's oracle, so the key says which task.
   */
  taskKey?: string;
  /**
   * Pins this workspace is KNOWN to have taken, from the contract row of an
   * earlier run (V8 critical 3).
   *
   * The manifest is the vault's own account of itself, so a vault that was
   * removed wholesale reads as "no pin was ever taken" and the next intake
   * seeds happily from the workspace. The contract row is a second, independent
   * record of the same fact, and it lives in the session log where the run
   * cannot reach it. When it names a path the manifest has forgotten, the pin
   * is MISSING rather than absent, and the criterion is unmeasurable.
   */
  knownPins?: ReadonlyArray<{ path: string; digest: string }>;
}

/** The manifest file inside the vault: pin key → sha256. */
const VAULT_MANIFEST = "pinned.json";

/**
 * The vault's witness, one directory UP (V9 finding 15).
 *
 * `knownPins` closed the wholesale removal for a run whose contract row was
 * restored, and left it open for a brand-new session: with no row, a removed
 * vault reads as "no pin was ever taken" and the rewritten oracle is staged as
 * a happy first intake, silently. A manifest cannot report its own removal, so
 * the second witness has to live outside the thing that can be removed — and
 * the pins DIRECTORY is exactly that place. It is a sibling file of the vault,
 * under the same `acceptance-pins` control directory, so:
 *
 *   · `rm -rf <vault>` — what a run reaching for its own oracle would do —
 *     leaves the index standing, and every pin it names is MISSING rather than
 *     absent: the criteria are unmeasurable and the gate does not run them.
 *   · `rm -rf <pins root>` — what a PERSON does to re-pin a revised acceptance
 *     — takes the index with it, which is the documented way back and is a
 *     guardrail change in 4th gear rather than an ordinary write.
 */
function vaultIndexPath(vaultDir: string): string {
  return join(dirname(vaultDir), `${basename(vaultDir)}.pins.json`);
}

function readVaultIndex(vaultDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(vaultIndexPath(vaultDir), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The index only ever GROWS: a pin it has seen is a pin that was taken. */
function writeVaultIndex(vaultDir: string, pins: Record<string, string>): void {
  try {
    const merged = { ...readVaultIndex(vaultDir), ...pins };
    mkdirSync(dirname(vaultDir), { recursive: true });
    writeFileSync(vaultIndexPath(vaultDir), JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // No index is the behaviour that shipped: the contract row is still a
    // witness, and nothing claims a pin that was not taken.
  }
}

/**
 * The manifest key for one script. Task-scoped when the caller named a task,
 * so a second task reusing the path is not measured by the first task's oracle.
 */
function pinKey(taskKey: string | undefined, relKey: string): string {
  return taskKey ? `${taskKey}::${relKey}` : relKey;
}

/**
 * The identity of an acceptance, for `AcceptanceVault.taskKey` (V8 finding 12).
 *
 * What the person STATED, not what they asked for: the criteria and the
 * commands, in order. Keying on the request instead would reopen V7 critical 3
 * on the first follow-up — "carry on" is a different intent against the same
 * acceptance, and surviving exactly that second session is what the pin is for.
 *
 * Read from the specs as handed in, before any staging rewrite, so the key is
 * the same on the run that takes the pin and on every run that reads it.
 */
export function acceptanceKey(specs: readonly AcceptanceSpec[]): string {
  const stated = specs.map((spec, i) => [
    spec.id ?? `a${i + 1}`,
    spec.text.trim(),
    spec.command?.trim() ?? "",
    (spec.files ?? []).join(","),
  ]);
  return createHash("sha256").update(JSON.stringify(stated)).digest("hex").slice(0, 16);
}

function readVault(dir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, VAULT_MANIFEST), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeVault(dir: string, pins: Record<string, string>): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, VAULT_MANIFEST), JSON.stringify(pins, null, 2) + "\n");
  } catch {
    // A vault that cannot be written leaves the run with the old behaviour and
    // no false claim: `notes` stays empty and nothing pretends to be pinned.
  }
}

/** Whether a resolved path is inside the root (the workspaceDigest rule). */
function inside(root: string, full: string): boolean {
  return full !== root && full.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The same test, asked of the path the filesystem will actually open.
 *
 * V8 finding 13: `inside()` is a string test over `resolve()`d paths, and
 * `resolve` does not follow links. A workspace `check.mjs` symlinked to
 * `/outside/real.mjs` read as an in-workspace file, so it was staged and pinned
 * on bytes the workspace does not own — and the premise the whole staging pass
 * rests on ("copy every in-workspace file OUT of the workspace") does not hold
 * for it: the target stays where the run can still edit it, under a pin that
 * says it was captured.
 *
 * A path that cannot be resolved (it does not exist yet) falls back to the
 * lexical answer, which is what every caller wants for a file about to be made.
 */
function realInside(root: string, full: string): boolean {
  let realRoot = root;
  let realFull = full;
  try {
    realRoot = realpathSync(root);
  } catch {
    // A workspace root we cannot resolve is the lexical one.
  }
  try {
    realFull = realpathSync(full);
  } catch {
    return inside(root, full);
  }
  return inside(realRoot, realFull) && inside(root, full);
}

/** A shell word that survives the shell: quoted only when it has to be. */
function shellQuote(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Everything a staging pass accumulates, so `copyInto` stays one call. */
interface StageSink {
  digests: Record<string, string>;
  staged: Array<{ from: string; to: string }>;
  /** The vault's manifest, read at the start and written back if it grew. */
  pins: Record<string, string>;
  vaultDir: string | undefined;
  /** The task the pins are keyed by, if the caller named one. */
  taskKey: string | undefined;
  notes: string[];
  pinned: boolean;
  /** Paths whose pin exists and whose pinned BYTES do not. Fails closed. */
  missing: string[];
}

/** Copy one workspace file or directory into the stage; returns what it wrote. */
function copyInto(workspaceRoot: string, stageRoot: string, rel: string, sink: StageSink): void {
  if (sink.staged.length >= STAGE_MAX_FILES) return;
  const from = resolve(workspaceRoot, rel);
  if (!realInside(workspaceRoot, from)) return;
  let stats;
  try {
    stats = statSync(from);
  } catch {
    return;
  }
  const relPath = relative(workspaceRoot, from);
  const to = join(stageRoot, relPath);
  if (stats.isDirectory()) {
    let entries: string[];
    try {
      entries = readdirSync(from);
    } catch {
      return;
    }
    for (const entry of entries) copyInto(workspaceRoot, stageRoot, join(rel, entry), sink);
    return;
  }
  if (!stats.isFile() || stats.size > STAGE_MAX_BYTES) return;
  if (sink.staged.some((row) => row.to === to)) return;

  // ── The pin (V7 finding 3) ──
  //
  // The workspace copy is the seed only while it still hashes to what the
  // FIRST intake recorded. Once it does not, the workspace copy is not this
  // acceptance any more: the pinned bytes are staged instead and the run says
  // so, rather than measuring the work with an oracle the work rewrote.
  let source = from;
  const relKey = relPath.split(sep).join("/");
  const key = pinKey(sink.taskKey, relKey);
  // The BYTES are task-scoped for the same reason the manifest key is: task B
  // pinning its own `check.mjs` must not overwrite the copy task A is measured
  // against.
  const vaultCopy = sink.vaultDir
    ? join(sink.vaultDir, "files", ...(sink.taskKey ? [sink.taskKey] : []), relPath)
    : undefined;
  if (sink.vaultDir) {
    let here: string | null = null;
    try {
      here = createHash("sha256").update(readFileSync(from)).digest("hex");
    } catch {
      here = null;
    }
    const pinned = sink.pins[key];
    if (pinned === undefined) {
      // First intake for this path: keep the bytes and record the digest.
      if (here !== null && vaultCopy) {
        try {
          mkdirSync(dirname(vaultCopy), { recursive: true });
          copyFileSync(from, vaultCopy);
          sink.pins[key] = here;
          sink.pinned = true;
        } catch {
          // No vault, no pin, and no claim of one.
        }
      }
    } else if (here === pinned) {
      // The workspace copy still IS the pinned oracle. Nothing to say.
    } else if (vaultCopy && existsSync(vaultCopy)) {
      source = vaultCopy;
      // The note names the vault, because the only way to re-pin deliberately
      // is to remove it — and a person told their revision was "tampering" and
      // not told where the pin lives has no move to make (V8 finding 12).
      sink.notes.push(
        `acceptance script changed in workspace — pinned copy used (${relKey}); ` +
          `to re-pin a deliberate revision, remove ${sink.vaultDir}`,
      );
    } else {
      // ── Fail closed (V8 critical 3) ──
      //
      // A pin with no bytes behind it. The code has ALREADY computed that the
      // workspace copy is not the oracle that was stated; staging it anyway is
      // measuring the work with the rewrite, on the one branch that exists to
      // refuse exactly that. The criterion is not settled here and it is not
      // failed either — it cannot be measured, which is `needs_review`.
      sink.missing.push(relKey);
      sink.notes.push(
        `acceptance pin missing — the pinned bytes for ${relKey} are gone from the vault ` +
          `and the workspace copy does not match the pin; the criterion was not run`,
      );
      return;
    }
  }

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(source, to);
  sink.digests[to] = createHash("sha256").update(readFileSync(to)).digest("hex");
  sink.staged.push({ from: relPath, to });
}

// ─── What the check LOADS, and never says it loads (V9 finding 16) ───
//
// `files:` pins what the author named. A check that imports a sibling helper
// the author did not list was not staged, not pinned, and rewriting that
// helper — which is rewriting what the oracle measures — produced no note at
// all. The same for a fixture the check reads: the script was pinned and the
// data it grades against was not.
//
// So the staged scripts are read for what they import, statically, and each
// dependency is pinned like any other acceptance file. Static is a real limit
// and it is stated: a path the check builds at runtime is not here, and the
// sandbox's own read audit is the only thing that could see one.
const DEPENDENCY_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']((?:\.{1,2}\/)[^"']+)["']/g;

/** Extensions a specifier may have dropped, in the order a loader tries them. */
const DEPENDENCY_EXTENSIONS = ["", ".mjs", ".cjs", ".js", ".ts", ".mts", ".cts", ".json"];

function dependenciesOf(file: string): string[] {
  let text: string;
  try {
    if (statSync(file).size > STAGE_MAX_BYTES) return [];
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(DEPENDENCY_SPECIFIER)) out.push(m[1]!);
  return out;
}

/**
 * A file the workspace names but does not own — a symlink pointing out of the
 * tree. It cannot be staged (V8 finding 13: staging it would pin bytes the
 * workspace does not control and leave the target editable), but its CONTENT
 * is still what the oracle measures, so its digest is pinned as a witness: the
 * next intake says so when it changes, and nothing is copied or run from it.
 */
function witnessPin(workspaceRoot: string, full: string, sink: StageSink): void {
  if (!sink.vaultDir) return;
  const relKey = relative(workspaceRoot, full).split(sep).join("/");
  if (!relKey || relKey.startsWith("..")) return;
  const key = pinKey(sink.taskKey, relKey);
  let here: string;
  try {
    here = createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return;
  }
  const pinned = sink.pins[key];
  if (pinned === undefined) {
    sink.pins[key] = here;
    sink.pinned = true;
    return;
  }
  if (pinned === here) return;
  sink.notes.push(
    `acceptance dependency changed outside the workspace — ${relKey} is a link to a file ` +
      `this workspace does not own and its contents are not what the pin recorded`,
  );
}

/**
 * Pin what the staged scripts import. Bounded by the same file ceiling as the
 * stage itself, and by a visited set, so a cycle or a fan-out cannot run away.
 */
function stageDependencies(workspaceRoot: string, stageRoot: string, sink: StageSink): void {
  const seen = new Set<string>();
  for (let guard = 0; guard < STAGE_MAX_FILES; guard++) {
    const next = sink.staged.find((row) => !seen.has(row.to));
    if (!next) return;
    seen.add(next.to);
    for (const spec of dependenciesOf(next.to)) {
      // Resolved against the file's own directory IN THE WORKSPACE, which is
      // where the loader would resolve it from when the check is run.
      const fromDir = dirname(resolve(workspaceRoot, next.from));
      for (const ext of DEPENDENCY_EXTENSIONS) {
        const candidate = resolve(fromDir, spec + ext);
        if (!existsSync(candidate)) continue;
        if (realInside(workspaceRoot, candidate)) {
          copyInto(workspaceRoot, stageRoot, relative(workspaceRoot, candidate), sink);
        } else if (inside(workspaceRoot, candidate)) {
          witnessPin(workspaceRoot, candidate, sink);
        }
        break;
      }
    }
  }
}

/**
 * Copy every in-workspace file the acceptance needs out of the workspace, and
 * rewrite the commands to run the copies.
 *
 * Pure of the Engine on purpose: it takes the two roots and the specs, so the
 * property it exists for — "a later edit inside the workspace changes
 * nothing" — is testable without driving a run.
 *
 * `vault` makes that property hold ACROSS runs as well as within one; see
 * `AcceptanceVault`. Without it the behaviour is exactly what it was, which is
 * what every unit call site wants.
 */
export function stageAcceptance(
  specs: readonly AcceptanceSpec[],
  opts: { workspaceRoot: string; stagingBase?: string; vault?: AcceptanceVault },
): StagedAcceptance {
  const workspaceRoot = resolve(opts.workspaceRoot);
  // A base inside the workspace would defeat the whole point, quietly.
  const requested = opts.stagingBase ? resolve(opts.stagingBase) : tmpdir();
  const base =
    inside(workspaceRoot, requested) || requested === workspaceRoot ? tmpdir() : requested;
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "rune-acceptance-"));
  // A vault inside the workspace would be reachable by the thing it pins.
  const vaultDir =
    opts.vault && !inside(workspaceRoot, resolve(opts.vault.dir))
      ? resolve(opts.vault.dir)
      : undefined;
  const taskKey = opts.vault?.taskKey;
  const pins = vaultDir ? readVault(vaultDir) : {};
  // A pin the CONTRACT ROW remembers and the manifest has forgotten is a pin
  // whose bytes are gone — the whole-vault removal, which the manifest alone
  // can never report because it is the thing that was removed. Seeding it here
  // puts that path on the `pinned !== undefined` branch, where the absent
  // vault copy makes it unmeasurable instead of a fresh first intake.
  if (vaultDir) {
    // The index first: it answers for a session that has no contract row at
    // all, which is the half of V8 critical 3 that stayed open.
    for (const [key, digest] of Object.entries(readVaultIndex(vaultDir))) {
      if (pins[key] === undefined) pins[key] = digest;
    }
    for (const known of opts.vault?.knownPins ?? []) {
      if (typeof known?.path !== "string" || !/^[0-9a-f]{64}$/.test(known?.digest ?? "")) continue;
      const key = pinKey(taskKey, known.path);
      if (pins[key] === undefined) pins[key] = known.digest;
    }
  }
  const sink: StageSink = {
    digests: {},
    staged: [],
    pins,
    vaultDir,
    taskKey,
    notes: [],
    pinned: false,
    missing: [],
  };

  const unmeasurable: Array<{ criterion: string; path: string }> = [];
  const rewritten = specs.map((spec, index) => {
    const named = [
      ...(spec.files ?? []),
      ...(spec.command ? commandPaths(spec.command).filter((t) => STAGEABLE.test(t)) : []),
    ];
    const missingBefore = sink.missing.length;
    for (const rel of named) copyInto(workspaceRoot, root, rel, sink);
    // …and what those files import, which the author did not have to name.
    stageDependencies(workspaceRoot, root, sink);
    for (const path of sink.missing.slice(missingBefore)) {
      unmeasurable.push({ criterion: spec.id ?? `a${index + 1}`, path });
    }
    if (!spec.command) return { ...spec };
    // Only the tokens that actually became a staged file are rewritten; a
    // path that named nothing, or named something outside the workspace, is
    // left exactly as the author wrote it.
    const map = new Map<string, string>();
    for (const token of commandPaths(spec.command)) {
      const full = resolve(workspaceRoot, token);
      if (!realInside(workspaceRoot, full)) continue;
      const to = join(root, relative(workspaceRoot, full));
      if (sink.digests[to]) map.set(token, to);
    }
    if (map.size === 0) return { ...spec };
    const pattern = [...map.keys()]
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const command = spec.command.replace(new RegExp(pattern, "g"), (token) =>
      shellQuote(map.get(token) ?? token),
    );
    return { ...spec, command };
  });

  if (vaultDir && sink.pinned) {
    writeVault(vaultDir, sink.pins);
    writeVaultIndex(vaultDir, sink.pins);
  }

  return {
    root,
    specs: rewritten,
    digests: sink.digests,
    staged: sink.staged,
    // The row carries the workspace-relative path, not the manifest key: the
    // task scope is this vault's business, and a reader asking "which oracle
    // measured this" is asking about a file.
    pins: Object.entries(sink.pins)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, digest]) => ({
        path: taskKey && key.startsWith(`${taskKey}::`) ? key.slice(taskKey.length + 2) : key,
        digest,
      })),
    notes: sink.notes,
    unmeasurable,
  };
}

/**
 * The staged files whose bytes are not what intake recorded, if any.
 *
 * Should always be empty — the stage is outside the workspace and its name is
 * random. It is read before every gate run anyway, because a guarantee that
 * is only argued for is the kind V6 found four of.
 */
export function stagedAcceptanceDrift(staged: StagedAcceptance | null | undefined): string[] {
  if (!staged) return [];
  const moved: string[] = [];
  for (const [path, digest] of Object.entries(staged.digests)) {
    let now: string | null = null;
    try {
      now = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      now = null;
    }
    if (now !== digest) moved.push(path);
  }
  return moved;
}

/** Remove a staging directory. Never throws: it is a temp directory. */
export function discardStagedAcceptance(staged: StagedAcceptance | null | undefined): void {
  if (!staged?.root) return;
  try {
    if (existsSync(staged.root)) rmSync(staged.root, { recursive: true, force: true });
  } catch {
    // A stage that outlives the run costs a few KiB in the temp directory.
  }
}

/**
 * Did the acceptance command actually RUN, or did it merely exit?
 *
 * The two cases the review names, and they look identical from a green suite:
 * a command that exits 0 having collected nothing (`bun test nothing.test.ts`),
 * and a command whose runner is not installed. Neither is evidence about the
 * work, so both derive `needs_review` — never `satisfied`, and never `failed`
 * either, because "we could not measure" is not "it is broken".
 *
 * The runner vocabulary is `couldNotRunOnParent`'s, held to examples in
 * `parent-check.test.ts`; the shell's own two answers for a missing program
 * (127, and the words it prints) are added here because an acceptance command
 * is run against THIS tree, where a missing runner is the whole finding.
 */
export function acceptanceDidNotRun(output: string, exitCode?: number, command?: string): boolean {
  // A command that could not fail is not a measurement (V6 finding 25).
  // `true` exits 0 and prints nothing, so no runner-shaped "0 tests" line
  // exists for the false-positive defence to catch, and the criterion read
  // `satisfied` on the strength of an exit code nothing produced.
  if (command && isNoOpCommand(command)) return true;
  if (exitCode === 127) return true;
  if (/command not found|: not found\b|no such file or directory/i.test(output)) return true;
  return couldNotRunOnParent(output);
}

/**
 * The newest `contract` row in a session's log, or null.
 *
 * A pure read, so the restart path can be tested without an Engine. Version 1
 * rows only — a row from a future schema is not guessed at.
 */
export function priorContract(
  events: Array<{ event: { type: string; payload: Record<string, unknown> } }>,
): TaskContract | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]!.event;
    if (row.type !== "contract") continue;
    const payload = row.payload as { version?: unknown; contract?: unknown };
    if (payload.version !== 1) continue;
    const contract = payload.contract as TaskContract | undefined;
    if (!contract || typeof contract !== "object" || typeof contract.intent !== "string") continue;
    return normalizeContract(contract);
  }
  return null;
}

/**
 * What a RESTARTED run inherits from the contract of the run it continues.
 *
 * `carryForward` recovers the criteria from the restored brief; this recovers
 * the facts that live only on the contract — the constraints the person
 * stated, how many times it has been amended, and by whom. Without it a
 * SIGKILL was a clean slate for exactly the fields that exist to survive one:
 * the next run started at revision 1 with no constraints, and a `user`
 * criterion the model had already omitted once could be omitted again with
 * nothing on the record saying it had ever been stated.
 */
export function inheritContract(
  contract: TaskContract,
  prior: TaskContract | null | undefined,
): TaskContract {
  if (!prior) return contract;
  const before = normalizeContract(prior);
  return {
    ...contract,
    revision: Math.max(contract.revision ?? 1, before.revision),
    constraints: [...new Set([...before.constraints, ...(contract.constraints ?? [])])],
    amendments: [...before.amendments].slice(-AMENDMENT_CAP),
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
  const bound = boundRun(criterion, checks);
  // ── An execution receipt is a fact, not an acceptance ──
  //
  // `echo done` exits 0. So does `git status`. Neither could have FAILED for
  // the criterion it is cited against, and a criterion is settled only by a
  // check that could have. Before M1 the cap held by accident: an execution
  // was capped at `observed`, and `met` required `verified` — which is why
  // F-5B deliberately left executions out of the relatedness gate. M1 removed
  // that accident by making acceptance a separate fact, and this is the rule
  // that has to carry the weight instead.
  //
  // Both halves are needed. The log's `kind` is authoritative while the run is
  // live; the verifier name is what survives on a saved row read back with no
  // check log behind it (`rune audit`). Never `satisfied` either way.
  if (bound?.latest.kind === "execution" || evidence.verifier === "execution-receipt@1") {
    return "needs_review";
  }
  // ── The run wrote the check ──
  //
  // V6 finding 3: `kind` is decided by `isVerificationCommand`, which reads
  // the command's NAME, so `verify-header.sh` containing `echo '1 pass, 0
  // fail'` was a check. A program this run authored cannot have failed for the
  // criterion it is cited against, so it is worth exactly what an execution
  // receipt is worth. Both halves again: the log is authoritative live, the
  // verifier name survives on a saved row with no check log behind it.
  if (bound?.latest.authoredBy || evidence.verifier === "self-authored-check@1") {
    return "needs_review";
  }
  // ── The runner collected nothing ──
  //
  // V7 finding 9, and the same shape as the clause above: `bun test
  // nothing.test.ts` exits 0 having executed no test, and an exit code from a
  // runner that measured nothing says nothing about the work. The acceptance
  // gate has refused this since M1 (`acceptanceDidNotRun`) and the parent
  // probe since F-5B (`couldNotRunOnParent`); the model's own citation was
  // where nobody asked. Both halves again — the log live, the verifier name on
  // a saved row.
  if (bound?.latest.measuredNothing || evidence.verifier === "no-measurement@1") {
    return "needs_review";
  }
  // A verifier that ran and recorded no result could not SAY. The acceptance
  // runner writes this shape for a command that exited without measuring
  // anything — a runner that collected no tests, a runner that is not
  // installed — and both of those are "we could not measure", which is
  // neither `satisfied` nor `failed`. It is tested before the bound run
  // because a missing runner exits non-zero, and reading that as a failing
  // check would report a broken toolchain as broken work.
  if (evidence.verifier && !evidence.result) return "needs_review";
  if (evidence.result === "failed") return "failed";
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
  // What the independent oracle said, counted on its own (V6 finding 21).
  // `met` is untouched: this is reported beside the kind, never folded into
  // it, so a consumer can count acceptance by the measurement the model could
  // not influence — the one number a question or a plan CAN reach.
  const evaluatorOutcomes = criteria.filter((c) => c.source === "evaluator");
  const evaluators =
    evaluatorOutcomes.length > 0
      ? {
          evaluators: {
            satisfied: evaluatorOutcomes.filter((c) => c.status === "satisfied").length,
            total: evaluatorOutcomes.length,
          },
        }
      : {};
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
    if (asked && !input.wrote)
      return { kind: "none", criteria, reason: asked, execution, ...evaluators };
    return { kind: "unmet", criteria, missing: ["no criteria stated"], execution, ...evaluators };
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
    return { kind: "met", criteria, execution, ...evaluators };
  }

  // Not one criterion was ever assessed, and nothing else is open to declare:
  // there is nothing to name a gap AGAINST.
  const assessed = criteria.filter((c) => c.status !== "unassessed");
  if (assessed.length === 0 && !stepsOpen && red.length === 0) {
    return {
      kind: "unmet",
      criteria,
      missing: criteria.map((c) => c.text),
      execution,
      ...evaluators,
    };
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
  return { kind: "partial", criteria, gaps, execution, ...evaluators };
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
  // The oracle's own count, printed where a consumer reading one line can see
  // it. It does not change `met`; it says what the acceptance measured, which
  // is the only number a question or a plan can reach.
  const oracle =
    verdict.evaluators && verdict.evaluators.total > 0
      ? `; evaluator ${verdict.evaluators.satisfied} of ${verdict.evaluators.total} satisfied`
      : "";
  if (verdict.kind === "none") return `[verdict] none — ${verdict.reason}${oracle}`;
  if (verdict.kind === "met") return `[verdict] met — ${count}${attributed}${oracle}`;
  if (verdict.kind === "partial") {
    const first = verdict.gaps[0];
    const rest = verdict.gaps.length - 1;
    const gap = first ? `; gap: ${first.criterion} (${first.why})` : "";
    return `[verdict] partial — ${count}${attributed}${oracle}${gap}${rest > 0 ? ` +${rest} more` : ""}`;
  }
  return `[verdict] unmet — ${count}${oracle}`;
}
