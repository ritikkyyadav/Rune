export type PermissionLevel = "auto" | "confirm" | "sandbox";
export type ToolCategory = "read" | "write" | "execute" | "network";

export interface ToolSchema {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionLevel: PermissionLevel;
  category: ToolCategory;
  /**
   * Explicitly safe to run concurrently with other tool calls. Read+auto
   * tools get this implicitly; an execute-category tool may opt in when its
   * own machinery makes parallel runs safe (e.g. `worker` ownership claims).
   */
  parallelSafe?: boolean;
}

export interface ToolCallInput {
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
  sessionId: string;
  workspaceRoot: string;
  /** Aborts the in-flight call when the turn is cancelled. Honored by tools that
   *  support cooperative cancellation (e.g. MCP sends notifications/cancelled). */
  signal?: AbortSignal;
  /**
   * Live progress channel for LONG tool calls (sub-agents, workers): one short
   * line per meaningful step ("editing src/x.ts"). The loop surfaces these on
   * the live status rung — before this, a multi-minute parallel worker build
   * rendered as one frozen line. Fire-and-forget; never awaited.
   */
  onProgress?: (note: string) => void;
}

/**
 * Non-text output a tool produced, carried beside the result rather than inside
 * it. Pixels must never reach a transcript as characters: a 130 KB screenshot
 * lossy-decoded into `result` was ~327 KB of mojibake that taught the model
 * nothing and cost more context than the rest of the turn.
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
  /** Images this call produced. The agent loop turns these into real content
   *  blocks; they are never serialized into `result`. */
  attachments?: ToolAttachment[];
}

export interface ToolHandler {
  schema: ToolSchema;
  execute(input: ToolCallInput): Promise<ToolCallOutput>;
  validate(args: Record<string, unknown>): { valid: boolean; error?: string };
}
