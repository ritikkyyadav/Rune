// ─── The Phase 4 gate: connecting a service is one command ───
//
//   rune mcp add <mock> && rune mcp login <mock>
//
// completes OAuth against a real (local) OAuth-protected MCP server, and a
// session then calls one of its tools. The whole path runs through `runMcp` —
// the same function `rune mcp` dispatches to — with only the browser click
// replaced by a direct fetch of the authorization URL.
//
// Also proves the other half of the gate: `rune mcp doctor` reports a stopped
// server as down, with a non-zero exit code.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcp } from "../../packages/orchestrator/src/bin/mcp-cli";
import { McpDiscovery } from "../../packages/tool-registry/src/mcp/discovery";
import { mcpCredentialAccount } from "../../packages/tool-registry/src/mcp/oauth";
import { resetRuneHomeCache } from "../../packages/shared/src/paths";
import { startMockOAuthMcpServer, type MockOAuthMcpServer } from "../helpers/mock-oauth-mcp-server";

const SERVER = "mocknotion";

let home: string;
let workspace: string;
let mock: MockOAuthMcpServer;
let prevHome: string | undefined;
let prevBackend: string | undefined;
let prevRegistry: string | undefined;
let output: string[];
let writeSpy: typeof process.stdout.write;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "rune-mcp-cli-home-"));
  workspace = mkdtempSync(join(tmpdir(), "rune-mcp-cli-ws-"));
  prevHome = process.env.RUNE_HOME;
  prevBackend = process.env.RUNE_CREDENTIAL_BACKEND;
  prevRegistry = process.env.RUNE_MCP_REGISTRY;
  process.env.RUNE_HOME = home;
  // Never touch the real keychain, and never reach the public registry.
  process.env.RUNE_CREDENTIAL_BACKEND = "file";
  process.env.RUNE_MCP_REGISTRY = "off";
  resetRuneHomeCache();
  mock = await startMockOAuthMcpServer();

  // The CLI writes to stdout; capture it so assertions can read what a person
  // would have seen.
  output = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = writeSpy;
  await mock.close();
  if (prevHome === undefined) delete process.env.RUNE_HOME;
  else process.env.RUNE_HOME = prevHome;
  if (prevBackend === undefined) delete process.env.RUNE_CREDENTIAL_BACKEND;
  else process.env.RUNE_CREDENTIAL_BACKEND = prevBackend;
  if (prevRegistry === undefined) delete process.env.RUNE_MCP_REGISTRY;
  else process.env.RUNE_MCP_REGISTRY = prevRegistry;
  resetRuneHomeCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const printed = (): string => output.join("");

/** Stand in for the browser: follow the 302 into the loopback. */
const clickAllow = async (url: string): Promise<void> => {
  await fetch(url, { redirect: "follow" }).catch(() => {
    // The loopback closes as soon as it has the code.
  });
};

describe("rune mcp add + login, end to end", () => {
  test("add writes the entry, login completes OAuth, and a session calls a tool", async () => {
    // ── rune mcp add <url> --name mocknotion ──
    const addCode = await runMcp(["add", mock.mcpUrl, "--name", SERVER], {
      name: SERVER,
      workspace,
      scope: "workspace",
    });
    expect(addCode).toBe(0);
    expect(printed()).toContain("added mocknotion");

    const configPath = join(workspace, ".rune", "mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.mcpServers[SERVER].url).toBe(mock.mcpUrl);

    // ── rune mcp login mocknotion ──
    output.length = 0;
    const loginCode = await runMcp(
      ["login", SERVER],
      { workspace },
      {
        openAuthorizationUrl: clickAllow,
      },
    );
    expect(loginCode).toBe(0);
    expect(printed()).toContain("connected");
    // Dynamic client registration + PKCE actually happened on the server side.
    expect(mock.registrations).toHaveLength(1);
    expect(mock.issuedAccessTokens).toHaveLength(1);

    // The token is in the store under mcp:<server>.
    const credFile = join(home, "credentials.json");
    expect(existsSync(credFile)).toBe(true);
    const creds = JSON.parse(readFileSync(credFile, "utf8"));
    const account = mcpCredentialAccount(SERVER);
    const blob = creds[account] ?? creds[`rune:${account}`];
    expect(JSON.stringify(creds)).toContain(account);
    if (blob) expect(JSON.parse(blob).accessToken).toBe(mock.issuedAccessTokens[0]);

    // ── a session now calls one of its tools ──
    const discovery = new McpDiscovery(workspace);
    const handlers = await discovery.discover();
    const search = handlers.find((h) => h.schema.name === `mcp_${SERVER}_search`);
    expect(search).toBeDefined();

    const result = await search!.execute({
      callId: "c1",
      toolName: search!.schema.name,
      args: { query: "quarterly plan" },
    });
    expect(result.success).toBe(true);
    expect(result.result).toContain("search ok");
    expect(mock.authorizedCalls).toBeGreaterThanOrEqual(1);
    await discovery.stopAll();
  });

  test("list shows the connector as authorized and up", async () => {
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], { name: SERVER, workspace });
    await runMcp(["login", SERVER], { workspace }, { openAuthorizationUrl: clickAllow });

    output.length = 0;
    expect(await runMcp(["list"], { workspace })).toBe(0);
    const text = printed();
    expect(text).toContain(SERVER);
    expect(text).toContain("up");
    expect(text).toContain("authorized");
    expect(text).toContain("2 tools");
  });

  test("doctor reports a stopped server as down and exits non-zero", async () => {
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], { name: SERVER, workspace });
    await runMcp(["login", SERVER], { workspace }, { openAuthorizationUrl: clickAllow });

    // A healthy doctor first, so "down" is a change and not the only state.
    output.length = 0;
    expect(await runMcp(["doctor"], { workspace })).toBe(0);
    expect(printed()).toContain("every connector is up");

    // Now stop the server the way a real one dies: it just goes away.
    await mock.close();

    output.length = 0;
    const code = await runMcp(["doctor"], { workspace });
    expect(code).toBe(1);
    const text = printed();
    expect(text).toContain(SERVER);
    expect(text).toContain("down");
    expect(text).toContain("need attention");
  });

  test("doctor names the login command for a connector that has no token", async () => {
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], { name: SERVER, workspace });

    output.length = 0;
    const code = await runMcp(["doctor"], { workspace });
    expect(code).toBe(1);
    const text = printed();
    expect(text).toContain("needs login");
    expect(text).toContain(`rune mcp login ${SERVER}`);
  });

  test("workspace scope wins over user scope for the same name", async () => {
    // The same connector in both scopes, pointed at different endpoints.
    await runMcp(["add", "https://user.example.com/mcp", "--name", SERVER], {
      name: SERVER,
      scope: "user",
      workspace,
    });
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], {
      name: SERVER,
      scope: "workspace",
      workspace,
    });

    output.length = 0;
    await runMcp(["list"], { workspace });
    const text = printed();
    expect(text).toContain(mock.mcpUrl);
    expect(text).not.toContain("https://user.example.com/mcp");
    expect(text).toContain("shadows user");
  });

  test("disable keeps the entry and stops the connection", async () => {
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], { name: SERVER, workspace });
    expect(await runMcp(["disable", SERVER], { workspace })).toBe(0);

    const written = JSON.parse(readFileSync(join(workspace, ".rune", "mcp.json"), "utf8"));
    expect(written.mcpServers[SERVER].enabled).toBe(false);

    const discovery = new McpDiscovery(workspace);
    expect(await discovery.discover()).toEqual([]);
    await discovery.stopAll();

    // …and enable brings it back, without re-adding.
    expect(await runMcp(["enable", SERVER], { workspace })).toBe(0);
    const again = new McpDiscovery(workspace);
    const handlers = await again.discover();
    // No token yet, so the connector is present but unauthorized — the point
    // is that discovery tried it again at all.
    expect(again.getStatus().map((s) => s.name)).toContain(SERVER);
    expect(handlers.length).toBe(0);
    await again.stopAll();
  });

  test("remove drops the entry but keeps the token, and says so", async () => {
    await runMcp(["add", mock.mcpUrl, "--name", SERVER], { name: SERVER, workspace });
    await runMcp(["login", SERVER], { workspace }, { openAuthorizationUrl: clickAllow });

    output.length = 0;
    expect(await runMcp(["remove", SERVER], { workspace })).toBe(0);
    const text = printed();
    expect(text).toContain("removed");
    expect(text).toContain(`rune mcp logout ${SERVER}`);

    // logout then actually forgets it.
    output.length = 0;
    expect(await runMcp(["logout", SERVER], { workspace })).toBe(0);
    expect(printed()).toContain("forgot the stored token");
  });

  test("adding an unknown catalog name suggests near misses instead of failing blankly", async () => {
    output.length = 0;
    const code = await runMcp(["add", "notionn"], { workspace });
    expect(code).toBe(1);
    const text = printed();
    expect(text).toContain("no connector named");
    expect(text).toContain("notion");
  });
});
