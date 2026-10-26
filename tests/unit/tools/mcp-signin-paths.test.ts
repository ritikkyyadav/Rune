// ─── Sign-in paths the real vendors need, proved against the mock ───
//
// Each of these was found checking live vendor metadata on 2026-10-26, from
// outside and without credentials, while building `/connectors`:
//
//   * a server built to the 2025-03-26 spec publishes no resource metadata;
//     its sign-in is at its own origin. Rune used to stop at "no authorization
//     server advertised".
//   * the spec's first place to look for the metadata is the 401's
//     `resource_metadata` hint, and a sign-in from a picker has no 401 in hand.
//   * a dynamically registered client is registered for one loopback port;
//     the next sign-in listens on another, and most servers match exactly.
//   * a pasted token (GitHub, Render) lives in the keychain and the config
//     names it; it must reach the server, and its absence must read as a
//     sign-in to finish, not an outage.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../../packages/shared/src/credential-store";
import { resetRuneHomeCache } from "../../../packages/shared/src/paths";
import { McpDiscovery } from "../../../packages/tool-registry/src/mcp/discovery";
import { McpOAuth, mcpCredentialAccount } from "../../../packages/tool-registry/src/mcp/oauth";
import { keychainRef, mcpTokenAccount } from "../../../packages/tool-registry/src/mcp/directory";
import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "../../helpers/mock-oauth-mcp-server";

/** A stand-in value; the mock accepts it as a pasted token. */
const FAKE_TOKEN = "test-only-not-a-real-token";

let home: string;
let workspace: string;
let store: FileCredentialStore;
let mock: MockOAuthMcpServer | undefined;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-signin-home-"));
  workspace = mkdtempSync(join(tmpdir(), "rune-signin-ws-"));
  saved = {
    RUNE_HOME: process.env.RUNE_HOME,
    RUNE_CREDENTIAL_BACKEND: process.env.RUNE_CREDENTIAL_BACKEND,
  };
  process.env.RUNE_HOME = home;
  // Never the real keychain.
  process.env.RUNE_CREDENTIAL_BACKEND = "file";
  resetRuneHomeCache();
  store = new FileCredentialStore({ ...process.env, RUNE_HOME: home });
});

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRuneHomeCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** Stand in for the browser: follow the redirect into the loopback. */
const clickAllow = async (url: string): Promise<void> => {
  await fetch(url, { redirect: "follow" }).catch(() => {});
};

const oauth = (m: MockOAuthMcpServer, extra: { callbackPort?: number } = {}) =>
  new McpOAuth({ serverName: "mockserver", serverUrl: m.mcpUrl, store, ...extra });

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe("a server with no resource metadata (2025-03-26)", () => {
  test("signs in at the server's own origin, and sends no resource indicator", async () => {
    mock = await startMockOAuthMcpServer({ legacy: true });
    const tokens = await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    expect(tokens.accessToken).toBe(mock.issuedAccessTokens[0]!);
    expect(mock.registrations).toHaveLength(1);
    // RFC 8707 is a 2025-06-18 feature; a strict older server refuses it.
    expect(mock.authorizeResources).toEqual([null]);
    expect(tokens.resource).toBeUndefined();
  });

  test("a server with metadata keeps its resource indicator", async () => {
    mock = await startMockOAuthMcpServer();
    await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    expect(mock.authorizeResources).toEqual([`${mock.origin}/mcp`]);
  });
});

describe("the 401's resource_metadata hint", () => {
  test("is asked for when the caller has no 401 in hand", async () => {
    // Metadata only at a custom path: the well-known ones 404.
    mock = await startMockOAuthMcpServer({ prmPath: "/meta/resource" });
    const tokens = await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    expect(tokens.accessToken).toBeTruthy();
    expect(mock.requestPaths).toContain("/meta/resource");
  });

  test("a caller that passes one is not asked again", async () => {
    mock = await startMockOAuthMcpServer({ prmPath: "/meta/resource" });
    const hint = `Bearer resource_metadata="${mock.origin}/meta/resource"`;
    await oauth(mock).login({ openAuthorizationUrl: clickAllow, wwwAuthenticate: hint });
    // The POST to /mcp a challenge probe would make never happened.
    expect(mock.requestPaths.filter((p) => p === "/mcp")).toHaveLength(0);
  });
});

describe("a client registered for an earlier loopback port", () => {
  test("is registered again, so a strict server accepts the new redirect", async () => {
    mock = await startMockOAuthMcpServer({ strictRedirects: true });
    await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    // The stored client, recorded as registered for a port no longer in use.
    const raw = await store.get(mcpCredentialAccount("mockserver"));
    const stale = { ...JSON.parse(raw!), redirectUri: "http://localhost:1/callback" };
    await store.set(mcpCredentialAccount("mockserver"), JSON.stringify(stale));

    const again = await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    expect(again.accessToken).toBeTruthy();
    expect(mock.registrations).toHaveLength(2);
    expect(again.clientId).toBe(mock.registrations[1]!);
  });

  test("a token set from before the record is treated the same way", async () => {
    mock = await startMockOAuthMcpServer({ strictRedirects: true });
    await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    const raw = JSON.parse((await store.get(mcpCredentialAccount("mockserver")))!);
    delete raw.redirectUri;
    await store.set(mcpCredentialAccount("mockserver"), JSON.stringify(raw));
    await oauth(mock).login({ openAuthorizationUrl: clickAllow });
    expect(mock.registrations).toHaveLength(2);
  });

  test("the same fixed port reuses the client it registered", async () => {
    mock = await startMockOAuthMcpServer({ strictRedirects: true });
    const port = await freePort();
    await oauth(mock, { callbackPort: port }).login({ openAuthorizationUrl: clickAllow });
    await oauth(mock, { callbackPort: port }).login({ openAuthorizationUrl: clickAllow });
    expect(mock.registrations).toHaveLength(1);
    expect(mock.issuedAccessTokens).toHaveLength(2);
  });
});

describe("a pasted token named in the config", () => {
  function writeUserConfig(name: string, url: string): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          [name]: {
            type: "http",
            url,
            headers: { Authorization: `Bearer ${keychainRef(mcpTokenAccount(name))}` },
          },
        },
      }),
    );
  }

  test("reaches the server from the keychain, and the file never holds it", async () => {
    mock = await startMockOAuthMcpServer({ staticBearer: FAKE_TOKEN });
    writeUserConfig("pasted", mock.mcpUrl);
    await store.set(mcpTokenAccount("pasted"), FAKE_TOKEN);
    const discovery = new McpDiscovery(workspace);
    try {
      const handlers = await discovery.discover();
      expect(handlers.map((h) => h.schema.name)).toContain("mcp_pasted_search");
      expect(discovery.getStatus().find((s) => s.name === "pasted")?.ready).toBe(true);
      // No OAuth was attempted for an entry carrying its own Authorization.
      expect(mock.registrations).toHaveLength(0);
    } finally {
      await discovery.stopAll();
    }
  });

  test("with nothing stored, it is a sign-in to finish and nothing is sent", async () => {
    mock = await startMockOAuthMcpServer({ staticBearer: FAKE_TOKEN });
    writeUserConfig("pasted", mock.mcpUrl);
    const discovery = new McpDiscovery(workspace);
    try {
      expect(await discovery.discover()).toHaveLength(0);
      const status = discovery.getStatus().find((s) => s.name === "pasted")!;
      expect(status.needsAuth).toBe(true);
      expect(status.lastError).toContain("no token stored");
      // An empty "Bearer " was never sent to the vendor.
      expect(mock.requestPaths).not.toContain("/mcp");
    } finally {
      await discovery.stopAll();
    }
  });

  test("restart reads the entry and the keychain again; disconnect takes the tools out", async () => {
    mock = await startMockOAuthMcpServer({ staticBearer: FAKE_TOKEN });
    writeUserConfig("pasted", mock.mcpUrl);
    const discovery = new McpDiscovery(workspace);
    try {
      await discovery.discover();
      expect(discovery.getStatus().find((s) => s.name === "pasted")?.needsAuth).toBe(true);
      await store.set(mcpTokenAccount("pasted"), FAKE_TOKEN);
      expect(await discovery.restart("pasted")).toBe(true);
      expect(discovery.getHandlers().map((h) => h.schema.name)).toContain("mcp_pasted_search");
      expect(await discovery.disconnect("pasted")).toBe(true);
      expect(discovery.getHandlers().map((h) => h.schema.name)).not.toContain("mcp_pasted_search");
      expect(discovery.configured().pasted).toBeDefined();
    } finally {
      await discovery.stopAll();
    }
  });
});
