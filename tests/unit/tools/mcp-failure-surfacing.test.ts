// ─── P4.5: a dead connector is visible ───
//
// The client has always emitted a typed lifecycle stream. Nobody subscribed,
// and `logger.ts` suppresses stderr while the TUI owns the screen — so a
// connector that died was silent to the user AND to the model, which kept
// planning around tools that were gone.
//
// These tests pin the three consumers of one event: the notice queue the TUI
// drains, the status projection the desktop reads, and the once-per-session
// harness note.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpDiscovery } from "../../../packages/tool-registry/src/mcp/discovery";
import type { McpEvent } from "../../../packages/tool-registry/src/mcp/types";
import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "../../helpers/mock-oauth-mcp-server";

let workspace: string;
let mock: MockOAuthMcpServer;
let prevBackend: string | undefined;
let prevHome: string | undefined;
let home: string;

function writeMcpJson(servers: Record<string, unknown>): void {
  mkdirSync(join(workspace, ".gear"), { recursive: true });
  writeFileSync(join(workspace, ".gear", "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "gear-mcp-surface-ws-"));
  home = mkdtempSync(join(tmpdir(), "gear-mcp-surface-home-"));
  prevBackend = process.env.GEAR_CREDENTIAL_BACKEND;
  prevHome = process.env.GEAR_HOME;
  process.env.GEAR_CREDENTIAL_BACKEND = "file";
  process.env.GEAR_HOME = home;
  mock = await startMockOAuthMcpServer();
});

afterEach(async () => {
  await mock.close();
  if (prevBackend === undefined) delete process.env.GEAR_CREDENTIAL_BACKEND;
  else process.env.GEAR_CREDENTIAL_BACKEND = prevBackend;
  if (prevHome === undefined) delete process.env.GEAR_HOME;
  else process.env.GEAR_HOME = prevHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("connector lifecycle reaches a subscriber", () => {
  test("a connector needing auth emits server-needs-auth, not a thrown string", async () => {
    writeMcpJson({ mocknotion: { type: "http", url: mock.mcpUrl } });
    const events: McpEvent[] = [];
    const discovery = new McpDiscovery(workspace, { onEvent: (e) => events.push(e) });

    const handlers = await discovery.discover();
    // No token: the connector contributes nothing and the SESSION survives.
    expect(handlers).toEqual([]);
    expect(events.map((e) => e.type)).toContain("server-needs-auth");

    const status = discovery.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].needsAuth).toBe(true);
    expect(status[0].health).toBe("down");
    await discovery.stopAll();
  });

  test("a connector that cannot be reached emits server-down with a reason", async () => {
    writeMcpJson({ ghost: { type: "http", url: "http://127.0.0.1:1/mcp" } });
    const events: McpEvent[] = [];
    const discovery = new McpDiscovery(workspace, { onEvent: (e) => events.push(e) });

    await discovery.discover();
    const down = events.find((e) => e.type === "server-down");
    expect(down).toBeDefined();
    expect(down && "reason" in down && down.reason.length).toBeGreaterThan(0);

    const status = discovery.getStatus();
    expect(status[0].name).toBe("ghost");
    expect(status[0].health).toBe("down");
    expect(status[0].lastError).toBeTruthy();
    await discovery.stopAll();
  });

  test("a healthy connector emits server-ready with its tool count", async () => {
    // Authorize first so the server actually comes up.
    const { McpOAuth } = await import("../../../packages/tool-registry/src/mcp/oauth");
    const { openCredentialStore } = await import("../../../packages/shared/src/credential-store");
    const provider = new McpOAuth({
      serverName: "mocknotion",
      serverUrl: mock.mcpUrl,
      store: await openCredentialStore(),
    });
    await provider.login({
      openAuthorizationUrl: async (url) => {
        await fetch(url, { redirect: "follow" }).catch(() => {});
      },
    });

    writeMcpJson({ mocknotion: { type: "http", url: mock.mcpUrl } });
    const events: McpEvent[] = [];
    const discovery = new McpDiscovery(workspace, { onEvent: (e) => events.push(e) });
    const handlers = await discovery.discover();

    // Two tools, plus the one cross-server read_resource the mock's resources
    // capability earns.
    expect(handlers.map((h) => h.schema.name).sort()).toEqual([
      "mcp_mocknotion_delete_page",
      "mcp_mocknotion_search",
      "read_resource",
    ]);
    const ready = events.find((e) => e.type === "server-ready");
    expect(ready).toBeDefined();
    expect(ready && "toolCount" in ready && ready.toolCount).toBe(2);
    expect(discovery.getStatus()[0].needsAuth).toBe(false);
    await discovery.stopAll();
  });

  test("one broken connector does not stop the others", async () => {
    writeMcpJson({
      ghost: { type: "http", url: "http://127.0.0.1:1/mcp" },
      mocknotion: { type: "http", url: mock.mcpUrl },
    });
    const discovery = new McpDiscovery(workspace);
    await discovery.discover();

    const names = discovery
      .getStatus()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["ghost", "mocknotion"]);
    // Both are unusable for different reasons, and BOTH are reported —
    // failing the first must not abandon the scan.
    expect(discovery.getStatus().every((s) => s.health === "down")).toBe(true);
    await discovery.stopAll();
  });

  test("a disabled connector is not started and reports nothing", async () => {
    writeMcpJson({ mocknotion: { type: "http", url: mock.mcpUrl, enabled: false } });
    const events: McpEvent[] = [];
    const discovery = new McpDiscovery(workspace, { onEvent: (e) => events.push(e) });
    expect(await discovery.discover()).toEqual([]);
    expect(events).toEqual([]);
    expect(discovery.getStatus()).toEqual([]);
    await discovery.stopAll();
  });
});
