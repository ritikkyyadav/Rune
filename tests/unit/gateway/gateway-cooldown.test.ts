/**
 * P4a — the gateway cools a capped provider down until the moment the
 * provider named, says when that is, and treats `infer()` the same way.
 *
 * The evidence: on 2026-09-28 a ChatGPT Plus cap said, in its body, "resets in
 * 9731 seconds". The gateway read "usage limit" out of the sentence, guessed
 * fifteen minutes (and would never have believed more than sixty), told the
 * user "resume this session in ~15m", and the TUI's auto-resume would have
 * re-sent the request every fifteen minutes for 2h42m. `infer()` — the
 * classifier, the summarizer, sub-agent repair — had no cap handling at all
 * and retried the capped request on every attempt.
 *
 * The recorded 429 is replayed through the REAL Codex provider on a fake fetch
 * and a fixed clock.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmGateway, formatClock, formatWait } from "../../../packages/llm-gateway/src/gateway";
import { CodexProvider } from "../../../packages/llm-gateway/src/providers/codex";
import { ProviderHealthStore } from "../../../packages/llm-gateway/src/provider-health";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type {
  GatewayConfig,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  ProviderName,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";
import { rateLimitWaitSecs } from "../../../packages/orchestrator/src/agent-loop";

const RESETS_AT_MS = 1790556009 * 1000;
const NOW = RESETS_AT_MS - 9731 * 1000;
const MINUTE = 60_000;

const CAP_BODY = JSON.stringify({
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "plus",
    resets_at: 1790556009,
    resets_in_seconds: 9731,
  },
});

const CAP_HEADERS = {
  "x-codex-primary-used-percent": "100",
  "x-codex-primary-reset-after-seconds": "9732",
  "x-codex-primary-reset-at": "1790556010",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": "16",
  "x-codex-secondary-reset-after-seconds": "596532",
  "x-codex-secondary-window-minutes": "10080",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

/** Every Codex request answers with the recorded cap. Returns the call count. */
function cappedCodex(): () => number {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response(CAP_BODY, { status: 429, headers: CAP_HEADERS });
  }) as unknown as typeof fetch;
  return () => n;
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

function gateway(over: Partial<GatewayConfig> = {}, health?: ProviderHealthStore): LlmGateway {
  return new LlmGateway(
    { providers: {}, defaultProvider: "codex", maxRetries: 3, retryBaseMs: 1, ...over },
    health,
  );
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type ErrorEvent = Extract<StreamEvent, { type: "error" }>;
const errorOf = (events: StreamEvent[]) => events.find((e): e is ErrorEvent => e.type === "error");

function scratchHealth(): string {
  return join(mkdtempSync(join(tmpdir(), "rune-p4a-health-")), "provider-health.json");
}

describe("the recorded cap, end to end", () => {
  test("stops without a retry, cooling exactly until the reported reset", async () => {
    setSystemTime(new Date(NOW));
    const calls = cappedCodex();
    const gw = gateway();
    gw.registerProvider(new CodexProvider("tok"));
    const events = await drain(gw.inferStream(request()));

    expect(calls()).toBe(1); // maxRetries 3, and not one of them spent on the wall
    const err = errorOf(events)!;
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("usage_cap");
    expect(err.resetAt).toBe(RESETS_AT_MS);
    // Not the 15m guess, and not clamped to the 60m ceiling a guess gets.
    expect(gw.getProviderHealth().cooling).toEqual([{ provider: "codex", untilMs: RESETS_AT_MS }]);
  });

  test("says how long AND when, in the words a person reads", async () => {
    setSystemTime(new Date(NOW));
    cappedCodex();
    const gw = gateway();
    gw.registerProvider(new CodexProvider("tok"));
    const err = errorOf(await drain(gw.inferStream(request())))!;

    expect(err.error).toContain("Quota exceeded on codex/gpt-6-sol");
    expect(err.error).toContain(
      `resume this session in ~2h 42m (at ${formatClock(RESETS_AT_MS, NOW)})`,
    );
    expect(err.error).not.toContain("~15m");
    // Still unmistakable for a short, waitable throttle.
    expect(rateLimitWaitSecs(err.error)).toBeNull();
  });

  test("the cap outlives the session at its exact moment", async () => {
    setSystemTime(new Date(NOW));
    cappedCodex();
    const path = scratchHealth();
    const gw = gateway({}, new ProviderHealthStore(path));
    gw.registerProvider(new CodexProvider("tok"));
    await drain(gw.inferStream(request()));

    // A fresh store on the same file — the next session.
    expect(new ProviderHealthStore(path).cappedUntil("codex")).toBe(RESETS_AT_MS);
    const next = gateway({}, new ProviderHealthStore(path));
    expect(next.getProviderHealth().cooling).toEqual([
      { provider: "codex", untilMs: RESETS_AT_MS },
    ]);
  });
});

// ─── The rules, one by one, on a stub provider ───

class Stub implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly fail?: () => Error,
  ) {}
  async infer(): Promise<InferenceResponse> {
    this.calls++;
    if (this.fail) throw this.fail();
    return {
      id: "r",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    };
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.fail) throw this.fail();
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

const capWith =
  (over: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  () =>
    new ApiError({
      status: 429,
      provider: "codex",
      message: "The usage limit has been reached",
      ...over,
    });

describe("reported resets are exact; guesses are clamped", () => {
  test("a reported reset days away is kept to the millisecond", async () => {
    setSystemTime(new Date(NOW));
    const at = NOW + 3 * 24 * 60 * MINUTE + 17_000;
    const gw = gateway();
    gw.registerProvider(new Stub("codex", capWith({ code: "usage_cap", resetAt: at })));
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.resetAt).toBe(at);
    expect(gw.getProviderHealth().cooling[0]!.untilMs).toBe(at);
    expect(err.error).toContain("in ~3d");
  });

  test("a cap known only from its sentence still gets the 15m guess", async () => {
    setSystemTime(new Date(NOW));
    const gw = gateway();
    gw.registerProvider(new Stub("codex", capWith()));
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.resetAt).toBe(NOW + 15 * MINUTE);
    expect(err.error).toContain("resume this session in ~15m");
  });

  test("a bare Retry-After is a guess too, and is clamped to the hour", async () => {
    setSystemTime(new Date(NOW));
    const gw = gateway();
    gw.registerProvider(new Stub("codex", capWith({ retryAfterMs: 5 * 60 * MINUTE })));
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.resetAt).toBe(NOW + 60 * MINUTE);
  });

  test("a reported reset already in the past is no reset at all", async () => {
    setSystemTime(new Date(NOW));
    const gw = gateway();
    gw.registerProvider(new Stub("codex", capWith({ code: "usage_cap", resetAt: NOW - 1 })));
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.resetAt).toBe(NOW + 15 * MINUTE);
  });
});

describe("a cap is recognised by its field first, its sentence second", () => {
  // Flex, so a throttle has somewhere to go and a cap visibly refuses it.
  function pair(fail: () => Error) {
    const gw = gateway({ modelIntegrity: "flex", maxRetries: 0 });
    const primary = new Stub("codex", fail);
    const spare = new Stub("google");
    gw.registerProvider(primary);
    gw.registerProvider(spare);
    return { gw, spare };
  }

  test("code usage_cap stops the run even when the sentence sounds like a throttle", async () => {
    const { gw, spare } = pair(capWith({ code: "usage_cap", message: "Too many requests" }));
    const err = errorOf(await drain(gw.inferStream(request())));
    expect(err?.error).toContain("Quota exceeded");
    expect(spare.calls).toBe(0);
  });

  test("code rate_limit is a throttle even when the sentence says quota", async () => {
    const { gw, spare } = pair(
      capWith({ code: "rate_limit", message: "Per-minute quota exceeded, slow down" }),
    );
    const events = await drain(gw.inferStream(request()));
    expect(events.some((e) => e.type === "fallback")).toBe(true);
    expect(spare.calls).toBe(1);
  });

  test("with no field, the sentence still decides (the other providers' path)", async () => {
    const { gw, spare } = pair(capWith());
    expect(errorOf(await drain(gw.inferStream(request())))?.error).toContain("Quota exceeded");
    expect(spare.calls).toBe(0);
  });
});

describe('under onQuotaExceeded = "degrade", with nothing left to degrade to', () => {
  test("a cap is still reported as a cap, never as a waitable throttle", async () => {
    // It used to fall through to "Rate limited on codex. Retry in ~9731s" —
    // which the agent loop reads as a 90-second wait, then re-sends.
    setSystemTime(new Date(NOW));
    const gw = gateway({ quotaPolicy: "degrade" });
    gw.registerProvider(new Stub("codex", capWith({ code: "usage_cap", resetAt: RESETS_AT_MS })));
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.error).toContain("Quota exceeded");
    expect(err.error).toContain("No provider is left to continue on.");
    expect(err.error).not.toContain("weaker model");
    expect(rateLimitWaitSecs(err.error)).toBeNull();
    expect(err.resetAt).toBe(RESETS_AT_MS);
  });

  test("the skip notice on the next turn names the real wait", async () => {
    setSystemTime(new Date(NOW));
    const gw = gateway({ quotaPolicy: "degrade", maxRetries: 0 });
    gw.registerProvider(new Stub("codex", capWith({ code: "usage_cap", resetAt: RESETS_AT_MS })));
    gw.registerProvider(new Stub("google"));
    await drain(gw.inferStream(request()));
    const next = await drain(gw.inferStream(request()));
    const notice = next.find((e) => e.type === "notice") as { message: string };
    expect(notice.message).toContain("retrying it in ~2h 42m");
  });
});

describe("infer() reads a 429 the way the stream does", () => {
  test("a cap is thrown after ONE request, with the provider's reset on it", async () => {
    setSystemTime(new Date(NOW));
    const stub = new Stub("codex", capWith({ code: "usage_cap", resetAt: RESETS_AT_MS }));
    const path = scratchHealth();
    const gw = gateway({}, new ProviderHealthStore(path));
    gw.registerProvider(stub);

    const thrown = await gw.infer(request({ stream: false })).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(stub.calls).toBe(1); // it used to be maxRetries + 1 requests into the wall
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown!.resetAt).toBe(RESETS_AT_MS);
    // The cooldown the reviewer's fallback reads, and the cap the next session reads.
    expect(gw.getProviderHealth().cooling).toEqual([{ provider: "codex", untilMs: RESETS_AT_MS }]);
    expect(new ProviderHealthStore(path).cappedUntil("codex")).toBe(RESETS_AT_MS);
  });

  test("the recorded Codex cap, through the real provider, is one request", async () => {
    setSystemTime(new Date(NOW));
    const calls = cappedCodex();
    const gw = gateway();
    gw.registerProvider(new CodexProvider("tok"));
    await expect(gw.infer(request({ stream: false }))).rejects.toMatchObject({
      code: "usage_cap",
      resetAt: RESETS_AT_MS,
    });
    expect(calls()).toBe(1);
  });

  test("a throttle is still retried, and now leaves a cooldown behind", async () => {
    setSystemTime(new Date(NOW));
    const stub = new Stub(
      "codex",
      () => new ApiError({ status: 429, provider: "codex", message: "slow down" }),
    );
    const gw = gateway({ maxRetries: 2 });
    gw.registerProvider(stub);
    await expect(gw.infer(request({ stream: false }))).rejects.toThrow("slow down");
    expect(stub.calls).toBe(3);
    expect(gw.getProviderHealth().cooling).toEqual([{ provider: "codex", untilMs: NOW + MINUTE }]);
  });
});

describe("the two forms of a wait", () => {
  test("relative: minutes under an hour, then hours and minutes, then days", () => {
    expect(formatWait(9731 * 1000)).toBe("2h 42m");
    expect(formatWait(15 * MINUTE)).toBe("15m");
    expect(formatWait(20_000)).toBe("1m"); // never "0m"
    expect(formatWait(3 * 60 * MINUTE)).toBe("3h");
    expect(formatWait(596532 * 1000)).toBe("6d 21h");
  });

  test("under an hour it is still the form the TUI's auto-resume parses", async () => {
    // tui.ts scheduleQuotaResume: /resume this session in ~(\d+)m/ — a
    // mismatch silently falls back to 15 minutes.
    setSystemTime(new Date(NOW));
    const gw = gateway();
    gw.registerProvider(
      new Stub("codex", capWith({ code: "usage_cap", resetAt: NOW + 42 * MINUTE })),
    );
    const err = errorOf(await drain(gw.inferStream(request())))!;
    expect(err.error.match(/resume this session in ~(\d+)m/)?.[1]).toBe("42");
  });

  test("clock: the minute rounded up, with the date once it is another day", () => {
    const at = new Date(2026, 8, 28, 14, 7, 49).getTime(); // 14:07:49 local
    const morning = new Date(2026, 8, 28, 11, 25).getTime();
    expect(formatClock(at, morning)).toBe("14:08"); // never a minute the cap still holds
    expect(formatClock(new Date(2026, 8, 28, 14, 7, 0).getTime(), morning)).toBe("14:07");
    expect(formatClock(new Date(2026, 9, 5, 9, 30).getTime(), morning)).toBe("Oct 5 09:30");
  });
});
