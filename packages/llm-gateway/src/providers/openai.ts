import OpenAI from "openai";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  StreamEvent,
  StopReason,
  ToolDefinition,
  TokenUsage,
} from "../types";

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
      ...(baseUrl && { baseURL: baseUrl }),
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

  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: this.toOpenAIMessages(request.messages, request.system),
      tools: request.tools ? this.toOpenAITools(request.tools) : undefined,
      temperature: request.temperature,
      top_p: request.topP,
      stop: request.stopSequences,
      stream: true,
      stream_options: { include_usage: true },
    });

    let messageId = "";
    let contentIndex = 0;
    let contentStarted = false;
    const toolCalls: Map<
      number,
      { id: string; name: string; argsJson: string }
    > = new Map();

    for await (const chunk of stream) {
      if (!messageId && chunk.id) {
        messageId = chunk.id;
        yield { type: "message_start", messageId };
      }

      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;

      if (delta?.content) {
        if (!contentStarted) {
          yield { type: "content_start", contentIndex: 0 };
          contentStarted = true;
        }
        yield {
          type: "content_delta",
          contentIndex: 0,
          delta: { type: "text_delta", text: delta.content },
        };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls.has(idx) && tc.id) {
            toolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", argsJson: "" });
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
        if (contentStarted) {
          yield { type: "content_stop", contentIndex: 0 };
        }
        // Emit tool_use_stop for all accumulated tools
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
    }
  }

  async countTokens(
    messages: Message[],
    _tools?: ToolDefinition[],
  ): Promise<number> {
    // Estimate: ~4 chars per token for English text
    let totalChars = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "text") totalChars += block.text.length;
        else if (block.type === "tool_result")
          totalChars += block.toolResultContent.length;
        else if (block.type === "tool_use")
          totalChars += JSON.stringify(block.toolInput).length;
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

  private toOpenAITools(
    tools: ToolDefinition[],
  ): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private fromOpenAIChoice(
    choice: OpenAI.ChatCompletion.Choice,
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (choice.message.content) {
      blocks.push({ type: "text", text: choice.message.content });
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
