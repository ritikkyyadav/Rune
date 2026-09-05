import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  StreamEvent,
  ToolDefinition,
} from "@rune/llm-gateway";

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
  /**
   * Fail the stream instead of completing it (P7.8).
   *
   * `provider.stream_error` has fired 59 times on this machine and the eval
   * suite could not express it at all: every scripted response succeeded, so
   * the recovery path — the one that decides whether a mid-stream failure costs
   * a turn or the run — was never measured. The text/tool events emitted before
   * this fire first, so a stream can fail PART WAY, which is the shape that
   * actually happens.
   */
  streamError?: string;
  /**
   * Emit these bytes as the tool-call arguments instead of `JSON.stringify`.
   *
   * `provider.malformed_tool_json_fatal` has fired 22 times. The salvage path
   * in the gateway exists for exactly this and had no deterministic test above
   * the unit level. Paired with `toolCalls` so the call's name is still
   * scripted; `toolInput` carries the parsed args when they parse and `{}` when
   * they do not, which is what a real provider hands over.
   */
  rawToolArgs?: string;
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
 * What the SUMMARIZER is asked, and what it answers.
 *
 * Compaction quality has two halves and only one of them belongs to the
 * harness: what the harness FEEDS the summarizer, and what the model makes of
 * it. A canned answer measures neither. A scripted summarizer that faithfully
 * carries forward everything it was given measures the first half exactly —
 * anything missing afterwards was dropped by the harness, because a summarizer
 * that invents nothing also loses nothing (tests/eval/tasks-compaction.ts).
 */
export interface SummaryRequest {
  /** The summarizer system prompt the context engine composed. */
  system: string;
  /** The single user message: instructions + prior state + the segment. */
  text: string;
  model: string;
  maxTokens: number;
}

export type Summarizer = (req: SummaryRequest) => string;

/** The pre-P10.8 canned reply: right shape, no content. */
const CANNED_SUMMARY =
  "## Goals & requirements\n(mock summary)\n## Key facts & codebase knowledge\n-\n" +
  "## Actions taken & outcomes (files touched, commands run)\n-\n" +
  "## Decisions & open questions\n-\n## Current state & next step\ncontinue";

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
  /** Every summarizer round trip, in order — what compaction actually asked. */
  readonly summaryRequests: SummaryRequest[] = [];
  /** What this mock answered each of them. */
  readonly summaryReplies: string[] = [];

  private responder: Responder | null = null;
  private summarizer: Summarizer | null = null;

  constructor(script: Script) {
    this.script = script;
  }

  setResponder(responder: Responder | null): void {
    this.responder = responder;
  }

  /** Drive the summarizer instead of returning the canned reply. */
  setSummarizer(summarizer: Summarizer | null): void {
    this.summarizer = summarizer;
  }

  reset(script?: Script): void {
    if (script) this.script = script;
    this.callIndex = 0;
    this.callIdCounter = 0;
    this.requestHistory.length = 0;
    this.summaryRequests.length = 0;
    this.summaryReplies.length = 0;
  }

  get callsConsumed(): number {
    return this.callIndex;
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    // Non-streaming inference backs the context engine's SUMMARIZER. A canned
    // summary keeps compaction functional in mock mode (it used to throw,
    // which made every compaction path untestable in evals); a task that wants
    // to MEASURE compaction supplies its own via setSummarizer.
    const req: SummaryRequest = {
      system: request.system ?? "",
      text: request.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n"),
      model: request.model ?? "mock-model",
      maxTokens: request.maxTokens ?? 0,
    };
    this.summaryRequests.push(req);
    const text = this.summarizer ? this.summarizer(req) : CANNED_SUMMARY;
    this.summaryReplies.push(text);
    return {
      id: "mock_infer",
      content: [{ type: "text", text }],
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
      const argsJson = r.rawToolArgs ?? JSON.stringify(tc.args);
      yield {
        type: "tool_use_delta",
        toolCallId: callId,
        partialJson: argsJson,
      };
      let toolInput: Record<string, unknown> = tc.args;
      if (r.rawToolArgs !== undefined) {
        // What a real provider hands over when its own JSON is broken: the
        // partial bytes are on the wire and the parsed object is empty.
        try {
          toolInput = JSON.parse(r.rawToolArgs) as Record<string, unknown>;
        } catch {
          toolInput = {};
        }
      }
      yield {
        type: "tool_use_stop",
        toolCallId: callId,
        toolInput,
      };
      contentIndex++;
    }

    // A stream that fails PART WAY: whatever was scripted above is already on
    // the wire, and then the connection dies.
    if (r.streamError) {
      yield { type: "error", error: r.streamError };
      return;
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
