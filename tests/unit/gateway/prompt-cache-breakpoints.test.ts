/**
 * Prompt-cache breakpoint placement, and the telemetry that makes it checkable.
 *
 * The bug these pin: the Anthropic adapter put its only conversation-level
 * breakpoint on the LAST message. The agent loop appends an ephemeral
 * task-state block as the last message — rebuilt every request, never stored —
 * so every turn wrote a cache entry keyed on content that could never recur,
 * and no turn ever read one back. System and tool blocks cached; the
 * conversation, which is the bulk of a long agent run, never did.
 *
 * The OpenAI-compatible adapter (which backs OpenRouter) emitted no
 * cache_control at all and dropped `cached_tokens` on the floor, so there was
 * neither caching nor any way to notice.
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import type { InferenceRequest, Message } from "../../../packages/llm-gateway/src/types";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** Reach the private converters the way the request path does. */
const toAnthropic = (p: AnthropicProvider, messages: Message[], breakpointIndex?: number) =>
  (
    p as unknown as {
      toAnthropicMessagesWithCache: (m: Message[], i?: number) => Array<{ content: unknown[] }>;
    }
  ).toAnthropicMessagesWithCache(messages, breakpointIndex);

const toOpenAI = (
  p: OpenAIProvider,
  messages: Message[],
  system?: string,
  cache?: { breakpointIndex?: number },
) =>
  (
    p as unknown as {
      toOpenAIMessages: (
        m: Message[],
        s?: string,
        c?: { breakpointIndex?: number },
      ) => Array<{ role: string; content: unknown }>;
    }
  ).toOpenAIMessages(messages, system, cache);

const marked = (blocks: unknown[]): boolean =>
  blocks.some((b) => (b as { cache_control?: unknown }).cache_control != null);

describe("anthropic — breakpoint lands on the stable prefix", () => {
  const provider = new AnthropicProvider("test-key");

  test("the ephemeral tail does NOT carry the breakpoint", () => {
    const history = [user("build it"), assistant("working"), user("continue")];
    const withSpine = [...history, user("[task state] spine block, rebuilt per request")];

    // Index of the last STABLE message — what the agent loop now passes.
    const out = toAnthropic(provider, withSpine, history.length - 1);

    expect(marked(out.at(-1)!.content)).toBe(false);
    expect(marked(out[history.length - 1]!.content)).toBe(true);
  });

  test("exactly one conversation breakpoint is emitted", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")];
    const out = toAnthropic(provider, msgs, 2);
    expect(out.filter((m) => marked(m.content))).toHaveLength(1);
  });

  test("omitting the index keeps the historical last-message placement", () => {
    const msgs = [user("a"), assistant("b")];
    const out = toAnthropic(provider, msgs);
    expect(marked(out.at(-1)!.content)).toBe(true);
  });

  test("system-role turns don't shift the breakpoint off its message", () => {
    // `filtered` drops system turns, so caller indices and converted indices
    // diverge — the mapping has to account for that or the marker slides.
    const msgs: Message[] = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      user("first"),
      assistant("second"),
      user("ephemeral tail"),
    ];
    const out = toAnthropic(provider, msgs, 2); // "second"
    expect(out).toHaveLength(3); // system dropped
    expect(marked(out[1]!.content)).toBe(true); // "second"
    expect(marked(out[2]!.content)).toBe(false); // tail
  });

  test("a breakpoint never rides a thinking block", () => {
    const msgs: Message[] = [
      user("a"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hmm", signature: "sig" },
        ],
      },
    ];
    const out = toAnthropic(provider, msgs, 1);
    const blocks = out[1]!.content as Array<{ type: string; cache_control?: unknown }>;
    expect(blocks.find((b) => b.type === "thinking")?.cache_control).toBeUndefined();
    // ...it moves to the last block that CAN hold it rather than vanishing.
    expect(blocks.find((b) => b.type === "text")?.cache_control).toBeDefined();
  });
});

describe("openai-compatible — breakpoints only where they are documented", () => {
  const openrouter = new OpenAIProvider("k", "https://openrouter.ai/api/v1");
  const plainOpenAI = new OpenAIProvider("k");

  const wants = (p: OpenAIProvider, model: string) =>
    (p as unknown as { wantsCacheBreakpoints: (m: string) => boolean }).wantsCacheBreakpoints(
      model,
    );

  test("anthropic models behind openrouter opt in; other upstreams do not", () => {
    expect(wants(openrouter, "anthropic/claude-sonnet-4-6")).toBe(true);
    // Implicit prefix caching upstream — a breakpoint would be an
    // undocumented field on the wire for no gain.
    expect(wants(openrouter, "stealth/ox-alpha")).toBe(false);
    expect(wants(openrouter, "openai/gpt-5")).toBe(false);
  });

  test("a non-openrouter host never emits breakpoints", () => {
    expect(wants(plainOpenAI, "anthropic/claude-sonnet-4-6")).toBe(false);
  });

  test("the wire shape is untouched when caching is off", () => {
    const out = toOpenAI(plainOpenAI, [user("hello")], "sys");
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "hello" });
  });

  test("when on: system is marked, and the ephemeral tail is not", () => {
    const history = [user("build it"), assistant("working")];
    const withSpine = [...history, user("[task state] rebuilt per request")];

    const out = toOpenAI(openrouter, withSpine, "sys", { breakpointIndex: history.length - 1 });

    expect(marked(out[0]!.content as unknown[])).toBe(true); // system
    expect(typeof out.at(-1)!.content).toBe("string"); // tail untouched
    // The conversation breakpoint sits on the last stable user/assistant turn.
    const conversation = out.slice(1, -1);
    expect(conversation.filter((m) => Array.isArray(m.content) && marked(m.content))).toHaveLength(
      1,
    );
  });
});

describe("cached-token telemetry", () => {
  /** A provider whose HTTP client returns one canned completion. */
  function providerReturning(usage: Record<string, unknown>): OpenAIProvider {
    const provider = new OpenAIProvider("k", "https://openrouter.ai/api/v1");
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () => ({
            id: "cmpl_1",
            model: "anthropic/claude-sonnet-4-6",
            choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage,
          }),
        },
      },
    };
    return provider;
  }

  const request: InferenceRequest = {
    messages: [user("hello")],
    model: "anthropic/claude-sonnet-4-6",
    provider: "openrouter",
    maxTokens: 16,
    stream: false,
  };

  test("cached prompt tokens are split out of inputTokens, not added alongside", async () => {
    const provider = providerReturning({
      prompt_tokens: 5_000,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 4_096 },
    });

    const res = await provider.infer(request);

    expect(res.usage.cacheReadTokens).toBe(4_096);
    // `prompt_tokens` INCLUDES the cached ones, so the cached portion is
    // SUBTRACTED here. The TokenUsage contract is three DISJOINT input counts
    // whose sum is the total — Anthropic reports natively that way, and every
    // other adapter normalizes to it.
    //
    // This test previously asserted 5_000, on the reasoning that the figure was
    // "telemetry, not arithmetic". It is both: ContextEngine.noteRealUsage sums
    // the three fields to size the context window, so leaving the cached tokens
    // inside inputTokens counted them twice — a 5k prompt read as 9,096 and
    // compacted at a fraction of the real window, paying for summarizer
    // round-trips against a context that had room to spare.
    expect(res.usage.inputTokens).toBe(904);
    // The invariant that matters: the parts still add up to what the host said.
    const total =
      res.usage.inputTokens +
      (res.usage.cacheReadTokens ?? 0) +
      (res.usage.cacheCreationTokens ?? 0);
    expect(total).toBe(5_000);
  });

  test("a host reporting more cached than prompt tokens cannot go negative", async () => {
    const provider = providerReturning({
      prompt_tokens: 1_000,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 4_096 },
    });
    const res = await provider.infer(request);
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.cacheReadTokens).toBe(1_000);
  });

  test("a host that reports no cache detail leaves the field absent", async () => {
    const provider = providerReturning({ prompt_tokens: 5_000, completion_tokens: 12 });
    const res = await provider.infer(request);
    expect(res.usage.cacheReadTokens).toBeUndefined();
    expect(res.usage.inputTokens).toBe(5_000);
  });

  test("a zero cached count is not reported as a cache hit", async () => {
    const provider = providerReturning({
      prompt_tokens: 5_000,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    const res = await provider.infer(request);
    expect(res.usage.cacheReadTokens).toBeUndefined();
  });
});
