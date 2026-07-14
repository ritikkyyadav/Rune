// ─── Token Counting Module ───
// Heuristic estimation, continuously calibrated against the REAL token counts
// providers report in their usage blocks. The estimate only has to be good
// enough to (a) budget prompt assembly before the first provider response and
// (b) rank items for eviction; every compaction *decision* after turn one runs
// on provider-authoritative numbers (ContextEngine.noteRealUsage).

export class TokenCounter {
  private cache: Map<string, number> = new Map();
  private maxCacheSize = 1000;
  // Per-model correction factor learned from provider usage reports
  // (actual / estimated, EMA). Code, JSON, and non-English text all tokenize
  // differently per model family — no static formula gets them all right,
  // but the ratio is stable within a session, so it converges in 1-2 turns.
  private calibrations: Map<string, number> = new Map();
  private activeModel: string | null = null;

  /**
   * Count tokens in the given text.
   *
   * Base heuristic: max(word-based estimate, chars/4). The word formula
   * (words × 1.3 + punctuation × 0.5) tracks prose well but collapses on
   * dense text — a 10KB minified JS line or JSON blob is a handful of
   * "words" yet thousands of tokens. The chars/4 floor bounds that error.
   * Skewing HIGH is the safe direction: the worst case is slightly early
   * compaction, never a provider over-limit rejection.
   *
   * The result is scaled by the model's learned calibration (default 1.0).
   * Raw estimates are cached; calibration is applied per call so a ratio
   * update never serves stale numbers.
   */
  countTokens(text: string, model?: string): number {
    const cacheKey = text.length > 200 ? text.slice(0, 100) + text.slice(-100) + text.length : text;
    let raw = this.cache.get(cacheKey);

    if (raw === undefined) {
      const words = text.split(/[\s]+/).filter((w) => w.length > 0);
      const punctuation = (text.match(/[{}()\[\]<>:;,."'`!@#$%^&*=+|\\/?~-]/g) || []).length;
      raw = Math.max(words.length * 1.3 + punctuation * 0.5, text.length / 4);

      if (this.cache.size >= this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, raw);
    }

    return Math.ceil(raw * this.getCalibration(model));
  }

  /**
   * Feed one (estimated, actual) pair from a real provider response.
   * Ratios are clamped to [0.25, 4] so a mismatched pairing can't poison the
   * factor, and prompts under 500 estimated tokens are ignored (per-request
   * scaffolding overhead dominates small prompts — pure noise).
   */
  noteCalibration(model: string, estimated: number, actual: number): void {
    if (!model || estimated < 500 || actual <= 0) return;
    const ratio = Math.min(4, Math.max(0.25, actual / estimated));
    const prev = this.calibrations.get(model);
    const next = prev === undefined ? ratio : prev + 0.3 * (ratio - prev);
    this.calibrations.set(model, next);
    this.activeModel = model;
  }

  /**
   * The correction factor for a model (1.0 until calibrated). With no model
   * argument, the most recently calibrated model's factor applies — nearly all
   * call sites count text for the active session model without naming it.
   */
  getCalibration(model?: string): number {
    const key = model ?? this.activeModel;
    return (key !== null && this.calibrations.get(key)) || 1;
  }

  /** Pin which model's calibration applies when countTokens gets no model. */
  setActiveModel(model: string): void {
    if (model) this.activeModel = model;
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
      // Opus 4.0 (dated id) and 4.1 cap at 32k; Opus 4.5+ and Sonnet 4.x at 64k.
      ["opus-4-1", 32000],
      ["opus-4-2025", 32000],
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

  /** Forget all learned calibrations (tests; provider-roster resets). */
  resetCalibrations(): void {
    this.calibrations.clear();
    this.activeModel = null;
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
