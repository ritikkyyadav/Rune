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
  ApiErrorCode,
  CapacityWindow,
  ReasoningEffort,
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  Message,
  ModelInfo,
  ProviderCapacity,
  StopReason,
  StreamEvent,
  StreamOpts,
  ToolDefinition,
  TokenUsage,
} from "../types";
import { ApiError } from "../types";
import { IdleWatchdog } from "./stream-guard";
import { parseToolArguments } from "@rune/shared";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** Models on Codex that reason (send a `reasoning` param + collect thinking). */
// Which models get a `reasoning` block. Written as a FAMILY rule rather than a
// list of the ids shipping today: the previous form (`/^(gpt-5|o[134]|codex)/`)
// was correct the day it was written and silently wrong the day OpenAI made
// gpt-6-astra the bundled Codex default — that model would have been sent with
// no reasoning block at all, which is the whole reason the Codex route feels
// strong. `gpt-[5-9]` covers this decade's single-digit line and `gpt-\d{2}`
// the next one, so the next generation arrives handled.
const REASONING_MODEL = /^(gpt-[5-9]|gpt-\d{2}|o[134](-|$)|codex)/;
// A reasoning model's reasoning items (with encrypted_content) MUST be echoed
// back in the input before their function call, or a store:false follow-up 400s
// with "No tool output found for function call". We round-trip each reasoning
// item verbatim inside a redacted_thinking block tagged `provider:"codex"`, so
// only Codex replays it and every other provider drops it (no cross-contamination).
const CODEX_PROVIDER = "codex";

// ─── Request translation (pure, exported for tests) ───

/** Map Rune messages to Responses API `input` items (system goes to `instructions`). */
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
  // The gpt-5.6 line takes everything except "minimal" (measured 2026-08-30).
  if (/^gpt-5\.6/.test(m) && wanted === "minimal") return "low";
  // gpt-6: UNMEASURED. OpenAI's changelog adds `max` and `ultra` to the effort
  // vocabulary for this line, but no accepted-effort matrix has been probed
  // from here and this lane made zero live calls. The requested value passes
  // through unchanged rather than being clamped against a guess — a wrong
  // clamp silently weakens every request, while a wrong value 400s once and
  // says so. Measure it before adding a rule.
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
 * Parse a Responses API `text/event-stream` into Rune StreamEvents. Handles the
 * event types Rune needs: text deltas, function-call items + argument deltas,
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
        case "error":
          throw codexStreamError(ev);
      }
    }
  }
  // Stream ended without an explicit completion event — close cleanly, still
  // honoring a pending tool call so the loop runs it.
  yield* flushContentStop();
  yield { type: "message_stop", stopReason: sawToolCall ? "tool_use" : "end_turn", usage };
}

// ─── Failures, classified by what the backend said rather than by prose ───
//
// Until 2026-09-29 every Codex failure reached the gateway as a status and a
// sentence. A plan cap's 429 carried its exact reset in the body
// (`resets_in_seconds`) and in the headers, and all of it was thrown away: the
// gateway read "usage limit" out of the sentence, guessed fifteen minutes, and
// told the user to come back then — against a wall that stood for 2h42m. And a
// failure that arrived mid-stream was a 502 whatever it was, so a context
// overflow was retried as an outage and a cap was retried as a blip.

/** Anything headers can be read from: a fetch `Headers`, or a test's stand-in. */
type HeaderSource = { get(name: string): string | null };

const NO_HEADERS: HeaderSource = { get: () => null };

/**
 * The furthest ahead a reported reset is believed. The longest window the
 * backend states is a week; a month of margin means only a garbled value is
 * refused — and a refused reset is merely a guessed cooldown, not an error.
 */
const MAX_REPORTED_RESET_MS = 31 * 24 * 60 * 60_000;

function headerNumber(h: HeaderSource, name: string): number | undefined {
  const raw = h.get(name)?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The backend spells booleans Python's way ("True"/"False"). */
function headerBool(h: HeaderSource, name: string): boolean | undefined {
  const raw = h.get(name)?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

function headerText(h: HeaderSource, name: string): string | undefined {
  return h.get(name)?.trim() || undefined;
}

/** A reset moment, kept only when it is in the future and not absurdly far. */
function plausibleReset(at: number | undefined, now: number): number | undefined {
  return at !== undefined && at > now && at - now <= MAX_REPORTED_RESET_MS ? at : undefined;
}

/**
 * The relative form wins over the absolute one, here and in error bodies: it
 * does not depend on this machine's clock agreeing with the server's.
 */
function resetFrom(
  afterSeconds: number | undefined,
  atEpochSeconds: number | undefined,
  now: number,
): number | undefined {
  return (
    plausibleReset(afterSeconds !== undefined ? now + afterSeconds * 1000 : undefined, now) ??
    plausibleReset(atEpochSeconds !== undefined ? atEpochSeconds * 1000 : undefined, now)
  );
}

function capacityWindow(
  h: HeaderSource,
  which: "primary" | "secondary",
  now: number,
): CapacityWindow | undefined {
  const usedPercent = headerNumber(h, `x-codex-${which}-used-percent`);
  if (usedPercent === undefined || usedPercent < 0) return undefined;
  const windowMinutes = headerNumber(h, `x-codex-${which}-window-minutes`);
  const after = headerNumber(h, `x-codex-${which}-reset-after-seconds`);
  const resetAfterSeconds = after !== undefined && after >= 0 ? after : undefined;
  const resetAt = resetFrom(resetAfterSeconds, headerNumber(h, `x-codex-${which}-reset-at`), now);
  return {
    usedPercent,
    ...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes } : {}),
    ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * The quota meter: the plan's windows as one Codex response reported them in
 * its `x-codex-*` headers — on EVERY response, success or failure. Undefined
 * when the response carried none of them, so an absent meter never reads as
 * an empty one. Pure, exported for tests.
 */
export function parseCodexCapacity(
  headers: HeaderSource,
  now: number = Date.now(),
): ProviderCapacity | undefined {
  const primary = capacityWindow(headers, "primary", now);
  const secondary = capacityWindow(headers, "secondary", now);
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  const balance = headerNumber(headers, "x-codex-credits-balance");
  const planType = headerText(headers, "x-codex-plan-type");
  const activeLimit = headerText(headers, "x-codex-active-limit");
  const hasCreditFacts =
    hasCredits !== undefined || unlimited !== undefined || balance !== undefined;
  if (!primary && !secondary && !hasCreditFacts && !planType && !activeLimit) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(hasCreditFacts
      ? {
          credits: {
            ...(hasCredits !== undefined ? { hasCredits } : {}),
            ...(unlimited !== undefined ? { unlimited } : {}),
            ...(balance !== undefined ? { balance } : {}),
          },
        }
      : {}),
    ...(planType ? { planType } : {}),
    ...(activeLimit ? { activeLimit } : {}),
  };
}

/** What a Codex error body or failed-stream event says about itself. */
interface CodexErrorFacts {
  /** The human sentence (detail / error.message), or the raw body. */
  detail: string;
  /** The backend's machine name: `code` when present, else `type`. */
  name?: string;
  resetsInSeconds?: number;
  /** Epoch SECONDS, as the backend writes it. */
  resetsAt?: number;
}

function errorFacts(err: Record<string, unknown>, fallbackDetail: string): CodexErrorFacts {
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const name = text(err.code) ?? text(err.type);
  const resetsInSeconds = num(err.resets_in_seconds);
  const resetsAt = num(err.resets_at);
  return {
    detail: text(err.detail) ?? text(err.message) ?? fallbackDetail,
    ...(name ? { name } : {}),
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Read a Codex HTTP error body: `{"detail": "..."}` (often pretty-printed) or
 * `{"error": {"type", "code", "message", "resets_in_seconds", "resets_at", …}}`.
 * Anything that is not JSON is its own detail.
 */
function parseCodexErrorBody(raw: string): CodexErrorFacts {
  try {
    const j = JSON.parse(raw) as { detail?: unknown; error?: unknown };
    if (typeof j.detail === "string") return { detail: j.detail };
    if (j.error && typeof j.error === "object") {
      return errorFacts(j.error as Record<string, unknown>, raw);
    }
  } catch {
    // not JSON — keep the raw body
  }
  return { detail: raw };
}

/**
 * Which kind of failure a backend error name is. The names are OpenAI's
 * (Responses `error.code` / `error.type`) plus the ChatGPT plan cap's own
 * `usage_limit_reached`; anything unrecognised is left unclassified, which
 * keeps the status-based handling that existed before.
 */
function classifyCodexError(name: string | undefined): ApiErrorCode | undefined {
  switch (name) {
    case "usage_limit_reached":
    case "insufficient_quota":
      return "usage_cap";
    case "rate_limit_exceeded":
      return "rate_limit";
    case "context_length_exceeded":
      return "context_overflow";
    case "server_error":
      return "server_error";
  }
  return name?.startsWith("invalid_") ? "invalid_request" : undefined;
}

/** "Please try again in 1.898s" / "in 350ms" — how a throttle names its wait. */
function tryAgainInMs(message: string): number | undefined {
  const m = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)\b/i.exec(message);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]!.toLowerCase() === "ms" ? n : n * 1000;
}

/**
 * The window whose reset lifts the cap: the exhausted one that resets last,
 * or the primary when none reads as exhausted. An exhausted window that
 * states no reset means nobody said when — so nothing exact is claimed.
 */
function bindingWindow(capacity: ProviderCapacity | undefined): CapacityWindow | undefined {
  const exhausted = [capacity?.primary, capacity?.secondary].filter(
    (w): w is CapacityWindow => !!w && w.usedPercent >= 100,
  );
  if (exhausted.length === 0) return capacity?.primary;
  if (exhausted.some((w) => w.resetAt === undefined)) return undefined;
  return exhausted.sort((a, b) => b.resetAt! - a.resetAt!)[0];
}

/**
 * Build the ApiError a Codex failure stands for. A plan cap gets `code:
 * "usage_cap"` and its exact `resetAt` — from the body's `resets_in_seconds`,
 * else its `resets_at`, else the binding window's headers — so the gateway
 * never has to guess what the backend already said.
 */
function codexApiError(opts: {
  status: number;
  message: string;
  facts: CodexErrorFacts;
  capacity?: ProviderCapacity;
  retryAfterHeader?: number;
  now: number;
}): ApiError {
  const { facts, capacity, now } = opts;
  const code = classifyCodexError(facts.name);
  let resetAt: number | undefined;
  let retryAfterMs: number | undefined;
  if (code === "usage_cap") {
    const window = bindingWindow(capacity);
    resetAt =
      resetFrom(facts.resetsInSeconds, facts.resetsAt, now) ?? plausibleReset(window?.resetAt, now);
    retryAfterMs = resetAt !== undefined ? resetAt - now : opts.retryAfterHeader;
  } else if (opts.status === 429 || code === "rate_limit") {
    // A throttle's wait. Only a 429 carries one: a 5xx that advertised
    // Retry-After would otherwise hold the session for as long as it asked,
    // where today it retries on the gateway's own short backoff.
    const told =
      facts.resetsInSeconds !== undefined && facts.resetsInSeconds > 0
        ? facts.resetsInSeconds * 1000
        : undefined;
    retryAfterMs = told ?? opts.retryAfterHeader ?? tryAgainInMs(facts.detail);
  }
  return new ApiError({
    status: opts.status,
    provider: "codex",
    message: opts.message,
    ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
    ...(code ? { code } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(facts.name ? { providerCode: facts.name } : {}),
    ...(capacity ? { capacity } : {}),
  });
}

/**
 * The one-line message for a failed Codex HTTP response. The backend returns
 * `{"detail":"..."}` (often pretty-printed across lines) — collapse whitespace
 * so the reason survives a UI that only renders the first line, and unwrap
 * `detail`/`error.message` instead of dumping raw JSON. The error's machine
 * name rides along ("429, usage_limit_reached"), because the sentence alone
 * cannot tell a plan cap from a throttle.
 */
function codexErrorLine(status: number, facts: CodexErrorFacts): string {
  const oneLine = facts.detail.replace(/\s+/g, " ").trim().slice(0, 300);
  const kind = facts.name ? `, ${facts.name}` : "";
  return `Codex request failed (${status}${kind}): ${oneLine || "(empty body)"}`;
}

export async function codexErrorMessage(res: {
  status: number;
  text(): Promise<string>;
}): Promise<string> {
  const raw = await res.text().catch(() => "");
  return codexErrorLine(res.status, parseCodexErrorBody(raw));
}

/** Retry-After in delta-seconds, as milliseconds. */
function retryAfterHeaderMs(h: HeaderSource): number | undefined {
  const secs = headerNumber(h, "retry-after");
  return secs !== undefined && secs > 0 ? Math.round(secs * 1000) : undefined;
}

/**
 * The structured error for a failed Codex HTTP response: the readable message,
 * plus the cap/reset/meter facts the body and headers carry. Exported for tests.
 */
export async function codexHttpError(
  res: { status: number; headers?: HeaderSource; text(): Promise<string> },
  now: number = Date.now(),
): Promise<ApiError> {
  const raw = await res.text().catch(() => "");
  const facts = parseCodexErrorBody(raw);
  const headers = res.headers ?? NO_HEADERS;
  const capacity = parseCodexCapacity(headers, now);
  const retryAfterHeader = retryAfterHeaderMs(headers);
  return codexApiError({
    status: res.status || 502,
    message: codexErrorLine(res.status, facts),
    facts,
    ...(capacity ? { capacity } : {}),
    ...(retryAfterHeader !== undefined ? { retryAfterHeader } : {}),
    now,
  });
}

/**
 * The status a mid-stream failure maps to, by its code. A stream that fails
 * after the 200 used to be a 502 whatever it said, which retried a context
 * overflow as an outage and a plan cap as a blip.
 *
 *   usage_cap / rate_limit → 429 (the gateway's cap and throttle handling)
 *   context_overflow       → 400, worded so the agent loop's overflow
 *                            recovery (isContextOverflowError) compacts
 *   invalid_request        → 400: the request was refused; not retried
 *   server_error, unknown  → 502: retryable, as before
 */
const STREAM_STATUS: Record<ApiErrorCode, number> = {
  usage_cap: 429,
  rate_limit: 429,
  context_overflow: 400,
  invalid_request: 400,
  server_error: 502,
};

/**
 * The ApiError a failed-stream event stands for (`response.failed`, or a
 * bare `error` event). The error object sits under `response.error`, under
 * `error`, or on the event itself. Exported for tests.
 */
export function codexStreamError(ev: Record<string, unknown>, now: number = Date.now()): ApiError {
  const resp = ev.response as { error?: unknown } | undefined;
  const nested =
    resp?.error && typeof resp.error === "object"
      ? resp.error
      : ev.error && typeof ev.error === "object"
        ? ev.error
        : undefined;
  // On a bare event, `type` is the event's own ("error"), not the error's.
  const own = nested ? undefined : { ...ev, type: undefined };
  const facts = errorFacts(
    (nested ?? own) as Record<string, unknown>,
    "Codex responses stream failed",
  );
  const code = classifyCodexError(facts.name);
  const detail = facts.detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return codexApiError({
    status: code ? STREAM_STATUS[code] : 502,
    message: `Codex stream failed${facts.name ? ` (${facts.name})` : ""}: ${detail}`,
    facts,
    now,
  });
}

/**
 * A cache key fit to send: printable ASCII with no spaces, because it also
 * rides in the `session_id` header, where anything else would make fetch
 * throw before a byte was sent.
 */
function usableCacheKey(key: string | undefined): string | undefined {
  return key && /^[\x21-\x7e]{1,256}$/.test(key) ? key : undefined;
}

// ─── Model catalogue ───
//
// The backend DOES list models: `GET …/codex/models?client_version=x.y.z`
// returns `{ models: [...] }` (codex-rs `ModelsResponse`). Until 2026-09-28
// this file said it had no listing endpoint and returned [], so the ChatGPT
// route could only ever offer the hand-written preset — which is how GPT-6 Sol
// and Luna shipped on 2026-09-22 and were still missing from `/model` a week
// later.
//
// The catalogue is FILTERED BY `client_version`: a model appears only for
// clients new enough to have been told about it. A pinned version therefore
// rots in exactly the way the preset did (nanobot pinned 0.153.4 and lost Sol
// and Luna on the same account that 0.158.0 saw them on). So the version asked
// for tracks the published Codex CLI, and the pin below is only a floor.

const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const CODEX_NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";

/** The newest Codex CLI release known to this build (2026-09-26). A floor, not the answer. */
export const CODEX_CLIENT_VERSION_FLOOR = "0.157.1";

/** The higher of two `x.y.z` versions, as a plain `x.y.z`. An unparseable `a` loses. */
export function newerClientVersion(a: string, b: string): string {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 4).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa) return pb ? pb.join(".") : b;
  if (!pb) return pa.join(".");
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return (pa[i]! > pb[i]! ? pa : pb).join(".");
  }
  return pa.join(".");
}

let clientVersion: Promise<string> | undefined;

/**
 * The `client_version` to ask the catalogue as. `RUNE_CODEX_CLIENT_VERSION`
 * wins outright (a lever for the day OpenAI changes the rule); otherwise the
 * newer of npm's published `@openai/codex` and the floor, looked up once per
 * process. An unreachable registry costs 1.5s once and falls to the floor.
 */
export function codexClientVersion(): Promise<string> {
  const override = process.env.RUNE_CODEX_CLIENT_VERSION?.trim();
  if (override) return Promise.resolve(override);
  clientVersion ??= fetch(CODEX_NPM_LATEST, { signal: AbortSignal.timeout(1500) })
    .then((res) => (res.ok ? (res.json() as Promise<{ version?: unknown }>) : null))
    .then((body) =>
      newerClientVersion(
        typeof body?.version === "string" ? body.version : "",
        CODEX_CLIENT_VERSION_FLOOR,
      ),
    )
    .catch(() => CODEX_CLIENT_VERSION_FLOOR);
  return clientVersion;
}

/** Test seam: forget the memoized version so each test starts cold. */
export function resetCodexClientVersion(): void {
  clientVersion = undefined;
}

/**
 * The catalogue as Rune reads it: only `visibility: "list"` entries (the ones
 * the Codex CLI's own picker shows; "hide" and "none" are internal or not for
 * this account), in the backend's `priority` order, ascending, as codex-rs
 * sorts it. Defensive about shape: a field that is missing or the wrong type
 * drops that entry, never the whole list. Pure, exported for tests.
 */
export function parseCodexCatalog(body: unknown): ModelInfo[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const rank = (p: unknown) => (typeof p === "number" && Number.isFinite(p) ? p : Infinity);
  return models
    .filter(
      (m): m is Record<string, unknown> =>
        !!m &&
        typeof m === "object" &&
        typeof (m as { slug?: unknown }).slug === "string" &&
        (m as { slug: string }).slug.length > 0 &&
        (m as { visibility?: unknown }).visibility === "list",
    )
    .sort((a, b) => rank(a.priority) - rank(b.priority))
    .map((m) => {
      const id = m.slug as string;
      const label =
        typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
      const window = m.context_window;
      return {
        id,
        label,
        live: true,
        ...(typeof window === "number" && window > 0 ? { contextLimit: window } : {}),
      };
    });
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
    // The caller's stable key (the Rune session) when it gave one: a
    // per-instance id changes every time the gateway is rebuilt, and the
    // backend's prompt cache is keyed on it.
    const cacheKey = usableCacheKey(opts?.cacheKey) ?? this.sessionId;
    // The request itself sits INSIDE the try. It used to sit before it, so a
    // watchdog that fired while the backend was still queueing (no headers
    // yet) escaped as a raw AbortError instead of the retryable 504 below,
    // and a failed connection left the watchdog's timer armed.
    try {
      const res = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: this.headers(cacheKey),
        body: JSON.stringify(toResponsesBody(request, true, cacheKey)),
        signal: guard.signal,
      });
      if (!res.ok || !res.body) throw await codexHttpError(res);
      // The meter: read on every response, and carried on its usage event.
      const capacity = parseCodexCapacity(res.headers);
      for await (const ev of parseResponsesStream(res.body)) {
        guard.beat();
        yield capacity && ev.type === "message_stop" ? { ...ev, capacity } : ev;
      }
    } catch (err) {
      // A failure the backend described stands as described. Anything else
      // that ended because the watchdog fired (not the caller's Esc) is the
      // retryable 504 the gateway knows how to retry or fall back on.
      if (err instanceof ApiError) throw err;
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
    let capacity: ProviderCapacity | undefined;
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
        capacity = ev.capacity;
      }
    }
    if (text) content.unshift({ type: "text", text });
    return {
      id,
      content,
      stopReason,
      usage,
      model: request.model,
      ...(capacity ? { capacity } : {}),
    };
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

  /**
   * What this ChatGPT account can run on Codex right now — the live catalogue
   * (see "Model catalogue" above). Throws on a failed call so `rune models`
   * can say WHY it fell back to the preset; callers that only want a list
   * catch and use the seed.
   */
  async listModels(): Promise<ModelInfo[]> {
    const version = await codexClientVersion();
    const res = await fetch(`${MODELS_URL}?client_version=${encodeURIComponent(version)}`, {
      headers: { ...this.identityHeaders(), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new ApiError({
        status: res.status,
        provider: "codex",
        message: await codexErrorMessage(res),
      });
    }
    return parseCodexCatalog(await res.json());
  }

  /** Who is calling: the account bearer, presented as the Codex CLI. */
  private identityHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      // Present as the Codex CLI — the backend keys subscription access off this.
      originator: "codex_cli_rs",
    };
    if (this.accountId) h["chatgpt-account-id"] = this.accountId;
    return h;
  }

  /** The Codex CLI sends one conversation id as both `session_id` and the cache key. */
  private headers(sessionId: string): Record<string, string> {
    return {
      ...this.identityHeaders(),
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
      session_id: sessionId,
    };
  }
}
