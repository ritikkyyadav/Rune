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
/**
 * How long Ollama holds a model — and its KV cache — in memory after a
 * request. The server default is 5 minutes, which is shorter than an agent
 * spends reading a file and thinking, so the cache was routinely evicted
 * between consecutive turns of ONE task. Every eviction costs a full re-prefill
 * of the whole transcript: on a local runtime that is not a bill, it is
 * wall-clock, and it is the difference between a second and a minute on a long
 * context.
 *
 * 30m is long enough to cover a working session and short enough that a
 * forgotten session releases the GPU before it matters.
 */
const DEFAULT_KEEP_ALIVE = "30m";

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama" as const;
  private baseUrl: string;
  /** Passed as `keep_alive` on every request. See DEFAULT_KEEP_ALIVE. */
  readonly keepAlive: string;

  constructor(baseUrl?: string, opts?: { keepAlive?: string }) {
    let b = baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    if (!/^https?:\/\//.test(b)) b = `http://${b}`;
    this.baseUrl = b.replace(/\/$/, "");
    // config.toml `[llm.ollama] keepAlive` wins; GEAR_OLLAMA_KEEP_ALIVE is the
    // escape hatch for one run. Ollama accepts a duration string ("30m", "1h")
    // or a number of seconds; "-1" holds the model indefinitely and "0"
    // unloads immediately.
    this.keepAlive = opts?.keepAlive ?? process.env.GEAR_OLLAMA_KEEP_ALIVE ?? DEFAULT_KEEP_ALIVE;
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

  /**
   * Live model discovery via Ollama's /api/tags (locally pulled models),
   * enriched with each model's REAL context window.
   *
   * /api/tags returns names only, so every listed model previously fell to the
   * tokenizer's conservative 100k default: a 256k model was compacted at a
   * fraction of its window, and the picker could not show what it actually
   * had. The window lives behind a per-model /api/show, so this fans out — to
   * localhost, free, bounded — and degrades to the bare name on any failure.
   */
  async listModels(): Promise<ModelInfo[]> {
    const r = await fetch(`${this.baseUrl}/api/tags`);
    if (!r.ok) throw new Error(`ollama /api/tags failed (${r.status})`);
    const json = (await r.json()) as { models?: { name?: string; model?: string }[] };
    const ids = (json.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((n): n is string => !!n);

    const out: ModelInfo[] = [];
    // Bounded fan-out: a machine with forty pulled models should not open
    // forty sockets at once just to render a list.
    const CONCURRENCY = 6;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          const described = await this.describeModel(id).catch(() => null);
          return described ?? { id, label: id, live: true };
        }),
      );
      out.push(...batch);
    }
    return out;
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
      // Hold the model AND its KV cache between turns. Without this the server
      // unloads after 5 minutes idle and the next turn re-prefills the entire
      // transcript from scratch.
      keep_alive: this.keepAlive,
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
      let images = 0;
      for (const b of m.content) {
        if (b.type === "text") text.push(b.text);
        else if (b.type === "image") images++;
        else if (b.type === "tool_use") {
          toolCalls.push({ function: { name: b.toolName, arguments: b.toolInput } });
        }
      }

      // This translation carries text and tool calls only, so an image block
      // reaching it was DROPPED IN SILENCE — and a silently dropped screenshot
      // is worse than none, because the agent believes it looked and then
      // describes what it assumes is there. Say so instead, in the same shape
      // the OpenAI-compatible adapter uses.
      if (images > 0) {
        text.push(
          `\n[${images} attached image(s) omitted: the ollama transport does not send images ` +
            `- tell the user you could not view them]`,
        );
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
