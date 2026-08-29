import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  StreamEvent,
  StopReason,
  StreamOpts,
  ToolDefinition,
  TokenUsage,
} from "../types";
import { parseApiErrorBody } from "../types";
import { tryParseJson } from "@gear/shared";
import { IdleWatchdog } from "./stream-guard";

interface GeminiPart {
  text?: string;
  /** True on thought-summary parts (only present when includeThoughts is requested). */
  thought?: boolean;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[];
  webSearchQueries?: string[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  groundingMetadata?: GeminiGroundingMetadata;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /** Portion of promptTokenCount served from implicit or explicit cache. */
    cachedContentTokenCount?: number;
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
      request.signal,
    );

    const candidate = response.candidates?.[0];
    const hasToolUse = candidate?.content?.parts?.some((part) => part.functionCall) ?? false;

    const content = this.fromGeminiCandidate(candidate);
    const hasText = content.some((b) => b.type === "text" && b.text.trim());
    throwOnUnusableFinish(candidate?.finishReason, hasToolUse, hasText);
    const sources = this.groundingSources(candidate);
    if (sources) content.push({ type: "text", text: sources });

    return {
      id: `google_${Date.now()}`,
      content,
      stopReason: this.mapFinishReason(candidate?.finishReason, hasToolUse),
      usage: this.fromUsage(response),
      model: request.model,
    };
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Wedged-stream protection: previously no timeout — a stalled SSE session
    // hung the turn until the user hit Esc. Generous allowances: Gemini Pro
    // thinking is hidden (no streamed deltas), so a legitimate reasoning pause
    // can run minutes of silence.
    const guard = new IdleWatchdog(this.name, opts?.signal, 240_000, 120_000);
    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.toGeminiRequest(request)),
        signal: guard.signal,
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
    let finishReason: string | undefined;
    let sawToolUse = false;
    let sawText = false;
    let groundingCandidate: GeminiCandidate | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        guard.beat();

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event.split(/\r?\n/).find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          const payload = dataLine.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;

          // Skip an unparseable SSE event (partial frame / keepalive / error blob) rather than
          // letting one bad chunk throw and abort the whole stream.
          const parsedEvent = tryParseJson(payload);
          if (parsedEvent === undefined) continue;
          const parsed = parsedEvent as GeminiResponse;
          const candidate = parsed.candidates?.[0];
          if (parsed.usageMetadata) usage = this.fromUsage(parsed);
          if (candidate?.finishReason) finishReason = candidate.finishReason;
          if (candidate?.groundingMetadata) groundingCandidate = candidate;

          for (const block of this.fromGeminiCandidate(candidate)) {
            if (block.type === "text" && block.text) {
              sawText = true;
              yield {
                type: "content_delta",
                contentIndex: 0,
                delta: { type: "text_delta", text: block.text },
              };
            } else if (block.type === "tool_use") {
              sawToolUse = true;
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
    } catch (err) {
      // Watchdog stall (not the caller's Esc) → retryable 504 for the gateway.
      throw guard.timeoutError() ?? err;
    } finally {
      reader.releaseLock();
      guard.stop();
    }

    // A stream that ends MALFORMED_FUNCTION_CALL (Gemini botched the tool-call
    // encoding — common with large arguments) or safety-blocked carries no
    // usable parts, yet arrives as a "successful" stream. Returning it as a
    // normal stop made the agent end a SILENT EMPTY TURN — observed live on
    // 2026-07-07 (/interactive → fallback to Gemini → nothing rendered, no
    // error). Throw instead: the gateway retries/falls back, and if this was
    // the last provider the user gets a real error they can act on.
    throwOnUnusableFinish(finishReason, sawToolUse, sawText);

    const sources = this.groundingSources(groundingCandidate);
    if (sources) {
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: sources },
      };
    }

    yield { type: "content_stop", contentIndex: 0 };
    yield {
      type: "message_stop",
      stopReason: this.mapFinishReason(finishReason, sawToolUse),
      usage,
    };
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

  /** Live model discovery via Gemini's models.list (generateContent-capable only). */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) throw new Error("GOOGLE_API_KEY is required to list models");
    const res = await fetch(
      `${this.baseUrl}/models?pageSize=200&key=${encodeURIComponent(this.apiKey)}`,
    );
    if (!res.ok) throw new Error(`Google models.list failed (${res.status})`);
    const json = (await res.json()) as {
      models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };
    return (json.models ?? [])
      .filter(
        (m) =>
          !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"),
      )
      .map((m) => {
        const id = (m.name ?? "").replace(/^models\//, "");
        return { id, label: m.displayName ?? id, live: true };
      })
      .filter((m) => m.id.length > 0);
  }

  private async post<T>(
    model: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error("GOOGLE_API_KEY is required for the Google provider");
    }

    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw parseApiErrorBody(body, response.status, "google");
    }
    return (await response.json()) as T;
  }

  private toGeminiRequest(request: InferenceRequest): Record<string, unknown> {
    const tools: Record<string, unknown>[] = [];
    const functionDeclarations = request.tools?.length ? request.tools.map(toGeminiTool) : [];
    if (functionDeclarations.length > 0) {
      tools.push({ functionDeclarations });
    }
    // Gemini rejects a request that combines the googleSearch built-in tool with
    // functionDeclarations ("Built-in tools and Function Calling cannot be combined
    // in the same request"). They are mutually exclusive, so grounding is only
    // attached when no function tools are present. The agent loop already picks one
    // or the other per request (see providerAllowsGroundingWithTools); this guard
    // ensures the provider can never emit an API-invalid request — function tools
    // win because an agent depends on them.
    if (request.enableWebSearch && functionDeclarations.length === 0) {
      // Gemini 2.x grounding: the model runs Google Search during generation
      // and returns citations in groundingMetadata.
      tools.push({ googleSearch: {} });
    }

    const thinkingConfig = geminiThinkingConfig(request);
    return {
      contents: this.toGeminiContents(request.messages),
      ...(request.system && { systemInstruction: { parts: [{ text: request.system }] } }),
      ...(tools.length > 0 && { tools }),
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        stopSequences: request.stopSequences,
        ...(thinkingConfig && { thinkingConfig }),
      },
    };
  }

  private toGeminiContents(messages: Message[]): GeminiContent[] {
    // Gemini correlates a functionResponse with its functionCall by NAME (there
    // is no call-id concept), so map our internal tool-call ids back to the tool
    // name when serializing tool results.
    const callIdToName = new Map<string, string>();
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === "tool_use") callIdToName.set(block.toolCallId, block.toolName);
      }
    }

    return messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: message.content.flatMap((block): GeminiPart[] => {
          if (block.type === "text") return [{ text: block.text }];
          if (block.type === "image") {
            return [{ inlineData: { mimeType: block.mediaType, data: block.data } }];
          }
          if (block.type === "tool_result") {
            return [
              {
                functionResponse: {
                  name: callIdToName.get(block.toolCallId) ?? block.toolCallId,
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
    // Thought summaries (`thought: true` parts) are reasoning, not the answer;
    // they only appear when includeThoughts is requested, which Gear never does.
    const parts = (candidate?.content?.parts ?? []).filter((part) => !part.thought);
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

  /** Format grounding citations as a Markdown "Sources" list (or "" if none). */
  private groundingSources(candidate: GeminiCandidate | undefined): string {
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      lines.push(`- [${chunk.web?.title || uri}](${uri})`);
    }
    return lines.length > 0 ? `\n\nSources:\n${lines.join("\n")}` : "";
  }

  /**
   * Gemini reports `promptTokenCount` INCLUSIVE of the cached portion, so the
   * cached count is subtracted here to satisfy the TokenUsage contract (three
   * disjoint input counts that sum to the total). Reporting both without
   * subtracting would double-count the cache in context-window accounting.
   */
  private fromUsage(response: GeminiResponse): TokenUsage {
    const prompt = response.usageMetadata?.promptTokenCount ?? 0;
    const cached = response.usageMetadata?.cachedContentTokenCount ?? 0;
    const cacheReadTokens = Math.min(Math.max(cached, 0), prompt);
    return {
      inputTokens: prompt - cacheReadTokens,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    };
  }

  private mapFinishReason(reason: string | undefined, hasToolUse = false): StopReason {
    switch (reason) {
      case "MAX_TOKENS":
        return "max_tokens";
      case "MALFORMED_FUNCTION_CALL":
      case "UNEXPECTED_TOOL_CALL":
        return "tool_use";
      case "STOP":
      default:
        // Gemini reports finishReason "STOP" even when the turn emitted function
        // calls, so detect tool use from the response parts, not the reason.
        return hasToolUse ? "tool_use" : "end_turn";
    }
  }
}

/**
 * Gemini thinking dial for the request's provider-neutral `thinking` flag.
 * Only models that actually support the field receive it (an unknown
 * generationConfig key is a 400 on older models):
 *   - thinking disabled → 2.5 Flash/Flash-Lite: thinkingBudget 0 (off);
 *     2.5 Pro cannot switch thinking off — 128 is its documented floor;
 *     Gemini 3.x uses thinkingLevel, whose floor is "low".
 *   - thinking enabled with an explicit budget → 2.5 family thinkingBudget.
 *   - otherwise the model's own default (dynamic thinking) is left alone.
 * Thought summaries are never requested (includeThoughts false).
 */
export function geminiThinkingConfig(
  request: Pick<InferenceRequest, "model" | "thinking">,
): Record<string, unknown> | undefined {
  const model = request.model.toLowerCase();
  const is25 = /^gemini-2\.5-/.test(model);
  const is25Pro = /^gemini-2\.5-pro/.test(model);
  const is3 = /^gemini-3/.test(model);
  if (request.thinking?.enabled === false) {
    if (is25) return { thinkingBudget: is25Pro ? 128 : 0, includeThoughts: false };
    if (is3) return { thinkingLevel: "low", includeThoughts: false };
    return undefined;
  }
  if (request.thinking?.enabled && request.thinking.budgetTokens && is25) {
    const floor = is25Pro ? 128 : 0;
    return {
      thinkingBudget: Math.max(floor, Math.floor(request.thinking.budgetTokens)),
      includeThoughts: false,
    };
  }
  return undefined;
}

// Finish reasons whose responses carry no usable output. MALFORMED/UNEXPECTED
// tool calls arrive with zero parts; the safety family can also strip
// everything. In both shapes the request "succeeded" while producing nothing.
const TOOL_CALL_FAILURE_REASONS = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"]);
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "PROHIBITED_CONTENT",
  "SPII",
  "BLOCKLIST",
  "IMAGE_SAFETY",
]);

/**
 * Throw when Gemini's finish reason says the response is unusable:
 *  - a malformed/unexpected function call that delivered no actual tool_use,
 *  - a safety-class block that delivered no content at all.
 * The error carries no HTTP status, which the gateway treats as fall-back-able,
 * so the request moves to the next provider instead of ending a silent turn.
 */
function throwOnUnusableFinish(
  finishReason: string | undefined,
  sawToolUse: boolean,
  sawText: boolean,
): void {
  if (!finishReason) return;
  if (TOOL_CALL_FAILURE_REASONS.has(finishReason) && !sawToolUse) {
    throw new Error(
      `Gemini ended with ${finishReason} and no usable tool call — the model failed to encode the function call (retryable)`,
    );
  }
  if (BLOCKED_FINISH_REASONS.has(finishReason) && !sawToolUse && !sawText) {
    throw new Error(`Gemini blocked the response (${finishReason}) and returned no content`);
  }
}

function toGeminiTool(tool: ToolDefinition): Record<string, unknown> {
  const decl: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
  };
  const parameters = sanitizeGeminiSchema(tool.inputSchema);
  if (parameters && typeof parameters === "object") decl.parameters = parameters;
  return decl;
}

// Gemini's FunctionDeclaration.parameters is an OpenAPI-3.0 Schema subset, not full
// JSON Schema. Keywords that MCP servers and skill authors routinely emit ($schema,
// additionalProperties, $ref, oneOf/allOf, const, …) make the API reject the WHOLE
// request — "Invalid JSON payload received. Unknown name \"$schema\" … Cannot find
// field." We can't predict every keyword a tool might carry, so prune to a whitelist
// of fields Gemini's Schema proto actually defines; anything else is dropped. This
// keeps the request structurally valid no matter what a tool's schema contains.
const GEMINI_SCHEMA_FIELDS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "default",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // JSON-Schema `const` has no Gemini equivalent; preserve the constraint as a
  // single-value `enum` (which Gemini does support) instead of silently dropping it.
  if ("const" in src && !("enum" in src)) out.enum = [src.const];

  for (const [key, value] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeGeminiSchema(sub);
      }
      out[key] = props;
    } else if (key === "items" || key === "anyOf") {
      out[key] = sanitizeGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
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
