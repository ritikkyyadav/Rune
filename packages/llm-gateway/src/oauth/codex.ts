// ─── ChatGPT Plus/Pro subscription OAuth (Codex) ───
// The "Sign in with ChatGPT" flow the Codex CLI uses: authorization-code + PKCE
// against auth.openai.com, with a FIXED loopback redirect (localhost:1455) because
// that's the only URI the Codex client registers. The token endpoint returns an
// access token (a JWT usable against the ChatGPT Codex "responses" backend), a
// refresh token, and an id_token whose claims carry the ChatGPT account id — which
// the CodexProvider sends as the `chatgpt-account-id` header. This is the same
// officially-supported login the first-party CLI performs, spending the user's OWN
// ChatGPT plan; no scraping, no session-cookie extraction.
//
// The client id is Codex's public CLI client (not a secret); override with
// RUNE_CODEX_CLIENT_ID if OpenAI rotates it (the older variable remains supported).

import type { OAuthFlow, ExchangeResult } from "../auth/oauth-strategy";

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = process.env.RUNE_CODEX_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const LOOPBACK_PORT = 1455;
const LOOPBACK_PATH = "/auth/callback";
const SCOPES = "openid profile email offline_access";

/** Decode a JWT payload (middle segment) without verifying — we only read claims. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const seg = jwt.split(".")[1];
  if (!seg) return undefined;
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Pull the ChatGPT account id out of the id_token's OpenAI auth claim. */
export function accountIdFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const payload = decodeJwtPayload(idToken);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id ?? payload?.chatgpt_account_id;
  return typeof id === "string" ? id : undefined;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

async function postToken(body: Record<string, unknown>): Promise<ExchangeResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI token endpoint failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!json.access_token) throw new Error("OpenAI token endpoint returned no access_token");
  const accountId = accountIdFromIdToken(json.id_token);
  return {
    secret: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSec: json.expires_in,
    meta: accountId ? { accountId } : undefined,
  };
}

export const codexOAuthFlow: OAuthFlow = {
  providerId: "codex",
  // The access token is a bearer spent against the ChatGPT Codex backend.
  credentialKind: "bearer",
  usesState: true,
  redirect: "loopback",
  loopbackPort: LOOPBACK_PORT,
  loopbackPath: LOOPBACK_PATH,

  authorizeUrl({ redirectUri, codeChallenge, state }) {
    // Hand-encoded (%20 for the scope's spaces), not URLSearchParams — the form
    // serializer's `+` reads as a literal plus on strict authorize endpoints.
    // Anthropic's endpoint live-rejected `+` ("Invalid request format"); encode
    // uniformly here too so Codex never trips the same parser class.
    const params: [string, string][] = [
      ["response_type", "code"],
      ["client_id", CLIENT_ID],
      ["redirect_uri", redirectUri],
      ["scope", SCOPES],
      ["code_challenge", codeChallenge],
      ["code_challenge_method", "S256"],
      ["state", state],
      // Codex-specific: return an id_token carrying the account so it can serve
      // inference, and use the simplified CLI consent screen.
      ["id_token_add_organizations", "true"],
      ["codex_cli_simplified_flow", "true"],
    ];
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${AUTHORIZE_URL}?${query}`;
  },

  exchange({ code, codeVerifier, redirectUri }): Promise<ExchangeResult> {
    return postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });
  },

  refresh(refreshToken): Promise<ExchangeResult> {
    return postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    });
  },
};
