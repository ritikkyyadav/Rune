import type {
  CostEntry,
  CostLedger,
  GatewayConfig,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  ProviderName,
  StreamEvent,
  StreamOpts,
  TokenUsage,
} from "./types";
import { MODEL_PRICING as PRICING } from "./types";

// Default model for each provider, used during fallback
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "qwen/qwen3-coder:free",
  ollama: "llama3",
};

export class LlmGateway {
  private providers: Map<ProviderName, LlmProvider> = new Map();
  private config: GatewayConfig;
  private ledger: CostLedger = { entries: [], totalCostUsd: 0 };

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  registerProvider(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: ProviderName): LlmProvider | undefined {
    return this.providers.get(name);
  }

  getRegisteredProviderNames(): ProviderName[] {
    return [...this.providers.keys()];
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const provider = this.resolveProvider(request.provider);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await provider.infer(request);
        this.recordCost(request.model, request.provider, response.usage);
        return response;
      } catch (err) {
        lastError = err as Error;
        if (!this.shouldRetry(err as Error, attempt)) break;
        await this.backoff(lastError, attempt);
      }
    }

    throw lastError ?? new Error("Inference failed");
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Build ordered list: requested provider first, then fallbacks
    const fallbackOrder = this.getFallbackProviders(request.provider);

    for (const providerName of fallbackOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Adjust model for fallback providers
      const adjustedRequest =
        providerName === request.provider
          ? request
          : {
              ...request,
              provider: providerName,
              model: PROVIDER_DEFAULT_MODELS[providerName] ?? request.model,
            };

      let lastError: Error | undefined;
      let lastStatus: number | undefined;
      let shouldFallback = false;

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          const gen = provider.inferStream(adjustedRequest, opts);
          for await (const event of gen) {
            if (event.type === "message_stop") {
              this.recordCost(adjustedRequest.model, providerName, event.usage);
            }
            yield event;
          }
          return; // success — done
        } catch (err) {
          lastError = err as Error;
          lastStatus = (err as Record<string, unknown>).status as number | undefined;

          // Auth / billing errors → immediately try fallback provider
          if (lastStatus === 401 || lastStatus === 402 || lastStatus === 403) {
            shouldFallback = true;
            break;
          }
          if (!this.shouldRetry(lastError, attempt)) break;
          await this.backoff(lastError, attempt);
        }
      }

      // Also fallback on 429 after exhausting retries — the model is overloaded
      if (!shouldFallback && lastStatus === 429) {
        shouldFallback = true;
      }

      if (shouldFallback && fallbackOrder.indexOf(providerName) < fallbackOrder.length - 1) {
        const nextProvider = fallbackOrder[fallbackOrder.indexOf(providerName) + 1];
        if (this.providers.has(nextProvider)) {
          const nextModel = PROVIDER_DEFAULT_MODELS[nextProvider] ?? "default";
          // Informational, NOT an error: the agent loop ends the turn on `error`
          // events, so emitting the switch as an error would abandon this
          // generator before the fallback provider streams anything.
          yield {
            type: "notice",
            message: `${providerName}/${adjustedRequest.model} unavailable. Switching to ${nextProvider}/${nextModel}…`,
          };
          continue;
        }
      }

      // No more fallbacks — yield clean final error
      const cleanMsg = lastError?.message?.split("\n")[0]?.slice(0, 150) ?? "Unknown error";

      if (lastStatus === 401 || lastStatus === 403) {
        yield {
          type: "error",
          error: `Auth failed on ${providerName}. Check your API key.`,
        };
      } else if (lastStatus === 402) {
        yield {
          type: "error",
          error: `No credits on ${providerName}. Add billing or switch providers with /model.`,
        };
      } else if (lastStatus === 429) {
        yield {
          type: "error",
          error: `Rate limited on ${providerName}/${adjustedRequest.model}. ${cleanMsg}`,
        };
      } else {
        yield { type: "error", error: cleanMsg };
      }
      return;
    }

    // No providers available at all
    yield {
      type: "error",
      error:
        "No providers available. Set an API key: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY",
    };
  }

  /**
   * Returns an ordered list of providers to try: primary first, then fallbacks.
   */
  private getFallbackProviders(primary: ProviderName): ProviderName[] {
    const all = [...this.providers.keys()];
    // Put primary first, then remaining registered providers
    const rest = all.filter((p) => p !== primary);
    if (this.providers.has(primary)) {
      return [primary, ...rest];
    }
    return rest.length > 0 ? rest : [primary];
  }

  async countTokens(
    provider: ProviderName,
    ...args: Parameters<LlmProvider["countTokens"]>
  ): Promise<number> {
    const p = this.resolveProvider(provider);
    return p.countTokens(...args);
  }

  async healthCheck(provider?: ProviderName): Promise<Record<ProviderName, boolean>> {
    const results: Partial<Record<ProviderName, boolean>> = {};
    const toCheck = provider ? [this.resolveProvider(provider)] : [...this.providers.values()];

    await Promise.all(
      toCheck.map(async (p) => {
        results[p.name] = await p.healthCheck();
      }),
    );
    return results as Record<ProviderName, boolean>;
  }

  getCostLedger(): CostLedger {
    return { ...this.ledger };
  }

  getTotalCost(): number {
    return this.ledger.totalCostUsd;
  }

  // ─── Private ───

  private resolveProvider(name: ProviderName): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider "${name}" not registered`);
    }
    return provider;
  }

  private shouldRetry(err: Error, attempt: number): boolean {
    if (attempt >= this.config.maxRetries) return false;
    const status = (err as unknown as { status?: number }).status;
    // Retry 429 (rate limit) and 5xx errors
    if (status === 429) return true;
    if (status && status >= 500) return true;
    // Don't retry other 4xx
    if (status && status >= 400 && status < 500) return false;
    // Retry network errors
    return true;
  }

  private async backoff(err: Error | undefined, attempt: number): Promise<void> {
    // Check for Retry-After header in error metadata
    let retryAfterMs = 0;
    if (err) {
      const headers = (err as unknown as { headers?: Record<string, string> }).headers;
      const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
      if (retryAfter) {
        retryAfterMs = parseInt(retryAfter, 10) * 1000;
      }
    }
    const baseMs = Math.max(retryAfterMs, this.config.retryBaseMs * Math.pow(2, attempt));
    const jitter = Math.random() * baseMs * 0.1;
    await new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
  }

  private recordCost(model: string, provider: ProviderName, usage: TokenUsage): void {
    const pricing = PRICING[model];
    if (!pricing) return;

    const costUsd =
      (usage.inputTokens * pricing.inputPerMillion) / 1_000_000 +
      (usage.outputTokens * pricing.outputPerMillion) / 1_000_000;

    const entry: CostEntry = {
      model,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      timestamp: new Date(),
    };

    this.ledger.entries.push(entry);
    this.ledger.totalCostUsd += costUsd;
  }
}
