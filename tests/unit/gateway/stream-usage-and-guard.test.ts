/**
 * Phase-1 regression tests: streamed usage reporting + the idle watchdog.
 *
 * Pre-fix behavior these pin against:
 *  - The OpenAI-family adapter never sent `stream_options: {include_usage}`,
 *    so every streamed response reported zero usage — the context engine
 *    never learned the real prompt size and compaction could not fire until
 *    the provider hard-rejected the request.
 *  - The per-chunk stall timer was armed and cleared inside the same loop
 *    iteration, so no timer ran while awaiting the next chunk — a wedged
 *    stream hung forever. (Anthropic/Google/Ollama/Codex had no timer at all.)
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import { IdleWatchdog } from "../../../packages/llm-gateway/src/providers/stream-guard";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SSE body in OpenAI chat-completions stream shape, usage on a TRAILING chunk. */
function sseBody(lines: object[]): string {
  return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
}

function fakeFetch(capture: { body?: any }, sse: string) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.body = JSON.parse(String(init?.body));
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function req(model = "gpt-4o"): InferenceRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    model,
    provider: "openai",
    maxTokens: 100,
    stream: true,
  };
}

const STREAM = sseBody([
  { id: "m1", choices: [{ delta: { content: "hel" }, finish_reason: null }] },
  { id: "m1", choices: [{ delta: { content: "lo" }, finish_reason: null }] },
  { id: "m1", choices: [{ delta: {}, finish_reason: "stop" }] },
  // include_usage delivers the totals on a trailing, choices-empty chunk.
  { id: "m1", choices: [], usage: { prompt_tokens: 123, completion_tokens: 7 } },
]);

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("OpenAI-family streamed usage", () => {
  test("requests include_usage and surface the trailing usage chunk on message_stop", async () => {
    const capture: { body?: any } = {};
    const p = new OpenAIProvider("k", "http://localhost:9/v1", "openai", {
      fetch: fakeFetch(capture, STREAM),
    });
    const events = await collect(p.inferStream(req()));

    expect(capture.body.stream_options).toEqual({ include_usage: true });
    const stops = events.filter((e) => e.type === "message_stop");
    expect(stops).toHaveLength(1);
    const stop = stops[0] as Extract<StreamEvent, { type: "message_stop" }>;
    expect(stop.usage.inputTokens).toBe(123);
    expect(stop.usage.outputTokens).toBe(7);
    expect(stop.stopReason).toBe("end_turn");
    // The answer text still streamed normally.
    const text = events
      .filter((e) => e.type === "content_delta")
      .map((e: any) => e.delta.text)
      .join("");
    expect(text).toBe("hello");
  });

  test("copilot (strict proxy) does NOT get stream_options", async () => {
    const capture: { body?: any } = {};
    const p = new OpenAIProvider("k", "http://localhost:9/v1", "copilot", {
      fetch: fakeFetch(capture, STREAM),
    });
    await collect(p.inferStream(req()));
    expect(capture.body.stream_options).toBeUndefined();
  });

  test("legacy hosts (usage on the finish chunk, no trailer) still report usage", async () => {
    const capture: { body?: any } = {};
    const legacy = sseBody([
      { id: "m1", choices: [{ delta: { content: "ok" }, finish_reason: null }] },
      {
        id: "m1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 55, completion_tokens: 2 },
      },
    ]);
    const p = new OpenAIProvider("k", "http://localhost:9/v1", "openrouter", {
      fetch: fakeFetch(capture, legacy),
    });
    const events = await collect(p.inferStream(req("some-model")));
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage.inputTokens).toBe(55);
  });
});

describe("IdleWatchdog", () => {
  test("fires after silence and reports a retryable 504", async () => {
    const guard = new IdleWatchdog("testprov", undefined, 30, 20);
    await sleep(70);
    expect(guard.signal.aborted).toBe(true);
    const err = guard.timeoutError();
    expect(err).not.toBeNull();
    expect(err!.status).toBe(504);
    expect(err!.message).toContain("stalled");
    guard.stop();
  });

  test("beats keep it alive while chunks flow", async () => {
    const guard = new IdleWatchdog("testprov", undefined, 50, 40);
    for (let i = 0; i < 5; i++) {
      await sleep(15);
      guard.beat();
    }
    expect(guard.signal.aborted).toBe(false);
    guard.stop();
  });

  test("a caller abort is NOT reported as a stall", async () => {
    const ctl = new AbortController();
    const guard = new IdleWatchdog("testprov", ctl.signal, 5_000, 5_000);
    ctl.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(guard.timeoutError()).toBeNull();
    guard.stop();
  });
});
