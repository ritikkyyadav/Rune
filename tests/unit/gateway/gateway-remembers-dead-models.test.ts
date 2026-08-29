/**
 * The gateway acts on what previous sessions learned.
 *
 * ProviderHealthStore's own tests prove it remembers. These prove the gateway
 * USES the memory: a model a previous session watched die is skipped without a
 * request, rather than confirmed with one. Confirming is not cheap — a
 * model-gone 404 carries the entire conversation up the wire before it fails,
 * and the incident log shows that happening 24 times against a single id.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { ProviderHealthStore } from "../../../packages/llm-gateway/src/provider-health";
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

class CountingProvider implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly stream: () => AsyncGenerator<StreamEvent>,
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("infer not used here");
  }
  inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    return this.stream();
  }
  async countTokens(_m: Message[], _t?: ToolDefinition[]): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

async function* modelGone(): AsyncGenerator<StreamEvent> {
  throw new ApiError({ status: 404, provider: "openrouter", message: "model not found" });
}

async function* succeed(): AsyncGenerator<StreamEvent> {
  yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: "ok" } };
  yield {
    type: "message_stop",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

const request = (provider: ProviderName, model: string): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model,
  provider,
  maxTokens: 16,
  stream: true,
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("gateway remembers dead models across sessions", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-gw-health-"));
    path = join(dir, "h.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a retirement discovered in one session is recorded", async () => {
    const health = new ProviderHealthStore(path);
    const gw = new LlmGateway(
      { providers: {}, defaultProvider: "openrouter", maxRetries: 0, retryBaseMs: 1 },
      health,
    );
    const dead = new CountingProvider("openrouter", modelGone);
    gw.registerProvider(dead);

    await drain(gw.inferStream(request("openrouter", "dead-model")));

    expect(dead.calls).toBeGreaterThan(0);
    expect(health.isRetired("openrouter", "dead-model")).toBe(true);
  });

  test("the NEXT session skips it without spending a request", async () => {
    // Session one learns.
    const first = new ProviderHealthStore(path);
    first.noteRetired("openrouter", "dead-model", "410 retired");

    // Session two: a fresh store over the same file, as a restart would build.
    const gw = new LlmGateway(
      { providers: {}, defaultProvider: "openrouter", maxRetries: 0, retryBaseMs: 1 },
      new ProviderHealthStore(path),
    );
    const dead = new CountingProvider("openrouter", modelGone);
    gw.registerProvider(dead);

    await drain(gw.inferStream(request("openrouter", "dead-model")));

    // The whole point: not one request was spent confirming what was known.
    expect(dead.calls).toBe(0);
  });

  test("a live model on the same provider is unaffected", async () => {
    const health = new ProviderHealthStore(path);
    health.noteRetired("openrouter", "dead-model", "410 retired");

    const gw = new LlmGateway(
      { providers: {}, defaultProvider: "openrouter", maxRetries: 0, retryBaseMs: 1 },
      health,
    );
    const live = new CountingProvider("openrouter", succeed);
    gw.registerProvider(live);

    const events = await drain(gw.inferStream(request("openrouter", "live-model")));

    expect(live.calls).toBe(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  test("with no persisted memory the gateway behaves exactly as before", async () => {
    const gw = new LlmGateway(
      { providers: {}, defaultProvider: "openrouter", maxRetries: 0, retryBaseMs: 1 },
      new ProviderHealthStore(path),
    );
    const live = new CountingProvider("openrouter", succeed);
    gw.registerProvider(live);

    await drain(gw.inferStream(request("openrouter", "live-model")));
    expect(live.calls).toBe(1);
  });
});
