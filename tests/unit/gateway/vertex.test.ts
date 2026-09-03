/**
 * P10.5 — Google Vertex AI, proven against recorded request/response fixtures.
 *
 * No GCP credential exists on this machine, so nothing here talks to Google.
 * What is pinned is the routing decision (which publisher serves which model
 * id), the URL and body each half builds, and that a recorded response comes
 * back through the SHARED adapters unchanged. The live half is
 * `tests/integration/enterprise-providers.test.ts` behind GEAR_LIVE_VERTEX=1.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  VertexProvider,
  vertexHost,
  vertexPublisher,
  vertexPublisherPath,
} from "../../../packages/llm-gateway/src/providers/vertex";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const origFetch = globalThis.fetch;

/** A service-account-free environment: the token comes from the metadata rung. */
const ENV: NodeJS.ProcessEnv = {
  GOOGLE_CLOUD_PROJECT: "gear-test-project",
  GOOGLE_CLOUD_LOCATION: "us-east5",
};

let calls: { url: string; init: RequestInit }[] = [];

function mockFetch(respond: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    // The ADC metadata rung, so every test has a token without a key file.
    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "ya29.vertex", expires_in: 3599 }), {
        status: 200,
      });
    }
    return respond(url, init ?? {});
  }) as typeof fetch;
}

/** Anthropic-on-Vertex answers plain SSE — no framing to decode. */
function anthropicSse(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_vertex_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 31, output_tokens: 0, cache_read_input_tokens: 9 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Gemini-on-Vertex answers the same SSE shape AI Studio does. */
function geminiSse(): Response {
  const chunks = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Hallo" }] } }] },
    {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 },
    },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "claude-sonnet-4-5@20250929",
  provider: "vertex",
  maxTokens: 128,
  stream: true,
  system: "You are a test.",
  ...over,
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** The request that is not the ADC metadata probe. */
function apiCall() {
  return calls.find((c) => !c.url.includes("metadata.google.internal"))!;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("publisher routing", () => {
  test("claude ids go to Anthropic, gemini ids to Google", () => {
    expect(vertexPublisher("claude-sonnet-4-5@20250929")).toBe("anthropic");
    expect(vertexPublisher("gemini-2.5-pro")).toBe("google");
  });

  test("an unknown id routes nowhere rather than guessing", () => {
    // Guessing "Gemini, probably" sends it to an endpoint that 404s with a
    // message about the wrong publisher. Naming the real problem is cheaper.
    expect(vertexPublisher("llama-3.3-70b")).toBeUndefined();
  });

  test("an unroutable model raises a 404 that says how routing works", async () => {
    mockFetch(() => anthropicSse());
    const p = new VertexProvider({ env: ENV });
    await expect(collect(p.inferStream(request({ model: "llama-3.3-70b" })))).rejects.toThrow(
      /no publisher for "llama-3\.3-70b"/,
    );
  });
});

describe("endpoints", () => {
  test("a region gets its own host; `global` has none", () => {
    expect(vertexHost("us-east5")).toBe("https://us-east5-aiplatform.googleapis.com");
    expect(vertexHost("europe-west4")).toBe("https://europe-west4-aiplatform.googleapis.com");
    expect(vertexHost("global")).toBe("https://aiplatform.googleapis.com");
  });

  test("the publisher path carries the project and location", () => {
    expect(vertexPublisherPath("p", "us-east5", "anthropic")).toBe(
      "/v1/projects/p/locations/us-east5/publishers/anthropic",
    );
  });
});

describe("the Anthropic half", () => {
  test("routes to streamRawPredict under the anthropic publisher", async () => {
    mockFetch(() => anthropicSse());
    await collect(new VertexProvider({ env: ENV }).inferStream(request()));
    expect(apiCall().url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/gear-test-project" +
        "/locations/us-east5/publishers/anthropic/models/" +
        "claude-sonnet-4-5%4020250929:streamRawPredict",
    );
  });

  test("moves `model` out of the body and the Vertex anthropic_version in", async () => {
    mockFetch(() => anthropicSse());
    await collect(new VertexProvider({ env: ENV }).inferStream(request()));
    const body = JSON.parse(String(apiCall().init.body)) as Record<string, unknown>;
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.model).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  test("keeps the shared adapter's cache_control breakpoints", async () => {
    mockFetch(() => anthropicSse());
    await collect(new VertexProvider({ env: ENV }).inferStream(request()));
    const body = JSON.parse(String(apiCall().init.body)) as {
      system?: { cache_control?: unknown }[];
    };
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("authenticates with a bearer token and never a query key", async () => {
    mockFetch(() => anthropicSse());
    await collect(new VertexProvider({ env: ENV }).inferStream(request()));
    const headers = apiCall().init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ya29.vertex");
    // A token in a query string ends up in every access log on the way.
    expect(apiCall().url).not.toContain("key=");
    expect(apiCall().url).not.toContain("ya29");
  });

  test("a recorded SSE response streams through the Anthropic parser", async () => {
    mockFetch(() => anthropicSse());
    const events = await collect(new VertexProvider({ env: ENV }).inferStream(request()));
    const text = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as { delta: { text: string } }).delta.text)
      .join("");
    expect(text).toBe("Bonjour");
    const stop = events.find((e) => e.type === "message_stop") as
      { usage: { inputTokens: number; cacheReadTokens?: number } } | undefined;
    expect(stop?.usage.inputTokens).toBe(31);
    expect(stop?.usage.cacheReadTokens).toBe(9);
  });

  test("a Google API error keeps its message", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Permission denied on resource project gear-test-project.",
              status: "PERMISSION_DENIED",
            },
          }),
          { status: 403 },
        ),
    );
    await expect(collect(new VertexProvider({ env: ENV }).inferStream(request()))).rejects.toThrow(
      /Permission denied on resource project/,
    );
  });
});

describe("the Gemini half", () => {
  test("routes to streamGenerateContent under the google publisher", async () => {
    mockFetch(() => geminiSse());
    await collect(
      new VertexProvider({ env: ENV }).inferStream(request({ model: "gemini-2.5-flash" })),
    );
    expect(apiCall().url).toContain(
      "/v1/projects/gear-test-project/locations/us-east5/publishers/google/models/" +
        "gemini-2.5-flash:streamGenerateContent",
    );
    expect(apiCall().url).toContain("alt=sse");
  });

  test("authenticates with a bearer token instead of ?key=", async () => {
    mockFetch(() => geminiSse());
    await collect(
      new VertexProvider({ env: ENV }).inferStream(request({ model: "gemini-2.5-flash" })),
    );
    expect((apiCall().init.headers as Record<string, string>).authorization).toBe(
      "Bearer ya29.vertex",
    );
    expect(apiCall().url).not.toContain("key=");
  });

  test("a recorded response streams through the Google parser", async () => {
    mockFetch(() => geminiSse());
    const events = await collect(
      new VertexProvider({ env: ENV }).inferStream(request({ model: "gemini-2.5-flash" })),
    );
    const text = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as { delta: { text: string } }).delta.text)
      .join("");
    expect(text).toBe("Hallo");
  });

  test("`global` moves both halves to the location-free host", async () => {
    mockFetch(() => geminiSse());
    await collect(
      new VertexProvider({ env: ENV, location: "global" }).inferStream(
        request({ model: "gemini-2.5-flash" }),
      ),
    );
    expect(apiCall().url.startsWith("https://aiplatform.googleapis.com/")).toBe(true);
    expect(apiCall().url).toContain("/locations/global/");
  });
});

describe("the failures a user actually meets", () => {
  test("no credential is a 401 that names the gcloud command", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const p = new VertexProvider({
      env: ENV,
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(
      /gcloud auth application-default login/,
    );
  });

  test("no project is a 400 that names the setting, not an opaque Google error", async () => {
    // Vertex's own answer to a projectless URL is a 404 about a malformed
    // resource name, which sends people looking in the wrong place.
    mockFetch(() => anthropicSse());
    const p = new VertexProvider({ env: { GOOGLE_CLOUD_LOCATION: "us-east5" } });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  test("healthCheck needs both a project and a token, and spends nothing", async () => {
    mockFetch(() => anthropicSse());
    expect(await new VertexProvider({ env: ENV }).healthCheck()).toBe(true);
    expect(
      await new VertexProvider({ env: { GOOGLE_CLOUD_LOCATION: "us-east5" } }).healthCheck(),
    ).toBe(false);
    // Only metadata-token probes; no inference.
    expect(calls.every((c) => c.url.includes("metadata.google.internal"))).toBe(true);
  });

  test("countTokens estimates locally rather than calling an endpoint that is not there", async () => {
    mockFetch(() => new Response("{}", { status: 404 }));
    const n = await new VertexProvider({ env: ENV }).countTokens([
      { role: "user", content: [{ type: "text", text: "x".repeat(200) }] },
    ]);
    expect(n).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});

describe("live model discovery", () => {
  test("lists both publishers, with @version on the Anthropic ids", async () => {
    mockFetch((url) => {
      if (url.includes("/publishers/anthropic/models")) {
        return new Response(
          JSON.stringify({
            publisherModels: [
              { name: "publishers/anthropic/models/claude-sonnet-4-5", versionId: "20250929" },
              { name: "publishers/anthropic/models/claude-haiku-4-5", versionId: "20251001" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/publishers/google/models")) {
        return new Response(
          JSON.stringify({
            publisherModels: [{ name: "publishers/google/models/gemini-2.5-pro" }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const models = await new VertexProvider({ env: ENV }).listModels();
    expect(models.map((m) => m.id)).toEqual([
      // Anthropic ids are only invokable WITH the version suffix.
      "claude-sonnet-4-5@20250929",
      "claude-haiku-4-5@20251001",
      // Gemini ids are not.
      "gemini-2.5-pro",
    ]);
  });

  test("discovery without a credential raises rather than returning an empty list", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const p = new VertexProvider({
      env: ENV,
      readFileImpl: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(p.listModels()).rejects.toThrow(/gcloud auth application-default login/);
  });
});
