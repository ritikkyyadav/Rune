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
import { cacheBreakpointPolicyFor } from "./cache-policy";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter provider — delegates to OpenAIProvider with OpenRouter's base URL.
 * Supports all models available on OpenRouter (Anthropic, OpenAI, Meta, etc.)
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;
  private inner: OpenAIProvider;
  /**
   * The key this provider was BUILT with. healthCheck() and listModels() used
   * to read `process.env.OPENROUTER_API_KEY` directly, so a key that arrived
   * any other way — the keychain, the OAuth flow OpenRouter documents, `/keys
   * set`, config.toml — produced `Authorization: Bearer undefined`. The health
   * check then failed for a provider that was working, and listModels() fetched
   * the catalog unauthenticated, hiding every model the account can reach.
   */
  private readonly apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.OPENROUTER_API_KEY;
    // The name MUST be forwarded: the inner adapter gates real behaviour on it
    // (vision translation, first-party reasoning params), and it defaults to
    // "openai" — which would make OpenRouter traffic impersonate first-party
    // OpenAI on the wire. Every other openai-compat host passes its own id here.
    this.inner = new OpenAIProvider(
      this.apiKey,
      OPENROUTER_BASE_URL,
      "openrouter",
      // OpenRouter is the one host known to forward Anthropic `cache_control`
      // upstream; declared here rather than sniffed from the base URL.
      { cacheBreakpoints: cacheBreakpointPolicyFor("openrouter") },
    );
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

  /** Authorization header for the key this provider holds, if it has one. */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: this.authHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Live model discovery via OpenRouter's /models catalog, as this account. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`OpenRouter /models failed (${res.status})`);
    const json = (await res.json()) as {
      data?: { id: string; name?: string; context_length?: number }[];
    };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      live: true,
      // The catalog knows every model's real window, including stealth ids the
      // orchestrator's static table can't recognize. Carrying it costs nothing
      // (this fetch already happens) and is the difference between compacting
      // a 256k model at 70k and leaving it alone.
      ...(typeof m.context_length === "number" &&
        m.context_length > 0 && { contextLimit: m.context_length }),
    }));
  }
}
