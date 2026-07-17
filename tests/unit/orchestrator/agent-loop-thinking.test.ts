/**
 * Thinking support in AgentLoop:
 *  1. Completed thinking blocks (thinking_stop) are stored in the assistant
 *     message and REPLAYED on the next request of a tool-use loop — Anthropic
 *     rejects continuations with missing/modified thinking blocks.
 *  2. redacted_thinking blocks round-trip untouched.
 *  3. The request carries thinking.enabled by default; disabled via config.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

const readRegistry = {
  toLlmTools: mock(() => []),
  get: mock(() => ({ schema: { category: "read", permissionLevel: "auto" } })),
  execute: mock(async (input: any) => ({
    callId: input.callId,
    toolName: input.toolName,
    success: true,
    result: "file contents",
    durationMs: 1,
  })),
} as any;

describe("AgentLoop thinking preservation", () => {
  test("thinking blocks are stored and replayed across a tool-use loop", async () => {
    let turn = 0;
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        turn++;
        if (turn === 1) {
          yield ev("thinking_delta", { text: "let me look…" });
          yield ev("thinking_stop", { thinking: "let me look…", signature: "sig123" });
          yield ev("redacted_thinking", { data: "opaque-blob" });
          yield ev("tool_use_start", { toolCallId: "t1", toolName: "read_file" });
          yield ev("tool_use_stop", { toolCallId: "t1", toolInput: { path: "a.ts" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, readRegistry);
    for await (const _ of loop.run("look at a.ts", "s1", "/tmp")) {
      // drain
    }

    // Second request must contain the assistant message with thinking blocks
    // ahead of the tool_use block, verbatim.
    const assistant = requests[1].messages.find((m: any) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const types = assistant.content.map((b: any) => b.type);
    expect(types).toEqual(["thinking", "redacted_thinking", "tool_use"]);
    expect(assistant.content[0].thinking).toBe("let me look…");
    expect(assistant.content[0].signature).toBe("sig123");
    expect(assistant.content[1].data).toBe("opaque-blob");
  });

  test("thinking is requested by default and can be disabled", async () => {
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        yield ev("content_delta", { delta: { type: "text_delta", text: "hi" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
    } as any;

    const on = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, readRegistry);
    for await (const _ of on.run("q", "s", "/tmp")) {
      /* drain */
    }
    // Effort defaults HIGH: agentic planning/diagnosis at medium is the
    // rushed-shallow failure mode (2026-07-16 audit).
    expect(requests[0].thinking).toEqual({ enabled: true, effort: "high" });

    const off = new AgentLoop(
      { model: "m", provider: "anthropic", thinking: false },
      gateway,
      readRegistry,
    );
    for await (const _ of off.run("q", "s", "/tmp")) {
      /* drain */
    }
    expect(requests[1].thinking).toEqual({ enabled: false, effort: "high" });

    const low = new AgentLoop(
      { model: "m", provider: "anthropic", thinkingEffort: "low" },
      gateway,
      readRegistry,
    );
    for await (const _ of low.run("q", "s", "/tmp")) {
      /* drain */
    }
    expect(requests[2].thinking).toEqual({ enabled: true, effort: "low" });
  });
});

describe("AnthropicProvider thinking param selection", () => {
  const provider = new AnthropicProvider("test-key") as any;

  function param(model: string, maxTokens = 32000, enabled = true) {
    return provider.buildThinkingParam({
      model,
      maxTokens,
      thinking: { enabled },
      messages: [],
      provider: "anthropic",
      stream: true,
    });
  }

  test("adaptive models get {type: adaptive} with no budget", () => {
    for (const m of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-sonnet-5"]) {
      const r = param(m);
      expect(r.thinking).toEqual({ type: "adaptive" });
      expect(r.needsInterleavedBeta).toBe(false);
    }
  });

  test("budget models get enabled + budget_tokens < max_tokens", () => {
    const r = param("claude-sonnet-4-5");
    expect(r.thinking.type).toBe("enabled");
    expect(r.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(r.thinking.budget_tokens).toBeLessThan(32000);
    expect(r.needsInterleavedBeta).toBe(true);
  });

  test("no thinking for unsupported or disabled cases", () => {
    expect(param("claude-3-5-haiku-20241022").thinking).toBeUndefined();
    expect(param("claude-sonnet-4-5", 32000, false).thinking).toBeUndefined();
    // budget would fall below the 1024 floor → skip thinking
    expect(param("claude-sonnet-4-5", 1500).thinking).toBeUndefined();
  });
});
