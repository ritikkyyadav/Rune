// ─── OAuth strategy registry (per provider) ───
// OAuth is provider-specific: each provider has its own endpoints and quirks.
// This maps a provider id to its OAuth (and device-code) strategy. Providers
// without a wired flow return undefined, so the auth resolver gracefully falls
// through to their next candidate method (api_key).
//
// OpenRouter's documented PKCE flow is the working reference (its exchange mints
// a normal API key). Anthropic's subscription OAuth (Claude Pro/Max) is the same
// authorization-code + PKCE shape but yields a refreshable *bearer* token spent
// against the plan — it uses a manual code-paste redirect (Anthropic renders the
// code on a console page rather than accepting an arbitrary loopback).

import type { AuthenticationStrategy } from "./types";
import { OAuthStrategy } from "./oauth-strategy";
import { DeviceCodeStrategy } from "./device-code-strategy";
import { openRouterOAuthFlow } from "../oauth/openrouter";
import { anthropicOAuthFlow } from "../oauth/anthropic";
import { codexOAuthFlow } from "../oauth/codex";

let openRouter: OAuthStrategy | undefined;
let anthropic: OAuthStrategy | undefined;
let codex: OAuthStrategy | undefined;

/** The OAuth (PKCE / authorization-code) strategy for a provider, if any. */
export function makeOAuthStrategy(
  providerId: string,
  _env: NodeJS.ProcessEnv = process.env,
): AuthenticationStrategy | undefined {
  if (providerId === "openrouter") {
    return (openRouter ??= new OAuthStrategy(openRouterOAuthFlow));
  }
  if (providerId === "anthropic") {
    return (anthropic ??= new OAuthStrategy(anthropicOAuthFlow));
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
