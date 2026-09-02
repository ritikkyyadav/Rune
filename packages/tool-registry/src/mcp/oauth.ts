// ─── OAuth 2.1 for MCP connectors ───
//
// Every remote connector in the vendored catalog — Notion, Slack, Linear,
// Atlassian, GitHub, PagerDuty, Datadog, gcal, gmail — is OAuth-protected. The
// HTTP transport turned their 401 into a thrown string, so none of them could
// connect at all. This is the missing half.
//
// The flow, per the MCP authorization spec (2025-06-18) and the RFCs it cites:
//
//   1. POST the server, get 401 + `WWW-Authenticate: Bearer resource_metadata=…`
//   2. GET the protected-resource metadata (RFC 9728) → which authorization
//      server(s) issue tokens for this resource
//   3. GET the authorization-server metadata (RFC 8414, OIDC discovery as a
//      fallback) → authorize/token/registration endpoints
//   4. Register a client dynamically (RFC 7591) when the server offers it;
//      otherwise use a pre-configured client_id
//   5. Authorization Code + PKCE S256, redirect captured on an ephemeral
//      127.0.0.1 loopback — the same engine `gear login` already uses
//   6. Store the token set under `mcp:<server>` in the OS credential store
//   7. Refresh before expiry; on refresh failure the SERVER goes unavailable,
//      never the session
//
// The last point is the one that matters at runtime. A connector whose token
// expired overnight must not take the session down with it: the server is
// marked needing auth, its tools stop being advertised, the model is told once,
// and everything else keeps working.

import { generatePkce, startLoopback } from "@gear/llm-gateway";
import { type Logger, nullLogger, type CredentialStore } from "@gear/shared";

// ─── Stored shape ───

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "no expiry advertised" — we use it until it 401s. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  /** The client this token belongs to; a dynamically registered id must persist. */
  clientId?: string;
  clientSecret?: string;
  /** Discovery results, cached so a refresh needs no round trips. */
  tokenEndpoint?: string;
  /** The canonical resource identifier this token was issued for (RFC 8707). */
  resource?: string;
}

/** Refresh this far before the token actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** Account name for a connector's stored OAuth token set. */
export function mcpCredentialAccount(serverName: string): string {
  return `mcp:${serverName}`;
}

/** Raised when a connector needs an interactive login before it can be used. */
export class McpAuthRequiredError extends Error {
  constructor(
    public serverName: string,
    message: string,
  ) {
    super(message);
    this.name = "McpAuthRequiredError";
  }
}

// ─── Metadata discovery ───

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  grant_types_supported?: string[];
}

/**
 * Parse `WWW-Authenticate`. Only the auth-param form matters to us
 * (`Bearer realm="…", resource_metadata="https://…"`), and only for reading
 * hints — nothing here is trusted beyond "where should I look next".
 */
export function parseWwwAuthenticate(header: string | null): {
  scheme: string;
  params: Record<string, string>;
} {
  if (!header) return { scheme: "", params: {} };
  const trimmed = header.trim();
  const sp = trimmed.indexOf(" ");
  const scheme = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? "" : trimmed.slice(sp + 1);
  const params: Record<string, string> = {};
  // key="value" | key=value, comma separated. Values may contain commas only
  // inside quotes, which this pattern respects.
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    params[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return { scheme, params };
}

/**
 * Candidate protected-resource metadata URLs for a server URL, per RFC 9728:
 * the well-known segment is inserted after the host, with the resource path
 * appended; a path-less fallback covers servers that publish at the root.
 */
export function protectedResourceUrls(serverUrl: string): string[] {
  try {
    const u = new URL(serverUrl);
    const path = u.pathname.replace(/\/+$/, "");
    const out = new Set<string>();
    if (path && path !== "/") {
      out.add(`${u.origin}/.well-known/oauth-protected-resource${path}`);
    }
    out.add(`${u.origin}/.well-known/oauth-protected-resource`);
    return [...out];
  } catch {
    return [];
  }
}

/** Candidate authorization-server metadata URLs for an issuer (RFC 8414 + OIDC). */
export function authorizationServerUrls(issuer: string): string[] {
  try {
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/+$/, "");
    const out = new Set<string>();
    if (path && path !== "/") {
      out.add(`${u.origin}/.well-known/oauth-authorization-server${path}`);
      out.add(`${u.origin}${path}/.well-known/oauth-authorization-server`);
      out.add(`${u.origin}${path}/.well-known/openid-configuration`);
    }
    out.add(`${u.origin}/.well-known/oauth-authorization-server`);
    out.add(`${u.origin}/.well-known/openid-configuration`);
    return [...out];
  } catch {
    return [];
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The first metadata document that answers, or null if none do. */
export async function discoverProtectedResource(
  serverUrl: string,
  hintUrl?: string,
): Promise<ProtectedResourceMetadata | null> {
  const candidates = hintUrl
    ? [hintUrl, ...protectedResourceUrls(serverUrl)]
    : protectedResourceUrls(serverUrl);
  for (const url of candidates) {
    const doc = await fetchJson<ProtectedResourceMetadata>(url);
    if (doc) return doc;
  }
  return null;
}

export async function discoverAuthorizationServer(
  issuer: string,
): Promise<AuthorizationServerMetadata | null> {
  for (const url of authorizationServerUrls(issuer)) {
    const doc = await fetchJson<AuthorizationServerMetadata>(url);
    if (doc?.token_endpoint) return doc;
  }
  return null;
}

/**
 * Dynamic client registration (RFC 7591). Public client, no secret expected —
 * a CLI cannot keep one. A server that returns a secret anyway gets it stored
 * and sent, which is what its own metadata asked for.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  opts: { clientName?: string; scope?: string } = {},
): Promise<{ clientId: string; clientSecret?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: opts.clientName ?? "Gear",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(opts.scope ? { scope: opts.scope } : {}),
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { client_id?: string; client_secret?: string };
    if (!body.client_id) return null;
    return { clientId: body.client_id, clientSecret: body.client_secret };
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    // Non-JSON error body — fall through to the status-based message.
  }
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`token endpoint refused the request: ${detail}`);
  }
  return body;
}

function toTokens(
  body: TokenResponse,
  base: Partial<McpOAuthTokens>,
  previousRefresh?: string,
): McpOAuthTokens {
  return {
    ...base,
    accessToken: body.access_token!,
    // A refresh response may omit the refresh token, meaning "keep the old one".
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    tokenType: body.token_type ?? "Bearer",
    scope: body.scope ?? base.scope,
  };
}

// ─── The per-server provider ───

export interface McpOAuthOptions {
  serverName: string;
  serverUrl: string;
  store: CredentialStore;
  logger?: Logger;
  /** Pre-registered client id (some servers do not offer DCR). */
  clientId?: string;
  /** Fixed loopback port, when a server only registered one redirect URI. */
  callbackPort?: number;
  /** Requested scopes; defaults to whatever the resource advertises. */
  scopes?: string[];
}

/**
 * One connector's OAuth state: discovery, login, refresh, storage.
 *
 * Deliberately NOT a transport concern. The transport asks for a header and
 * reports a 401; everything about how a token is obtained lives here, so the
 * same object backs `gear mcp login`, the automatic refresh, and `doctor`.
 */
export class McpOAuth {
  private readonly serverName: string;
  private readonly serverUrl: string;
  private readonly store: CredentialStore;
  private readonly logger: Logger;
  private readonly configuredClientId?: string;
  private readonly callbackPort?: number;
  private readonly scopes?: string[];

  private tokens: McpOAuthTokens | null = null;
  private loaded = false;
  /** In-flight refresh, shared so a burst of 401s costs one round trip. */
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: McpOAuthOptions) {
    this.serverName = opts.serverName;
    this.serverUrl = opts.serverUrl;
    this.store = opts.store;
    this.logger = opts.logger ?? nullLogger;
    this.configuredClientId = opts.clientId;
    this.callbackPort = opts.callbackPort;
    this.scopes = opts.scopes;
  }

  get name(): string {
    return this.serverName;
  }

  /** Read the stored token set (once per process, then cached). */
  async load(): Promise<McpOAuthTokens | null> {
    if (this.loaded) return this.tokens;
    this.loaded = true;
    try {
      const raw = await this.store.get(mcpCredentialAccount(this.serverName));
      this.tokens = raw ? (JSON.parse(raw) as McpOAuthTokens) : null;
    } catch {
      this.tokens = null;
    }
    return this.tokens;
  }

  async save(tokens: McpOAuthTokens): Promise<void> {
    this.tokens = tokens;
    this.loaded = true;
    await this.store.set(mcpCredentialAccount(this.serverName), JSON.stringify(tokens));
  }

  async logout(): Promise<void> {
    this.tokens = null;
    this.loaded = true;
    await this.store.delete(mcpCredentialAccount(this.serverName));
  }

  /**
   * Drop the cached read so the next call sees the store as it is now.
   *
   * `gear mcp login` runs in a DIFFERENT process from a live session. Without
   * this, a session that started unauthenticated would keep believing it had
   * no token for the rest of its life, and reconnecting after a sign-in would
   * fail for no visible reason.
   */
  async reload(): Promise<void> {
    this.loaded = false;
    this.tokens = null;
    await this.load();
  }

  /** True when a token set exists at all (says nothing about validity). */
  async hasCredentials(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  /**
   * The Authorization header to send, refreshing first when the token is
   * within the skew of expiry. Returns null when there is nothing stored — the
   * caller then sends the request unauthenticated and lets the 401 drive
   * discovery, which is how a first connection learns what it needs.
   */
  async authorizationHeader(): Promise<string | null> {
    const tokens = await this.load();
    if (!tokens) return null;
    if (tokens.expiresAt !== undefined && Date.now() >= tokens.expiresAt - REFRESH_SKEW_MS) {
      const ok = await this.refresh();
      if (!ok) return null;
    }
    const current = this.tokens;
    if (!current) return null;
    return `${current.tokenType ?? "Bearer"} ${current.accessToken}`;
  }

  /**
   * Exchange the refresh token for a new access token.
   * Returns false when there is nothing to refresh with or the server refuses —
   * the caller's job is then to mark the connector as needing auth, not to fail.
   */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const tokens = await this.load();
    if (!tokens?.refreshToken || !tokens.tokenEndpoint) return false;
    try {
      const body = await postToken(tokens.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        ...(tokens.clientId ? { client_id: tokens.clientId } : {}),
        ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
        ...(tokens.resource ? { resource: tokens.resource } : {}),
      });
      await this.save(toTokens(body, tokens, tokens.refreshToken));
      this.logger.info(`refreshed OAuth token for "${this.serverName}"`);
      return true;
    } catch (err) {
      this.logger.warn(
        `token refresh failed for "${this.serverName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Run the full interactive flow and store the result.
   *
   * `openAuthorizationUrl` is injected rather than hardcoded so the CLI can
   * open a browser, a headless caller can print the URL, and the integration
   * test can drive the mock authorization server directly.
   */
  async login(opts: {
    openAuthorizationUrl: (url: string) => void | Promise<void>;
    wwwAuthenticate?: string | null;
    signal?: AbortSignal;
  }): Promise<McpOAuthTokens> {
    const hint = parseWwwAuthenticate(opts.wwwAuthenticate ?? null).params.resource_metadata;
    const resource = await discoverProtectedResource(this.serverUrl, hint);
    const issuer = resource?.authorization_servers?.[0];
    if (!issuer) {
      throw new McpAuthRequiredError(
        this.serverName,
        `no authorization server advertised for ${this.serverUrl} — the connector does not publish OAuth metadata`,
      );
    }
    const as = await discoverAuthorizationServer(issuer);
    if (!as?.authorization_endpoint || !as.token_endpoint) {
      throw new McpAuthRequiredError(
        this.serverName,
        `authorization server ${issuer} published no usable metadata`,
      );
    }
    // PKCE S256 is required by OAuth 2.1; a server that says it supports only
    // `plain` is refused rather than downgraded to.
    const methods = as.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) {
      throw new McpAuthRequiredError(
        this.serverName,
        `authorization server ${issuer} does not support PKCE S256`,
      );
    }

    const scope = (this.scopes ?? resource?.scopes_supported ?? []).join(" ");
    const loop = await startLoopback(opts.signal, {
      port: this.callbackPort,
      providerLabel: this.serverName,
    });
    try {
      let clientId = this.configuredClientId ?? (await this.load())?.clientId;
      let clientSecret = (await this.load())?.clientSecret;
      if (!clientId && as.registration_endpoint) {
        const reg = await registerClient(as.registration_endpoint, loop.redirectUri, {
          clientName: "Gear",
          scope: scope || undefined,
        });
        clientId = reg?.clientId;
        clientSecret = reg?.clientSecret;
      }
      if (!clientId) {
        throw new McpAuthRequiredError(
          this.serverName,
          `${issuer} offers no dynamic client registration and no client_id is configured — ` +
            `add one to the server's mcp.json entry as "oauth": { "clientId": "…" }`,
        );
      }

      const { verifier, challenge } = generatePkce();
      const state = crypto.randomUUID();
      const authorizeUrl = new URL(as.authorization_endpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", loop.redirectUri);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);
      if (scope) authorizeUrl.searchParams.set("scope", scope);
      // RFC 8707: name the resource so the token is audience-bound to THIS server.
      const resourceId = resource?.resource ?? this.serverUrl;
      authorizeUrl.searchParams.set("resource", resourceId);

      await opts.openAuthorizationUrl(authorizeUrl.toString());
      const captured = await loop.waitForCode;
      if (captured.state && captured.state !== state) {
        throw new McpAuthRequiredError(this.serverName, "authorization state mismatch");
      }

      const body = await postToken(as.token_endpoint, {
        grant_type: "authorization_code",
        code: captured.code,
        redirect_uri: loop.redirectUri,
        code_verifier: verifier,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        resource: resourceId,
      });

      const tokens = toTokens(body, {
        clientId,
        clientSecret,
        tokenEndpoint: as.token_endpoint,
        resource: resourceId,
        scope: scope || undefined,
      });
      await this.save(tokens);
      this.logger.info(`connected "${this.serverName}" via OAuth`);
      return tokens;
    } finally {
      loop.close();
    }
  }
}
