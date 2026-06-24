// ─── MCP Protocol Types ───
// Subset of the Model Context Protocol needed for tool discovery and execution.

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Behavioral hints (readOnlyHint, destructiveHint, …) per the 2025-06-18 spec. */
  annotations?: Record<string, unknown>;
}

/** A single content block in a tool result. The spec defines text/image/audio/
 *  resource/resource_link; unknown types are preserved and degraded gracefully. */
export interface McpContentBlock {
  type: string;
  text?: string;
  /** base64 payload for image/audio. */
  data?: string;
  mimeType?: string;
  /** resource_link / embedded resource uri. */
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  /** 2025-06-18: structured (typed) result alongside the human-readable content. */
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Any inbound message from a server (response to a request, or a server-initiated message). */
export type McpIncomingMessage =
  | McpJsonRpcResponse
  | (McpJsonRpcRequest & { id?: number | string })
  | McpJsonRpcNotification;

// ─── Handshake shapes ───

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  completions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion?: string;
  capabilities?: McpServerCapabilities;
  serverInfo?: McpServerInfo;
  instructions?: string;
}

export interface McpProgress {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/** Typed lifecycle/observability events a client emits to an optional sink. */
export type McpEvent =
  | { type: "server-ready"; server: string; protocolVersion: string; toolCount: number }
  | { type: "server-down"; server: string; reason: string }
  | { type: "server-restarted"; server: string }
  | { type: "tools-changed"; server: string; toolCount: number }
  | {
      type: "progress";
      server: string;
      callId?: string;
      progress: number;
      total?: number;
      message?: string;
    }
  | { type: "log"; server: string; level: string; message: string };

// ─── Protocol versions ───
// Newest first. We offer the newest on initialize; if a server pins an older
// version we still support, we accept it. Anything else aborts the handshake.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// ─── Method / notification names ───

export const MCP_METHODS = {
  initialize: "initialize",
  initialized: "notifications/initialized",
  toolsList: "tools/list",
  toolsCall: "tools/call",
  ping: "ping",
  cancelled: "notifications/cancelled",
  progress: "notifications/progress",
  toolsListChanged: "notifications/tools/list_changed",
  resourcesListChanged: "notifications/resources/list_changed",
  promptsListChanged: "notifications/prompts/list_changed",
  loggingMessage: "notifications/message",
} as const;

export const JSONRPC_METHOD_NOT_FOUND = -32601;

// ─── Shared limits ───

export const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_PARAM_SIZE = 1_000_000; // 1MB per string param
export const HEALTH_CHECK_MAX_FAILURES = 3;
export const REQUEST_TIMEOUT_MS = 30_000;
export const INIT_TIMEOUT_MS = 20_000;
export const PING_INTERVAL_MS = 30_000;
/** Per-server cap on concurrent in-flight tools/call requests. */
export const MAX_CONCURRENT_CALLS = 8;
/** Last-N stderr lines retained per stdio server for diagnostics. */
export const STDERR_RING_LINES = 50;

// ─── Transport ───

/** Transport-level lifecycle signals the client reacts to. */
export type McpTransportLifecycle =
  | { type: "exit"; code: number | null } // stdio child process exited
  | { type: "session-expired" }; // http session id rejected (404)

/**
 * A transport moves raw JSON-RPC messages between the client and one MCP
 * server. The client owns request/response correlation; the transport only
 * frames and ships bytes (newline-delimited JSON over stdio, or HTTP+SSE).
 */
export interface McpTransport {
  /** Open the connection / spawn the process. */
  start(): Promise<void>;
  /** Ship one JSON-RPC message (request or notification). */
  send(message: object): Promise<void>;
  /** Register the callback invoked for every inbound message. */
  setMessageHandler(handler: (msg: McpIncomingMessage) => void): void;
  /** Close the connection / kill the process. */
  close(): Promise<void>;
  /** Advertise the negotiated protocol version on subsequent requests (HTTP
   *  header). No-op for stdio. */
  setProtocolVersion?(version: string): void;
  /** Register a callback for transport lifecycle (process exit, session expiry). */
  setLifecycleHandler?(handler: (ev: McpTransportLifecycle) => void): void;
}
