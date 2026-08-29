import type { ContentBlock, Message } from "@gear/llm-gateway";
import type { SessionEvent } from "@gear/shared";
import type { CheckpointStore, RunState } from "@gear/shared";

interface ToolUseRecord {
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface AssistantMsgPayload {
  content?: string;
  toolUses?: ToolUseRecord[];
  /**
   * Exact provider-facing block order for new events. Legacy rows only have
   * content/toolUses; those cannot preserve signed/encrypted reasoning items
   * that strict store:false transports need when a session resumes.
   */
  contentBlocks?: ContentBlock[];
}

interface ToolResultPayload {
  callId: string;
  content?: string;
  isError?: boolean;
}

interface UserMsgPayload {
  content: string;
}

interface CompactionPayload {
  /** The summary that stands in for every event folded into it. */
  summary: string;
  /** Highest event seq represented by this summary (informational). */
  replacedThroughSeq?: number;
  /** Original conversation message count before compaction (informational). */
  originalMessages?: number;
  /** "manual" (via /compress) or "auto". */
  trigger?: string;
  /** Optional user-supplied focus passed to /compress. */
  instructions?: string;
}

export function eventsToMessages(
  events: Array<{ seq: number; event: SessionEvent }>,
  opts?: { dropLegacyToolProtocol?: boolean },
): Message[] {
  const messages: Message[] = [];
  const pendingToolCalls = new Map<string, string>();

  // Historical runs could terminate after persisting an assistant tool_use
  // but before persisting its result (the loop detector was one such path).
  // Strict providers reject that transcript forever on resume. Close those
  // pairs in the replayed view; the append-only audit log remains untouched.
  const closePendingToolCalls = () => {
    if (pendingToolCalls.size === 0) return;
    messages.push({
      role: "tool",
      content: [...pendingToolCalls].map(([callId, toolName]): ContentBlock => ({
        type: "tool_result",
        toolCallId: callId,
        toolResultContent:
          `Not executed: the previous Gear run ended before ${toolName || "this tool"} returned. ` +
          "Re-run it if the result is still needed.",
        isError: true,
      })),
    });
    pendingToolCalls.clear();
  };

  for (const { event } of events) {
    switch (event.type) {
      case "user_msg": {
        closePendingToolCalls();
        const p = event.payload as unknown as UserMsgPayload;
        messages.push({
          role: "user",
          content: [{ type: "text", text: p.content ?? "" }],
        });
        break;
      }

      case "assistant_msg": {
        closePendingToolCalls();
        const p = event.payload as unknown as AssistantMsgPayload;
        const exactBlocks = Array.isArray(p.contentBlocks) ? p.contentBlocks : null;
        const blocks: ContentBlock[] = exactBlocks
          ? exactBlocks.map((block) => ({ ...block }))
          : [];
        if (!exactBlocks) {
          if (p.content && p.content.length > 0) {
            blocks.push({ type: "text", text: p.content });
          }
          // A legacy Codex row lacks the encrypted reasoning item that must
          // precede its function call. Replaying that incomplete protocol is
          // guaranteed to 400; the task spine carries durable state, so omit
          // only the old call protocol and let the agent re-run needed reads.
          if (!opts?.dropLegacyToolProtocol) {
            for (const tu of p.toolUses ?? []) {
              blocks.push({
                type: "tool_use",
                toolCallId: tu.callId,
                toolName: tu.toolName,
                toolInput: tu.toolInput,
              });
            }
          }
        }
        for (const block of blocks) {
          if (block.type === "tool_use") {
            pendingToolCalls.set(block.toolCallId, block.toolName);
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks });
        }
        break;
      }

      case "tool_result": {
        const p = event.payload as unknown as ToolResultPayload;
        // A result without a preceding call is just as invalid on provider
        // replay as a call without a result. Keep it in the raw audit log but
        // omit it from the model-visible transcript.
        if (!pendingToolCalls.has(p.callId)) break;
        const block: ContentBlock = {
          type: "tool_result",
          toolCallId: p.callId,
          toolResultContent: p.content ?? "",
          isError: p.isError ?? false,
        };
        pendingToolCalls.delete(p.callId);
        // Merge consecutive tool_result events into a single tool Message
        const last = messages[messages.length - 1];
        if (last && last.role === "tool") {
          last.content.push(block);
        } else {
          messages.push({ role: "tool", content: [block] });
        }
        break;
      }

      case "compaction": {
        // A manual /compress folds every preceding event into one summary.
        // Drop everything accumulated so far and replace it with the summary;
        // later events (future turns) then append after it normally. The
        // underlying event log is untouched — only the replayed view shrinks.
        const p = event.payload as unknown as CompactionPayload;
        pendingToolCalls.clear();
        messages.length = 0;
        messages.push({
          role: "user",
          content: [{ type: "text", text: `[Conversation summary]\n${p.summary ?? ""}` }],
        });
        break;
      }

      // system_note, checkpoint, plan_* events do not produce model-visible
      // messages directly; they are session metadata.
      default:
        break;
    }
  }

  closePendingToolCalls();

  return messages;
}

export interface AssistantPersistPayload {
  content: string;
  toolUses: ToolUseRecord[];
  contentBlocks: ContentBlock[];
  [key: string]: unknown;
}

export function messageToAssistantPayload(message: Message): AssistantPersistPayload {
  const textParts: string[] = [];
  const toolUses: ToolUseRecord[] = [];
  for (const block of message.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolUses.push({
        callId: block.toolCallId,
        toolName: block.toolName,
        toolInput: block.toolInput,
      });
    }
  }
  return {
    content: textParts.join(""),
    toolUses,
    // Preserve order and opaque provider state. A shallow clone is enough:
    // SessionManager serializes the payload immediately and no block is
    // mutated after appendMessage queues it.
    contentBlocks: message.content.map((block) => ({ ...block })),
  };
}

export interface ToolResultPersistPayload {
  callId: string;
  content: string;
  isError: boolean;
  [key: string]: unknown;
}

export function messageToToolResultPayloads(message: Message): ToolResultPersistPayload[] {
  const results: ToolResultPersistPayload[] = [];
  for (const block of message.content) {
    if (block.type === "tool_result") {
      results.push({
        callId: block.toolCallId,
        content: block.toolResultContent,
        isError: block.isError ?? false,
      });
    }
  }
  return results;
}

/**
 * Resume a run from its latest checkpoint.
 * Returns the restored RunState, or null if no checkpoint is found.
 */
export function resumeFromCheckpoint(runId: string, store: CheckpointStore): RunState | null {
  try {
    const checkpoint = store.load(runId);
    return checkpoint?.state ?? null;
  } catch {
    return null;
  }
}
