// ─── The brief: what the agent understood, before it touches anything ───
//
// A coding agent earns trust twice. First by showing it understood — BEFORE it
// acts. Then by showing its work in a form that can be audited in seconds. This
// file is the first half, and the ledger that closes the loop on the second.
//
// The move is a read-back: the agent's reading of the request, what it will
// deliberately leave alone, and how it will know it is done — committed to the
// screen before a file is opened, and correctable in one keystroke. Warmth in a
// terminal is not "Great question!"; it is being understood. Anyone can echo a
// request back. Naming what you are NOT going to touch is what proves you
// modelled the boundary, which is why `leave` is the highest-signal field here
// and why the schema asks for it rather than hoping for it.
//
// The second half is the part a prompt cannot be trusted to enforce. A criterion
// flips ONLY on an event carrying evidence — never because the model wrote
// "done". So the model is not given a way to set the rung: `read_back` accepts
// criteria as plain strings, and BriefLedger is the only thing that can move
// one, and it refuses `verified` without a recorded parent-commit failure.
//
// There is deliberately no rung for "probably". That absence is load-bearing:
// it means the agent structurally cannot write "this failure looks unrelated to
// my change" — the parent commit has to be checked, and the answer recorded.
//
// The runtime does that checking itself (parent-check.ts): when a passing
// command is cited, it re-runs that same command against the pre-change tree in
// a detached worktree and records what happened. `verified` used to be inferred
// from in-session red→green instead, which is a weaker and different claim —
// break a test, fix your own break, and it goes red→green while the parent
// commit was green the whole time. Nothing outside the test files ever set
// `parentCommit`, which is what that gap looked like from the outside.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@rune/tool-registry";
import type { TaskKind } from "@rune/protocol";
import { TASK_KINDS } from "@rune/protocol";

/**
 * Commands whose result is evidence, rather than merely another action:
 * tests, typechecks, lints, builds. The check log records only these, and a
 * step completed right after one of these FAILED is refused (task-state.ts).
 * Lives here, beside the ledger that consumes it, rather than in the UI layer
 * where it was born — no engine module may import a surface module, and a gate
 * on Phase 2 counts the violations.
 */
import {
  checkRelatedness,
  commandProgramPaths,
  normalizeCommand,
  samePathToken,
} from "./verification-command";
export { isVerificationCommand, normalizeCommand } from "./verification-command";

export const CLAIM_RUNGS: readonly ClaimRung[] = [
  "suspected",
  "observed",
  "reproduced",
  "verified",
] as const;

/** The one-cell mark for a rung, and its ASCII twin. Both are single-width. */
export const RUNG_GLYPH: Record<ClaimRung, { utf8: string; ascii: string }> = {
  suspected: { utf8: "~", ascii: "~" },
  observed: { utf8: "·", ascii: "." },
  reproduced: { utf8: "=", ascii: "=" },
  verified: { utf8: "✓", ascii: "+" },
};

/** What it costs to write each rung — shown in help, and enforced below. */
export const RUNG_MEANING: Record<ClaimRung, string> = {
  suspected: "a hypothesis. no evidence yet, and it says so.",
  observed: "it appeared in output that can be quoted back.",
  reproduced: "it was made to happen twice, on purpose.",
  verified: "a test that failed on the parent commit passes now.",
};

/**
 * A1 — what to do instead, when the cited command ran but is not a check.
 *
 * Appended to the `record_evidence` reply (both branches) whenever the cited
 * command's latest run is `kind: "execution"`. The receipt already says what
 * the runtime awarded; this says the two moves that would raise it, and — the
 * sentence that actually closes the loop — that a fourth phrasing is not one of
 * them. Pilot J spent three completions and one supervisor screen rewording a
 * citation the runtime had already answered as fully as it could.
 *
 * It lives in the REPLY and not in `Evidence.detail` because the detail rides
 * the plan ledger on every subsequent turn (`:193`) while the reply is read
 * once: guidance that costs prompt bytes every turn to save one completion once
 * is a bad trade.
 */
const UNRECOGNISED_CHECK_NEXT_STEP =
  "Not a recognised check: write the assertion as a test file a runner collects " +
  "(`bun test path/to/x.test.ts`), or cite a project check command — a `package.json` script, " +
  "`bunx tsc --noEmit`, `cargo test`. Re-citing this command in other words will get the same answer.";

// The brief and its criteria cross the wire: the read-back is a round-trip a
// desktop or web client holds exactly as the terminal does, so @rune/protocol
// owns the shapes and they are re-exported here.
export type { Criterion, Brief, ClaimRung, Evidence, BriefDecision } from "@rune/protocol";
import type { Brief, ClaimRung, Criterion, Evidence } from "@rune/protocol";
import type { StampedRevision } from "./lifecycle";

/** Why a criterion refused to move. Returned rather than thrown — a rejected
 *  claim is information for the surface, not an exception. */
export type LedgerRejection = { ok: true; criterion: Criterion } | { ok: false; reason: string };

/**
 * The only thing that can move a criterion. Holding this separate from the
 * brief itself is what makes "done" un-assertable: the read-back tool builds
 * the Brief and has no access to rungs, and every path that could set one runs
 * through `record`, which checks the evidence before it agrees.
 */
export class BriefLedger {
  /**
   * `revision` is how a rung learns which tree it is a claim about. The engine
   * supplies it; a ledger built without one still works and simply records
   * evidence with no revision, which `demoteStaleCriteria` treats as old
   * rather than stale. It is called at RECORD time, with the files the brief
   * is scoped to, and answers for that moment — not for the moment the run
   * started.
   */
  constructor(
    private readonly brief: Brief,
    private readonly revision?: (files?: readonly string[]) => {
      head: string | null;
      dirty: boolean;
      digest?: string;
    },
  ) {}

  get criteria(): readonly Criterion[] {
    return this.brief.criteria;
  }

  /** The brief itself, for persistence. The ledger mutates it in place. */
  get snapshot(): Brief {
    return this.brief;
  }

  get met(): number {
    return this.brief.criteria.filter((c) => c.rung === "verified").length;
  }

  get total(): number {
    return this.brief.criteria.length;
  }

  /** Every criterion carries a recorded parent failure followed by a pass. */
  get complete(): boolean {
    return this.total > 0 && this.met === this.total;
  }

  /**
   * Move a criterion, if the evidence supports it. Refuses to:
   *  · move an unknown criterion,
   *  · mark `verified` without a recorded parent-commit failure,
   *  · accept evidence with no source (that is prose wearing a struct),
   *  · walk a claim BACKWARDS silently — a downgrade is allowed but must be
   *    explicit, because a criterion that quietly weakens is worse than one
   *    that never moved.
   */
  record(
    index: number,
    rung: ClaimRung,
    evidence: Evidence,
    allowDowngrade = false,
  ): LedgerRejection {
    const criterion = this.brief.criteria[index];
    if (!criterion) return { ok: false, reason: `no criterion at index ${index}` };
    if (!evidence || !evidence.source || !evidence.source.trim()) {
      return { ok: false, reason: "evidence needs a source — what ran, verbatim" };
    }
    if (rung === "verified" && !evidence.parentCommitFailed) {
      return {
        ok: false,
        reason:
          "`verified` requires the same check to have FAILED on the parent commit. " +
          "A green test proves it is green, not that this change is why. " +
          "Run it on the parent, then record again — or record `reproduced`.",
      };
    }
    const before = criterion.rung ? CLAIM_RUNGS.indexOf(criterion.rung) : -1;
    const after = CLAIM_RUNGS.indexOf(rung);
    if (after < before && !allowDowngrade) {
      return {
        ok: false,
        reason: `criterion is already ${criterion.rung}; downgrading to ${rung} must be explicit`,
      };
    }
    criterion.rung = rung;
    // Scoped to the files the brief says the work is in: on a dirty tree HEAD
    // cannot date a claim, and their content digest is the only thing that
    // can say the tree moved under it.
    //
    // Evidence that ARRIVES stamped keeps its own stamp (V6 finding 4): it was
    // dated when the check ran, and re-dating it here would date the
    // measurement by when the model got round to citing it.
    const at = alreadyStamped(evidence) ? undefined : this.revision?.(this.brief.touch);
    criterion.evidence = at
      ? {
          ...evidence,
          ...(at.head ? { head: at.head } : {}),
          dirty: at.dirty,
          ...(at.digest ? { digest: at.digest } : {}),
        }
      : evidence;
    return { ok: true, criterion };
  }

  /**
   * A citation the runtime priced and then SET ASIDE: the command ran, it is
   * worth something, and it does not speak to this criterion.
   *
   * The rung does not move — that is the whole decision — but the attempt is
   * kept on the criterion, because a contract whose gap reads "no evidence
   * recorded" when the model cited three commands for it describes the run
   * less honestly than one that says which command was refused and why. Never
   * overwrites a criterion that already earned a rung: a later unrelated
   * citation cannot cost an earned claim its receipt.
   */
  setAside(index: number, evidence: Evidence, reason: string): LedgerRejection {
    const criterion = this.brief.criteria[index];
    if (!criterion) return { ok: false, reason: `no criterion at index ${index}` };
    if (criterion.rung) {
      return { ok: false, reason: `criterion is already ${criterion.rung}; nothing moved` };
    }
    criterion.evidence = { ...evidence, unrelated: reason };
    return { ok: true, criterion };
  }

  /**
   * The runtime's OWN measurement of a criterion, pass or fail.
   *
   * `record` is the citation path: the model points, the runtime prices, and a
   * failure is refused because there is nothing to record — a criterion is not
   * settled by a check that is failing. This is the other direction. The
   * runtime ran the criterion's own command itself, so what it saw is the
   * answer either way, and a `failed` result is a status WITH a receipt rather
   * than the absence of one.
   *
   * No parent-commit rule applies because `verified` is not reachable here:
   * this path never awards it. The rung stays the receipt's strength
   * (`observed` — it ran and passed) and the acceptance is derived from the
   * evidence by `criterionStatus`.
   */
  recordRuntimeCheck(index: number, evidence: Evidence, rung: ClaimRung | null): LedgerRejection {
    const criterion = this.brief.criteria[index];
    if (!criterion) return { ok: false, reason: `no criterion at index ${index}` };
    if (!evidence?.source?.trim()) {
      return { ok: false, reason: "evidence needs a source — what ran, verbatim" };
    }
    if (rung === "verified") {
      return {
        ok: false,
        reason: "`verified` is a parent-commit finding; this path cannot award it",
      };
    }
    if (rung) criterion.rung = rung;
    const at = alreadyStamped(evidence) ? undefined : this.revision?.(this.brief.touch);
    criterion.evidence = at
      ? {
          ...evidence,
          ...(at.head ? { head: at.head } : {}),
          dirty: at.dirty,
          ...(at.digest ? { digest: at.digest } : {}),
        }
      : evidence;
    return { ok: true, criterion };
  }

  /** The close: the same criteria, in the same order, with what moved them. */
  close(): {
    met: number;
    total: number;
    rows: Array<{ text: string; rung: ClaimRung | null; receipt: string }>;
  } {
    return {
      met: this.met,
      total: this.total,
      rows: this.brief.criteria.map((c) => ({
        text: c.text,
        rung: c.rung,
        receipt: c.evidence
          ? [c.evidence.source, c.evidence.detail].filter(Boolean).join(" — ")
          : "no evidence yet",
      })),
    };
  }
}

/** Build a Brief from the tool's raw arguments. Criteria arrive unmet, always. */
export function briefFromArgs(args: Record<string, unknown>, request: string, now: string): Brief {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  return {
    reading: String(args.reading ?? "").trim(),
    touch: strings(args.touch),
    leave: strings(args.leave),
    criteria: strings(args.done_when).map((text) => ({ text, rung: null })),
    request,
    createdAt: now,
  };
}

export const READ_BACK_SCHEMA: ToolSchema = {
  name: "read_back",
  version: "1.0.0",
  description:
    "BEFORE starting any non-trivial task, state what you understood — so the person can correct " +
    "you in one keystroke instead of after the work. Restate the SYMPTOM they described, not the " +
    "command they typed. `leave` is the most important field: naming what you are deliberately " +
    "NOT touching is what proves you understood the boundary, and it is where a misread shows up " +
    "first. `done_when` are the criteria you will be held to — write them so an event could " +
    "settle each one, never as a feeling. You cannot mark them met; only evidence can. Skip this " +
    "for a one-line question or a trivial lookup; use it for anything that will change a file.",
  inputSchema: {
    type: "object",
    properties: {
      reading: {
        type: "string",
        description:
          "Your reading of what they actually want, in their frame. Name the symptom they " +
          "described. 1-3 sentences, addressed to them as 'you'.",
      },
      touch: {
        type: "array",
        description: "Files or areas you expect to change.",
        items: { type: "string" },
      },
      leave: {
        type: "array",
        description:
          "What you will deliberately NOT touch, and why — especially anything they told you to " +
          "leave alone, and anything adjacent you could plausibly have swept in.",
        items: { type: "string" },
      },
      done_when: {
        type: "array",
        description:
          "How you will know you are finished. Each must be settleable by an observable event " +
          "(a test, an exit code, a file's absence from the diff), never by judgement.",
        items: { type: "string" },
        minItems: 1,
        maxItems: 6,
      },
      kind: {
        type: "string",
        description: "What shape of work this is, if the harness read it wrong. Set once per task.",
        enum: ["investigate", "build", "analyze", "research", "operate", "write"],
      },
    },
    required: ["reading", "done_when"],
  },
  permissionLevel: "auto",
  // "execute": it commits a block and may block on the person's confirmation,
  // so it must never fire while other tools stream output over it.
  category: "execute",
};

/** Resolves once the person accepts, edits, or questions the read-back. */
export type BriefHandler = (
  brief: Brief,
) => Promise<{ accepted: boolean; edited?: Brief; note?: string }>;

export function createReadBackTool(
  getHandler: () => BriefHandler | undefined,
  getRequest: () => string,
  onBrief: (brief: Brief) => void,
  /**
   * The model's ONE revision of the task kind (P11.1).
   *
   * It rides on the read-back because that is where the model already says
   * what it understood the work to be, and a third tool for one enum would
   * cost a schema on every request for a field used once per task. The value
   * never enters the Brief: the kind belongs to the task spine, and the brief
   * is a contract with the person. The store enforces "once".
   */
  onKind?: (kind: TaskKind) => void,
): ToolHandler {
  return {
    schema: READ_BACK_SCHEMA,

    validate: (args) => {
      const reading = String(args.reading ?? "").trim();
      if (!reading)
        return { valid: false, error: "read_back needs `reading` — what did you understand?" };
      const done = Array.isArray(args.done_when) ? args.done_when.filter(Boolean) : [];
      if (done.length === 0) {
        return {
          valid: false,
          error:
            "read_back needs at least one `done_when` criterion, written so an observable event " +
            "could settle it.",
        };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (result: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result,
        durationMs: Math.round(performance.now() - start),
      });

      const args = (input.args ?? {}) as Record<string, unknown>;
      const brief = briefFromArgs(args, getRequest(), new Date().toISOString());
      const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
      if (onKind && (TASK_KINDS as readonly string[]).includes(kind)) {
        onKind(kind as TaskKind);
      }
      const handler = getHandler();

      if (!handler) {
        // Headless: nothing can confirm it, so the brief still stands as the
        // contract and work proceeds against it. Stalling would be worse, and
        // silently skipping the read-back would defeat the point of having one.
        onBrief(brief);
        return done(
          "Read-back recorded (no interactive surface to confirm it). Work to it, and say so " +
            "plainly the moment what you find contradicts it.",
        );
      }

      const reply = await handler(brief);
      // A brief the person EDITED is the person's statement of what done
      // means, not the model's reading of it — so its criteria are `user`,
      // and the next read-back cannot drop or optionalise one. Every
      // criterion in the edited brief counts, including the ones they left
      // alone: leaving a criterion standing in a brief you are editing is
      // stating it.
      const settled = reply.edited
        ? {
            ...reply.edited,
            // `??=`, not an overwrite: an `evaluator` criterion that happens
            // to be on the brief the person edited is still the runtime's, and
            // relabelling it `user` would hand the model a way to cite it.
            criteria: reply.edited.criteria.map((c) => ({ ...c, source: c.source ?? "user" })),
          }
        : brief;
      onBrief(settled);
      if (reply.accepted) {
        return done("Accepted. Work to this brief and report against these criteria.");
      }
      return done(
        "Not accepted as written." +
          (reply.note ? ` They said: ${reply.note}` : "") +
          " Read back again with the correction folded in before doing any work.",
      );
    },
  };
}

// ─── The check log, and where a rung actually comes from ───
//
// The first draft of this file let the model name a rung and made the ledger
// argue with it. That was the wrong shape: an argument the model can restate
// more confidently is an argument it eventually wins. So the model does not
// name rungs at all any more. It points at a criterion and cites a command it
// ran, and the RUNTIME decides what that citation is worth — from its own
// record of what actually happened when that command ran.
//
// The mapping falls out of the log with no judgement involved:
//
//   ran once, passed              -> observed    (it appeared in output)
//   ran twice or more, all passed -> reproduced  (made to happen on purpose)
//   failed before, passes now     -> verified    (the parent-commit rule, met)
//   last run failed               -> refused     (nothing to record)
//   never ran                     -> refused     (a citation to nothing)
//
// The `verified` line is the one that matters. It is exactly the parent-commit
// rule expressed as something the runtime can check by itself: the same command
// is on record as having failed and then passed. A model cannot fabricate
// either half, because it never touched the verdict — the exit code did.

/**
 * The tool whose results feed the check log — the shell, by its REGISTERED
 * schema name. The engine's listener matches on this.
 *
 * It lives here, next to CheckLog, because the coupling it names is the one
 * that already broke once: the listener was written against `run_command`, the
 * tool was renamed to `bash`, and the log went silently empty — taking the
 * entire evidence ledger with it while every unit test stayed green, because
 * they all built the log by hand. `check-log-wiring.test.ts` asserts this
 * constant against the live registry, so the next rename fails loudly.
 */
export const CHECK_SOURCE_TOOL = "bash";

export interface CheckRun {
  command: string;
  passed: boolean;
  at: number;
  summary?: string;
  /** Other shell actions are recorded too, but never replayed or promoted
   * as checks. Omitted by legacy embedders/harness verifiers means check. */
  kind?: "check" | "execution";
  /**
   * The exit code the runtime read, and how long the command took. Present for
   * checks the HARNESS ran (the verifier reads both directly); absent for
   * checks from embedders without a structured shell result. Native `bash`
   * carries the child exit code inside its result JSON. "No data" is null, never zero.
   */
  exitCode?: number;
  durationMs?: number;
  /**
   * This RUN's stable identity (`chk-<n>`), assigned by `CheckLog.record`.
   *
   * A command string is not an execution. The same command runs many times in
   * a session, so evidence that names only the command is a claim about a
   * string: a criterion settled by a green run still read as settled after a
   * later run of the same command went red. Never set by a caller — `record`
   * overwrites whatever arrives, so there is no path from a model-authored
   * value to an execution id.
   */
  executionId?: string;
  /**
   * The program this check runs, when the RUN itself wrote it (V6 finding 3).
   *
   * `kind` comes from `isVerificationCommand`, which classifies by NAME: any
   * script whose basename matches /(test|spec|check|verify|…)/ is a "check".
   * So a model that writes `verify-header.sh` containing `echo '1 pass, 0
   * fail'; exit 0`, runs it and cites it got `kind: "check"`, evidence
   * `check-log@1`, `satisfied`, and the run reported `met` with nothing
   * changed. A check whose program the run authored could not have FAILED for
   * any criterion, which is the one thing a criterion is settled by.
   *
   * Set only by `CheckLog.record`, from the runtime's own write ledger, and it
   * names the file so the receipt can say which one.
   */
  authoredBy?: string;
  /**
   * The workspace revision AT THE MOMENT THIS RAN (V6 finding 4).
   *
   * `BriefLedger.record` used to stamp the evidence at CITATION time, so every
   * edit between the green run and the citation was invisible: a model could
   * fix a file, run the check green, revert the fix, and then cite — the stamp
   * was taken against the reverted tree, the verdict read the same reverted
   * tree, nothing "moved", and the criterion derived `satisfied` at rung
   * `verified` for a change that was no longer there.
   *
   * Taken un-memoised, here, for checks only. The memo behind `runRevision`
   * exists so stamping every tool call does not spawn two git processes; a
   * memo is exactly wrong for evidence, because it dates a measurement by
   * when the last measurement was taken (M5's `REVISION_MEMO_MS` false
   * negative: a check that took three seconds made the verdict depend on how
   * long the checks took).
   */
  revision?: StampedRevision;
}

/**
 * The toolchain a claim was taken on, in one short string.
 *
 * What the review means by "relevant environment/config fingerprint", and
 * deliberately no more than that: a runtime, its version and the platform.
 * Enough to tell a claim taken under Bun 1.1 on darwin from the same claim
 * taken under node 20 in CI; not a dependency graph, which is a different
 * project and would cost a subprocess per record.
 */
export function envFingerprint(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const runtime = bun ? `bun ${bun}` : `node ${process.versions?.node ?? "?"}`;
  return `${runtime} ${process.platform}/${process.arch}`;
}

/**
 * What running one command against the pre-change tree established. `failed`
 * is the only status that can lift a criterion to `verified`; `passed` is the
 * finding that the change is NOT why the check is green, `inconclusive` means
 * the parent tree could not answer (usually: nothing installed there), and
 * `not-applicable-on-parent` means the check did not RUN there at all — a
 * runner that collected nothing, or a command naming a file the parent commit
 * never had. A failure by absence is the one shape of "it failed on the
 * parent" that says nothing about this change, so it buys no rung.
 */
export interface ParentRun {
  command: string;
  status: "failed" | "passed" | "inconclusive" | "not-applicable-on-parent";
  commit?: string;
  reason?: string;
}

/** Every check the runtime ran this session, with the verdict IT read. */
export class CheckLog {
  private readonly runs: CheckRun[] = [];
  private readonly parents: ParentRun[] = [];
  private seq = 0;

  /**
   * `authoredThisRun` answers, from the runtime's write ledger, whether this
   * run wrote one of the program paths handed to it — and which. Absent (an
   * embedder, a unit call site) means nothing is known to be self-authored,
   * which is the reading that keeps an honest citation.
   */
  constructor(
    private readonly runtime?: {
      authoredThisRun?: (paths: readonly string[]) => string | undefined;
      /** The workspace revision RIGHT NOW, un-memoised, scoped to the brief. */
      revisionNow?: () => StampedRevision;
    },
  ) {}

  /**
   * Record one execution, and give it an id.
   *
   * The id is assigned HERE and overwrites anything the caller supplied: the
   * whole value of an execution id is that it names a run the runtime itself
   * saw, and a caller-settable one would be a model-reachable field wearing a
   * measurement's name.
   */
  record(run: CheckRun): CheckRun {
    // Asked HERE, at execution time, because that is when the write ledger
    // says what this run has written so far. Only for checks: an execution
    // receipt can never reach `satisfied` anyway.
    const authoredBy =
      (run.kind ?? "check") === "check"
        ? this.runtime?.authoredThisRun?.(commandProgramPaths(run.command))
        : undefined;
    const revision =
      (run.kind ?? "check") === "check"
        ? (run.revision ?? this.runtime?.revisionNow?.())
        : undefined;
    const recorded: CheckRun = {
      ...run,
      executionId: `chk-${++this.seq}`,
      ...(authoredBy ? { authoredBy } : {}),
      ...(revision ? { revision } : {}),
    };
    this.runs.push(recorded);
    return recorded;
  }

  /** The run one execution id names, if the log still holds it. */
  execution(executionId: string): CheckRun | undefined {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (this.runs[i]!.executionId === executionId) return this.runs[i];
    }
    return undefined;
  }

  /**
   * Record what the pre-change tree did with this command. Written only by the
   * runtime's own parent-commit probe (parent-check.ts) — there is deliberately
   * no path from a model-authored value to here, for the same reason the model
   * cannot name a rung.
   */
  recordParent(run: ParentRun): void {
    this.parents.push(run);
  }

  /** The most recent parent-commit result for a command, if one was taken. */
  parent(command: string): ParentRun | undefined {
    const key = normalizeCommand(command);
    for (let i = this.parents.length - 1; i >= 0; i--) {
      const run = this.parents[i]!;
      if (normalizeCommand(run.command) === key) return run;
    }
    return undefined;
  }

  /** Runs of one command, oldest first. Normalised on whitespace only — a
   *  command is identified by what was executed, not by how it was spaced. */
  history(command: string): CheckRun[] {
    const key = normalizeCommand(command);
    return this.runs.filter((r) => normalizeCommand(r.command) === key);
  }

  get all(): readonly CheckRun[] {
    return this.runs;
  }

  get allParents(): readonly ParentRun[] {
    return this.parents;
  }
}

/** One `CheckRun`'s revision, as the fields evidence carries it in. */
export function stampOf(revision: StampedRevision | undefined): Partial<Evidence> {
  if (!revision) return {};
  return {
    ...(revision.head ? { head: revision.head } : {}),
    dirty: revision.dirty,
    ...(revision.digest ? { digest: revision.digest } : {}),
  };
}

/** Whether a piece of evidence already says which tree it was taken against. */
function alreadyStamped(evidence: Evidence): boolean {
  const e = evidence as Evidence & { head?: string; dirty?: boolean; digest?: string };
  return e.head != null || e.digest != null || e.dirty != null;
}

export type RungVerdict =
  { ok: true; rung: ClaimRung; evidence: Evidence } | { ok: false; reason: string };

/**
 * What a cited command is worth. Pure, and derived only from the runtime's own
 * record — nothing the model wrote reaches this function.
 */
export function rungForCommand(log: CheckLog, command: string): RungVerdict {
  const runs = log.history(command);
  if (runs.length === 0) {
    return {
      ok: false,
      reason:
        `nothing on record for \`${normalizeCommand(command)}\`. Run it first — a citation to a ` +
        `command that never ran is not evidence.`,
    };
  }
  const last = runs[runs.length - 1]!;
  if (!last.passed) {
    return {
      ok: false,
      reason:
        `\`${normalizeCommand(command)}\` last FAILED${last.summary ? ` (${last.summary})` : ""}. ` +
        `A criterion cannot be settled by a check that is failing.`,
    };
  }
  // Every receipt this function writes names the EXECUTION it was priced from,
  // says who assessed it and at what version, records what the verifier saw,
  // and stamps the toolchain. Before M1 the evidence carried a command string
  // and a summary, so "which run of `bun test` was this" and "did anyone
  // record a failure" were both unanswerable from the record itself.
  const base: Evidence = {
    // The stamp comes off the RUN, so the claim is dated to the tree the check
    // actually saw. `BriefLedger.record` leaves an evidence that arrives
    // stamped alone.
    ...stampOf(last.revision),
    source: normalizeCommand(command),
    detail: last.summary,
    ...(last.executionId ? { executionId: last.executionId } : {}),
    verifier: "check-log@1",
    result: "passed",
    env: envFingerprint(),
  };
  // ── A check this run wrote is not a check ──
  //
  // V6 finding 3. `verify-header.sh` printing `1 pass, 0 fail` classifies as a
  // check by its NAME, and the execution-receipt clause never fired for it. A
  // program the run authored could not have failed for the criterion it is
  // cited against — the run decided what it printed — so it is priced exactly
  // as an execution receipt is: `observed`, never replayed on the parent, and
  // `criterionStatus` reads the verifier name and answers `needs_review`.
  if (last.authoredBy) {
    return {
      ok: true,
      rung: "observed",
      evidence: {
        ...base,
        verifier: "self-authored-check@1",
        detail: joinDetail(
          last.summary,
          `this run wrote \`${last.authoredBy}\` — a check the run authored cannot settle a ` +
            `criterion; cite a check that existed before this run, or a project-wide one`,
        ),
      },
    };
  }
  if (last.kind === "execution") {
    return {
      ok: true,
      rung: "observed",
      evidence: {
        ...base,
        // WHO assessed this, and it is not the check log: a shell command that
        // exited 0 is a receipt that something RAN, not a verdict that
        // anything held. `result: "passed"` stays — the exit code is a fact
        // and the record keeps it — but the verifier name is what
        // `criterionStatus` reads to refuse `satisfied`, and it survives on a
        // saved row read back with no check log behind it.
        verifier: "execution-receipt@1",
        // A1 (Lane A's spec, `.codex/audit-20260910/handoff/phase3/a1-spec.md`):
        // say what HAPPENED, not only what it was not. The verdict above is
        // unchanged — `observed`, no parent replay — because a command that ran
        // and exited 0 is real evidence of something; what Pilot J lost three
        // completions to was a receipt that read like a refusal and named no
        // way forward. The exit code comes off the record and is never invented:
        // an embedder without a structured shell result has none (`CheckRun.exitCode`
        // above: "No data is null, never zero"), and a passing run can only ever
        // carry 0. The NEXT STEP is not in this string on purpose — `detail`
        // rides the plan ledger on every turn (`:193`), so guidance belongs in
        // the tool reply, which is read once.
        detail: joinDetail(
          last.summary,
          last.exitCode != null
            ? `execution receipt only — ran, exit ${last.exitCode}, not a recognised check; not replayed on the parent`
            : "execution receipt only — ran and passed, not a recognised check; not replayed on the parent",
        ),
      },
    };
  }

  // `verified` comes from ONE place: the runtime having run this same command
  // against the pre-change tree and read a failure there.
  //
  // It used to be inferred from in-session red→green — the command failed at
  // some earlier point this session and passes now. That is a different claim,
  // and the difference is the most ordinary shape of agent work there is: the
  // agent edits, breaks the test, fixes its own break, and the test goes
  // red→green while the parent commit was green the entire time. The receipt
  // then asserted "a test that failed on the parent commit passes now" about a
  // commit nothing had checked out. `parentCommit` was never populated by any
  // code path outside the test files, which is what that gap looks like from
  // the outside.
  const parent = log.parent(command);
  if (parent?.status === "failed") {
    return {
      ok: true,
      rung: "verified",
      evidence: {
        ...base,
        // The measurement that produced THIS rung is the parent probe, not the
        // log read: `check-log@1` says the command passes now, and only
        // `parent-probe@1` says the change is why. The pass is still on the
        // record as `result: "passed"`.
        verifier: "parent-probe@1",
        parentCommitFailed: true,
        ...(parent.commit ? { parentCommit: parent.commit } : {}),
        detail: joinDetail(
          last.summary,
          `failed on ${parent.commit?.slice(0, 8) ?? "the parent commit"}, passes now`,
        ),
      },
    };
  }

  // A green parent is a real finding, not a shortfall: the change is not why
  // this check passes. Say so in the receipt rather than quietly settling for
  // a weaker rung with no explanation.
  const note =
    parent?.status === "passed"
      ? `also passed on ${parent.commit?.slice(0, 8) ?? "the parent commit"} — this change is not why it passes`
      : parent?.status === "inconclusive"
        ? `parent-commit check inconclusive: ${parent.reason ?? "unknown"}`
        : parent?.status === "not-applicable-on-parent"
          ? // The attack this closes: a brand-new test file "fails" on the
            // parent commit by not existing there. Saying so in the receipt
            // is the point — the rung is weaker AND the reader is told the
            // measurement was never taken.
            `not applicable on the parent commit: ${parent.reason ?? "the check did not run there"} — a failure by absence is not evidence`
          : undefined;

  // Failed attempts are not successful reproductions. A new failure also
  // breaks the streak; two earlier passes cannot certify today's recovery.
  let passingStreak = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i]!.passed; i--) passingStreak++;
  if (passingStreak >= 2) {
    return {
      ok: true,
      rung: "reproduced",
      evidence: {
        ...base,
        detail: joinDetail(joinDetail(last.summary, `passed ${passingStreak} times`), note ?? ""),
      },
    };
  }
  return {
    ok: true,
    rung: "observed",
    evidence: { ...base, detail: joinDetail(last.summary, note ?? "") },
  };
}

function joinDetail(a: string | undefined, b: string | undefined): string | undefined {
  if (!b) return a;
  return a ? `${a} — ${b}` : b;
}

/**
 * The files from the brief's own scope that THIS criterion is about.
 *
 * The brief's `touch`/`leave` lists belong to the task; a criterion is about
 * some part of it, and usually says which in ordinary words — `the CSV header
 * is unchanged` is about `header.csv`, `the exporter writes every row` is
 * about nothing the list can identify. Only a file the criterion actually
 * names can contradict a citation, so this returns the named ones and, when
 * it returns nothing, relatedness falls back to the behaviour a criterion with
 * no scope always had.
 *
 * `leave` counts as much as `touch`: "this file is unchanged" is the shape of
 * criterion the model is most tempted to settle with a check that never opens
 * it, and it is the one that names a `leave` file by construction.
 *
 * Matching is deliberately literal — the path, its basename, or its basename's
 * stem as a whole word — because a fuzzy match here costs a real citation its
 * rung, and the fallback for no match is to keep the citation.
 */
export function criterionScope(
  text: string,
  brief: { touch: readonly string[]; leave: readonly string[] },
): string[] {
  const hay = ` ${text.toLowerCase()} `;
  const named: string[] = [];
  for (const file of [...brief.touch, ...brief.leave]) {
    const norm = String(file).replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!norm || named.includes(file)) continue;
    const base = norm.split("/").pop() ?? norm;
    const stem = base
      .replace(/\.[^.]+$/, "")
      .replace(/[._-](?:test|spec)$/i, "")
      .toLowerCase();
    const hit =
      hay.includes(` ${norm.toLowerCase()} `) ||
      hay.includes(`\`${norm.toLowerCase()}\``) ||
      hay.includes(` ${base.toLowerCase()} `) ||
      (stem.length >= 3 && new RegExp(`\\b${escapeForWordMatch(stem)}\\b`).test(hay));
    if (hit) named.push(file);
  }
  return named;
}

function escapeForWordMatch(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const RECORD_EVIDENCE_SCHEMA: ToolSchema = {
  name: "record_evidence",
  version: "1.0.0",
  description:
    "Cite a command you already ran as evidence for one of your read_back criteria. You choose " +
    "WHICH criterion the command speaks to; you do not get to say what it proves — the runtime " +
    "reads its own record of that command and decides. A command that never ran, or that is " +
    "currently failing, is refused. For a passing command the runtime re-runs it ITSELF against " +
    "the pre-change tree in a throwaway checkout: only a command that FAILS there and passes now " +
    "earns 'verified'. If it passes there too, your change is not why it is green, and the " +
    "receipt will say so. Anything else is weaker, and that is the honest answer. Call this as " +
    "you go, not at the end — and in the SAME response as the check when you can: put the bash " +
    "call first and record_evidence after it. The calls run in order, and the runtime reads the " +
    "check's real exit code before it records, so the citation costs no extra turn.",
  inputSchema: {
    type: "object",
    properties: {
      criterion: {
        type: "number",
        description:
          "0-based index of the done_when criterion this speaks to. With no read_back in play, " +
          "the 0-based index of the plan step it settles.",
      },
      claim: {
        type: "string",
        description:
          "Instead of an index: the claim this command settles, in your own words. Use it when " +
          "no read_back is in play and the command does not belong to a numbered step.",
      },
      command: {
        type: "string",
        description: "The command you ran, verbatim, exactly as you ran it.",
      },
    },
    required: ["command"],
  },
  permissionLevel: "auto",
  category: "read",
};

/** What a citation points at: a numbered criterion or step, or a claim in words. */
function citationTarget(args: Record<string, unknown>): { index?: number; claim?: string } {
  const raw = args.criterion;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { index: raw };
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return { index: Number(raw.trim()) };
  const claim = String(args.claim ?? (typeof raw === "string" ? raw : "")).trim();
  return claim ? { claim: claim.slice(0, 200) } : {};
}

export function createRecordEvidenceTool(
  getLedger: () => BriefLedger | undefined,
  getLog: () => CheckLog,
  /**
   * Run the cited command against the pre-change tree. Supplied by the Engine
   * (parent-check.ts); omitted by embedders with no git repo, in which case
   * `verified` is simply unreachable — which is the correct outcome, not a
   * degraded one. A rung nobody can substantiate should not be awarded.
   */
  probeParent?: (command: string) => ParentRun | undefined,
  /**
   * The plan, for a citation made with no brief in play: a numbered target is
   * then a plan step. The citation is acknowledged in one line either way —
   * a validation error here was never the model's fault, and it landed on
   * the user's screen seven times in one turn.
   */
  getSpine?: () =>
    { todos: Array<{ content: string }>; touchedFiles?: readonly string[] } | undefined,
): ToolHandler {
  return {
    schema: RECORD_EVIDENCE_SCHEMA,

    validate: (args) => {
      if (!String(args.command ?? "").trim()) {
        return { valid: false, error: "command must be the command you ran, verbatim" };
      }
      const target = citationTarget(args);
      if (target.index == null && !target.claim) {
        return {
          valid: false,
          error:
            "say what the command speaks to: `criterion` (a 0-based index) or `claim` (in your own words)",
        };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const reply = (result: string, success = true): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success,
        result,
        durationMs: Math.round(performance.now() - start),
      });

      const ledger = getLedger();
      const target = citationTarget(input.args ?? {});
      const command = String((input.args ?? {}).command ?? "");
      const log = getLog();
      // A1: a pure read off the log already in hand — no verdict shape changes.
      const unrecognisedCheck = log.history(command).at(-1)?.kind === "execution";
      const nextStep = unrecognisedCheck ? ` ${UNRECOGNISED_CHECK_NEXT_STEP}` : "";
      if (!ledger) {
        // No brief: the citation still gets the runtime's verdict on the
        // command, attributed to the plan step or the claim it names, and
        // the reply says plainly that no criterion moved.
        const verdict = rungForCommand(log, command);
        if (!verdict.ok) return reply(verdict.reason);
        const spine = getSpine?.();
        const step = target.index != null ? spine?.todos[target.index] : undefined;
        const about =
          step != null
            ? `step ${target.index! + 1} "${step.content.slice(0, 80)}"`
            : target.claim
              ? `"${target.claim}"`
              : target.index != null
                ? `step ${target.index + 1}`
                : "the claim";
        // The citation names a STEP, so the same relatedness test the loop
        // applies to a model-run check applies here: a command that speaks to
        // files this step never touched is still on record as executed, and
        // still gets its rung, but it is not this step's evidence. A step
        // with no touched files has nothing to judge against and keeps the
        // reply it always had.
        const relation =
          step != null
            ? checkRelatedness(command, { content: step.content, touched: spine?.touchedFiles })
            : null;
        return reply(
          `Noted for ${about}: ${verdict.rung} — ${RUNG_MEANING[verdict.rung]} ` +
            (verdict.evidence.detail ? `Receipt: ${verdict.evidence.detail}. ` : "") +
            (relation && !relation.related
              ? "It is on record as executed, but it does not speak to that step: " +
                (relation.reason === "names_nothing"
                  ? "it names no file this step wrote, and it is not a project-wide check. "
                  : "it names only files this step never touched. ") +
                "Cite the step's own check, or run one. "
              : "") +
            "No read_back criteria are in play, so this settles no criterion." +
            nextStep,
        );
      }
      // A claim in words against a numbered brief: match it to a criterion
      // by text, else say which numbers exist. One line either way.
      let index = target.index;
      if (index == null && target.claim) {
        const needle = target.claim.toLowerCase();
        const found = ledger.criteria.findIndex(
          (c) => c.text.toLowerCase().includes(needle) || needle.includes(c.text.toLowerCase()),
        );
        if (found < 0) {
          return reply(
            `No criterion reads like "${target.claim.slice(0, 60)}". The brief's criteria are ` +
              `numbered 0-${Math.max(0, ledger.total - 1)}; cite one by index.`,
          );
        }
        index = found;
      }
      if (index == null) return reply("Cite a criterion by its 0-based index.");

      const runs = log.history(command);
      const lastRun = runs[runs.length - 1];

      // ── Does this command speak to THIS criterion? ──
      //
      // The runtime decides what a command is WORTH; until now the model
      // decided what it was ABOUT, and the second half is the whole claim. One
      // green check cited twice — once per criterion — bought `verified` for a
      // criterion about a file the check never opened, and the run ended
      // `met` with that file byte-identical (V-5B, F1). The rung value was
      // never model-authored; the ATTRIBUTION was, and an attribution nobody
      // tests is an assertion wearing a measurement's clothes.
      //
      // So the same relatedness test the loop already applies to a model-run
      // check, and this tool already applies on its no-brief branch, applies
      // here — with the scope narrowed from the brief's whole file list to the
      // files THIS criterion names (`criterionScope`). That narrowing is the
      // difference between a gate and a wall: the brief's `touch` list belongs
      // to the whole task, so judging every citation against it sets aside the
      // honest citation too, and a run where nothing can be recorded reports
      // `unmet` on work that was done. A criterion that names no artifact of
      // its own has nothing to contradict and keeps the behaviour it had; a
      // criterion that names one — `the CSV header is unchanged`, against a
      // brief holding `header.csv` — is settled only by a check that reads it.
      //
      // A project-wide check is related to everything by nature, a criterion
      // that names its own check keeps it, and a check that names no file at
      // all buys nothing. Set aside means recorded, refused, and explained,
      // not silently dropped.
      //
      // Executions are not gated here: `rungForCommand` caps them at
      // `observed` and never replays them on the parent, so they cannot reach
      // the rungs that make a claim, and A1's receipt wording (P3B, measured
      // against a pilot that spent three completions rewording one citation)
      // is the more valuable thing to keep intact.
      const criterion = ledger.criteria[index];

      // ── An evaluator criterion is not the model's to settle ──
      //
      // It is the independent oracle: a check the runtime runs ITSELF at the
      // finish gate, against a command the model never saw. A citation is the
      // model choosing what a command is about, and letting it choose that for
      // the acceptance test would put the one measurement it cannot influence
      // back inside its reach. The refusal is a plain sentence, not an error:
      // there is nothing wrong with having tried.
      //
      // The refusal deliberately does NOT quote the criterion back. An
      // evaluator criterion is one the model never sees, and a tool reply that
      // echoes its text on an out-of-range index would be a way to read it.
      if (criterion?.source === "evaluator") {
        return reply(
          `Criterion ${index} is settled by the runtime's own run, not by citation. It will be ` +
            `checked when this turn finishes and the result will be on the record either way. ` +
            `Cite a criterion you read back instead.`,
        );
      }

      const named = criterion ? criterionScope(criterion.text, ledger.snapshot) : [];
      // A self-authored check is not set aside: it is RECORDED, with a receipt
      // that says the run wrote it, so the criterion reads `needs_review`
      // ("we have no measurement") rather than `unassessed` ("nobody tried").
      const relation =
        criterion && lastRun?.kind !== "execution" && !lastRun?.authoredBy
          ? checkRelatedness(command, { content: criterion.text, touched: named })
          : null;
      if (relation && !relation.related) {
        const priced = rungForCommand(log, command);
        if (!priced.ok) return reply(priced.reason);
        const why =
          relation.reason === "names_nothing"
            ? "it names no file at all, and it is not a project-wide check"
            : `it never reads ${named.slice(0, 3).join(", ")}, which is what this criterion is about`;
        const kept = ledger.setAside(index, priced.evidence, why);
        return reply(
          `\`${normalizeCommand(command)}\` is on record as passing, but it does not speak to ` +
            `criterion ${index} "${criterion!.text.slice(0, 80)}": ${why}. ` +
            (kept.ok
              ? "Nothing moved, and the citation is on the contract as set aside. "
              : `${kept.reason}. `) +
            "A criterion is settled by a check that could have FAILED for it: cite one that " +
            "reads the file this criterion is about, or a project-wide check (`bun test`, " +
            "`bunx tsc --noEmit`), or state the check in the criterion itself and read back " +
            `again. (${ledger.met} of ${ledger.total} criteria verified)` +
            nextStep,
        );
      }

      // Take the parent-commit measurement before judging the citation — but
      // only once per command, and only for a command that is currently
      // passing. Probing a failing check would spend a full test run to learn
      // nothing (rungForCommand refuses it either way), and probing twice
      // would spend it again for an answer already on record. An unrelated
      // citation never reaches here, so it never spends one either.
      if (
        probeParent &&
        lastRun?.passed &&
        lastRun.kind !== "execution" &&
        !lastRun.authoredBy &&
        !log.parent(command)
      ) {
        const parent = probeParent(command);
        if (parent) log.recordParent(parent);
      }

      const verdict = rungForCommand(log, command);
      if (!verdict.ok) return reply(verdict.reason);

      const moved = ledger.record(index, verdict.rung, verdict.evidence);
      if (!moved.ok) return reply(moved.reason);
      return reply(
        `Recorded as ${verdict.rung}: ${RUNG_MEANING[verdict.rung]} ` +
          (verdict.evidence.detail ? `Receipt: ${verdict.evidence.detail}. ` : "") +
          `(${ledger.met} of ${ledger.total} criteria verified)` +
          (verdict.rung === "verified"
            ? ""
            : ". Passing evidence is recorded. This rung does not request another run; report its scope and limits. Repeat checks when code or requirements change, not solely to raise the rung.") +
          nextStep,
      );
    },
  };
}

/**
 * The one quotable line from a check's output.
 *
 * The ladder is ordered by how much a READER learns from the line, because
 * this string is what a hypothesis's reason and a criterion's evidence detail
 * are made of:
 *
 *   1. the named failure  -- `(fail) the cache TTL changed across the deploy`
 *   2. the error itself   -- `error: expect(received).not.toBe(expected)`
 *   3. the counts         -- `1 fail`
 *   4. the tail, where runners put their verdict
 *
 * "1 fail" was the top of the ladder until P11.1 put this string in front of a
 * person: a record whose folded branch reads "refuted: 1 fail" has told them
 * the shape of the evidence and none of it.
 */
export function summarizeCheck(raw: string): string | undefined {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const reversed = [...lines].reverse();
  const named = reversed.find((l) => /^\((?:fail|failed)\)\s+\S/i.test(l));
  const errored =
    named ?? reversed.find((l) => /^(?:error|assertionerror|panic|fatal|exception)\b/i.test(l));
  const counted = errored ?? reversed.find((l) => /\d+\s*(\/|of|pass|fail|error)/i.test(l));
  const chosen = counted ?? lines[lines.length - 1]!;
  return chosen.length > 90 ? chosen.slice(0, 87) + "..." : chosen;
}

/** The shell tool reports whether it launched; a check is judged by the child exit.
 * Shared by the plan, citations, retrospective and learned command facts. */
export function bashCheckVerdict(output: { success: boolean; result?: string; error?: string }): {
  passed: boolean;
  summary: string;
  exitCode?: number;
} {
  if (!output.success) {
    return {
      passed: false,
      summary:
        (output.error ?? output.result ?? "").trim().split("\n").at(-1)?.trim().slice(0, 160) ||
        "failed",
    };
  }
  let exitCode: number | undefined;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  try {
    const parsed = JSON.parse(output.result ?? "") as Record<string, unknown>;
    if (typeof parsed.exit_code === "number") exitCode = parsed.exit_code;
    timedOut = parsed.timed_out === true;
    if (typeof parsed.stdout === "string") stdout = parsed.stdout;
    if (typeof parsed.stderr === "string") stderr = parsed.stderr;
  } catch {
    // Not the shell's JSON shape (a stubbed tool, an embedder's own runner).
    // Fall back to the flag, which is what this did before it read the code.
    return { passed: true, summary: "ok" };
  }
  const passed = !timedOut && (exitCode == null || exitCode === 0);
  if (passed) return { passed: true, summary: "ok", ...(exitCode != null ? { exitCode } : {}) };
  // BOTH streams, through the shared ladder. Runners disagree about where the
  // verdict goes -- `bun test` writes the failure to stderr and leaves stdout
  // holding nothing but its own version banner, which is exactly the line a
  // stdout-only reading would quote back as the reason a theory was ruled out.
  const summary =
    summarizeCheck([stdout, stderr].filter(Boolean).join("\n")) ??
    (timedOut ? "timed out" : "failed");
  return {
    passed: false,
    summary: summary.slice(0, 160),
    ...(exitCode != null ? { exitCode } : {}),
  };
}
