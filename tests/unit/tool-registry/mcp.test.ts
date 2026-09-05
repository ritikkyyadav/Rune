import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { McpClient, McpDiscovery } from "../../../packages/tool-registry/src/mcp/index";

// ─── Minimal Streamable-HTTP MCP server for tests ───

interface MockServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  received: { methods: string[]; authHeaders: string[]; sessionIds: string[] };
}

function startMockServer(): MockServer {
  const received = {
    methods: [] as string[],
    authHeaders: [] as string[],
    sessionIds: [] as string[],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });

      const body = (await req.json()) as { id?: number; method: string; params?: any };
      received.methods.push(body.method);
      const auth = req.headers.get("authorization");
      if (auth) received.authHeaders.push(auth);
      const sid = req.headers.get("mcp-session-id");
      if (sid) received.sessionIds.push(sid);

      const headers = { "content-type": "application/json", "mcp-session-id": "sess-123" };

      // Notifications carry no id — just acknowledge.
      if (body.id === undefined) return new Response(null, { status: 202, headers });

      let result: unknown;
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "mock", version: "1" },
        };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "echo",
              description: "echo back text",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            { name: "danger", description: "needs confirm", inputSchema: { type: "object" } },
          ],
        };
      } else if (body.method === "tools/call") {
        result = { content: [{ type: "text", text: `echoed:${body.params?.arguments?.text}` }] };
      } else {
        result = {};
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers,
      });
    },
  });
  return { server, url: `http://localhost:${server.port}/mcp`, received };
}

describe("McpClient over Streamable HTTP", () => {
  let mock: MockServer;
  beforeEach(() => {
    mock = startMockServer();
  });
  afterEach(() => {
    mock.server.stop(true);
  });

  test("handshake discovers tools and callTool round-trips", async () => {
    const client = new McpClient({
      name: "mock",
      url: mock.url,
      headers: { Authorization: "Bearer abc" },
    });
    await client.start();

    expect(client.isReady).toBe(true);
    expect(client.kind).toBe("http");
    expect(
      client
        .getTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["danger", "echo"]);

    const res = await client.callTool("echo", { text: "hi" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("echoed:hi");

    // Auth header forwarded on every request; session id echoed after initialize.
    expect(mock.received.authHeaders.length).toBeGreaterThan(0);
    expect(mock.received.authHeaders.every((h) => h === "Bearer abc")).toBe(true);
    expect(mock.received.sessionIds).toContain("sess-123");
    expect(mock.received.methods[0]).toBe("initialize");

    await client.stop();
  });

  test("validation blocks calls missing required params", async () => {
    const client = new McpClient({ name: "mock", url: mock.url });
    await client.start();
    const res = await client.callTool("echo", {}); // missing `text`
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Missing required param");
    await client.stop();
  });

  test("toToolHandlers prefixes names and honors autoApprove", async () => {
    const client = new McpClient({ name: "mock", url: mock.url });
    await client.start();

    const handlers = client.toToolHandlers((name) => name === "echo");
    const echo = handlers.find((h) => h.schema.name === "mcp_mock_echo");
    const danger = handlers.find((h) => h.schema.name === "mcp_mock_danger");
    expect(echo?.schema.permissionLevel).toBe("auto");
    expect(danger?.schema.permissionLevel).toBe("confirm");

    const out = await echo!.execute({
      toolName: "mcp_mock_echo",
      callId: "c",
      sessionId: "s",
      workspaceRoot: "/tmp",
      args: { text: "yo" },
    });
    expect(out.success).toBe(true);
    expect(out.result).toBe("echoed:yo");

    await client.stop();
  });
});

describe("McpDiscovery", () => {
  let mock: MockServer;
  let dir: string;

  beforeEach(async () => {
    mock = startMockServer();
    dir = await mkdtemp(join(tmpdir(), "rune-mcp-"));
    await mkdir(join(dir, ".rune"), { recursive: true });
  });
  afterEach(async () => {
    mock.server.stop(true);
    await rm(dir, { recursive: true, force: true });
    delete process.env.MCP_TEST_TOKEN;
  });

  test("interpolates ${ENV} in headers and applies autoApprove list", async () => {
    process.env.MCP_TEST_TOKEN = "secret-xyz";
    const cfg = {
      mcpServers: {
        mock: {
          type: "http",
          url: mock.url,
          headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" },
          autoApprove: ["echo"],
        },
      },
    };
    await writeFile(join(dir, ".rune", "mcp.json"), JSON.stringify(cfg));

    const discovery = new McpDiscovery(dir);
    const handlers = await discovery.discover();

    expect(handlers.map((h) => h.schema.name).sort()).toEqual(["mcp_mock_danger", "mcp_mock_echo"]);
    expect(handlers.find((h) => h.schema.name === "mcp_mock_echo")?.schema.permissionLevel).toBe(
      "auto",
    );
    expect(handlers.find((h) => h.schema.name === "mcp_mock_danger")?.schema.permissionLevel).toBe(
      "confirm",
    );

    // The ${MCP_TEST_TOKEN} token was interpolated before reaching the server.
    expect(mock.received.authHeaders).toContain("Bearer secret-xyz");

    const status = discovery.getStatus();
    expect(status[0].kind).toBe("http");
    expect(status[0].toolCount).toBe(2);
    expect(status[0].health).toBe("healthy");

    await discovery.stopAll();
  });

  test("missing .rune/mcp.json → no handlers", async () => {
    const discovery = new McpDiscovery(dir);
    expect(await discovery.discover()).toEqual([]);
  });
});
