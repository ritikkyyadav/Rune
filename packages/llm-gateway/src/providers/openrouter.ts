import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  StreamEvent,
  StreamOpts,
  ToolDefinition,
} from "../types";
import { OpenAIProvider } from "./openai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter provider — delegates to OpenAIProvider with OpenRouter's base URL.
 * Supports all models available on OpenRouter (Anthropic, OpenAI, Meta, etc.)
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;
  private inner: OpenAIProvider;

  constructor(apiKey?: string) {
    this.inner = new OpenAIProvider(apiKey ?? process.env.OPENROUTER_API_KEY, OPENROUTER_BASE_URL);
  }

  infer(request: InferenceRequest): Promise<InferenceResponse> {
    return this.inner.infer(request);
  }

  inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    return this.inner.inferStream(request, opts);
  }

  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    return this.inner.countTokens(messages, tools);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Live model discovery via OpenRouter's public /models catalog. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`);
    if (!res.ok) throw new Error(`OpenRouter /models failed (${res.status})`);
    const json = (await res.json()) as { data?: { id: string; name?: string }[] };
    return (json.data ?? []).map((m) => ({ id: m.id, label: m.name ?? m.id, live: true }));
  }
}
