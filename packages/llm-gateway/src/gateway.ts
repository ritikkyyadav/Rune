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
        await this.backoff(attempt);
      }
    }

    throw lastError ?? new Error("Inference failed");
  }

  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    const provider = this.resolveProvider(request.provider);
    let lastError: Error | undefined;

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
        if (!this.shouldRetry(err as Error, attempt)) break;
        await this.backoff(attempt);
      }
    }

    yield { type: "error", error: lastError?.message ?? "Stream failed" };
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
    // Don't retry client errors (4xx) except 429
    const status = (err as unknown as Record<string, unknown>).status as number | undefined;
    if (status && status >= 400 && status < 500 && status !== 429) return false;
    return true;
  }

  private async backoff(attempt: number): Promise<void> {
    const ms = this.config.retryBaseMs * Math.pow(2, attempt);
    const jitter = Math.random() * ms * 0.1;
    await new Promise((resolve) => setTimeout(resolve, ms + jitter));
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
