// ─── Core Agent ───
export {
  AgentLoop,
  type AgentLoopConfig,
  type AgentState,
  type AgentTurnEvent,
  type PermissionCheck,
  type PermissionCheckArgs,
  type PermissionCheckResult,
} from "./agent-loop";
export {
  Engine,
  type EffortLevel,
  type EngineConfig,
  type PermissionHandler,
  type PermissionPrompt,
  type UserPermissionDecision,
} from "./engine";
export {
  PermissionBroker,
  type PermissionDecision,
  type PermissionRule,
  type PermissionScope,
} from "./permissions";
export { Planner, type PlannerConfig, type PlannerEvent } from "./planner";
export { PlanRunner, type PlanRunnerConfig, type PlanRunnerEvent } from "./plan-runner";
export type { Plan, Step, PlanStatus, StepStatus, StepResult, ModelRouting } from "./types";

// ─── Research Mode (/research) ───
export {
  planResearch,
  runResearch,
  createResearchRegistry,
  createResearchPermissionCheck,
  extractJson,
  type ResearchDeps,
  type PlanResearchOpts,
} from "./research";
export {
  isClarification,
  type ResearchDepth,
  type SourceScope,
  type ResearchSubQuestion,
  type ResearchPlan,
  type ResearchClarification,
  type ResearchSource,
  type SubQuestionResult,
  type ResearchReport,
  type ResearchOptions,
  type ResearchEvent,
} from "./research-types";
export {
  ContextEngine,
  type ContextBudget,
  type ContextItem,
  type SessionMemory,
  type BuiltPrompt,
} from "./context-engine";

// ─── Production Infrastructure ───
export { ProductionEngine, type ProductionEngineConfig } from "./production-engine";

// ─── Error Handling (Section 10) ───
export {
  classifyError,
  withRetry,
  retryDelay,
  CircuitBreaker,
  createFailoverCircuits,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CIRCUIT_CONFIG,
} from "./errors";
export type {
  ErrorClass,
  ClassifiedError,
  RetryPolicy,
  CircuitBreakerConfig,
  CircuitState,
  FailoverConfig,
} from "./errors";

// ─── Security (Section 9) ───
export {
  scanForInjection,
  tagUntrustedInput,
  tagToolResult,
  scanOutput,
  isAllowedEgress,
  createEgressGuard,
  createToolExecutionGuard,
  DEFAULT_SECURITY_CONTEXT,
  DEFAULT_EGRESS_ALLOWLIST,
} from "./security";
export type { InjectionScanResult, OutputScanResult, SecurityContext } from "./security";

// ─── Memory (Section 5) ───
export { EpisodicMemory, WorkingMemory, estimateTokens } from "./memory/index";
export { MemoryManager } from "./memory/manager";
export type {
  EpisodicFact,
  EpisodicMemoryConfig,
  WorkingMemoryConfig,
  ContextSlot,
} from "./memory/index";

// ─── Tokenizer ───
export { TokenCounter, countTokens, getContextLimit } from "./tokenizer";

// ─── Session Replay ───
export { resumeFromCheckpoint } from "./session-replay";
