// ─── Strategy registry ───
// provider id + method → the strategy instance that implements it. Strategies are
// stateless singletons (all state lives in the injected AuthContext), so one
// instance each is enough. OAuth is provider-specific (OpenRouter's PKCE flow is
// the working reference); device-code is a headless fallback for OAuth providers.

import type { AuthMethod } from "@rune/shared";
import type { AuthenticationStrategy } from "./types";
import { ApiKeyStrategy } from "./api-key-strategy";
import { LocalEndpointStrategy } from "./local-endpoint-strategy";
import { CloudChainStrategy } from "./chain-strategy";
import { makeOAuthStrategy, makeDeviceStrategy } from "./oauth-registry";

const API_KEY = new ApiKeyStrategy();
const LOCAL = new LocalEndpointStrategy();
const CHAIN = new CloudChainStrategy();

/**
 * Resolve the strategy for a (method, provider). Returns undefined when a
 * provider doesn't support the requested method (e.g. "oauth" for a key-only
 * provider) so callers can fall back to the next candidate method.
 */
export function getStrategy(
  method: AuthMethod,
  providerId: string,
): AuthenticationStrategy | undefined {
  switch (method) {
    case "api_key":
      return API_KEY;
    case "local":
      return LOCAL;
    // The cloud routes (bedrock / vertex / azure-openai) authenticate from the
    // machine's own AWS/GCP/Azure credentials. One strategy covers all three
    // because the shape is identical — probe, report, store nothing.
    case "chain":
      return CHAIN;
    case "oauth":
      return makeOAuthStrategy(providerId);
    case "device":
      return makeDeviceStrategy(providerId);
  }
}
