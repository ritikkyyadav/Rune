import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { McpDiscovery } from "../../../packages/tool-registry/src/mcp/index";

const FIXTURE = join(import.meta.dir, "../../fixtures/mcp/echo-server.ts");

describe("McpDiscovery extraServers (built-in servers)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rune-mcp-extra-"));
    await mkdir(join(dir, ".rune"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("extra servers start without any mcp.json", async () => {
    const discovery = new McpDiscovery(dir, {
      extraServers: { browser: { command: "bun", args: [FIXTURE], autoApprove: ["echo"] } },
    });
    const handlers = await discovery.discover();
    expect(handlers.map((h) => h.schema.name)).toEqual(["mcp_browser_echo"]);
    expect(handlers[0].schema.permissionLevel).toBe("auto");
    const status = discovery.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("browser");
    expect(status[0].ready).toBe(true);
    await discovery.stopAll();
  });

  test("a user mcp.json entry with the same name overrides the built-in", async () => {
    // The built-in points at a nonexistent binary; the user's entry must win,
    // so discovery starts the echo fixture instead of failing.
    await writeFile(
      join(dir, ".rune", "mcp.json"),
      JSON.stringify({ mcpServers: { browser: { command: "bun", args: [FIXTURE] } } }),
    );
    const discovery = new McpDiscovery(dir, {
      extraServers: { browser: { command: "rune-no-such-binary-xyz", args: [] } },
    });
    const handlers = await discovery.discover();
    expect(handlers.map((h) => h.schema.name)).toEqual(["mcp_browser_echo"]);
    expect(discovery.getStatus()[0].ready).toBe(true);
    await discovery.stopAll();
  });

  test("a broken built-in is recorded as down and breaks nothing else", async () => {
    await writeFile(
      join(dir, ".rune", "mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: "bun", args: [FIXTURE] } } }),
    );
    const discovery = new McpDiscovery(dir, {
      extraServers: { browser: { command: "rune-no-such-binary-xyz", args: [] } },
    });
    const handlers = await discovery.discover();
    expect(handlers.map((h) => h.schema.name)).toEqual(["mcp_echo_echo"]);
    const browser = discovery.getStatus().find((s) => s.name === "browser");
    expect(browser?.health).toBe("down");
    expect(browser?.lastError).toBeTruthy();
    await discovery.stopAll();
  });
});
