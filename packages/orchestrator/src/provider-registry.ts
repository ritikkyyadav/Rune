// ─── Provider registry ───
// Pure helpers that turn a set of API keys into a configured LlmGateway. Kept
// separate from the Engine so the "which keys → which providers" logic can be
// unit-tested without standing up a session DB, and so the constructor and
// runtime key edits share exactly one registration path.

import {
  LlmGateway,
  AnthropicProvider,
  OpenAIProvider,
  OpenRouterProvider,
  GoogleProvider,
  OllamaProvider,
} from "@alan/llm-gateway";
import type { ProviderName } from "@alan/llm-gateway";
import { PROVIDER_PRESETS, CUSTOM_PROVIDER_ID, maskKey } from "@alan/shared";
import type { CustomEndpoint } from "@alan/shared";

export interface BuildGatewayOpts {
  /** Active/default provider for the gateway. */
  provider: ProviderName;
  /** Saved keys by provider id (config + secrets + runtime, already merged). */
  keys: Record<string, string>;
  /** User-defined OpenAI-compatible endpoint, if any. */
  customEndpoint?: CustomEndpoint;
  /** Provider ids toggled off — registered providers skip these. */
  disabled?: Set<string>;
  ollamaBaseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a provider's usable key: an explicitly saved key wins, otherwise the
 * provider's env var. Returns undefined when neither is present.
 */
function resolveKey(
  id: string,
  envVar: string | undefined,
  keys: Record<string, string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return keys[id] || (envVar ? env[envVar] || undefined : undefined);
}

/** Build a gateway with every provider that has a usable key registered. */
export function buildGateway(opts: BuildGatewayOpts): LlmGateway {
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? new Set<string>();
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: opts.provider,
    maxRetries: opts.maxRetries ?? 3,
    retryBaseMs: opts.retryBaseMs ?? 1000,
  });

  for (const preset of PROVIDER_PRESETS) {
    if (disabled.has(preset.id)) continue;
    const key = resolveKey(preset.id, preset.envVar, opts.keys, env);
    if (!key) continue;
    switch (preset.kind) {
      case "anthropic":
        gw.registerProvider(new AnthropicProvider(key));
        break;
      case "google":
        gw.registerProvider(new GoogleProvider(key));
        break;
      case "openai-compat":
        // OpenRouter keeps its bespoke adapter (custom health check); every
        // other OpenAI-compatible host runs through OpenAIProvider + base URL.
        if (preset.id === "openrouter") gw.registerProvider(new OpenRouterProvider(key));
        else gw.registerProvider(new OpenAIProvider(key, preset.baseUrl, preset.id as ProviderName));
        break;
    }
  }

  // User-defined custom OpenAI-compatible endpoint.
  const c = opts.customEndpoint;
  if (c?.key && c.baseUrl && !disabled.has(CUSTOM_PROVIDER_ID)) {
    gw.registerProvider(new OpenAIProvider(c.key, c.baseUrl, CUSTOM_PROVIDER_ID as ProviderName));
  }

  // Local Ollama: only when explicitly selected, so cloud sessions never
  // accidentally fall back to a local server.
  if (opts.provider === "ollama" || opts.ollamaBaseUrl || env.OLLAMA_HOST) {
    gw.registerProvider(new OllamaProvider(opts.ollamaBaseUrl));
  }

  return gw;
}

export interface ProviderStatusRow {
  id: string;
  label: string;
  hasKey: boolean;
  /** "saved" = entered/configured, "env" = from an env var, "none" = no key. */
  source: "saved" | "env" | "none";
  /** Masked key for display (never the raw secret). */
  masked: string;
  disabled: boolean;
  active: boolean;
}

export interface ProviderStatusOpts {
  keys: Record<string, string>;
  customEndpoint?: CustomEndpoint;
  disabled?: Set<string>;
  active: string;
  env?: NodeJS.ProcessEnv;
}

/** Per-provider status for the keys panel / `/providers`. Reveals no raw keys. */
export function providerStatus(opts: ProviderStatusOpts): ProviderStatusRow[] {
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? new Set<string>();

  const rows: ProviderStatusRow[] = PROVIDER_PRESETS.map((p) => {
    const saved = opts.keys[p.id];
    const envKey = !saved && p.envVar ? env[p.envVar] : undefined;
    const source: ProviderStatusRow["source"] = saved ? "saved" : envKey ? "env" : "none";
    return {
      id: p.id,
      label: p.label,
      hasKey: !!(saved || envKey),
      source,
      masked: saved ? maskKey(saved) : envKey ? maskKey(envKey) : "",
      disabled: disabled.has(p.id),
      active: p.id === opts.active,
    };
  });

  const c = opts.customEndpoint;
  rows.push({
    id: CUSTOM_PROVIDER_ID,
    label: c?.label || "Custom endpoint",
    hasKey: !!c?.key,
    source: c?.key ? "saved" : "none",
    masked: c?.key ? maskKey(c.key) : "",
    disabled: disabled.has(CUSTOM_PROVIDER_ID),
    active: opts.active === CUSTOM_PROVIDER_ID,
  });

  return rows;
}
