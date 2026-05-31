// ─── Message Format ───

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      toolCallId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolResultContent: string;
      isError?: boolean;
    }
  | { type: "image"; mediaType: string; data: string };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Provider Names ───

export type ProviderName = "anthropic" | "openai" | "openrouter" | "ollama" | "google";

// ─── Inference Request ───

export interface CacheControlHint {
  index: number;
  type: "ephemeral";
}

export interface ResponseFormat {
  type: "json_schema";
  jsonSchema: Record<string, unknown>;
}

export interface InferenceRequest {
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  model: string;
  provider: ProviderName;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  cacheControl?: CacheControlHint[];
  responseFormat?: ResponseFormat;
  stream: boolean;
}

// ─── Inference Response (non-streaming) ───

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface InferenceResponse {
  id: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
}

// ─── Streaming Events ───

export type StreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "content_start"; contentIndex: number }
  | { type: "content_delta"; contentIndex: number; delta: { type: "text_delta"; text: string } }
  | { type: "content_stop"; contentIndex: number }
  | { type: "tool_use_start"; toolCallId: string; toolName: string }
  | { type: "tool_use_delta"; toolCallId: string; partialJson: string }
  | { type: "tool_use_stop"; toolCallId: string; toolInput: Record<string, unknown> }
  | { type: "message_stop"; stopReason: StopReason; usage: TokenUsage }
  | { type: "notice"; message: string }
  | { type: "error"; error: string };

// ─── Provider Adapter Interface ───

export interface StreamOpts {
  signal?: AbortSignal;
}

export interface LlmProvider {
  name: ProviderName;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent>;
  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;
  healthCheck(): Promise<boolean>;
}

// ─── Cost Tracking ───

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  o3: { inputPerMillion: 10, outputPerMillion: 40 },
  // OpenRouter model IDs
  "anthropic/claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "openai/gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  // Google Gemini (free tier = $0, but track usage for when paid tier is used)
  "gemini-2.5-flash": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // OpenRouter free models (actual cost is $0 but track usage)
  "deepseek/deepseek-v4-flash:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek/deepseek-r1:free": { inputPerMillion: 0, outputPerMillion: 0 },
};

export interface CostEntry {
  model: string;
  provider: ProviderName;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: Date;
}

export interface CostLedger {
  entries: CostEntry[];
  totalCostUsd: number;
}

// ─── Gateway Config ───

export interface GatewayConfig {
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  defaultProvider: ProviderName;
  maxRetries: number;
  retryBaseMs: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
}

// ─── Structured API Error ───

export class ApiError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly retryAfterMs: number | null;

  constructor(opts: { status: number; provider: string; message: string; retryAfterMs?: number }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function parseApiErrorBody(
  body: string,
  status: number,
  provider: string,
): ApiError {
  let message = `${provider} API error (${status})`;
  let retryAfterMs: number | undefined;

  try {
    const json = JSON.parse(body);
    const err = json.error ?? json;
    if (err.message) {
      // Extract just the first line/sentence
      const raw: string = err.message;
      const firstLine = raw.split("\n")[0].slice(0, 200);
      message = firstLine;
    }
    // Google puts retryDelay in details
    const retryInfo = err.details?.find?.(
      (d: Record<string, unknown>) =>
        (d["@type"] as string)?.includes("RetryInfo"),
    );
    if (retryInfo?.retryDelay) {
      const secs = parseFloat(retryInfo.retryDelay);
      if (!isNaN(secs)) retryAfterMs = secs * 1000;
    }
  } catch {
    // Not JSON — use first 100 chars of body
    message = body.slice(0, 100);
  }

  return new ApiError({ status, provider, message, retryAfterMs });
}
