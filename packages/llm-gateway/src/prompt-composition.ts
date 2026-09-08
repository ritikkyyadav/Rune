// ─── What one request is made of, in bytes (P12.1) ───
//
// "~34k fresh input tokens per completion" was the founder's measurement, and
// it was a total with no parts: nobody could say whether that was the doctrine,
// the tool surface, the plan ledger or the conversation, so nobody could say
// what to trim. This is the ruler.
//
// Bytes of UTF-8, not tokens. The provider's own usage report gives the exact
// token count for the whole request; a second, local token estimate per part
// would be a guess stacked on an exact number. Bytes are exact, they are what
// the caller can actually measure before sending, and the ratios between the
// parts — which is the whole question — are the same either way.

import type { Message, PromptComposition, ToolDefinition } from "./types";

const BYTES = new TextEncoder();

export function utf8Bytes(text: string): number {
  return text ? BYTES.encode(text).length : 0;
}

/** Every text byte in a message, including tool-call arguments and results. */
export function messageBytes(message: Message): number {
  let total = 0;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        total += utf8Bytes(block.text);
        break;
      case "tool_use":
        total += utf8Bytes(block.toolName) + utf8Bytes(JSON.stringify(block.toolInput ?? {}));
        break;
      case "tool_result":
        total += utf8Bytes(block.toolResultContent ?? "");
        break;
      default:
        // Images and anything added later: count the serialized form rather
        // than pretending a block with no text costs nothing.
        total += utf8Bytes(JSON.stringify(block));
    }
  }
  return total;
}

export function toolSchemaBytes(tools: ReadonlyArray<ToolDefinition> | undefined): number {
  if (!tools?.length) return 0;
  return utf8Bytes(JSON.stringify(tools));
}

/**
 * Measure a request's parts.
 *
 * The caller names which of the trailing messages are the ephemeral blocks —
 * the plan ledger, the budget/team notices — because only it knows: on the
 * wire they are ordinary user messages, indistinguishable from the work. This
 * is the same seam the cache breakpoint uses, and it is why `stableMessageCount`
 * exists in the agent loop.
 */
export function measureComposition(parts: {
  system?: string;
  tools?: ReadonlyArray<ToolDefinition>;
  /** The conversation proper — everything that recurs next turn. */
  messages: ReadonlyArray<Message>;
  /** The task-state / plan-ledger block, when one was appended. */
  planLedger?: string | null;
  /** Other ephemeral tails (team presence, turn budget). */
  taskState?: ReadonlyArray<string | null | undefined>;
}): PromptComposition {
  const doctrine = utf8Bytes(parts.system ?? "");
  const toolSchemas = toolSchemaBytes(parts.tools);
  let conversation = 0;
  for (const m of parts.messages) conversation += messageBytes(m);
  const planLedger = utf8Bytes(parts.planLedger ?? "");
  let taskState = 0;
  for (const block of parts.taskState ?? []) taskState += utf8Bytes(block ?? "");
  return {
    doctrine,
    planLedger,
    taskState,
    toolSchemas,
    conversation,
    total: doctrine + planLedger + taskState + toolSchemas + conversation,
  };
}

/** The share each part took, for a readout. Null when nothing was measured. */
export function compositionShares(
  c: PromptComposition,
): Record<keyof Omit<PromptComposition, "total">, number> | null {
  if (c.total <= 0) return null;
  return {
    doctrine: c.doctrine / c.total,
    planLedger: c.planLedger / c.total,
    taskState: c.taskState / c.total,
    toolSchemas: c.toolSchemas / c.total,
    conversation: c.conversation / c.total,
  };
}
