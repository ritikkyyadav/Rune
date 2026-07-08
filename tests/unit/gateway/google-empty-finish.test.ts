/**
 * Gemini streams that "succeed" with nothing in them must THROW, not end as a
 * normal stop. Live failure 2026-07-07: /interactive fell back to Gemini,
 * which answered MALFORMED_FUNCTION_CALL with zero parts; the loop rendered
 * nothing and the session ended silently — the worst possible UX.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { GoogleProvider } from "../../../packages/llm-gateway/src/providers/google";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockFetch(impl: () => Response) {
  globalThis.fetch = (async () => impl()) as typeof fetch;
}

function sse(chunks: object[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\n";
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const req = (): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "build a dashboard" }] }],
  model: "gemini-2.5-flash",
  provider: "google",
  maxTokens: 256,
  stream: true,
});

describe("GoogleProvider — unusable finish reasons throw instead of ending silently", () => {
  test("MALFORMED_FUNCTION_CALL with zero parts throws a retryable error", async () => {
    mockFetch(() =>
      sse([{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }]),
    );
    const p = new GoogleProvider("key");
    await expect(collect(p.inferStream(req()))).rejects.toThrow(/MALFORMED_FUNCTION_CALL/);
  });

  test("UNEXPECTED_TOOL_CALL with no delivered call throws", async () => {
    mockFetch(() => sse([{ candidates: [{ finishReason: "UNEXPECTED_TOOL_CALL" }] }]));
    const p = new GoogleProvider("key");
    await expect(collect(p.inferStream(req()))).rejects.toThrow(/no usable tool call/);
  });

  test("SAFETY block with no content throws with the reason", async () => {
    mockFetch(() => sse([{ candidates: [{ finishReason: "SAFETY" }] }]));
    const p = new GoogleProvider("key");
    await expect(collect(p.inferStream(req()))).rejects.toThrow(/SAFETY/);
  });

  test("MALFORMED after a REAL tool call does not throw (partial success stands)", async () => {
    mockFetch(() =>
      sse([
        {
          candidates: [
            {
              content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a" } } }] },
            },
          ],
        },
        { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] },
      ]),
    );
    const p = new GoogleProvider("key");
    const events = await collect(p.inferStream(req()));
    expect(events.some((e) => e.type === "tool_use_stop")).toBe(true);
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("SAFETY after partial text does not throw (text was delivered)", async () => {
    mockFetch(() =>
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] },
        { candidates: [{ finishReason: "SAFETY" }] },
      ]),
    );
    const p = new GoogleProvider("key");
    const events = await collect(p.inferStream(req()));
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("normal STOP with text still streams fine", async () => {
    mockFetch(() =>
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }] },
      ]),
    );
    const p = new GoogleProvider("key");
    const events = await collect(p.inferStream(req()));
    const stop = events.at(-1);
    expect(stop?.type).toBe("message_stop");
  });

  test("non-streaming infer() throws on MALFORMED too", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const p = new GoogleProvider("key");
    await expect(p.infer({ ...req(), stream: false })).rejects.toThrow(/MALFORMED_FUNCTION_CALL/);
  });
});
