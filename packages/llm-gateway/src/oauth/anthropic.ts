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
// override with BERNE_ANTHROPIC_OAUTH_CLIENT_ID if Anthropic rotates it.

import type { OAuthFlow, ExchangeResult } from "../auth/oauth-strategy";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLIENT_ID =
  process.env.BERNE_ANTHROPIC_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
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
    const u = new URL(AUTHORIZE_URL);
    // `code=true` asks Anthropic to render the code on the page for manual copy.
    u.searchParams.set("code", "true");
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", SCOPES);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    return u.toString();
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
