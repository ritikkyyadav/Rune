// ─── Generic OAuth strategy (Authorization Code + PKCE, loopback redirect) ───
// The reusable engine behind `gear login <provider>` for OAuth providers. It
// owns the security-critical mechanics — PKCE (S256), a `state` nonce, an
// ephemeral 127.0.0.1 loopback to capture the redirect — and delegates only the
// provider-specific URL shape and token exchange to an injected `OAuthFlow`.
// OpenRouter is the working reference (its flow mints a normal API key); a
// bearer-token provider with refresh (e.g. Anthropic) slots in as another flow.
//
// Officially documented flows only: no scraping, no unofficial token extraction.

import { createHash, randomBytes } from "crypto";
import { createServer } from "http";
import { oauthAccount } from "@gear/shared";
import type { AuthContext, AuthenticationStrategy, ResolvedCredential, AuthMethod } from "./types";
import { AuthError } from "./types";

// ─── PKCE + state (pure, exported for tests) ───

/** RFC 4648 §5 base64url with no padding. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier (43 chars) and its S256 challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A random anti-CSRF `state` nonce. */
export function randomState(): string {
  return base64url(randomBytes(16));
}

// ─── Provider flow contract ───

export interface ExchangeResult {
  /** The API key (OpenRouter) or OAuth access token. */
  secret: string;
  /** Refresh token, for providers that issue one. */
  refreshToken?: string;
  /** Access-token lifetime in seconds (bearer providers). */
  expiresInSec?: number;
  /**
   * Non-secret metadata to persist alongside the token and surface on the
   * resolved credential (e.g. Codex's `accountId`, parsed from the id_token, for
   * the `chatgpt-account-id` header). Carried forward across refreshes.
   */
  meta?: Record<string, string>;
}

export interface OAuthFlow {
  readonly providerId: string;
  /** apiKey → the provider mints a normal key; bearer → an OAuth access token. */
  readonly credentialKind: "apiKey" | "bearer";
  /** Whether the provider echoes `state` (then we verify it). PKCE covers CSRF otherwise. */
  readonly usesState?: boolean;
  /**
   * How the authorization code comes back:
   *   "loopback" (default) — an ephemeral 127.0.0.1 server captures the redirect.
   *   "manual" — the provider only redirects to its OWN callback page, which
   *     DISPLAYS a code (often `code#state`) for the user to paste. Used by
   *     Anthropic's Claude Pro/Max flow.
   */
  readonly redirect?: "loopback" | "manual";
  /** For manual redirect: the fixed redirect_uri the provider's page is shown at. */
  readonly manualRedirectUri?: string;
  /**
   * For loopback redirect: bind this EXACT port instead of an ephemeral one. Some
   * providers (OpenAI Codex) only register a fixed redirect URI, so the port and
   * path must match. Defaults to an ephemeral port + "/callback".
   */
  readonly loopbackPort?: number;
  readonly loopbackPath?: string;
  /** Build the browser URL that starts authorization. */
  authorizeUrl(p: { redirectUri: string; codeChallenge: string; state: string }): string;
  /** Exchange the returned authorization code (+ PKCE verifier, + state) for a credential. */
  exchange(p: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    state?: string;
  }): Promise<ExchangeResult>;
  /** Refresh a bearer token (providers that issue refresh tokens). */
  refresh?(refreshToken: string): Promise<ExchangeResult>;
}

interface StoredOAuth {
  secret: string;
  refreshToken?: string;
  expiresAt?: number;
  method: AuthMethod;
  /** Non-secret metadata (e.g. Codex accountId) persisted with the token. */
  meta?: Record<string, string>;
}

/** Refresh a token this far before it actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** RFC 6749 out-of-band redirect, the manual-paste fallback when a flow omits one. */
const OOB_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

// ─── Loopback capture (exported for tests) ───

export interface Loopback {
  /** The redirect URI to hand the provider (http://localhost:<ephemeral>/callback). */
  redirectUri: string;
  /** Resolves with the captured authorization code + state, or rejects on error/abort. */
  waitForCode: Promise<{ code: string; state: string }>;
  /** Tear down the server. */
  close(): void;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>Gear</title>" +
  "<body style='font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center'>" +
  "<h2>✓ Authorized</h2><p>You can close this tab and return to your terminal.</p></body>";

/**
 * Start a loopback server that captures a single OAuth redirect. Binds an
 * ephemeral port + "/callback" by default; a flow that only registered a FIXED
 * redirect (OpenAI Codex → localhost:1455/auth/callback) passes an exact port +
 * path so the URI matches.
 */
export async function startLoopback(
  signal?: AbortSignal,
  opts?: { port?: number; path?: string },
): Promise<Loopback> {
  const wantPort = opts?.port ?? 0;
  const path = opts?.path ?? "/callback";
  return new Promise<Loopback>((resolve, reject) => {
    let resolveCode!: (v: { code: string; state: string }) => void;
    let rejectCode!: (e: Error) => void;
    const waitForCode = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // The consumer attaches its `await` only after openBrowser runs, but the
    // redirect (and thus a possible rejection) can land during that window. A
    // no-op catch keeps an early rejection from being flagged "unhandled"; the
    // original promise still rejects for the real awaiter.
    void waitForCode.catch(() => {});

    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://localhost");
        if (!u.pathname.startsWith(path)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        const error = u.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`authorization error: ${error}`);
          rejectCode(new Error(`authorization denied: ${error}`));
          return;
        }
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state") ?? "";
        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("missing authorization code");
          rejectCode(new Error("callback did not include an authorization code"));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SUCCESS_HTML);
        resolveCode({ code, state });
      } catch (e) {
        try {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        } catch {
          // response may already be sent
        }
        rejectCode(e instanceof Error ? e : new Error(String(e)));
      }
    });

    server.on("error", reject);
    server.listen(wantPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        reject(new Error("could not bind a loopback port for OAuth"));
        return;
      }
      if (signal) {
        signal.addEventListener("abort", () => {
          rejectCode(new Error("login aborted"));
          try {
            server.close();
          } catch {
            // ignore
          }
        });
      }
      resolve({
        redirectUri: `http://localhost:${port}${path}`,
        waitForCode,
        close: () => {
          try {
            server.close();
          } catch {
            // ignore
          }
        },
      });
    });
  });
}

// ─── The strategy ───

export class OAuthStrategy implements AuthenticationStrategy {
  readonly method: AuthMethod = "oauth";

  constructor(private readonly flow: OAuthFlow) {}

  async authenticate(ctx: AuthContext): Promise<ResolvedCredential> {
    try {
      return this.flow.redirect === "manual"
        ? await this.authenticateManual(ctx)
        : await this.authenticateLoopback(ctx);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: `OAuth login failed: ${errMsg(err)}`,
        recovery: `run: gear login ${ctx.providerId}`,
      });
    }
  }

  /** Loopback redirect: capture the code on an ephemeral 127.0.0.1 server. */
  private async authenticateLoopback(ctx: AuthContext): Promise<ResolvedCredential> {
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const loop = await startLoopback(ctx.signal, {
      port: this.flow.loopbackPort,
      path: this.flow.loopbackPath,
    });
    try {
      const url = this.flow.authorizeUrl({
        redirectUri: loop.redirectUri,
        codeChallenge: challenge,
        state,
      });
      await this.openOrPrint(ctx, url);
      ctx.log?.("Waiting for authorization to complete…");

      const { code, state: returnedState } = await loop.waitForCode;
      // Strict for loopback: the provider echoes state in the query, so an empty
      // or mismatched value is a real anomaly (possible CSRF).
      if (this.flow.usesState && returnedState !== state) {
        throw this.stateMismatch(ctx);
      }
      return this.exchangeAndPersist(ctx, {
        code,
        verifier,
        redirectUri: loop.redirectUri,
        state: returnedState || state,
      });
    } finally {
      loop.close();
    }
  }

  /**
   * Manual redirect: the provider only redirects to its OWN callback page, which
   * displays a `code#state` for the user to paste back (Anthropic's Claude
   * Pro/Max flow). PKCE is the primary CSRF defense; state is verified when the
   * provider includes it in the pasted value.
   */
  private async authenticateManual(ctx: AuthContext): Promise<ResolvedCredential> {
    if (!ctx.prompt) {
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: `${ctx.preset.label} sign-in needs an interactive terminal to paste the code.`,
        recovery: `run: gear login ${ctx.providerId}`,
      });
    }
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const redirectUri = this.flow.manualRedirectUri ?? OOB_REDIRECT;
    const url = this.flow.authorizeUrl({ redirectUri, codeChallenge: challenge, state });
    await this.openOrPrint(ctx, url);

    const pasted = (
      await ctx.prompt("Paste the authorization code shown after approving: ")
    ).trim();
    if (!pasted) {
      throw new AuthError({
        providerId: ctx.providerId,
        method: this.method,
        message: "No authorization code entered.",
        recovery: `run: gear login ${ctx.providerId}`,
      });
    }
    // Anthropic returns `code#state`; split it. Lenient state check: verify only
    // when a state is present (some providers omit it — PKCE still protects).
    const [code, returnedState = ""] = pasted.split("#");
    if (this.flow.usesState && returnedState && returnedState !== state) {
      throw this.stateMismatch(ctx);
    }
    return this.exchangeAndPersist(ctx, {
      code,
      verifier,
      redirectUri,
      state: returnedState || state,
    });
  }

  // ─── shared authorize steps ───

  private async openOrPrint(ctx: AuthContext, url: string): Promise<void> {
    if (ctx.openBrowser) {
      ctx.log?.(`Opening your browser to authorize ${ctx.preset.label}…`);
      await ctx.openBrowser(url).catch(() => {
        ctx.log?.(`Couldn't open a browser. Visit this URL to authorize:\n${url}`);
      });
    } else {
      ctx.log?.(`Open this URL to authorize ${ctx.preset.label}:\n${url}`);
    }
  }

  private stateMismatch(ctx: AuthContext): AuthError {
    return new AuthError({
      providerId: ctx.providerId,
      method: this.method,
      message: "OAuth state mismatch — aborting (possible CSRF).",
      recovery: `run: gear login ${ctx.providerId}`,
    });
  }

  private async exchangeAndPersist(
    ctx: AuthContext,
    p: { code: string; verifier: string; redirectUri: string; state?: string },
  ): Promise<ResolvedCredential> {
    const result = await this.flow.exchange({
      code: p.code,
      codeVerifier: p.verifier,
      redirectUri: p.redirectUri,
      state: p.state,
    });
    const cred = this.toCred(result);
    await this.persist(ctx, {
      secret: result.secret,
      refreshToken: result.refreshToken,
      expiresAt: cred.expiresAt,
      method: "oauth",
      meta: result.meta,
    });
    return cred;
  }

  async loadCredentials(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const blob = await this.readBlob(ctx);
    if (!blob) return null;
    // Refresh proactively when near expiry, before we hand a stale token out.
    if (
      blob.expiresAt &&
      blob.expiresAt - Date.now() < REFRESH_SKEW_MS &&
      blob.refreshToken &&
      this.flow.refresh
    ) {
      try {
        return await this.doRefresh(ctx, blob);
      } catch {
        // Refresh failed on the quiet path → behave as "no credential". The next
        // live call surfaces a 401 with the run-login recovery text.
        return null;
      }
    }
    return this.credFromBlob(blob);
  }

  async refresh(ctx: AuthContext): Promise<ResolvedCredential | null> {
    const blob = await this.readBlob(ctx);
    if (!blob) return null;
    if (blob.refreshToken && this.flow.refresh) return this.doRefresh(ctx, blob);
    return this.credFromBlob(blob);
  }

  /** Offline validity: a non-empty secret. Live probes happen at call time. */
  async validate(_ctx: AuthContext, cred: ResolvedCredential): Promise<boolean> {
    return typeof cred.secret === "string" && cred.secret.length > 0;
  }

  async storeCredentials(ctx: AuthContext, cred: ResolvedCredential): Promise<void> {
    // Preserve an existing refresh token + metadata when re-storing just the token.
    const existing = await this.readBlob(ctx);
    await this.persist(ctx, {
      secret: cred.secret ?? "",
      refreshToken: existing?.refreshToken,
      expiresAt: cred.expiresAt,
      method: "oauth",
      meta: existing?.meta,
    });
  }

  async logout(ctx: AuthContext): Promise<void> {
    try {
      await ctx.store.delete(oauthAccount(ctx.providerId));
    } catch {
      // Never throw on logout.
    }
  }

  // ─── internals ───

  /** The resolved credential for a stored blob (no refresh). */
  private credFromBlob(blob: StoredOAuth): ResolvedCredential {
    return {
      kind: this.flow.credentialKind,
      secret: blob.secret,
      expiresAt: blob.expiresAt,
      meta: { method: "oauth", ...(blob.meta ?? {}) },
    };
  }

  private toCred(result: ExchangeResult, carryMeta?: Record<string, string>): ResolvedCredential {
    const expiresAt = result.expiresInSec ? Date.now() + result.expiresInSec * 1000 : undefined;
    return {
      kind: this.flow.credentialKind,
      secret: result.secret,
      expiresAt,
      // A refresh response usually omits the account metadata — carry the stored
      // value forward so `chatgpt-account-id` survives token rotation.
      meta: { method: "oauth", ...(carryMeta ?? {}), ...(result.meta ?? {}) },
    };
  }

  private async doRefresh(ctx: AuthContext, blob: StoredOAuth): Promise<ResolvedCredential> {
    const result = await this.flow.refresh!(blob.refreshToken!);
    const carriedMeta = { ...(blob.meta ?? {}), ...(result.meta ?? {}) };
    const cred = this.toCred(result, blob.meta);
    await this.persist(ctx, {
      secret: result.secret,
      // keep the old refresh token if the provider didn't rotate it
      refreshToken: result.refreshToken ?? blob.refreshToken,
      expiresAt: cred.expiresAt,
      method: "oauth",
      meta: Object.keys(carriedMeta).length ? carriedMeta : undefined,
    });
    return cred;
  }

  private async persist(ctx: AuthContext, blob: StoredOAuth): Promise<void> {
    await ctx.store.set(oauthAccount(ctx.providerId), JSON.stringify(blob));
  }

  private async readBlob(ctx: AuthContext): Promise<StoredOAuth | null> {
    try {
      const raw = await ctx.store.get(oauthAccount(ctx.providerId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredOAuth;
      return parsed && typeof parsed.secret === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
