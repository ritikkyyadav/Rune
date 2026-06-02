import OpenAI from "openai";
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
import { ApiError } from "../types";

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    const resolvedKey = apiKey ?? process.env.OPENAI_API_KEY ?? "dummy";
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(baseUrl && { baseURL: baseUrl }),
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: this.toOpenAIMessages(request.messages, request.system),
      tools: request.tools ? this.toOpenAITools(request.tools) : undefined,
      temperature: request.temperature,
      top_p: request.topP,
      stop: request.stopSequences,
    });

    const choice = response.choices[0];
    const content = this.fromOpenAIChoice(choice);

    return {
      id: response.id,
      content,
      stopReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    // If caller provides a signal, abort our controller when it fires
    opts?.signal?.addEventListener("abort", () => controller.abort());
    const streamTimeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          messages: this.toOpenAIMessages(request.messages, request.system),
          tools: request.tools ? this.toOpenAITools(request.tools) : undefined,
          temperature: request.temperature,
          top_p: request.topP,
          stop: request.stopSequences,
          stream: true,
        },
        { signal: controller.signal },
      );

      let messageId = "";
      let contentIndex = 0;
      let contentStarted = false;
      let gotFinish = false;
      const toolCalls: Map<number, { id: string; name: string; argsJson: string }> = new Map();

      for await (const chunk of stream) {
        // Reset per-chunk timeout
        clearTimeout(streamTimeout);
        const chunkTimeout = setTimeout(() => controller.abort(), 30_000);

        try {
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

          // Handle regular content AND reasoning output (for reasoning models)
          const textChunk = delta?.content || (delta as Record<string, unknown>)?.reasoning;
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

          if (finishReason) {
            gotFinish = true;
            if (contentStarted) {
              yield { type: "content_stop", contentIndex: 0 };
            }
            for (const [, entry] of toolCalls) {
              const toolInput = entry.argsJson ? JSON.parse(entry.argsJson) : {};
              yield { type: "tool_use_stop", toolCallId: entry.id, toolInput };
            }

            const usage: TokenUsage = {
              inputTokens: chunk.usage?.prompt_tokens ?? 0,
              outputTokens: chunk.usage?.completion_tokens ?? 0,
            };
            yield {
              type: "message_stop",
              stopReason: this.mapFinishReason(finishReason),
              usage,
            };
          }
        } finally {
          clearTimeout(chunkTimeout);
        }
      }

      // If stream ended without a finish reason, emit a synthetic stop
      if (!gotFinish) {
        if (contentStarted) {
          yield { type: "content_stop", contentIndex: 0 };
        }
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    } finally {
      clearTimeout(streamTimeout);
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

  // ─── Translation Helpers ───

  private toOpenAIMessages(
    messages: Message[],
    system?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (system) {
      result.push({ role: "system", content: system });
    }

    for (const msg of messages) {
      if (msg.role === "system") continue;

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
        result.push({ role: "user", content: textParts.join("\n") });
      }
    }

    return result;
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

    // Handle regular content or reasoning (for reasoning models like DeepSeek)
    const content =
      choice.message.content || (choice.message as unknown as Record<string, unknown>).reasoning;
    if (content && typeof content === "string") {
      blocks.push({ type: "text", text: content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        blocks.push({
          type: "tool_use",
          toolCallId: tc.id,
          toolName: tc.function.name,
          toolInput: JSON.parse(tc.function.arguments || "{}"),
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
