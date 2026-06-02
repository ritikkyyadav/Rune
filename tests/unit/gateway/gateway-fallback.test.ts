import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  ToolDefinition,
} from "../../../packages/llm-gateway/src/types";

class FakeProvider implements LlmProvider {
  /** Number of times inferStream was invoked — used to assert fast fallback. */
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly stream: () => AsyncGenerator<StreamEvent>,
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("infer not used in these tests");
  }
  inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    return this.stream();
  }
  async countTokens(_messages: Message[], _tools?: ToolDefinition[]): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

async function* fail429(): AsyncGenerator<StreamEvent> {
  throw new ApiError({ status: 429, provider: "google", message: "rate limited" });
}

async function* failNetwork(): AsyncGenerator<StreamEvent> {
  // A transient error with no HTTP status (e.g. socket reset).
  throw new Error("socket hang up");
}

function errorEvent(events: StreamEvent[]): Extract<StreamEvent, { type: "error" }> | undefined {
  return events.find((e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error");
}

function okText(text: string): () => AsyncGenerator<StreamEvent> {
  return async function* () {
    yield { type: "message_start", messageId: "m" };
    yield { type: "content_start", contentIndex: 0 };
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text } };
    yield { type: "content_stop", contentIndex: 0 };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const req: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gemini-2.5-flash",
  provider: "google",
  maxTokens: 128,
  stream: true,
};

function gateway(): LlmGateway {
  return new LlmGateway({
    providers: {},
    defaultProvider: "google",
    maxRetries: 1,
    retryBaseMs: 1,
  });
}

describe("LlmGateway streaming fallback", () => {
  // Regression: a provider switch must NOT be an `error` event. The agent loop
  // ends the turn on `error`, so an error-typed switch abandons the fallback
  // generator and the turn produces nothing (the "Switching to…" hang).
  test("on 429, emits a non-fatal notice and streams the fallback provider", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", fail429));
    gw.registerProvider(new FakeProvider("openrouter", okText("hello from fallback")));

    const events = await collect(gw.inferStream(req));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const notice = events.find(
      (e): e is Extract<StreamEvent, { type: "notice" }> => e.type === "notice",
    );
    expect(notice?.message).toContain("Switching to");

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "content_delta" }> => e.type === "content_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("hello from fallback");
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("with no fallback available, a 429 surfaces as a terminal, non-retryable error", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", fail429));

    const events = await collect(gw.inferStream(req));
    expect(events.some((e) => e.type === "notice")).toBe(false);
    const err = errorEvent(events);
    expect(err).toBeDefined();
    expect(err?.retryable).toBe(false); // re-running won't help — fail fast
    expect(err?.error.toLowerCase()).toContain("rate limited");
  });

  // The core bug: on 429 the gateway must switch immediately, not burn the
  // retry ladder on the throttled primary first.
  test("on 429 with a fallback, switches immediately without retrying the primary", async () => {
    const gw = gateway(); // maxRetries: 1 — old behavior would call google twice
    const google = new FakeProvider("google", fail429);
    const openrouter = new FakeProvider("openrouter", okText("ok"));
    gw.registerProvider(google);
    gw.registerProvider(openrouter);

    const events = await collect(gw.inferStream(req));

    expect(google.calls).toBe(1); // fast fallback — no wasted retry on the dead primary
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  // The confusing failure: when every provider is throttled, the user got 3×
  // repeated failures ending in "Too many consecutive errors". Now it's one
  // clean, non-retryable error naming the providers.
  test("all providers rate-limited → one terminal error, retryable:false, names them", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", fail429));
    gw.registerProvider(new FakeProvider("openrouter", fail429));

    const events = await collect(gw.inferStream(req));

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    const err = errorEvent(events)!;
    expect(err.retryable).toBe(false);
    expect(err.error).toContain("google");
    expect(err.error).toContain("openrouter");
    expect(err.error.toLowerCase()).toContain("rate limited");
  });

  // A transient network error (no HTTP status) should still fall back to the
  // next provider rather than dying on the primary.
  test("a network error (no status) falls back to the next provider", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", failNetwork));
    gw.registerProvider(new FakeProvider("openrouter", okText("recovered")));

    const events = await collect(gw.inferStream(req));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "content_delta" }> => e.type === "content_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("recovered");
  });
});
