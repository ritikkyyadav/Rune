import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OllamaProvider } from "../../../packages/llm-gateway/src/providers/ollama";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const origFetch = globalThis.fetch;
let lastInit: RequestInit | undefined;
let lastUrl: string | undefined;

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    lastUrl = String(input);
    lastInit = init;
    return impl(lastUrl, init);
  }) as typeof fetch;
}

function ndjson(chunks: object[]): Response {
  const text = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function pick<T extends StreamEvent["type"]>(
  events: StreamEvent[],
  t: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === t);
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const baseReq = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "llama3",
  provider: "ollama",
  maxTokens: 256,
  stream: true,
  ...over,
});

beforeEach(() => {
  lastInit = undefined;
  lastUrl = undefined;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("OllamaProvider", () => {
  test("name is ollama", () => {
    expect(new OllamaProvider().name).toBe("ollama");
  });

  test("normalizes a scheme-less base URL", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    await new OllamaProvider("127.0.0.1:11434").healthCheck();
    expect(lastUrl).toBe("http://127.0.0.1:11434/api/tags");
  });

  test("streams text deltas and final usage", async () => {
    mockFetch(() =>
      ndjson([
        { message: { role: "assistant", content: "Hello" }, done: false },
        {
          message: { role: "assistant", content: " world" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 5,
          eval_count: 2,
        },
      ]),
    );
    const events = await collect(new OllamaProvider().inferStream(baseReq()));
    const text = pick(events, "content_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("Hello world");
    const stop = pick(events, "message_stop")[0];
    expect(stop.stopReason).toBe("end_turn");
    expect(stop.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  test("streams a tool call and reports stopReason tool_use", async () => {
    mockFetch(() =>
      ndjson([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "grep", arguments: { pattern: "x" } } }],
          },
          done: true,
          done_reason: "stop",
        },
      ]),
    );
    const events = await collect(
      new OllamaProvider().inferStream(
        baseReq({
          tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
        }),
      ),
    );
    expect(pick(events, "tool_use_start")[0].toolName).toBe("grep");
    expect(pick(events, "tool_use_stop")[0].toolInput).toEqual({ pattern: "x" });
    expect(pick(events, "message_stop")[0].stopReason).toBe("tool_use");

    const body = JSON.parse(lastInit!.body as string);
    expect(body.tools[0].function.name).toBe("grep");
    expect(body.stream).toBe(true);
  });

  test("sends system prompt and maps roles in the request body", async () => {
    mockFetch(() => ndjson([{ message: { role: "assistant", content: "ok" }, done: true }]));
    await collect(new OllamaProvider().inferStream(baseReq({ system: "You are Rune." })));
    const body = JSON.parse(lastInit!.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are Rune." });
    expect(body.messages[1].role).toBe("user");
  });

  test("non-streaming infer returns content and usage", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            message: { role: "assistant", content: "answer" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 3,
            eval_count: 4,
          }),
          { status: 200 },
        ),
    );
    const res = await new OllamaProvider().infer(baseReq({ stream: false }));
    expect(res.content).toEqual([{ type: "text", text: "answer" }]);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(res.stopReason).toBe("end_turn");
  });

  test("throws on a non-ok response", async () => {
    mockFetch(() => new Response("model not found", { status: 404 }));
    await expect(collect(new OllamaProvider().inferStream(baseReq()))).rejects.toThrow();
  });

  test("healthCheck: true when reachable, false when it throws", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    expect(await new OllamaProvider().healthCheck()).toBe(true);
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await new OllamaProvider().healthCheck()).toBe(false);
  });
});
