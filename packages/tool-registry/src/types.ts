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

// `ToolAttachment` and `ToolCallOutput` are wire shapes: they cross the socket
// inside `tool_call_end`, so `@gear/protocol` owns them and every surface
// reads the same definition. Re-exported here for the in-repo import sites.
export type { ToolAttachment, ToolCallOutput } from "@gear/protocol";
import type { ToolCallOutput } from "@gear/protocol";

export interface ToolHandler {
  schema: ToolSchema;
  execute(input: ToolCallInput): Promise<ToolCallOutput>;
  validate(args: Record<string, unknown>): { valid: boolean; error?: string };
}
