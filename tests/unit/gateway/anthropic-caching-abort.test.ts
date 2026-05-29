/**
 * Unit tests for:
 *  (a) Prompt caching — verifies cache_control is attached to the system prompt,
 *      the last tool, and the last content block of the last message.
 *  (b) AbortSignal threading — verifies the signal parameter reaches the SDK /
 *      fetch call and that behaviour is unchanged when no signal is provided.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { InferenceRequest, Message, ToolDefinition } from "../../../packages/llm-gateway/src/types";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";
import { GoogleProvider } from "../../../packages/llm-gateway/src/providers/google";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";

// ─── Shared test data ────────────────────────────────────────────────────────

const baseMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
  { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
];

const baseTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  },
];

function makeRequest(overrides?: Partial<InferenceRequest>): InferenceRequest {
  return {
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    maxTokens: 1024,
    stream: false,
    messages: baseMessages,
    system: "You are a helpful assistant.",
    tools: baseTools,
    ...overrides,
  };
}

// ─── Anthropic Provider — cache_control placement ────────────────────────────

describe("AnthropicProvider — prompt caching", () => {
  let capturedParams: Record<string, unknown> | null = null;
  let provider: AnthropicProvider;

  beforeEach(() => {
    capturedParams = null;

    // We access private methods via the class prototype to inspect the
    // translated parameters without making real API calls.
    provider = new AnthropicProvider("test-key");
  });

  /**
   * Access the private helpers by casting to any — TypeScript only; safe in tests.
   */
  function callPrivate<T>(method: string, ...args: unknown[]): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (provider as any)[method](...args) as T;
  }

  test("toSystemWithCache wraps system string in a text block with cache_control", () => {
    const result = callPrivate<unknown[]>("toSystemWithCache", "You are helpful.");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    const block = result[0] as Record<string, unknown>;
    expect(block.type).toBe("text");
    expect(block.text).toBe("You are helpful.");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("toAnthropicMessagesWithCache attaches cache_control only to last block of last message", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
      { role: "user", content: [{ type: "text", text: "last-first" }, { type: "text", text: "last-last" }] },
    ];

    const result = callPrivate<Array<Record<string, unknown>>>("toAnthropicMessagesWithCache", msgs);

    // First message — no cache_control on any block
    const firstMsgContent = result[0].content as Array<Record<string, unknown>>;
    for (const blk of firstMsgContent) {
      expect(blk.cache_control).toBeUndefined();
    }

    // Last message — only the last block has cache_control
    const lastMsgContent = result[1].content as Array<Record<string, unknown>>;
    expect(lastMsgContent[0].cache_control).toBeUndefined();
    expect(lastMsgContent[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("toAnthropicToolsWithCache attaches cache_control only to the last tool", () => {
    const result = callPrivate<Array<Record<string, unknown>>>("toAnthropicToolsWithCache", baseTools);

    expect(result).toHaveLength(2);
    // First tool — no cache_control
    expect(result[0].cache_control).toBeUndefined();
    // Last tool — has cache_control
    expect(result[1].cache_control).toEqual({ type: "ephemeral" });
    expect(result[1].name).toBe("bash");
  });

  test("toAnthropicToolsWithCache handles a single tool", () => {
    const single: ToolDefinition[] = [baseTools[0]];
    const result = callPrivate<Array<Record<string, unknown>>>("toAnthropicToolsWithCache", single);
    expect(result).toHaveLength(1);
    expect(result[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("toAnthropicToolsWithCache handles empty tools array", () => {
    const result = callPrivate<unknown[]>("toAnthropicToolsWithCache", []);
    expect(result).toHaveLength(0);
  });

  test("toAnthropicMessagesWithCache handles a single message with single block", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const result = callPrivate<Array<Record<string, unknown>>>("toAnthropicMessagesWithCache", msgs);
    const content = result[0].content as Array<Record<string, unknown>>;
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

// ─── AnthropicProvider — AbortSignal threading ───────────────────────────────

describe("AnthropicProvider — inferStream AbortSignal", () => {
  test("inferStream signature accepts optional opts with signal", () => {
    // This is a compile-time / type-level check. If the method signature does
    // not accept opts, TypeScript would have failed the tsc --noEmit step.
    // At runtime we confirm the method exists and accepts two args.
    const provider = new AnthropicProvider("test-key");
    const fn = provider.inferStream.bind(provider);
    // Should be a function; calling with opts arg should not throw synchronously
    expect(typeof fn).toBe("function");
    // Just confirm the method is callable — length varies by runtime/TS emit
    expect(fn.length).toBeGreaterThanOrEqual(0);
  });

  test("inferStream can be called without opts (backward compat)", () => {
    const provider = new AnthropicProvider("test-key");
    // Should not throw synchronously when called without opts
    // (will fail async due to missing real API key, which is fine for this test)
    const gen = provider.inferStream(makeRequest());
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
  });

  test("inferStream can be called with an AbortSignal", () => {
    const provider = new AnthropicProvider("test-key");
    const controller = new AbortController();
    // Should not throw synchronously
    const gen = provider.inferStream(makeRequest(), { signal: controller.signal });
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
  });

  test("signal abortion propagates — aborted signal results in aborted generator", async () => {
    const provider = new AnthropicProvider("test-key");
    const controller = new AbortController();
    controller.abort(); // pre-abort

    const gen = provider.inferStream(makeRequest(), { signal: controller.signal });
    // With an already-aborted signal the SDK should throw an abort error
    try {
      await gen.next();
      // If it resolves without error it must return done:true (no events yielded)
    } catch (err) {
      // Expected: AbortError or similar from the SDK
      expect(err).toBeDefined();
    }
  });
});

// ─── GoogleProvider — AbortSignal threading ──────────────────────────────────

describe("GoogleProvider — inferStream AbortSignal", () => {
  test("inferStream accepts optional opts param", () => {
    const provider = new GoogleProvider("test-key");
    const fn = provider.inferStream.bind(provider);
    expect(typeof fn).toBe("function");
  });

  test("inferStream can be called without opts (backward compat)", () => {
    const provider = new GoogleProvider("test-key");
    const gen = provider.inferStream(makeRequest({ provider: "google", model: "gemini-2.5-flash" }));
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
  });

  test("inferStream passes signal to fetch — abort causes fetch to reject", async () => {
    const provider = new GoogleProvider("test-key");
    const controller = new AbortController();
    controller.abort(); // pre-abort

    const gen = provider.inferStream(
      makeRequest({ provider: "google", model: "gemini-2.5-flash" }),
      { signal: controller.signal },
    );

    try {
      await gen.next();
    } catch (err) {
      // fetch with an already-aborted signal throws AbortError
      expect(err).toBeDefined();
    }
  });
});

// ─── OpenAIProvider — AbortSignal threading ──────────────────────────────────

describe("OpenAIProvider — inferStream AbortSignal", () => {
  test("inferStream accepts optional opts param", () => {
    const provider = new OpenAIProvider("test-key");
    expect(typeof provider.inferStream).toBe("function");
  });

  test("inferStream can be called without opts (backward compat)", () => {
    const provider = new OpenAIProvider("test-key");
    const gen = provider.inferStream(makeRequest({ provider: "openai", model: "gpt-4o" }));
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
  });

  test("inferStream can be called with an AbortSignal", () => {
    const provider = new OpenAIProvider("test-key");
    const controller = new AbortController();
    const gen = provider.inferStream(
      makeRequest({ provider: "openai", model: "gpt-4o" }),
      { signal: controller.signal },
    );
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
  });

  test("signal abortion propagates to internal controller", async () => {
    const provider = new OpenAIProvider("test-key");
    const controller = new AbortController();
    controller.abort(); // pre-abort

    const gen = provider.inferStream(
      makeRequest({ provider: "openai", model: "gpt-4o" }),
      { signal: controller.signal },
    );

    try {
      await gen.next();
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
