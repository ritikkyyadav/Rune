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
// override with RUNE_ANTHROPIC_OAUTH_CLIENT_ID if Anthropic rotates it.

import type { OAuthFlow, ExchangeResult } from "../auth/oauth-strategy";

// Endpoints, client id and scopes are the FIRST-PARTY constants, read out of
// the installed Claude Code binary (2.1.198). The client keeps TWO flows and
// each has its OWN endpoint and redirect style — they cannot be mixed:
//
//   Pro/Max (chat account) : claude.com/cai/oauth/authorize + LOOPBACK
//                            redirect (http://localhost:<port>/callback)
//   Console (API billing)  : platform.claude.com/oauth/authorize + the manual
//                            paste-the-code page
//
// Rune used the MANUAL redirect for a Pro/Max sign-in. That is the mismatch
// behind "Authorization failed: Invalid request format", and it survived three
// fixes aimed at the query string because the query string was never wrong.
//
// Demonstrated in a real browser (headless Chromium, 2026-08-30) — the same
// params, only the redirect differing:
//   claude.ai + LOOPBACK -> proceeds to claude.ai/login, "Continue with your
//                           Claude.ai account to authenticate connections"
//   claude.ai + MANUAL   -> never proceeds
// A curl check could not have seen this: the page returns 200 with the right
// <title> and renders the failure from JavaScript after hydration.
const AUTHORIZE_URL =
  process.env.RUNE_ANTHROPIC_AUTHORIZE_URL ?? "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID =
  process.env.RUNE_ANTHROPIC_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/**
 * `Ovn` from the first-party client: the deduped union of its two scope lists,
 * which is what BOTH the claude.ai and console flows send.
 *
 *   r  = ["org:create_api_key", "user:profile"]
 *   Tq = ["user:profile", "user:inference", "user:sessions:claude_code",
 *         "user:mcp_servers", "user:file_upload"]
 *   Ovn = dedupe([...r, ...Tq])
 *
 * Rune sent a three-scope subset and the authorize endpoint answered
 * "Authorization failed: Invalid request format" — which reads like a malformed
 * query and actually means the scope set is not one it grants. Guessing at a
 * plausible-looking subset failed twice; this is copied.
 */
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

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
  // Loopback — NOT the manual paste-the-code page. The comment that used to sit
  // here claimed "Anthropic only redirects to its OWN console callback ... no
  // arbitrary loopback is accepted". That is false, and it cost four attempts:
  // the loopback redirect is exactly what the Pro/Max flow requires, and the
  // manual one is what it rejects. `startLoopback` binds an ephemeral port and
  // "/callback", matching the first-party `http://localhost:${port}/callback`.

  authorizeUrl({ redirectUri, codeChallenge, state }) {
    // Mirrors the first-party builder verbatim, INCLUDING its encoding.
    //
    // This used to be hand-rolled with encodeURIComponent so the scope's
    // separators were `%20`, under a comment asserting that is "what the
    // first-party client sends and the only encoding this endpoint accepts".
    // That assertion is false: the client builds the URL with `new URL()` +
    // `searchParams.append()`, and URLSearchParams serializes a space as `+`.
    // So `+` is what actually reaches Anthropic from the client that works,
    // and Rune's careful `%20` was the anomaly.
    //
    // Using URLSearchParams here is therefore not a style choice — it is the
    // thing being copied. Param order matches the first-party call order.
    const url = new URL(AUTHORIZE_URL);
    // `code=true` asks Anthropic to render the code on the page for manual copy.
    url.searchParams.append("code", "true");
    url.searchParams.append("client_id", CLIENT_ID);
    url.searchParams.append("response_type", "code");
    url.searchParams.append("redirect_uri", redirectUri);
    url.searchParams.append("scope", SCOPES);
    url.searchParams.append("code_challenge", codeChallenge);
    url.searchParams.append("code_challenge_method", "S256");
    url.searchParams.append("state", state);
    return url.toString();
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
