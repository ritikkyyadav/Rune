// ─── Auth layer barrel ───
// Strategy port + concrete strategies + the provider→strategy registry.
export type { AuthMethod, ResolvedCredential, AuthContext, AuthenticationStrategy } from "./types";
export { AuthError } from "./types";
export { ApiKeyStrategy } from "./api-key-strategy";
export { LocalEndpointStrategy } from "./local-endpoint-strategy";
export { CloudChainStrategy, probeCloudChain, chainSetupHint } from "./chain-strategy";
export type { ChainProbe } from "./chain-strategy";
export {
  OAuthStrategy,
  base64url,
  generatePkce,
  randomState,
  startLoopback,
  type OAuthFlow,
  type ExchangeResult,
  type Loopback,
} from "./oauth-strategy";
export {
  DeviceCodeStrategy,
  type DeviceFlow,
  type DeviceAuthorization,
  type DevicePoll,
} from "./device-code-strategy";
export { getStrategy } from "./registry";
export { makeOAuthStrategy, makeDeviceStrategy } from "./oauth-registry";
export { openRouterOAuthFlow } from "../oauth/openrouter";
export { anthropicOAuthFlow } from "../oauth/anthropic";
