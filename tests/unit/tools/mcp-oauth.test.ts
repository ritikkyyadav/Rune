// ─── P4.2: OAuth 2.1 for MCP connectors, end to end ───
//
// Against a local server that implements RFC 9728 / 8414 / 7591 / 7636 / 8707
// the way the real ones do. The browser step is replaced by a direct fetch of
// the authorization URL — the mock then redirects to the loopback exactly as a
// consent screen does after a person clicks Allow, so everything downstream of
// the click is the production path.
//
// What must hold:
//   * a 401 carries the metadata pointer, and discovery follows it
//   * the client registers dynamically and does PKCE S256 (verified server-side)
//   * the token lands in the credential store under `mcp:<server>`
//   * an expired token refreshes without the user noticing
//   * a refresh that fails marks the SERVER unavailable, never the session

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../../packages/shared/src/credential-store";
import { McpClient } from "../../../packages/tool-registry/src/mcp/client";
import {
  McpOAuth,
  mcpCredentialAccount,
  parseWwwAuthenticate,
  protectedResourceUrls,
  authorizationServerUrls,
  discoverProtectedResource,
  discoverAuthorizationServer,
} from "../../../packages/tool-registry/src/mcp/oauth";
import type { McpEvent } from "../../../packages/tool-registry/src/mcp/types";
import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "../../helpers/mock-oauth-mcp-server";

let home: string;
let store: FileCredentialStore;
let mock: MockOAuthMcpServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "gear-mcp-oauth-"));
  store = new FileCredentialStore({ ...process.env, GEAR_HOME: home });
  mock = await startMockOAuthMcpServer();
});

afterEach(async () => {
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

/** Stand in for the browser: fetch the authorize URL and follow the redirect. */
const clickAllow = async (url: string): Promise<void> => {
  // `redirect: "follow"` walks the 302 straight into the loopback server,
  // which is exactly what a browser does.
  await fetch(url, { redirect: "follow" }).catch(() => {
    // The loopback closes as soon as it has the code; a torn connection here
    // is normal and the captured code is what matters.
  });
};

function oauth(): McpOAuth {
  return new McpOAuth({ serverName: "mocknotion", serverUrl: mock.mcpUrl, store });
}

// ─── The parsing and discovery primitives ───

describe("OAuth metadata parsing", () => {
  test("parses the WWW-Authenticate resource_metadata pointer", () => {
    const parsed = parseWwwAuthenticate(
      'Bearer realm="mock", error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"',
    );
    expect(parsed.scheme).toBe("bearer");
    expect(parsed.params.resource_metadata).toBe(
      "https://x/.well-known/oauth-protected-resource/mcp",
    );
    expect(parsed.params.error).toBe("invalid_token");
  });

  test("an absent or malformed header yields no params rather than throwing", () => {
    expect(parseWwwAuthenticate(null).params).toEqual({});
    expect(parseWwwAuthenticate("Bearer").scheme).toBe("bearer");
  });

  test("well-known URLs insert the segment after the host, per RFC 9728", () => {
    expect(protectedResourceUrls("https://mcp.notion.com/mcp")).toEqual([
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.notion.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerUrls("https://auth.example.com")).toContain(
      "https://auth.example.com/.well-known/oauth-authorization-server",
    );
    expect(authorizationServerUrls("https://auth.example.com")).toContain(
      "https://auth.example.com/.well-known/openid-configuration",
    );
  });

  test("discovery walks resource metadata to the authorization server", async () => {
    const resource = await discoverProtectedResource(mock.mcpUrl);
    expect(resource?.authorization_servers?.[0]).toBe(mock.origin);
    const as = await discoverAuthorizationServer(mock.origin);
    expect(as?.token_endpoint).toBe(`${mock.origin}/token`);
    expect(as?.registration_endpoint).toBe(`${mock.origin}/register`);
    expect(as?.code_challenge_methods_supported).toContain("S256");
  });
});

// ─── The flow ───

describe("MCP OAuth 2.1 flow", () => {
  test("a 401 leads to registration, PKCE, a token, and a working tool call", async () => {
    const events: McpEvent[] = [];

    // 1. Without a token the connector reports needing auth — and does NOT
    //    throw, because an unauthorized connector is a missing capability.
    const before = new McpClient({
      name: "mocknotion",
      url: mock.mcpUrl,
      auth: oauth(),
      onEvent: (e) => events.push(e),
    });
    await before.start();
    expect(before.isReady).toBe(false);
    expect(before.needsAuthentication).toBe(true);
    expect(events.map((e) => e.type)).toContain("server-needs-auth");
    await before.stop();

    // 2. The flow itself. The mock verifies PKCE S256 server-side, so a token
    //    coming back at all proves the challenge/verifier pair was real.
    const provider = oauth();
    const tokens = await provider.login({
      openAuthorizationUrl: clickAllow,
      wwwAuthenticate: `Bearer resource_metadata="${mock.origin}/.well-known/oauth-protected-resource/mcp"`,
    });
    expect(tokens.accessToken).toStartWith("at-");
    expect(tokens.refreshToken).toStartWith("rt-");
    expect(mock.registrations).toHaveLength(1);
    expect(tokens.clientId).toBe(mock.registrations[0]);
    // RFC 8707: the token is bound to this resource, not to "the internet".
    expect(tokens.resource).toBe(`${mock.origin}/mcp`);

    // 3. It is in the credential store under mcp:<server>.
    const raw = await store.get(mcpCredentialAccount("mocknotion"));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).accessToken).toBe(tokens.accessToken);

    // 4. A session now connects and calls a tool.
    const after = new McpClient({ name: "mocknotion", url: mock.mcpUrl, auth: oauth() });
    await after.start();
    expect(after.isReady).toBe(true);
    expect(after.needsAuthentication).toBe(false);
    expect(after.getTools().map((t) => t.name).sort()).toEqual(["delete_page", "search"]);

    const result = await after.callTool("search", { query: "hello" });
    expect(result.isError).toBeFalsy();
    expect(after.flattenContent(result)).toContain("search ok");
    expect(mock.authorizedCalls).toBe(1);
    await after.stop();
  });

  test("an expired access token refreshes transparently mid-session", async () => {
    const provider = oauth();
    await provider.login({ openAuthorizationUrl: clickAllow });
    const first = mock.issuedAccessTokens.length;

    const client = new McpClient({ name: "mocknotion", url: mock.mcpUrl, auth: oauth() });
    await client.start();
    expect(client.isReady).toBe(true);

    // The server revokes every token it has minted; the next request 401s.
    mock.expireAccessTokens();
    const result = await client.callTool("search", { query: "after expiry" });

    // The transport refreshed and retried — the user sees a normal result.
    expect(result.isError).toBeFalsy();
    expect(client.flattenContent(result)).toContain("search ok");
    expect(mock.issuedAccessTokens.length).toBeGreaterThan(first);
    expect(client.needsAuthentication).toBe(false);
    await client.stop();
  });

  test("a refresh that fails marks the server unavailable, not the session", async () => {
    const provider = oauth();
    await provider.login({ openAuthorizationUrl: clickAllow });

    const events: McpEvent[] = [];
    const client = new McpClient({
      name: "mocknotion",
      url: mock.mcpUrl,
      auth: oauth(),
      onEvent: (e) => events.push(e),
    });
    await client.start();
    expect(client.isReady).toBe(true);

    // The grant is revoked at the authorization server: no way back without a
    // human. This is the case that used to take the whole session down.
    mock.expireAccessTokens();
    mock.breakRefresh();

    const result = await client.callTool("search", { query: "revoked" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("gear mcp login mocknotion");
    expect(client.needsAuthentication).toBe(true);
    expect(events.some((e) => e.type === "server-needs-auth")).toBe(true);
    // The tools are gone, the process is fine.
    expect(client.getTools()).toEqual([]);
    await client.stop();
  });

  test("logout removes the stored token and the connector needs auth again", async () => {
    const provider = oauth();
    await provider.login({ openAuthorizationUrl: clickAllow });
    expect(await provider.hasCredentials()).toBe(true);

    await provider.logout();
    expect(await store.get(mcpCredentialAccount("mocknotion"))).toBeNull();

    const client = new McpClient({ name: "mocknotion", url: mock.mcpUrl, auth: oauth() });
    await client.start();
    expect(client.needsAuthentication).toBe(true);
    await client.stop();
  });

  test("reconnect brings a connector back after a login without restarting the session", async () => {
    const client = new McpClient({ name: "mocknotion", url: mock.mcpUrl, auth: oauth() });
    await client.start();
    expect(client.needsAuthentication).toBe(true);

    await oauth().login({ openAuthorizationUrl: clickAllow });

    expect(await client.reconnect()).toBe(true);
    expect(client.isReady).toBe(true);
    expect(client.getTools()).toHaveLength(2);
    await client.stop();
  });

  test("a server offering no registration and no configured client_id says so plainly", async () => {
    const bare = await startMockOAuthMcpServer({ offerRegistration: false });
    try {
      const provider = new McpOAuth({
        serverName: "bare",
        serverUrl: bare.mcpUrl,
        store,
      });
      await expect(provider.login({ openAuthorizationUrl: clickAllow })).rejects.toThrow(
        /no dynamic client registration/,
      );
    } finally {
      await bare.close();
    }
  });

  test("a pre-registered client_id works when registration is unavailable", async () => {
    const bare = await startMockOAuthMcpServer({
      offerRegistration: false,
      staticClientId: "preconfigured-client",
    });
    try {
      const provider = new McpOAuth({
        serverName: "bare",
        serverUrl: bare.mcpUrl,
        store,
        clientId: "preconfigured-client",
      });
      const tokens = await provider.login({ openAuthorizationUrl: clickAllow });
      expect(tokens.clientId).toBe("preconfigured-client");
      expect(bare.registrations).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});
