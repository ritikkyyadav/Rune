/**
 * Which provider and model a new process opens on.
 *
 * This used to live inline in `bin/rune-cli.ts`, where it grew the same rot
 * twice: a hand-written list of the six provider ids the CLI happened to know
 * (`isCliProvider`) gated BOTH the sticky pick and the config pick. The sticky
 * half was fixed when a saved `codex` model kept opening on gemini; the config
 * half was not, so `[llm] defaultProvider = "custom"` — everything the six-step
 * setup wizard writes — fell straight through to auto-detect, and the wizard's
 * "restart required" promise was false. The roster is thirty-odd hosts; any
 * list that names a few of them by hand is a defect waiting for the next one.
 *
 * So the rule here is asked of the registry and the credential store, never of
 * a literal: a saved provider is honoured when it is `custom` with a usable
 * endpoint, a local runtime, or ANY preset that has a credential (keychain,
 * env var, `[llm.<id>].apiKey`, or a `/keys` secret).
 *
 * Precedence, unchanged: CLI flags → the sticky `/model` pick → config.toml →
 * auto-detect. Pure and injectable so every rung of that ladder is unit-tested.
 */

import { AUTO_PROVIDER_PRIORITY, CUSTOM_PROVIDER_ID } from "@rune/shared";

/** The provider ids the CLI carries built-in defaults for. */
export type CliProvider =
  "anthropic" | "openai" | "openrouter" | "google" | "ollama-turbo" | "ollama";

export const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  // qwen/qwen3-coder:free and qwen3-coder:480b were retired 2026-07-15, and
  // deepseek-v4-flash:free was withdrawn from the free tier 2026-08-26;
  // these mirror the gateway's refreshed, live-verified defaults.
  openrouter: "minimax/minimax-m3:free",
  google: "gemini-2.5-flash",
  "ollama-turbo": "gpt-oss:120b",
  ollama: "llama3.1",
};

/** Local runtimes that need no API key — reached by base URL on this machine. */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export function isCliProvider(provider: string): provider is CliProvider {
  return (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "google" ||
    provider === "ollama-turbo" ||
    provider === "ollama"
  );
}

/**
 * Env vars for the built-in ids. Every other provider's env var comes from its
 * preset (`preset.envVar`), which is the only place it is written down once.
 * ollama-turbo carries no `[llm.*]` section — its key lives in secrets.json /
 * OLLAMA_API_KEY.
 */
const PROVIDER_ENV_VAR: Partial<Record<CliProvider, string>> = {
  google: "GOOGLE_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "ollama-turbo": "OLLAMA_API_KEY",
};

/** The fields this module reads from a `[llm.<id>]` section. */
export interface LlmSectionView {
  model?: string;
  apiKey?: string;
}

/** The fields this module reads from a preset. */
export interface PresetView {
  defaultModel?: string;
  envVar?: string;
  local?: boolean;
}

/** The fields this module reads from config.toml. */
export interface StartupConfigView {
  llm: { defaultProvider?: string } & Record<string, unknown>;
}

/** The fields this module reads from secrets.json. */
export interface StartupSecretsView {
  keys?: Record<string, string>;
  custom?: { baseUrl?: string; model?: string; key?: string };
}

export interface StartupSelectionInput {
  /** `--provider` for this run. */
  cliProvider?: string;
  /** `--model` for this run. */
  cliModel?: string;
  config: StartupConfigView;
  secrets: StartupSecretsView;
  /** The last provider+model the user actually used (`/model`, persisted). */
  lastUsed?: { provider: string; model: string } | null;
  env?: Record<string, string | undefined>;
  /** Keychain / OAuth store lookup (id → does a credential exist). */
  hasStoredCredential: (id: string) => boolean;
  /** Registry lookup (id → preset, or undefined when the id is unknown). */
  getPreset: (id: string) => PresetView | undefined;
}

export interface StartupSelection {
  provider: string;
  model: string;
  /** Which rung of the ladder answered — for `/setup`'s SAVED vs ACTIVE and for tests. */
  source: "flag" | "sticky" | "config" | "auto";
}

/** Context enough to name a provider's model without re-deriving the whole selection. */
export interface ModelResolutionContext {
  config: StartupConfigView;
  secrets: StartupSecretsView;
  getPreset: (id: string) => PresetView | undefined;
  /** `--model`, when this run named one. */
  cliModel?: string;
}

function sectionFor(config: StartupConfigView, provider: string): LlmSectionView | undefined {
  const section = config.llm?.[provider as keyof typeof config.llm];
  return section && typeof section === "object" ? (section as LlmSectionView) : undefined;
}

/**
 * The model a provider opens on: `--model`, else its `[llm.<id>] model`, else
 * the CLI's built-in default, else the preset's, else the custom endpoint's.
 *
 * Reading `[llm.<id>] model` for ANY id (not just the six) is what makes the
 * wizard's `[llm.custom] model = "mock-small"` survive a restart.
 */
export function modelForProvider(provider: string, ctx: ModelResolutionContext): string {
  return (
    ctx.cliModel ??
    sectionFor(ctx.config, provider)?.model ??
    (isCliProvider(provider) ? DEFAULT_MODELS[provider] : undefined) ??
    ctx.getPreset(provider)?.defaultModel ??
    (provider === CUSTOM_PROVIDER_ID ? ctx.secrets.custom?.model : undefined) ??
    ""
  );
}

export function resolveStartupSelection(input: StartupSelectionInput): StartupSelection {
  const env = input.env ?? {};
  const { config, secrets, getPreset, hasStoredCredential } = input;
  const modelCtx: ModelResolutionContext = {
    config,
    secrets,
    getPreset,
    cliModel: input.cliModel,
  };

  /** A working key from any of the legacy, non-keychain sources. */
  const hasCreds = (p: string): boolean => {
    // Local runtimes are keyless — always "available"; reachability of the
    // localhost server is surfaced at call time, not gated here.
    if (LOCAL_PROVIDERS.has(p) || getPreset(p)?.local) return true;
    const envVar = PROVIDER_ENV_VAR[p as CliProvider] ?? getPreset(p)?.envVar;
    return !!(envVar && env[envVar]) || !!sectionFor(config, p)?.apiKey || !!secrets.keys?.[p];
  };

  // `custom` has no preset by design — it IS the escape hatch for a provider
  // the catalogue does not know — so the preset gate would reject it forever.
  const customUsable = !!(
    secrets.custom?.baseUrl &&
    (secrets.custom?.key || hasStoredCredential(CUSTOM_PROVIDER_ID))
  );

  // Unchanged sticky semantics (see the note in rune-cli's git history): the
  // model you last used IS the model you get, as long as it can still be paid for.
  const stickyUsable = (p: string): boolean =>
    p === CUSTOM_PROVIDER_ID
      ? customUsable
      : getPreset(p) !== undefined &&
        (LOCAL_PROVIDERS.has(p) || hasStoredCredential(p) || (isCliProvider(p) && hasCreds(p)));

  /**
   * A SAVED provider is usable when it is reachable at all: the custom
   * endpoint, a local runtime, or any preset with a credential from any store.
   * Deliberately wider than `stickyUsable` — this is the rot the config path had.
   */
  const configUsable = (p: string): boolean =>
    p === CUSTOM_PROVIDER_ID
      ? customUsable
      : getPreset(p) !== undefined && (hasStoredCredential(p) || hasCreds(p));

  /** Last resort: the best-funded key on this machine. */
  const detectBestProvider = (): CliProvider => {
    for (const provider of AUTO_PROVIDER_PRIORITY) {
      const envVar = PROVIDER_ENV_VAR[provider];
      if ((envVar && env[envVar]) || sectionFor(config, provider)?.apiKey) return provider;
    }
    // Keyed hosts without an [llm.*] config section: a saved /keys secret (or
    // env var) is a working credential too. Without this, a user whose ONLY
    // key was ollama-turbo auto-detected into a keyless openrouter boot.
    if (env.OLLAMA_API_KEY || secrets.keys?.["ollama-turbo"]) return "ollama-turbo";
    return "openrouter"; // last resort
  };

  const cliProvider = input.cliProvider?.trim() || undefined;
  // `--provider` names ANY preset, not only the six the CLI knew by hand.
  if (
    cliProvider &&
    (isCliProvider(cliProvider) || getPreset(cliProvider) || cliProvider === CUSTOM_PROVIDER_ID)
  ) {
    return {
      provider: cliProvider,
      model: modelForProvider(cliProvider, modelCtx),
      source: "flag",
    };
  }

  // An explicit --provider/--model is this run's instruction; the sticky pick
  // loses only to that.
  const lastUsed = cliProvider || input.cliModel ? null : (input.lastUsed ?? null);
  if (lastUsed && stickyUsable(lastUsed.provider)) {
    return { provider: lastUsed.provider, model: lastUsed.model, source: "sticky" };
  }

  const configProvider = config.llm?.defaultProvider;
  if (configProvider && configUsable(configProvider)) {
    return {
      provider: configProvider,
      model: modelForProvider(configProvider, modelCtx),
      source: "config",
    };
  }

  const detected = detectBestProvider();
  return { provider: detected, model: modelForProvider(detected, modelCtx), source: "auto" };
}
