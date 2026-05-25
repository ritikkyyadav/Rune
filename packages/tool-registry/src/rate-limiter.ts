export interface RateLimitConfig {
  globalMaxPerMinute: number;
  perToolMaxPerMinute: number;
  bashMaxPerMinute: number;
  writeMaxPerMinute: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalMaxPerMinute: 60,
  perToolMaxPerMinute: 20,
  bashMaxPerMinute: 10,
  writeMaxPerMinute: 15,
};

export class ToolRateLimiter {
  private calls = new Map<string, number[]>();
  private globalCalls: number[] = [];
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
  }

  checkLimit(toolName: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const windowStart = now - 60_000;
    this.globalCalls = this.globalCalls.filter((t) => t > windowStart);

    if (this.globalCalls.length >= this.config.globalMaxPerMinute) {
      return { allowed: false, retryAfterMs: this.globalCalls[0] + 60_000 - now };
    }

    const toolCalls = (this.calls.get(toolName) || []).filter((t) => t > windowStart);
    this.calls.set(toolName, toolCalls);

    const limit =
      toolName === "bash"
        ? this.config.bashMaxPerMinute
        : ["write_file", "edit_file"].includes(toolName)
          ? this.config.writeMaxPerMinute
          : this.config.perToolMaxPerMinute;

    if (toolCalls.length >= limit) {
      return { allowed: false, retryAfterMs: toolCalls[0] + 60_000 - now };
    }
    return { allowed: true };
  }

  recordCall(toolName: string): void {
    const now = Date.now();
    this.globalCalls.push(now);
    const arr = this.calls.get(toolName) || [];
    arr.push(now);
    this.calls.set(toolName, arr);
  }

  reset(): void {
    this.calls.clear();
    this.globalCalls = [];
  }

  getStats(): Record<string, number> {
    const now = Date.now();
    const windowStart = now - 60_000;
    const stats: Record<string, number> = {
      _global: this.globalCalls.filter((t) => t > windowStart).length,
    };
    for (const [name, calls] of this.calls) {
      stats[name] = calls.filter((t) => t > windowStart).length;
    }
    return stats;
  }
}
