// ─── note_hypothesis and record_decision ───
//
// Two small tools beside `record_evidence`, and the same design rule holds for
// all three: the model says what it is DOING, and the runtime decides what
// that is worth.
//
// `note_hypothesis` takes the suspicion while it is still a suspicion. That
// ordering is the whole feature. A hypothesis recorded after its own
// refutation is a story told backwards; one recorded only when it turns out to
// be right is a record of the answer rather than of the investigation. So the
// tool writes `testing`, and the verdict comes from somewhere else — from the
// harness reading a check (agent-loop.ts), or from the model reporting a
// result it can point at.
//
// `record_decision` takes the commitment and what justified it. A decision with
// an empty `based_on` is recorded as unbacked rather than refused: the harness
// cannot know whether a given commitment needed a citation, and an argument the
// model can restate more confidently is one it eventually wins. So the absence
// is made visible — in the record, in the mission file, and in `gear audit` —
// instead of being argued about.
//
// Both are `read` category and cost nothing but their own schema: they touch
// no file, run no command, and can never block.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@gear/tool-registry";
import type { EvidenceRef, Hypothesis, HypothesisStatus, TaskDecision } from "@gear/protocol";

/** What the tools write into. The store, narrowed to what they may touch. */
export interface NarrativeSink {
  noteHypothesis(text: string, opts?: { status?: HypothesisStatus; step?: string }): Hypothesis;
  updateHypothesis(
    id: string,
    status: HypothesisStatus,
    opts?: { reason?: string; evidence?: EvidenceRef[] },
  ): Hypothesis | null;
  recordDecision(text: string, basedOn?: EvidenceRef[]): TaskDecision;
}

const STATUSES: readonly HypothesisStatus[] = ["proposed", "testing", "refuted", "confirmed"];

export const NOTE_HYPOTHESIS_SCHEMA: ToolSchema = {
  name: "note_hypothesis",
  version: "1.0.0",
  description:
    "Name what you suspect BEFORE you test it, and report the verdict when you have one. Call " +
    "with `text` to raise a hypothesis (you get back its id); call with `id` and `status` " +
    "(refuted or confirmed) plus a one-line `reason` once a check has settled it. The harness " +
    "also settles hypotheses on its own from failing and passing step checks, so a verdict you " +
    "do not report is not lost — but the SUSPICION is, and a refuted branch nobody recorded is " +
    "work the reader cannot see you did.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The suspicion, in one sentence, as a claim that could be wrong: " +
          "'the connection pool is exhausted on deploy', not 'look at the pool'.",
      },
      id: { type: "string", description: "The id of a hypothesis you are updating (e.g. `h2`)." },
      status: {
        type: "string",
        description: "Where it ended up. Use refuted/confirmed only when something settled it.",
        enum: ["proposed", "testing", "refuted", "confirmed"],
      },
      reason: {
        type: "string",
        description:
          "One line: what settled it. 'TTL unchanged across the deploy', not 'did not pan out'.",
      },
      evidence: {
        type: "array",
        description: "What you are pointing at: a command you ran, a file, a step.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["check", "file", "step", "artifact", "answer"] },
            ref: { type: "string" },
            detail: { type: "string" },
          },
          required: ["kind", "ref"],
        },
      },
    },
  },
  permissionLevel: "auto",
  category: "read",
};

export const RECORD_DECISION_SCHEMA: ToolSchema = {
  name: "record_decision",
  version: "1.0.0",
  description:
    "Record what you committed to and what justified it, at the moment you commit — not at the " +
    "end. `based_on` points at evidence you already have: a command you ran, a file you read, a " +
    "step that closed, an answer the user gave. A decision with nothing behind it is recorded " +
    "as unbacked rather than refused, and the record will say so.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The decision, in one sentence, in the form a reader can act on: " +
          "'restore the (customer_id, created_at) index', not 'fixed the index thing'.",
      },
      based_on: {
        type: "array",
        description: "The evidence it stands on.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["check", "file", "step", "artifact", "answer"] },
            ref: { type: "string", description: "The command, path, step or artifact id." },
            detail: { type: "string", description: "One quotable line of what it showed." },
          },
          required: ["kind", "ref"],
        },
      },
    },
    required: ["text"],
  },
  permissionLevel: "auto",
  category: "read",
};

/** Coerce whatever the model sent into evidence refs, dropping anything shapeless. */
export function parseEvidenceRefs(raw: unknown): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = String(e.kind ?? "").trim();
    const ref = String(e.ref ?? "").trim();
    if (!ref) continue;
    if (!["check", "file", "step", "artifact", "answer"].includes(kind)) continue;
    out.push({
      kind: kind as EvidenceRef["kind"],
      ref: ref.slice(0, 300),
      ...(typeof e.detail === "string" && e.detail.trim()
        ? { detail: e.detail.trim().slice(0, 200) }
        : {}),
      at: new Date().toISOString(),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function createNoteHypothesisTool(getSink: () => NarrativeSink | undefined): ToolHandler {
  return {
    schema: NOTE_HYPOTHESIS_SCHEMA,

    validate: (args) => {
      const text = String(args.text ?? "").trim();
      const id = String(args.id ?? "").trim();
      if (!text && !id) {
        return {
          valid: false,
          error:
            "note_hypothesis needs `text` to raise a hypothesis, or `id` and `status` to settle " +
            "one you already raised.",
        };
      }
      if (id) {
        const status = String(args.status ?? "").trim();
        if (!STATUSES.includes(status as HypothesisStatus)) {
          return {
            valid: false,
            error: `updating a hypothesis needs \`status\`: one of ${STATUSES.join(", ")}.`,
          };
        }
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

      const sink = getSink();
      if (!sink) {
        return reply(
          "No task spine in this run, so there is nothing to record a hypothesis against. " +
            "Carry on; say what you suspect in your prose instead.",
        );
      }
      const args = (input.args ?? {}) as Record<string, unknown>;
      const id = String(args.id ?? "").trim();
      const evidence = parseEvidenceRefs(args.evidence);

      if (id) {
        const status = String(args.status ?? "").trim() as HypothesisStatus;
        const reason = String(args.reason ?? "").trim();
        const updated = sink.updateHypothesis(id, status, {
          ...(reason ? { reason } : {}),
          ...(evidence.length > 0 ? { evidence } : {}),
        });
        if (!updated) {
          return reply(
            `No hypothesis ${id} on this task. Raise it with \`text\` first — the record keeps ` +
              `them in the order they were raised, and one that appears only at its verdict ` +
              `reads as though you knew the answer from the start.`,
          );
        }
        return reply(
          `${updated.id} is ${updated.status}${updated.reason ? ` — ${updated.reason}` : ""}.` +
            (status === "refuted"
              ? " Recorded as a branch you closed; it stays in the record with its reason."
              : ""),
        );
      }

      const hypothesis = sink.noteHypothesis(String(args.text ?? ""), {
        status: STATUSES.includes(String(args.status ?? "") as HypothesisStatus)
          ? (String(args.status) as HypothesisStatus)
          : "testing",
      });
      if (evidence.length > 0) {
        sink.updateHypothesis(hypothesis.id, hypothesis.status, { evidence });
      }
      return reply(
        `Recorded as ${hypothesis.id} (${hypothesis.status}). Test it, then report the verdict ` +
          `with \`id: "${hypothesis.id}"\` and a one-line reason.`,
      );
    },
  };
}

export function createRecordDecisionTool(getSink: () => NarrativeSink | undefined): ToolHandler {
  return {
    schema: RECORD_DECISION_SCHEMA,

    validate: (args) => {
      if (!String(args.text ?? "").trim()) {
        return { valid: false, error: "record_decision needs `text` — what did you decide?" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const reply = (result: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result,
        durationMs: Math.round(performance.now() - start),
      });

      const sink = getSink();
      if (!sink) {
        return reply(
          "No task spine in this run, so there is nothing to record a decision against. " +
            "Carry on; state the decision in your prose instead.",
        );
      }
      const args = (input.args ?? {}) as Record<string, unknown>;
      const basedOn = parseEvidenceRefs(args.based_on);
      const decision = sink.recordDecision(String(args.text ?? ""), basedOn);
      return reply(
        basedOn.length > 0
          ? `Recorded as ${decision.id}, on ${basedOn.length} piece${basedOn.length === 1 ? "" : "s"} of evidence.`
          : `Recorded as ${decision.id} with NO evidence cited — the record will say so. If a ` +
              `command, file or answer justified this, cite it in \`based_on\`.`,
      );
    },
  };
}
