export type ErrorClass =
  | "tool_input_invalid"
  | "tool_exec_failure"
  | "model_output_malformed"
  | "infinite_loop"
  | "context_overflow"
  | "sandbox_violation"
  | "provider_error"
  | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetAfterMs: number;
}

export interface CircuitState {
  failures: number;
  openedAt: number | null;
  state: "closed" | "open" | "half_open";
}

export interface FailoverConfig {
  names: string[];
  config?: Partial<CircuitBreakerConfig>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
};

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetAfterMs: 60_000,
};

export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const status = getStatus(error);
  const lower = message.toLowerCase();

  if (status === 429 || (status !== undefined && status >= 500)) {
    return { class: "provider_error", message, retryable: true, status, cause: error };
  }
  if (status !== undefined && status >= 400) {
    return { class: "provider_error", message, retryable: false, status, cause: error };
  }
  if (lower.includes("validation") || lower.includes("invalid input")) {
    return { class: "tool_input_invalid", message, retryable: false, cause: error };
  }
  if (lower.includes("sandbox") || lower.includes("permission denied")) {
    return { class: "sandbox_violation", message, retryable: false, cause: error };
  }
  if (lower.includes("context") && lower.includes("overflow")) {
    return { class: "context_overflow", message, retryable: true, cause: error };
  }
  if (lower.includes("json") || lower.includes("parse")) {
    return { class: "model_output_malformed", message, retryable: true, cause: error };
  }
  if (lower.includes("loop")) {
    return { class: "infinite_loop", message, retryable: false, cause: error };
  }
  if (lower.includes("tool")) {
    return { class: "tool_exec_failure", message, retryable: true, cause: error };
  }

  return { class: "unknown", message, retryable: true, cause: error };
}

export function retryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponential = policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * Math.random();
  return Math.round(capped + jitter);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const classified = classifyError(error);
      if (!classified.retryable || attempt >= policy.maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, policy)));
    }
  }

  throw lastError;
}

export class CircuitBreaker {
  private current: CircuitState = {
    failures: 0,
    openedAt: null,
    state: "closed",
  };
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  get state(): CircuitState {
    return { ...this.current };
  }

  canExecute(): boolean {
    if (this.current.state !== "open") return true;
    if (this.current.openedAt === null) return false;
    if (Date.now() - this.current.openedAt >= this.config.resetAfterMs) {
      this.current.state = "half_open";
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.current = { failures: 0, openedAt: null, state: "closed" };
  }

  recordFailure(): void {
    this.current.failures += 1;
    if (this.current.failures >= this.config.failureThreshold) {
      this.current.state = "open";
      this.current.openedAt = Date.now();
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error("Circuit breaker is open");
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}

export function createFailoverCircuits(config: FailoverConfig): Map<string, CircuitBreaker> {
  return new Map(config.names.map((name) => [name, new CircuitBreaker(config.config)]));
}

function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const maybeStatus = (error as { status?: unknown; code?: unknown }).status;
  if (typeof maybeStatus === "number") return maybeStatus;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "number" ? maybeCode : undefined;
}
