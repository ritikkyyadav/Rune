/**
 * Mid-stream failure integrity in LlmGateway.inferStream:
 *  - A provider that dies AFTER yielding partial events must emit stream_reset
 *    before the retry/fallback re-streams, so consumers drop the partial
 *    message instead of duplicating it.
 *  - A user abort mid-stream must stop dead — no retry ladder, no fallback.
 */

import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  InferenceRequest,
  LlmProvider,
  StreamEvent,
  StreamOpts,
} from "../../../packages/llm-gateway/src/types";

const REQ: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "m",
  provider: "anthropic",
  maxTokens: 100,
  stream: true,
};

function gatewayWith(...providers: LlmProvider[]): LlmGateway {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 2,
    retryBaseMs: 1,
    // The cross-provider case documents the substitute chain — the explicit
    // flex opt-in now that model integrity pins by default.
    modelIntegrity: "flex",
  });
  for (const p of providers) gw.registerProvider(p);
  return gw;
}

/** Provider that yields `partial` events then throws `err` on the first N calls, then streams `full`. */
function flakyProvider(
  name: string,
  opts: { failCalls: number; err: Error; partial: StreamEvent[]; full: StreamEvent[] },
): LlmProvider & { calls: number } {
  const p = {
    name: name as LlmProvider["name"],
    calls: 0,
    infer: async () => {
      throw new Error("not used");
    },
    inferStream: async function* (_req: InferenceRequest, _opts?: StreamOpts) {
      p.calls++;
      if (p.calls <= opts.failCalls) {
        for (const e of opts.partial) yield e;
        throw opts.err;
      }
      for (const e of opts.full) yield e;
    },
    countTokens: async () => 0,
    healthCheck: async () => true,
  };
  return p as unknown as LlmProvider & { calls: number };
}

const textDelta = (text: string): StreamEvent => ({
  type: "content_delta",
  contentIndex: 0,
  delta: { type: "text_delta", text },
});

const stop: StreamEvent = {
  type: "message_stop",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("gateway stream_reset on mid-stream failure", () => {
  test("same-provider retry after partial output emits stream_reset first", async () => {
    const err = Object.assign(new Error("upstream connect error"), { status: 529 });
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err,
      partial: [textDelta("partial that must be discarded")],
      full: [textDelta("clean full answer"), stop],
    });
    const gw = gatewayWith(provider);

    const events = await collect(gw.inferStream(REQ));
    const types = events.map((e) => e.type);

    const resetIdx = types.indexOf("stream_reset");
    expect(resetIdx).toBeGreaterThan(0); // after the partial delta
    // The re-streamed answer arrives after the reset.
    const lastDelta = events.findLastIndex((e) => e.type === "content_delta");
    expect(lastDelta).toBeGreaterThan(resetIdx);
    expect(types.at(-1)).toBe("message_stop");
    expect(provider.calls).toBe(2);
  });

  test("failure BEFORE any output retries without a reset", async () => {
    const err = Object.assign(new Error("boom"), { status: 500 });
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err,
      partial: [], // dies before yielding anything
      full: [textDelta("answer"), stop],
    });
    const gw = gatewayWith(provider);

    const events = await collect(gw.inferStream(REQ));
    expect(events.map((e) => e.type)).not.toContain("stream_reset");
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("cross-provider fallback after partial output emits stream_reset before the fallback event", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const dying = flakyProvider("anthropic", {
      failCalls: 99,
      err,
      partial: [textDelta("half an answer")],
      full: [],
    });
    const backup = flakyProvider("openai", {
      failCalls: 0,
      err,
      partial: [],
      full: [textDelta("backup answer"), stop],
    });
    const gw = gatewayWith(dying, backup);

    const events = await collect(gw.inferStream(REQ));
    const types = events.map((e) => e.type);
    const resetIdx = types.indexOf("stream_reset");
    const fallbackIdx = types.indexOf("fallback");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(resetIdx);
    expect(types.at(-1)).toBe("message_stop");
  });

  test("abort mid-stream stops dead — no retry, no fallback", async () => {
    const controller = new AbortController();
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    let calls = 0;
    const provider = {
      name: "anthropic",
      infer: async () => {
        throw new Error("not used");
      },
      inferStream: async function* (_req: InferenceRequest, opts?: StreamOpts) {
        calls++;
        yield textDelta("some");
        controller.abort();
        if (opts?.signal?.aborted) throw abortErr;
      },
      countTokens: async () => 0,
      healthCheck: async () => true,
    } as unknown as LlmProvider;
    const backup = flakyProvider("openai", {
      failCalls: 0,
      err: abortErr,
      partial: [],
      full: [textDelta("must never stream"), stop],
    });
    const gw = gatewayWith(provider, backup);

    await expect(collect(gw.inferStream(REQ, { signal: controller.signal }))).rejects.toThrow(
      "aborted",
    );
    expect(calls).toBe(1); // no retry of the aborted request
    expect((backup as unknown as { calls: number }).calls).toBe(0); // no fallback either
  });
});

/**
 * R2 of docs/program/rune-reliability-plan-20261014.md: a response that fails
 * after it FINISHED tool calls is not re-sent from zero when the caller can run
 * what was finished — the agent loop asks with `keepCompletedOnCut`.
 */
describe("a response cut after finished tool calls (keepCompletedOnCut)", () => {
  const callA: StreamEvent[] = [
    { type: "tool_use_start", toolCallId: "a", toolName: "read_file" },
    { type: "tool_use_stop", toolCallId: "a", toolInput: { path: "a.ts" } },
  ];
  const callBStarted: StreamEvent = {
    type: "tool_use_start",
    toolCallId: "b",
    toolName: "read_file",
  };
  const stall = Object.assign(new Error("stream stalled — no data for 120s"), { status: 504 });

  test("ends with message_cut after the finished call, and does not re-send", async () => {
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err: stall,
      partial: [...callA, callBStarted],
      full: [textDelta("a whole second answer"), stop],
    });
    const gw = gatewayWith(provider);

    const events = await collect(gw.inferStream(REQ, { keepCompletedOnCut: true }));
    const types = events.map((e) => e.type);

    expect(provider.calls).toBe(1);
    expect(types).not.toContain("stream_reset");
    expect(types).toContain("tool_use_stop");
    const cut = events.at(-1) as Extract<StreamEvent, { type: "message_cut" }>;
    expect(cut.type).toBe("message_cut");
    expect(cut.completedCalls).toBe(1);
    expect(cut.reason).toContain("stream stalled");
  });

  test("with nothing finished it re-sends from zero, as before", async () => {
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err: stall,
      partial: [textDelta("thinking out loud"), callBStarted],
      full: [textDelta("answer"), stop],
    });
    const gw = gatewayWith(provider);

    const events = await collect(gw.inferStream(REQ, { keepCompletedOnCut: true }));
    expect(provider.calls).toBe(2);
    expect(events.map((e) => e.type)).toContain("stream_reset");
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("a caller that did not ask keeps the re-send", async () => {
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err: stall,
      partial: [...callA, callBStarted],
      full: [textDelta("answer"), stop],
    });
    const gw = gatewayWith(provider);

    const events = await collect(gw.inferStream(REQ));
    expect(provider.calls).toBe(2);
    expect(events.map((e) => e.type)).not.toContain("message_cut");
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("a user abort is still an abort, finished calls or not", async () => {
    const controller = new AbortController();
    const provider = flakyProvider("anthropic", {
      failCalls: 1,
      err: new Error("aborted"),
      partial: [...callA],
      full: [],
    });
    const original = provider.inferStream;
    provider.inferStream = async function* (req: InferenceRequest, opts?: StreamOpts) {
      controller.abort();
      yield* original(req, opts);
    };
    const gw = gatewayWith(provider);

    await expect(
      collect(gw.inferStream(REQ, { keepCompletedOnCut: true, signal: controller.signal })),
    ).rejects.toThrow("aborted");
  });
});

describe("a kept cut is reported, never silent", () => {
  test("the black box hears of it as a cut, with the provider's status", async () => {
    const incidents: Array<{ kind: string; status?: number; message: string }> = [];
    const gw = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 2,
      retryBaseMs: 1,
      modelIntegrity: "flex",
      onIncident: (i) => incidents.push(i),
    });
    gw.registerProvider(
      flakyProvider("anthropic", {
        failCalls: 1,
        err: Object.assign(new Error("upstream closed the stream"), { status: 502 }),
        partial: [
          { type: "tool_use_start", toolCallId: "a", toolName: "read_file" },
          { type: "tool_use_stop", toolCallId: "a", toolInput: { path: "a.ts" } },
        ],
        full: [stop],
      }),
    );
    await collect(gw.inferStream(REQ, { keepCompletedOnCut: true }));
    const cut = incidents.find((i) => i.kind === "cut");
    expect(cut?.status).toBe(502);
    expect(cut?.message).toContain("1 finished tool call");
    expect(cut?.message).toContain("upstream closed the stream");
  });
});
