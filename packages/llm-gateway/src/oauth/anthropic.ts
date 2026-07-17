// ─── Anthropic subscription OAuth (Claude Pro/Max) ───
// The sign-in the official Claude Code CLI uses: authorization-code + PKCE against
// claude.ai. Anthropic only redirects to its OWN console callback, which DISPLAYS
// a `code#state` for the user to paste back (manual redirect — no arbitrary
// loopback is accepted). The token endpoint returns a refreshable *bearer* access
// token; the Anthropic transport then presents as Claude Code (oauth beta header +
// identity block, see providers/anthropic.ts) to spend the user's OWN Pro/Max
// plan. This is the same officially-supported flow the first-party CLI performs —
// no scraping, no unofficial token extraction, no API-key minting on the user's
// behalf beyond what the flow itself returns.
//
// The client id is Anthropic's public Claude Code CLI client (not a secret);
// override with GEAR_ANTHROPIC_OAUTH_CLIENT_ID if Anthropic rotates it.

import type { OAuthFlow, ExchangeResult } from "../auth/oauth-strategy";

// Endpoint hosts as of Claude Code 2.1.198 (read from the first-party client):
// Anthropic migrated the OAuth surface off claude.ai/console.anthropic.com —
// the legacy claude.ai/oauth/authorize now bounces every request with
// "Authorization failed: Invalid request format". The Claude-account (Pro/Max)
// authorize lives at claude.com/cai/…; token + the manual-code callback moved
// to platform.claude.com.
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLIENT_ID =
  process.env.GEAR_ANTHROPIC_OAUTH_CLIENT_ID ??
  process.env.BERNE_ANTHROPIC_OAUTH_CLIENT_ID ??
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// `user:inference` is the scope that lets a Pro/Max subscription serve inference;
// the others match what the first-party client requests during the same flow.
const SCOPES = "org:create_api_key user:profile user:inference";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
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
    throw new Error(`Anthropic token endpoint failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!json.access_token) throw new Error("Anthropic token endpoint returned no access_token");
  return {
    secret: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSec: json.expires_in,
  };
}

export const anthropicOAuthFlow: OAuthFlow = {
  providerId: "anthropic",
  // A Pro/Max login yields a bearer access token spent against the plan (not an
  // API key) — buildGateway sees `bearer` and puts the transport in OAuth mode.
  credentialKind: "bearer",
  usesState: true,
  // Anthropic renders the code on its console page to paste back (no loopback).
  redirect: "manual",
  manualRedirectUri: REDIRECT_URI,

  authorizeUrl({ redirectUri, codeChallenge, state }) {
    // Built by hand with encodeURIComponent, NOT URLSearchParams: the form
    // serializer encodes the scope's spaces as `+`, and claude.ai's authorize
    // endpoint parses `+` literally — the request bounces with "Authorization
    // failed: Invalid request format". `%20` is what the first-party client
    // sends and the only encoding this endpoint accepts. (Live-verified.)
    const params: [string, string][] = [
      // `code=true` asks Anthropic to render the code on the page for manual copy.
      ["code", "true"],
      ["client_id", CLIENT_ID],
      ["response_type", "code"],
      ["redirect_uri", redirectUri],
      ["scope", SCOPES],
      ["code_challenge", codeChallenge],
      ["code_challenge_method", "S256"],
      ["state", state],
    ];
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${AUTHORIZE_URL}?${query}`;
  },

  exchange({ code, codeVerifier, redirectUri, state }): Promise<ExchangeResult> {
    return postToken({
      grant_type: "authorization_code",
      code,
      state,
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
    });
  },
};
