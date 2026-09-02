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
 * A content-addressed responder, for scripts a sequential index cannot express.
 *
 * The index script assumes one loop consuming responses in order. That holds
 * for a lead agent and breaks the moment work is PARALLEL: four workers running
 * concurrently interleave their inference calls nondeterministically, so entry
 * N belongs to whichever worker happened to get there first. A responder keys
 * on the request instead — the worker system prompt names the files that worker
 * owns — which makes a four-worker eval deterministic without pretending the
 * concurrency is not real.
 *
 * Returning null falls through to the index script, so a task can use both: a
 * responder for the parallel part and a script for the lead's own turns.
 */
export type Responder = (request: InferenceRequest) => ScriptedResponse | null;

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

  private responder: Responder | null = null;

  constructor(script: Script) {
    this.script = script;
  }

  setResponder(responder: Responder | null): void {
    this.responder = responder;
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

    const addressed = this.responder?.(request) ?? null;
    if (!addressed && this.callIndex >= this.script.length) {
      yield { type: "error", error: "MockProvider script exhausted" };
      return;
    }

    const r = addressed ?? this.script[this.callIndex++];
    const messageId = `mock_msg_${addressed ? "addr" : this.callIndex}_${++this.callIdCounter}`;

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
