// ─── OAuth strategy registry (per provider) ───
// OAuth is provider-specific: each provider has its own endpoints and quirks.
// This maps a provider id to its OAuth (and device-code) strategy. Providers
// without a wired flow return undefined, so the auth resolver gracefully falls
// through to their next candidate method (api_key).
//
// OpenRouter's documented PKCE flow is the working reference (its exchange mints
// a normal API key). Codex (ChatGPT sign-in) is the same authorization-code +
// PKCE shape but yields a refreshable *bearer* token.
//
// Anthropic is deliberately absent. Its subscription sign-in (Claude Pro/Max)
// was retired on 2026-09-28: Anthropic's terms do not permit a third-party app
// to offer Claude.ai login or to route requests through a Free, Pro or Max
// plan. A token stored by an older Rune is left where it is and never read for
// inference; `retiredOAuthNotices` is how a person who still has one learns why
// it stopped working. See docs/program/compliance-subscription-routes.md.

import { oauthAccount, type CredentialStore } from "@rune/shared";
import type { AuthenticationStrategy } from "./types";
import { OAuthStrategy } from "./oauth-strategy";
import { DeviceCodeStrategy } from "./device-code-strategy";
import { openRouterOAuthFlow } from "../oauth/openrouter";
import { codexOAuthFlow } from "../oauth/codex";

let openRouter: OAuthStrategy | undefined;
let codex: OAuthStrategy | undefined;

/** The OAuth (PKCE / authorization-code) strategy for a provider, if any. */
export function makeOAuthStrategy(
  providerId: string,
  _env: NodeJS.ProcessEnv = process.env,
): AuthenticationStrategy | undefined {
  if (providerId === "openrouter") {
    return (openRouter ??= new OAuthStrategy(openRouterOAuthFlow));
  }
  if (providerId === "codex") {
    return (codex ??= new OAuthStrategy(codexOAuthFlow));
  }
  return undefined;
}

/** The device-code strategy for a provider, if any (headless OAuth login). */
export function makeDeviceStrategy(providerId: string): AuthenticationStrategy | undefined {
  return undefined;
}

// ─── Retired sign-ins ───

/**
 * Account sign-ins Rune used to offer and no longer does, by provider id, with
 * the one line a person sees about it. The order of the advice matters:
 * `rune logout <id>` removes the stored API key as well as the old token, so it
 * comes before signing in again with a key, not after.
 */
export const RETIRED_OAUTH_NOTICES: Readonly<Record<string, string>> = {
  anthropic:
    "The Claude subscription sign-in is retired: Anthropic's terms do not permit third-party " +
    "apps to use Claude.ai login or Free/Pro/Max plan credentials, so Rune ignores the token " +
    "stored for it. Run `rune logout anthropic` to remove it, then use an Anthropic API key " +
    "(`rune login anthropic`), Bedrock or Vertex.",
};

/** Retired routes already announced in this process. */
const announcedRetired = new Set<string>();

/**
 * The notices owed to this person: one per retired sign-in whose token is
 * still in the credential store, each at most once per process (`seen` is
 * injectable for tests). It only reads. The stored token is the person's, and
 * removing it is `rune logout`'s job, never a side effect of starting Rune.
 */
export async function retiredOAuthNotices(
  store: Pick<CredentialStore, "get">,
  seen: Set<string> = announcedRetired,
): Promise<string[]> {
  const out: string[] = [];
  for (const [providerId, notice] of Object.entries(RETIRED_OAUTH_NOTICES)) {
    if (seen.has(providerId)) continue;
    let stored: string | null = null;
    try {
      stored = await store.get(oauthAccount(providerId));
    } catch {
      stored = null; // a store that cannot answer owes no notice
    }
    if (!stored) continue;
    seen.add(providerId);
    out.push(notice);
  }
  return out;
}
