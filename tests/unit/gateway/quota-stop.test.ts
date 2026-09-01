/**
 * A plan/QUOTA cap ends the run. It does not hand the task to another model.
 *
 * The failure this prevents: a frontier model is partway through an extensive
 * coding task, its plan cap trips, and the gateway hands the live transcript to
 * whatever provider is registered next. The substitute inherits the work and
 * the authority, produces output at a different standard, and nothing in the
 * result says so. Recorded on a real audit run — codex/gpt-5.6-sol capped nine
 * minutes in and the deepest sub-agent finished on a free model.
 *
 * Scope is deliberately narrow: a CAP (15m+, often much longer) stops; an
 * ordinary rate limit still retries and falls back, because it clears in
 * seconds and no one wants a run killed by a passing throttle.
 */

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
import { rateLimitWaitSecs } from "../../../packages/orchestrator/src/agent-loop";

const CAP = "The usage limit has been reached";
const THROTTLE = "Too many requests, slow down";

class Stub implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly fail?: string,
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.fail) {
      throw new ApiError({ status: 429, provider: this.name, message: this.fail });
    }
    yield { type: "message_start", messageId: "m" };
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: "ok" } };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(_m: Message[], _t?: ToolDefinition[]): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function setup(failure: string, quotaPolicy?: "stop" | "degrade") {
  const primary = new Stub("codex", failure);
  const spare = new Stub("google");
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "codex",
    maxRetries: 0,
    retryBaseMs: 1,
    // These suites document the SUBSTITUTE chain, which is now the explicit
    // flex opt-in (model integrity pins by default — see model-pin.test.ts).
    modelIntegrity: "flex",
    ...(quotaPolicy ? { quotaPolicy } : {}),
  });
  gw.registerProvider(primary);
  gw.registerProvider(spare);
  return { gw, primary, spare };
}

const req: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-5.6-sol",
  provider: "codex",
  maxTokens: 10,
  stream: true,
};

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const errorOf = (events: StreamEvent[]) =>
  events.find((e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error");
const fellBack = (events: StreamEvent[]) => events.some((e) => e.type === "fallback");

describe("a quota cap stops the run", () => {
  test("no fallback happens, even with a healthy provider registered", async () => {
    const { gw, spare } = setup(CAP);
    const events = await drain(gw.inferStream(req));
    expect(fellBack(events)).toBe(false);
    expect(spare.calls).toBe(0);
  });

  test("the error is terminal, so the loop cannot retry into it", async () => {
    const { gw } = setup(CAP);
    const err = errorOf(await drain(gw.inferStream(req)));
    expect(err?.retryable).toBe(false);
  });

  test("the message says what happened, that work is kept, and when to return", async () => {
    const { gw } = setup(CAP);
    const err = errorOf(await drain(gw.inferStream(req)));
    expect(err?.error).toContain("Quota exceeded");
    expect(err?.error).toContain("codex/gpt-5.6-sol");
    expect(err?.error).toContain("weaker model");
    expect(err?.error).toContain("Your work is saved");
    expect(err?.error).toMatch(/~\d+m/); // a concrete retry window
  });

  test("it names the escape hatch", async () => {
    const { gw } = setup(CAP);
    const err = errorOf(await drain(gw.inferStream(req)));
    expect(err?.error).toContain("onQuotaExceeded");
  });

  test("the message cannot be mistaken for a short waitable throttle", async () => {
    // The agent loop waits out an all-providers rate limit when it can parse a
    // window from the text. A 15-minute cap must never enter that path, or
    // "stop immediately" becomes "hang for a quarter of an hour".
    const { gw } = setup(CAP);
    const err = errorOf(await drain(gw.inferStream(req)));
    expect(rateLimitWaitSecs(err!.error)).toBeNull();
  });
});

describe("what a cap does NOT change", () => {
  test("an ordinary rate limit still falls back", async () => {
    const { gw, spare } = setup(THROTTLE);
    const events = await drain(gw.inferStream(req));
    expect(fellBack(events)).toBe(true);
    expect(spare.calls).toBe(1);
  });

  test('quotaPolicy "degrade" restores the old behaviour', async () => {
    const { gw, spare } = setup(CAP, "degrade");
    const events = await drain(gw.inferStream(req));
    expect(fellBack(events)).toBe(true);
    expect(spare.calls).toBe(1);
  });
});

describe("the stop holds for the rest of the session", () => {
  test("a later turn still refuses the substitute", async () => {
    // The leak this closes: getFallbackProviders drops a COOLING provider and
    // returns the others, so without a guard "stop" would hold for exactly one
    // turn and turn two would quietly land on the substitute after all.
    const { gw, primary, spare } = setup(CAP);
    await drain(gw.inferStream(req));
    expect(primary.calls).toBe(1);

    const second = await drain(gw.inferStream(req));
    expect(spare.calls).toBe(0); // still nobody else inherits the task
    expect(errorOf(second)?.error).toContain("Quota exceeded");
    expect(errorOf(second)?.retryable).toBe(false);
  });

  test("the capped provider IS retried, so a lifted cap is noticed", async () => {
    // Deliberately NOT short-circuited on the recorded cooldown. Caps often
    // clear sooner than the 15m we assume, and refusing to try would lock the
    // user out for the whole window with no recourse — a worse failure than
    // the silent downgrade this policy exists to prevent. One cheap 429 is the
    // price of noticing recovery.
    const { gw, primary } = setup(CAP);
    await drain(gw.inferStream(req));
    await drain(gw.inferStream(req));
    expect(primary.calls).toBe(2);
  });

  test("a different provider chosen deliberately still works", async () => {
    // The cap is on codex, not on the session. An explicit /model switch must
    // not be blocked by it.
    const { gw, spare } = setup(CAP);
    await drain(gw.inferStream(req));
    const events = await drain(gw.inferStream({ ...req, provider: "google", model: "gemini" }));
    expect(errorOf(events)).toBeUndefined();
    expect(spare.calls).toBe(1);
  });
});
