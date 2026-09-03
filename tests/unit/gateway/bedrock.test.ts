/**
 * P10.5 — AWS Bedrock, proven against recorded request/response fixtures.
 *
 * There is no AWS credential on this machine, so nothing here talks to AWS.
 * What these tests pin is the part a live call could not tell you anyway: that
 * the request Gear BUILDS is the request Bedrock documents, and that a recorded
 * Bedrock response comes back through the shared Anthropic parser as ordinary
 * stream events. The live half is `tests/integration/enterprise-providers.test.ts`,
 * which skips with a printed reason unless GEAR_LIVE_BEDROCK=1.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  BedrockProvider,
  applyInferenceProfile,
  inferenceProfileFamily,
} from "../../../packages/llm-gateway/src/providers/bedrock";
import { encodeMessage } from "../../../packages/llm-gateway/src/providers/aws/event-stream";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const origFetch = globalThis.fetch;

/** Static credentials via rung 1 of the chain — no files, no network. */
const ENV: NodeJS.ProcessEnv = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "us-east-1",
};

let calls: { url: string; init: RequestInit }[] = [];

function mockFetch(respond: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
}

function bedrockChunk(event: object): Uint8Array {
  const inner = JSON.stringify(event);
  return encodeMessage({
    headers: { ":event-type": "chunk", ":message-type": "event" },
    payload: new TextEncoder().encode(
      JSON.stringify({ bytes: Buffer.from(inner, "utf-8").toString("base64") }),
    ),
  });
}

/** A recorded `invoke-model-with-response-stream` body for a one-word answer. */
function recordedStream(): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg_bedrock_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 17 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
  ].map(bedrockChunk);
  const total = frames.reduce((n, f) => n + f.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const f of frames) {
    body.set(f, at);
    at += f.length;
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  provider: "bedrock",
  maxTokens: 256,
  stream: true,
  system: "You are a test.",
  ...over,
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("inference-profile ids", () => {
  test("a region maps to its geography", () => {
    expect(inferenceProfileFamily("us-east-1")).toBe("us");
    expect(inferenceProfileFamily("eu-central-1")).toBe("eu");
    expect(inferenceProfileFamily("ap-northeast-1")).toBe("apac");
  });

  test("GovCloud and unknown regions get no prefix rather than a guessed one", () => {
    expect(inferenceProfileFamily("us-gov-west-1")).toBeUndefined();
    expect(inferenceProfileFamily("mars-north-1")).toBeUndefined();
  });

  test("a prefixed id follows the region", () => {
    expect(applyInferenceProfile("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "eu")).toBe(
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
  });

  test("a bare on-demand id is never given a prefix", () => {
    // Prefixing an on-demand foundation-model id turns a working call into a
    // "model not found" — which is why only already-prefixed ids are rewritten.
    expect(applyInferenceProfile("anthropic.claude-3-5-haiku-20241022-v1:0", "eu")).toBe(
      "anthropic.claude-3-5-haiku-20241022-v1:0",
    );
  });

  test("an ARN and the 'none' escape are both left alone", () => {
    const arn = "arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.x";
    expect(applyInferenceProfile(arn, "eu")).toBe(arn);
    expect(applyInferenceProfile("us.anthropic.x", "none")).toBe("us.anthropic.x");
  });
});

describe("the request Bedrock actually receives", () => {
  test("routes to invoke-with-response-stream with the model in the path", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    await collect(p.inferStream(request()));

    expect(calls).toHaveLength(1);
    const { url } = calls[0]!;
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/" +
        "us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream",
    );
  });

  test("moves `model` out of the body and `anthropic_version` in", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    await collect(p.inferStream(request()));

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    // Bedrock 400s on either of these: the path already says which model and
    // that the response streams.
    expect(body.model).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(body.max_tokens).toBe(256);
  });

  test("keeps the shared adapter's cache_control breakpoints", async () => {
    // The whole point of the variant: Bedrock inherits the Anthropic adapter's
    // caching, so the system block still carries the breakpoint that creates
    // the cache entry. A hand-written Bedrock body would have lost this.
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    await collect(p.inferStream(request()));

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      system?: { type: string; cache_control?: unknown }[];
    };
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("signs with SigV4 and sends no x-api-key", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    await collect(p.inferStream(request()));

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
    // The placeholder key the SDK requires must never reach the wire.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-api-key");
    expect(JSON.stringify(headers)).not.toContain("wJalrXUtnFEMI");
  });

  test("a session token is signed as x-amz-security-token", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: { ...ENV, AWS_SESSION_TOKEN: "TEMP" } });
    await collect(p.inferStream(request()));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-amz-security-token"]).toBe("TEMP");
    expect(headers.authorization).toContain("x-amz-security-token");
  });

  test("the configured region moves both the host and the profile prefix", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV, region: "eu-central-1" });
    await collect(p.inferStream(request()));
    expect(calls[0]!.url).toContain("bedrock-runtime.eu-central-1.amazonaws.com");
    expect(calls[0]!.url).toContain("eu.anthropic.claude-sonnet-4-5");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: expect.stringContaining("/eu-central-1/bedrock/"),
    });
  });

  test("an anthropic-beta header is translated into the body's anthropic_beta", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    await collect(
      p.inferStream(
        request({
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          thinking: { enabled: true, budgetTokens: 2000 },
          maxTokens: 8000,
          tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
        }),
      ),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as { anthropic_beta?: string[] };
    expect(body.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
  });
});

describe("the response Bedrock actually sends", () => {
  test("a recorded event-stream body streams through the Anthropic parser", async () => {
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({ env: ENV });
    const events = await collect(p.inferStream(request()));

    const text = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as { delta: { text: string } }).delta.text)
      .join("");
    expect(text).toBe("Hello there");

    const stop = events.find((e) => e.type === "message_stop") as
      { stopReason: string; usage: { inputTokens: number; cacheReadTokens?: number } } | undefined;
    expect(stop?.stopReason).toBe("end_turn");
    // Usage survives the framing round-trip, including the cache counter the
    // meter needs to report a hit rate rather than "no data".
    expect(stop?.usage.inputTokens).toBe(42);
    expect(stop?.usage.cacheReadTokens).toBe(17);
  });

  test("an AWS error body is re-shaped so the message is not empty", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "You don't have access to the model" }), {
          status: 403,
          headers: { "x-amzn-errortype": "AccessDeniedException:http://internal" },
        }),
    );
    const p = new BedrockProvider({ env: ENV });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(
      /You don't have access to the model/,
    );
  });

  test("no credential is a 401 that names the fix, not a stack trace", async () => {
    // The SDK re-raises a THROWN transport error as "Connection error." after
    // retrying it, which is why the adapter answers with a synthetic 401
    // instead: the actionable text survives and nothing is retried.
    mockFetch(() => recordedStream());
    const p = new BedrockProvider({
      env: { AWS_REGION: "us-east-1" },
      // Empty shared files: the profile rung finds nothing either.
      readFileImpl: async () => "",
    });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(/aws configure/);
    expect(calls).toHaveLength(0);
  });
});

describe("the endpoints Bedrock does not have", () => {
  test("countTokens estimates locally instead of calling a 404", async () => {
    mockFetch(() => new Response("{}", { status: 404 }));
    const p = new BedrockProvider({ env: ENV });
    const n = await p.countTokens([
      { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
    ]);
    expect(n).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  test("healthCheck asks the credential chain, and never spends a completion", async () => {
    mockFetch(() => recordedStream());
    expect(await new BedrockProvider({ env: ENV }).healthCheck()).toBe(true);
    expect(await new BedrockProvider({ env: {}, readFileImpl: async () => "" }).healthCheck()).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("live model discovery", () => {
  test("lists Anthropic foundation models from the control plane", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            modelSummaries: [
              {
                modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
                modelName: "Claude 3.5 Haiku",
                inferenceTypesSupported: ["ON_DEMAND"],
                responseStreamingSupported: true,
              },
              {
                modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
                modelName: "Claude Sonnet 4.5",
                inferenceTypesSupported: ["INFERENCE_PROFILE"],
                responseStreamingSupported: true,
              },
              {
                modelId: "anthropic.claude-embed-v1:0",
                modelName: "Embed",
                responseStreamingSupported: false,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const models = await new BedrockProvider({ env: ENV }).listModels();

    expect(calls[0]!.url).toContain("https://bedrock.us-east-1.amazonaws.com/foundation-models");
    expect(calls[0]!.url).toContain("byProvider=Anthropic");
    expect(models.map((m) => m.id)).toEqual([
      // On-demand: invokable as-is.
      "anthropic.claude-3-5-haiku-20241022-v1:0",
      // Profile-only: returned WITH the region's prefix, so picking it works.
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]);
    expect(models.every((m) => m.live)).toBe(true);
  });
});
