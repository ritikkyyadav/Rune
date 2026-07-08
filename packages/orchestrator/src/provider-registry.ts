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
import type { GatewayIncidentEvent, ProviderName } from "@alan/llm-gateway";
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
  /** Base URLs for local runtimes (ollama / lmstudio) by id; overrides preset defaults. */
  localBaseUrls?: Record<string, string>;
  /** Back-compat: explicit local Ollama base URL (folded into localBaseUrls.ollama). */
  ollamaBaseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Black-box tap forwarded into the gateway (survives gateway rebuilds). */
  onIncident?: (incident: GatewayIncidentEvent) => void;
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
    onIncident: opts.onIncident,
  });

  const localBaseUrls = mergeLocalBaseUrls(opts);

  for (const preset of PROVIDER_PRESETS) {
    if (disabled.has(preset.id)) continue;

    // Local runtimes (ollama / lmstudio) need no API key. Register them opt-in:
    // only when they're the active provider or the user has configured a base URL
    // (in /keys or config), so a cloud session never silently falls back to a
    // (likely-not-running) localhost server.
    if (preset.local) {
      const configured = !!localBaseUrls[preset.id];
      if (!configured && opts.provider !== preset.id) continue;
      const baseUrl = localBaseUrls[preset.id] ?? preset.baseUrl;
      if (preset.kind === "ollama") gw.registerProvider(new OllamaProvider(baseUrl));
      else gw.registerProvider(new OpenAIProvider(undefined, baseUrl, preset.id as ProviderName));
      continue;
    }

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
        else
          gw.registerProvider(new OpenAIProvider(key, preset.baseUrl, preset.id as ProviderName));
        break;
      case "ollama":
        break; // only reached for local presets, handled above
    }
  }

  // User-defined custom OpenAI-compatible endpoint.
  const c = opts.customEndpoint;
  if (c?.key && c.baseUrl && !disabled.has(CUSTOM_PROVIDER_ID)) {
    gw.registerProvider(new OpenAIProvider(c.key, c.baseUrl, CUSTOM_PROVIDER_ID as ProviderName));
  }

  return gw;
}

/**
 * Resolve effective local base URLs: explicit `localBaseUrls`, the back-compat
 * `ollamaBaseUrl`, and the `OLLAMA_HOST` env var (for the ollama runtime).
 * Anything present here marks a local runtime as "configured" → registered.
 */
function mergeLocalBaseUrls(opts: BuildGatewayOpts): Record<string, string> {
  const env = opts.env ?? process.env;
  const merged: Record<string, string> = { ...(opts.localBaseUrls ?? {}) };
  if (!merged.ollama && opts.ollamaBaseUrl) merged.ollama = opts.ollamaBaseUrl;
  if (!merged.ollama && env.OLLAMA_HOST) merged.ollama = env.OLLAMA_HOST;
  return merged;
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
  /** A local runtime (ollama / lmstudio) reached by base URL, no key. */
  local?: boolean;
  /** Resolved base URL for a local runtime (for display / editing). */
  endpoint?: string;
}

export interface ProviderStatusOpts {
  keys: Record<string, string>;
  customEndpoint?: CustomEndpoint;
  disabled?: Set<string>;
  active: string;
  /** Base URLs for local runtimes by id (overrides preset defaults). */
  localBaseUrls?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

/** Per-provider status for the keys panel / `/providers`. Reveals no raw keys. */
export function providerStatus(opts: ProviderStatusOpts): ProviderStatusRow[] {
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? new Set<string>();
  const localBaseUrls = opts.localBaseUrls ?? {};

  const rows: ProviderStatusRow[] = PROVIDER_PRESETS.map((p) => {
    if (p.local) {
      // Local runtimes need no key; they're "usable" when a URL is configured or
      // they're the active provider (which registers them on demand).
      const endpoint = localBaseUrls[p.id] ?? p.baseUrl ?? "";
      const configured = !!localBaseUrls[p.id] || p.id === opts.active;
      return {
        id: p.id,
        label: p.label,
        hasKey: configured,
        source: "none" as const,
        masked: "",
        disabled: disabled.has(p.id),
        active: p.id === opts.active,
        local: true,
        endpoint,
      };
    }
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
