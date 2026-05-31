import OpenAI from "openai";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  StreamEvent,
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
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        "OpenRouter API key is required. Set OPENROUTER_API_KEY in ~/.alan/.env or via config.toml."
      );
    }
    this.apiKey = key;
    this.inner = new OpenAIProvider(key, OPENROUTER_BASE_URL);
  }

  infer(request: InferenceRequest): Promise<InferenceResponse> {
    return this.inner.infer(request);
  }

  inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    return this.inner.inferStream(request);
  }

  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    return this.inner.countTokens(messages, tools);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
