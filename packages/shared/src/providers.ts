// ─── Provider presets ───
// The single source of truth for which LLM providers Gear can talk to and how to
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
// set; `@gear/llm-gateway`'s auth layer re-exports it so the strategy code and the
// preset metadata never drift. Adding a method here is the first step to teaching
// Gear a new way to sign in — the rest of the system asks for an *authenticated*
// provider and never learns which of these produced it.
//
//   api_key  — a bearer secret pasted/env-supplied (today's only path).
//   oauth    — browser authorization-code + PKCE (loopback redirect).
//   device   — OAuth device-code (headless / SSH-friendly, no local browser).
//   local    — a localhost runtime reached by URL; connectivity, no credential.
export type AuthMethod = "api_key" | "oauth" | "device" | "local";

/**
 * Automatic startup order when several cloud credentials are available.
 * Direct Anthropic/OpenAI credentials normally represent funded capacity, so
 * they outrank quota-constrained developer/free endpoints. Explicit CLI,
 * config, and sticky model choices still win before this list is consulted.
 */
export const AUTO_PROVIDER_PRIORITY = ["anthropic", "openai", "google", "openrouter"] as const;

/**
 * How much capacity a provider represents — the axis the gateway descends when
 * the active provider dies MID-TASK.
 *
 * This is deliberately NOT `AUTO_PROVIDER_PRIORITY`, which answers a different
 * question: "which keyed provider should this session boot into?" That list is
 * env-var-shaped (its element type keys a `Record<…, string>` of env var names
 * in gear-cli), so the OAuth-only transports — codex, copilot — can never
 * appear in it, and they are precisely the ones a fallback has to reason about.
 *
 * The classes carry the same principle its doc states, generalized:
 *
 *   funded       — a direct API key you top up. Falling here costs money, not
 *                  capability, and it is the smallest possible drop.
 *   subscription — a plan seat with a hard periodic cap (ChatGPT/Copilot).
 *                  Strong models, but the cap is exactly why we are here.
 *   free         — quota-constrained free tiers. Cheap and weak, and they rot:
 *                  ids retire without notice and balances hit 402 mid-run.
 *   local        — a localhost runtime. It never 429s, but its default is an
 *                  8k-window model, so handing it a long agentic transcript
 *                  produces immediate context overflow. Availability does not
 *                  help when the work cannot fit; this is the last resort.
 *
 * Ranking by CAPACITY rather than by model strength is the durable choice:
 * capacity is a structural fact about the account, while model ids rot (see the
 * retirement graveyard in PROVIDER_TIER_DEFAULTS and PROVIDER_DEFAULT_MODELS).
 */
export type ProviderCapacity = "funded" | "subscription" | "free" | "local";

/** Descending preference. Index = rank; lower is tried first. */
export const FALLBACK_CAPACITY_ORDER: readonly ProviderCapacity[] = [
  "funded",
  "subscription",
  "free",
  "local",
];

export const PROVIDER_CAPACITY: Record<string, ProviderCapacity> = {
  anthropic: "funded",
  openai: "funded",
  google: "funded",
  groq: "funded",
  xai: "funded",
  deepseek: "funded",
  // A user-supplied OpenAI-compatible endpoint: they chose and pay for it, so
  // it is treated as funded capacity rather than guessed at.
  custom: "funded",
  codex: "subscription",
  copilot: "subscription",
  openrouter: "free",
  "ollama-turbo": "free",
  ollama: "local",
  lmstudio: "local",
};

/**
 * Fallback rank for a provider id — lower is preferred. An id absent from the
 * table ranks as "free": pessimistic on purpose, so a provider added to the
 * presets without a capacity entry can never silently outrank a funded one.
 */
export function providerFallbackRank(id: string): number {
  const capacity = PROVIDER_CAPACITY[id] ?? "free";
  return FALLBACK_CAPACITY_ORDER.indexOf(capacity);
}

/** What a plan/quota cap does to a run. See GatewayConfig.quotaPolicy. */
export type QuotaPolicy = "stop" | "degrade";

/**
 * Read `[fallback] onQuotaExceeded`. Anything unrecognized — including a typo —
 * resolves to "stop", the safe direction: the cost of stopping when the user
 * meant to degrade is one message and a `/model` switch, while the cost of
 * degrading when they meant to stop is a long task silently finished by a
 * weaker model.
 */
export function normalizeQuotaPolicy(value: unknown): QuotaPolicy {
  return value === "degrade" ? "degrade" : "stop";
}

/** Whether mid-task inference may move to a different provider/model. */
export type ModelIntegrity = "pin" | "flex";

/**
 * Read `[fallback] modelIntegrity`. Anything unrecognized resolves to "pin",
 * the safe direction: the model that started a task finishes it. A cooling or
 * capped provider WAITS (and self-heals the moment the limit lifts) instead of
 * handing the work to whatever registered next — a weaker model quietly
 * inheriting a frontier model's task poisons the work in a way no banner
 * undoes. "flex" restores the substitute chain for lineups where a degraded
 * answer genuinely beats a dead run.
 */
export function normalizeModelIntegrity(value: unknown): ModelIntegrity {
  return value === "flex" ? "flex" : "pin";
}

/**
 * Validate a user-written `[fallback] order` list: keep the known provider ids,
 * in order, without duplicates, and report the rest.
 *
 * The unknown ids come back rather than being dropped on the floor: a typo'd
 * provider name in config.toml silently doing nothing is the failure mode that
 * makes people distrust the knob. One place does this so the CLI and the
 * desktop host cannot drift into two different notions of a valid list.
 */
export function normalizeFallbackOrder(order: readonly unknown[] | undefined): {
  order: string[];
  unknown: string[];
} {
  const kept: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of order ?? []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id in PROVIDER_CAPACITY) kept.push(id);
    else unknown.push(id);
  }
  return { order: kept, unknown };
}

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
    defaultModel: "claude-opus-5",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    // Two ways in: sign in with a Claude Pro/Max *subscription* (OAuth → a
    // refreshable bearer token spent against your plan), or paste an API key.
    // OAuth is preferred in the picker; the API key stays the fallback and the
    // env/console path is byte-identical to before for existing key users.
    auth: ["oauth", "api_key"],
    // Fable 5 is listed but is NOT the default: it is unavailable under zero
    // data retention, and Gear's compliance-sensitive users are exactly the
    // ones who run ZDR. Opting in is a choice they should make knowingly.
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
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
    defaultModel: "minimax/minimax-m3:free",
    docsUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    // OpenRouter documents a PKCE OAuth flow that mints a normal API key —
    // Gear's fully-working OAuth reference. API key stays the fallback.
    auth: ["oauth", "api_key"],
    // Free-tier churn is brutal here (qwen3-coder:free retired, the deepseek
    // :free variants withdrawn to paid). Every id below completed a live call
    // on 2026-08-26. Stealth models are ephemeral by nature — keep ox-alpha
    // while it lasts, but never make it the default.
    models: [
      { id: "minimax/minimax-m3:free", label: "MiniMax M3 (free)" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)" },
      { id: "stealth/ox-alpha", label: "Ox Alpha (free)" },
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
    // The three current Codex models, and only those. gpt-5.5 is gone from the
    // picker: it is the previous frontier, it 400s on some Plus tiers, and a
    // fourth row that may not work is clutter in the one list a person reads
    // while deciding. Depth is a SEPARATE choice now (see effortChoices) —
    // sol/terra/luna are model weights, not effort levels.
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (flagship)" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fast)" },
    ],
  },
  {
    // GitHub Copilot subscription. Signs in with GitHub's device flow (no API
    // key); the CopilotProvider mints short-lived Copilot tokens from the GitHub
    // token and talks to api.githubcopilot.com (OpenAI-compatible). Model ids are
    // Copilot's own catalog (plan-dependent) — pick with `/model copilot/<id>`,
    // or list live with `gear models copilot`.
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
    defaultModel: "gpt-oss:120b",
    docsUrl: "https://ollama.com/settings/keys",
    // Verified 2026-08-26 on the default (no-subscription) Ollama Cloud plan:
    // every id below returned 200 AND completed a tool call. The whole qwen3
    // lineup this list used to carry (qwen3-coder:480b, qwen3-coder-next,
    // qwen3-next:80b) was retired 2026-07-15 wholesale. Subscription-gated
    // models (qwen3.5, kimi-k2.x/k3, deepseek-v4-*, glm-5.x, minimax-m2.7,
    // mistral-large-3) are intentionally omitted — they 403 and would trip
    // silent provider fallback.
    models: [
      { id: "gpt-oss:120b", label: "GPT-OSS 120B" },
      { id: "gpt-oss:20b", label: "GPT-OSS 20B" },
      { id: "minimax-m3", label: "MiniMax M3" },
      { id: "nemotron-3-ultra", label: "Nemotron 3 Ultra" },
      { id: "nemotron-3-super", label: "Nemotron 3 Super" },
      { id: "nemotron-3-nano:30b", label: "Nemotron 3 Nano 30B" },
      { id: "gemma4:31b", label: "Gemma 4 31B" },
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
 * Gear talks to streams and calls tools; vision/reasoning come from a small
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

/** Friendly, pi-style label for an auth method in the `gear login` picker. */
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
