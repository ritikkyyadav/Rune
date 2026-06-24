import { describe, test, expect } from "bun:test";
import { join } from "path";
import { McpClient } from "../../../packages/tool-registry/src/mcp/index";

const FIXTURE = join(import.meta.dir, "../../fixtures/mcp/echo-server.ts");

describe("McpClient over stdio", () => {
  test("handshake discovers tools and callTool round-trips", async () => {
    const client = new McpClient({ name: "echo", command: "bun", args: [FIXTURE] });
    await client.start();

    expect(client.isReady).toBe(true);
    expect(client.kind).toBe("stdio");
    expect(client.getTools().map((t) => t.name)).toEqual(["echo"]);
    expect(client.getServerInfo().protocolVersion).toBe("2025-06-18");
    expect(client.getServerInfo().serverInfo.name).toBe("echo-fixture");

    const res = await client.callTool("echo", { text: "hi" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("echo:hi");

    await client.stop();
  });

  test("a missing command fails start with a clear error (no hang)", async () => {
    const client = new McpClient({
      name: "bad",
      command: "alan-no-such-binary-xyz-123",
      args: [],
    });
    await expect(client.start()).rejects.toThrow();
    await client.stop();
  });

  test("survives a stderr flood and non-JSON stdout without deadlocking", async () => {
    const client = new McpClient({
      name: "flood",
      command: "bun",
      args: [FIXTURE],
      env: { MCP_FIXTURE_FLOOD: "1" },
    });
    await client.start();
    expect(client.isReady).toBe(true);
    // The non-JSON banner on stdout must not have been mis-parsed as a message,
    // and the stderr burst must not have wedged the handshake.
    const res = await client.callTool("echo", { text: "ok" });
    expect(res.content[0].text).toBe("echo:ok");
    await client.stop();
  });

  test("validation blocks calls missing required params", async () => {
    const client = new McpClient({ name: "echo", command: "bun", args: [FIXTURE] });
    await client.start();
    const res = await client.callTool("echo", {}); // missing `text`
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Missing required param");
    await client.stop();
  });
});
