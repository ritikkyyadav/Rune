// ─── Core Agent ───
export {
  AgentLoop,
  INTERJECTION_MARKER,
  formatInterjection,
  parseInterjection,
  type AgentLoopConfig,
  type AgentState,
  type AgentTurnEvent,
  type PermissionCheck,
  type PermissionCheckArgs,
  type PermissionCheckResult,
  type ToolResultProcessArgs,
  type ToolResultProcessor,
} from "./agent-loop";
export { createResearchTool, RESEARCH_TOOL_SCHEMA, type ResearchToolDeps } from "./research-tool";
export { createCompactTool, COMPACT_TOOL_SCHEMA, type CompactToolDeps } from "./compact-tool";
export {
  LoopManager,
  parseLoopRequest,
  resolveLoopPrompt,
  formatLoopInterval,
  formatLoopDue,
  loopPromptPreview,
  renderLoopRunDoctrine,
  DEFAULT_LOOP_MAINTENANCE_PROMPT,
  LOOP_MIN_INTERVAL_MS,
  LOOP_EXPIRY_MS,
  LOOP_MAX_TASKS,
  type LoopTask,
  type LoopCadence,
  type LoopRunOutcome,
  type LoopCompletion,
  type LoopCancelResult,
} from "./loop-mode";
export {
  createLoopControlTool,
  LOOP_CONTROL_SCHEMA,
  type LoopControlToolDeps,
} from "./loop-control-tool";
export {
  Engine,
  type EngineConfig,
  type PermissionHandler,
  type PermissionPrompt,
  type UserPermissionDecision,
} from "./engine";
export {
  PermissionBroker,
  PERMISSION_MODE_ORDER,
  configModeToPermissionMode,
  nextPermissionMode,
  permissionModeToConfig,
  type PermissionDecision,
  type PermissionMode,
  type PermissionModeInput,
  type PermissionRule,
  type PermissionScope,
} from "./permissions";
// PlanRunner was retired with the task-spine work — planning is a property of
// the default loop now. The event-union alias survives for embedders.
export type { AgentTurnEvent as PlanRunnerEvent } from "./agent-loop";

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

// (ProductionEngine and the errors.ts retry/circuit architecture were removed
// in the phase-0 stabilization: neither was instantiated or consumed anywhere —
// real retry/fallback policy lives in the gateway and reliability-policy.ts.)

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
export {
  AutoModeSafetyController,
  GatewayActionClassifier,
  resolveAutoModeConfig,
  classifyAutoModeTier,
  isHaltExemptTool,
  assessActionRisk,
  ruleMatches,
  DEFAULT_AUTO_MODE_ENVIRONMENT,
} from "./auto-mode";
export type {
  AutoModePolicyConfig,
  ResolvedAutoModeConfig,
  AutoModeAction,
  AutoModeReview,
  AutoModeRisk,
  AutoModeTier,
  AutoModeVerdict,
  AutoModeStats,
  ActionClassifier,
  ClassifierCall,
} from "./auto-mode";

// ─── Tokenizer ───
export { TokenCounter, tokenCounter, countTokens, getContextLimit } from "./tokenizer";

// ─── Reliability policy ───
export { DEFAULT_RELIABILITY, policyForModel, type ReliabilityPolicy } from "./reliability-policy";

// ─── Loop-guard call signatures ───
export { breakerSignature, batchSignature } from "./call-signature";

// ─── Plugin bundles (.gear/plugins) ───
export { discoverPlugins, type PluginManifest, type LoadedPlugin } from "./plugins";

// ─── Detach/attach: host client + per-run worktrees ───
export { HostClient, type HostStreamFrame } from "./host-client";
export {
  createRunWorktree,
  listRunWorktrees,
  removeRunWorktree,
  isGitRepo,
  type RunWorktree,
} from "./worktree";

// ─── Signed org policy (managed machines) ───
export {
  loadOrgPolicy,
  policyDenial,
  policyAllowsModel,
  canonicalPolicyBytes,
  type OrgPolicy,
  type LoadedOrgPolicy,
  type OrgPolicyLoadResult,
} from "./org-policy";

// ─── Session Replay ───
export { resumeFromCheckpoint } from "./session-replay";
