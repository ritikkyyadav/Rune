import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  TokenUsage,
} from "../../packages/llm-gateway/src/types";

/** No credentials or network: scripts the same provider boundary as a paid run. */
export class UsageProvider implements LlmProvider {
  readonly name: ProviderName = "anthropic";
  requests: InferenceRequest[] = [];
  onRequest?: (request: InferenceRequest, index: number) => ContentBlock[];
  usage: TokenUsage = { inputTokens: 1000, outputTokens: 100 };
  pending?: Promise<void>;

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    await this.pending;
    return {
      id: "helper",
      model: request.model,
      content: [{ type: "text", text: "Summary: retain the parser goal and verify comments." }],
      stopReason: "end_turn",
      usage: this.usage,
    };
  }
  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const blocks = this.onRequest?.(request, this.requests.length) ?? [
      { type: "text", text: "Ready." },
    ];
    yield { type: "message_start", messageId: "main" };
    for (const [contentIndex, block] of blocks.entries()) {
      if (block.type === "text")
        yield {
          type: "content_delta",
          contentIndex,
          delta: { type: "text_delta", text: block.text },
        };
      if (block.type === "tool_use") {
        yield { type: "tool_use_start", toolCallId: block.toolCallId, toolName: block.toolName };
        yield { type: "tool_use_stop", toolCallId: block.toolCallId, toolInput: block.toolInput };
      }
    }
    yield {
      type: "message_stop",
      stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: this.usage,
    };
  }
  async countTokens(_messages: Message[]): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export const usageRequest = (): InferenceRequest => ({
  stream: true,
  model: "claude-sonnet-5",
  provider: "anthropic",
  maxTokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});
