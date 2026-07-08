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
}

export interface ToolCallOutput {
  callId: string;
  toolName: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
}

export interface ToolHandler {
  schema: ToolSchema;
  execute(input: ToolCallInput): Promise<ToolCallOutput>;
  validate(args: Record<string, unknown>): { valid: boolean; error?: string };
}
