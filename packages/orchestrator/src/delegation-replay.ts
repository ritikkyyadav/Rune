// ─── A delegated child, read back from its parent's log ───
//
// Every `task` and `worker` call already leaves a durable record: its whole
// conversation is written into the parent session's event log as a
// `delegation_checkpoint` row at each tool boundary and once more when it
// returns (delegated-sessions.ts). That record existed for one reader -- the
// child itself, resuming from a `task_id` -- and for nobody else. A person who
// watched four sub-agents work had no way to read any of them again once the
// process ended: the surface's own copy was an in-memory buffer, and the
// database's copy had no door.
//
// This is the door, and it is deliberately only a reader. Nothing here writes,
// nothing here decides anything, and both halves are pure so they can be tested
// without an engine or a database:
//
//   listStoredDelegations   the children of a session, one row each, from a
//                           PROJECTION of their checkpoints -- a handful of
//                           scalars per row, never the conversations.
//   delegationEntries       one child's conversation as display entries, in
//                           the order it happened.

import type { Message } from "@rune/llm-gateway";

/** One delegated child, as its parent's log records it. */
export interface StoredDelegation {
  /** `task_<uuid>`: the durable id, and the handle a follow-up resumes by. */
  id: string;
  kind: "task" | "worker";
  /** The call that dispatched it -- the surface's card key. Absent on a row
   *  written before the checkpoint carried it. */
  callId?: string;
  /** The one-word role the master wrote (`planner`). */
  name?: string;
  /** The 2-5 word brief the master wrote. */
  label?: string;
  /**
   * How it ended. Absent when only mid-run checkpoints exist, which is a child
   * whose process died before it returned -- not one that is still running:
   * nothing is running in a log that is being read back.
   */
  status?: string;
  model?: string;
  provider?: string;
  /** When its latest run began, when the record says. */
  startedAt?: string;
  /** When its latest record was written. */
  at: string;
  elapsedMs?: number;
  turns?: number;
  /** The head of what it was asked, for a child that was given no label. */
  promptHead?: string;
}

/**
 * The JSON paths `listStoredDelegations` reads, by the name it reads them
 * under. Exported so the engine asks the store for exactly these and the two
 * cannot drift apart.
 */
export const DELEGATION_PATHS = {
  id: "$.payload.id",
  kind: "$.payload.kind",
  callId: "$.payload.callId",
  name: "$.payload.name",
  label: "$.payload.label",
  status: "$.payload.status",
  model: "$.payload.model",
  provider: "$.payload.provider",
  startedAt: "$.payload.startedAt",
  recordedAt: "$.payload.at",
  elapsedMs: "$.payload.budget.elapsedMs",
  turns: "$.payload.budget.turnsUsed",
  prompt: "$.payload.messages[0].content[0].text",
} as const;

/** How much of the prompt crosses out of the database: a label's worth. */
export const DELEGATION_CLIP = { prompt: 240 } as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Fold a session's checkpoint rows into one entry per child.
 *
 * A child writes several rows -- one per tool boundary, then a final one -- and
 * a follow-up on the same `task_id` writes more. The LATEST row is the child's
 * current state, so later rows replace earlier ones field by field; what a
 * later row leaves out (an old build's row has no name) is kept from an earlier
 * one rather than erased by it.
 *
 * Order is first appearance, which is dispatch order for any child that
 * reached a tool boundary and completion order for one that did not. That is
 * the order the log can vouch for; it is not reconstructed into anything
 * neater.
 */
export function listStoredDelegations(
  rows: ReadonlyArray<{ seq: number; at: string; fields: Record<string, unknown> }>,
): StoredDelegation[] {
  const byId = new Map<string, StoredDelegation>();
  for (const row of rows) {
    const f = row.fields;
    const id = text(f.id);
    if (!id) continue;
    const kind = f.kind === "worker" ? "worker" : "task";
    const prior = byId.get(id);
    const prompt = text(f.prompt);
    const next: StoredDelegation = {
      ...prior,
      id,
      kind,
      at: text(f.recordedAt) ?? row.at,
      ...(text(f.callId) ? { callId: text(f.callId) } : {}),
      ...(text(f.name) ? { name: text(f.name) } : {}),
      ...(text(f.label) ? { label: text(f.label) } : {}),
      ...(text(f.model) ? { model: text(f.model) } : {}),
      ...(text(f.provider) ? { provider: text(f.provider) } : {}),
      ...(text(f.startedAt) ? { startedAt: text(f.startedAt) } : {}),
      ...(count(f.elapsedMs) != null ? { elapsedMs: count(f.elapsedMs) } : {}),
      ...(count(f.turns) != null ? { turns: count(f.turns) } : {}),
      ...(prompt ? { promptHead: prompt.replace(/\s+/g, " ").trim() } : {}),
    };
    // A status belongs to the row that carries it. A follow-up's boundary
    // checkpoint has none, and inheriting the previous run's `end_turn` would
    // report a child that died mid-follow-up as having finished cleanly.
    const status = text(f.status);
    if (status) next.status = status;
    else delete next.status;
    byId.set(id, next);
  }
  return [...byId.values()];
}

/** One step of a child's conversation, as a surface would draw it. */
export type DelegationEntry =
  /** What the child was asked: the dispatch, or a later follow-up. */
  | { kind: "prompt"; text: string }
  /** Something the harness told it -- a budget line, a note, an omission mark. */
  | { kind: "note"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolName: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
      /** True when the record holds the call and no result: the child stopped,
       *  or was stopped, with this call outstanding. */
      unanswered?: boolean;
    };

/**
 * Text the harness wrote into the child's conversation rather than a person or
 * the lead: every such block opens with a bracketed tag (`[Budget: turn 3 of
 * 16]`, `[Harness note]`, `[2 earlier exchanges omitted …]`). Drawn quietly --
 * it is part of the record, and it is not what the child was asked.
 */
const HARNESS_TEXT = /^\s*\[[^\]\n]{1,120}\]/;

/**
 * One child's stored conversation, as display entries in the order it ran.
 *
 * A tool call and its result are two blocks in two messages; they are joined
 * here into one entry, because one row is what a reader needs and the pairing
 * is the part with an order to get wrong. A call the record never answered is
 * kept and marked, never dropped: "it called this and we do not know what came
 * back" is a fact about the run.
 *
 * What a checkpoint does NOT hold is said by the checkpoint itself -- long tool
 * results are cut to their opening with a marker, and whole early exchanges may
 * be replaced by a count (`compactCheckpointMessages`). Those markers pass
 * through verbatim, so the transcript states its own gaps.
 */
export function delegationEntries(messages: readonly Message[]): DelegationEntry[] {
  const out: DelegationEntry[] = [];
  // callId -> where its entry sits, so the result can be attached to it.
  const open = new Map<string, number>();
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text": {
          if (!block.text.trim()) break;
          if (message.role === "assistant") {
            out.push({ kind: "text", text: block.text });
          } else {
            out.push({ kind: HARNESS_TEXT.test(block.text) ? "note" : "prompt", text: block.text });
          }
          break;
        }
        case "thinking":
          if (block.thinking.trim()) out.push({ kind: "thinking", text: block.thinking });
          break;
        case "tool_use":
          open.set(block.toolCallId, out.length);
          out.push({
            kind: "tool",
            toolName: block.toolName,
            args: block.toolInput ?? {},
            result: "",
            isError: false,
            unanswered: true,
          });
          break;
        case "tool_result": {
          const at = open.get(block.toolCallId);
          const entry = at == null ? undefined : out[at];
          if (entry?.kind === "tool") {
            entry.result = block.toolResultContent;
            entry.isError = block.isError === true;
            delete entry.unanswered;
            open.delete(block.toolCallId);
          }
          break;
        }
        // An image was replaced by a text marker at save time, and opaque
        // provider reasoning has no readable form at all.
        default:
          break;
      }
    }
  }
  return out;
}
