/**
 * P8.1 — the cache-breakpoint policy is DECLARED per provider, not sniffed.
 *
 * What this replaces: `forwardsCacheControl = baseUrl.includes("openrouter.ai")`.
 * A substring test on a URL cannot say which hosts were measured, silently
 * excludes every endpoint added later, and would have quietly enabled
 * Anthropic-shaped fields for anyone whose custom endpoint happened to proxy
 * through a matching domain. These tests pin the policy each provider is
 * built with, so a future host is a table entry with a test, not a guess.
 */

import { describe, test, expect } from "bun:test";
import {
  cacheBreakpointPolicyFor,
  declaredCachePolicies,
  isAnthropicUpstream,
  promptCacheKey,
  type CacheBreakpointPolicy,
} from "../../../packages/llm-gateway/src/providers/cache-policy";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import { OpenRouterProvider } from "../../../packages/llm-gateway/src/providers/openrouter";
import { buildGateway } from "../../../packages/orchestrator/src/provider-registry";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

const POLICIES: CacheBreakpointPolicy[] = [
  "anthropic-style",
  "prompt-cache-key",
  "implicit",
  "none",
];

describe("the policy table", () => {
  test("every declared policy is one of the four", () => {
    for (const [id, policy] of Object.entries(declaredCachePolicies())) {
      expect(POLICIES, `${id} declares an unknown policy`).toContain(policy);
    }
  });

  test("each provider gets the policy its host actually implements", () => {
    // OpenRouter forwards Anthropic cache_control upstream (measured).
    expect(cacheBreakpointPolicyFor("openrouter")).toBe("anthropic-style");
    // First-party OpenAI caches automatically and takes the routing hint.
    expect(cacheBreakpointPolicyFor("openai")).toBe("prompt-cache-key");
    // Gemini caches automatically and reports it. MEASURED 2026-09-02: 99.7%.
    expect(cacheBreakpointPolicyFor("google")).toBe("implicit");
    // Documented automatic prefix caching, no wire field. Unmeasured here.
    expect(cacheBreakpointPolicyFor("deepseek")).toBe("implicit");
    expect(cacheBreakpointPolicyFor("groq")).toBe("implicit");
    expect(cacheBreakpointPolicyFor("xai")).toBe("implicit");
    // MEASURED 2026-09-02 on gpt-oss:20b: cached=0 on both turns of an
    // identical prefix. The documentation-based "implicit" was wrong, and a
    // cache nobody can observe is not a cache.
    expect(cacheBreakpointPolicyFor("ollama-turbo")).toBe("none");
    // A user-supplied endpoint could be anything.
    expect(cacheBreakpointPolicyFor("custom")).toBe("none");
  });

  test("an unknown id falls to none, never to a cache it may not have", () => {
    expect(cacheBreakpointPolicyFor("some-host-added-tomorrow")).toBe("none");
  });

  test("every declared id is a real preset id (or the custom endpoint)", () => {
    const known = new Set([...PROVIDER_PRESETS.map((p) => p.id), "custom"]);
    for (const id of Object.keys(declaredCachePolicies())) {
      expect(known, `${id} has a policy but no preset`).toContain(id);
    }
  });
});

describe("the policy reaches the constructed provider", () => {
  test("OpenRouterProvider declares anthropic-style on its inner adapter", () => {
    const inner = (new OpenRouterProvider("k") as unknown as { inner: OpenAIProvider }).inner;
    expect(inner.cacheBreakpoints).toBe("anthropic-style");
  });

  test("buildGateway sets the declared policy at every construction site", () => {
    const gw = buildGateway({
      provider: "openai",
      keys: {
        openai: "sk-test",
        groq: "gsk-test",
        deepseek: "sk-test",
        xai: "xai-test",
        "ollama-turbo": "ol-test",
      },
      customEndpoint: { key: "k", baseUrl: "https://example.invalid/v1" },
      // Empty env so the host's own keys never reach these assertions.
      env: {} as NodeJS.ProcessEnv,
    });

    for (const id of ["openai", "groq", "deepseek", "xai", "ollama-turbo", "custom"]) {
      const p = gw.getProvider(id as never) as unknown as
        { cacheBreakpoints?: CacheBreakpointPolicy } | undefined;
      expect(p, `${id} did not register`).toBeDefined();
      expect(p!.cacheBreakpoints, `${id} policy`).toBe(cacheBreakpointPolicyFor(id));
    }
  });
});

describe("prompt-cache-key on the wire", () => {
  /** A provider whose HTTP client records the body it was handed. */
  function recording(policy: CacheBreakpointPolicy): {
    provider: OpenAIProvider;
    body: () => Record<string, unknown>;
  } {
    let seen: Record<string, unknown> = {};
    const provider = new OpenAIProvider("k", undefined, "openai", { cacheBreakpoints: policy });
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (b: Record<string, unknown>) => {
            seen = b;
            return {
              id: "cmpl_1",
              model: "gpt-5",
              choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            };
          },
        },
      },
    };
    return { provider, body: () => seen };
  }

  const request: InferenceRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: "you are a careful agent",
    model: "gpt-5",
    provider: "openai",
    maxTokens: 16,
    stream: false,
  };

  test("the routing hint is sent under the prompt-cache-key policy", async () => {
    const { provider, body } = recording("prompt-cache-key");
    await provider.infer(request);
    expect(body().prompt_cache_key).toBe(promptCacheKey(request.system, []));
  });

  test("no other policy puts the field on the wire", async () => {
    for (const policy of ["anthropic-style", "implicit", "none"] as CacheBreakpointPolicy[]) {
      const { provider, body } = recording(policy);
      await provider.infer(request);
      expect(body().prompt_cache_key, policy).toBeUndefined();
    }
  });

  test("the key is stable for a stable prefix and moves when the prefix does", () => {
    expect(promptCacheKey("sys", ["read", "write"])).toBe(promptCacheKey("sys", ["read", "write"]));
    expect(promptCacheKey("sys", ["read", "write"])).not.toBe(promptCacheKey("sys", ["read"]));
    expect(promptCacheKey("sys", [])).not.toBe(promptCacheKey("other", []));
  });

  test("the key carries no prompt text", () => {
    const key = promptCacheKey("a very secret system prompt", ["bash"]);
    expect(key).toMatch(/^gear-[0-9a-f]{8}$/);
    expect(key).not.toContain("secret");
  });
});

describe("the anthropic-upstream gate", () => {
  test("only anthropic-prefixed model ids qualify", () => {
    expect(isAnthropicUpstream("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicUpstream("ANTHROPIC/claude-opus-5")).toBe(true);
    expect(isAnthropicUpstream("openai/gpt-5")).toBe(false);
    expect(isAnthropicUpstream("stealth/ox-alpha")).toBe(false);
    // Not an upstream route: a bare Anthropic id is the direct adapter's job.
    expect(isAnthropicUpstream("claude-sonnet-4-6")).toBe(false);
  });
});
