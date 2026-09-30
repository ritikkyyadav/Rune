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
 * see `codexEffortFor`. Rune previously topped out at "high" and never sent the
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
  | "google"
  | "groq"
  | "xai"
  | "deepseek"
  // The wider roster (2026-09-06): OpenAI-compatible hosts, each one a preset
  // in @rune/shared. Named here for autocomplete; see the open tail below.
  | "alibaba"
  | "ai21"
  | "baseten"
  | "cerebras"
  | "chutes"
  | "cohere"
  | "deepinfra"
  | "fireworks"
  // `github-models` was here until 2026-09-16; GitHub retired the product on
  // 2026-07-30 (playground, catalog and inference API all at once).
  | "huggingface"
  | "hyperbolic"
  | "inception"
  | "minimax"
  | "mistral"
  | "moonshot"
  | "nebius"
  | "novita"
  | "nvidia"
  | "sambanova"
  | "scaleway"
  | "siliconflow"
  | "together"
  | "vercel"
  | "zai"
  // Subscription-backed transport (its own endpoint, not the vendor's public
  // API): the ChatGPT-backend Codex "responses" API.
  | "codex"
  // ─── Enterprise routes (P10.5) ───
  // The same three model families, reached through a cloud account instead of
  // the vendor's own console: an AWS/GCP/Azure bill, an existing data-residency
  // and compliance posture, and the credentials a team already has. Each is an
  // auth-and-endpoint variant over the adapter above it, not a new transport.
  | "bedrock" // Anthropic models via the AWS Bedrock Messages API (SigV4)
  | "vertex" // Anthropic + Gemini via Google Vertex AI (ADC)
  | "azure-openai" // OpenAI models via Azure deployments (api-key / Entra)
  | "custom"
  // The open tail. The literals above are documentation and autocomplete; the
  // real set is PROVIDER_PRESETS in @rune/shared, and a hand-written copy of it
  // has rotted before — a sticky `codex` pick was rejected at boot by a list
  // that predated the subscription transports. Keeping the type open means a
  // preset added there is a provider here with no second edit to forget.
  | (string & {});

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
    // gpt-6: the Codex models page documents Light–Max for astra, and the API
    // pages document low…max for astra, sol and luna (2026-09-28). `ultra`
    // (sub-agent delegation, not a depth) has no ReasoningEffort value here
    // and is deliberately not invented. Later generations inherit the same
    // set, which is the conservative direction: every value in it has been
    // accepted from an earlier model on this route.
    if (/^(gpt-[6-9]|gpt-\d{2})/.test(m)) return ["low", "medium", "high", "xhigh", "max"];
    return ["low", "medium", "high"];
  }
  // Azure serves the same OpenAI models over the same Chat Completions wire, so
  // it carries the same dial. The model here is Rune's model id, which maps to
  // a deployment NAME on the way out — the dial follows the model, not the
  // deployment, which is why this tests the id and not the deployment string.
  // The OpenAI API itself: gpt-5.6 and gpt-6 DOCUMENT low…max on their model
  // pages (2026-09-28), so the API dial is as deep as the Codex one for them.
  // Azure is left on the narrow set below: a Foundry deployment can trail the
  // first-party model by weeks, and nothing here has read its accepted values.
  if (provider === "openai" && /^gpt-(6|5\.6)(-|$)/.test(m)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (
    (provider === "openai" || provider === "azure-openai") &&
    /^(gpt-[5-9]|gpt-\d{2}|o[134])(-|\.|:|$)/.test(m)
  ) {
    return ["low", "medium", "high"];
  }
  // Gemini through Vertex is the same model with the same thinking budget; the
  // Anthropic models on Vertex have no effort field at all, exactly as on the
  // first-party API. Answering per FAMILY rather than per provider is what
  // stops an enterprise route from silently losing the dial.
  if (provider === "vertex" && /^gemini-2\.5-/.test(m)) return ["low", "medium", "high"];
  if (provider === "vertex" && /^gemini-3/.test(m)) return ["low", "high"];
  // Gemini has no `reasoning_effort` field — depth is a thinking BUDGET — but
  // the dial is real and is now translated on the wire (geminiThinkingConfig).
  // It returned [] here while the effort was silently dropped in the adapter,
  // so the control was correctly hidden for the wrong reason. The 2.5 line
  // takes a budget; the 3.x line takes a level with only two documented values.
  if (provider === "google") {
    if (/^gemini-2\.5-/.test(m)) return ["low", "medium", "high"];
    if (/^gemini-3/.test(m)) return ["low", "high"];
    return [];
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

// ─── What a completion was FOR (P12.1) ───
//
// Measured 2026-09-07 on the founder's run DB: 45% of all incidents are
// provider rate limits, and the harness's own calls — the safety classifier,
// the compaction summarizer, the intent read, the schema repair — are separate
// completions that each carry a fresh system prompt and tool surface. The
// ledger could not tell them apart from the work, so "how many completions did
// this task actually need" had no answer and nothing could be traded away.
//
// A request says what it is; the meter carries it through to the cost entry
// and the session log. Absent means "primary" — the agent's own turn.

/**
 * The role a completion plays. `primary` is the agent's turn — the work the
 * user asked for. Everything else is GOVERNANCE: Rune's own overhead.
 */
export type CallRole =
  /** The agent loop's turn. The work. */
  | "primary"
  /** Auto mode's in-path safety reviewer. */
  | "classifier"
  /** Auto mode's out-of-band supervisor screen/confirm. */
  | "supervisor"
  /** Context compaction's summarizer walk. */
  | "summarizer"
  /** The intent read that gives a task its kind. */
  | "intent"
  /** System-memory distillation ("dreaming"). */
  | "memory"
  /** Repairing a sub-agent report into its schema. */
  | "repair"
  /** A delegated sub-agent's own turn. */
  | "subagent"
  /** Research synthesis. */
  | "research"
  /**
   * Nobody said. Written ONLY by `CostTracker.record`'s runtime guard, when a
   * caller reached it with no attribution at all — which the type forbids, so
   * in practice an untyped caller or an old compiled build.
   *
   * It exists because the alternatives are both worse. Throwing loses the row,
   * and the row is what a budget cap is tested against: the first version of
   * this did throw, and the comparison rig's OpenCode arm — whose `record` call
   * sits inside a `catch { return false; }` — silently stopped accruing a cent,
   * so its live spend cap could never fire. Defaulting to `primary` files the
   * mystery as the user's own work, which is the exact misattribution requiring
   * `role` was meant to end. So the money is counted and the row says, in one
   * word, that it is unexplained. Seeing this in a ledger is a bug report.
   */
  | "unattributed";

/** Every role that is Rune's overhead rather than the user's work. */
export const GOVERNANCE_ROLES: readonly CallRole[] = [
  "classifier",
  "supervisor",
  "summarizer",
  "intent",
  "memory",
  "repair",
];

export function isGovernanceRole(role: CallRole | undefined): boolean {
  return role !== undefined && (GOVERNANCE_ROLES as readonly string[]).includes(role);
}

/**
 * What one request was made of, in BYTES of the wire payload.
 *
 * Bytes, not tokens: this is measured locally before the request goes out, and
 * a token estimate here would be a second guess layered on the provider's own
 * count (which the usage report already gives, exactly). Bytes are what the
 * composition question is actually about — "which block is 34k of fresh input"
 * — and they are exact.
 *
 * The four named parts plus `conversation` sum to `total`; `other` absorbs
 * anything the caller did not attribute.
 */
export interface PromptComposition {
  /** The doctrine + environment + memory system prompt. */
  doctrine: number;
  /** The plan-ledger / task-state block riding as an ephemeral tail. */
  planLedger: number;
  /** Task-state prose OUTSIDE the ledger block (budget, team, spine notices). */
  taskState: number;
  /** JSON of every advertised tool definition. */
  toolSchemas: number;
  /** Everything else in `messages` — the actual conversation. */
  conversation: number;
  /** Sum of the above. */
  total: number;

  // ─── What this request asked the cache to do (P3B I5) ───
  //
  // `cacheReadTokens` / `cacheCreationTokens` on the CostEntry say what the
  // cache DID. Neither says what was asked of it, so a miss could not be told
  // apart from a breakpoint that moved or a prefix that changed mid-stream —
  // and `cacheCreationTokens` is 0 on every one of the 2,931 rows measured,
  // because no provider in use reports cache writes at all. These two fields
  // are the request side of the same question, and they cost one integer and
  // eight hex characters.

  /**
   * The index into `messages` the caller marked as the last cacheable turn,
   * when it marked one. A miss against a breakpoint that moved is a different
   * failure from a miss against a stable one.
   */
  cacheBreakpointIndex?: number;
  /**
   * A cheap, stable fold of everything ahead of the ephemeral tail — the
   * system prompt, the tool schemas and every stable message. Two consecutive
   * requests with the same hash sent a byte-identical prefix; a hash that
   * changed while the conversation only grew means something rewrote history,
   * which is the one thing that cannot be seen from a token count. Compared
   * only to itself, never stored as a claim about content.
   */
  prefixHash?: string;
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
  /**
   * What this completion is for. Purely descriptive: no provider reads it, and
   * nothing about the request changes because of it. It exists so the ledger
   * can answer "how many of these were the work".
   *
   * REQUIRED (P3B I1). It used to be optional and default to `primary`, which
   * meant a new caller was silently filed as the user's work: 437 of 2,931
   * rows in the founder's ledger carried a tag and the other 85% had to be
   * inferred from the event sequence around them. Requiring it turns every
   * unattributed call into a compile error instead of a silent misattribution.
   * A caller that genuinely is the agent's own turn writes `"primary"`, which
   * is a claim someone made rather than a field nobody filled in.
   */
  role: CallRole;
  /**
   * Bytes per prompt part, measured by the caller that assembled the request.
   * Only the agent loop attributes all five parts; a governance caller that
   * passes nothing simply has no composition row, which reads as "not
   * measured" rather than as a zero it did not earn.
   */
  composition?: PromptComposition;
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

// ─── The quota meter ───
//
// A subscription route is not metered in dollars, so the question a long run
// has to answer is "how much of the plan's window is left". The ChatGPT Codex
// backend states it on every response, success or failure, in `x-codex-*`
// headers — and until these types existed nothing in Rune read them. The live
// 429 of 2026-09-28 said "primary window 100% used, resets in 9732s" in its
// headers while Rune guessed fifteen minutes.

/** One quota window, as the provider reported it. */
export interface CapacityWindow {
  /** Share of the window already spent, in percent, as reported (100 = exhausted). */
  usedPercent: number;
  /** The window's length in minutes (Codex: 300 is the five-hour window, 10080 the week). */
  windowMinutes?: number;
  /** Seconds until the window resets, as reported. */
  resetAfterSeconds?: number;
  /** Epoch ms when the window resets. */
  resetAt?: number;
}

/**
 * How much of a plan's allowance a response says is left.
 *
 * `primary.usedPercent` is THE quota figure — the short window, the one a long
 * run hits first. Every field is optional because providers state different
 * subsets; an absent field means "not reported", never zero.
 */
export interface ProviderCapacity {
  /** The short window (Codex: five hours). */
  primary?: CapacityWindow;
  /** The long window (Codex: the week). */
  secondary?: CapacityWindow;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: number };
  /** The plan the provider named ("plus", "pro"). */
  planType?: string;
  /** Which of the plan's limits applies to this request, in the provider's words ("premium"). */
  activeLimit?: string;
}

export interface InferenceResponse {
  id: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
  /** The plan's quota windows as this response reported them (see ProviderCapacity). */
  capacity?: ProviderCapacity;
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
  | {
      type: "message_stop";
      stopReason: StopReason;
      usage: TokenUsage;
      /**
       * The plan's quota windows as this response reported them. Beside
       * `usage`, not inside it: TokenUsage is token counts and nothing else,
       * and this event is the one every response emits. Absent when the
       * provider reported none.
       */
      capacity?: ProviderCapacity;
    }
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
  | {
      type: "error";
      error: string;
      retryable?: boolean;
      /** The failure's kind, when the gateway knows it structurally (a plan cap is `usage_cap`). */
      code?: ApiErrorCode;
      /**
       * Epoch ms when the limit that stopped this lifts: the provider's own
       * reset when it reported one, the gateway's cooldown otherwise. For
       * machine readers (auto-resume, the eval rig), so nobody has to parse
       * the minutes back out of the sentence.
       */
      resetAt?: number;
    };

// ─── Provider Adapter Interface ───

export interface StreamOpts {
  signal?: AbortSignal;
  /**
   * A stable key for the provider's prompt cache, e.g. the Rune session id.
   * Codex sends it as `prompt_cache_key`; without it each provider instance
   * uses its own random id, which changes whenever the gateway is rebuilt and
   * so throws away a warm cache. Providers without the concept ignore it.
   */
  cacheKey?: string;
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
  // Deliberately NOT derived from PROVIDER_CAPACITY in @rune/shared, which
  // looks like the same table and is not. That map ranks rate-limit headroom
  // for fallback ordering, and marks openrouter "free" — true of its free
  // pool, false of the paid models on the same account. Billing has to be
  // decided per request, so it lives here.

  // The free pool advertises itself in the id. Checked FIRST: a ":free" model
  // is free on any provider that serves it.
  if (model.endsWith(":free")) return "free";
  // Subscription transports: a plan the user already pays for monthly. The
  // tokens are real; the marginal dollar is zero.
  if (provider === "codex") return "subscription";
  // Ollama Cloud is NOT one of them. The ids Rune ships for `ollama-turbo` are
  // the ones verified on the DEFAULT, no-subscription plan; the
  // subscription-gated models are deliberately omitted from the preset because
  // they 403. This said "subscription" while PROVIDER_CAPACITY said "free" -
  // the two now agree, and both say free.
  if (provider === "ollama-turbo") return "free";
  // Local runtimes cost electricity, not API dollars.
  if (provider === "ollama") return "free";
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
  // Two exceptions to the 10% cache-read default, per Anthropic's models
  // overview (2026-09-28): Fable 5.1 reads cache at 2.5% and Opus 5.5 at 5%.
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 0.25 },
  "claude-mythos-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2 },
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

  // ─── Anthropic on AWS Bedrock ───
  // Bedrock resells Anthropic at Anthropic's list rates, so these are the same
  // numbers under the ids AWS uses. They need their OWN rows because pricing
  // lookup is exact-match (plus a `vendor/model` suffix fallback that a dotted
  // Bedrock id does not match), and an unpriced model reports $0 — which is
  // indistinguishable from free and is the exact hole the coverage guard exists
  // to close. The geo-prefixed inference-profile ids are what the catalogue
  // offers, so those are the ids priced.
  "global.anthropic.claude-opus-4-6-v1": { inputPerMillion: 5, outputPerMillion: 25 },
  "global.anthropic.claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "us.anthropic.claude-opus-4-5-20251101-v1:0": { inputPerMillion: 5, outputPerMillion: 25 },
  "us.anthropic.claude-opus-4-1-20250805-v1:0": { inputPerMillion: 15, outputPerMillion: 75 },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { inputPerMillion: 3, outputPerMillion: 15 },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMillion: 1, outputPerMillion: 5 },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // ─── Anthropic on Google Vertex AI ───
  // Vertex names an Anthropic model `<family>@<version>` and bills at the same
  // list rate. These need their OWN rows because pricing lookup is exact-match,
  // and an unpriced model reports $0 — indistinguishable from free. Vertex's
  // Gemini ids are the plain AI Studio ones, already priced below.
  "claude-opus-4-1@20250805": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-5@20250929": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5@20251001": { inputPerMillion: 1, outputPerMillion: 5 },

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
  // The 2026 line, from OpenAI's model pages (2026-09-28). Codex-plan use of
  // the same ids costs nothing at the margin, but pricing them at API rates
  // keeps the "what would this have cost metered?" column real. Cached input
  // is 10% across the line, which is the default ratio, so no row states it.
  // Prompts over 272K input tokens bill at 2x input; the meter prices the
  // base tier, so a very long prompt under-reports rather than over-reports.
  //
  // Until 2026-09-28 astra carried the GPT-5 line's $1.25/$10 as an estimate.
  // The published rate is $10/$50, so every astra session was metered at
  // about an eighth of its real cost.
  "gpt-6-astra": { inputPerMillion: 10, outputPerMillion: 50 },
  "gpt-6-sol": { inputPerMillion: 2, outputPerMillion: 10 },
  "gpt-6-luna": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  // Kept only so old ledgers still price: no OpenAI page documents this id.
  "gpt-6-astra-pro": { inputPerMillion: 2.5, outputPerMillion: 20, estimated: true },
  "gpt-5.6-sol": { inputPerMillion: 4, outputPerMillion: 20 },
  "gpt-5.6-terra": { inputPerMillion: 2, outputPerMillion: 12 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "gpt-5.5": { inputPerMillion: 1.25, outputPerMillion: 10, estimated: true },
  "gpt-5.4-mini": { inputPerMillion: 0.25, outputPerMillion: 2, estimated: true },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },

  // ─── DeepSeek ───
  // The current pair (2026-09-16). Rates carried from the line they replace;
  // DeepSeek's cache-read discount is the same 0.07 shape.
  "deepseek-flash": {
    inputPerMillion: 0.27,
    outputPerMillion: 1.1,
    cacheReadPerMillion: 0.07,
    estimated: true,
  },
  "deepseek-v4-pro": { inputPerMillion: 0.55, outputPerMillion: 2.19, estimated: true },
  "deepseek-v4.1-flash": {
    inputPerMillion: 0.27,
    outputPerMillion: 1.1,
    cacheReadPerMillion: 0.07,
    estimated: true,
  },
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1, cacheReadPerMillion: 0.07 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  "deepseek-coder-v2": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  deepseek: { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },

  // ─── xAI ───
  // The 2026 line, from xAI's model page (2026-09-28). xAI bills two tiers by
  // prompt length; these are the under-200k rates, which is where an agent
  // turn lives, so a very long prompt under-reports. They replace estimates
  // carried over from grok-4 that overstated output cost by 2.5x.
  "grok-4.7": { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5 },
  "grok-4.6": { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5 },
  "grok-4.5": { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.3 },
  "grok-4.3": { inputPerMillion: 1.25, outputPerMillion: 2.5, cacheReadPerMillion: 0.2 },
  "grok-4.20-0309-reasoning": {
    inputPerMillion: 1.25,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.2,
  },
  "grok-build-0.1": { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.2 },
  "grok-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "grok-4-fast": { inputPerMillion: 0.2, outputPerMillion: 0.5 },
  "grok-code-fast-1": { inputPerMillion: 0.2, outputPerMillion: 1.5 },

  // ─── Google Gemini ───
  // Gemini discounts cached input to 25%, not the 10% default.
  // The 3.x line (2026-09-16). Flash rates estimated from the 2.5 Flash row it
  // supersedes; the preview Pro id takes 2.5 Pro's.
  "gemini-3.8-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.0375,
    estimated: true,
  },
  "gemini-3.5-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.0375,
    estimated: true,
  },
  "gemini-3.5-flash-lite": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
    estimated: true,
  },
  "gemini-3.1-pro-preview": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.3125,
    estimated: true,
  },
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
  "openai/gpt-oss-20b": { inputPerMillion: 0.05, outputPerMillion: 0.2, estimated: true },
  // Groq's two preview ids and Cerebras' Qwen checkpoint.
  "qwen3.8-27b": { inputPerMillion: 0.2, outputPerMillion: 0.8, estimated: true },
  "qwen-3.8-27b": { inputPerMillion: 0.2, outputPerMillion: 0.8, estimated: true },
  "minimax-m2.7": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79, estimated: true },
  // Groq's light tier. Added to the catalogue in P8.6 because the tier table
  // already resolved to it while the picker never listed it.
  "llama-3.1-8b-instant": { inputPerMillion: 0.05, outputPerMillion: 0.08, estimated: true },
  "llama3.1": { inputPerMillion: 0.05, outputPerMillion: 0.08, estimated: true },
  "nemotron-3-ultra": { inputPerMillion: 0.6, outputPerMillion: 1.8, estimated: true },
  "nemotron-3-super": { inputPerMillion: 0.3, outputPerMillion: 0.9, estimated: true },
  "nemotron-3-nano:30b": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },
  "gemma4:31b": { inputPerMillion: 0.06, outputPerMillion: 0.18, estimated: true },

  // ─── The wider roster (2026-09-06) ───
  // Keyed by the BARE id (pricingFor falls back to the segment after the last
  // "/"), so one row serves every host that spells a model the same way:
  // `gpt-oss-120b` covers openai/…, accounts/fireworks/models/… and the bare
  // Cerebras/SambaNova/Scaleway ids alike. Casing is part of the key, which is
  // why Kimi-K2 and DeepSeek-V3.1 appear in the spellings their hosts use.
  //
  // First-party hosts (Mistral, Cohere, Moonshot, Z.ai, AI21, MiniMax,
  // Inception, Alibaba, Cerebras) carry their published list rates. Ids served
  // by several hosts at several prices carry a mid-market ESTIMATE and say so —
  // the metered-equivalent column is populated rather than silently zero, and
  // every readout marks the figure as inferred.

  // AI21
  "jamba-large": { inputPerMillion: 2, outputPerMillion: 8 },
  "jamba-mini": { inputPerMillion: 0.2, outputPerMillion: 0.4 },

  // Alibaba Model Studio (first tier of a context-tiered sheet; longer inputs cost more)
  "qwen3-coder-plus": { inputPerMillion: 1, outputPerMillion: 5, estimated: true },
  "qwen3-coder-flash": { inputPerMillion: 0.3, outputPerMillion: 1.5, estimated: true },
  "qwen-max": { inputPerMillion: 1.6, outputPerMillion: 6.4, estimated: true },
  "qwen-plus": { inputPerMillion: 0.4, outputPerMillion: 1.2, estimated: true },
  "qwen-turbo": { inputPerMillion: 0.05, outputPerMillion: 0.2, estimated: true },

  // Cerebras
  "qwen-3-coder-480b": { inputPerMillion: 2, outputPerMillion: 2 },
  "qwen-3-235b-a22b-instruct-2507": { inputPerMillion: 0.6, outputPerMillion: 1.2 },
  "llama-3.3-70b": { inputPerMillion: 0.85, outputPerMillion: 1.2 },

  // Cohere
  "command-a-03-2025": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "command-r-plus-08-2024": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "command-r7b-12-2024": { inputPerMillion: 0.0375, outputPerMillion: 0.15 },

  // Fireworks spellings
  "deepseek-v3p1": { inputPerMillion: 0.56, outputPerMillion: 1.68 },
  "kimi-k2-instruct-0905": { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  "llama-v3p3-70b-instruct": { inputPerMillion: 0.9, outputPerMillion: 0.9 },
  "qwen3-coder-480b-a35b-instruct": {
    inputPerMillion: 0.45,
    outputPerMillion: 1.8,
    estimated: true,
  },

  // Inception
  "mercury-coder": { inputPerMillion: 0.25, outputPerMillion: 1 },
  mercury: { inputPerMillion: 0.25, outputPerMillion: 1 },

  // MiniMax
  "MiniMax-M3": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "MiniMax-M2.7": { inputPerMillion: 0.3, outputPerMillion: 1.2, estimated: true },
  "MiniMax-M2": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  "MiniMax-M1": { inputPerMillion: 0.4, outputPerMillion: 2.2 },

  // Mistral (the -latest aliases, plus the dated ids other hosts use)
  "mistral-large-latest": { inputPerMillion: 2, outputPerMillion: 6 },
  "mistral-medium-latest": { inputPerMillion: 0.4, outputPerMillion: 2 },
  "devstral-medium-latest": { inputPerMillion: 0.4, outputPerMillion: 2 },
  "codestral-latest": { inputPerMillion: 0.3, outputPerMillion: 0.9 },
  "codestral-2501": { inputPerMillion: 0.3, outputPerMillion: 0.9 },
  "magistral-medium-latest": { inputPerMillion: 2, outputPerMillion: 5 },
  "mistral-small-latest": { inputPerMillion: 0.1, outputPerMillion: 0.3 },
  "mistral-small-3.2-24b-instruct-2506": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.35,
    estimated: true,
  },

  // Moonshot (Kimi)
  // Moonshot's current line (2026-09-16); rates estimated from the K2 sheet
  // the ids replace, with the highspeed variant on the turbo row's shape.
  "kimi-k3": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "kimi-k2.7-code": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "kimi-k2.7-code-highspeed": { inputPerMillion: 1.15, outputPerMillion: 8, estimated: true },
  "kimi-k2.6": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "kimi-k2-0905-preview": { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  "kimi-k2-thinking": { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  "kimi-k2-turbo-preview": { inputPerMillion: 1.15, outputPerMillion: 8 },
  "kimi-latest": { inputPerMillion: 1, outputPerMillion: 3, estimated: true },

  // Z.ai (GLM). The flash tier is a real zero, not an unknown one.
  "glm-5.2:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "glm-4.6": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  "glm-4.5": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  "glm-4.5-air": { inputPerMillion: 0.2, outputPerMillion: 1.1 },
  "glm-4.5-flash": { inputPerMillion: 0, outputPerMillion: 0 },

  // Open weights served by many hosts (Baseten, Chutes, DeepInfra, Hugging
  // Face, Hyperbolic, Nebius, Novita, NVIDIA, SambaNova, Scaleway, SiliconFlow,
  // Together): mid-market estimates in each host's spelling.
  "Kimi-K2-Instruct-0905": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "Kimi-K2-Instruct": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "kimi-k2-instruct": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "kimi-k2": { inputPerMillion: 0.6, outputPerMillion: 2.5, estimated: true },
  "Qwen3-Coder-480B-A35B-Instruct": {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    estimated: true,
  },
  "Qwen3-Coder-480B-A35B-Instruct-FP8": {
    inputPerMillion: 2,
    outputPerMillion: 2,
    estimated: true,
  },
  "Qwen3-32B": { inputPerMillion: 0.4, outputPerMillion: 0.8, estimated: true },
  "qwen3-coder-30b-a3b-instruct": { inputPerMillion: 0.2, outputPerMillion: 0.8, estimated: true },
  "DeepSeek-V3.1": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  "deepseek-v3.1": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  "DeepSeek-V3-0324": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  "deepseek-v3-0324": { inputPerMillion: 0.27, outputPerMillion: 1.1, estimated: true },
  "gpt-oss-120b": { inputPerMillion: 0.1, outputPerMillion: 0.5, estimated: true },
  "Llama-3.3-70B-Instruct": { inputPerMillion: 0.3, outputPerMillion: 0.4, estimated: true },
  "Llama-3.3-70B-Instruct-Turbo": {
    inputPerMillion: 0.88,
    outputPerMillion: 0.88,
    estimated: true,
  },
  "Meta-Llama-3.3-70B-Instruct": { inputPerMillion: 0.6, outputPerMillion: 1.2, estimated: true },
  "llama-3.3-70b-instruct": { inputPerMillion: 0.3, outputPerMillion: 0.4, estimated: true },
  "llama-3.3-nemotron-super-49b-v1.5": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    estimated: true,
  },

  // Gateway-prefixed frontier ids (Vercel AI Gateway) that the bare-id fallback
  // cannot reach because the spelling differs from ours.
  "claude-sonnet-4.5": { inputPerMillion: 3, outputPerMillion: 15 },

  // ─── OpenRouter-prefixed ids for the same models ───
  "anthropic/claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  // OpenRouter spells Opus 5.5 with a dot, so the bare-id fallback misses it.
  "anthropic/claude-opus-5.5": {
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.2,
  },
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
  // Verified 2026-09-08: https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free
  "nvidia/nemotron-3-super-120b-a12b:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { inputPerMillion: 0, outputPerMillion: 0 },
  // Listed free with tool support on 2026-09-28 (openrouter.ai/api/v1/models).
  "qwen/qwen3.8-27b:free": { inputPerMillion: 0, outputPerMillion: 0 },
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
  /**
   * What the completion was for.
   *
   * REQUIRED since P3B I1 — `InferenceRequest.role` is required, so every row
   * the gateway records carries one. The replay path (a pre-P12.1 row read
   * back out of a session log with no tag) passes `"primary"` explicitly,
   * which is what every reader already assumed of an absent field; the
   * difference is that the assumption is now made once, in the open.
   */
  role: CallRole;
  /** Bytes per prompt part, when the caller measured them. */
  composition?: PromptComposition;

  // ─── When the provider was actually busy (P3B I3) ───
  //
  // `timestamp` is when the response landed and nothing else, so per-completion
  // wall clock had to be inferred from the gap between consecutive cost rows.
  // That interval charges a completion for the tool time that preceded it and
  // cannot see a concurrent caller at all — the out-of-band supervisor runs off
  // the critical path by design and read as 36.7% of the clock. Both fields are
  // optional because a row REPLAYED from a pre-I3 session log has neither, and
  // an absent latency reads as "not measured" rather than as an instant
  // response. Every row the gateway records carries both.

  /**
   * When the CALL was first handed to a provider — and the join key an
   * incident's `requestStartedAt` matches (P3B I6b).
   *
   * Call-scoped on purpose. A retried request raises its incident on the
   * attempt that failed and records its cost on the attempt that answered, so
   * an attempt-scoped stamp is guaranteed NOT to appear on both — the join
   * would resolve on every request except the rate-limited ones it exists for.
   */
  startedAt?: Date;
  /**
   * When the attempt that actually answered went out, present ONLY when the
   * call was retried or fell back — i.e. when it differs from `startedAt`.
   * Absent means "this call went out once", so `startedAt` is also the
   * attempt's stamp.
   */
  attemptStartedAt?: Date;
  /**
   * `timestamp - (attemptStartedAt ?? startedAt)` in milliseconds: the
   * provider's own latency for the attempt that answered.
   *
   * Deliberately NOT `timestamp - startedAt` on a retried call: a request that
   * was retried twice was not slow for the whole ladder, and charging it the
   * back-off it waited through would hide the retry behind the provider.
   */
  latencyMs?: number;
  /**
   * The plan's quota windows as the response reported them (see
   * ProviderCapacity). `capacity.primary.usedPercent` is the share of the
   * subscription window spent so far. Absent when the provider reported none.
   */
  capacity?: ProviderCapacity;
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
  /**
   * Whether mid-task inference may move to a DIFFERENT provider/model at all.
   *
   *   "pin"  — the model that started the task finishes it (default). A
   *            cooling or capped provider is retried and waited out rather
   *            than substituted; a retired model stops the run with /model
   *            guidance. Nothing weaker ever quietly inherits the work.
   *   "flex" — the historical substitute chain: capacity-ranked fallback
   *            providers, each handover labeled.
   *
   * Sourced from `[fallback] modelIntegrity` in config.toml.
   */
  modelIntegrity?: "pin" | "flex";
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

  // ─── Which completion paid for this (P3B I6b) ───
  //
  // The black box holds 3,284 incidents and 1,417 of them are provider rate
  // limits, against 15 recorded retries in the cost ledger: the two stores had
  // no join, so "what did this incident cost" had no answer. These two fields
  // are the request's own identity, and with `startedAt` on the cost row they
  // name the completion exactly — no new id, no new table.
  //
  // The stamp is the CALL's, not the attempt's. The first shipped version used
  // the attempt's and so could not resolve a single rate-limited request: the
  // incident is raised by the attempt that failed, the cost row is written by
  // the attempt that answered, and with real back-off the two are seconds
  // apart. Every incident a call raises now carries the one stamp its cost row
  // carries, whichever attempt or provider ends up serving it.

  /** What the request that hit this was FOR. */
  role?: CallRole;
  /** ISO stamp of when the CALL went out — `CostEntry.startedAt`'s join key. */
  requestStartedAt?: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
}

// ─── Structured API Error ───

/**
 * What kind of failure an ApiError is, when the provider said so in a field
 * rather than in prose. Absent means "read the status and the message", which
 * is all the gateway had before these existed.
 *
 *   usage_cap        a plan/quota cap — waiting seconds will not clear it
 *   rate_limit       a passing throttle
 *   context_overflow the prompt is over the model's window (compact, then retry)
 *   server_error     the provider failed; retrying may succeed
 *   invalid_request  the request itself was refused; retrying cannot succeed
 */
export type ApiErrorCode =
  "usage_cap" | "rate_limit" | "context_overflow" | "server_error" | "invalid_request";

export class ApiError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly retryAfterMs: number | null;
  /** The structured classification, when the provider gave one. */
  readonly code?: ApiErrorCode;
  /**
   * Epoch ms when the provider says the limit lifts. Only ever a reported
   * moment, never a guess: the gateway cools a provider down EXACTLY until
   * it, where a guessed cooldown is clamped.
   */
  readonly resetAt?: number;
  /** The provider's own name for the error, verbatim ("usage_limit_reached"). */
  readonly providerCode?: string;
  /** The quota windows the failing response reported. */
  readonly capacity?: ProviderCapacity;

  constructor(opts: {
    status: number;
    provider: string;
    message: string;
    retryAfterMs?: number;
    code?: ApiErrorCode;
    resetAt?: number;
    providerCode?: string;
    capacity?: ProviderCapacity;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    if (opts.code) this.code = opts.code;
    if (opts.resetAt !== undefined) this.resetAt = opts.resetAt;
    if (opts.providerCode) this.providerCode = opts.providerCode;
    if (opts.capacity) this.capacity = opts.capacity;
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
