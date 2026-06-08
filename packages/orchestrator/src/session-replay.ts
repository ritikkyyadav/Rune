import type { ContentBlock, Message } from "@alan/llm-gateway";
import type { SessionEvent } from "@alan/shared";
import type { CheckpointStore, RunState } from "@alan/shared";

interface ToolUseRecord {
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface AssistantMsgPayload {
  content?: string;
  toolUses?: ToolUseRecord[];
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

export function eventsToMessages(events: Array<{ seq: number; event: SessionEvent }>): Message[] {
  const messages: Message[] = [];

  for (const { event } of events) {
    switch (event.type) {
      case "user_msg": {
        const p = event.payload as unknown as UserMsgPayload;
        messages.push({
          role: "user",
          content: [{ type: "text", text: p.content ?? "" }],
        });
        break;
      }

      case "assistant_msg": {
        const p = event.payload as unknown as AssistantMsgPayload;
        const blocks: ContentBlock[] = [];
        if (p.content && p.content.length > 0) {
          blocks.push({ type: "text", text: p.content });
        }
        for (const tu of p.toolUses ?? []) {
          blocks.push({
            type: "tool_use",
            toolCallId: tu.callId,
            toolName: tu.toolName,
            toolInput: tu.toolInput,
          });
        }
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks });
        }
        break;
      }

      case "tool_result": {
        const p = event.payload as unknown as ToolResultPayload;
        const block: ContentBlock = {
          type: "tool_result",
          toolCallId: p.callId,
          toolResultContent: p.content ?? "",
          isError: p.isError ?? false,
        };
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

  return messages;
}

export interface AssistantPersistPayload {
  content: string;
  toolUses: ToolUseRecord[];
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
  return { content: textParts.join(""), toolUses };
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
