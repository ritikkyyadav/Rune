// ─── Provider presets ───
// The single source of truth for which LLM providers Alan can talk to and how to
// reach each one. The `/keys` panel, the engine's gateway builder, and
// `/providers` all read from this list, so adding a provider is a one-line edit.
//
// Most non-Anthropic/Google hosts speak the OpenAI Chat Completions wire format
// ("openai-compat"), so they all run through OpenAIProvider with a different base
// URL — the same mechanism OpenRouter already uses.

export type ProviderKind =
  | "anthropic"
  | "openai-compat"
  | "google"
  | "ollama"
  // Subscription transports with their own auth + endpoints:
  | "copilot" // GitHub Copilot (device login → api.githubcopilot.com)
  | "codex"; // ChatGPT Plus/Pro via the Codex "responses" backend

// ─── Authentication methods ───
// How a provider proves who you are. This is the ONE canonical definition of the
// set; `@alan/llm-gateway`'s auth layer re-exports it so the strategy code and the
// preset metadata never drift. Adding a method here is the first step to teaching
// Berne a new way to sign in — the rest of the system asks for an *authenticated*
// provider and never learns which of these produced it.
//
//   api_key  — a bearer secret pasted/env-supplied (today's only path).
//   oauth    — browser authorization-code + PKCE (loopback redirect).
//   device   — OAuth device-code (headless / SSH-friendly, no local browser).
//   local    — a localhost runtime reached by URL; connectivity, no credential.
export type AuthMethod = "api_key" | "oauth" | "device" | "local";

/**
 * Coarse, provider-level capability facts surfaced for display and routing hints.
 * Model-level truth still lives in `models` / MODEL_PRICING — these are the
 * broad strokes (does this provider stream, call tools, see images, reason).
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  contextLength?: number;
}

export interface ProviderPreset {
  /** Stable id; also the registered provider name in the gateway. */
  id: string;
  /** Display name shown in the keys panel. */
  label: string;
  /** Adapter to instantiate for this provider. */
  kind: ProviderKind;
  /** Suggested default model when this provider becomes active. */
  defaultModel: string;
  /** Where to get a key (shown as a hint in the panel). */
  docsUrl: string;
  /** Env var that also supplies this key (checked after a saved key). */
  envVar?: string;
  /**
   * A local runtime (Ollama / LM Studio) that needs no API key — it's reached by
   * base URL on the user's machine. Registered when enabled regardless of key,
   * and shown in `/keys`/`/providers` with an editable URL instead of a key.
   */
  local?: boolean;
  /** Base URL for openai-compat/local hosts; omit for native OpenAI. */
  baseUrl?: string;
  /** Rough key-shape hint shown in the panel (e.g. "sk-ant-…"). */
  keyHint?: string;
  /**
   * Curated models offered in the `/model` picker for this provider. The picker
   * is data-driven from this list, so adding a provider = add a preset with its
   * models — no per-provider UI code. Any model id still works via free-form
   * `/model <provider>/<id>`. Keep these to models known to be reachable on a
   * default plan (no silent fallback surprises).
   */
  models?: { id: string; label: string }[];
  /**
   * Authentication methods this provider supports, in preference order.
   * Additive and optional: when omitted the effective methods default to
   * `["local"]` for local runtimes and `["api_key"]` for everyone else (see
   * `effectiveAuthMethods`). Only set this where a provider genuinely offers
   * more than an API key — e.g. OpenRouter's documented OAuth (PKCE) flow.
   */
  auth?: AuthMethod[];
  /** Optional per-preset capability override; otherwise derived in the descriptor. */
  capabilities?: ProviderCapabilities;
  /** Optional pricing note; live cost still comes from MODEL_PRICING. */
  pricing?: { source: "static" | "live"; note?: string };
}

/** The reserved id for the single user-defined OpenAI-compatible endpoint. */
export const CUSTOM_PROVIDER_ID = "custom";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    // Two ways in: sign in with a Claude Pro/Max *subscription* (OAuth → a
    // refreshable bearer token spent against your plan), or paste an API key.
    // OAuth is preferred in the picker; the API key stays the fallback and the
    // env/console path is byte-identical to before for existing key users.
    auth: ["oauth", "api_key"],
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compat",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5",
    docsUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    models: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "o3", label: "o3" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compat",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3-coder:free",
    docsUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    // OpenRouter documents a PKCE OAuth flow that mints a normal API key —
    // Berne's fully-working OAuth reference. API key stays the fallback.
    auth: ["oauth", "api_key"],
    models: [
      { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder (free)" },
      { id: "deepseek/deepseek-v4-flash:free", label: "DeepSeek V4 (free)" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)" },
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    kind: "google",
    envVar: "GOOGLE_API_KEY",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compat",
    envVar: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    kind: "openai-compat",
    envVar: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    docsUrl: "https://console.x.ai/",
    keyHint: "xai-…",
    models: [
      { id: "grok-4", label: "Grok 4" },
      { id: "grok-4-fast", label: "Grok 4 Fast" },
      { id: "grok-code-fast-1", label: "Grok Code Fast" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compat",
    envVar: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    docsUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    // ChatGPT Plus/Pro subscription via the Codex backend. Signs in with the
    // "Sign in with ChatGPT" OAuth flow (no API key); the CodexProvider speaks
    // the ChatGPT Codex "responses" API using the account token. Models are the
    // Codex-enabled set for your plan — pick with `/model codex/<id>`.
    id: "codex",
    label: "ChatGPT (Codex)",
    kind: "codex",
    // A ChatGPT account (not an API key) can ONLY call the current Codex-for-
    // ChatGPT allowlist — the GPT-5.6 family plus gpt-5.5. The plain gpt-5 /
    // gpt-5-codex / 5.2 / 5.3-codex slugs are API-key-only or deprecated here and
    // 400 with "model is not supported when using Codex with a ChatGPT account".
    // gpt-5.6-sol is OpenAI's documented default (Power, medium reasoning).
    // gpt-5.5 is the previous frontier — available on plans that include it
    // (may 400 on some Plus tiers). Ref: https://learn.chatgpt.com/docs/models
    defaultModel: "gpt-5.6-sol",
    docsUrl: "https://learn.chatgpt.com/docs/models",
    auth: ["oauth"],
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (flagship)" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fast)" },
      { id: "gpt-5.5", label: "GPT-5.5 (previous frontier)" },
    ],
  },
  {
    // GitHub Copilot subscription. Signs in with GitHub's device flow (no API
    // key); the CopilotProvider mints short-lived Copilot tokens from the GitHub
    // token and talks to api.githubcopilot.com (OpenAI-compatible). Model ids are
    // Copilot's own catalog (plan-dependent) — pick with `/model copilot/<id>`,
    // or list live with `berne models copilot`.
    id: "copilot",
    label: "GitHub Copilot",
    kind: "copilot",
    defaultModel: "gpt-4o",
    docsUrl: "https://github.com/settings/copilot",
    auth: ["device"],
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "o4-mini", label: "o4-mini" },
      { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    // Ollama's hosted cloud ("Turbo"). Distinct id from local "ollama" so the
    // two never collide in the gateway: this one is a keyed OpenAI-compatible
    // host (https://ollama.com/v1), while "ollama" stays the keyless localhost
    // path. Keys come from the panel or the OLLAMA_API_KEY env var.
    id: "ollama-turbo",
    label: "Ollama Turbo (cloud)",
    kind: "openai-compat",
    envVar: "OLLAMA_API_KEY",
    baseUrl: "https://ollama.com/v1",
    defaultModel: "qwen3-coder:480b",
    docsUrl: "https://ollama.com/settings/keys",
    // Verified reachable on the default (no-subscription) Ollama Cloud plan and
    // tool-capable where it matters for agentic use. Subscription-gated models
    // (deepseek-v3.1, kimi-k2, glm-5.x, mistral-large-3, gemini-3) are
    // intentionally omitted — they 403 and would trip silent provider fallback.
    models: [
      { id: "qwen3-coder:480b", label: "Qwen3 Coder 480B" },
      { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
      { id: "qwen3-next:80b", label: "Qwen3 Next 80B" },
      { id: "devstral-2:123b", label: "Devstral 2 123B" },
      { id: "glm-4.7", label: "GLM 4.7" },
      { id: "gpt-oss:120b", label: "GPT-OSS 120B" },
    ],
  },
  {
    // Local Ollama (no key). Reached over /api/chat on the user's machine via
    // OllamaProvider. The base URL is editable in /keys and config.toml; any
    // pulled model works via `/model ollama/<name>` — the listed ones are just
    // common suggestions and may need `ollama pull` first.
    id: "ollama",
    label: "Ollama (local)",
    kind: "ollama",
    local: true,
    baseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    docsUrl: "https://ollama.com/download",
    models: [
      { id: "llama3.1", label: "Llama 3.1" },
      { id: "qwen2.5-coder", label: "Qwen2.5 Coder" },
      { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
      { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B" },
    ],
  },
  {
    // LM Studio's OpenAI-compatible local server (no key). Runs through
    // OpenAIProvider against http://localhost:1234/v1. The model id is whatever
    // you've loaded in LM Studio — pick it with `/model lmstudio/<id>`.
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "openai-compat",
    local: true,
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    docsUrl: "https://lmstudio.ai/docs/app/api",
    models: [],
  },
];

/** Look up a preset by id. */
export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * The auth methods a provider effectively supports, in preference order.
 * Falls back to a sensible default when a preset omits `auth`, so the field is
 * truly optional: local runtimes → `["local"]`, everyone else → `["api_key"]`.
 * Providers that genuinely offer more (OpenRouter/Anthropic OAuth, Copilot
 * device-code, Codex OAuth) declare it explicitly via `preset.auth`.
 *
 * The `env` parameter is retained for signature stability (callers thread it
 * through `getProviderDescriptor`) and future env-gated methods; it is currently
 * unused now that Anthropic OAuth ships enabled rather than flag-gated.
 */
export function effectiveAuthMethods(
  preset: ProviderPreset,
  _env: NodeJS.ProcessEnv = process.env,
): AuthMethod[] {
  if (preset.auth && preset.auth.length) return preset.auth;
  return preset.local ? ["local"] : ["api_key"];
}

/**
 * Coarse capability derivation. Provider-level capabilities are fuzzy (real
 * truth is per-model), so this returns broad strokes for display: everything
 * Berne talks to streams and calls tools; vision/reasoning come from a small
 * known set. A preset may override via `capabilities`.
 */
const VISION_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "google"]);
const REASONING_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "xai",
  "openrouter",
]);

function deriveCapabilities(preset: ProviderPreset): ProviderCapabilities {
  if (preset.capabilities) return preset.capabilities;
  return {
    streaming: true,
    toolCalling: true,
    vision: VISION_PROVIDERS.has(preset.id),
    reasoning: REASONING_PROVIDERS.has(preset.id),
  };
}

/**
 * The subscription/account a provider's non-API-key login uses, for the picker.
 * Undefined for providers whose only "account" login is a plain OAuth key mint
 * (OpenRouter) or that have no account login at all.
 */
export function accountLoginLabel(providerId: string): string | undefined {
  switch (providerId) {
    case "anthropic":
      return "Claude Pro/Max subscription";
    case "codex":
      return "ChatGPT Plus/Pro subscription";
    case "copilot":
      return "GitHub Copilot subscription";
    case "openrouter":
      return "OpenRouter account";
    default:
      return undefined;
  }
}

/** Friendly, pi-style label for an auth method in the `berne login` picker. */
export function authMethodLabel(method: AuthMethod, providerId?: string): string {
  switch (method) {
    case "oauth":
    case "device": {
      const acct = providerId ? accountLoginLabel(providerId) : undefined;
      return acct ? `Sign in with your ${acct}` : "Sign in with an account";
    }
    case "api_key":
      return "Sign in with an API key";
    case "local":
      return "Connect to a local endpoint";
  }
}

/** A provider's public description: identity, auth methods, capabilities, models. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: ProviderKind;
  local: boolean;
  auth: AuthMethod[];
  capabilities: ProviderCapabilities;
  defaultModel: string;
  models: { id: string; label: string }[];
  docsUrl: string;
}

/**
 * The single accessor the auth layer and CLI read to learn what a provider is
 * and how it can authenticate — derived from the preset (+ the anthropic flag),
 * never mutated. Returns undefined for unknown ids.
 */
export function getProviderDescriptor(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderDescriptor | undefined {
  const preset = getPreset(id);
  if (!preset) return undefined;
  return {
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    local: !!preset.local,
    auth: effectiveAuthMethods(preset, env),
    capabilities: deriveCapabilities(preset),
    defaultModel: preset.defaultModel,
    models: preset.models ?? [],
    docsUrl: preset.docsUrl,
  };
}
