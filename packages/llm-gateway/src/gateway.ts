import type {
  CostEntry,
  CostLedger,
  GatewayConfig,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  ProviderName,
  StreamEvent,
  TokenUsage,
} from "./types";
import { MODEL_PRICING as PRICING } from "./types";

// Default model for each provider, used during fallback
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "deepseek/deepseek-v4-flash:free",
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

  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
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
          const gen = provider.inferStream(adjustedRequest);
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
        // Try next provider — yield info event about the switch
        const nextProvider = fallbackOrder[fallbackOrder.indexOf(providerName) + 1];
        if (this.providers.has(nextProvider)) {
          yield {
            type: "error",
            error: `${providerName} failed (${lastStatus}): ${lastError?.message ?? ""}. Switching to ${nextProvider}…`,
          };
          continue;
        }
      }

      // No more fallbacks — yield final error
      const providerHints: Record<string, string> = {
        openrouter: "Add credits at https://openrouter.ai/settings/credits",
        anthropic: "Check billing at https://console.anthropic.com/settings/billing",
        openai: "Check billing at https://platform.openai.com/account/billing",
        google: "Check billing at https://console.cloud.google.com/billing",
      };

      if (lastStatus === 401 || lastStatus === 403) {
        yield {
          type: "error",
          error: `Auth error (${lastStatus}) on ${providerName}: ${lastError?.message ?? ""}`,
        };
      } else if (lastStatus === 402) {
        const hint = providerHints[providerName] ?? "Check your provider billing";
        yield {
          type: "error",
          error: `Insufficient credits (${providerName}): ${lastError?.message ?? ""}. ${hint}`,
        };
      } else if (lastStatus === 429) {
        yield {
          type: "error",
          error: `Rate limited after ${this.config.maxRetries + 1} attempts on ${providerName}. Model "${adjustedRequest.model}" is busy.`,
        };
      } else {
        yield { type: "error", error: lastError?.message ?? "Stream failed" };
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
