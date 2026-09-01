/**
 * Model integrity: the model that starts a task finishes it.
 *
 * Recorded, on a real run: a rate-limited frontier session handed its task to
 * a free model mid-turn — the substitute chain treated a cooldown as a
 * handover ticket, and no "using X for now" banner makes that acceptable for
 * work the user chose a frontier model to author. Under "pin" (the default)
 * there is no substitute chain at all: the primary is retried and waited out,
 * a dead model stops the run with /model guidance, and nothing weaker ever
 * quietly inherits the work. "flex" restores the labeled substitute chain for
 * lineups that prefer a degraded answer over a paused run.
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

type StubMode = "ok" | "throttle" | "gone";

class Stub implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly mode: StubMode = "ok",
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.mode === "throttle") {
      // A plain throttle, NOT a plan cap — the shape that used to trigger a
      // silent handover to the next provider.
      throw new ApiError({ status: 429, provider: this.name, message: "Too many requests" });
    }
    if (this.mode === "gone") {
      throw new ApiError({ status: 404, provider: this.name, message: "model not found" });
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

function gatewayWith(
  primaryMode: StubMode,
  modelIntegrity?: "pin" | "flex",
): { gw: LlmGateway; primary: Stub; substitute: Stub } {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "codex",
    maxRetries: 0,
    retryBaseMs: 1,
    ...(modelIntegrity ? { modelIntegrity } : {}),
  });
  const primary = new Stub("codex", primaryMode);
  const substitute = new Stub("openrouter", "ok");
  gw.registerProvider(primary);
  gw.registerProvider(substitute);
  return { gw, primary, substitute };
}

const req = (): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-5.6-sol",
  provider: "codex",
  maxTokens: 10,
  stream: true,
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const errorText = (events: StreamEvent[]): string =>
  events
    .filter((e): e is Extract<StreamEvent, { type: "error" }> => e.type === "error")
    .map((e) => e.error)
    .join(" | ");

describe("model integrity — pin (the default)", () => {
  test("a throttled primary is never substituted; the run stops with the wait", async () => {
    const { gw, substitute } = gatewayWith("throttle");
    const events = await drain(gw.inferStream(req()));
    expect(substitute.calls).toBe(0);
    expect(events.some((e) => e.type === "fallback")).toBe(false);
    expect(errorText(events)).toContain("Rate limited");
  });

  test("a retired model stops with /model guidance instead of a quiet handover", async () => {
    const { gw, substitute } = gatewayWith("gone");
    const events = await drain(gw.inferStream(req()));
    expect(substitute.calls).toBe(0);
    expect(errorText(events)).toContain("/model");
  });

  test("a healthy primary streams normally", async () => {
    const { gw, primary, substitute } = gatewayWith("ok");
    const events = await drain(gw.inferStream(req()));
    expect(primary.calls).toBe(1);
    expect(substitute.calls).toBe(0);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

describe("model integrity — flex (the explicit opt-in)", () => {
  test("a throttled primary falls through the labeled substitute chain", async () => {
    const { gw, substitute } = gatewayWith("throttle", "flex");
    const events = await drain(gw.inferStream(req()));
    expect(substitute.calls).toBe(1);
    const fallback = events.find(
      (e): e is Extract<StreamEvent, { type: "fallback" }> => e.type === "fallback",
    );
    expect(fallback?.to.provider).toBe("openrouter");
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});
