/**
 * T1 — the gateway's back-off is bounded, and a cancel ends it.
 *
 * Two things a retry ladder must not do. It must not hold a call for as long as
 * a failing server asks: a 503 carrying `Retry-After: 600` slept ten minutes in
 * line, because only a throttle's wait was capped. And it must not sleep
 * through a cancel: the wait ignored the caller's signal, so a cancel that
 * landed in it was honoured only after the whole wait — and after one more
 * request had been sent to a provider nobody was waiting on any more.
 *
 * Fake providers and short real waits. No network.
 */

import { describe, expect, test } from "bun:test";

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

type Retry = Extract<StreamEvent, { type: "retry" }>;

/** Fails every call the same way, and counts the calls. */
class FailingProvider implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly failure: () => Error,
  ) {}
  async infer(): Promise<InferenceResponse> {
    this.calls++;
    throw this.failure();
  }
  inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    const failure = this.failure;
    return (async function* (): AsyncGenerator<StreamEvent> {
      throw failure();
    })();
  }
  async countTokens(_messages: Message[], _tools?: ToolDefinition[]): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

const busy = (retryAfterMs?: number) => () =>
  new ApiError({
    status: 503,
    provider: "google",
    message: "busy",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

const request = (signal?: AbortSignal): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gemini-2.5-flash",
  provider: "google",
  maxTokens: 128,
  stream: true,
  role: "primary",
  ...(signal ? { signal } : {}),
});

/** One provider, three retries, and a first back-off long enough to be cancelled inside. */
function gateway(retryBaseMs: number): LlmGateway {
  return new LlmGateway({
    providers: {},
    defaultProvider: "google",
    maxRetries: 3,
    retryBaseMs,
  });
}

/** Read the stream until its first retry, then hand back the iterator still open. */
async function untilFirstRetry(stream: AsyncGenerator<StreamEvent>): Promise<Retry> {
  for (;;) {
    const next = await stream.next();
    if (next.done) throw new Error("the stream ended before any retry");
    if (next.value.type === "retry") return next.value;
  }
}

describe("a cancel during the back-off", () => {
  test("ends a streamed call there: the wait is not sat out, and nothing more is sent", async () => {
    const provider = new FailingProvider("google", busy());
    const gw = gateway(2_000);
    gw.registerProvider(provider);
    const cancel = new AbortController();
    const stream = gw.inferStream(request(), { signal: cancel.signal });

    await untilFirstRetry(stream);
    // The gateway is now inside a two-second back-off.
    const cancelledAt = performance.now();
    setTimeout(() => cancel.abort(), 20);
    await expect(stream.next()).rejects.toThrow("busy");

    expect(performance.now() - cancelledAt).toBeLessThan(1_000);
    expect(provider.calls).toBe(1);
  });

  test("ends a plain call there too", async () => {
    const provider = new FailingProvider("google", busy());
    const gw = gateway(2_000);
    gw.registerProvider(provider);
    const cancel = new AbortController();

    const startedAt = performance.now();
    setTimeout(() => cancel.abort(), 20);
    await expect(gw.infer(request(cancel.signal))).rejects.toThrow("busy");

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(provider.calls).toBe(1);
  });

  test("ends a throttled call's one short wait there as well", async () => {
    // A sole throttled provider gets one retry after the wait it advised.
    const provider = new FailingProvider(
      "google",
      () =>
        new ApiError({
          status: 429,
          provider: "google",
          message: "slow down",
          retryAfterMs: 5_000,
        }),
    );
    const gw = gateway(1);
    gw.registerProvider(provider);
    const cancel = new AbortController();
    const stream = gw.inferStream(request(), { signal: cancel.signal });

    const retry = await untilFirstRetry(stream);
    expect(retry.waitMs).toBe(5_000);
    const cancelledAt = performance.now();
    setTimeout(() => cancel.abort(), 20);
    await expect(stream.next()).rejects.toThrow("slow down");

    expect(performance.now() - cancelledAt).toBeLessThan(1_000);
    expect(provider.calls).toBe(1);
  });

  test("a call nobody cancels still waits its back-off out and tries again", async () => {
    const provider = new FailingProvider("google", busy());
    const gw = gateway(20);
    gw.registerProvider(provider);

    const startedAt = performance.now();
    const events: StreamEvent[] = [];
    for await (const event of gw.inferStream(request(), {})) events.push(event);

    // Four attempts, and the three waits between them: 20 + 40 + 80 ms.
    expect(provider.calls).toBe(4);
    expect(events.filter((event) => event.type === "retry")).toHaveLength(3);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(140);
  });
});

describe("how long one back-off may be", () => {
  test("a failing server that asks for ten minutes gets thirty seconds", async () => {
    const provider = new FailingProvider("google", busy(600_000));
    const gw = gateway(1);
    gw.registerProvider(provider);
    const cancel = new AbortController();
    const stream = gw.inferStream(request(), { signal: cancel.signal });

    const retry = await untilFirstRetry(stream);
    cancel.abort();
    await expect(stream.next()).rejects.toThrow("busy");

    expect(retry.status).toBe(503);
    expect(retry.waitMs).toBe(30_000);
  });

  test("a wait the server asks for under the bound is the wait it gets", async () => {
    const provider = new FailingProvider("google", busy(1_200));
    const gw = gateway(1);
    gw.registerProvider(provider);
    const cancel = new AbortController();
    const stream = gw.inferStream(request(), { signal: cancel.signal });

    const retry = await untilFirstRetry(stream);
    cancel.abort();
    await expect(stream.next()).rejects.toThrow("busy");

    expect(retry.waitMs).toBe(1_200);
  });

  test("the ladder itself stops doubling at the bound", async () => {
    // Ten retries from a one-minute base would reach hours; each is thirty seconds.
    const provider = new FailingProvider("google", busy());
    const gw = new LlmGateway({
      providers: {},
      defaultProvider: "google",
      maxRetries: 10,
      retryBaseMs: 60_000,
    });
    gw.registerProvider(provider);
    const cancel = new AbortController();
    const stream = gw.inferStream(request(), { signal: cancel.signal });

    const retry = await untilFirstRetry(stream);
    cancel.abort();
    await expect(stream.next()).rejects.toThrow("busy");

    expect(retry.waitMs).toBe(30_000);
  });
});
