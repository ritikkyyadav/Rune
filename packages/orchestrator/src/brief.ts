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

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@gear/tool-registry";
import type { TaskKind } from "@gear/protocol";
import { TASK_KINDS } from "@gear/protocol";

/**
 * Commands whose result is evidence, rather than merely another action:
 * tests, typechecks, lints, builds. The check log records only these, and a
 * step completed right after one of these FAILED is refused (task-state.ts).
 * Lives here, beside the ledger that consumes it, rather than in the UI layer
 * where it was born — no engine module may import a surface module, and a gate
 * on Phase 2 counts the violations.
 */
export function isVerificationCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)/.test(cmd) ||
    /(^|[\s;&|])(lint|eslint|ruff|mypy|typecheck|tsc|check|build)([\s;&|]|$)/.test(cmd) ||
    /\b(cargo\s+(test|check|clippy)|go\s+test|swift\s+test|xcodebuild|gradle\w*\s+test|mvn\w*\s+test)\b/.test(
      cmd,
    )
  );
}

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

// The brief and its criteria cross the wire: the read-back is a round-trip a
// desktop or web client holds exactly as the terminal does, so @gear/protocol
// owns the shapes and they are re-exported here.
export type { Criterion, Brief, ClaimRung, Evidence, BriefDecision } from "@gear/protocol";
import type { Brief, ClaimRung, Criterion, Evidence } from "@gear/protocol";

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
  constructor(private readonly brief: Brief) {}

  get criteria(): readonly Criterion[] {
    return this.brief.criteria;
  }

  get met(): number {
    return this.brief.criteria.filter((c) => c.rung === "verified").length;
  }

  get total(): number {
    return this.brief.criteria.length;
  }

  /** Every criterion verified. The ONLY definition of done this codebase has. */
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
    criterion.evidence = evidence;
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
      const settled = reply.edited ?? brief;
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
  /**
   * The exit code the runtime read, and how long the command took. Present for
   * checks the HARNESS ran (the verifier reads both directly); absent for
   * checks the model ran through `bash`, where the tool result carries a
   * success flag rather than a code. "No data" is null, never zero.
   */
  exitCode?: number;
  durationMs?: number;
}

/**
 * What running one command against the pre-change tree established. `failed`
 * is the only status that can lift a criterion to `verified`; `passed` is the
 * finding that the change is NOT why the check is green, and `inconclusive`
 * means the parent tree could not answer (usually: nothing installed there).
 */
export interface ParentRun {
  command: string;
  status: "failed" | "passed" | "inconclusive";
  commit?: string;
  reason?: string;
}

/** Every check the runtime ran this session, with the verdict IT read. */
export class CheckLog {
  private readonly runs: CheckRun[] = [];
  private readonly parents: ParentRun[] = [];

  record(run: CheckRun): void {
    this.runs.push(run);
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

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
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
  const base: Evidence = {
    source: normalizeCommand(command),
    detail: last.summary,
  };

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
        : undefined;

  if (runs.length >= 2) {
    return {
      ok: true,
      rung: "reproduced",
      evidence: {
        ...base,
        detail: joinDetail(joinDetail(last.summary, `passed ${runs.length} times`), note ?? ""),
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
    "you go, not at the end.",
  inputSchema: {
    type: "object",
    properties: {
      criterion: {
        type: "number",
        description: "0-based index of the done_when criterion this speaks to.",
      },
      command: {
        type: "string",
        description: "The command you ran, verbatim, exactly as you ran it.",
      },
    },
    required: ["criterion", "command"],
  },
  permissionLevel: "auto",
  category: "read",
};

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
): ToolHandler {
  return {
    schema: RECORD_EVIDENCE_SCHEMA,

    validate: (args) => {
      if (typeof args.criterion !== "number" || !Number.isInteger(args.criterion)) {
        return { valid: false, error: "criterion must be the 0-based index of a done_when item" };
      }
      if (!String(args.command ?? "").trim()) {
        return { valid: false, error: "command must be the command you ran, verbatim" };
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
      if (!ledger) {
        return reply(
          "No brief in play. Call read_back first — criteria have to exist before evidence can " +
            "settle one.",
        );
      }
      const index = Number((input.args ?? {}).criterion);
      const command = String((input.args ?? {}).command ?? "");
      const log = getLog();

      // Take the parent-commit measurement before judging the citation — but
      // only once per command, and only for a command that is currently
      // passing. Probing a failing check would spend a full test run to learn
      // nothing (rungForCommand refuses it either way), and probing twice
      // would spend it again for an answer already on record.
      const runs = log.history(command);
      const lastRun = runs[runs.length - 1];
      if (probeParent && lastRun?.passed && !log.parent(command)) {
        const parent = probeParent(command);
        if (parent) log.recordParent(parent);
      }

      const verdict = rungForCommand(log, command);
      if (!verdict.ok) return reply(verdict.reason);

      const moved = ledger.record(index, verdict.rung, verdict.evidence);
      if (!moved.ok) return reply(moved.reason);
      return reply(
        `Recorded as ${verdict.rung}: ${RUNG_MEANING[verdict.rung]} ` +
          `(${ledger.met} of ${ledger.total} criteria verified)`,
      );
    },
  };
}

/** The one quotable line from a check's output — the tail, where failures live. */
export function summarizeCheck(raw: string): string | undefined {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  // Prefer a line that carries counts; otherwise the last line, because that is
  // where test runners put their verdict.
  const counted = [...lines].reverse().find((l) => /\d+\s*(\/|of|pass|fail|error)/i.test(l));
  const chosen = counted ?? lines[lines.length - 1]!;
  return chosen.length > 90 ? chosen.slice(0, 87) + "..." : chosen;
}
