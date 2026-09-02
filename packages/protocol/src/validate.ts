// ─── Inbound validators ───
//
// Hand-written rather than zod: the protocol package is a leaf with zero
// dependencies on purpose, so the desktop bundle and the SDK do not inherit a
// runtime schema library to read an event union.
//
// The posture is asymmetric and deliberately so. INBOUND commands are
// validated strictly — a client is untrusted, and `run_held_step` with a
// missing id must fail at the door, not three frames later inside the broker.
// OUTBOUND events are validated shallowly — the host is the only writer, and a
// client that rejected a frame because a newer host added an optional field
// would break the additive-minor contract in `version.ts`.

import { HOST_COMMANDS, type HostCommandName } from "./commands";
import { ProtocolError, RPC_ERROR } from "./envelope";

const COMMAND_SET: ReadonlySet<string> = new Set<string>(HOST_COMMANDS);

export function isHostCommand(name: unknown): name is HostCommandName {
  return typeof name === "string" && COMMAND_SET.has(name);
}

/** Throw `methodNotFound` unless `name` is a command this build serves. */
export function requireCommand(name: unknown): HostCommandName {
  if (!isHostCommand(name)) {
    throw new ProtocolError(RPC_ERROR.methodNotFound, `unknown command: ${String(name)}`);
  }
  return name;
}

function fail(message: string): never {
  throw new ProtocolError(RPC_ERROR.invalidParams, message);
}

/** A required non-empty string parameter. */
export function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) fail(`"${key}" must be a non-empty string`);
  return v;
}

/** An optional string parameter; undefined when absent or empty. */
export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  return v.length > 0 ? v : undefined;
}

/** An optional non-negative integer. */
export function optionalCount(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    fail(`"${key}" must be a non-negative number`);
  }
  return Math.floor(v);
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") fail(`"${key}" must be a boolean`);
  return v;
}

/** An optional array of non-empty strings. */
export function optionalStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
    fail(`"${key}" must be an array of non-empty strings`);
  }
  return v as string[];
}

const DECISIONS = new Set(["allow_once", "allow_session", "deny"]);

/** The permission decision, refusing anything outside the three legal kinds. */
export function requirePermissionDecision(
  params: Record<string, unknown>,
): "allow_once" | "allow_session" | "deny" {
  const v = params.decision;
  if (typeof v !== "string" || !DECISIONS.has(v)) {
    fail(`"decision" must be one of allow_once, allow_session, deny`);
  }
  return v as "allow_once" | "allow_session" | "deny";
}

/**
 * The brief decision. `edited` is passed through structurally rather than
 * field-checked: a brief the user corrected is theirs, and the ledger re-reads
 * it before any criterion can move.
 */
export function requireBriefDecision(params: Record<string, unknown>): {
  accepted: boolean;
  edited?: Record<string, unknown>;
  note?: string;
} {
  const raw = params.decision;
  if (typeof raw !== "object" || raw === null) fail(`"decision" must be an object`);
  const d = raw as Record<string, unknown>;
  if (typeof d.accepted !== "boolean") fail(`"decision.accepted" must be a boolean`);
  if (d.edited !== undefined && (typeof d.edited !== "object" || d.edited === null)) {
    fail(`"decision.edited" must be an object`);
  }
  if (d.note !== undefined && typeof d.note !== "string") fail(`"decision.note" must be a string`);
  return {
    accepted: d.accepted,
    edited: d.edited as Record<string, unknown> | undefined,
    note: d.note as string | undefined,
  };
}

/** A bearer token as it arrives on a `Sec-WebSocket-Protocol` header or query. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

/**
 * Constant-time string comparison for the bearer token.
 *
 * `===` on secrets leaks their length and prefix through timing. The cost here
 * is nanoseconds and the failure mode it removes is a token recovered one byte
 * at a time by a local process that can already reach the port.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
