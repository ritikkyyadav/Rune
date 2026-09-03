// ─── @gear/protocol ───
//
// One typed, versioned contract between the engine and every surface that
// drives it: the terminal, the desktop, the web client, editors, CI and the
// SDK. Zero runtime dependencies, so a browser bundle can import it whole.
//
// The invariant this package exists to hold: no client duplicates the event
// union, and no client reaches into engine internals. Drift between clients is
// a type error, not a rendering bug found six weeks later.
//
// See `docs/protocol.md` for the envelope, the commands, the streams and auth.

export { PROTOCOL_VERSION, PROTOCOL_MAJOR, isCompatibleVersion } from "./version";
export { assertNever, assertNeverSoft } from "./assert";

export type { ToolAttachment, ToolCallOutput } from "./tool";
export type { TodoItem, TodoStatus, StepEvidence, HandoffReason } from "./task";

export type {
  AgentTurnEvent,
  AgentTurnEventType,
  ChildAgentEvent,
  WorkflowNodeContext,
} from "./events";
export { AGENT_TURN_EVENT_TYPES, isAgentTurnEvent, isAgentTurnEventType } from "./events";

export type {
  ResearchDepth,
  ResearchEvent,
  ResearchEventType,
  ResearchPlan,
  ResearchClarification,
  ResearchReport,
  ResearchSource,
  ResearchSubQuestion,
  SourceScope,
  SubQuestionResult,
} from "./research";
export { RESEARCH_EVENT_TYPES, RESEARCH_ONLY_EVENT_TYPES, isClarification } from "./research";

export type {
  AutoApprovalNotice,
  Brief,
  BriefDecision,
  ClaimRung,
  ContainmentKind,
  Criterion,
  Evidence,
  HeldStep,
  HeldStepRunResult,
  PermissionDecisionKind,
  PermissionPrompt,
  PermissionScope,
  UnattendedReason,
  UserPermissionDecision,
  UserQuestion,
} from "./roundtrips";
export { NO_ANSWER_TEXT, UNATTENDED_POLICY } from "./roundtrips";

export type {
  EngineStatus,
  HostCommandArgs,
  HostCommandName,
  HostCommandResult,
  HostCommands,
  HostStreamName,
  HostStreams,
  ReplayFrame,
  SessionSummary,
  SubscribeResult,
  TranscriptMessage,
  TurnContext,
} from "./commands";
export { HOST_COMMANDS, HOST_STREAMS, SETTINGS_COMMANDS } from "./commands";

export type {
  LegacyRequest,
  LegacyResponse,
  LegacyStream,
  MethodName,
  NormalizedRequest,
  RpcError,
  RpcErrorCode,
  RpcFailure,
  RpcFrame,
  RpcNotification,
  RpcRequest,
  RpcResponse,
  RpcSuccess,
} from "./envelope";
export {
  JSONRPC_VERSION,
  ProtocolError,
  RPC_ERROR,
  decodeFrame,
  encodeFrame,
  isRpcFailure,
  isRpcFrame,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  rpcFailure,
  rpcNotification,
  rpcRequest,
  rpcSuccess,
  streamNameOf,
  streamNotification,
  toRequest,
  toResponse,
  toResult,
  toStream,
} from "./envelope";

export {
  isHostCommand,
  isWellFormedToken,
  optionalBoolean,
  optionalCount,
  optionalString,
  optionalStringArray,
  requireBriefDecision,
  requireCommand,
  requirePermissionDecision,
  requireString,
  timingSafeEqual,
} from "./validate";
