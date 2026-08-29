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
  CopilotProvider,
  CodexProvider,
  getStrategy,
} from "@gear/llm-gateway";
import type {
  GatewayIncidentEvent,
  ProviderName,
  ResolvedCredential,
  AuthContext,
  AuthMethod,
} from "@gear/llm-gateway";
import { PROVIDER_PRESETS, CUSTOM_PROVIDER_ID, maskKey, effectiveAuthMethods } from "@gear/shared";
import type { CustomEndpoint, CredentialStore, StoredKey } from "@gear/shared";

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
  /**
   * `[fallback] order` from config.toml — the head of the provider chain the
   * gateway walks when the active provider fails mid-task. Unset means the
   * built-in capacity ranking decides.
   */
  fallbackOrder?: ProviderName[];
  /** `[fallback] onQuotaExceeded` — stop the run on a plan cap, or degrade. */
  quotaPolicy?: "stop" | "degrade";
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Black-box tap forwarded into the gateway (survives gateway rebuilds). */
  onIncident?: (incident: GatewayIncidentEvent) => void;
  /**
   * BYOP: pre-resolved credentials by provider id (from the auth layer —
   * keychain keys, OAuth bearer tokens, …). When a provider has an entry with a
   * secret it wins over `resolveKey`; when ABSENT (the default), each provider
   * falls back to today's exact env/saved-key resolution — so a gateway built
   * without this map is byte-identical to before BYOP.
   */
  credentials?: Record<string, ResolvedCredential>;
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
    fallbackOrder: opts.fallbackOrder,
    quotaPolicy: opts.quotaPolicy,
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

    // BYOP: a pre-resolved credential (keychain / OAuth) wins; otherwise fall
    // back to today's exact env/saved-key resolution. `?? resolveKey(...)` means
    // an absent credential map reproduces the legacy path exactly.
    const cred = opts.credentials?.[preset.id];
    const key = cred?.secret ?? resolveKey(preset.id, preset.envVar, opts.keys, env);
    if (!key) continue;
    // A subscription bearer token (Claude Pro/Max OAuth) authenticates differently
    // from an API key — flag it so the transport uses Bearer + first-party headers.
    const oauth = cred?.kind === "bearer";
    switch (preset.kind) {
      case "anthropic":
        gw.registerProvider(new AnthropicProvider(key, undefined, { oauth }));
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
      case "copilot":
        // `key` is the durable GitHub OAuth token; CopilotProvider mints and
        // rotates the short-lived Copilot API token from it internally.
        gw.registerProvider(new CopilotProvider(key));
        break;
      case "codex":
        // `key` is the ChatGPT access token; the account id (from the id_token,
        // parsed at login) rides in the credential meta for the required header.
        gw.registerProvider(new CodexProvider(key, cred?.meta?.accountId));
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

export interface ResolveCredentialsOpts {
  /** The secure credential store (keychain / secret-service / file fallback). */
  store: CredentialStore;
  /** Merged config+secrets saved keys by provider id (the middle precedence rung). */
  keys: Record<string, string>;
  /** Active provider (unused for resolution today; kept for parity with build opts). */
  active: ProviderName;
  /** Provider ids toggled off — skipped, exactly like buildGateway. */
  disabled?: Set<string>;
  /** Base URLs for local runtimes by id (unused here; local resolves in buildGateway). */
  localBaseUrls?: Record<string, string>;
  /** Per-provider auth method override from config.llm.<id>.authentication. */
  authOverrides?: Record<string, AuthMethod>;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The non-interactive boot resolver: turn stored credentials (keychain + OAuth)
 * and the legacy key sources into a credential map for `buildGateway`. Runs ONCE
 * at boot and on login events — never per gateway rebuild — so the hot path stays
 * synchronous. Local runtimes are intentionally skipped: they register keylessly
 * in buildGateway, unchanged. For a KEYED provider whose only sources are
 * env/secrets (empty secure store), the resolved secret equals `resolveKey`'s —
 * making the credential-map path byte-identical to the legacy path.
 */
export async function resolveProviderCredentials(
  opts: ResolveCredentialsOpts,
): Promise<Record<string, ResolvedCredential>> {
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? new Set<string>();
  const localBaseUrls = opts.localBaseUrls ?? {};
  const out: Record<string, ResolvedCredential> = {};

  for (const preset of PROVIDER_PRESETS) {
    if (preset.local) continue; // keyless local registration lives in buildGateway
    if (disabled.has(preset.id)) continue;

    const ctx: AuthContext = {
      providerId: preset.id,
      preset,
      store: opts.store,
      env,
      savedKey: opts.keys[preset.id],
      baseUrl: localBaseUrls[preset.id] ?? preset.baseUrl,
    };

    const override = opts.authOverrides?.[preset.id];
    const candidates = override ? [override] : effectiveAuthMethods(preset, env);
    for (const method of candidates) {
      const strategy = getStrategy(method, preset.id);
      if (!strategy) continue; // provider doesn't support this method → try next
      let cred: ResolvedCredential | null = null;
      try {
        cred = await strategy.loadCredentials(ctx);
      } catch {
        cred = null; // resolution must never break startup
      }
      if (cred) {
        out[preset.id] = cred;
        break;
      }
    }
  }
  return out;
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

/** One stored key as the panel shows it: masked, dated, never the raw secret. */
export interface StoredKeyView {
  /** Entry id (to select/remove it). */
  id: string;
  /** Masked key for display. */
  masked: string;
  /** Optional user label (account name). */
  label?: string;
  /** ISO add-date, or undefined for pre-multi-key keys. */
  addedAt?: string;
  /** The active key of the pool — the one the gateway uses. */
  active: boolean;
}

export interface ProviderStatusRow {
  id: string;
  label: string;
  hasKey: boolean;
  /**
   * How many keys are stored for this provider. 0 = none; 1 = a single key
   * (saved/env/config); >1 = a multi-account pool. Only saved (secrets) keys can
   * exceed 1 — env/config keys are always a single value.
   */
  keyCount: number;
  /**
   * The stored keys, masked and dated, when this provider has a saved pool. Empty
   * for env/config/none (nothing to manage there). This is what the per-provider
   * key manager lists.
   */
  savedKeys: StoredKeyView[];
  /**
   * Where the credential actually in use comes from: "keychain"/"oauth" = the
   * BYOP secure store, "saved" = secrets.json/config, "env" = an env var,
   * "none" = no credential. Reflects what the gateway will really use, not just
   * the legacy key sources.
   */
  source: "keychain" | "oauth" | "saved" | "env" | "none";
  /** The auth method in effect (api_key / oauth / device / local), when known. */
  authMethod?: AuthMethod;
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
  /** Multi-account key pools by provider id (from secrets.json). */
  keyEntries?: Record<string, StoredKey[]>;
  /** Active entry id per provider (which pool key the gateway uses). */
  activeKeyId?: Record<string, string>;
  customEndpoint?: CustomEndpoint;
  disabled?: Set<string>;
  active: string;
  /** Base URLs for local runtimes by id (overrides preset defaults). */
  localBaseUrls?: Record<string, string>;
  /**
   * BYOP: the credentials the engine actually resolved (keychain keys, OAuth
   * tokens). When a provider has one here, its row reflects that source/method
   * instead of the raw env/secrets view — so the panel never lies about which
   * credential is in use.
   */
  credentials?: Record<string, ResolvedCredential>;
  env?: NodeJS.ProcessEnv;
}

/** Mask a provider's key pool for display; marks which entry is active. */
function keyViews(entries: StoredKey[] | undefined, activeId: string | undefined): StoredKeyView[] {
  if (!entries || !entries.length) return [];
  const activeEntryId =
    activeId && entries.some((e) => e.id === activeId) ? activeId : entries[0]!.id;
  return entries.map((e) => ({
    id: e.id,
    masked: maskKey(e.key),
    ...(e.label ? { label: e.label } : {}),
    ...(e.addedAt ? { addedAt: e.addedAt } : {}),
    active: e.id === activeEntryId,
  }));
}

/** Per-provider status for the keys panel / `/providers`. Reveals no raw keys. */
export function providerStatus(opts: ProviderStatusOpts): ProviderStatusRow[] {
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? new Set<string>();
  const localBaseUrls = opts.localBaseUrls ?? {};
  const keyEntries = opts.keyEntries ?? {};

  const rows: ProviderStatusRow[] = PROVIDER_PRESETS.map((p) => {
    // The saved multi-account pool (if any) drives count + the manager list. It's
    // the same across the source branches below, so compute it once.
    const pool = keyViews(keyEntries[p.id], opts.activeKeyId?.[p.id]);

    if (p.local) {
      // Local runtimes need no key; they're "usable" when a URL is configured or
      // they're the active provider (which registers them on demand).
      const endpoint = localBaseUrls[p.id] ?? p.baseUrl ?? "";
      const configured = !!localBaseUrls[p.id] || p.id === opts.active;
      return {
        id: p.id,
        label: p.label,
        hasKey: configured,
        keyCount: 0,
        savedKeys: [],
        source: "none" as const,
        masked: "",
        disabled: disabled.has(p.id),
        active: p.id === opts.active,
        local: true,
        endpoint,
      };
    }
    // A BYOP-resolved credential (keychain / OAuth) is what the gateway actually
    // uses — it wins the display over the raw env/secrets view.
    const cred = opts.credentials?.[p.id];
    if (cred?.secret) {
      const method = (cred.meta?.method as AuthMethod | undefined) ?? "api_key";
      const credSource: ProviderStatusRow["source"] =
        method === "oauth"
          ? "oauth"
          : cred.meta?.source === "keychain"
            ? "keychain"
            : cred.meta?.source === "env"
              ? "env"
              : "saved";
      return {
        id: p.id,
        label: p.label,
        hasKey: true,
        keyCount: pool.length || 1,
        savedKeys: pool,
        source: credSource,
        authMethod: method,
        masked: maskKey(cred.secret),
        disabled: disabled.has(p.id),
        active: p.id === opts.active,
      };
    }
    const saved = opts.keys[p.id];
    const envKey = !saved && p.envVar ? env[p.envVar] : undefined;
    const source: ProviderStatusRow["source"] = saved ? "saved" : envKey ? "env" : "none";
    return {
      id: p.id,
      label: p.label,
      hasKey: !!(saved || envKey),
      // A saved key always has at least one pool entry (the pool view synthesizes
      // a single from the legacy key); env/none get 1/0 with nothing to manage.
      keyCount: pool.length || (saved ? 1 : envKey ? 1 : 0),
      savedKeys: source === "saved" ? pool : [],
      source,
      authMethod: saved || envKey ? "api_key" : undefined,
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
    keyCount: c?.key ? 1 : 0,
    savedKeys: [],
    source: c?.key ? "saved" : "none",
    masked: c?.key ? maskKey(c.key) : "",
    disabled: disabled.has(CUSTOM_PROVIDER_ID),
    active: opts.active === CUSTOM_PROVIDER_ID,
  });

  return rows;
}
