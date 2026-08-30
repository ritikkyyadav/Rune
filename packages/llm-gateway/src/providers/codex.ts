// ─── ChatGPT Codex transport (subscription) ───
// ChatGPT Plus/Pro sign-in (see oauth/codex.ts) yields a bearer spent against the
// ChatGPT *backend* Codex endpoint — NOT the public OpenAI API. That endpoint
// speaks the OpenAI **Responses** API (input items + a typed SSE event stream),
// which is a different wire format than chat completions, so this is its own
// transport rather than a base-URL swap on OpenAIProvider.
//
// The request presents as the Codex CLI (the `originator` header + account id)
// to spend the user's OWN ChatGPT plan. Officially the same login/flow the
// first-party CLI uses — no scraping, no cookie/session extraction.

import { randomUUID } from "crypto";
import type {
  ReasoningEffort,
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  StopReason,
  StreamEvent,
  StreamOpts,
  ToolDefinition,
  TokenUsage,
} from "../types";
import { ApiError } from "../types";
import { IdleWatchdog } from "./stream-guard";
import { parseToolArguments } from "@gear/shared";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** Models on Codex that reason (send a `reasoning` param + collect thinking). */
const REASONING_MODEL = /^(gpt-5|o[134]|codex)/;
// A reasoning model's reasoning items (with encrypted_content) MUST be echoed
// back in the input before their function call, or a store:false follow-up 400s
// with "No tool output found for function call". We round-trip each reasoning
// item verbatim inside a redacted_thinking block tagged `provider:"codex"`, so
// only Codex replays it and every other provider drops it (no cross-contamination).
const CODEX_PROVIDER = "codex";

// ─── Request translation (pure, exported for tests) ───

/** Map Gear messages to Responses API `input` items (system goes to `instructions`). */
export function toResponsesInput(messages: Message[]): unknown[] {
  const items: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const content: unknown[] = [];
      for (const b of msg.content) {
        if (b.type === "text") content.push({ type: "input_text", text: b.text });
        else if (b.type === "image")
          content.push({ type: "input_image", image_url: `data:${b.mediaType};base64,${b.data}` });
      }
      if (content.length) items.push({ type: "message", role: "user", content });
    } else if (msg.role === "assistant") {
      // Iterate IN ORDER so each reasoning item is replayed immediately before
      // the function_call it produced (required for the store:false tool loop).
      for (const b of msg.content) {
        if (b.type === "text" && b.text) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: b.text }],
          });
        } else if (b.type === "redacted_thinking" && b.provider === CODEX_PROVIDER) {
          try {
            items.push(JSON.parse(b.data));
          } catch {
            // Skip a malformed reasoning payload rather than break the request.
          }
        } else if (b.type === "tool_use") {
          items.push({
            type: "function_call",
            call_id: b.toolCallId,
            name: b.toolName,
            arguments: JSON.stringify(b.toolInput ?? {}),
          });
        }
      }
    } else if (msg.role === "tool") {
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          items.push({
            type: "function_call_output",
            call_id: b.toolCallId,
            output: b.toolResultContent,
          });
        }
      }
    }
  }
  return items;
}

/**
 * Build the Responses API request body — matched to the exact shape the Codex
 * CLI sends to the ChatGPT backend. That backend does STRICT top-level parameter
 * validation and 400s ("Unsupported parameter: X") on anything it doesn't expect,
 * so we send ONLY its known fields:
 *   - reasoning carries BOTH `summary` and `effort`. This used to send `summary`
 *     alone, on the belief that the sol/terra/luna variants encode effort in the
 *     model name and that `reasoning.effort` was "an API-key-only param rejected
 *     here". Both halves were wrong, and the cost was the whole product: every
 *     ChatGPT-subscription session ran at the server default with `max`
 *     unreachable, which is why a frontier model felt weaker here than a small
 *     one on OpenRouter. Measured against the live backend on 2026-08-30 —
 *     effort=low/medium/high/xhigh/max all return 200 on gpt-5.6-sol, and the
 *     backend validates the field, naming its own set in the 400 it returns for
 *     anything else. The real Codex CLI carries it too
 *     (`model_reasoning_effort = "max"` in ~/.codex/config.toml).
 *   - `prompt_cache_key` (the session id) is included like Codex does.
 *   - `parallel_tool_calls` is TRUE. This used to be false "matching Codex",
 *     and it was the single largest source of wall-clock in the product: the
 *     backend honors the flag, so every tool call became its own round trip
 *     re-sending the whole (40k–150k token) prompt. Measured over 20 recorded
 *     codex sessions: 1030 assistant turns carried exactly one tool call and
 *     11 carried more — and all 11 landed in the two windows where a FALLBACK
 *     provider was serving, the last of them one second before control
 *     returned to codex. An agent reading fifteen files paid fifteen full
 *     inferences for work that is one batch. Codex-CLI fidelity is not worth
 *     that; the agent loop already bounds real concurrency itself
 *     (maxParallelTools, default 8) and runs non-parallel-safe tools serially.
 */
/**
 * The effort value to send for a model, clamped to what that model accepts.
 *
 * The backend validates this and 400s the whole request on a value the model
 * does not take — gpt-5.6-sol rejects "minimal", for instance, while the family
 * as a whole lists it. A user's configured preference must never be able to
 * hard-fail every request, so an unsupported value falls to the nearest
 * supported neighbour rather than going out as-is.
 */
export function codexEffortFor(
  model: string,
  thinking?: { enabled: boolean; effort?: ReasoningEffort },
): ReasoningEffort {
  // Thinking explicitly off (utility calls, the fast classifier) wants the
  // floor, not the default: hidden reasoning would eat a small budget whole.
  if (thinking?.enabled === false) return "none";
  const wanted = thinking?.effort ?? "high";
  const m = model.toLowerCase();
  // The gpt-5.6 line takes everything except "minimal" (measured).
  if (/^gpt-5\.6/.test(m) && wanted === "minimal") return "low";
  return wanted;
}

export function toResponsesBody(
  request: InferenceRequest,
  stream: boolean,
  promptCacheKey?: string,
): Record<string, unknown> {
  const reason = request.thinking?.enabled !== false && REASONING_MODEL.test(request.model);
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system ?? "",
    input: toResponsesInput(request.messages),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream,
  };
  if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
  if (request.tools?.length) {
    body.tools = request.tools.map((t: ToolDefinition) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
  }
  if (reason) {
    body.reasoning = { summary: "auto", effort: codexEffortFor(request.model, request.thinking) };
    // Ask for encrypted reasoning back so store=false multi-turn works.
    body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

// ─── SSE parsing (pure, exported for tests) ───

/**
 * Parse a Responses API `text/event-stream` into Gear StreamEvents. Handles the
 * event types Gear needs: text deltas, function-call items + argument deltas,
 * reasoning-summary deltas, and completion (with usage). Unknown events are
 * ignored so the stream is resilient to additive backend event types.
 */
// Structural stream type so both the DOM and node:stream/web ReadableStream
// (which differ only in optionality of `value`) satisfy it without a cast.
type ByteStream = { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } };

export async function* parseResponsesStream(body: ByteStream): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentStarted = false;
  // Whether the model emitted a function call this response. The stop reason MUST
  // be "tool_use" when it did, or the agent loop treats the turn as finished and
  // never runs the tool (the "done after one step" bug).
  let sawToolCall = false;
  // Responses references function-call items by item_id across events.
  const callsById = new Map<string, string>(); // item_id → tool call id
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const flushContentStop = function* (): Generator<StreamEvent> {
    if (contentStarted) {
      contentStarted = false;
      yield { type: "content_stop", contentIndex: 0 };
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const dataStr = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!dataStr || dataStr === "[DONE]") continue;

      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = ev.type as string | undefined;
      if (!type) continue;

      switch (type) {
        case "response.created": {
          const resp = ev.response as { id?: string } | undefined;
          yield { type: "message_start", messageId: resp?.id ?? "codex" };
          break;
        }
        case "response.output_item.added": {
          const item = ev.item as
            { id?: string; type?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.id) {
            sawToolCall = true;
            const callId = item.call_id ?? item.id;
            callsById.set(item.id, callId);
            yield* flushContentStop();
            yield { type: "tool_use_start", toolCallId: callId, toolName: item.name ?? "" };
          }
          break;
        }
        case "response.output_text.delta": {
          const delta = (ev.delta as string) ?? "";
          if (delta) {
            if (!contentStarted) {
              contentStarted = true;
              yield { type: "content_start", contentIndex: 0 };
            }
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: delta },
            };
          }
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const delta = (ev.delta as string) ?? "";
          if (delta) yield { type: "thinking_delta", text: delta };
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = ev.item_id as string | undefined;
          const callId = itemId ? callsById.get(itemId) : undefined;
          const delta = (ev.delta as string) ?? "";
          if (callId && delta)
            yield { type: "tool_use_delta", toolCallId: callId, partialJson: delta };
          break;
        }
        case "response.output_item.done": {
          const item = ev.item as
            | {
                id?: string;
                type?: string;
                call_id?: string;
                arguments?: string;
                summary?: unknown;
                encrypted_content?: string;
              }
            | undefined;
          if (item?.type === "function_call") {
            const callId =
              item.call_id ?? (item.id ? callsById.get(item.id) : undefined) ?? item.id ?? "";
            yield {
              type: "tool_use_stop",
              toolCallId: callId,
              toolInput: parseToolArguments(item.arguments ?? ""),
            };
          } else if (item?.type === "reasoning" && item.id) {
            // Round-trip the reasoning item verbatim (id + summary + encrypted
            // content) so it can be replayed before its function call next turn.
            const payload = {
              type: "reasoning",
              id: item.id,
              summary: item.summary ?? [],
              ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
            };
            yield {
              type: "redacted_thinking",
              data: JSON.stringify(payload),
              provider: CODEX_PROVIDER,
            };
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const resp = ev.response as
            | {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                };
                status?: string;
                incomplete_details?: { reason?: string };
              }
            | undefined;
          // The Responses API prefix-caches automatically — no breakpoints to
          // send — but it only reports the saving if you read it back. Until
          // this was read, every Codex turn looked like a full-price cache
          // miss, which is why the ledger could not show what caching was
          // worth on the transport carrying most of the traffic.
          //
          // `input_tokens` INCLUDES the cached portion, so subtract it: the
          // TokenUsage contract is three DISJOINT counts that sum to the total.
          const promptTokens = resp?.usage?.input_tokens ?? 0;
          const cached = resp?.usage?.input_tokens_details?.cached_tokens ?? 0;
          const cacheReadTokens = Math.min(Math.max(cached, 0), promptTokens);
          usage = {
            inputTokens: promptTokens - cacheReadTokens,
            outputTokens: resp?.usage?.output_tokens ?? 0,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          };
          yield* flushContentStop();
          // A tool call in the response MUST stop as "tool_use" so the loop runs
          // it; a truncated response stops as "max_tokens"; otherwise end_turn.
          const truncated =
            resp?.status === "incomplete" ||
            resp?.incomplete_details?.reason === "max_output_tokens";
          const stopReason: StopReason = truncated
            ? "max_tokens"
            : sawToolCall
              ? "tool_use"
              : "end_turn";
          yield { type: "message_stop", stopReason, usage };
          return;
        }
        case "response.failed":
        case "error": {
          const resp = ev.response as { error?: { message?: string } } | undefined;
          const message =
            resp?.error?.message ?? (ev.message as string) ?? "Codex responses stream failed";
          throw new ApiError({ status: 502, provider: "codex", message });
        }
      }
    }
  }
  // Stream ended without an explicit completion event — close cleanly, still
  // honoring a pending tool call so the loop runs it.
  yield* flushContentStop();
  yield { type: "message_stop", stopReason: sawToolCall ? "tool_use" : "end_turn", usage };
}

/**
 * Turn a failed Codex HTTP response into a readable one-line message. The backend
 * returns `{"detail":"..."}` (often pretty-printed across lines) — collapse
 * whitespace so the reason survives a UI that only renders the first line, and
 * unwrap `detail`/`error.message` instead of dumping raw JSON.
 */
export async function codexErrorMessage(res: {
  status: number;
  text(): Promise<string>;
}): Promise<string> {
  const raw = await res.text().catch(() => "");
  let detail = raw;
  try {
    const j = JSON.parse(raw) as { detail?: unknown; error?: { message?: string } };
    if (typeof j.detail === "string") detail = j.detail;
    else if (j.error?.message) detail = j.error.message;
  } catch {
    // not JSON — keep the raw body
  }
  const oneLine = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return `Codex request failed (${res.status}): ${oneLine || "(empty body)"}`;
}

// ─── Provider ───

export class CodexProvider implements LlmProvider {
  readonly name = "codex" as const;
  private readonly accessToken: string;
  private readonly accountId?: string;
  private readonly sessionId = randomUUID();

  constructor(accessToken: string, accountId?: string) {
    this.accessToken = accessToken;
    this.accountId = accountId;
  }

  async *inferStream(request: InferenceRequest, opts?: StreamOpts): AsyncGenerator<StreamEvent> {
    // Wedged-stream protection: previously no timeout — a stalled SSE session
    // hung the turn until the user hit Esc. The FIRST-token allowance stays
    // very generous: the Codex backend serves hidden-reasoning gpt-5.x models
    // that legitimately go silent for minutes before they emit anything.
    //
    // The BETWEEN-chunk allowance was 240s, and that was pure loss. Once the
    // stream is producing, this backend emits reasoning-summary deltas while
    // it thinks, so mid-stream silence means wedged, not busy — and every
    // recorded stall ("stream stalled — no data for 240s") cost four minutes
    // before the gateway was allowed to retry or fall back. 120s is still
    // twice any healthy gap observed, and halves the price of a dead socket.
    const guard = new IdleWatchdog(this.name, opts?.signal, 300_000, 120_000);
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toResponsesBody(request, true, this.sessionId)),
      signal: guard.signal,
    });
    if (!res.ok || !res.body) {
      guard.stop();
      throw new ApiError({
        status: res.status || 502,
        provider: "codex",
        message: await codexErrorMessage(res),
      });
    }
    try {
      for await (const ev of parseResponsesStream(res.body)) {
        guard.beat();
        yield ev;
      }
    } catch (err) {
      // Watchdog stall (not the caller's Esc) → retryable 504 for the gateway.
      throw guard.timeoutError() ?? err;
    } finally {
      guard.stop();
    }
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    // Aggregate the stream into a single response (the backend is stream-first).
    const content: ContentBlock[] = [];
    let text = "";
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let id = "codex";
    const toolArgs = new Map<string, { name: string; json: string }>();

    for await (const ev of this.inferStream(request, { signal: request.signal })) {
      if (ev.type === "message_start") id = ev.messageId;
      else if (ev.type === "content_delta") text += ev.delta.text;
      else if (ev.type === "tool_use_start")
        toolArgs.set(ev.toolCallId, { name: ev.toolName, json: "" });
      else if (ev.type === "tool_use_delta") {
        const e = toolArgs.get(ev.toolCallId);
        if (e) e.json += ev.partialJson;
      } else if (ev.type === "tool_use_stop") {
        content.push({
          type: "tool_use",
          toolCallId: ev.toolCallId,
          toolName: toolArgs.get(ev.toolCallId)?.name ?? "",
          toolInput: ev.toolInput,
        });
      } else if (ev.type === "message_stop") {
        stopReason = ev.stopReason;
        usage = ev.usage;
      }
    }
    if (text) content.unshift({ type: "text", text });
    return { id, content, stopReason, usage, model: request.model };
  }

  async countTokens(messages: Message[]): Promise<number> {
    let chars = 0;
    for (const m of messages)
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.toolResultContent.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.toolInput).length;
      }
    return Math.ceil(chars / 4);
  }

  async healthCheck(): Promise<boolean> {
    return this.accessToken.length > 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    // The Codex backend has no public model-listing endpoint; the preset's
    // curated list is the source of truth (callers fall back to it).
    return [];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
      // Present as the Codex CLI — the backend keys subscription access off this.
      originator: "codex_cli_rs",
      session_id: this.sessionId,
    };
    if (this.accountId) h["chatgpt-account-id"] = this.accountId;
    return h;
  }
}
