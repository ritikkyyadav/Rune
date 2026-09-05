/**
 * Anthropic sign-in: the request must match the first-party client exactly.
 *
 * The bug: "Authorization failed - Invalid request format", every time.
 *
 * The first suspect was encoding — claude.com 307s to claude.ai and
 * re-serializes `%20` to `+` on the way. That is real, and it is NOT the cause:
 * the first-party Claude Code client takes the same hop and signs in fine.
 *
 * The actual defect was the SCOPE. Read out of the installed Claude Code binary
 * (2.1.198), it keeps two disjoint sets and picks by flow:
 *
 *   console   = ["org:create_api_key", "user:profile"]
 *   claude.ai = ["user:profile", "user:inference",
 *                "user:sessions:claude_code", "user:mcp_servers",
 *                "user:file_upload"]
 *
 * Rune sent `org:create_api_key user:profile user:inference` to the CLAUDE.AI
 * endpoint — an org-level API-key-minting scope spliced into a personal
 * subscription sign-in, missing three of that flow's own scopes. "Invalid
 * request format" reads like a malformed query and actually means "these are
 * not the scopes this flow grants".
 *
 * So these tests pin the request against the first-party constants, which is
 * the only standard that has ever mattered here.
 */

import { describe, test, expect } from "bun:test";
import { anthropicOAuthFlow } from "../../../packages/llm-gateway/src/oauth/anthropic";
import { successPage } from "../../../packages/llm-gateway/src/auth/oauth-strategy";

const url = () =>
  anthropicOAuthFlow.authorizeUrl({
    redirectUri: "http://localhost:45123/callback",
    codeChallenge: "CHALLENGE",
    state: "STATE",
  });

const paramOf = (name: string) => {
  const raw = url().split("?")[1]!;
  const hit = raw.split("&").find((p) => p.startsWith(`${name}=`));
  return hit!.slice(name.length + 1);
};

describe("the Anthropic authorize URL", () => {
  test("uses the claude.ai endpoint, paired with a LOOPBACK redirect", () => {
    // The client keeps two flows and they cannot be mixed. Pro/Max is
    // claude.ai + loopback; console is platform.claude.com + the manual
    // paste-the-code page. Rune pairing claude.ai with the manual redirect is
    // what "Invalid request format" meant, and it survived three fixes aimed at
    // the query string because the query string was never wrong.
    const u = new URL(url());
    expect(u.origin + u.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:45123/callback");
  });

  test("is a loopback flow, not a manual paste-the-code one", () => {
    expect(anthropicOAuthFlow.redirect ?? "loopback").toBe("loopback");
    expect(anthropicOAuthFlow.manualRedirectUri).toBeUndefined();
  });

  test("sends the first-party scope set, whole", () => {
    // `Ovn` in the client: the deduped union of its two lists. Two earlier
    // attempts guessed at plausible-looking subsets and both were refused.
    const scopes = paramOf("scope").replace(/\+/g, " ");
    expect(decodeURIComponent(scopes).split(" ")).toEqual([
      "org:create_api_key",
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  test("scope separators are + — URLSearchParams, exactly as the client does it", () => {
    const scope = paramOf("scope");
    expect(scope).toContain("+");
    expect(scope).not.toContain("%20");
  });

  test("colons inside a scope stay encoded", () => {
    expect(paramOf("scope").startsWith("org%3Acreate_api_key")).toBe(true);
  });

  test("carries the PKCE params the flow depends on", () => {
    const u = url();
    expect(u).toContain("code=true");
    expect(u).toContain("code_challenge_method=S256");
    expect(u).toContain("response_type=code");
  });
});

describe("the page you land on after signing in", () => {
  test("names what was actually connected", () => {
    expect(successPage("Claude Pro / Max")).toContain("connected to Claude Pro / Max");
  });

  test("carries the Rune mark inline, so it needs no network", () => {
    const html = successPage("Anthropic");
    expect(html).toContain("<svg");
    expect(html).toContain("Rune");
    // Served from localhost after an auth redirect: an external fetch here
    // would be both slow and a needless third party in the flow.
    expect(/https?:\/\//.test(html)).toBe(false);
  });

  test("reads in dark mode too", () => {
    // A browser opened from a dark terminal should not flashbang the person
    // who just signed in.
    expect(successPage("X")).toContain("prefers-color-scheme:dark");
  });

  test("escapes the provider label", () => {
    const html = successPage('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("falls back to something sensible with no label", () => {
    expect(successPage()).toContain("your account");
  });
});
