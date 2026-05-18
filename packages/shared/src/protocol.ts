// ─── JSON-RPC 2.0 Base Types ───

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ─── Error Codes ───

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom
  SESSION_NOT_FOUND: -32000,
  PERMISSION_DENIED: -32001,
  TOOL_EXEC_FAILED: -32002,
  CONTEXT_OVERFLOW: -32003,
  PROVIDER_ERROR: -32004,
  SANDBOX_VIOLATION: -32005,
} as const;

// ─── Engine Methods ───

export type EngineMethod =
  | "ping"
  | "session.create"
  | "session.resume"
  | "session.list"
  | "session.fork"
  | "session.delete"
  | "message.send"
  | "message.cancel"
  | "tool.list"
  | "tool.call"
  | "plan.get"
  | "plan.update"
  | "context.inspect"
  | "config.get"
  | "config.set";

// ─── Notification Methods (server -> client) ───

export type NotificationMethod =
  | "stream.token"
  | "stream.toolCall"
  | "stream.toolResult"
  | "stream.planUpdate"
  | "stream.progress"
  | "stream.error"
  | "stream.done";

// ─── Domain Types ───

export interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  model: string;
  eventCount: number;
  title?: string;
}

export interface StreamToken {
  sessionId: string;
  content: string;
  role: "assistant";
}

export interface ToolCallEvent {
  sessionId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "running" | "completed" | "failed";
}

export interface ToolResultEvent {
  sessionId: string;
  callId: string;
  toolName: string;
  result: unknown;
  durationMs: number;
  exitCode?: number;
}

// ─── Plan Types ───

export interface Plan {
  id: string;
  steps: Step[];
  status: PlanStatus;
  createdAt: string;
}

export interface Step {
  index: number;
  description: string;
  toolsHint: string[];
  successCriteria: string;
  status: StepStatus;
  result?: StepResult;
  dependsOn: number[];
}

export type PlanStatus = "active" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  error?: string;
}
