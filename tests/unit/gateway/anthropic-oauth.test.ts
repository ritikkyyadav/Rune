/**
 * Subscription-OAuth (Claude Pro/Max) mode for AnthropicProvider.
 *
 * A Claude Pro/Max login yields a bearer access token, not an API key. The
 * backend accepts it only when the request presents as Claude Code:
 *   • Authorization: Bearer <token>  (never x-api-key), and
 *   • anthropic-beta: oauth-2025-04-20, and
 *   • the first system block is the exact Claude Code identity line.
 * These tests lock that contract without making a real API call, and confirm the
 * API-key path is byte-identical to before (no identity block, no oauth beta).
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Reach a private field/method — TypeScript-only cast, safe at runtime in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(p: AnthropicProvider): any {
  return p as unknown as Record<string, unknown>;
}

describe("AnthropicProvider — subscription OAuth auth wiring", () => {
  test("oauth mode sends Bearer (authToken) and suppresses x-api-key", () => {
    const p = new AnthropicProvider("oauth-access-token", undefined, { oauth: true });
    const client = priv(p).client as { apiKey: string | null; authToken: string | null };
    expect(client.authToken).toBe("oauth-access-token");
    expect(client.apiKey).toBeNull(); // nulled so the SDK cannot prefer x-api-key
  });

  test("api-key mode is unchanged: x-api-key set, no bearer", () => {
    const p = new AnthropicProvider("sk-ant-123", undefined);
    const client = priv(p).client as { apiKey: string | null; authToken: string | null };
    expect(client.apiKey).toBe("sk-ant-123");
    expect(client.authToken).toBeNull();
  });
});

describe("AnthropicProvider — betaHeader composition", () => {
  test("api-key mode, no interleaving → no beta header (byte-identical to before)", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).betaHeader(false)).toBeUndefined();
  });

  test("api-key mode + interleaving → interleaved beta only (legacy behavior)", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).betaHeader(true)).toEqual({
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });
  });

  test("oauth mode → always carries the oauth beta", () => {
    const p = new AnthropicProvider("tok", undefined, { oauth: true });
    expect(priv(p).betaHeader(false)).toEqual({ "anthropic-beta": "oauth-2025-04-20" });
  });

  test("oauth mode + interleaving → BOTH betas, comma-joined (neither dropped)", () => {
    const p = new AnthropicProvider("tok", undefined, { oauth: true });
    expect(priv(p).betaHeader(true)).toEqual({
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    });
  });
});

describe("AnthropicProvider — foreign opaque-block isolation", () => {
  test("drops another provider's redacted_thinking (e.g. Codex reasoning) from the request", () => {
    const p = new AnthropicProvider("sk-ant");
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "codex-reasoning-json", provider: "codex" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const out = priv(p).toAnthropicMessagesWithCache(messages) as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const assistant = out[1];
    // the codex-tagged block is gone; only the text survives
    expect(assistant.content.every((b) => b.type !== "redacted_thinking")).toBe(true);
    expect(assistant.content.some((b) => b.type === "text")).toBe(true);
  });

  test("keeps Anthropic's OWN (untagged) redacted_thinking block", () => {
    const p = new AnthropicProvider("sk-ant");
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "anthropic-blob" }, // no provider ⇒ Anthropic's own
          { type: "text", text: "hi" },
        ],
      },
    ];
    const out = priv(p).toAnthropicMessagesWithCache(messages) as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(out[0].content.some((b) => b.type === "redacted_thinking")).toBe(true);
  });
});

describe("AnthropicProvider — toSystemBlocks identity injection", () => {
  test("oauth mode prepends the Claude Code identity, real system keeps the cache breakpoint", () => {
    const p = new AnthropicProvider("tok", undefined, { oauth: true });
    const blocks = priv(p).toSystemBlocks("You are Gear, a coding agent.") as Array<
      Record<string, unknown>
    >;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: IDENTITY }); // identity first, uncached
    expect(blocks[1]).toEqual({
      type: "text",
      text: "You are Gear, a coding agent.",
      cache_control: { type: "ephemeral" },
    });
  });

  test("oauth mode with no system prompt still sends the identity block (backend requires it)", () => {
    const p = new AnthropicProvider("tok", undefined, { oauth: true });
    const blocks = priv(p).toSystemBlocks(undefined) as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: IDENTITY,
      cache_control: { type: "ephemeral" },
    });
  });

  test("api-key mode never injects the identity block (unchanged single cached block)", () => {
    const p = new AnthropicProvider("sk-ant-123");
    const blocks = priv(p).toSystemBlocks("You are Gear.") as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "You are Gear.",
      cache_control: { type: "ephemeral" },
    });
  });

  test("api-key mode with no system → undefined (no system param at all)", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).toSystemBlocks(undefined)).toBeUndefined();
  });
});
