/**
 * P10.5 — Azure OpenAI, proven against recorded request/response fixtures.
 *
 * No Azure resource exists on this machine. What is pinned is deployment-name
 * routing (the one thing Azure does differently), the api-version, the two
 * credential headers, and that a recorded response comes back through the
 * SHARED OpenAI adapter unchanged. Live half: RUNE_LIVE_AZURE_OPENAI=1.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  AzureOpenAIProvider,
  azureDeploymentFor,
  azureUrl,
  normalizeAzureEndpoint,
  DEFAULT_AZURE_API_VERSION,
} from "../../../packages/llm-gateway/src/providers/azure-openai";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";

const origFetch = globalThis.fetch;

const ENV: NodeJS.ProcessEnv = {
  AZURE_OPENAI_ENDPOINT: "https://my-resource.openai.azure.com",
  AZURE_OPENAI_API_KEY: "azure-resource-key",
};

let calls: { url: string; init: RequestInit }[] = [];

function mockFetch(respond: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
}

/** A recorded Azure chat-completions stream — the OpenAI SSE shape, unchanged. */
function recordedStream(): Response {
  const chunks = [
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: " there" } }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      id: "c1",
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 16 },
      },
    },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-4o",
  provider: "azure-openai",
  maxTokens: 64,
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

describe("endpoint normalization", () => {
  test("a trailing slash is dropped", () => {
    expect(normalizeAzureEndpoint("https://r.openai.azure.com/")).toBe(
      "https://r.openai.azure.com",
    );
  });

  test("a full URL pasted from the portal is reduced to its origin", () => {
    // Otherwise the rewrite doubles `/openai` and every call 404s on a path
    // nobody typed.
    expect(
      normalizeAzureEndpoint(
        "https://r.openai.azure.com/openai/deployments/x/chat/completions?api-version=2024-10-21",
      ),
    ).toBe("https://r.openai.azure.com");
  });
});

describe("deployment mapping", () => {
  test("defaults to the model id, which is what Azure's portal names a deployment", () => {
    expect(azureDeploymentFor("gpt-4o", undefined)).toBe("gpt-4o");
    expect(azureDeploymentFor("gpt-4o", {})).toBe("gpt-4o");
  });

  test("a configured mapping wins", () => {
    expect(azureDeploymentFor("gpt-4o", { "gpt-4o": "prod-chat" })).toBe("prod-chat");
  });

  test("an unmapped id still resolves, so a partial map is usable", () => {
    expect(azureDeploymentFor("o3", { "gpt-4o": "prod-chat" })).toBe("o3");
  });
});

describe("URL rewriting", () => {
  const t = { endpoint: "https://r.openai.azure.com", apiVersion: "2024-10-21" };

  test("chat completions go under the deployment", () => {
    expect(azureUrl(t, "/v1/chat/completions", "prod-chat")).toBe(
      "https://r.openai.azure.com/openai/deployments/prod-chat/chat/completions" +
        "?api-version=2024-10-21",
    );
  });

  test("the model listing is per resource, not per deployment", () => {
    expect(azureUrl(t, "/v1/models", "prod-chat")).toBe(
      "https://r.openai.azure.com/openai/models?api-version=2024-10-21",
    );
  });

  test("a deployment name with a space is encoded", () => {
    expect(azureUrl(t, "/v1/chat/completions", "prod chat")).toContain(
      "/deployments/prod%20chat/chat/completions",
    );
  });
});

describe("the request Azure actually receives", () => {
  test("routes to the deployment path with the api-version", async () => {
    mockFetch(() => recordedStream());
    const p = new AzureOpenAIProvider({ env: ENV, deployments: { "gpt-4o": "prod-chat" } });
    await collect(p.inferStream(request()));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/prod-chat/chat/completions" +
        `?api-version=${DEFAULT_AZURE_API_VERSION}`,
    );
  });

  test("the api-version default is a GA version, and config overrides it", async () => {
    // A preview default is withdrawn on a schedule and breaks every user at
    // once — the same rot this repo has been bitten by on model ids.
    expect(DEFAULT_AZURE_API_VERSION).not.toContain("preview");
    mockFetch(() => recordedStream());
    await collect(
      new AzureOpenAIProvider({ env: ENV, apiVersion: "2025-01-01-preview" }).inferStream(
        request(),
      ),
    );
    expect(calls[0]!.url).toContain("api-version=2025-01-01-preview");
  });

  test("the body's model carries the deployment name, matching the path", async () => {
    mockFetch(() => recordedStream());
    await collect(
      new AzureOpenAIProvider({
        env: ENV,
        deployments: { "gpt-4o": "prod-chat" },
      }).inferStream(request()),
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as { model?: string };
    expect(body.model).toBe("prod-chat");
  });

  test("authenticates with the api-key header and drops the SDK's placeholder", async () => {
    mockFetch(() => recordedStream());
    await collect(new AzureOpenAIProvider({ env: ENV }).inferStream(request()));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("azure-resource-key");
    // Two credentials, one of them fake, is how a request gets rejected for a
    // reason nobody can find.
    expect(headers.authorization).toBeUndefined();
  });

  test("an Entra token authenticates as a bearer instead", async () => {
    mockFetch(() => recordedStream());
    await collect(
      new AzureOpenAIProvider({
        env: {
          AZURE_OPENAI_ENDPOINT: ENV.AZURE_OPENAI_ENDPOINT,
          AZURE_OPENAI_AD_TOKEN: "entra-token",
        },
      }).inferStream(request()),
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer entra-token");
    expect(headers["api-key"]).toBeUndefined();
  });

  test("keeps the shared adapter's prompt_cache_key routing hint", async () => {
    // The point of the variant: Azure inherits every OpenAI translation,
    // including the field that keeps same-prefix requests on one machine.
    mockFetch(() => recordedStream());
    await collect(new AzureOpenAIProvider({ env: ENV }).inferStream(request()));
    const body = JSON.parse(String(calls[0]!.init.body)) as { prompt_cache_key?: string };
    expect(body.prompt_cache_key).toMatch(/^rune-[0-9a-f]{8}$/);
  });
});

describe("the response Azure actually sends", () => {
  test("a recorded stream comes back through the OpenAI parser", async () => {
    mockFetch(() => recordedStream());
    const events = await collect(new AzureOpenAIProvider({ env: ENV }).inferStream(request()));
    const text = events
      .filter((e) => e.type === "content_delta")
      .map((e) => (e as { delta: { text: string } }).delta.text)
      .join("");
    expect(text).toBe("Hi there");

    const stop = events.find((e) => e.type === "message_stop") as
      { usage: { inputTokens: number; cacheReadTokens?: number } } | undefined;
    // The cached portion is SUBTRACTED from prompt_tokens by the shared
    // adapter, so the three input fields stay disjoint and the context engine
    // does not double-count a well-cached conversation.
    expect(stop?.usage.inputTokens).toBe(24);
    expect(stop?.usage.cacheReadTokens).toBe(16);
  });

  test("no credential is a 401 that names the variables to set", async () => {
    mockFetch(() => recordedStream());
    const p = new AzureOpenAIProvider({
      env: { AZURE_OPENAI_ENDPOINT: ENV.AZURE_OPENAI_ENDPOINT },
    });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(/AZURE_OPENAI_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  test("no endpoint is a 400 that names the setting", async () => {
    mockFetch(() => recordedStream());
    const p = new AzureOpenAIProvider({ env: { AZURE_OPENAI_API_KEY: "k" } });
    await expect(collect(p.inferStream(request()))).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
    expect(calls).toHaveLength(0);
  });

  test("healthCheck asks whether the route is configured, and spends nothing", async () => {
    mockFetch(() => recordedStream());
    expect(await new AzureOpenAIProvider({ env: ENV }).healthCheck()).toBe(true);
    expect(await new AzureOpenAIProvider({ env: {} }).healthCheck()).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("live deployment discovery", () => {
  test("lists what this resource has deployed, keyed by model id", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "prod-chat", model: "gpt-4o", status: "succeeded" },
              { id: "gpt-4o-mini", model: "gpt-4o-mini", status: "succeeded" },
              { id: "broken", model: "gpt-4o", status: "failed" },
            ],
          }),
          { status: 200 },
        ),
    );
    const models = await new AzureOpenAIProvider({ env: ENV }).listModels();

    expect(calls[0]!.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments" +
        `?api-version=${DEFAULT_AZURE_API_VERSION}`,
    );
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe(
      "azure-resource-key",
    );
    // A failed deployment is not something you can run.
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    // The id is the MODEL (what the picker and the meter key on); the
    // deployment name is visible in the label so a mismatch is not silent.
    expect(models[0]!.label).toBe("gpt-4o · deployment prod-chat");
  });

  test("discovery without a credential raises rather than returning an empty list", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    await expect(
      new AzureOpenAIProvider({
        env: { AZURE_OPENAI_ENDPOINT: ENV.AZURE_OPENAI_ENDPOINT },
      }).listModels(),
    ).rejects.toThrow(/AZURE_OPENAI_API_KEY/);
  });
});
