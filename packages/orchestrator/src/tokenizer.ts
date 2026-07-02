// ─── Token Counting Module ───
// Provides accurate token estimation using word-based heuristics
// with caching for performance.

export class TokenCounter {
  private cache: Map<string, number> = new Map();
  private maxCacheSize = 1000;

  /**
   * Count tokens in the given text using a word-based heuristic.
   * More accurate than the naive `text.length / 4` approach:
   *  - Splits on whitespace to get word count
   *  - Multiplies by ~1.3 to account for subword tokenization
   *  - Counts punctuation/special characters separately (0.5 tokens each)
   *
   * Results are cached for performance.
   */
  countTokens(text: string, _model?: string): number {
    // Check cache first
    const cacheKey = text.length > 200 ? text.slice(0, 100) + text.slice(-100) + text.length : text;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    // Better heuristic: word-based counting
    // Split on whitespace and punctuation, multiply by ~1.3 for subword tokenization
    const words = text.split(/[\s]+/).filter((w) => w.length > 0);
    const punctuation = (text.match(/[{}()\[\]<>:;,."'`!@#$%^&*=+|\\/?~-]/g) || []).length;
    const tokens = Math.ceil(words.length * 1.3 + punctuation * 0.5);

    // Cache the result
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, tokens);
    return tokens;
  }

  /**
   * Get the context window limit for a given model.
   * Exact match first, then model-family substring rules, then a safe default.
   * Values are the model's advertised window; compaction triggers at a
   * fraction of this (shouldCompact's high-water ratio), so being slightly
   * generous is safe while being badly low forces needless compaction.
   */
  static getContextLimit(model: string): number {
    const exact: Record<string, number> = {
      "qwen/qwen3-coder:free": 262144,
      "qwen3-coder:480b": 262144,
    };
    if (exact[model]) return exact[model];

    // Family rules — first match wins. Substring-keyed so provider prefixes
    // ("anthropic/…", "openai/…") and date suffixes don't matter.
    const families: Array<[pattern: string, limit: number]> = [
      // Anthropic: 200k standard across Claude 3.5+ (1M is beta/opt-in)
      ["claude", 200000],
      // OpenAI
      ["gpt-5", 400000],
      ["gpt-4.1", 1000000],
      ["gpt-4o", 128000],
      ["o3", 200000],
      ["o4", 200000],
      // Google
      ["gemini-1.5-pro", 2097152],
      ["gemini", 1048576],
      // Open-weight coder families
      ["qwen3-coder", 262144],
      ["qwen", 131072],
      ["glm-4", 131072],
      ["deepseek", 131072],
      ["kimi", 131072],
      ["llama-3", 131072],
      ["llama3", 8192],
      ["grok", 131072],
    ];
    const lower = model.toLowerCase();
    for (const [pattern, limit] of families) {
      if (lower.includes(pattern)) return limit;
    }

    return 100000; // safe default
  }

  /**
   * Max output tokens a model accepts in one response. Requests above a
   * model's cap are rejected outright by most providers, so the agent loop
   * clamps its configured budget to this before sending.
   */
  static getMaxOutputTokens(model: string): number {
    const families: Array<[pattern: string, limit: number]> = [
      ["claude-3-5", 8192],
      ["claude-haiku", 32000],
      ["claude", 64000],
      ["gpt-5", 128000],
      ["gpt-4.1", 32768],
      ["gpt-4o-mini", 16384],
      ["gpt-4o", 16384],
      ["o3", 100000],
      ["o4", 100000],
      ["gemini-2", 65536],
      ["gemini", 8192],
      ["qwen3-coder", 65536],
      ["qwen", 32768],
      ["glm-4", 32768],
      ["deepseek", 32768],
      ["kimi", 32768],
      ["llama-3", 8192],
      ["llama3", 4096],
      ["grok", 32768],
    ];
    const lower = model.toLowerCase();
    for (const [pattern, limit] of families) {
      if (lower.includes(pattern)) return limit;
    }
    return 8192; // conservative default for unknown models
  }

  /** Clear the token count cache. */
  clearCache(): void {
    this.cache.clear();
  }
}

/** Shared singleton instance for convenience. */
export const tokenCounter = new TokenCounter();

/** Count tokens in text (convenience function using the shared instance). */
export function countTokens(text: string, model?: string): number {
  return tokenCounter.countTokens(text, model);
}

/** Get context window limit for a model (convenience function). */
export function getContextLimit(model: string): number {
  return TokenCounter.getContextLimit(model);
}

/** Max output tokens a model accepts per response (convenience function). */
export function getMaxOutputTokens(model: string): number {
  return TokenCounter.getMaxOutputTokens(model);
}
