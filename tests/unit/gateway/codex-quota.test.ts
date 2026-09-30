/**
 * P4a — what a Codex response says about the plan, read instead of guessed.
 *
 * The evidence (ChatGPT Plus, 2026-09-28): a plan cap answered HTTP 429 with
 * its exact reset in the body AND the headers —
 *
 *   {"error":{"type":"usage_limit_reached", …, "resets_at":1790556009,
 *             "resets_in_seconds":9731}}
 *   x-codex-primary-used-percent: 100, x-codex-primary-reset-after-seconds: 9732, …
 *
 * — and Rune kept only the sentence, guessed fifteen minutes, and would have
 * retried every fifteen minutes against a 2h42m wall. These tests replay that
 * response (and a healthy one) through a fake fetch on a fixed clock. No
 * request leaves the process.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import {
  CodexProvider,
  codexErrorMessage,
  codexHttpError,
  parseCodexCapacity,
} from "../../../packages/llm-gateway/src/providers/codex";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  CostEntry,
  InferenceRequest,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";

// ─── The recorded 429 ───

const RESETS_AT = 1790556009; // epoch seconds, from the body
const NOW = (RESETS_AT - 9731) * 1000; // the moment the body was written

const CAP_BODY = JSON.stringify({
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "plus",
    resets_at: RESETS_AT,
    resets_in_seconds: 9731,
  },
});

const CAP_HEADERS: Record<string, string> = {
  "x-codex-primary-used-percent": "100",
  "x-codex-primary-reset-after-seconds": "9732",
  "x-codex-primary-reset-at": "1790556010",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": "16",
  "x-codex-secondary-reset-after-seconds": "596532",
  "x-codex-secondary-reset-at": "1791142810",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-credits-balance": "0",
  "x-codex-credits-has-credits": "False",
  "x-codex-credits-unlimited": "False",
  "x-codex-plan-type": "plus",
  "x-codex-active-limit": "premium",
};

/** A Response-shaped stand-in for codexHttpError (status, headers, text). */
function res(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime(); // back to the real clock
});

describe("the recorded plan cap", () => {
  test("becomes a structured usage cap with the backend's own reset", async () => {
    const err = await codexHttpError(res(429, CAP_BODY, CAP_HEADERS), NOW);
    expect(err.status).toBe(429);
    expect(err.code).toBe("usage_cap");
    expect(err.providerCode).toBe("usage_limit_reached");
    // resets_in_seconds, to the millisecond — not the 15m guess, not a 60m clamp.
    expect(err.retryAfterMs).toBe(9731 * 1000);
    expect(err.resetAt).toBe(RESETS_AT * 1000);
  });

  test("keeps the error type in the message", async () => {
    const err = await codexHttpError(res(429, CAP_BODY, CAP_HEADERS), NOW);
    expect(err.message).toBe(
      "Codex request failed (429, usage_limit_reached): The usage limit has been reached",
    );
    expect(await codexErrorMessage(res(429, CAP_BODY))).toBe(err.message);
  });

  test("carries the meter the failing response reported", async () => {
    const err = await codexHttpError(res(429, CAP_BODY, CAP_HEADERS), NOW);
    expect(err.capacity).toEqual({
      primary: {
        usedPercent: 100,
        windowMinutes: 300,
        resetAfterSeconds: 9732,
        resetAt: NOW + 9732 * 1000,
      },
      secondary: {
        usedPercent: 16,
        windowMinutes: 10080,
        resetAfterSeconds: 596532,
        resetAt: NOW + 596532 * 1000,
      },
      credits: { hasCredits: false, unlimited: false, balance: 0 },
      planType: "plus",
      activeLimit: "premium",
    });
  });
});

describe("where a cap's reset comes from, in order", () => {
  const body = (error: Record<string, unknown>) =>
    JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", ...error } });

  test("resets_in_seconds wins over resets_at, because it needs no clock agreement", async () => {
    // This machine's clock runs 5 minutes fast: the absolute stamp would put
    // the reset 5 minutes early, the relative one stays right.
    const skewedNow = NOW + 5 * 60_000;
    const err = await codexHttpError(
      res(429, body({ resets_at: RESETS_AT, resets_in_seconds: 9731 })),
      skewedNow,
    );
    expect(err.resetAt).toBe(skewedNow + 9731 * 1000);
  });

  test("then resets_at", async () => {
    const err = await codexHttpError(res(429, body({ resets_at: RESETS_AT })), NOW);
    expect(err.resetAt).toBe(RESETS_AT * 1000);
    expect(err.retryAfterMs).toBe(9731 * 1000);
  });

  test("then the headers of the window that is exhausted", async () => {
    const err = await codexHttpError(res(429, body({}), CAP_HEADERS), NOW);
    expect(err.resetAt).toBe(NOW + 9732 * 1000); // the primary: 100% used
    expect(err.retryAfterMs).toBe(9732 * 1000);
  });

  test("an exhausted WEEKLY window binds even with the five-hour one open", async () => {
    const weekly = {
      ...CAP_HEADERS,
      "x-codex-primary-used-percent": "40",
      "x-codex-secondary-used-percent": "100",
    };
    const err = await codexHttpError(res(429, body({}), weekly), NOW);
    expect(err.resetAt).toBe(NOW + 596532 * 1000);
  });

  test("an exhausted window that states no reset claims none, even beside one that does", async () => {
    const weeklyUnstated = {
      "x-codex-primary-used-percent": "40",
      "x-codex-primary-reset-after-seconds": "3600",
      "x-codex-secondary-used-percent": "100",
      "retry-after": "90",
    };
    const err = await codexHttpError(res(429, body({}), weeklyUnstated), NOW);
    expect(err.resetAt).toBeUndefined(); // not the open five-hour window's hour
    expect(err.retryAfterMs).toBe(90_000);
  });

  test("then Retry-After, with no exact reset claimed", async () => {
    const err = await codexHttpError(res(429, body({}), { "retry-after": "120" }), NOW);
    expect(err.code).toBe("usage_cap");
    expect(err.resetAt).toBeUndefined();
    expect(err.retryAfterMs).toBe(120_000);
  });

  test("a garbled reset is refused, not believed for sixty days", async () => {
    const err = await codexHttpError(
      res(429, body({ resets_in_seconds: 60 * 24 * 3600 }), { "retry-after": "30" }),
      NOW,
    );
    expect(err.resetAt).toBeUndefined();
    expect(err.retryAfterMs).toBe(30_000);
  });
});

describe("what is NOT a cap keeps its own wait", () => {
  test("a throttle never borrows the five-hour window's reset", async () => {
    // The meter headers ride on every response, throttles included. Reading
    // the primary window's reset as a throttle's wait would park the session
    // for hours over a limit that clears in seconds.
    const throttle = JSON.stringify({
      error: {
        code: "rate_limit_exceeded",
        message: "Rate limit reached. Please try again in 1.5s.",
      },
    });
    const err = await codexHttpError(res(429, throttle, CAP_HEADERS), NOW);
    expect(err.code).toBe("rate_limit");
    expect(err.resetAt).toBeUndefined();
    expect(err.retryAfterMs).toBe(1500);
  });

  test("Retry-After on a throttle is honoured", async () => {
    const err = await codexHttpError(res(429, "{}", { "retry-after": "7" }), NOW);
    expect(err.retryAfterMs).toBe(7000);
  });

  test("a 5xx that advertises Retry-After does not get to hold the session", async () => {
    const err = await codexHttpError(res(503, "busy", { "retry-after": "600" }), NOW);
    expect(err.retryAfterMs).toBeNull();
  });

  test("a body with no type keeps the old one-line message exactly", async () => {
    expect(await codexErrorMessage(res(429, '{"error":{"message":"rate limited"}}'))).toBe(
      "Codex request failed (429): rate limited",
    );
  });
});

// ─── The meter on a healthy response ───

const OK_SSE = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_text.delta", delta: "hi" },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2 } },
  },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");

const METER_HEADERS: Record<string, string> = {
  "x-codex-primary-used-percent": "42",
  "x-codex-primary-reset-after-seconds": "3600",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": "7.5",
  "x-codex-secondary-window-minutes": "10080",
};

type Call = { url: string; init: RequestInit };

function installFetch(respond: (n: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return calls;
}

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-6-sol",
  provider: "codex",
  maxTokens: 100,
  stream: true,
  role: "primary",
  ...over,
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const stopOf = (events: StreamEvent[]) =>
  events.find(
    (e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop",
  );

describe("the quota meter on a 200", () => {
  test("parses the windows it was given, and only those", () => {
    setSystemTime(new Date(NOW));
    expect(parseCodexCapacity(new Headers(METER_HEADERS))).toEqual({
      primary: {
        usedPercent: 42,
        windowMinutes: 300,
        resetAfterSeconds: 3600,
        resetAt: NOW + 3_600_000,
      },
      secondary: { usedPercent: 7.5, windowMinutes: 10080 },
    });
  });

  test("absent headers mean no meter at all, not an empty one", () => {
    expect(
      parseCodexCapacity(new Headers({ "content-type": "text/event-stream" })),
    ).toBeUndefined();
  });

  test("rides on the usage event of the response that reported it", async () => {
    setSystemTime(new Date(NOW));
    installFetch(() => res(200, OK_SSE, METER_HEADERS));
    const events = await drain(new CodexProvider("tok").inferStream(request()));
    const stop = stopOf(events)!;
    expect(stop.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(stop.capacity?.primary?.usedPercent).toBe(42);
  });

  test("a response with no meter headers emits no capacity field", async () => {
    installFetch(() => res(200, OK_SSE));
    const stop = stopOf(await drain(new CodexProvider("tok").inferStream(request())))!;
    expect("capacity" in stop).toBe(false);
  });

  test("the non-streaming path carries it too", async () => {
    installFetch(() => res(200, OK_SSE, METER_HEADERS));
    const response = await new CodexProvider("tok").infer(request({ stream: false }));
    expect(response.capacity?.primary?.usedPercent).toBe(42);
  });

  test("reaches every usage listener as capacity.primary.usedPercent", async () => {
    // This entry is what the orchestrator spreads into rune.db's cost event,
    // and what the eval rig reads its quotaPct from.
    installFetch(() => res(200, OK_SSE, METER_HEADERS));
    const gw = new LlmGateway({
      providers: {},
      defaultProvider: "codex",
      maxRetries: 0,
      retryBaseMs: 1,
    });
    gw.registerProvider(new CodexProvider("tok"));
    const entries: CostEntry[] = [];
    gw.onUsage((e) => entries.push(e));
    await drain(gw.inferStream(request()));
    await gw.infer(request({ stream: false }));
    expect(entries.map((e) => e.capacity?.primary?.usedPercent)).toEqual([42, 42]);
  });
});

// ─── A stable prompt cache key ───

describe("the prompt cache key", () => {
  const sent = (call: Call) => ({
    key: (JSON.parse(String(call.init.body)) as { prompt_cache_key?: string }).prompt_cache_key,
    session: (call.init.headers as Record<string, string>).session_id,
  });

  test("is the caller's key when it gives one, in the body and the session header", async () => {
    const calls = installFetch(() => res(200, OK_SSE));
    await drain(new CodexProvider("tok").inferStream(request(), { cacheKey: "sess_01J9ABC" }));
    // A rebuilt gateway builds a new provider; the key must not move with it.
    await drain(new CodexProvider("tok").inferStream(request(), { cacheKey: "sess_01J9ABC" }));
    expect(calls.map(sent)).toEqual([
      { key: "sess_01J9ABC", session: "sess_01J9ABC" },
      { key: "sess_01J9ABC", session: "sess_01J9ABC" },
    ]);
  });

  test("falls back to the provider's own id — stable per instance, fresh per instance", async () => {
    const calls = installFetch(() => res(200, OK_SSE));
    const one = new CodexProvider("tok");
    await drain(one.inferStream(request()));
    await drain(one.inferStream(request()));
    await drain(new CodexProvider("tok").inferStream(request()));
    const [a, b, c] = calls.map(sent);
    expect(a!.key).toBeTruthy();
    expect(a).toEqual(b!);
    expect(c!.key).not.toBe(a!.key);
  });

  test("a key that could not ride in a header is not used", async () => {
    const calls = installFetch(() => res(200, OK_SSE));
    const p = new CodexProvider("tok");
    await drain(p.inferStream(request(), { cacheKey: "two words" }));
    await drain(p.inferStream(request(), { cacheKey: "line\nbreak" }));
    await drain(p.inferStream(request()));
    const [spaced, broken, own] = calls.map(sent);
    expect(spaced).toEqual(own!);
    expect(broken).toEqual(own!);
  });
});
