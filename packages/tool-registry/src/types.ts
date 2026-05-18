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
}

export interface ToolCallInput {
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
  sessionId: string;
  workspaceRoot: string;
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
