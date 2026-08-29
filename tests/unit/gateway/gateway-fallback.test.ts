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

function gateway(quotaPolicy?: "stop" | "degrade"): LlmGateway {
  return new LlmGateway({
    providers: {},
    defaultProvider: "google",
    maxRetries: 1,
    retryBaseMs: 1,
    ...(quotaPolicy ? { quotaPolicy } : {}),
  });
}

describe("LlmGateway streaming fallback", () => {
  // Regression: a provider switch must NOT be an `error` event. The agent loop
  // ends the turn on `error`, so an error-typed switch abandons the fallback
  // generator and the turn produces nothing (the "Switching to…" hang).
  test("on 429, emits a non-fatal structured fallback and streams the fallback provider", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", fail429));
    gw.registerProvider(new FakeProvider("openrouter", okText("hello from fallback")));

    const events = await collect(gw.inferStream(req));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const fallback = events.find(
      (e): e is Extract<StreamEvent, { type: "fallback" }> => e.type === "fallback",
    );
    expect(fallback?.from.provider).toBe("google");
    expect(fallback?.to.provider).toBe("openrouter");
    expect(fallback?.status).toBe(429);

    const text = events
      .filter(
        (e): e is Extract<StreamEvent, { type: "content_delta" }> => e.type === "content_delta",
      )
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
    expect(events.some((e) => e.type === "fallback")).toBe(true);
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
      .filter(
        (e): e is Extract<StreamEvent, { type: "content_delta" }> => e.type === "content_delta",
      )
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("recovered");
  });
});

// ─── Model-gone pruning + usage-cap cooldowns ───
//
// Forensic regression (2026-07-16): openrouter's fallback default
// (qwen/qwen3-coder:free) was retired upstream; every turn re-walked
// codex-429 → openrouter-410 → … until the agent loop died with "Too many
// consecutive errors" and 5/6 todos unfinished. A dead model must prune its
// provider for the session, and a plan-cap 429 must cool the provider so the
// next turn skips it instantly.

async function* fail410Retired(): AsyncGenerator<StreamEvent> {
  throw new ApiError({
    status: 410,
    provider: "openrouter",
    message: "qwen3-coder:480b was retired at 2026-07-15 00:00:00 -0700 PDT",
  });
}

async function* fail429UsageCap(): AsyncGenerator<StreamEvent> {
  throw new ApiError({
    status: 429,
    provider: "google",
    message: "Codex request failed (429): The usage limit has been reached",
  });
}

describe("LlmGateway model-gone pruning", () => {
  test("a retired fallback model prunes its provider — next call never touches it", async () => {
    const gw = gateway();
    const google = new FakeProvider("google", fail410Retired);
    const openrouter = new FakeProvider("openrouter", okText("healthy"));
    gw.registerProvider(google);
    gw.registerProvider(openrouter);

    // First call: primary 410s (model gone) → pruned → fallback succeeds.
    const first = await collect(gw.inferStream(req));
    expect(errorEvent(first)).toBeUndefined();
    expect(google.calls).toBe(1);
    expect(gw.getProviderHealth().pruned).toContain("google");

    // Second call: pruned provider is skipped up front, with an honest notice.
    const second = await collect(gw.inferStream(req));
    expect(google.calls).toBe(1); // never re-tried
    const notice = second.find(
      (e): e is Extract<StreamEvent, { type: "notice" }> => e.type === "notice",
    );
    expect(notice?.message).toContain("Skipping google");
    expect(notice?.message).toContain("/model");
    expect(errorEvent(second)).toBeUndefined();
  });

  test("sole provider with a retired model → one terminal, non-retryable error naming /model", async () => {
    const gw = gateway();
    gw.registerProvider(new FakeProvider("google", fail410Retired));

    const events = await collect(gw.inferStream(req));
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1); // no retry-ladder burn, no consecutive-error death
    const err = errorEvent(events)!;
    expect(err.retryable).toBe(false);
    expect(err.error).toContain("retired");
    expect(err.error).toContain("/model");
  });
});

// These exercise the cooldown/self-heal machinery, which only produces a
// fallback under `quotaPolicy: "degrade"`. Under the default ("stop") a cap
// ends the run instead — see quota-stop.test.ts. The cooldown itself still
// runs in both modes; only what happens next differs.
describe("LlmGateway usage-cap cooldown (degrade mode)", () => {
  test("a plan-cap 429 cools the provider — next call skips it instantly", async () => {
    const gw = gateway("degrade");
    const google = new FakeProvider("google", fail429UsageCap);
    const openrouter = new FakeProvider("openrouter", okText("via fallback"));
    gw.registerProvider(google);
    gw.registerProvider(openrouter);

    // First call: 429 → cooldown recorded → fallback streams fine.
    const first = await collect(gw.inferStream(req));
    expect(errorEvent(first)).toBeUndefined();
    expect(google.calls).toBe(1);
    const cooling = gw.getProviderHealth().cooling;
    expect(cooling.some((c) => c.provider === "google")).toBe(true);
    // Usage caps cool for minutes, not seconds — re-hammering a weekly cap
    // at the top of every turn is pure cascade spam.
    const entry = cooling.find((c) => c.provider === "google")!;
    expect(entry.untilMs - Date.now()).toBeGreaterThan(5 * 60_000);

    // Second call: the cooled primary is skipped without a network attempt.
    const second = await collect(gw.inferStream(req));
    expect(google.calls).toBe(1);
    const notice = second.find(
      (e): e is Extract<StreamEvent, { type: "notice" }> => e.type === "notice",
    );
    expect(notice?.message).toContain("Skipping google");
    expect(errorEvent(second)).toBeUndefined();
  });

  test("when everything is unusable, the primary is retried alone and errors cleanly (self-heal path)", async () => {
    const gw = gateway("degrade");
    const google = new FakeProvider("google", fail429UsageCap);
    gw.registerProvider(google);

    const first = await collect(gw.inferStream(req));
    expect(errorEvent(first)?.retryable).toBe(false);

    // Cooldown is active, but with no alternative the primary must still be
    // attempted (it's how the gateway notices the limit reset) — never a
    // false "No providers available".
    const second = await collect(gw.inferStream(req));
    expect(google.calls).toBe(2);
    const err = errorEvent(second);
    expect(err).toBeDefined();
    expect(err?.retryable).toBe(false);
    expect(err?.error).not.toContain("No providers available");
  });
});
