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
  | { type: "image"; mediaType: string; data: string }
  // Extended/adaptive thinking. Blocks MUST be preserved in the assistant
  // message and replayed verbatim (signature included) on the next request of
  // a tool-use loop — Anthropic rejects modified or missing thinking blocks
  // when thinking is enabled. Providers that don't understand thinking skip
  // these blocks during conversion.
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };

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

export type ProviderName =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "ollama-turbo"
  | "lmstudio"
  | "google"
  | "groq"
  | "xai"
  | "deepseek"
  | "custom";

/**
 * Providers that can run web search server-side (the model grounds itself on
 * fresh results during generation). For these, the engine enables native
 * grounding instead of advertising the `web_search` function tool. Other
 * providers fall back to the universal `web_search` tool.
 */
const NATIVE_SEARCH_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
  "google",
  "anthropic",
]);

export function providerSupportsNativeSearch(provider: ProviderName): boolean {
  return NATIVE_SEARCH_PROVIDERS.has(provider);
}

/**
 * Providers whose native grounding CANNOT share a request with function-calling
 * tools. Gemini treats googleSearch as a "built-in tool" and the API rejects any
 * request that also sends functionDeclarations ("Built-in tools and Function
 * Calling cannot be combined in the same request"). Anthropic, by contrast, runs
 * web_search as a server-side tool that coexists with client function tools.
 */
const GROUNDING_EXCLUDES_TOOLS: ReadonlySet<ProviderName> = new Set<ProviderName>(["google"]);

/**
 * Whether a provider's native grounding can be combined with function-calling
 * tools in the same request. When false (Gemini), grounding is only usable when
 * no function tools are sent, so an agent that needs tools must instead fall back
 * to the universal `web_search` function tool.
 */
export function providerAllowsGroundingWithTools(provider: ProviderName): boolean {
  return !GROUNDING_EXCLUDES_TOOLS.has(provider);
}

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
  /**
   * Enable the provider's native web-search grounding (Gemini googleSearch /
   * Anthropic web_search). Only honored by providers where
   * providerSupportsNativeSearch() is true.
   */
  enableWebSearch?: boolean;
  /**
   * Ask the provider to reason before answering (Anthropic extended/adaptive
   * thinking). Providers pick the right wire form per model — adaptive on
   * models that support it, budgeted extended thinking otherwise — and ignore
   * the flag on models with no thinking support.
   */
  thinking?: { enabled: boolean; budgetTokens?: number };
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
  // Reasoning models stream chain-of-thought separately from the answer; this
  // carries it so the UI can show it dimmed and the agent loop keeps it OUT of
  // the persisted message + tool-call parsing.
  | { type: "thinking_delta"; text: string }
  // A completed thinking block (text + signature). The agent loop stores this
  // in the assistant message so it can be replayed verbatim on the next
  // request — required for Anthropic tool-use loops with thinking enabled.
  | { type: "thinking_stop"; thinking: string; signature?: string }
  // Opaque redacted thinking block — must round-trip untouched.
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use_start"; toolCallId: string; toolName: string }
  | { type: "tool_use_delta"; toolCallId: string; partialJson: string }
  | { type: "tool_use_stop"; toolCallId: string; toolInput: Record<string, unknown> }
  | { type: "message_stop"; stopReason: StopReason; usage: TokenUsage }
  | { type: "notice"; message: string }
  // The in-flight response was abandoned mid-stream (provider error after
  // partial output) and will be re-streamed from scratch — consumers MUST
  // discard everything accumulated for the current assistant message, or the
  // retry duplicates text and tool calls in the transcript.
  | { type: "stream_reset" }
  // `retryable: false` marks a terminal failure (bad key, no credits, every
  // provider rate-limited) that re-running won't fix — the agent loop surfaces
  // it immediately instead of retrying through maxConsecutiveErrors.
  | { type: "error"; error: string; retryable?: boolean };

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
  // Anthropic — current generation
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  // Anthropic — legacy
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  o3: { inputPerMillion: 2, outputPerMillion: 8 },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  // xAI
  "grok-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "grok-4-fast": { inputPerMillion: 0.2, outputPerMillion: 0.5 },
  // OpenRouter model IDs
  "anthropic/claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
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
  /**
   * Black-box tap: called on provider fallbacks and terminal failures so the
   * orchestrator's recorder can count them. Fire-and-forget; the gateway
   * guards every invocation — a throwing handler can never break a stream.
   */
  onIncident?: (incident: GatewayIncidentEvent) => void;
}

/** What the gateway reports to the black box (kept provider-agnostic). */
export interface GatewayIncidentEvent {
  kind: "fallback" | "terminal";
  provider: string;
  model?: string;
  status?: number;
  message: string;
  /** For kind="fallback": the provider we switched to. */
  fallbackTo?: string;
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

export function parseApiErrorBody(body: string, status: number, provider: string): ApiError {
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
    const retryInfo = err.details?.find?.((d: Record<string, unknown>) =>
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
