// ─── Commands and streams ───
//
// The full host surface as one typed map. `HostCommands[name]` gives the
// argument and result shapes, so `HostClient.call("switch_model", …)` is
// checked at both ends and a command added on the host without a client type
// is a compile error rather than a runtime `unknown command`.

import type { AgentTurnEvent } from "./events";
import type { ResearchEvent, ResearchPlan } from "./research";
import type {
  AutoApprovalNotice,
  Brief,
  BriefDecision,
  HeldStep,
  HeldStepRunResult,
  PermissionPrompt,
  UnattendedReason,
  UserPermissionDecision,
  UserQuestion,
} from "./roundtrips";

// ─── Shared payloads ───

export interface EngineStatus {
  state: "connected";
  model: string;
  provider: string;
  contextUsed: number;
  contextMax: number;
  totalCost: number;
  workspace?: string;
  permissionMode?: string;
  securityPosture?: string;
  autoMode?: unknown;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  workspace: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/** One replayed frame, carrying the store sequence it was reconstructed from. */
export interface ReplayFrame {
  seq: number;
  event: AgentTurnEvent;
}

/** What `subscribe` hands back before live frames begin (P2.5). */
export interface SubscribeResult {
  sessionId: string;
  /** Sequence the backfill ends at; pass it as `sinceSeq` to resume from here. */
  seq: number;
  /** Settled agent history reconstructed from the session store. */
  backfill: ReplayFrame[];
  /**
   * The user's own turns, with their sequences, so a client can interleave
   * them with `backfill` and rebuild the conversation in order. They are not
   * `AgentTurnEvent`s — the union has no member for "the person said this".
   */
  userTurns: Array<{ seq: number; text: string }>;
  /**
   * Recent LIVE frames from the host's ring buffer — newer than anything the
   * store has, so a client reconnecting mid-turn sees the tool call that is
   * running right now and not only the last thing written to the database.
   */
  live: AgentTurnEvent[];
  /**
   * Always true, and the client is expected to say so.
   *
   * `text_delta` is never persisted, so an assistant turn comes back as ONE
   * settled block rather than the stream that produced it. Announcing that is
   * the difference between "here is the state" and handing a client a stream
   * it can mis-assemble into a half-typed sentence that never existed.
   */
  settled: true;
  /** True when a turn is in flight on this session right now. */
  running: boolean;
}

// ─── The command map ───

export interface HostCommands {
  // ── handshake ──
  hello: {
    args: { protocolVersion?: string; client?: string };
    result: { protocolVersion: string; server: string; commands: string[] };
  };

  // ── status and sessions ──
  get_status: { args: { sessionId?: string }; result: EngineStatus };
  create_session: { args: { model?: string }; result: string };
  list_sessions: { args: Record<string, never>; result: SessionSummary[] };
  resume_session: { args: { sessionId: string }; result: TranscriptMessage[] };
  delete_session: { args: { sessionId: string }; result: null };
  subscribe: {
    args: { sessionId: string; sinceSeq?: number };
    result: SubscribeResult;
  };

  // ── the turn ──
  chat_start: {
    args: { sessionId?: string; message: string };
    result: { sessionId: string };
  };
  abort_chat: { args: { sessionId?: string }; result: { aborted: boolean } };
  interject_chat: {
    args: { sessionId?: string; text: string };
    result: { accepted: boolean };
  };

  // ── the five round-trips ──
  respond_permission: {
    args: { requestId: string; decision: UserPermissionDecision["kind"] };
    result: null;
  };
  respond_question: { args: { requestId: string; answer: string }; result: null };
  respond_brief: { args: { requestId: string; decision: BriefDecision }; result: null };
  list_held_steps: { args: { sessionId?: string }; result: HeldStep[] };
  run_held_step: {
    args: { sessionId?: string; stepId: string };
    result: HeldStepRunResult;
  };
  dismiss_held_steps: {
    args: { sessionId?: string; stepIds?: string[] };
    result: { dismissed: number };
  };

  // ── model and providers ──
  switch_model: { args: { model: string; provider?: string }; result: EngineStatus };
  list_providers: {
    args: Record<string, never>;
    result: {
      providers: unknown[];
      search: unknown;
      active: { provider: string; model: string };
    };
  };
  save_settings: {
    args: {
      apiKeys?: Record<string, string>;
      permissionLevel?: string;
      persist?: boolean;
      provider?: string;
      model?: string;
    };
    result: EngineStatus;
  };

  // ── research (P2.7) ──
  research_start: {
    args: { sessionId?: string; question: string; depth?: string; autoApprove?: boolean };
    result: { runId: string };
  };
  respond_research_plan: {
    args: { requestId: string; approved: boolean; note?: string };
    result: null;
  };

  // ── system memory ──
  get_system_memory: { args: Record<string, never>; result: unknown };
  save_system_memory: { args: { content: string }; result: unknown };
  add_memory_note: { args: { text: string }; result: unknown };
  set_memory_schedule: { args: { schedule: string }; result: unknown };
  reflect_system_memory: { args: { focus?: string }; result: unknown };
  clear_system_memory: { args: Record<string, never>; result: unknown };
}

export type HostCommandName = keyof HostCommands;
export type HostCommandArgs<K extends HostCommandName> = HostCommands[K]["args"];
export type HostCommandResult<K extends HostCommandName> = HostCommands[K]["result"];

/** Runtime list, for the `hello` handshake and the host's dispatch audit. */
export const HOST_COMMANDS = [
  "hello",
  "get_status",
  "create_session",
  "list_sessions",
  "resume_session",
  "delete_session",
  "subscribe",
  "chat_start",
  "abort_chat",
  "interject_chat",
  "respond_permission",
  "respond_question",
  "respond_brief",
  "list_held_steps",
  "run_held_step",
  "dismiss_held_steps",
  "switch_model",
  "list_providers",
  "save_settings",
  "research_start",
  "respond_research_plan",
  "get_system_memory",
  "save_system_memory",
  "add_memory_note",
  "set_memory_schedule",
  "reflect_system_memory",
  "clear_system_memory",
] as const satisfies readonly HostCommandName[];

type _AllCommandsListed =
  Exclude<HostCommandName, (typeof HOST_COMMANDS)[number]> extends never
    ? true
    : {
        ERROR: "HOST_COMMANDS is missing a command";
        missing: Exclude<HostCommandName, (typeof HOST_COMMANDS)[number]>;
      };
const _allCommandsListed: _AllCommandsListed = true;
void _allCommandsListed;

/**
 * Commands that write credentials or rewrite global configuration.
 *
 * Refused over a non-loopback connection unless the bearer token was minted
 * with `--allow-remote-settings` (P2.4). Before Phase 2 any client that could
 * open the socket could call `save_settings`, which writes API keys.
 */
export const SETTINGS_COMMANDS: readonly HostCommandName[] = ["save_settings"];

// ─── Streams (host → client, unsolicited) ───

export interface HostStreams {
  /** Sent once per connection, with the engine's opening status. */
  ready: EngineStatus & { protocolVersion: string };
  engine_status: EngineStatus;
  chat_event: { sessionId?: string; event: AgentTurnEvent };
  research_event: { sessionId?: string; runId: string; event: ResearchEvent };
  permission_request: { requestId: string; sessionId?: string; prompt: PermissionPrompt };
  question_request: { requestId: string; sessionId?: string; question: UserQuestion };
  brief_request: { requestId: string; sessionId?: string; brief: Brief };
  research_plan_request: { requestId: string; sessionId?: string; plan: ResearchPlan };
  auto_notice: { sessionId?: string; notice: AutoApprovalNotice };
  held_steps: { sessionId?: string; steps: HeldStep[] };
  /**
   * A pending round-trip resolved without a human. Clients drop the card they
   * are showing — otherwise a permission prompt that timed out stays on screen
   * offering a decision the host has already made for it.
   */
  roundtrip_resolved: {
    requestId: string;
    kind: "permission" | "question" | "brief" | "research_plan";
    reason: UnattendedReason;
    /** What the host substituted, per `UNATTENDED_POLICY`. */
    applied: string;
  };
}

export type HostStreamName = keyof HostStreams;

export const HOST_STREAMS = [
  "ready",
  "engine_status",
  "chat_event",
  "research_event",
  "permission_request",
  "question_request",
  "brief_request",
  "research_plan_request",
  "auto_notice",
  "held_steps",
  "roundtrip_resolved",
] as const satisfies readonly HostStreamName[];

type _AllStreamsListed =
  Exclude<HostStreamName, (typeof HOST_STREAMS)[number]> extends never
    ? true
    : {
        ERROR: "HOST_STREAMS is missing a stream";
        missing: Exclude<HostStreamName, (typeof HOST_STREAMS)[number]>;
      };
const _allStreamsListed: _AllStreamsListed = true;
void _allStreamsListed;
