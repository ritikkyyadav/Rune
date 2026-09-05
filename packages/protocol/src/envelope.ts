// ─── JSON-RPC 2.0 envelope ───
//
// The host's historical frames are JSON-RPC in all but the envelope:
// `{"id","cmd","args"}` / `{"id","ok","result"}` / `{"stream","payload"}`.
// This module gives them the real envelope without breaking the sidecar
// contract the desktop already ships against.
//
// Both shapes are accepted on the wire and `toRequest` / `toResponse`
// normalise them, so a v0 desktop build and a v1 SDK client can talk to the
// same host. New transports (`rune serve`) speak JSON-RPC 2.0 only.

import type { HostCommandName } from "./commands";

export const JSONRPC_VERSION = "2.0" as const;

// ─── Errors ───

/** JSON-RPC reserved codes, plus the ones this protocol adds. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // ── application range ──
  /** The bearer token was missing, malformed, or wrong. */
  unauthorized: -32000,
  /** Authenticated, but this command is refused on this connection. */
  forbidden: -32001,
  /** A pending round-trip expired or lost every client. */
  unattended: -32002,
  /** The client speaks an incompatible protocol major. */
  incompatibleVersion: -32003,
  /** A turn is already in flight on this session. */
  busy: -32004,
} as const;

export type RpcErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR];

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
  toRpcError(): RpcError {
    return { code: this.code, message: this.message, data: this.data };
  }
}

// ─── Frames ───

export interface RpcRequest<A = Record<string, unknown>> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: A;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  result: R;
}

export interface RpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string | null;
  error: RpcError;
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure;

/** A server push. JSON-RPC calls these notifications: no id, never answered. */
export interface RpcNotification<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params: P;
}

export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

// ─── Legacy frames (the stdio sidecar contract) ───

export interface LegacyRequest {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}
export interface LegacyResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface LegacyStream {
  stream: string;
  payload: unknown;
}

// ─── Builders ───

export function rpcRequest<A>(id: number | string, method: string, params?: A): RpcRequest<A> {
  return params === undefined
    ? ({ jsonrpc: JSONRPC_VERSION, id, method } as RpcRequest<A>)
    : { jsonrpc: JSONRPC_VERSION, id, method, params };
}

export function rpcSuccess<R>(id: number | string, result: R): RpcSuccess<R> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcFailure(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): RpcFailure {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function rpcNotification<P>(method: string, params: P): RpcNotification<P> {
  return { jsonrpc: JSONRPC_VERSION, method, params };
}

/** A stream push, in the JSON-RPC envelope: `stream.<name>`. */
export function streamNotification<P>(stream: string, payload: P): RpcNotification<P> {
  return rpcNotification(`stream.${stream}`, payload);
}

/** The stream name inside a `stream.<name>` notification, or null. */
export function streamNameOf(method: string): string | null {
  return method.startsWith("stream.") ? method.slice("stream.".length) : null;
}

// ─── Discrimination ───

export function isRpcFrame(value: unknown): value is RpcFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === JSONRPC_VERSION
  );
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    isRpcFrame(value) &&
    typeof (value as RpcRequest).method === "string" &&
    (value as RpcRequest).id !== undefined
  );
}

export function isRpcNotification(value: unknown): value is RpcNotification {
  return (
    isRpcFrame(value) &&
    typeof (value as RpcNotification).method === "string" &&
    (value as { id?: unknown }).id === undefined
  );
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isRpcFrame(value) &&
    (value as { method?: unknown }).method === undefined &&
    (value as { id?: unknown }).id !== undefined
  );
}

export function isRpcFailure(value: unknown): value is RpcFailure {
  return isRpcResponse(value) && (value as RpcFailure).error !== undefined;
}

// ─── Normalisation across both envelopes ───

export interface NormalizedRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
  /** True when the frame arrived in the legacy `{id,cmd,args}` shape. */
  legacy: boolean;
}

/**
 * Read a request frame in either envelope.
 *
 * Returns null for anything that is not a request — a response, a
 * notification, or junk — so a caller can log and drop it rather than
 * guessing at an id it does not have.
 */
export function toRequest(value: unknown): NormalizedRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc === JSONRPC_VERSION) {
    if (typeof v.method !== "string") return null;
    if (typeof v.id !== "number" && typeof v.id !== "string") return null;
    const params = typeof v.params === "object" && v.params !== null ? v.params : {};
    return { id: v.id, method: v.method, params: params as Record<string, unknown>, legacy: false };
  }
  if (typeof v.cmd === "string" && typeof v.id === "number") {
    const args = typeof v.args === "object" && v.args !== null ? v.args : {};
    return { id: v.id, method: v.cmd, params: args as Record<string, unknown>, legacy: true };
  }
  return null;
}

/** Build the response a request deserves, in the envelope it arrived in. */
export function toResponse(
  req: Pick<NormalizedRequest, "id" | "legacy">,
  outcome: { ok: true; result: unknown } | { ok: false; error: RpcError },
): RpcResponse | LegacyResponse {
  if (req.legacy) {
    return outcome.ok
      ? { id: req.id as number, ok: true, result: outcome.result }
      : { id: req.id as number, ok: false, error: outcome.error.message };
  }
  return outcome.ok
    ? rpcSuccess(req.id, outcome.result)
    : rpcFailure(req.id, outcome.error.code, outcome.error.message, outcome.error.data);
}

/** Read a response frame in either envelope. */
export function toResult(
  value: unknown,
):
  | { id: number | string; ok: true; result: unknown }
  | { id: number | string; ok: false; error: RpcError }
  | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc === JSONRPC_VERSION) {
    if (typeof v.id !== "number" && typeof v.id !== "string") return null;
    if (v.error !== undefined) {
      const e = v.error as Partial<RpcError>;
      return {
        id: v.id,
        ok: false,
        error: {
          code: Number(e.code ?? RPC_ERROR.internal),
          message: String(e.message ?? "error"),
          data: e.data,
        },
      };
    }
    return { id: v.id, ok: true, result: v.result };
  }
  if (typeof v.id === "number" && typeof v.ok === "boolean") {
    return v.ok
      ? { id: v.id, ok: true, result: v.result }
      : {
          id: v.id,
          ok: false,
          error: { code: RPC_ERROR.internal, message: String(v.error ?? "host error") },
        };
  }
  return null;
}

/** Read a stream push in either envelope. */
export function toStream(value: unknown): { stream: string; payload: unknown } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc === JSONRPC_VERSION && typeof v.method === "string" && v.id === undefined) {
    const name = streamNameOf(v.method);
    return name ? { stream: name, payload: v.params } : null;
  }
  if (typeof v.stream === "string") return { stream: v.stream, payload: v.payload };
  return null;
}

/** Serialize one frame as a protocol line (NDJSON: one object, one newline). */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * Parse one protocol line. Throws `ProtocolError(parse)` rather than the raw
 * `SyntaxError` so a transport can answer with a proper frame.
 */
export function decodeFrame(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new ProtocolError(RPC_ERROR.parse, `malformed protocol frame: ${String(err)}`);
  }
}

/** Type-level helper so a caller cannot invent a method name. */
export type MethodName = HostCommandName | (string & {});
