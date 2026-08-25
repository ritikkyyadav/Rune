import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  StreamEvent,
  ToolDefinition,
} from "@gear/llm-gateway";

/**
 * A scripted response to one model invocation.
 *  - `text`: plain text the model "says"
 *  - `toolCalls`: tool calls the model emits in this response
 *  - `stopReason`: optional override (default: tool_use if toolCalls, else end_turn)
 */
export interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

export type Script = ScriptedResponse[];

/**
 * A pure-TypeScript LlmProvider that returns scripted responses in order.
 * Used by the eval harness to drive the agent loop deterministically
 * without burning API tokens.
 */
export class MockProvider implements LlmProvider {
  readonly name = "anthropic" as const; // pretend to be Anthropic for tool-call shape
  private script: Script;
  private callIndex = 0;
  private callIdCounter = 0;
  /** Snapshot of the messages array passed in on each inference call. */
  readonly requestHistory: Message[][] = [];

  constructor(script: Script) {
    this.script = script;
  }

  reset(script?: Script): void {
    if (script) this.script = script;
    this.callIndex = 0;
    this.callIdCounter = 0;
    this.requestHistory.length = 0;
  }

  get callsConsumed(): number {
    return this.callIndex;
  }

  async infer(_request: InferenceRequest): Promise<InferenceResponse> {
    // Non-streaming inference backs the context engine's SUMMARIZER. A canned
    // summary keeps compaction functional in mock mode (it used to throw,
    // which made every compaction path untestable in evals).
    return {
      id: "mock_infer",
      content: [
        {
          type: "text",
          text:
            "## Goals & requirements\n(mock summary)\n## Key facts & codebase knowledge\n-\n" +
            "## Actions taken & outcomes (files touched, commands run)\n-\n" +
            "## Decisions & open questions\n-\n## Current state & next step\ncontinue",
        },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
      model: "mock-model",
    };
  }

  async *inferStream(request: InferenceRequest): AsyncGenerator<StreamEvent> {
    // Snapshot the inbound messages so the eval can introspect what context
    // the agent loop actually presented to the model.
    this.requestHistory.push(request.messages.map((m) => ({ ...m })));

    if (this.callIndex >= this.script.length) {
      yield { type: "error", error: "MockProvider script exhausted" };
      return;
    }

    const r = this.script[this.callIndex++];
    const messageId = `mock_msg_${this.callIndex}`;

    yield { type: "message_start", messageId };

    let contentIndex = 0;

    if (r.text && r.text.length > 0) {
      yield { type: "content_start", contentIndex };
      yield {
        type: "content_delta",
        contentIndex,
        delta: { type: "text_delta", text: r.text },
      };
      yield { type: "content_stop", contentIndex };
      contentIndex++;
    }

    for (const tc of r.toolCalls ?? []) {
      const callId = `mock_call_${++this.callIdCounter}`;
      yield {
        type: "tool_use_start",
        toolCallId: callId,
        toolName: tc.name,
      };
      const argsJson = JSON.stringify(tc.args);
      yield {
        type: "tool_use_delta",
        toolCallId: callId,
        partialJson: argsJson,
      };
      yield {
        type: "tool_use_stop",
        toolCallId: callId,
        toolInput: tc.args,
      };
      contentIndex++;
    }

    const stopReason =
      r.stopReason ?? (r.toolCalls && r.toolCalls.length > 0 ? "tool_use" : "end_turn");

    yield {
      type: "message_stop",
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async countTokens(_messages: Message[], _tools?: ToolDefinition[]): Promise<number> {
    return 0;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
