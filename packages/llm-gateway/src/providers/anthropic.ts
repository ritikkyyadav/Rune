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
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system ? this.toSystemWithCache(request.system) : undefined,
      messages: this.toAnthropicMessagesWithCache(request.messages),
      tools: request.tools ? this.toAnthropicToolsWithCache(request.tools) : undefined,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stopSequences,
    });

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
    const stream = this.client.messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system ? this.toSystemWithCache(request.system) : undefined,
        messages: this.toAnthropicMessagesWithCache(request.messages),
        tools: this.buildTools(request),
        temperature: request.temperature,
        top_p: request.topP,
        stop_sequences: request.stopSequences,
      },
      { signal: opts?.signal },
    );

    let contentIndex = 0;
    let currentToolCallId: string | null = null;
    let toolJsonAccumulator = "";

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          yield { type: "message_start", messageId: event.message.id };
          break;

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
          }
          break;
        }

        case "content_block_stop":
          if (currentToolCallId) {
            const toolInput = toolJsonAccumulator ? JSON.parse(toolJsonAccumulator) : {};
            yield {
              type: "tool_use_stop",
              toolCallId: currentToolCallId,
              toolInput,
            };
            currentToolCallId = null;
            toolJsonAccumulator = "";
          } else {
            yield { type: "content_stop", contentIndex };
          }
          break;

        case "message_delta": {
          const eventUsage = event.usage as unknown as Record<string, number> | undefined;
          const usage: TokenUsage = {
            inputTokens: eventUsage?.input_tokens ?? 0,
            outputTokens: event.usage?.output_tokens ?? 0,
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
      model: "claude-sonnet-4-20250514",
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
        if (isLast && isLastBlock) {
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
