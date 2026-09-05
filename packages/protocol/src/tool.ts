// ─── Tool call wire shapes ───
//
// Canonical here, re-exported by `@rune/tool-registry`. They live in the
// protocol package because they cross the wire inside `tool_call_end`: a
// client that renders a tool result is reading these fields, and a second
// hand-maintained copy on the client side is exactly the drift Phase 2 exists
// to end (`apps/desktop/src/lib/types.ts` had one).

/**
 * Non-text output a tool produced, carried beside the result rather than
 * inside it. Pixels must never reach a transcript as characters: a 130 KB
 * screenshot lossy-decoded into `result` was ~327 KB of mojibake that taught
 * the model nothing and cost more context than the rest of the turn.
 */
export interface ToolAttachment {
  kind: "image";
  /** e.g. "image/png" — one of the formats every vision provider accepts. */
  mediaType: string;
  /** Base64-encoded bytes. */
  data: string;
  /** Short human label, used as the caption when the block is attached. */
  label: string;
}

export interface ToolCallOutput {
  callId: string;
  toolName: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
  /**
   * Images this call produced. The agent loop turns these into real content
   * blocks; they are never serialized into `result`.
   */
  attachments?: ToolAttachment[];
  /**
   * The typed result behind `result`, for tools that declare an `outputSchema`.
   *
   * `result` stays the rendered text the model reads — nothing downstream has
   * to change. This is the same content as an object, so the harness can
   * validate it, a UI can group by it, and a workflow node can depend on a
   * field of it instead of parsing prose back out of a paragraph.
   */
  structured?: Record<string, unknown>;
}
