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
import { parseApiErrorBody } from "../types";

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GoogleProvider implements LlmProvider {
  readonly name = "google" as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl = "https://generativelanguage.googleapis.com/v1beta") {
    this.apiKey = apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const response = await this.post<GeminiResponse>(
      request.model,
      "generateContent",
      this.toGeminiRequest(request),
    );

    return {
      id: `google_${Date.now()}`,
      content: this.fromGeminiCandidate(response.candidates?.[0]),
      stopReason: this.mapFinishReason(response.candidates?.[0]?.finishReason),
      usage: this.fromUsage(response),
      model: request.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.toGeminiRequest(request)),
        signal: opts?.signal,
      },
    );

    if (!response.ok || !response.body) {
      const body = await response.text();
      throw parseApiErrorBody(body, response.status, "google");
    }

    const messageId = `google_${Date.now()}`;
    yield { type: "message_start", messageId };
    yield { type: "content_start", contentIndex: 0 };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event.split(/\r?\n/).find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          const payload = dataLine.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;

          const parsed = JSON.parse(payload) as GeminiResponse;
          const candidate = parsed.candidates?.[0];
          usage = this.fromUsage(parsed);
          stopReason = this.mapFinishReason(candidate?.finishReason);

          for (const block of this.fromGeminiCandidate(candidate)) {
            if (block.type === "text" && block.text) {
              yield {
                type: "content_delta",
                contentIndex: 0,
                delta: { type: "text_delta", text: block.text },
              };
            } else if (block.type === "tool_use") {
              yield {
                type: "tool_use_start",
                toolCallId: block.toolCallId,
                toolName: block.toolName,
              };
              const argsJson = JSON.stringify(block.toolInput);
              yield {
                type: "tool_use_delta",
                toolCallId: block.toolCallId,
                partialJson: argsJson,
              };
              yield {
                type: "tool_use_stop",
                toolCallId: block.toolCallId,
                toolInput: block.toolInput,
              };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "content_stop", contentIndex: 0 };
    yield { type: "message_stop", stopReason, usage };
  }

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    const chars =
      messages.reduce((sum, message) => sum + messageToText(message).length, 0) +
      (tools ? JSON.stringify(tools).length : 0);
    return Math.ceil(chars / 4);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.post("gemini-2.5-flash", "generateContent", {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async post<T>(model: string, method: string, body: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new Error("GOOGLE_API_KEY is required for the Google provider");
    }

    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw parseApiErrorBody(body, response.status, "google");
    }
    return (await response.json()) as T;
  }

  private toGeminiRequest(request: InferenceRequest): Record<string, unknown> {
    return {
      contents: this.toGeminiContents(request.messages),
      ...(request.system && { systemInstruction: { parts: [{ text: request.system }] } }),
      ...(request.tools?.length && {
        tools: [{ functionDeclarations: request.tools.map(toGeminiTool) }],
      }),
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        stopSequences: request.stopSequences,
      },
    };
  }

  private toGeminiContents(messages: Message[]): GeminiContent[] {
    return messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: message.content.flatMap((block): GeminiPart[] => {
          if (block.type === "text") return [{ text: block.text }];
          if (block.type === "tool_result") {
            return [
              {
                functionResponse: {
                  name: block.toolCallId,
                  response: { content: block.toolResultContent, isError: block.isError ?? false },
                },
              },
            ];
          }
          if (block.type === "tool_use") {
            return [{ functionCall: { name: block.toolName, args: block.toolInput } }];
          }
          return [];
        }),
      }));
  }

  private fromGeminiCandidate(candidate: GeminiCandidate | undefined): ContentBlock[] {
    const parts = candidate?.content?.parts ?? [];
    return parts.map((part, index) => {
      if (part.functionCall) {
        return {
          type: "tool_use" as const,
          toolCallId: `google_tool_${Date.now()}_${index}`,
          toolName: part.functionCall.name,
          toolInput: part.functionCall.args ?? {},
        };
      }
      return { type: "text" as const, text: part.text ?? "" };
    });
  }

  private fromUsage(response: GeminiResponse): TokenUsage {
    return {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  private mapFinishReason(reason: string | undefined): StopReason {
    switch (reason) {
      case "MAX_TOKENS":
        return "max_tokens";
      case "STOP":
        return "end_turn";
      case "MALFORMED_FUNCTION_CALL":
      case "UNEXPECTED_TOOL_CALL":
        return "tool_use";
      default:
        return "end_turn";
    }
  }
}

function toGeminiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function messageToText(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") return block.toolResultContent;
      if (block.type === "tool_use") return JSON.stringify(block.toolInput);
      return "";
    })
    .join("\n");
}
