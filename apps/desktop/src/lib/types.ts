// ─── Session Types ───

export interface SessionInfo {
  id: string;
  title: string;
  model: string;
  workspace: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Message Types ───

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  toolCalls?: ToolCallInfo[];
  plan?: Plan;
}

// ─── Tool Call Types ───

export type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallInfo {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  error?: string;
  durationMs?: number;
}

// ─── Plan Types ───
// Mirrors the orchestrator's plan types.

export type PlanStatus = "active" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  error?: string;
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

export interface Plan {
  id: string;
  steps: Step[];
  status: PlanStatus;
  createdAt: string;
}

// ─── Event Types ───
// Events streamed from the engine back to the UI.

export type EngineEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; callId: string; toolName: string }
  | {
      type: "tool_call_args_delta";
      callId: string;
      partialJson: string;
    }
  | {
      type: "tool_call_end";
      callId: string;
      args: Record<string, unknown>;
      output: ToolCallOutput;
    }
  | { type: "turn_complete"; stopReason: string; totalTurns: number }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "plan_created"; plan: Plan }
  | { type: "plan_updated"; plan: Plan; reason: string }
  | { type: "step_started"; stepIndex: number; description: string }
  | {
      type: "step_completed";
      stepIndex: number;
      result: StepResult;
    }
  | { type: "plan_completed"; plan: Plan }
  | { type: "replanning"; failedStep: number; reason: string };

export interface ToolCallOutput {
  toolName: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
}

// ─── Permission Types ───

export interface PermissionPrompt {
  toolName: string;
  argsSummary: string;
  rawArgs: Record<string, unknown>;
}

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

// ─── Connection Types ───

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface EngineStatus {
  state: ConnectionState;
  model: string;
  provider: string;
  contextUsed: number;
  contextMax: number;
  totalCost: number;
}

// ─── Settings Types ───

export interface ProviderSettings {
  apiKey: string;
  model: string;
}

export interface AppSettings {
  providers: Record<string, ProviderSettings>;
  activeProvider: string;
  permissionLevel: "ask" | "auto_allow" | "auto_deny";
}

// ─── Diff Types ───

export type DiffLineType = "added" | "removed" | "context";

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}
