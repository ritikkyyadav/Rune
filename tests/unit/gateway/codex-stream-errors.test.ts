/**
 * P4a — a Codex failure is classified by what it says, wherever it arrives.
 *
 * Two holes this closes:
 *
 *  - A failure that arrived AFTER the 200 (`response.failed`, a bare `error`
 *    event) was a 502 whatever it said. A context overflow was retried as an
 *    outage — three identical oversized requests — and a plan cap as a blip.
 *  - `fetch()` sat outside the try, so a watchdog that fired while the backend
 *    was still queueing (no headers yet) escaped as a raw AbortError instead of
 *    the retryable 504, and a refused connection left the watchdog armed.
 *
 * Fake fetch throughout; the watchdog's five-minute allowance runs on fake
 * timers.
 */
import { describe, test, expect, afterEach, jest } from "bun:test";
import {
  CodexProvider,
  parseResponsesStream,
} from "../../../packages/llm-gateway/src/providers/codex";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type { InferenceRequest, StreamEvent } from "../../../packages/llm-gateway/src/types";
import { isContextOverflowError } from "../../../packages/orchestrator/src/agent-loop";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

/** A structural byte stream carrying these SSE events, then EOF. */
function sse(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  let done = false;
  return {
    getReader() {
      return {
        async read() {
          if (done) return { value: undefined, done: true };
          done = true;
          return { value: new TextEncoder().encode(text), done: false };
        },
      };
    },
  };
}

async function failureOf(event: object): Promise<ApiError> {
  try {
    for await (const _ of parseResponsesStream(sse([event]))) {
      // drain
    }
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("the stream did not fail");
}

describe("mid-stream failures, by code", () => {
  test("a plan cap is a 429 usage cap with its reset", async () => {
    const before = Date.now();
    const err = await failureOf({
      type: "response.failed",
      response: {
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          resets_in_seconds: 9731,
        },
      },
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("usage_cap");
    expect(err.resetAt! - before).toBeGreaterThanOrEqual(9731 * 1000);
    expect(err.resetAt! - before).toBeLessThan(9731 * 1000 + 5_000);
  });

  test("a rate limit is a 429 throttle with the wait it named", async () => {
    const err = await failureOf({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Rate limit reached for gpt-6-sol. Please try again in 1.898s.",
    });
    expect([err.status, err.code, err.retryAfterMs]).toEqual([429, "rate_limit", 1898]);
    expect(err.resetAt).toBeUndefined();

    const short = await failureOf({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Please try again in 350ms.",
    });
    expect(short.retryAfterMs).toBe(350);
  });

  test("an exhausted quota is a cap too, even with no reset to give", async () => {
    const err = await failureOf({
      type: "response.failed",
      response: { error: { code: "insufficient_quota", message: "You exceeded your quota." } },
    });
    expect([err.status, err.code, err.resetAt]).toEqual([429, "usage_cap", undefined]);
  });

  test("a context overflow is a 400 the agent loop's overflow recovery recognises", async () => {
    const err = await failureOf({
      type: "response.failed",
      response: {
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model.",
        },
      },
    });
    expect([err.status, err.code]).toEqual([400, "context_overflow"]);
    // The loop compacts and retries on exactly this predicate.
    expect(isContextOverflowError(err.message)).toBe(true);
  });

  test("a server error stays a retryable 502", async () => {
    const err = await failureOf({
      type: "response.failed",
      response: { error: { code: "server_error", message: "An error occurred." } },
    });
    expect([err.status, err.code]).toEqual([502, "server_error"]);
  });

  test("an invalid request is a 400, from either event shape", async () => {
    for (const event of [
      { type: "error", error: { type: "invalid_request_error", message: "Invalid 'input[3]'." } },
      { type: "response.failed", response: { error: { code: "invalid_prompt", message: "no" } } },
    ]) {
      const err = await failureOf(event);
      expect([err.status, err.code]).toEqual([400, "invalid_request"]);
    }
  });

  test("anything unrecognised keeps the old retryable 502, and its words", async () => {
    const unknown = await failureOf({
      type: "response.failed",
      response: { error: { code: "vector_store_timeout", message: "store timed out" } },
    });
    expect([unknown.status, unknown.code]).toEqual([502, undefined]);
    expect(unknown.message).toContain("store timed out");

    const bare = await failureOf({ type: "response.failed", response: {} });
    expect(bare.status).toBe(502);
    expect(bare.message).toContain("Codex responses stream failed");
  });

  test("a bare error event's own type is not mistaken for the error's name", async () => {
    // `{"type":"error"}` names the EVENT. Read as the error's name it would
    // print "(error)" and file "error" as the provider's code.
    const err = await failureOf({ type: "error", message: "boom" });
    expect(err.status).toBe(502);
    expect(err.providerCode).toBeUndefined();
    expect(err.message).toBe("Codex stream failed: boom");
  });
});

// ─── The request, inside the try ───

const OK_SSE = [
  { type: "response.created", response: { id: "r" } },
  { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join("");

const request = (): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-6-sol",
  provider: "codex",
  maxTokens: 100,
  stream: true,
  role: "primary",
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("a watchdog that fires before the headers arrive", () => {
  test("is the retryable 504, not a raw AbortError", async () => {
    jest.useFakeTimers();
    // The backend accepts the connection and says nothing: the fetch settles
    // only when its signal aborts, as a real one does.
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const outcome = drain(new CodexProvider("tok").inferStream(request())).then(
      () => null,
      (err: unknown) => err,
    );
    await settle();
    jest.advanceTimersByTime(300_001); // the five-minute first-byte allowance
    const err = (await outcome) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(504); // >= 500: the gateway retries or falls back
    expect(err.message).toBe("stream stalled — no data for 300s");
  });

  test("a failure the backend described stands, even when its body stalls", async () => {
    // The status arrived; only the error body hung until the watchdog fired.
    // What the backend said (a 429) is worth more than "stream stalled".
    jest.useFakeTimers();
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => ({
      ok: false,
      status: 429,
      body: null,
      headers: new Headers(),
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    })) as unknown as typeof fetch;

    const outcome = drain(new CodexProvider("tok").inferStream(request())).then(
      () => null,
      (err: unknown) => err,
    );
    await settle();
    jest.advanceTimersByTime(300_001);
    const err = (await outcome) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
  });

  test("the caller's own Esc is still the caller's, never a 504", async () => {
    const esc = new AbortController();
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const outcome = drain(
      new CodexProvider("tok").inferStream(request(), { signal: esc.signal }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    await settle();
    esc.abort();
    const err = (await outcome) as Error;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.name).toBe("AbortError");
  });

  test("a refused connection stops the watchdog instead of leaving it armed", async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(drain(new CodexProvider("tok").inferStream(request()))).rejects.toThrow(
      "fetch failed",
    );
    // Had the timer survived, it would fire here and abort a request that
    // already failed — a live timer holding the process open for five minutes.
    jest.advanceTimersByTime(300_001);
    expect(signal?.aborted).toBe(false);
  });
});

// ─── The retry ladder, counted ───

function gateway() {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "codex",
    maxRetries: 3,
    retryBaseMs: 1,
  });
  gw.registerProvider(new CodexProvider("tok"));
  return gw;
}

function countingFetch(respond: () => Response): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return respond();
  }) as unknown as typeof fetch;
  return { calls: () => n };
}

const failedStream = (error: object) =>
  new Response(`data: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`, {
    status: 200,
  });

describe("the retry ladder on Codex failures", () => {
  test("a 502 sequence is tried exactly four times (one call, three retries)", async () => {
    const fetch = countingFetch(() => new Response("bad gateway", { status: 502 }));
    const events = await drain(gateway().inferStream(request()));
    expect(fetch.calls()).toBe(4);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(3);
    // Still transient at the end: the loop may try the turn again.
    const error = events.find((e) => e.type === "error") as { retryable?: boolean };
    expect(error.retryable).not.toBe(false);
  });

  test("so is a mid-stream server_error sequence", async () => {
    const fetch = countingFetch(() => failedStream({ code: "server_error", message: "boom" }));
    await drain(gateway().inferStream(request()));
    expect(fetch.calls()).toBe(4);
  });

  test("a mid-stream invalid request is sent once", async () => {
    const fetch = countingFetch(() =>
      failedStream({ type: "invalid_request_error", message: "Invalid 'input[3]'." }),
    );
    await drain(gateway().inferStream(request()));
    expect(fetch.calls()).toBe(1);
  });

  test("a mid-stream context overflow is sent once, and reaches the loop in its words", async () => {
    const fetch = countingFetch(() =>
      failedStream({ code: "context_length_exceeded", message: "Your input is too long." }),
    );
    const events = await drain(gateway().inferStream(request()));
    expect(fetch.calls()).toBe(1);
    const error = events.find((e) => e.type === "error") as { error: string };
    expect(isContextOverflowError(error.error)).toBe(true);
  });
});
