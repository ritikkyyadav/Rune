// ─── MCP Protocol Types ───
// Subset of the Model Context Protocol needed for tool discovery and execution.

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
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
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Any inbound message from a server (response to a request, or a server-initiated message). */
export type McpIncomingMessage =
  | McpJsonRpcResponse
  | (McpJsonRpcRequest & { id?: number })
  | McpJsonRpcNotification;

// ─── Shared limits ───

export const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_PARAM_SIZE = 1_000_000; // 1MB per string param
export const HEALTH_CHECK_MAX_FAILURES = 3;
export const REQUEST_TIMEOUT_MS = 30_000;

// ─── Transport ───

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
}
