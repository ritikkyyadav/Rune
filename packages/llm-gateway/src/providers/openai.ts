import OpenAI from "openai";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  ProviderName,
  StreamEvent,
  StopReason,
  StreamOpts,
  ToolDefinition,
  TokenUsage,
} from "../types";
import { ApiError } from "../types";
import { IdleWatchdog } from "./stream-guard";
import { parseToolArguments } from "@gear/shared";

/**
 * Attach a prompt-cache breakpoint to one chat message, promoting its string
 * content to the array-of-parts form that can carry the field. A message with
 * no text to hang it on (an assistant turn that is pure tool_calls) is left
 * alone rather than given an empty part.
 */
function markCacheBreakpoint(msg: OpenAI.ChatCompletionMessageParam | undefined): void {
  if (!msg) return;
  const cacheControl = { type: "ephemeral" as const };
  if (typeof msg.content === "string") {
    if (!msg.content) return;
    (msg as { content: unknown }).content = [
      { type: "text", text: msg.content, cache_control: cacheControl },
    ];
    return;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const last = msg.content[msg.content.length - 1] as unknown as {
      type?: string;
    } & Record<string, unknown>;
    if (last.type === "text") last.cache_control = cacheControl;
  }
}

/**
 * Split an OpenAI-compatible host's prompt count into the disjoint fields the
 * TokenUsage contract requires.
 *
 * `prompt_tokens` INCLUDES the cached portion, so the cached count has to be
 * SUBTRACTED, not merely reported alongside. Reporting both without
 * subtracting made ContextEngine.noteRealUsage — which sums the three input
 * fields — count every cached token twice, so a well-cached conversation read
 * as nearly double its real size and compacted at a fraction of the window.
 * The symptom was paying for summarizer round-trips on a context that had
 * plenty of room left.
 *
 * Keeping the cached figure is still what makes a working prompt cache
 * distinguishable from a silently-invalidated one.
 */
function inputUsageFrom(usage: unknown): { inputTokens: number; cacheReadTokens?: number } {
  const u = usage as
    { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (typeof cached !== "number" || cached <= 0) return { inputTokens: prompt };
  // Clamp: a host reporting more cached than prompt tokens would otherwise
  // yield a negative fresh count and corrupt every downstream sum.
  const cacheReadTokens = Math.min(cached, prompt);
  return { inputTokens: prompt - cacheReadTokens, cacheReadTokens };
}

export class OpenAIProvider implements LlmProvider {
  readonly name: ProviderName;
  private client: OpenAI;
  /**
   * Whether this host forwards `cache_control` breakpoints upstream. Derived
   * from the base URL rather than `name`, because OpenRouterProvider wraps this
   * adapter WITHOUT passing its own name — `this.name` is "openai" there.
   */
  private readonly forwardsCacheControl: boolean;

  // `name` lets OpenAI-compatible hosts (Groq, xAI, DeepSeek, a custom endpoint,
  // OpenRouter) register under their own identity while sharing this adapter.
  // `opts.fetch`/`opts.defaultHeaders` let a subscription transport (GitHub
  // Copilot) reuse this whole translation layer while injecting a rotating bearer
  // token and its required editor headers on every request.
  constructor(
    apiKey?: string,
    baseUrl?: string,
    name: ProviderName = "openai",
    opts?: {
      fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
      defaultHeaders?: Record<string, string>;
    },
  ) {
    this.name = name;
    this.forwardsCacheControl = (baseUrl ?? "").includes("openrouter.ai");
    const resolvedKey = apiKey ?? process.env.OPENAI_API_KEY ?? "dummy";
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(baseUrl && { baseURL: baseUrl }),
      timeout: 60_000,
      maxRetries: 0,
      // Cast: the SDK's Fetch type isn't exported; the shapes are compatible.
      ...(opts?.fetch && { fetch: opts.fetch as never }),
      ...(opts?.defaultHeaders && { defaultHeaders: opts.defaultHeaders }),
    });
  }

  /**
   * OpenAI FIRST-PARTY reasoning-family models (gpt-5*, o1/o3/o4*): these
   * reject `max_tokens` (require `max_completion_tokens`), reject non-default
   * sampling params, and accept `reasoning_effort`. Other OpenAI-compatible
   * hosts sharing this adapter (Groq/xAI/DeepSeek/OpenRouter/Ollama Turbo)
   * keep the classic params, so this is gated on the provider name too.
   */
  private isOpenAIReasoningModel(model: string): boolean {
    if (this.name !== "openai") return false;
    return /^(gpt-5|o[134])(-|:|$)/.test(model.toLowerCase());
  }

  /**
   * The cheapest reasoning dial a first-party reasoning model accepts when the
   * caller asked for NO thinking (Auto-mode fast classifier, utility calls).
   * Omitting `reasoning_effort` is not "off" — gpt-5/o-series default to
   * medium and spend the whole small completion budget on hidden reasoning,
   * returning empty content. Per the model pages: gpt-5/-mini/-nano accept
   * "minimal"; gpt-5.1+ replaced it with "none"; gpt-5-codex and the o-series
   * bottom out at "low".
   */
  static minimalReasoningEffort(model: string): "minimal" | "none" | "low" {
    const m = model.toLowerCase();
    if (/^gpt-5(?:-mini|-nano|-chat)?(?:-|$)/.test(m) && !m.includes("codex")) return "minimal";
    if (/^gpt-5\.\d/.test(m) && !m.includes("codex")) return "none";
    return "low";
  }

  /** Token/sampling/reasoning params appropriate for the target model family. */
  private buildTuningParams(request: InferenceRequest): Record<string, unknown> {
    if (this.isOpenAIReasoningModel(request.model)) {
      return {
        max_completion_tokens: request.maxTokens,
        // Depth dial: honor the caller's effort, defaulting HIGH — an agent
        // that plans/diagnoses at "medium" rushes to shallow conclusions
        // (the exact daily-driver complaint this replaces). Thinking explicitly
        // disabled maps to the model's floor so a small max_completion_tokens
        // budget is spent on the answer, not on hidden reasoning.
        reasoning_effort:
          request.thinking?.enabled === false
            ? OpenAIProvider.minimalReasoningEffort(request.model)
            : (request.thinking?.effort ?? "high"),
      };
    }
    return {
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
    };
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: this.toOpenAIMessages(
          request.messages,
          request.system,
          this.wantsCacheBreakpoints(request.model)
            ? { breakpointIndex: request.cacheBreakpointIndex }
            : undefined,
        ),
        tools: request.tools ? this.toOpenAITools(request.tools) : undefined,
        stop: request.stopSequences,
        ...(this.buildTuningParams(request) as object),
      } as Parameters<typeof this.client.chat.completions.create>[0] & { stream?: false },
      { signal: request.signal },
    );

    const choice = response.choices[0];
    const content = this.fromOpenAIChoice(choice);

    return {
      id: response.id,
      content,
      stopReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        ...inputUsageFrom(response.usage),
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Idle watchdog: aborts a stream that stops producing bytes. (The previous
    // design armed a per-chunk timer and cleared it in the same iteration's
    // `finally` — no timer was ever running during the only window that can
    // stall: the await between chunks. A wedged stream hung the CLI.)
    // Hidden-reasoning families (o-series / gpt-5) legitimately go silent for
    // minutes while they think — chat-completions does not stream their
    // reasoning — so they get a far more generous allowance than models that
    // stream continuously.
    const hiddenReasoning = /(^|\/)(o[134]|gpt-5)/.test(request.model.toLowerCase());
    const guard = hiddenReasoning
      ? new IdleWatchdog(this.name, opts?.signal, 300_000, 240_000)
      : new IdleWatchdog(this.name, opts?.signal, 120_000, 45_000);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: this.toOpenAIMessages(
            request.messages,
            request.system,
            this.wantsCacheBreakpoints(request.model)
              ? { breakpointIndex: request.cacheBreakpointIndex }
              : undefined,
          ),
          tools: request.tools ? this.toOpenAITools(request.tools) : undefined,
          stop: request.stopSequences,
          stream: true,
          // Ask for the trailing usage chunk. Without it this whole family
          // (openai/openrouter/groq/deepseek/…) reports zero usage on streams,
          // the context engine never learns the REAL prompt size, and
          // compaction can't fire until the provider hard-rejects. Copilot's
          // proxy is the one host known to reject unrecognized params, so it
          // keeps the legacy behavior.
          ...(this.name !== "copilot" && { stream_options: { include_usage: true } }),
          ...(this.buildTuningParams(request) as object),
        },
        { signal: guard.signal },
      );

      let messageId = "";
      let contentIndex = 0;
      let contentStarted = false;
      // With include_usage the final usage arrives on a chunk AFTER the
      // finish_reason one (with an empty choices array) — so message_stop is
      // deferred to stream end, carrying whatever usage was captured.
      let pendingStop: StopReason | null = null;
      let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      const toolCalls: Map<number, { id: string; name: string; argsJson: string }> = new Map();

      for await (const chunk of stream) {
        guard.beat();

        {
          // Check for error in chunk (OpenRouter sends errors as stream events).
          // Preserve the HTTP status (e.g. 429) as an ApiError so the gateway's
          // status-based fallback/retry logic can act on it — a plain Error
          // drops the status and silently defeats fallback.
          const anyChunk = chunk as unknown as Record<string, unknown>;
          if (anyChunk.error) {
            const errObj = anyChunk.error as Record<string, unknown>;
            const code = Number(errObj.code ?? errObj.status);
            const message = (errObj.message as string) ?? `API error ${errObj.code ?? ""}`;
            throw new ApiError({
              status: Number.isFinite(code) ? code : 502,
              provider: this.name,
              message,
            });
          }

          if (!messageId && chunk.id) {
            messageId = chunk.id;
            yield { type: "message_start", messageId };
          }

          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;

          // Real answer text.
          const textChunk = delta?.content;
          if (textChunk && typeof textChunk === "string") {
            if (!contentStarted) {
              yield { type: "content_start", contentIndex: 0 };
              contentStarted = true;
            }
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: textChunk },
            };
          }

          // Reasoning / chain-of-thought from reasoning models (gpt-oss,
          // qwen3-next, minimax, …) arrives in a separate `reasoning` /
          // `reasoning_content` field. Stream it as a DISTINCT thinking event so
          // the UI can dim it and the agent loop keeps it out of the persisted
          // answer — otherwise the raw chain-of-thought renders as the reply,
          // which reads as hallucination.
          const dr = delta as Record<string, unknown> | undefined;
          const reasoningChunk = dr?.reasoning ?? dr?.reasoning_content;
          if (typeof reasoningChunk === "string" && reasoningChunk) {
            yield { type: "thinking_delta", text: reasoningChunk };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx) && tc.id) {
                toolCalls.set(idx, {
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  argsJson: "",
                });
                if (contentStarted) {
                  yield { type: "content_stop", contentIndex: 0 };
                  contentStarted = false;
                }
                contentIndex++;
                yield {
                  type: "tool_use_start",
                  toolCallId: tc.id,
                  toolName: tc.function?.name ?? "",
                };
              }
              const entry = toolCalls.get(idx)!;
              if (tc.function?.arguments) {
                entry.argsJson += tc.function.arguments;
                yield {
                  type: "tool_use_delta",
                  toolCallId: entry.id,
                  partialJson: tc.function.arguments,
                };
              }
            }
          }

          // Usage can ride the finish chunk (legacy hosts) or a trailing
          // choices-empty chunk (include_usage) — capture it wherever it shows.
          if (chunk.usage) {
            finalUsage = {
              ...inputUsageFrom(chunk.usage),
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          if (finishReason) {
            if (contentStarted) {
              yield { type: "content_stop", contentIndex: 0 };
              contentStarted = false;
            }
            for (const [, entry] of toolCalls) {
              // Model-streamed args aren't trustworthy JSON — parse defensively so a malformed
              // blob (common with glm/qwen) degrades to {} instead of killing the whole stream.
              const toolInput = parseToolArguments(entry.argsJson);
              yield { type: "tool_use_stop", toolCallId: entry.id, toolInput };
            }
            pendingStop = this.mapFinishReason(finishReason);
          }
        }
      }

      // message_stop is emitted once the stream is fully drained so the
      // trailing usage chunk (when present) is included; a stream that died
      // without a finish reason still gets a synthetic end_turn.
      if (contentStarted) {
        yield { type: "content_stop", contentIndex: 0 };
      }
      yield {
        type: "message_stop",
        stopReason: pendingStop ?? "end_turn",
        usage: finalUsage,
      };
    } catch (err) {
      // Watchdog stall (not the caller's Esc) → retryable 504 the gateway can
      // retry/fall back on, instead of the SDK's opaque abort error.
      throw guard.timeoutError() ?? err;
    } finally {
      guard.stop();
    }
  }

  async countTokens(messages: Message[], _tools?: ToolDefinition[]): Promise<number> {
    // Estimate: ~4 chars per token for English text
    let totalChars = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "text") totalChars += block.text.length;
        else if (block.type === "tool_result") totalChars += block.toolResultContent.length;
        else if (block.type === "tool_use") totalChars += JSON.stringify(block.toolInput).length;
      }
    }
    return Math.ceil(totalChars / 4);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  /** Live model discovery via the OpenAI-compatible /v1/models endpoint. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await this.client.models.list();
    return (res.data ?? []).map((m) => ({ id: m.id, label: m.id, live: true }));
  }

  // ─── Translation Helpers ───

  /**
   * Whether to emit explicit `cache_control` breakpoints for this request.
   *
   * Only for Anthropic models behind OpenRouter, where the pass-through is
   * documented. Every other upstream on OpenRouter (OpenAI, DeepSeek, Grok,
   * and the stealth ids) does IMPLICIT prefix caching, which needs no
   * breakpoint — only a prompt prefix that stays byte-stable between turns.
   *
   * Measured on stealth/ox-alpha, cold prefix, 2026-08-26
   * (scripts/verify-cache.ts, with and without --force-breakpoints):
   *
   *   implicit  turn 1 cached=64 → turn 2 cached=4288  (input 4316)
   *   forced    turn 1 cached=64 → turn 2 cached=4288  (input 4318)
   *
   * Identical hit rate; the explicit field is accepted rather than rejected,
   * but buys nothing and costs the two tokens it serializes to. So the narrow
   * gate is a measured decision, not caution — widening it would add an
   * undocumented shape to the wire for no gain.
   */
  private wantsCacheBreakpoints(model: string): boolean {
    return this.forwardsCacheControl && model.toLowerCase().startsWith("anthropic/");
  }

  /**
   * The index in `result` that should carry the conversation cache breakpoint:
   * the last user/assistant message at or before `breakpointIndex`. Tool-role
   * messages are skipped — the OpenAI schema types their content as a bare
   * string, so an array-form part there is not portable.
   */
  private static breakpointSlot(result: OpenAI.ChatCompletionMessageParam[], upTo: number): number {
    for (let i = Math.min(upTo, result.length - 1); i >= 0; i--) {
      const role = result[i]?.role;
      if (role === "user" || role === "assistant") return i;
    }
    return -1;
  }

  private toOpenAIMessages(
    messages: Message[],
    system?: string,
    cache?: { breakpointIndex?: number },
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    // Where the caller's stable prefix ends, translated into `result` indices
    // as we go (one source message can emit several tool messages, and the
    // system prompt adds a leading entry, so the indices do not line up).
    const stableUpTo = cache?.breakpointIndex;
    let stableSlot = -1;

    if (system) {
      result.push({ role: "system", content: system });
    }

    for (const [srcIdx, msg] of messages.entries()) {
      if (msg.role === "system") continue;
      if (stableUpTo != null && srcIdx <= stableUpTo) stableSlot = result.length;

      if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

        for (const block of msg.content) {
          if (block.type === "text") textParts.push(block.text);
          else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.toolCallId,
              type: "function",
              function: {
                name: block.toolName,
                arguments: JSON.stringify(block.toolInput),
              },
            });
          }
        }

        result.push({
          role: "assistant",
          content: textParts.join("") || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        });
      } else if (msg.role === "tool") {
        // Tool results in OpenAI are separate messages
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: block.toolCallId,
              content: block.toolResultContent,
            });
          }
        }
      } else {
        // User messages
        const textParts = msg.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text);
        const imageBlocks = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
        );

        if (imageBlocks.length > 0 && this.supportsVision()) {
          // Vision: images ride as data-URL image_url parts, before the text.
          result.push({
            role: "user",
            content: [
              ...imageBlocks.map((b) => ({
                type: "image_url" as const,
                image_url: { url: `data:${b.mediaType};base64,${b.data}` },
              })),
              { type: "text" as const, text: textParts.join("\n") },
            ],
          });
        } else {
          // Hosts with unknown model catalogs (OpenRouter free tiers, local
          // runtimes) may 400 on image parts. Drop the pixels but SAY so —
          // the model must report "I couldn't view it", never guess.
          const note =
            imageBlocks.length > 0
              ? `\n\n[${imageBlocks.length} attached image(s) omitted: the ${this.name} transport does not send images to this host — tell the user you could not view them]`
              : "";
          result.push({ role: "user", content: textParts.join("\n") + note });
        }
      }
    }

    if (cache) {
      // System prompt and tool schemas are the largest always-stable block, so
      // they get a breakpoint of their own; the conversation gets a second one
      // at the end of its stable prefix.
      if (system) markCacheBreakpoint(result[0]);
      const slot = OpenAIProvider.breakpointSlot(result, stableSlot >= 0 ? stableSlot : -1);
      if (slot >= 0) markCacheBreakpoint(result[slot]);
    }

    return result;
  }

  /**
   * Whether this adapter sends image blocks on the wire. First-party OpenAI
   * models are vision-capable across the board; OpenAI-COMPATIBLE hosts
   * (OpenRouter, Groq, local runtimes, custom endpoints) serve arbitrary
   * models where an image part risks a hard 400 — those get an honest
   * text placeholder instead.
   */
  protected supportsVision(): boolean {
    return this.name === "openai";
  }

  private toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private fromOpenAIChoice(choice: OpenAI.ChatCompletion.Choice): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    // Only the real `content` is the answer. Reasoning models also return a
    // `reasoning` field, but that is chain-of-thought, not the reply, so it must
    // not become the assistant's message (it would read as hallucination).
    const content = choice.message.content;
    if (content && typeof content === "string") {
      blocks.push({ type: "text", text: content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        blocks.push({
          type: "tool_use",
          toolCallId: tc.id,
          toolName: tc.function.name,
          toolInput: parseToolArguments(tc.function.arguments),
        });
      }
    }

    return blocks;
  }

  private mapFinishReason(reason: string | null): StopReason {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }
}
