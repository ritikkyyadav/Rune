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
//
// The engine event union is NOT redeclared here any more. It lives in
// `@gear/protocol`, which the engine yields and the host streams verbatim, and
// this file's hand-written copy had drifted both ways: stale `plan_*` /
// `step_*` members the engine stopped emitting long ago, and four live events
// (`retry`, `tool_progress`, `step_check`, `handoff`) it had never learned. A
// desktop that renders nothing for an event the terminal renders is the exact
// failure Phase 2 exists to end.

export type {
  AgentTurnEvent,
  AgentTurnEvent as EngineEvent,
  ChildAgentEvent,
  ToolCallOutput,
  ToolAttachment,
  TodoItem,
  TodoStatus,
  StepEvidence,
  HandoffReason,
} from "@gear/protocol";

// ─── Permission Types ───
//
// The five round-trips are protocol shapes: the desktop holds all of them over
// the socket exactly as the terminal does (P2.2).

export type {
  PermissionPrompt,
  PermissionScope,
  UserPermissionDecision,
  PermissionDecisionKind as PermissionDecision,
  UserQuestion,
  Brief,
  BriefDecision,
  Criterion,
  ClaimRung,
  Evidence,
  AutoApprovalNotice,
  HeldStep,
  HeldStepRunResult,
  ContainmentKind,
} from "@gear/protocol";

/** The gear ladder (mirrors packages/orchestrator/src/permissions.ts). */
export type PermissionMode = "gear-1" | "gear-2" | "gear-3" | "gear-4" | "auto";

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
