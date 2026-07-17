// ─── OpenRouter OAuth (PKCE) — the reference flow ───
// OpenRouter documents a PKCE authorization flow that mints a *normal* API key:
//   1. Send the user to https://openrouter.ai/auth?callback_url=…&code_challenge=…
//      &code_challenge_method=S256
//   2. They approve; OpenRouter redirects to callback_url?code=…
//   3. POST the code + PKCE verifier to /api/v1/auth/keys → { key: "sk-or-v1-…" }
// Because the result is an ordinary key, `credentialKind` is "apiKey": it stores
// and streams exactly like a pasted key, and there is no token to refresh.
// Docs: https://openrouter.ai/docs/use-cases/oauth-pkce

import type { OAuthFlow, ExchangeResult } from "../auth/oauth-strategy";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";

export const openRouterOAuthFlow: OAuthFlow = {
  providerId: "openrouter",
  credentialKind: "apiKey",
  // OpenRouter's documented params are callback_url + code_challenge(+method);
  // it does not echo a `state`, so PKCE (the verifier we alone hold) is the
  // CSRF protection — an intercepted code is useless without the verifier.
  usesState: false,

  authorizeUrl({ redirectUri, codeChallenge }) {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("callback_url", redirectUri);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async exchange({ code, codeVerifier }): Promise<ExchangeResult> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { key?: string; api_key?: string };
    const key = json.key ?? json.api_key;
    if (typeof key !== "string" || !key) {
      throw new Error("OpenRouter token exchange returned no key");
    }
    return { secret: key };
  },
};
