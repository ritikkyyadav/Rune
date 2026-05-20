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
    const provider = this.resolveProvider(request.provider);
    let lastError: Error | undefined;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const gen = provider.inferStream(request);
        for await (const event of gen) {
          if (event.type === "message_stop") {
            this.recordCost(request.model, request.provider, event.usage);
          }
          yield event;
        }
        return;
      } catch (err) {
        lastError = err as Error;
        lastStatus = (err as Record<string, unknown>).status as
          | number
          | undefined;
        // Non-retryable auth errors — surface immediately
        if (lastStatus === 401 || lastStatus === 403) {
          yield {
            type: "error",
            error: `Auth error (${lastStatus}): ${lastError.message ?? ""}`,
          };
          return;
        }
        if (lastStatus === 402) {
          yield {
            type: "error",
            error: `Insufficient credits: ${lastError.message ?? ""}. Add credits at https://openrouter.ai/settings/credits`,
          };
          return;
        }
        if (!this.shouldRetry(lastError, attempt)) break;
        await this.backoff(lastError, attempt);
      }
    }

    // Final error message with actionable advice
    const msg = lastError?.message ?? "Stream failed";
    if (lastStatus === 429) {
      yield {
        type: "error",
        error: `Rate limited after ${this.config.maxRetries + 1} attempts. Model "${request.model}" is busy. Try: alan --model google/gemma-4-31b-it:free`,
      };
    } else {
      yield { type: "error", error: msg };
    }
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
    const toCheck = provider
      ? [this.resolveProvider(provider)]
      : [...this.providers.values()];

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
    const status = (err as unknown as Record<string, unknown>).status as number | undefined;
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
      const headers = (err as Record<string, unknown>).headers as Record<string, string> | undefined;
      const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
      if (retryAfter) {
        retryAfterMs = parseInt(retryAfter, 10) * 1000;
      }
    }
    const baseMs = Math.max(retryAfterMs, this.config.retryBaseMs * Math.pow(2, attempt));
    const jitter = Math.random() * baseMs * 0.1;
    await new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
  }

  private recordCost(
    model: string,
    provider: ProviderName,
    usage: TokenUsage,
  ): void {
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
