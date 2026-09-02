// ─── /model tree picker — providers → accounts → models ───
// Pure-module tests: level filtering/ordering, account derivation (saved vs
// env vs endpoint vs custom), model marks (current/default), live listing for
// local runtimes, and the themed line renderers.

import { describe, it, expect } from "bun:test";
import {
  providerChoices,
  accountChoices,
  modelChoices,
  fetchLiveModels,
  treeHeadline,
  formatProviderLine,
  formatAccountLine,
  formatModelLine,
} from "../../../packages/orchestrator/src/bin/ui/model-picker";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import type { ProviderStatusRow } from "../../../packages/orchestrator/src/provider-registry";
import { getPreset, type CustomEndpoint } from "../../../packages/shared/src";

const row = (over: Partial<ProviderStatusRow>): ProviderStatusRow => ({
  id: "openai",
  label: "OpenAI",
  hasKey: false,
  keyCount: 0,
  savedKeys: [],
  source: "none",
  masked: "",
  disabled: false,
  active: false,
  ...over,
});

const CUSTOM: CustomEndpoint = {
  baseUrl: "http://10.0.0.7:8080/v1",
  model: "glm-4.7",
  key: "k",
  label: "Lab box",
};

describe("providerChoices (level 1)", () => {
  it("keeps configured providers, local runtimes, and the active one; hides the rest", () => {
    const rows: ProviderStatusRow[] = [
      row({
        id: "anthropic",
        label: "Anthropic",
        hasKey: true,
        source: "saved",
        masked: "sk-a…12",
      }),
      row({ id: "openai", label: "OpenAI" }), // no key → hidden
      row({ id: "google", label: "Google Gemini", active: true }), // active, keyless → shown
      row({
        id: "ollama",
        label: "Ollama (local)",
        local: true,
        endpoint: "http://localhost:11434",
      }),
      row({ id: "custom", label: "Custom endpoint" }), // no custom configured → hidden
    ];
    const out = providerChoices(rows, undefined, {}, getPreset);
    expect(out.map((c) => c.id)).toEqual(["google", "anthropic", "ollama"]);
  });

  it("orders active first, then cloud, then local, then custom; disabled stays hidden", () => {
    const rows: ProviderStatusRow[] = [
      row({
        id: "ollama",
        label: "Ollama (local)",
        local: true,
        endpoint: "http://localhost:11434",
      }),
      row({ id: "custom", label: "Custom endpoint", hasKey: true, source: "saved" }),
      row({ id: "anthropic", label: "Anthropic", hasKey: true, source: "saved" }),
      row({ id: "openrouter", label: "OpenRouter", hasKey: true, source: "env", disabled: true }),
      row({ id: "openai", label: "OpenAI", hasKey: true, source: "saved", active: true }),
    ];
    const out = providerChoices(rows, CUSTOM, {}, getPreset);
    expect(out.map((c) => c.id)).toEqual(["openai", "anthropic", "ollama", "custom"]);
    expect(out[3]!.label).toBe("Lab box"); // the custom endpoint shows its label
  });

  it("hints carry the one-glance state (active dot, key source, endpoint host)", () => {
    const rows: ProviderStatusRow[] = [
      row({
        id: "openai",
        label: "OpenAI",
        hasKey: true,
        source: "saved",
        masked: "sk-o…99",
        active: true,
      }),
      row({
        id: "ollama",
        label: "Ollama (local)",
        local: true,
        endpoint: "http://localhost:11434",
      }),
    ];
    const env = { OPENAI_API_KEY: "sk-env" } as NodeJS.ProcessEnv;
    const out = providerChoices(rows, undefined, env, getPreset);
    const openai = stripAnsi(out[0]!.hint);
    expect(openai).toContain("● active");
    expect(openai).toContain("key saved sk-o…99");
    expect(openai).toContain("+env"); // both paths exist → surfaced at a glance
    expect(stripAnsi(out[1]!.hint)).toBe("localhost:11434");
  });
});

describe("accountChoices (level 2)", () => {
  it("lists saved AND env keys when both exist (the only multi-account case)", () => {
    const r = row({ id: "openai", hasKey: true, source: "saved", masked: "sk-o…99" });
    const env = { OPENAI_API_KEY: "sk-env-1234567890" } as NodeJS.ProcessEnv;
    const out = accountChoices(getPreset("openai"), r, undefined, env);
    expect(out.map((a) => a.kind)).toEqual(["key", "env"]);
    expect(out[0]!.detail).toBe("sk-o…99");
    expect(out[1]!.detail).toContain("OPENAI_API_KEY");
    expect(out[1]!.detail).not.toContain("sk-env-1234567890"); // masked, never raw
  });

  it("env-only providers yield a single env account", () => {
    const r = row({ id: "openai", hasKey: true, source: "env", masked: "sk-e…11" });
    const env = { OPENAI_API_KEY: "sk-env-1234567890" } as NodeJS.ProcessEnv;
    const out = accountChoices(getPreset("openai"), r, undefined, env);
    expect(out.map((a) => a.kind)).toEqual(["env"]);
  });

  it("a multi-key pool lists every stored key with entry ids and the active mark", () => {
    const r = row({
      id: "ollama-turbo",
      hasKey: true,
      source: "saved",
      masked: "sk-b…22",
      keyCount: 2,
      savedKeys: [
        {
          id: "k1",
          masked: "sk-a…11",
          label: "personal",
          addedAt: "2026-07-01T10:00:00Z",
          active: false,
        },
        {
          id: "k2",
          masked: "sk-b…22",
          label: "work",
          addedAt: "2026-07-10T10:00:00Z",
          active: true,
        },
      ],
    });
    const out = accountChoices(getPreset("ollama-turbo"), r, undefined, {});
    expect(out.map((a) => a.kind)).toEqual(["key", "key"]);
    expect(out[0]).toMatchObject({ label: "API key | personal", entryId: "k1", active: false });
    expect(out[0]!.detail).toContain("added 2026-07-01");
    expect(out[1]).toMatchObject({ label: "API key | work", entryId: "k2", active: true });
  });

  it("a signed-in OAuth account leads the list and outranks stored keys", () => {
    const r = row({
      id: "anthropic",
      label: "Anthropic",
      hasKey: true,
      source: "oauth",
      authMethod: "oauth",
      keyCount: 1,
      savedKeys: [{ id: "k1", masked: "sk-a…11", active: true }],
    });
    const out = accountChoices(getPreset("anthropic"), r, undefined, {});
    expect(out[0]).toMatchObject({ kind: "oauth", label: "OAuth account", active: true });
    expect(out[0]!.detail).toContain("signed in");
    // The pool key is listed but not the wire credential while OAuth is signed in.
    expect(out[1]).toMatchObject({ kind: "key", active: false });
  });

  it("a device-flow login reads as signed in · device flow", () => {
    // Copilot was the device-flow provider until P8.5 removed it; the rendering
    // is method-driven, not provider-driven, so the case survives it.
    const r = row({
      id: "openrouter",
      label: "OpenRouter",
      hasKey: true,
      source: "oauth",
      authMethod: "device",
    });
    const out = accountChoices(getPreset("openrouter"), r, undefined, {});
    expect(out[0]!.detail).toBe("signed in | device flow");
  });

  it("local runtimes yield their endpoint; custom yields the endpoint card", () => {
    const local = row({ id: "ollama", local: true, endpoint: "http://localhost:11434" });
    expect(accountChoices(getPreset("ollama"), local, undefined, {})).toEqual([
      { kind: "endpoint", label: "Local endpoint", detail: "http://localhost:11434", active: true },
    ]);
    const custom = row({ id: "custom", hasKey: true, source: "saved" });
    const out = accountChoices(undefined, custom, CUSTOM, {});
    expect(out[0]!.kind).toBe("custom");
    expect(out[0]!.label).toBe("Lab box");
    expect(out[0]!.detail).toContain("glm-4.7");
  });
});

describe("modelChoices (level 3)", () => {
  const current = { provider: "openai", model: "gpt-5" };

  it("uses the curated preset list with current/default marks", () => {
    const out = modelChoices(getPreset("openai"), "openai", {
      current,
      def: { provider: "openai", model: "o3" },
    });
    expect(out.find((m) => m.id === "gpt-5")!.current).toBe(true);
    expect(out.find((m) => m.id === "o3")!.isDefault).toBe(true);
    expect(out.find((m) => m.id === "gpt-5-mini")!.current).toBe(false);
  });

  it("live listings replace the curated list (only what the endpoint serves)", () => {
    const out = modelChoices(getPreset("ollama"), "ollama", {
      live: ["qwen3:30b", "llama3.3:70b"],
      current: { provider: "ollama", model: "qwen3:30b" },
      def: null,
    });
    expect(out.map((m) => m.id)).toEqual(["qwen3:30b", "llama3.3:70b"]);
    expect(out[0]!.current).toBe(true);
  });

  it("the custom endpoint offers exactly its configured model", () => {
    const out = modelChoices(undefined, "custom", { custom: CUSTOM, current, def: null });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("glm-4.7");
  });
});

describe("fetchLiveModels", () => {
  it("reads ollama /api/tags and openai-compat /models shapes", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/tags")
          return Response.json({ models: [{ name: "qwen3:30b" }, { name: "phi3:mini" }] });
        if (path === "/v1/models") return Response.json({ data: [{ id: "loaded-model" }] });
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const base = `http://localhost:${srv.port}`;
      expect(await fetchLiveModels("ollama", base)).toEqual(["qwen3:30b", "phi3:mini"]);
      expect(await fetchLiveModels("openai-compat", `${base}/v1`)).toEqual(["loaded-model"]);
    } finally {
      srv.stop(true);
    }
  });

  it("unreachable hosts and non-local kinds fall back to null (never throw)", async () => {
    expect(await fetchLiveModels("ollama", "http://127.0.0.1:1", 300)).toBeNull();
    expect(await fetchLiveModels("anthropic", "http://localhost:11434", 300)).toBeNull();
  });
});

describe("line rendering", () => {
  it("treeHeadline reads out current and default", () => {
    const lines = treeHeadline(
      { provider: "openai", model: "gpt-5" },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ).map(stripAnsi);
    expect(lines[0]).toContain("CURRENT");
    expect(lines[0]).toContain("openai/gpt-5");
    expect(lines[1]).toContain("DEFAULT");
    expect(lines[1]).toContain("anthropic/claude-sonnet-5");
  });

  it("model lines carry number, label, id, and marks", () => {
    const line = stripAnsi(
      formatModelLine(3, { id: "o3", label: "o3", current: true, isDefault: true }),
    );
    expect(line).toContain("[3] o3");
    expect(line).toContain("< current");
    expect(line).toContain("◆ default");
    const withId = stripAnsi(
      formatModelLine(1, { id: "gpt-5", label: "GPT-5", current: false, isDefault: false }),
    );
    expect(withId).toContain("GPT-5");
    expect(withId).toContain("gpt-5");
  });

  it("provider/account lines are numbered and readable; active accounts get the dot", () => {
    expect(stripAnsi(formatProviderLine(2, { id: "openai", label: "OpenAI", hint: "" }))).toContain(
      "[2] OpenAI",
    );
    expect(
      stripAnsi(formatAccountLine(1, { kind: "key", label: "API key · saved", detail: "sk…9" })),
    ).toContain("[1] API key · saved  sk…9");
    expect(
      stripAnsi(
        formatAccountLine(2, {
          kind: "oauth",
          label: "OAuth account",
          detail: "signed in",
          active: true,
        }),
      ),
    ).toContain("●");
  });

  it("oauth providers surface signed-in state in the level-1 hint", () => {
    const rows: ProviderStatusRow[] = [
      row({
        id: "codex",
        label: "ChatGPT (Codex)",
        hasKey: true,
        source: "oauth",
        authMethod: "oauth",
      }),
    ];
    const out = providerChoices(rows, undefined, {}, getPreset);
    expect(stripAnsi(out[0]!.hint)).toContain("oauth | signed in");
  });
});
