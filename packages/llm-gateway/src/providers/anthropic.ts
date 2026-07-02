import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  StreamEvent,
  StopReason,
  StreamOpts,
  ToolDefinition,
  TokenUsage,
} from "../types";
import { parseToolArguments } from "@alan/shared";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(baseUrl && { baseURL: baseUrl }),
    });
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const { thinking, needsInterleavedBeta } = this.buildThinkingParam(request);
    const response = await this.client.messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system ? this.toSystemWithCache(request.system) : undefined,
        messages: this.toAnthropicMessagesWithCache(request.messages),
        tools: request.tools ? this.toAnthropicToolsWithCache(request.tools) : undefined,
        // Anthropic rejects sampling params alongside thinking.
        temperature: thinking ? undefined : request.temperature,
        top_p: thinking ? undefined : request.topP,
        stop_sequences: request.stopSequences,
        ...(thinking ? { thinking: thinking as never } : {}),
      },
      needsInterleavedBeta
        ? { headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" } }
        : undefined,
    );

    const usage = response.usage as unknown as Record<string, number>;
    return {
      id: response.id,
      content: this.fromAnthropicContent(response.content),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      },
      model: response.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    const { thinking, needsInterleavedBeta } = this.buildThinkingParam(request);
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system ? this.toSystemWithCache(request.system) : undefined,
        messages: this.toAnthropicMessagesWithCache(request.messages),
        tools: this.buildTools(request),
        // Anthropic rejects sampling params alongside thinking.
        temperature: thinking ? undefined : request.temperature,
        top_p: thinking ? undefined : request.topP,
        stop_sequences: request.stopSequences,
        ...(thinking ? { thinking: thinking as never } : {}),
      },
      {
        signal: opts?.signal,
        ...(needsInterleavedBeta
          ? { headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" } }
          : {}),
      },
    );

    let contentIndex = 0;
    let currentToolCallId: string | null = null;
    let toolJsonAccumulator = "";
    // Accumulates the in-flight thinking block (text + signature) so a
    // complete, replayable block can be emitted at content_block_stop.
    let currentThinking: { text: string; signature: string } | null = null;
    // Anthropic reports input/cache token counts on message_start and only
    // output tokens on the final message_delta — capture the former so the
    // usage we emit at message_stop is complete (the context engine relies on
    // real input counts to schedule compaction).
    let startUsage: { input: number; cacheRead: number; cacheCreation: number } = {
      input: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const u = event.message.usage as unknown as Record<string, number> | undefined;
          startUsage = {
            input: u?.input_tokens ?? 0,
            cacheRead: u?.cache_read_input_tokens ?? 0,
            cacheCreation: u?.cache_creation_input_tokens ?? 0,
          };
          yield { type: "message_start", messageId: event.message.id };
          break;
        }

        case "content_block_start": {
          const block = event.content_block;
          contentIndex = event.index;
          if (block.type === "text") {
            yield { type: "content_start", contentIndex };
          } else if (block.type === "tool_use") {
            currentToolCallId = block.id;
            toolJsonAccumulator = "";
            yield {
              type: "tool_use_start",
              toolCallId: block.id,
              toolName: block.name,
            };
          } else if (block.type === "thinking") {
            currentThinking = { text: "", signature: "" };
          } else if (block.type === "redacted_thinking") {
            // Opaque, complete on arrival — forward for verbatim round-trip.
            const data = (block as unknown as { data?: string }).data ?? "";
            yield { type: "redacted_thinking", data };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield {
              type: "content_delta",
              contentIndex,
              delta: { type: "text_delta", text: delta.text },
            };
          } else if (delta.type === "input_json_delta" && currentToolCallId) {
            toolJsonAccumulator += delta.partial_json;
            yield {
              type: "tool_use_delta",
              toolCallId: currentToolCallId,
              partialJson: delta.partial_json,
            };
          } else if (delta.type === "thinking_delta" && currentThinking) {
            const text = (delta as unknown as { thinking?: string }).thinking ?? "";
            currentThinking.text += text;
            if (text) yield { type: "thinking_delta", text };
          } else if (delta.type === "signature_delta" && currentThinking) {
            currentThinking.signature +=
              (delta as unknown as { signature?: string }).signature ?? "";
          }
          break;
        }

        case "content_block_stop":
          if (currentToolCallId) {
            const toolInput = parseToolArguments(toolJsonAccumulator);
            yield {
              type: "tool_use_stop",
              toolCallId: currentToolCallId,
              toolInput,
            };
            currentToolCallId = null;
            toolJsonAccumulator = "";
          } else if (currentThinking) {
            yield {
              type: "thinking_stop",
              thinking: currentThinking.text,
              signature: currentThinking.signature || undefined,
            };
            currentThinking = null;
          } else {
            yield { type: "content_stop", contentIndex };
          }
          break;

        case "message_delta": {
          const eventUsage = event.usage as unknown as Record<string, number> | undefined;
          const usage: TokenUsage = {
            // message_delta usually omits input tokens — fall back to the
            // counts captured from message_start.
            inputTokens: eventUsage?.input_tokens || startUsage.input,
            outputTokens: event.usage?.output_tokens ?? 0,
            cacheReadTokens: eventUsage?.cache_read_input_tokens ?? startUsage.cacheRead,
            cacheCreationTokens:
              eventUsage?.cache_creation_input_tokens ?? startUsage.cacheCreation,
          };
          yield {
            type: "message_stop",
            stopReason: this.mapStopReason(event.delta.stop_reason),
            usage,
          };
          break;
        }
      }
    }
  }

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    const result = await this.client.messages.countTokens({
      model: "claude-sonnet-4-6",
      messages: this.toAnthropicMessages(messages),
      tools: tools ? this.toAnthropicTools(tools) : undefined,
    });
    return result.input_tokens;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Thinking ───

  /** Models where thinking is adaptive (no token budget; budget_tokens is rejected). */
  private static readonly ADAPTIVE_THINKING = /opus-4-[6-9]|sonnet-4-6|sonnet-5|fable|mythos/;
  /** Models that support budgeted extended thinking. */
  private static readonly BUDGET_THINKING = /3-7-sonnet|opus-4|sonnet-4|haiku-4-5/;

  /**
   * Map the request's provider-neutral thinking flag onto the wire form the
   * target model accepts. Returns the `thinking` param (or undefined when the
   * model has no thinking support / the budget wouldn't fit) plus whether the
   * interleaved-thinking beta header is needed (budget mode + tools).
   */
  private buildThinkingParam(request: InferenceRequest): {
    thinking?: Record<string, unknown>;
    needsInterleavedBeta: boolean;
  } {
    if (!request.thinking?.enabled) return { needsInterleavedBeta: false };
    const model = request.model.toLowerCase();

    if (AnthropicProvider.ADAPTIVE_THINKING.test(model)) {
      return { thinking: { type: "adaptive" }, needsInterleavedBeta: false };
    }

    if (AnthropicProvider.BUDGET_THINKING.test(model)) {
      // budget_tokens must be ≥1024 and < max_tokens.
      const budget = Math.min(
        request.thinking.budgetTokens ?? 16_000,
        Math.floor(request.maxTokens / 2),
      );
      if (budget < 1024) return { needsInterleavedBeta: false };
      return {
        thinking: { type: "enabled", budget_tokens: budget },
        // Interleaved thinking (thinking between tool calls) needs the beta
        // header on budget-mode models; harmless without tools.
        needsInterleavedBeta: true,
      };
    }

    return { needsInterleavedBeta: false };
  }

  // ─── Translation Helpers ───

  /** Wraps the system prompt in a text block array with ephemeral cache_control. */
  private toSystemWithCache(system: string): Anthropic.TextBlockParam[] {
    return [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  /**
   * Converts messages and adds cache_control to the last content block of the
   * last message so the full conversation prefix is eligible for caching.
   */
  private toAnthropicMessagesWithCache(messages: Message[]): Anthropic.MessageParam[] {
    const filtered = messages.filter((m) => m.role !== "system");
    return filtered.map((msg, msgIdx) => {
      const isLast = msgIdx === filtered.length - 1;
      const blocks = msg.content.map((block, blkIdx) => {
        const isLastBlock = blkIdx === msg.content.length - 1;
        const base = this.toAnthropicBlock(block);
        // thinking blocks cannot carry cache_control (API rejects it).
        const cacheable = block.type !== "thinking" && block.type !== "redacted_thinking";
        if (isLast && isLastBlock && cacheable) {
          return { ...base, cache_control: { type: "ephemeral" as const } };
        }
        return base;
      });
      return {
        role: msg.role === "tool" ? "user" : (msg.role as "user" | "assistant"),
        content: blocks,
      };
    });
  }

  /** For backwards-compat internal use (e.g. countTokens — no cache_control needed). */
  private toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((msg) => ({
        role: msg.role === "tool" ? "user" : (msg.role as "user" | "assistant"),
        content: msg.content.map((block) => this.toAnthropicBlock(block)),
      }));
  }

  private toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        // Replayed VERBATIM (signature included) — Anthropic validates
        // signatures and rejects modified thinking blocks in tool-use loops.
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature ?? "",
        } as Anthropic.ContentBlockParam;
      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          data: block.data,
        } as Anthropic.ContentBlockParam;
      case "tool_use":
        return {
          type: "tool_use",
          id: block.toolCallId,
          name: block.toolName,
          input: block.toolInput,
        };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content: block.toolResultContent,
          is_error: block.isError,
        };
      case "image":
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: block.data,
          },
        };
    }
  }

  /**
   * Build the request's tool list: the user's function tools plus, when
   * native grounding is enabled, Anthropic's server-side web_search tool.
   *
   * `web_search_20250305` isn't in this SDK version's static `Tool` union (it
   * was added to the API later), but the Messages endpoint accepts it — so we
   * send it over the wire via a cast. The model runs the search server-side and
   * returns the answer inline.
   */
  private buildTools(request: InferenceRequest): Anthropic.Tool[] | undefined {
    const tools: Anthropic.Tool[] = request.tools
      ? this.toAnthropicToolsWithCache(request.tools)
      : [];
    if (request.enableWebSearch) {
      tools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Tool);
    }
    return tools.length > 0 ? tools : undefined;
  }

  /**
   * Converts tools and adds cache_control to the LAST tool so the stable
   * tools + system prefix is cached as a single prefix.
   */
  private toAnthropicToolsWithCache(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t, idx) => {
      const base: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      };
      if (idx === tools.length - 1) {
        return { ...base, cache_control: { type: "ephemeral" } };
      }
      return base;
    });
  }

  /** For backwards-compat internal use (e.g. countTokens — no cache_control needed). */
  private toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  private fromAnthropicContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
    return content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          toolCallId: block.id,
          toolName: block.name,
          toolInput: block.input as Record<string, unknown>,
        };
      }
      if (block.type === "thinking") {
        const b = block as unknown as { thinking?: string; signature?: string };
        return {
          type: "thinking" as const,
          thinking: b.thinking ?? "",
          signature: b.signature,
        };
      }
      if (block.type === "redacted_thinking") {
        const b = block as unknown as { data?: string };
        return { type: "redacted_thinking" as const, data: b.data ?? "" };
      }
      return { type: "text" as const, text: "" };
    });
  }

  private mapStopReason(reason: string | null | undefined): StopReason {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }
}
