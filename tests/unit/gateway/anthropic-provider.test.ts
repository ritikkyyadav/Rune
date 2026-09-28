/**
 * AnthropicProvider's request shape: API key only.
 *
 * This transport used to carry a second mode, a Claude subscription token sent
 * as a bearer under another client's identity. That mode is retired (see
 * docs/program/compliance-subscription-routes.md). These tests pin what is left
 * without making a real API call: x-api-key auth, no identity block, a beta
 * header only when interleaved thinking needs one, and no SDK retries stacked
 * under the gateway's own.
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";

/** Reach a private field/method — TypeScript-only cast, safe at runtime in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(p: AnthropicProvider): any {
  return p as unknown as Record<string, unknown>;
}

describe("AnthropicProvider — auth wiring", () => {
  test("sends the key as x-api-key, never as a bearer", () => {
    const p = new AnthropicProvider("sk-ant-123", undefined);
    const client = priv(p).client as { apiKey: string | null; authToken: string | null };
    expect(client.apiKey).toBe("sk-ant-123");
    expect(client.authToken).toBeNull();
  });

  test("an `oauth` option from an old caller changes nothing", () => {
    // The option is gone from the type; a stale caller that still passes it
    // must not find a subscription mode behind it.
    const p = new AnthropicProvider("tok", undefined, { oauth: true } as never);
    const client = priv(p).client as { apiKey: string | null; authToken: string | null };
    expect(client.apiKey).toBe("tok");
    expect(client.authToken).toBeNull();
    expect(priv(p).betaHeader(false)).toBeUndefined();
    expect(priv(p).toSystemBlocks("You are Rune.")).toHaveLength(1);
  });

  test("the SDK does not retry underneath the gateway", () => {
    // The gateway owns attempts, backoff and fallback; the SDK's default of 2
    // retries multiplied every one of them.
    const p = new AnthropicProvider("sk-ant-123");
    expect((priv(p).client as { maxRetries: number }).maxRetries).toBe(0);
  });
});

describe("AnthropicProvider — betaHeader composition", () => {
  test("no interleaving → no beta header at all", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).betaHeader(false)).toBeUndefined();
  });

  test("interleaving → the interleaved-thinking beta, alone", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).betaHeader(true)).toEqual({
      "anthropic-beta": "interleaved-thinking-2025-05-14",
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

describe("AnthropicProvider — system blocks", () => {
  test("Rune's system prompt is the only block, and it carries the cache breakpoint", () => {
    const p = new AnthropicProvider("sk-ant-123");
    const blocks = priv(p).toSystemBlocks("You are Rune.") as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "You are Rune.",
      cache_control: { type: "ephemeral" },
    });
  });

  test("no system prompt → undefined (no system param at all)", () => {
    const p = new AnthropicProvider("sk-ant-123");
    expect(priv(p).toSystemBlocks(undefined)).toBeUndefined();
  });
});
