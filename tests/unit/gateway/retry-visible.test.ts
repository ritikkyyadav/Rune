/**
 * A silent retry is a lie of omission about how long something took and how
 * reliable the run was. The gateway used to back off and re-stream with nothing
 * on the wire to say so, which left the surface looking wedged for the length
 * of the backoff — the one moment it most needed to explain itself.
 */

import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type {
  GatewayIncidentEvent,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  ToolDefinition,
} from "../../../packages/llm-gateway/src/types";

type Retry = Extract<StreamEvent, { type: "retry" }>;

/** Fails `failures` times with `status`, then streams `text`. */
class FlakyProvider implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly failures: number,
    private readonly status: number | undefined,
    private readonly text = "done",
  ) {}
  async infer(): Promise<InferenceResponse> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error();
    return {
      id: "r",
      model: "m",
      provider: this.name,
      content: [{ type: "text", text: this.text }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as unknown as InferenceResponse;
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error();
    yield { type: "message_start", messageId: "m" };
    yield { type: "content_start", contentIndex: 0 };
    yield {
      type: "content_delta",
      contentIndex: 0,
      delta: { type: "text_delta", text: this.text },
    };
    yield { type: "content_stop", contentIndex: 0 };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  private error(): Error {
    return this.status === undefined
      ? new Error("socket hang up")
      : new ApiError({ status: this.status, provider: this.name, message: "upstream unavailable" });
  }
  async countTokens(_m: Message[], _t?: ToolDefinition[]): Promise<number> {
    return 0;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

const req: InferenceRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gemini-2.5-flash",
  provider: "google",
  maxTokens: 128,
  stream: true,
};

function gateway(incidents?: GatewayIncidentEvent[]): LlmGateway {
  return new LlmGateway({
    providers: {},
    defaultProvider: "google",
    maxRetries: 2,
    retryBaseMs: 1,
    ...(incidents ? { onIncident: (i: GatewayIncidentEvent) => incidents.push(i) } : {}),
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("retries reach the surface", () => {
  test("a transient 5xx yields a counted retry before the backoff", async () => {
    const gw = gateway();
    gw.registerProvider(new FlakyProvider("google", 1, 503, "recovered"));

    const events = await collect(gw.inferStream(req));
    const retries = events.filter((e): e is Retry => e.type === "retry");

    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.of).toBe(2);
    expect(retries[0]!.provider).toBe("google");
    expect(retries[0]!.status).toBe(503);
    expect(retries[0]!.waitMs).toBeGreaterThan(0);

    // The retry is reported BEFORE the recovered stream, not after it.
    const firstText = events.findIndex((e) => e.type === "content_delta");
    expect(events.indexOf(retries[0]!)).toBeLessThan(firstText);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("every attempt in a ladder is counted, not just the first", async () => {
    const gw = gateway();
    gw.registerProvider(new FlakyProvider("google", 2, undefined, "third time"));

    const retries = (await collect(gw.inferStream(req))).filter(
      (e): e is Retry => e.type === "retry",
    );
    expect(retries.map((r) => `${r.attempt} of ${r.of}`)).toEqual(["1 of 2", "2 of 2"]);
  });

  test("a clean first attempt yields no retry at all", async () => {
    const gw = gateway();
    gw.registerProvider(new FlakyProvider("google", 0, undefined, "fine"));
    const events = await collect(gw.inferStream(req));
    expect(events.some((e) => e.type === "retry")).toBe(false);
  });

  test("the non-streaming path has no stream, so it reports to the black box", async () => {
    const incidents: GatewayIncidentEvent[] = [];
    const gw = gateway(incidents);
    gw.registerProvider(new FlakyProvider("google", 1, 503, "recovered"));

    await gw.infer({ ...req, stream: false });

    const retry = incidents.find((i) => i.kind === "retry");
    expect(retry).toBeDefined();
    expect(retry!.provider).toBe("google");
    expect(retry!.attempt).toBe(1);
    expect(retry!.of).toBe(2);
    expect(retry!.waitMs).toBeGreaterThan(0);
  });
});
