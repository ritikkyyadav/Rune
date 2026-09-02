/**
 * The envelope, both dialects.
 *
 * The host has spoken `{"id","cmd","args"}` / `{"id","ok","result"}` /
 * `{"stream","payload"}` since the desktop sidecar shipped. Phase 2 gives it a
 * real JSON-RPC 2.0 envelope WITHOUT breaking that contract, because a desktop
 * binary already in someone's Applications folder must keep working against a
 * host it did not ship with.
 *
 * So the rule under test is: both dialects are read, and a response goes back
 * in the dialect its request arrived in. A host that answered JSON-RPC to a
 * legacy request would silently strand every existing client.
 */

import { describe, expect, test } from "bun:test";

import {
  JSONRPC_VERSION,
  ProtocolError,
  RPC_ERROR,
  decodeFrame,
  encodeFrame,
  isRpcFailure,
  isRpcNotification,
  isRpcRequest,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
  streamNameOf,
  streamNotification,
  toRequest,
  toResponse,
  toResult,
  toStream,
} from "../../../packages/protocol/src/index";
import {
  isWellFormedToken,
  requireBriefDecision,
  requireCommand,
  requirePermissionDecision,
  requireString,
  optionalCount,
  timingSafeEqual,
} from "../../../packages/protocol/src/validate";

describe("reading a request in either dialect", () => {
  test("JSON-RPC 2.0", () => {
    const req = toRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "get_status",
      params: { sessionId: "s1" },
    });
    expect(req).toEqual({
      id: 7,
      method: "get_status",
      params: { sessionId: "s1" },
      legacy: false,
    });
  });

  test("the legacy sidecar shape", () => {
    const req = toRequest({ id: 7, cmd: "get_status", args: { sessionId: "s1" } });
    expect(req).toEqual({ id: 7, method: "get_status", params: { sessionId: "s1" }, legacy: true });
  });

  test("params and args are optional", () => {
    expect(toRequest({ jsonrpc: "2.0", id: 1, method: "list_sessions" })?.params).toEqual({});
    expect(toRequest({ id: 1, cmd: "list_sessions" })?.params).toEqual({});
  });

  test("anything that is not a request reads as null", () => {
    expect(toRequest({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
    expect(toRequest({ stream: "chat_event", payload: {} })).toBeNull();
    expect(toRequest({ id: "not-a-number", cmd: "x" })).toBeNull();
    expect(toRequest("hello")).toBeNull();
    expect(toRequest(null)).toBeNull();
  });
});

describe("a response goes back in the dialect it came in", () => {
  test("legacy request gets a legacy response", () => {
    const req = toRequest({ id: 3, cmd: "create_session" })!;
    expect(toResponse(req, { ok: true, result: "sess-1" })).toEqual({
      id: 3,
      ok: true,
      result: "sess-1",
    });
    expect(
      toResponse(req, { ok: false, error: { code: RPC_ERROR.internal, message: "boom" } }),
    ).toEqual({
      id: 3,
      ok: false,
      error: "boom",
    });
  });

  test("JSON-RPC request gets a JSON-RPC response", () => {
    const req = toRequest({ jsonrpc: "2.0", id: "abc", method: "create_session" })!;
    expect(toResponse(req, { ok: true, result: "sess-1" })).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      result: "sess-1",
    });
    const failed = toResponse(req, {
      ok: false,
      error: { code: RPC_ERROR.unauthorized, message: "no token" },
    });
    expect(failed).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: RPC_ERROR.unauthorized, message: "no token" },
    });
  });
});

describe("reading a result in either dialect", () => {
  test("JSON-RPC success and failure", () => {
    expect(toResult(rpcSuccess(1, { ok: 1 }))).toEqual({ id: 1, ok: true, result: { ok: 1 } });
    const failure = toResult(rpcFailure(1, RPC_ERROR.forbidden, "nope"));
    expect(failure).toMatchObject({ id: 1, ok: false });
    expect((failure as { error: { code: number } }).error.code).toBe(RPC_ERROR.forbidden);
  });

  test("legacy success and failure", () => {
    expect(toResult({ id: 2, ok: true, result: 5 })).toEqual({ id: 2, ok: true, result: 5 });
    const failure = toResult({ id: 2, ok: false, error: "bad" });
    expect(failure).toMatchObject({ id: 2, ok: false });
    expect((failure as { error: { message: string } }).error.message).toBe("bad");
  });

  test("a stream frame is not a result", () => {
    expect(toResult({ stream: "chat_event", payload: {} })).toBeNull();
  });
});

describe("streams", () => {
  test("legacy stream frames still read", () => {
    expect(toStream({ stream: "chat_event", payload: { a: 1 } })).toEqual({
      stream: "chat_event",
      payload: { a: 1 },
    });
  });

  test("JSON-RPC notifications carry the stream under stream.<name>", () => {
    const frame = streamNotification("chat_event", { event: { type: "text_delta", text: "hi" } });
    expect(frame.method).toBe("stream.chat_event");
    expect(isRpcNotification(frame)).toBe(true);
    expect(isRpcRequest(frame)).toBe(false);
    expect(toStream(frame)).toEqual({
      stream: "chat_event",
      payload: { event: { type: "text_delta", text: "hi" } },
    });
  });

  test("a non-stream notification is not a stream", () => {
    expect(streamNameOf("some.other.method")).toBeNull();
    expect(toStream({ jsonrpc: JSONRPC_VERSION, method: "ping", params: {} })).toBeNull();
  });
});

describe("framing", () => {
  test("encode appends exactly one newline", () => {
    const line = encodeFrame(rpcRequest(1, "get_status"));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  test("a torn frame raises a protocol parse error, not a bare SyntaxError", () => {
    expect(() => decodeFrame('{"jsonrpc":"2.0",')).toThrow(ProtocolError);
    try {
      decodeFrame("not json");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(RPC_ERROR.parse);
    }
  });

  test("round-trips", () => {
    const original = rpcRequest(9, "chat_start", { message: "hi" });
    expect(decodeFrame(encodeFrame(original))).toEqual(original);
  });
});

describe("inbound validation is strict — a client is untrusted", () => {
  test("unknown commands are methodNotFound, not a 500", () => {
    expect(() => requireCommand("rm_rf")).toThrow(ProtocolError);
    try {
      requireCommand("rm_rf");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(RPC_ERROR.methodNotFound);
    }
    expect(requireCommand("chat_start")).toBe("chat_start");
  });

  test("required strings must be present and non-empty", () => {
    expect(requireString({ sessionId: "s" }, "sessionId")).toBe("s");
    expect(() => requireString({ sessionId: "" }, "sessionId")).toThrow(/non-empty string/);
    expect(() => requireString({}, "sessionId")).toThrow(/non-empty string/);
    expect(() => requireString({ sessionId: 4 }, "sessionId")).toThrow(/non-empty string/);
  });

  test("a permission decision outside the three legal kinds is refused", () => {
    expect(requirePermissionDecision({ decision: "deny" })).toBe("deny");
    expect(requirePermissionDecision({ decision: "allow_session" })).toBe("allow_session");
    // The one that matters: a client must not be able to invent an approval.
    expect(() => requirePermissionDecision({ decision: "allow_forever" })).toThrow(ProtocolError);
    expect(() => requirePermissionDecision({ decision: true })).toThrow(ProtocolError);
    expect(() => requirePermissionDecision({})).toThrow(ProtocolError);
  });

  test("a brief decision needs an explicit accepted flag", () => {
    expect(requireBriefDecision({ decision: { accepted: true } })).toEqual({
      accepted: true,
      edited: undefined,
      note: undefined,
    });
    expect(() => requireBriefDecision({ decision: {} })).toThrow(/accepted/);
    expect(() => requireBriefDecision({ decision: "yes" })).toThrow(/object/);
  });

  test("counts must be non-negative numbers", () => {
    expect(optionalCount({ sinceSeq: 12 }, "sinceSeq")).toBe(12);
    expect(optionalCount({}, "sinceSeq")).toBeUndefined();
    expect(() => optionalCount({ sinceSeq: -1 }, "sinceSeq")).toThrow(ProtocolError);
    expect(() => optionalCount({ sinceSeq: "3" }, "sinceSeq")).toThrow(ProtocolError);
  });
});

describe("bearer tokens", () => {
  test("well-formed means url-safe and long enough to be a secret", () => {
    expect(isWellFormedToken("a".repeat(43))).toBe(true);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken("has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });

  test("comparison does not short-circuit on the first differing byte", () => {
    expect(timingSafeEqual("abcdef", "abcdef")).toBe(true);
    expect(timingSafeEqual("abcdef", "abcdeg")).toBe(false);
    expect(timingSafeEqual("abcdef", "abc")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("failure frames", () => {
  test("carry a code a client can branch on", () => {
    const f = rpcFailure(null, RPC_ERROR.unauthorized, "missing bearer token");
    expect(isRpcFailure(f)).toBe(true);
    expect(f.error.code).toBe(RPC_ERROR.unauthorized);
    expect(f.id).toBeNull();
  });

  test("ProtocolError converts to a wire error", () => {
    const err = new ProtocolError(RPC_ERROR.busy, "a turn is already in progress", {
      sessionId: "s",
    });
    expect(err.toRpcError()).toEqual({
      code: RPC_ERROR.busy,
      message: "a turn is already in progress",
      data: { sessionId: "s" },
    });
  });
});
