import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

// Drive the provider's streaming loop by stubbing the OpenAI SDK client with a fake async
// iterable of chunks — the same seam the real SDK exposes (`client.chat.completions.create`).
// This reproduces the production failure: glm/qwen on ollama.com/v1 streaming tool-call
// arguments that don't accumulate into valid JSON. Before the fix, the JSON.parse threw
// "Unable to parse JSON string", which killed the provider stream and cascaded the fallback.

function fakeStream(chunks: object[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function stubClient(provider: OpenAIProvider, chunks: object[]) {
  (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };
}

// ── chunk builders (avoid deep literal nesting) ──
const startToolCall = (index: number, id: string, name: string, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }],
});
const moreArgs = (index: number, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }],
});
const finish = () => ({
  choices: [{ delta: {}, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const toolStop = (events: StreamEvent[]) =>
  events.find((e) => e.type === "tool_use_stop") as
    Extract<StreamEvent, { type: "tool_use_stop" }> | undefined;

const req: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
  model: "glm-4.7",
  provider: "ollama-turbo",
  maxTokens: 256,
  stream: true,
};

describe("OpenAIProvider tool-arg parsing (regression: 'Unable to parse JSON string')", () => {
  test("malformed/truncated tool args degrade to {} instead of throwing", async () => {
    const provider = new OpenAIProvider("test-key");
    // args stream as `{"path":` + `"a.ts` — never closes into valid JSON
    stubClient(provider, [
      startToolCall(0, "call_1", "read_file", '{"path":'),
      moreArgs(0, '"a.ts'),
      finish(),
    ]);

    let events: StreamEvent[] = [];
    await expect(
      (async () => {
        events = await collect(provider.inferStream(req));
      })(),
    ).resolves.toBeUndefined(); // completed without throwing

    expect(toolStop(events)).toBeDefined();
    expect(toolStop(events)!.toolInput).toEqual({});
    expect(events.find((e) => e.type === "message_stop")).toBeDefined();
  });

  test("recovers real args when the JSON is salvageable (trailing junk)", async () => {
    const provider = new OpenAIProvider("test-key");
    stubClient(provider, [
      startToolCall(0, "call_2", "read_file", '{"path":"a.ts"} oops'),
      finish(),
    ]);

    const events = await collect(provider.inferStream(req));
    expect(toolStop(events)!.toolInput).toEqual({ path: "a.ts" });
  });

  test("well-formed args still parse normally", async () => {
    const provider = new OpenAIProvider("test-key");
    stubClient(provider, [
      startToolCall(0, "call_3", "read_file", '{"path":'),
      moreArgs(0, '"a.ts"}'),
      finish(),
    ]);

    const events = await collect(provider.inferStream(req));
    expect(toolStop(events)!.toolInput).toEqual({ path: "a.ts" });
  });
});
