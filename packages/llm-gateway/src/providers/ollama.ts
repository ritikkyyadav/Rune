import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  StopReason,
  StreamEvent,
  StreamOpts,
  TokenUsage,
  ToolDefinition,
} from "../types";
import { parseApiErrorBody } from "../types";
import { IdleWatchdog } from "./stream-guard";

// ─── Ollama wire types (subset of /api/chat) ───

interface OllamaToolCall {
  function: { name: string; arguments?: Record<string, unknown> };
}

interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatChunk {
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface StreamState {
  usage: TokenUsage;
  stopReason: StopReason;
  sawTool: boolean;
  toolIndex: number;
}

/**
 * Local-first provider for an Ollama server (default http://localhost:11434).
 * Needs no API key — this is the "local-only mode" path for code that may not
 * leave the machine. Talks to /api/chat (NDJSON streaming) and /api/tags.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = "ollama" as const;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    let b = baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    if (!/^https?:\/\//.test(b)) b = `http://${b}`;
    this.baseUrl = b.replace(/\/$/, "");
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.buildBody(request, false)),
      signal: request.signal,
    });

    if (!response.ok) {
      throw parseApiErrorBody(await response.text(), response.status, "ollama");
    }

    const data = (await response.json()) as OllamaChatChunk;
    const content = this.fromMessage(data.message);
    const sawTool = content.some((b) => b.type === "tool_use");

    return {
      id: `ollama_${Date.now()}`,
      content,
      stopReason: this.mapDoneReason(data.done_reason, sawTool),
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: request.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Wedged-stream protection, with GENEROUS allowances: local inference on a
    // big model can legitimately pause a long time before/between tokens
    // (model load, CPU offload), so only a truly dead stream trips this.
    const guard = new IdleWatchdog(this.name, opts?.signal, 300_000, 120_000);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.buildBody(request, true)),
      signal: guard.signal,
    });

    if (!response.ok || !response.body) {
      throw parseApiErrorBody(await response.text(), response.status, "ollama");
    }

    yield { type: "message_start", messageId: `ollama_${Date.now()}` };
    yield { type: "content_start", contentIndex: 0 };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const state: StreamState = {
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
      sawTool: false,
      toolIndex: 0,
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        guard.beat();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the trailing partial line
        for (const line of lines) {
          const chunk = parseLine(line);
          if (chunk) yield* this.handleChunk(chunk, state);
        }
      }
      // Flush any final line that lacked a trailing newline.
      const tail = parseLine(buffer);
      if (tail) yield* this.handleChunk(tail, state);
    } catch (err) {
      // Watchdog stall (not the caller's Esc) → retryable 504 for the gateway.
      throw guard.timeoutError() ?? err;
    } finally {
      reader.releaseLock();
      guard.stop();
    }

    yield { type: "content_stop", contentIndex: 0 };
    yield { type: "message_stop", stopReason: state.stopReason, usage: state.usage };
  }

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    const chars =
      messages.reduce((sum, m) => sum + messageToText(m).length, 0) +
      (tools ? JSON.stringify(tools).length : 0);
    return Math.ceil(chars / 4);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Live model discovery via Ollama's /api/tags (locally pulled models). */
  async listModels(): Promise<ModelInfo[]> {
    const r = await fetch(`${this.baseUrl}/api/tags`);
    if (!r.ok) throw new Error(`ollama /api/tags failed (${r.status})`);
    const json = (await r.json()) as { models?: { name?: string; model?: string }[] };
    return (json.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((n): n is string => !!n)
      .map((id) => ({ id, label: id, live: true }));
  }

  /**
   * Real context window for one model, from /api/show.
   *
   * /api/tags — what listModels uses — returns names only, so every Ollama
   * model fell to the tokenizer's conservative 100k default and was compacted
   * far below its real window. /api/show reports `model_info` keyed by
   * architecture (`llama.context_length`, `qwen3moe.context_length`, …), so
   * the key is found by suffix rather than guessed per family.
   */
  async describeModel(id: string): Promise<ModelInfo | null> {
    try {
      const r = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
      });
      if (!r.ok) return null;
      const json = (await r.json()) as { model_info?: Record<string, unknown> };
      const info = json.model_info ?? {};
      const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
      const raw = key ? info[key] : undefined;
      const contextLimit = typeof raw === "number" && raw > 0 ? Math.floor(raw) : undefined;
      return { id, label: id, live: true, ...(contextLimit ? { contextLimit } : {}) };
    } catch {
      // Runtime unreachable — the static floor stands.
      return null;
    }
  }

  // ── internals ──

  private *handleChunk(chunk: OllamaChatChunk, state: StreamState): Generator<StreamEvent> {
    const msg = chunk.message;
    if (msg?.content) {
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: msg.content },
      };
    }
    if (msg?.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const id = `ollama_tool_${Date.now()}_${state.toolIndex++}`;
        const args = tc.function.arguments ?? {};
        state.sawTool = true;
        yield { type: "tool_use_start", toolCallId: id, toolName: tc.function.name };
        yield { type: "tool_use_delta", toolCallId: id, partialJson: JSON.stringify(args) };
        yield { type: "tool_use_stop", toolCallId: id, toolInput: args };
      }
    }
    if (chunk.done) {
      state.usage = {
        inputTokens: chunk.prompt_eval_count ?? 0,
        outputTokens: chunk.eval_count ?? 0,
      };
      state.stopReason = this.mapDoneReason(chunk.done_reason, state.sawTool);
    }
  }

  private buildBody(request: InferenceRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: this.toOllamaMessages(request.messages, request.system),
      stream,
      ...(request.tools?.length && { tools: request.tools.map(toOllamaTool) }),
      // Thinking explicitly disabled → top-level `think: false` so a reasoning
      // model (qwen3, deepseek-r1, gemma) answers directly instead of spending
      // a small num_predict budget on <think>. Ollama only rejects the field
      // when it is TRUTHY on a non-thinking model, so false is safe everywhere.
      ...(request.thinking?.enabled === false && { think: false }),
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        num_predict: request.maxTokens,
        ...(request.stopSequences?.length && { stop: request.stopSequences }),
      },
    };
  }

  private toOllamaMessages(messages: Message[], system?: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (system) out.push({ role: "system", content: system });

    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        for (const b of m.content) {
          if (b.type === "tool_result") out.push({ role: "tool", content: b.toolResultContent });
        }
        continue;
      }

      const text: string[] = [];
      const toolCalls: OllamaToolCall[] = [];
      for (const b of m.content) {
        if (b.type === "text") text.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({ function: { name: b.toolName, arguments: b.toolInput } });
        }
      }

      const msg: Record<string, unknown> = {
        role: m.role === "assistant" ? "assistant" : "user",
        content: text.join("\n"),
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
    return out;
  }

  private fromMessage(msg: OllamaMessage | undefined): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (msg?.content) blocks.push({ type: "text", text: msg.content });
    if (msg?.tool_calls) {
      msg.tool_calls.forEach((tc, i) => {
        blocks.push({
          type: "tool_use",
          toolCallId: `ollama_tool_${Date.now()}_${i}`,
          toolName: tc.function.name,
          toolInput: tc.function.arguments ?? {},
        });
      });
    }
    return blocks;
  }

  private mapDoneReason(reason: string | undefined, sawTool: boolean): StopReason {
    if (sawTool) return "tool_use";
    if (reason === "length") return "max_tokens";
    return "end_turn";
  }
}

function parseLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaChatChunk;
  } catch {
    return null;
  }
}

function toOllamaTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
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
