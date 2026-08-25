// ─── Authentication strategy port ───
// The isolation boundary for BYOP. A provider authenticates by exactly one of
// several methods (API key, OAuth, device code, local connectivity); each method
// is a strategy behind THIS interface. The composition root resolves a strategy,
// asks it for a credential, and hands the credential to the provider adapter. The
// gateway, the agent loop, and the UI never learn *how* a provider signed in —
// they ask for an authenticated provider and stream. That is the whole point:
// putting `authenticate()` on the adapter would couple auth to inference; keeping
// it here does not.

import type { ProviderPreset, CredentialStore, AuthMethod } from "@gear/shared";

// Re-export so the auth layer is the one import site for strategy code, while the
// canonical definition stays in @gear/shared (used by ProviderPreset.auth too).
export type { AuthMethod };

/**
 * The output of authentication: a ready-to-use credential for a provider adapter.
 * Deliberately provider-shaped-neutral — an API key and a refreshed OAuth bearer
 * both land here, and `buildGateway` treats them identically.
 */
export interface ResolvedCredential {
  /** apiKey → send as the provider's key; bearer → OAuth access token; none → keyless local. */
  kind: "apiKey" | "bearer" | "none";
  /** The secret value (api key or bearer token). Absent for kind="none". */
  secret?: string;
  /** For local/custom endpoints — the base URL to reach. */
  baseUrl?: string;
  /** Epoch ms when a refreshable token expires (OAuth). Absent for static keys. */
  expiresAt?: number;
  /** Non-secret metadata (e.g. auth method, token type) for status/telemetry. */
  meta?: Record<string, string>;
}

/**
 * Everything a strategy needs, injected for testability. Interactive I/O hooks
 * are undefined on the non-interactive paths (startup, gateway rebuild) so a
 * strategy can tell "run the full browser flow" from "quietly load what's saved".
 */
export interface AuthContext {
  providerId: string;
  preset: ProviderPreset;
  /** The secure credential store (injected — keychain or file fallback). */
  store: CredentialStore;
  /** Injected env for key/precedence resolution and testability. */
  env: NodeJS.ProcessEnv;
  /**
   * The key already resolved from config.toml / secrets.json for this provider —
   * the MIDDLE of the api_key precedence chain (secure store → this → env var).
   * Supplied by the resolver so the whole chain lives in one place (the strategy)
   * and stays byte-identical to today's `resolveKey`.
   */
  savedKey?: string;
  /** Effective base URL for a local/custom provider (localBaseUrls → preset). */
  baseUrl?: string;
  /** Open a URL in the user's browser (interactive login only). */
  openBrowser?: (url: string) => Promise<void>;
  /** Prompt for a line of input, e.g. pasting a code (interactive login only). */
  prompt?: (question: string) => Promise<string>;
  /** Emit a progress/info line to the user (interactive login only). */
  log?: (line: string) => void;
  /** Cancels an in-flight interactive flow. */
  signal?: AbortSignal;
}

export interface AuthenticationStrategy {
  readonly method: AuthMethod;
  /** Interactive: run the full flow (browser/device/paste), persist, return creds. */
  authenticate(ctx: AuthContext): Promise<ResolvedCredential>;
  /** Non-interactive: load persisted creds; refresh near expiry; null if none. Never throws. */
  loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null>;
  /** Refresh an OAuth token; no-op (returns the input/null) for api_key & local. */
  refresh(ctx: AuthContext): Promise<ResolvedCredential | null>;
  /** Cheap validity probe (format check or /models ping). Never throws. */
  validate(ctx: AuthContext, cred: ResolvedCredential): Promise<boolean>;
  /** Persist credentials to the store. */
  storeCredentials(ctx: AuthContext, cred: ResolvedCredential): Promise<void>;
  /** Delete persisted credentials (logout). Never throws. */
  logout(ctx: AuthContext): Promise<void>;
}

/**
 * A terminal authentication failure the gateway can surface with recovery text.
 * `retryable=false` (the default for auth errors) tells the agent loop not to
 * grind through retries — the fix is human (re-login), not another attempt.
 */
export class AuthError extends Error {
  readonly providerId: string;
  readonly method: AuthMethod;
  readonly retryable: boolean;
  /** Actionable next step, e.g. "run: gear login openrouter". */
  readonly recovery?: string;

  constructor(opts: {
    providerId: string;
    method: AuthMethod;
    message: string;
    retryable?: boolean;
    recovery?: string;
  }) {
    super(opts.message);
    this.name = "AuthError";
    this.providerId = opts.providerId;
    this.method = opts.method;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery;
  }
}
