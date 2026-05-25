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
   * Tries exact match first, then prefix match, then falls back to 100k.
   */
  static getContextLimit(model: string): number {
    const limits: Record<string, number> = {
      "claude-sonnet-4-20250514": 200000,
      "claude-haiku-4-5-20251001": 200000,
      "claude-opus-4-20250514": 200000,
      "gpt-4o": 128000,
      "gpt-4o-mini": 128000,
      "deepseek/deepseek-v4-flash:free": 128000,
      "gemini-2.5-flash": 1048576,
    };

    // Try exact match
    if (limits[model]) return limits[model];

    // Try prefix match (e.g. "claude-sonnet" matches "claude-sonnet-4-...")
    for (const [key, val] of Object.entries(limits)) {
      if (model.startsWith(key.split("-").slice(0, 2).join("-"))) return val;
    }

    return 100000; // safe default
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
