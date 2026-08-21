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
  attachments?: MessageAttachment[];
  toolCalls?: ToolCallInfo[];
  plan?: Plan;
}

export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
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
  | { type: "replanning"; failedStep: number; reason: string }
  // ── v2 events the engine host forwards verbatim (trace + transcript) ──
  | { type: "thinking_delta"; text: string }
  | { type: "stream_reset" }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      context?: { used: number; limit: number; percent: number };
    }
  | {
      type: "fallback";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      status?: number;
      reason?: string;
      chain?: string[];
    }
  | {
      type: "compaction";
      beforeTokens: number;
      afterTokens: number;
      limitTokens: number;
      summarizedCount?: number;
      forced?: boolean;
    }
  | { type: "checkpoint_saved"; runId: string; version: number; turnCount?: number }
  | { type: "todo_updated"; items: { content: string; status: string }[] }
  | { type: "verification_started"; attempt: number }
  | {
      type: "verification_completed";
      attempt: number;
      ran: boolean;
      passed: boolean;
      report: string;
    }
  | { type: "notice"; message: string }
  | { type: "context_warning"; message: string };

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
  safety?: {
    reason: string;
    risk: string;
    tier: string;
    source: string;
    reviewer?: { provider: string; model: string };
  };
  exactSessionGrant?: boolean;
  /** Live per-minute rate-limit occupancy for this tool (v2 risk row). */
  rateLimit?: { used: number; limit: number };
}

/** The gear ladder (mirrors packages/orchestrator/src/permissions.ts). */
export type PermissionMode = "gear-1" | "gear-2" | "gear-3" | "gear-4" | "auto";

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

// ─── Connection Types ───

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface EngineStatus {
  state: ConnectionState;
  model: string;
  provider: string;
  workspace?: string;
  contextUsed: number;
  contextMax: number;
  totalCost: number;
  /** Gear ladder id ("gear-1" … "gear-4" | "auto"); legacy spellings may still arrive. */
  permissionMode?: PermissionMode | string;
  securityPosture?: string;
  autoMode?: {
    enabled: boolean;
    failClosed: boolean;
    reviewer: { provider: string; model: string; isolatedContext: true } | null;
    policy: {
      environmentEntries: number;
      hardRules: number;
      askRules: number;
      allowRules: number;
    };
    stats: {
      decisions: number;
      allowed: number;
      asked: number;
      denied: number;
      classifierCalls: number;
      classifierFailures: number;
      probeScans: number;
      injectionsFlagged: number;
      lastDecisionAt: string | null;
    };
  };
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
