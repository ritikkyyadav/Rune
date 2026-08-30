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
  // Opaque provider reasoning state that must round-trip verbatim within a
  // tool-use loop (Anthropic redacted-thinking; Codex/Responses reasoning items
  // with encrypted_content). `provider` tags the ORIGIN so a block is only ever
  // replayed back to the same provider — every other provider drops it, so
  // switching providers mid-conversation can never leak one provider's opaque
  // state into another's request. Absent = legacy Anthropic (its own block).
  | { type: "redacted_thinking"; data: string; provider?: string };

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

/**
 * Reasoning depth, in the vocabulary the backends actually use.
 *
 * Measured against the ChatGPT/Codex Responses backend on 2026-08-30 — it
 * validates the field and names the set in its own 400:
 *   "Supported values are: 'none', 'minimal', 'low', 'medium', 'high',
 *    'xhigh', and 'max'."
 * Per-model subsets exist (gpt-5.6-sol rejects 'minimal'), so providers clamp;
 * see `codexEffortFor`. Gear previously topped out at "high" and never sent the
 * field to Codex at all, which pinned every ChatGPT-subscription session to the
 * server default while `max` sat unreachable.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  // Subscription-backed transports (own endpoints, not the vendor's public API):
  // GitHub Copilot and the ChatGPT-backend Codex "responses" API.
  | "copilot"
  | "codex"
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
 * Providers whose wire format cannot carry an image block. Ollama's native
 * `/api/chat` translation understands text and tool calls only, so an image
 * block sent there is silently dropped — and a silently dropped screenshot is
 * worse than none, because the agent believes it looked. Everything else routes
 * through the Anthropic, OpenAI-compatible, Google, or Codex translations, all
 * of which encode images.
 *
 * This is a claim about the TRANSPORT, not about the model: an
 * OpenAI-compatible endpoint serving a text-only checkpoint will accept the
 * block and ignore it. The transport is the part the harness can actually know.
 */
const IMAGE_BLIND_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(["ollama"]);

export function providerCarriesImages(provider: ProviderName): boolean {
  return !IMAGE_BLIND_PROVIDERS.has(provider);
}

/**
 * The reasoning depths a given provider+model actually accepts, or [] where the
 * dial does not exist.
 *
 * Provider wire knowledge, so it lives here rather than in the picker that
 * renders it — the engine needs the same answer to decide whether "depth" is
 * even a meaningful thing to show for the current model.
 *
 * Codex values are MEASURED against the live ChatGPT backend (2026-08-30),
 * which validates the field and 400s on anything the model rejects. The OpenAI
 * API path is deliberately narrower: low/medium/high are known-good there and
 * xhigh/max have not been probed on that endpoint. Anthropic and Google honour
 * no effort field at all (they approximate depth by thinking budget), so they
 * return [] and no control is offered for them anywhere.
 *
 * `none` and `minimal` are never listed: `none` is the internal value for
 * thinking-off, and `minimal` is rejected by the gpt-5.6 line.
 */
export function reasoningEffortsFor(provider: string, model: string): ReasoningEffort[] {
  const m = model.toLowerCase();
  if (provider === "codex") {
    if (/^gpt-5\.6/.test(m)) return ["low", "medium", "high", "xhigh", "max"];
    return ["low", "medium", "high"];
  }
  if (provider === "openai" && /^(gpt-5|o[134])(-|:|$)/.test(m)) {
    return ["low", "medium", "high"];
  }
  return [];
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
  /**
   * Cancels the in-flight HTTP request (non-streaming path). The Auto-mode
   * reviewer aborts on its decision timeout so a late reply stops billing the
   * provider instead of completing into the void. The gateway never retries
   * an aborted request.
   */
  signal?: AbortSignal;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  cacheControl?: CacheControlHint[];
  /**
   * Index of the last message that will recur BYTE-IDENTICALLY on the next
   * request — i.e. the end of the cacheable prefix. Everything after it is
   * ephemeral: rebuilt per request and never stored (today, the task-state
   * spine block the agent loop appends).
   *
   * Providers place their conversation cache breakpoint here. Placing it on
   * the final message instead — the obvious-looking choice — writes a cache
   * entry keyed on content that never repeats, so every turn pays to write a
   * prefix no later turn can read. Omit when the whole array is stable.
   */
  cacheBreakpointIndex?: number;
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
   *
   * `effort` maps to the provider's reasoning-depth dial where one exists
   * (OpenAI `reasoning_effort`; others approximate via budget). Agentic work
   * defaults to "high": shallow reasoning is how tasks get half-done fast.
   */
  thinking?: { enabled: boolean; budgetTokens?: number; effort?: ReasoningEffort };
  stream: boolean;
}

// ─── Inference Response (non-streaming) ───

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

/**
 * Provider-reported token usage for one request.
 *
 * THE CONTRACT — the three input fields are DISJOINT, and the total input a
 * request consumed is their sum:
 *
 *     total input = inputTokens + cacheReadTokens + cacheCreationTokens
 *
 * This is Anthropic's native shape, and every other transport normalizes to
 * it. That matters because the two consumers pull in opposite directions:
 * ContextEngine.noteRealUsage sums all three to get window occupancy, while
 * CostTracker prices each at its own rate. A field that means "total" to one
 * and "fresh" to the other silently breaks both.
 *
 * OpenAI-family and Google APIs report the opposite shape — their prompt
 * token count INCLUDES the cached portion — so their adapters must subtract
 * before filling these fields. Getting that wrong double-counts the cache and
 * compacts the conversation at a fraction of the real window.
 */
export interface TokenUsage {
  /** Fresh input tokens, billed at full rate. EXCLUDES anything cached. */
  inputTokens: number;
  outputTokens: number;
  /** Input served from a warm cache, billed at a discount. */
  cacheReadTokens?: number;
  /** Input written INTO the cache, billed at a premium (Anthropic only). */
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
  // Opaque provider reasoning state that must round-trip untouched. `provider`
  // tags the origin so it's only ever replayed to the same provider.
  | { type: "redacted_thinking"; data: string; provider?: string }
  | { type: "tool_use_start"; toolCallId: string; toolName: string }
  | { type: "tool_use_delta"; toolCallId: string; partialJson: string }
  | { type: "tool_use_stop"; toolCallId: string; toolInput: Record<string, unknown> }
  | { type: "message_stop"; stopReason: StopReason; usage: TokenUsage }
  | { type: "notice"; message: string }
  // The gateway abandoned `from` and is about to stream from `to` instead.
  // Structured (provider/model/status/backoff) so UIs can render a real
  // fallback banner instead of regex-parsing an English sentence. Emitted in
  // place of the old prose notice; informational, never terminal — the turn
  // continues on `to` and nothing already streamed is lost (a stream_reset
  // precedes this event when a partial response must be discarded).
  | {
      type: "fallback";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      /** HTTP status that triggered the switch, when one exists (e.g. 429). */
      status?: number;
      /** Short human reason, e.g. "rate limited" or "invalid API key". */
      reason?: string;
      /** Providers remaining after `to`, for rendering the full chain. */
      chain?: string[];
    }
  // The in-flight response was abandoned mid-stream (provider error after
  // partial output) and will be re-streamed from scratch — consumers MUST
  // discard everything accumulated for the current assistant message, or the
  // retry duplicates text and tool calls in the transcript.
  | { type: "stream_reset" }
  // The same provider is about to be re-tried after a transient failure.
  // Emitted BEFORE the backoff sleep, so the surface can say why it is about
  // to go quiet for `waitMs` instead of looking wedged. A retry that never
  // reaches a UI is a lie of omission about how long the turn took and how
  // reliable the run was, which is why this is a first-class event and not a
  // log line. A `stream_reset` precedes it when partial output must be dropped.
  | {
      type: "retry";
      provider: string;
      model: string;
      /** 1-based: this is retry `attempt` of `of`. */
      attempt: number;
      of: number;
      /** HTTP status that triggered it, when there is one. */
      status?: number;
      /** How long the gateway is about to wait, before jitter. */
      waitMs: number;
      /** Short human reason, e.g. "rate limited". */
      reason?: string;
    }
  // `retryable: false` marks a terminal failure (bad key, no credits, every
  // provider rate-limited) that re-running won't fix — the agent loop surfaces
  // it immediately instead of retrying through maxConsecutiveErrors.
  | { type: "error"; error: string; retryable?: boolean };

// ─── Provider Adapter Interface ───

export interface StreamOpts {
  signal?: AbortSignal;
}

/** A model exposed by a provider's discovery endpoint (or its static preset list). */
export interface ModelInfo {
  id: string;
  /** Human label if the provider supplies one; otherwise the id. */
  label?: string;
  /** True when this came from the provider's live endpoint vs. a static fallback. */
  live?: boolean;
  /**
   * The model's real context window, when the provider's catalog reports one.
   * Authoritative — the orchestrator's static family table is only a guess for
   * models it happens to recognize, and guesses low (100k) for everything else.
   * A too-low guess makes compaction fire on a model that had room to spare.
   */
  contextLimit?: number;
}

export interface LlmProvider {
  name: ProviderName;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent>;
  countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;
  healthCheck(): Promise<boolean>;
  /**
   * OPTIONAL live model discovery. Implemented by adapters with a real listing
   * endpoint (Ollama /api/tags, OpenAI-compat /v1/models, …). Optional so every
   * existing adapter compiles untouched; callers fall back to the static preset
   * `models` list when this is absent or throws.
   */
  listModels?(): Promise<ModelInfo[]>;

  /**
   * OPTIONAL single-model lookup, for hosts whose listing endpoint omits the
   * detail a caller actually needs.
   *
   * Exists because Ollama's /api/tags returns names only, while /api/show
   * returns the real context length — but only one model at a time. Asking for
   * the one model in play is a single cheap request; listing then describing
   * every installed model to learn one number is not. Callers fall back to
   * listModels() when this is absent, and to the static table when both are.
   */
  describeModel?(id: string): Promise<ModelInfo | null>;
}

// ─── Cost Tracking ───

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * Rate for input served from cache. Absent means "10% of input" — true for
   * Anthropic and the GPT-5 family. Models that discount differently (GPT-4o
   * at 50%, Gemini at 25%) MUST state it, or the meter overstates the saving.
   */
  cacheReadPerMillion?: number;
  /** Rate for input written into the cache. Anthropic only; 1.25x input. */
  cacheWritePerMillion?: number;
  /**
   * True when the rate is inferred rather than taken from a published price
   * list — unreleased models, open-weight models with no first-party rate.
   * Surfaced as a "~" in every readout: a meter that hides its own
   * uncertainty is the problem this table was built to fix.
   */
  estimated?: boolean;
}

/** Multiplier applied to input rate when a model states no cache-read rate. */
export const DEFAULT_CACHE_READ_RATIO = 0.1;
/** Multiplier applied to input rate when a model states no cache-write rate. */
export const DEFAULT_CACHE_WRITE_RATIO = 1.25;

/**
 * How the tokens were actually paid for. Pricing says what a model's tokens
 * are WORTH; this says whether a dollar left the building. A subscription
 * seat and a free tier both cost $0 at the margin, and conflating that with
 * "we don't know the price" is exactly the blindness this table fixes.
 */
export type BillingMode = "metered" | "subscription" | "free";

/**
 * Resolve billing mode from the account the request is spent against.
 *
 * Deliberately keyed on provider + model id rather than the pricing table:
 * the same model is metered on one account and free on another
 * (gemini-2.5-flash on a paid key vs the free tier), so this is a property of
 * how it was bought, never of what it is.
 */
export function billingModeFor(provider: string, model: string): BillingMode {
  // Deliberately NOT derived from PROVIDER_CAPACITY in @gear/shared, which
  // looks like the same table and is not. That map ranks rate-limit headroom
  // for fallback ordering, and marks openrouter "free" — true of its free
  // pool, false of the paid models on the same account. Billing has to be
  // decided per request, so it lives here.

  // The free pool advertises itself in the id. Checked FIRST: a ":free" model
  // is free on any provider that serves it.
  if (model.endsWith(":free")) return "free";
  // Subscription transports: a plan the user already pays for monthly. The
  // tokens are real; the marginal dollar is zero.
  if (provider === "codex" || provider === "copilot" || provider === "ollama-turbo") {
    return "subscription";
  }
  // Local runtimes cost electricity, not API dollars.
  if (provider === "ollama" || provider === "lmstudio") return "free";
  return "metered";
}

/**
 * List rates, US dollars per million tokens.
 *
 * These state what a model's tokens are WORTH, never what was paid — a model
 * on a subscription seat keeps its real rate here and is zeroed at record()
 * time via billingModeFor(). That split is what lets the meter answer both
 * "what did this cost me?" and "what would this have cost metered?" — the
 * second being the only number that compares to a competitor.
 *
 * Entries flagged `estimated` are inferred from comparable models because no
 * first-party price list exists (unreleased ids, open-weight models served by
 * many hosts at different rates). They are marked in every readout.
 *
 * Coverage is checked by a test against the provider catalog: a model users
 * can select but the meter cannot price is a reporting hole, and the previous
 * table had 21 of them — including the three that carried most traffic.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ─── Anthropic — current generation ───
  // Cache reads at 10% and writes at 125% are the standard Anthropic terms,
  // so these take the defaults rather than restating them per row.
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-mythos-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  // ─── Anthropic — legacy ───
  "claude-3.5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // ─── OpenAI ───
  // The GPT-5 line discounts cached input to 10%; GPT-4o only to 50%, which
  // is why those rows state it and the GPT-5 rows do not.
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075 },
  o3: { inputPerMillion: 2, outputPerMillion: 8 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  // Codex-plan models. Reached through a ChatGPT subscription, so the marginal
  // cost is zero — but they are priced at the GPT-5 line's rates so the "what
  // would this have cost metered?" column is real. Estimated until published.
  "gpt-5.5": { inputPerMillion: 1.25, outputPerMillion: 10, estimated: true },
  "gpt-5.6-sol": { inputPerMillion: 1.25, outputPerMillion: 10, estimated: true },
  "gpt-5.6-terra": { inputPerMillion: 1.25, outputPerMillion: 10, estimated: true },
  "gpt-5.6-luna": { inputPerMillion: 1.25, outputPerMillion: 10, estimated: true },

  // ─── DeepSeek ───
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1, cacheReadPerMillion: 0.07 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  "deepseek-coder-v2": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  deepseek: { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },

  // ─── xAI ───
  "grok-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "grok-4-fast": { inputPerMillion: 0.2, outputPerMillion: 0.5 },
  "grok-code-fast-1": { inputPerMillion: 0.2, outputPerMillion: 1.5 },

  // ─── Google Gemini ───
  // Gemini discounts cached input to 25%, not the 10% default.
  "gemini-2.5-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.0375,
  },
  "gemini-2.5-pro": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.3125,
  },
  "gemini-2.0-flash": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
  },
  "gemini-2.0-flash-001": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
  },

  // ─── Open-weight coder models ───
  // Served by many hosts at different rates; these are mid-market estimates so
  // the metered-equivalent column is populated rather than silently zero.
  "qwen3-coder:480b": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "qwen3-coder-next": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "qwen2.5-coder": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },
  "qwen2.5-coder:32b": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },
  "glm-4.7": { inputPerMillion: 0.6, outputPerMillion: 2.2, estimated: true },
  "minimax-m3": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "gpt-oss:120b": { inputPerMillion: 0.1, outputPerMillion: 0.5, estimated: true },
  "gpt-oss:20b": { inputPerMillion: 0.05, outputPerMillion: 0.2, estimated: true },
  "openai/gpt-oss-120b": { inputPerMillion: 0.1, outputPerMillion: 0.5, estimated: true },
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79, estimated: true },
  "llama3.1": { inputPerMillion: 0.05, outputPerMillion: 0.08, estimated: true },
  "nemotron-3-ultra": { inputPerMillion: 0.6, outputPerMillion: 1.8, estimated: true },
  "nemotron-3-super": { inputPerMillion: 0.3, outputPerMillion: 0.9, estimated: true },
  "nemotron-3-nano:30b": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },
  "gemma4:31b": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },

  // ─── OpenRouter-prefixed ids for the same models ───
  "anthropic/claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "openai/gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
  "qwen/qwen3-coder": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },

  // ─── Zero-rate pools ───
  // A real rate of zero, NOT an unknown one. billingModeFor() reaches the same
  // conclusion from the id; these rows keep the distinction explicit so a
  // ":free" id that later starts charging shows up as a pricing change.
  "qwen/qwen3-coder:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek/deepseek-v4-flash:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek/deepseek-r1:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "minimax/minimax-m3:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "stealth/ox-alpha": { inputPerMillion: 0, outputPerMillion: 0 },
};

export interface CostEntry {
  model: string;
  provider: ProviderName;
  /** Fresh input tokens — see the TokenUsage contract. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Dollars actually spent. Zero on a subscription seat or a free tier. */
  costUsd: number;
  /**
   * What these tokens would have cost metered at list rates. Always computed,
   * even when costUsd is zero — this is the number that compares to a
   * competitor, and the reason the meter exists.
   */
  listCostUsd: number;
  billing: BillingMode;
  /** False when the model is absent from MODEL_PRICING — both figures are 0 and MEANINGLESS. */
  priced: boolean;
  /** True when the rate is inferred rather than published. */
  estimated: boolean;
  timestamp: Date;
}

export interface CostLedger {
  entries: CostEntry[];
  totalCostUsd: number;
  /** Metered-equivalent total across every entry, including free ones. */
  totalListCostUsd: number;
  /**
   * Models seen that MODEL_PRICING could not price. Non-empty means the
   * totals understate reality and the UI must say so rather than print a
   * confident number.
   */
  unpricedModels: string[];
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
  /**
   * Preferred order to fall back through, head-first, overriding the built-in
   * capacity ranking (see providerFallbackRank). Providers left out are not
   * excluded — they follow, in ranked order. Sourced from `[fallback] order`
   * in config.toml.
   */
  fallbackOrder?: ProviderName[];
  /**
   * What to do when a provider reports a PLAN/QUOTA cap ("usage limit
   * reached", weekly caps, exhausted credits) rather than a passing throttle.
   *
   *   "stop"    — end the run with a clear message and the retry window
   *               (default). A frontier model halfway through an extensive task
   *               is not interchangeable with whatever is registered next;
   *               continuing on a weaker one silently produces work the user
   *               did not ask for and cannot tell apart.
   *   "degrade" — the historical behaviour: fall through the chain.
   *
   * Sourced from `[fallback] onQuotaExceeded` in config.toml. This governs CAPS
   * only — an ordinary rate limit still retries and falls back, because it
   * clears in seconds.
   */
  quotaPolicy?: "stop" | "degrade";
}

/** What the gateway reports to the black box (kept provider-agnostic). */
export interface GatewayIncidentEvent {
  kind: "fallback" | "terminal" | "retry";
  provider: string;
  model?: string;
  status?: number;
  message: string;
  /** For kind="fallback": the provider we switched to. */
  fallbackTo?: string;
  /** For kind="retry": which attempt this is, and how long the wait will be.
   *  Carried here as well as on the stream so the non-streaming `infer()`
   *  path — which has no event channel — still reports its retries. */
  attempt?: number;
  of?: number;
  waitMs?: number;
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
