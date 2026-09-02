/**
 * WHICH provider the gateway hands the work to when the active one dies.
 *
 * `getFallbackProviders` used to return raw Map insertion order — the order
 * `buildGateway` happened to walk PROVIDER_PRESETS, which is a display list.
 * Registration order carries no information about what a handover COSTS, so a
 * capped frontier session handed a deep code audit to a free model purely
 * because openrouter sat next in the table. Recorded, on a real run:
 *
 *   codex/gpt-5.6-sol → openrouter: 429 The usage limit has been reached
 *   openrouter/minimax-m3:free — Insufficient balance (402)
 *   openrouter → google
 *
 * Ranking is by CAPACITY (funded → subscription → free → local), which is a
 * structural fact about the account, rather than by model strength, which rots.
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
import {
  providerFallbackRank,
  normalizeFallbackOrder,
} from "../../../packages/shared/src/providers";

class Stub implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: ProviderName,
    private readonly mode: "ok" | "cap" = "ok",
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.mode === "cap") {
      // A plain THROTTLE, not a plan cap. Ranking decides who inherits a
      // fallback-eligible failure; a quota cap now ends the run instead of
      // falling back at all (quota-stop.test.ts), so using one here would
      // test the wrong thing.
      throw new ApiError({
        status: 429,
        provider: this.name,
        message: "Too many requests, slow down",
      });
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

/** Register in a deliberately BAD order so insertion order can't accidentally pass. */
function gatewayWith(names: ProviderName[], capped: ProviderName, fallbackOrder?: ProviderName[]) {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: capped,
    maxRetries: 0,
    retryBaseMs: 1,
    // Ranking documents the SUBSTITUTE chain, which is now the explicit flex
    // opt-in (model integrity pins by default — see model-pin.test.ts).
    modelIntegrity: "flex",
    ...(fallbackOrder ? { fallbackOrder } : {}),
  });
  const stubs = new Map<ProviderName, Stub>();
  for (const n of names) {
    const s = new Stub(n, n === capped ? "cap" : "ok");
    stubs.set(n, s);
    gw.registerProvider(s);
  }
  return { gw, stubs };
}

const req = (provider: ProviderName): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "m",
  provider,
  maxTokens: 10,
  stream: true,
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const fallbackTo = (events: StreamEvent[]) =>
  events
    .filter((e): e is Extract<StreamEvent, { type: "fallback" }> => e.type === "fallback")
    .map((e) => e.to.provider);

describe("capacity ranking", () => {
  test("funded outranks free, subscription, and local", () => {
    expect(providerFallbackRank("anthropic")).toBeLessThan(providerFallbackRank("codex"));
    expect(providerFallbackRank("codex")).toBeLessThan(providerFallbackRank("openrouter"));
    expect(providerFallbackRank("openrouter")).toBeLessThan(providerFallbackRank("ollama"));
  });

  test("an unknown provider ranks as free, never above funded", () => {
    // Pessimistic on purpose: a provider added to the presets without a
    // capacity entry must not silently outrank a funded key.
    expect(providerFallbackRank("brand-new-host")).toBeGreaterThan(
      providerFallbackRank("anthropic"),
    );
    expect(providerFallbackRank("brand-new-host")).toBe(providerFallbackRank("openrouter"));
  });

  test("every registered provider name has a capacity entry", () => {
    // The table must not drift behind the ProviderName union.
    const names = [
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "ollama-turbo",
      "google",
      "groq",
      "xai",
      "deepseek",
      "codex",
      "custom",
    ];
    for (const n of names) {
      expect(normalizeFallbackOrder([n]).unknown).toEqual([]);
    }
  });
});

describe("the chain the gateway actually walks", () => {
  test("a capped subscription falls to the funded key, not the free tier", async () => {
    // Registration order puts the free provider FIRST — the exact shape that
    // sent a real audit to a free model.
    const { gw, stubs } = gatewayWith(["openrouter", "google", "codex"], "codex");
    const events = await drain(gw.inferStream(req("codex")));

    expect(fallbackTo(events)[0]).toBe("google");
    expect(stubs.get("google")!.calls).toBe(1);
    expect(stubs.get("openrouter")!.calls).toBe(0);
  });

  test("local runtimes are the last resort, below free", async () => {
    const { gw } = gatewayWith(["ollama", "openrouter", "codex"], "codex");
    const events = await drain(gw.inferStream(req("codex")));
    expect(fallbackTo(events)[0]).toBe("openrouter");
  });

  test("registration order still breaks ties inside one capacity class", async () => {
    // google and groq are both funded; the one registered first wins, so a
    // user's own ordering is preserved where the ranking is indifferent.
    const { gw } = gatewayWith(["groq", "google", "codex"], "codex");
    const events = await drain(gw.inferStream(req("codex")));
    expect(fallbackTo(events)[0]).toBe("groq");
  });

  test("the primary is always tried first, whatever its rank", async () => {
    // openrouter is the lowest-ranked cloud class, but it is what was asked
    // for — ranking governs the FALLBACK, never the user's actual choice.
    const { gw, stubs } = gatewayWith(["anthropic", "openrouter"], "openrouter");
    await drain(gw.inferStream(req("openrouter")));
    expect(stubs.get("openrouter")!.calls).toBe(1);
  });
});

describe("[fallback] order override", () => {
  test("named providers are tried before any ranked one", async () => {
    const { gw } = gatewayWith(["google", "openrouter", "codex"], "codex", ["openrouter"]);
    const events = await drain(gw.inferStream(req("codex")));
    // openrouter is free-tier and would normally lose to funded google.
    expect(fallbackTo(events)[0]).toBe("openrouter");
  });

  test("omitting a provider deprioritizes it — it is not excluded", async () => {
    // A degraded answer beats a dead run, and the degradation is now labelled.
    const { gw } = gatewayWith(["google", "codex"], "codex", ["openrouter"]);
    const events = await drain(gw.inferStream(req("codex")));
    expect(fallbackTo(events)[0]).toBe("google");
  });

  test("the override respects the order it was written in", async () => {
    const { gw } = gatewayWith(["google", "openrouter", "ollama", "codex"], "codex", [
      "ollama",
      "openrouter",
    ]);
    const events = await drain(gw.inferStream(req("codex")));
    expect(fallbackTo(events)[0]).toBe("ollama");
  });
});

describe("normalizeFallbackOrder", () => {
  test("keeps known ids in order", () => {
    expect(normalizeFallbackOrder(["codex", "anthropic"]).order).toEqual(["codex", "anthropic"]);
  });

  test("reports unknown ids instead of silently dropping them", () => {
    // A typo doing nothing quietly is what makes people distrust a knob.
    const r = normalizeFallbackOrder(["anthropic", "anthropik"]);
    expect(r.order).toEqual(["anthropic"]);
    expect(r.unknown).toEqual(["anthropik"]);
  });

  test("dedupes, trims, and survives junk values", () => {
    const r = normalizeFallbackOrder([" codex ", "codex", "", 7, null, undefined]);
    expect(r.order).toEqual(["codex"]);
  });

  test("absent config yields an empty list, not a crash", () => {
    expect(normalizeFallbackOrder(undefined).order).toEqual([]);
  });
});
