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

// ─── The prefix fingerprint (P3B I5) ───
//
// FNV-1a over UTF-16 code units. Not a checksum and not a security primitive:
// it is only ever compared to the hash of ANOTHER request on the same machine
// in the same run, to answer "did the prefix these two requests sent differ".
// It is one multiply and one xor per character over text the caller has
// already assembled, which is nothing beside the request it describes.
//
// It stores no content. Eight hex characters cannot reconstruct a prompt, and
// that is deliberate — this rides in a session log the cost report reads.

const FNV_OFFSET = 0x811c9dc5;

function fold(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fold one message's text the same way `messageBytes` counts it. */
function foldMessage(hash: number, message: Message): number {
  let h = fold(hash, message.role);
  for (const block of message.content) {
    h = fold(h, block.type);
    switch (block.type) {
      case "text":
        h = fold(h, block.text);
        break;
      case "tool_use":
        h = fold(fold(h, block.toolName), JSON.stringify(block.toolInput ?? {}));
        break;
      case "tool_result":
        h = fold(h, block.toolResultContent ?? "");
        break;
      default:
        h = fold(h, JSON.stringify(block));
    }
  }
  return h;
}

/**
 * Measure a request's parts.
 *
 * `messages` is what goes on the wire, and the caller names the ephemeral
 * blocks inside it — the plan ledger, the budget/team notices — because only it
 * knows: on the wire they are an ordinary user message, or the end of a tool
 * output, indistinguishable from the work. This is the same seam the cache
 * breakpoint uses, and it is why `stableMessageCount` exists in the agent loop.
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
  /**
   * The blocks named above ride INSIDE `messages` rather than after them.
   *
   * Two wire shapes carry the same text: trailing user messages on most hosts,
   * and — where a request that ends on a user message ends the prompt cache —
   * folded into the last message (`withTailFolded`). Either way `messages` is
   * what the provider is sent, because the prefix fingerprint has to be the
   * fingerprint of the bytes that went out; this says to give those bytes back
   * to the ledger instead of counting them twice, so `total` stays the size of
   * the request. Tails from EARLIER requests that a folding host replays are
   * not deducted: they are conversation now, and they are really on the wire.
   */
  tailInMessages?: boolean;
  /**
   * The index the caller marked as the last cacheable message, when it marked
   * one. Recorded, not used: the cache decision belongs to the caller, and
   * this is the ruler that says what the decision was.
   */
  cacheBreakpointIndex?: number;
}): PromptComposition {
  const systemText = parts.system ?? "";
  const toolsJson = parts.tools?.length ? JSON.stringify(parts.tools) : "";
  const doctrine = utf8Bytes(systemText);
  const toolSchemas = utf8Bytes(toolsJson);
  let messageBytesTotal = 0;
  // The prefix is what a provider's cache would match on: the system prompt,
  // the tool surface and the messages, exactly as they were sent. Folded in the
  // same pass that measures it.
  let prefix = fold(fold(FNV_OFFSET, systemText), toolsJson);
  for (const m of parts.messages) {
    messageBytesTotal += messageBytes(m);
    prefix = foldMessage(prefix, m);
  }
  const planLedger = utf8Bytes(parts.planLedger ?? "");
  let taskState = 0;
  for (const block of parts.taskState ?? []) taskState += utf8Bytes(block ?? "");
  const conversation = parts.tailInMessages
    ? Math.max(0, messageBytesTotal - planLedger - taskState)
    : messageBytesTotal;
  return {
    doctrine,
    planLedger,
    taskState,
    toolSchemas,
    conversation,
    total: doctrine + planLedger + taskState + toolSchemas + conversation,
    ...(parts.cacheBreakpointIndex !== undefined
      ? { cacheBreakpointIndex: parts.cacheBreakpointIndex }
      : {}),
    prefixHash: prefix.toString(16).padStart(8, "0"),
  };
}

/** The five measured byte parts — the ones that have a share of the total. */
export type CompositionPart =
  "doctrine" | "planLedger" | "taskState" | "toolSchemas" | "conversation";

/** The share each part took, for a readout. Null when nothing was measured. */
export function compositionShares(c: PromptComposition): Record<CompositionPart, number> | null {
  if (c.total <= 0) return null;
  return {
    doctrine: c.doctrine / c.total,
    planLedger: c.planLedger / c.total,
    taskState: c.taskState / c.total,
    toolSchemas: c.toolSchemas / c.total,
    conversation: c.conversation / c.total,
  };
}
