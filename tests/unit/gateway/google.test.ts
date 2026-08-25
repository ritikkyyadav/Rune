import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GoogleProvider } from "../../../packages/llm-gateway/src/providers/google";
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

/** Build a Gemini SSE body: one `data: {json}` per chunk, blank-line separated. */
function sse(chunks: object[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\n";
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
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
  model: "gemini-2.5-flash",
  provider: "google",
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

describe("GoogleProvider", () => {
  test("streams text deltas and reports end_turn with usage", async () => {
    mockFetch(() =>
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }] },
        {
          candidates: [
            { content: { role: "model", parts: [{ text: " world" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      ]),
    );
    const events = await collect(new GoogleProvider("k").inferStream(baseReq()));
    const text = pick(events, "content_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("Hello world");
    const stop = pick(events, "message_stop")[0];
    expect(stop.stopReason).toBe("end_turn");
    expect(stop.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  // Regression: Gemini returns finishReason "STOP" even when it emits a function
  // call. The loop only executes tools when stopReason is "tool_use", so this
  // must not be reported as "end_turn" (the "stops after one command" bug).
  test("reports stopReason tool_use for a function call despite finishReason STOP", async () => {
    mockFetch(() =>
      sse([
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "list_dir", args: { path: "." } } }],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
    );
    const events = await collect(
      new GoogleProvider("k").inferStream(
        baseReq({
          tools: [{ name: "list_dir", description: "list", inputSchema: { type: "object" } }],
        }),
      ),
    );
    expect(pick(events, "tool_use_start")[0].toolName).toBe("list_dir");
    expect(pick(events, "tool_use_stop")[0].toolInput).toEqual({ path: "." });
    expect(pick(events, "message_stop")[0].stopReason).toBe("tool_use");
  });

  // Robustness: the finishReason can arrive in a later, parts-less chunk; the
  // tool-use signal must survive across chunks.
  test("reports tool_use when finishReason arrives in a separate final chunk", async () => {
    mockFetch(() =>
      sse([
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "grep", args: { pattern: "x" } } }],
              },
            },
          ],
        },
        {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
        },
      ]),
    );
    const events = await collect(
      new GoogleProvider("k").inferStream(
        baseReq({
          tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
        }),
      ),
    );
    expect(pick(events, "message_stop")[0].stopReason).toBe("tool_use");
  });

  // Regression: Gemini matches a functionResponse to its functionCall by name,
  // so a tool result must be serialized with the tool name, not our call id.
  test("serializes tool results with the tool name, not the call id", async () => {
    mockFetch(() =>
      sse([
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      ]),
    );
    await collect(
      new GoogleProvider("k").inferStream(
        baseReq({
          messages: [
            { role: "user", content: [{ type: "text", text: "list" }] },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  toolCallId: "google_tool_1_0",
                  toolName: "list_dir",
                  toolInput: { path: "." },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  toolCallId: "google_tool_1_0",
                  toolResultContent: "a.txt",
                  isError: false,
                },
              ],
            },
          ],
        }),
      ),
    );
    const body = JSON.parse(lastInit!.body as string) as {
      contents: { parts: { functionResponse?: { name: string } }[] }[];
    };
    const responses = body.contents
      .flatMap((c) => c.parts)
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse!.name);
    expect(responses).toEqual(["list_dir"]);
  });

  test("non-streaming infer reports tool_use for a function call", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "list_dir", args: {} } }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        ),
    );
    const res = await new GoogleProvider("k").infer(baseReq({ stream: false }));
    expect(res.stopReason).toBe("tool_use");
    expect(res.content[0]).toMatchObject({ type: "tool_use", toolName: "list_dir" });
  });

  // Regression: Gemini rejects the WHOLE request when a tool's parameter schema
  // carries JSON-Schema keywords its proto doesn't define ("Invalid JSON payload
  // received. Unknown name \"$schema\" … Cannot find field"). MCP and skill tools
  // routinely emit these, so the provider must prune schemas to Gemini's supported
  // subset — recursively — before sending.
  test("strips unsupported JSON-Schema keywords from tool parameters", async () => {
    mockFetch(() =>
      sse([
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      ]),
    );
    await collect(
      new GoogleProvider("k").inferStream(
        baseReq({
          tools: [
            {
              name: "messy",
              description: "tool authored as a full JSON Schema",
              inputSchema: {
                $schema: "http://json-schema.org/draft-07/schema#",
                $id: "https://example.com/messy",
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                  path: { type: "string", description: "a path", additionalProperties: false },
                  mode: { const: "fast" },
                  tags: { type: "array", items: { type: "string", $comment: "drop me" } },
                },
                oneOf: [{ required: ["path"] }],
              },
            },
          ],
        }),
      ),
    );
    const body = JSON.parse(lastInit!.body as string) as {
      tools: { functionDeclarations: { parameters: Record<string, any> }[] }[];
    };
    const params = body.tools[0].functionDeclarations[0].parameters;
    // No JSON-Schema-only keyword survives anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain("$schema");
    expect(JSON.stringify(body)).not.toContain("additionalProperties");
    expect(params.$id).toBeUndefined();
    expect(params.oneOf).toBeUndefined();
    // Supported structure is preserved, and recursion reaches nested schemas.
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["path"]);
    expect(params.properties.path).toEqual({ type: "string", description: "a path" });
    expect(params.properties.tags.items).toEqual({ type: "string" });
    // `const` is preserved as a single-value enum (Gemini has no `const`).
    expect(params.properties.mode).toEqual({ enum: ["fast"] });
  });
});
