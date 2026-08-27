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
// my change". It has to stash, run the test on the parent commit, and report.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@gear/tool-registry";

/** How much an assertion is worth. Ordered weakest → strongest. */
export type ClaimRung = "suspected" | "observed" | "reproduced" | "verified";

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
  verified: { utf8: "✓", ascii: "x" },
};

/** What it costs to write each rung — shown in help, and enforced below. */
export const RUNG_MEANING: Record<ClaimRung, string> = {
  suspected: "a hypothesis. no evidence yet, and it says so.",
  observed: "it appeared in output that can be quoted back.",
  reproduced: "it was made to happen twice, on purpose.",
  verified: "a test that failed on the parent commit passes now.",
};

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

      const brief = briefFromArgs(
        (input.args ?? {}) as Record<string, unknown>,
        getRequest(),
        new Date().toISOString(),
      );
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
