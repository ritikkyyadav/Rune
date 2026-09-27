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

/**
 * The model each built-in provider opens on, when nothing else named one.
 *
 * This table OUTRANKS the preset's `defaultModel` (see `modelForProvider`),
 * which is exactly how it rotted: it went on saying `minimax/minimax-m3:free`
 * for eleven days after that id was withdrawn to paid and started answering
 * 404, because the preset beneath it had already been fixed and nobody looked
 * up. Every entry here must equal its preset's `defaultModel`; the agreement
 * is pinned in tests/unit/shared/provider-tables.test.ts so the two can never
 * drift again.
 */
export const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6-astra",
  openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
  google: "gemini-3.8-flash",
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

/**
 * The registry id a `--provider` value names, or undefined when it names none.
 *
 * Case-insensitive: every id in the registry is lower-case, and a miscased
 * `--provider Anthropic` was silently dropped to the next rung — the run then
 * opened on an auto-detected provider with no message, which is the same shape
 * as the `rune -p` incident (a flag that is read and discarded).
 */
export function resolveProviderId(
  value: string,
  getPreset: (id: string) => PresetView | undefined,
): string | undefined {
  const id = value.trim().toLowerCase();
  if (!id) return undefined;
  if (isCliProvider(id) || id === CUSTOM_PROVIDER_ID || getPreset(id)) return id;
  return undefined;
}

/**
 * The ids closest to what the user typed, for a refusal that is usable.
 *
 * A refusal that only says "unknown" makes the user go and read a catalogue of
 * thirty-odd hosts. Prefix and substring matches first, then a small edit
 * distance, so `anthropic`/`openai` come back for `anthrpic`/`opnai`.
 */
export function nearestProviderIds(value: string, ids: readonly string[], limit = 5): string[] {
  const needle = value.trim().toLowerCase();
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_unused, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(
          row[j]! + 1,
          row[j - 1]! + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        previous = row[j]!;
        row[j] = next;
      }
    }
    return row[b.length]!;
  };
  return [...ids]
    .map((id) => ({
      id,
      rank: id.startsWith(needle) ? -2 : id.includes(needle) ? -1 : distance(needle, id),
    }))
    .filter((row) => row.rank <= Math.max(3, Math.floor(needle.length / 2)))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((row) => row.id);
}

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
  /**
   * The providers the `/keys` panel switched OFF.
   *
   * Holding a key and being usable are different questions, and this module
   * only asked the first one: a provider the user disabled was still selected,
   * the gateway then refused to register it, and the boot printed "<id> has no
   * API key" — a false statement about the user's own key — before
   * substituting `registeredProviders[0]` (V6 finding 14).
   */
  disabled?: string[];
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
  /**
   * A saved or sticky provider id this build's registry no longer knows,
   * present ONLY when one was skipped for that reason.
   *
   * Presets get removed when a vendor retires the product behind them —
   * `github-models` went on 2026-09-16 because GitHub retired GitHub Models on
   * 2026-07-30. The selection already degraded correctly (both `stickyUsable`
   * and `configUsable` require a preset, so an unknown id falls through to
   * auto-detect rather than booting onto a dead host), but it degraded in
   * SILENCE: a user whose `[llm] defaultProvider` named it would find
   * themselves on some other provider with no explanation. This field is what
   * lets the boot say one line about it.
   */
  unknownSaved?: string;
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
  /**
   * A runtime that answers on this machine and asks for no key.
   *
   * Read from the REGISTRY as well as the built-in set, so the rule is "the
   * catalogue says this one is local", not "the catalogue says ollama".
   */
  const isLocal = (p: string): boolean => LOCAL_PROVIDERS.has(p) || getPreset(p)?.local === true;

  const hasCreds = (p: string): boolean => {
    // Local runtimes are keyless — always "available"; reachability of the
    // localhost server is surfaced at call time, not gated here.
    if (isLocal(p)) return true;
    const envVar = PROVIDER_ENV_VAR[p as CliProvider] ?? getPreset(p)?.envVar;
    return !!(envVar && env[envVar]) || !!sectionFor(config, p)?.apiKey || !!secrets.keys?.[p];
  };

  // `custom` has no preset by design — it IS the escape hatch for a provider
  // the catalogue does not know — so the preset gate would reject it forever.
  //
  // The key must be in the SIDECAR. A `|| hasStoredCredential(CUSTOM_PROVIDER_ID)`
  // half used to stand here and was dead in three ways (V6 finding 15):
  // `loadSecrets` drops a keyless `custom` outright, so `secrets.custom?.baseUrl`
  // could never be true beside it; nothing writes a `provider:custom`
  // credential; and where the state was forced by hand it made things worse —
  // the selection said `custom` while `buildGateway` (which needs
  // `key && baseUrl` from the sidecar and reads no credential store for
  // `custom`) refused to register it, so the boot substituted
  // `registeredProviders[0]` and landed on gemini. Widening this is a change to
  // `loadSecrets` and `buildGateway` first, and to this line last.
  const customUsable = !!(secrets.custom?.baseUrl && secrets.custom?.key);

  /** Switched off in `/keys`. A key it cannot use is not a reason to select it. */
  const disabled = (p: string): boolean => secrets.disabled?.includes(p) === true;

  // Unchanged sticky semantics (see the note in rune-cli's git history): the
  // model you last used IS the model you get, as long as it can still be paid for.
  const stickyUsable = (p: string): boolean =>
    disabled(p)
      ? false
      : p === CUSTOM_PROVIDER_ID
        ? customUsable
        : getPreset(p) !== undefined &&
          (isLocal(p) || hasStoredCredential(p) || (isCliProvider(p) && hasCreds(p)));

  /**
   * A SAVED provider is usable when it is reachable at all: the custom
   * endpoint, a local runtime, or any preset with a credential from any store.
   * Deliberately wider than `stickyUsable` — this is the rot the config path had.
   */
  const configUsable = (p: string): boolean =>
    disabled(p)
      ? false
      : p === CUSTOM_PROVIDER_ID
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
  // `--provider` names ANY preset, not only the six the CLI knew by hand, and
  // it is matched case-insensitively: every registry id is lower-case, and
  // `--provider Anthropic` used to be dropped in silence (V6 finding 16).
  const namedProvider = cliProvider ? resolveProviderId(cliProvider, getPreset) : undefined;
  if (namedProvider) {
    return {
      provider: namedProvider,
      model: modelForProvider(namedProvider, modelCtx),
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

  // A saved or sticky id the registry does not know — a preset removed because
  // its vendor retired the product. Reported so the boot can say so; never a
  // throw, and never a reason to stop at this rung.
  const retired = [lastUsed?.provider, configProvider].find(
    (id): id is string => !!id && id !== CUSTOM_PROVIDER_ID && getPreset(id) === undefined,
  );

  const detected = detectBestProvider();
  return {
    provider: detected,
    model: modelForProvider(detected, modelCtx),
    source: "auto",
    ...(retired ? { unknownSaved: retired } : {}),
  };
}
