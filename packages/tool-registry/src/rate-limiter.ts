// ─── The tool pacer ───
//
// This began as a rate LIMITER with defaults tuned for a chatbot: 20 calls
// per tool per minute, 10 bash, 60 in total. A refusal reached the model as
// an error — `Rate limit exceeded for "read_file". Retry after 88ms` — and
// cost a completion to re-issue a read the engine had throttled itself; 29
// such refusals in one afternoon, while the batching nudge was asking the
// same model to issue MORE reads at once. An agent is not a chatbot.
//
// It is a pacer now. Read-category tools are never limited (reading is cheap
// and safe, and batched reads are the whole point). A call over the limit is
// held for the short remainder of its window — the model never sees a pace —
// and only refused when the wait would exceed `maxWaitMs`. The defaults are
// generous; the limits exist for the runaway case the loop guards already
// bound, not for ordinary work.

export interface RateLimitConfig {
  globalMaxPerMinute: number;
  perToolMaxPerMinute: number;
  bashMaxPerMinute: number;
  writeMaxPerMinute: number;
  /** Longest wait the pacer absorbs before a call is refused, in ms. */
  maxWaitMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  globalMaxPerMinute: 600,
  perToolMaxPerMinute: 120,
  bashMaxPerMinute: 60,
  writeMaxPerMinute: 60,
  maxWaitMs: 5_000,
};

/** Tool categories the pacer never touches. */
export const PACER_EXEMPT_CATEGORIES: ReadonlySet<string> = new Set(["read"]);

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

export class ToolRateLimiter {
  private calls = new Map<string, number[]>();
  private globalCalls: number[] = [];
  private config: RateLimitConfig;
  /** Names seen with an exempt category; their calls are never counted. */
  private exempt = new Set<string>();
  private readonly now: () => number;

  constructor(config: Partial<RateLimitConfig> = {}, opts: { now?: () => number } = {}) {
    const clean: Partial<RateLimitConfig> = {};
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        clean[k as keyof RateLimitConfig] = v;
      }
    }
    this.config = { ...DEFAULT_RATE_LIMIT, ...clean };
    this.now = opts.now ?? (() => Date.now());
  }

  get maxWaitMs(): number {
    return this.config.maxWaitMs;
  }

  checkLimit(toolName: string, category?: string): RateLimitDecision {
    if (category !== undefined && PACER_EXEMPT_CATEGORIES.has(category)) {
      this.exempt.add(toolName);
      return { allowed: true };
    }
    if (this.exempt.has(toolName)) return { allowed: true };

    const now = this.now();
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
        : category === "write" || WRITE_TOOLS.has(toolName)
          ? this.config.writeMaxPerMinute
          : this.config.perToolMaxPerMinute;

    if (toolCalls.length >= limit) {
      return { allowed: false, retryAfterMs: toolCalls[0] + 60_000 - now };
    }
    return { allowed: true };
  }

  recordCall(toolName: string): void {
    if (this.exempt.has(toolName)) return;
    const now = this.now();
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
    const now = this.now();
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

/** What the engine does with a call: run it, hold it briefly, or refuse it. */
export type PaceDecision =
  { kind: "allow" } | { kind: "wait"; waitMs: number } | { kind: "refuse"; waitMs: number };

/**
 * The one decision the engine makes before a tool runs. A wait is absorbed
 * (the model never learns of it); a refusal is the old behaviour, kept only
 * for a wait longer than the limiter's `maxWaitMs`.
 */
export function resolveRateLimit(
  limiter: ToolRateLimiter,
  toolName: string,
  category?: string,
): PaceDecision {
  const r = limiter.checkLimit(toolName, category);
  if (r.allowed) return { kind: "allow" };
  const waitMs = Math.max(1, Math.ceil(r.retryAfterMs ?? 0));
  return waitMs <= limiter.maxWaitMs ? { kind: "wait", waitMs } : { kind: "refuse", waitMs };
}

/** `[tools] rateLimit` as written in config.toml. */
export interface RateLimitSettings {
  enabled?: boolean;
  globalPerMinute?: number;
  perToolPerMinute?: number;
  bashPerMinute?: number;
  writePerMinute?: number;
  maxWaitMs?: number;
}

/** Config names → limiter names; anything that is not a positive finite number is dropped. */
export function rateLimitFromConfig(c?: RateLimitSettings): Partial<RateLimitConfig> {
  if (!c) return {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const out: Partial<RateLimitConfig> = {};
  const g = num(c.globalPerMinute);
  const p = num(c.perToolPerMinute);
  const b = num(c.bashPerMinute);
  const w = num(c.writePerMinute);
  const m = num(c.maxWaitMs);
  if (g !== undefined) out.globalMaxPerMinute = g;
  if (p !== undefined) out.perToolMaxPerMinute = p;
  if (b !== undefined) out.bashMaxPerMinute = b;
  if (w !== undefined) out.writeMaxPerMinute = w;
  if (m !== undefined) out.maxWaitMs = m;
  return out;
}
