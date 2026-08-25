import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { McpClient, McpDiscovery } from "../../../packages/tool-registry/src/mcp/index";

// ─── Configurable Streamable-HTTP MCP mock ───
// One mock with mutable `state` flags so each test drives the behavior it needs.

const ECHO = {
  name: "echo",
  description: "echo text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const DANGER = { name: "danger", description: "needs confirm", inputSchema: { type: "object" } };

interface MockState {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  toolPages: Array<Array<Record<string, unknown>>>;
  /** When set (after a list_changed), tools/list returns this single page. */
  nextTools: Array<Record<string, unknown>> | null;
  callMode: "json" | "progress" | "listChanged" | "hang" | "nonText";
  expireSessionOnce: boolean;
  sessionCounter: number;
  received: {
    methods: string[];
    protocolVersionHeaders: string[];
    cancelledRequestIds: Array<number | string>;
    cursors: Array<string | undefined>;
  };
}

function startMock(initial: Partial<MockState> = {}) {
  const state: MockState = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: true } },
    toolPages: [[ECHO, DANGER]],
    nextTools: null,
    callMode: "json",
    expireSessionOnce: false,
    sessionCounter: 0,
    received: { methods: [], protocolVersionHeaders: [], cancelledRequestIds: [], cursors: [] },
    ...initial,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });

      const body = (await req.json()) as { id?: number | string; method: string; params?: any };
      state.received.methods.push(body.method);
      const pv = req.headers.get("mcp-protocol-version");
      if (pv) state.received.protocolVersionHeaders.push(pv);

      const sid = `sess-${state.sessionCounter || 1}`;
      const headers = { "content-type": "application/json", "mcp-session-id": sid };
      const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers,
        });
      const sse = (messages: unknown[]) =>
        new Response(messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(""), {
          status: 200,
          headers: { ...headers, "content-type": "text/event-stream" },
        });

      // Notifications (no id) — just acknowledge, recording cancellations.
      if (body.id === undefined) {
        if (body.method === "notifications/cancelled") {
          state.received.cancelledRequestIds.push(body.params?.requestId);
        }
        return new Response(null, { status: 202, headers });
      }

      switch (body.method) {
        case "initialize":
          state.sessionCounter++;
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: state.protocolVersion,
                capabilities: state.capabilities,
                serverInfo: { name: "mock", version: "1" },
              },
            }),
            {
              status: 200,
              headers: { ...headers, "mcp-session-id": `sess-${state.sessionCounter}` },
            },
          );
        case "ping":
          return json({});
        case "tools/list": {
          const cursor = body.params?.cursor as string | undefined;
          state.received.cursors.push(cursor);
          if (state.nextTools) return json({ tools: state.nextTools });
          const idx = cursor ? Number(cursor) : 0;
          const page = state.toolPages[idx] ?? [];
          const hasNext = idx + 1 < state.toolPages.length;
          return json(hasNext ? { tools: page, nextCursor: String(idx + 1) } : { tools: page });
        }
        case "tools/call": {
          if (state.expireSessionOnce) {
            state.expireSessionOnce = false;
            return new Response("session gone", { status: 404, headers });
          }
          const token = body.params?._meta?.progressToken;
          const result = {
            content: [{ type: "text", text: `echoed:${body.params?.arguments?.text}` }],
          };
          if (state.callMode === "hang") {
            await new Promise((r) => setTimeout(r, 400));
            return json(result);
          }
          if (state.callMode === "progress") {
            return sse([
              {
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token, progress: 0.5, total: 1, message: "halfway" },
              },
              { jsonrpc: "2.0", id: body.id, result },
            ]);
          }
          if (state.callMode === "listChanged") {
            state.nextTools = [ECHO]; // tools shrank to just echo
            return sse([
              { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
              { jsonrpc: "2.0", id: body.id, result },
            ]);
          }
          if (state.callMode === "nonText") {
            return json({
              content: [
                { type: "text", text: "caption" },
                { type: "image", mimeType: "image/png", data: "AAAA" },
              ],
            });
          }
          return json(result);
        }
        default:
          return json({});
      }
    },
  });

  return { server, url: `http://localhost:${server.port}/mcp`, state };
}

describe("MCP hardening — protocol negotiation", () => {
  let mock: ReturnType<typeof startMock>;
  afterEach(() => mock?.server.stop(true));

  test("rejects an unsupported protocol version", async () => {
    mock = startMock({ protocolVersion: "1999-01-01" });
    const client = new McpClient({ name: "old", url: mock.url });
    await expect(client.start()).rejects.toThrow(/unsupported MCP protocol version/);
    await client.stop();
  });

  test("accepts a supported older version and sends it as a header", async () => {
    mock = startMock({ protocolVersion: "2024-11-05" });
    const client = new McpClient({ name: "v", url: mock.url });
    await client.start();
    expect(client.getServerInfo().protocolVersion).toBe("2024-11-05");
    await client.callTool("echo", { text: "x" });
    // Every request after initialize carries the negotiated version header.
    expect(mock.state.received.protocolVersionHeaders).toContain("2024-11-05");
    await client.stop();
  });
});

describe("MCP hardening — discovery & execution", () => {
  let mock: ReturnType<typeof startMock>;
  afterEach(() => mock?.server.stop(true));

  test("tools/list pagination accumulates every page", async () => {
    mock = startMock({ toolPages: [[ECHO], [DANGER]] });
    const client = new McpClient({ name: "paged", url: mock.url });
    await client.start();
    expect(
      client
        .getTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["danger", "echo"]);
    expect(mock.state.received.cursors).toContain("1"); // requested the 2nd page
    await client.stop();
  });

  test("non-text content is rendered, not dropped", async () => {
    mock = startMock({ callMode: "nonText" });
    const client = new McpClient({ name: "media", url: mock.url });
    await client.start();
    const handler = client.toToolHandlers().find((h) => h.schema.name === "mcp_media_echo")!;
    const out = await handler.execute({
      toolName: "mcp_media_echo",
      callId: "c",
      sessionId: "s",
      workspaceRoot: "/tmp",
      args: { text: "x" },
    });
    expect(out.result).toContain("caption");
    expect(out.result).toContain("[image image/png");
    await client.stop();
  });

  test("progress notifications reach the onProgress callback", async () => {
    mock = startMock({ callMode: "progress" });
    const client = new McpClient({ name: "prog", url: mock.url });
    await client.start();
    const seen: number[] = [];
    await client.callTool("echo", { text: "x" }, { onProgress: (p) => seen.push(p.progress) });
    expect(seen).toContain(0.5);
    await client.stop();
  });

  test("live tools/list_changed refreshes tools and fires the callback", async () => {
    mock = startMock({ callMode: "listChanged" });
    let changed = 0;
    const client = new McpClient({ name: "live", url: mock.url, onToolsChanged: () => changed++ });
    await client.start();
    expect(client.getTools().length).toBe(2);
    await client.callTool("echo", { text: "x" }); // SSE carries list_changed
    // Debounced refresh (250ms) then a fresh tools/list returning the shrunk set.
    await new Promise((r) => setTimeout(r, 400));
    expect(client.getTools().map((t) => t.name)).toEqual(["echo"]);
    expect(changed).toBeGreaterThan(0);
    await client.stop();
  });

  test("HTTP session expiry triggers a transparent re-initialize + retry", async () => {
    mock = startMock({ expireSessionOnce: true });
    const client = new McpClient({ name: "exp", url: mock.url });
    await client.start();
    const res = await client.callTool("echo", { text: "x" });
    expect(res.content[0].text).toBe("echoed:x");
    // initialize ran twice: once at start, once after the 404.
    expect(mock.state.received.methods.filter((m) => m === "initialize").length).toBe(2);
    await client.stop();
  });

  test("aborting a call sends notifications/cancelled and rejects", async () => {
    mock = startMock({ callMode: "hang" });
    const client = new McpClient({ name: "cancel", url: mock.url });
    await client.start();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(client.callTool("echo", { text: "x" }, { signal: ac.signal })).rejects.toThrow(
      /aborted/,
    );
    // The server received our cancellation notification.
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.state.received.cancelledRequestIds.length).toBeGreaterThan(0);
    await client.stop();
  });
});

describe("MCP hardening — config validation & collisions", () => {
  let mock: ReturnType<typeof startMock>;
  let dir: string;

  beforeEach(async () => {
    mock = startMock();
    dir = await mkdtemp(join(tmpdir(), "gear-mcp-h-"));
    await mkdir(join(dir, ".gear"), { recursive: true });
  });
  afterEach(async () => {
    mock.server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("a misconfigured server is reported but siblings still load", async () => {
    const cfg = {
      mcpServers: {
        good: { type: "http", url: mock.url },
        bad: { args: ["nothing"] }, // neither command nor url
      },
    };
    await writeFile(join(dir, ".gear", "mcp.json"), JSON.stringify(cfg));

    const discovery = new McpDiscovery(dir);
    const handlers = await discovery.discover();
    // The good server's tools loaded.
    expect(handlers.map((h) => h.schema.name).sort()).toEqual(["mcp_good_danger", "mcp_good_echo"]);

    const status = discovery.getStatus();
    const bad = status.find((s) => s.name === "bad");
    expect(bad?.health).toBe("down");
    expect(bad?.lastError).toContain("command");
    await discovery.stopAll();
  });

  test("name collisions across servers are disambiguated", async () => {
    // "a.b" and "a_b" both sanitize to the same prefixed name → suffix the dupe.
    const cfg = {
      mcpServers: {
        "a.b": { type: "http", url: mock.url },
        a_b: { type: "http", url: mock.url },
      },
    };
    await writeFile(join(dir, ".gear", "mcp.json"), JSON.stringify(cfg));

    const discovery = new McpDiscovery(dir);
    const handlers = await discovery.discover();
    const names = handlers.map((h) => h.schema.name);
    // No duplicates, and the collisions got numeric suffixes.
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => /_2$/.test(n))).toBe(true);
    await discovery.stopAll();
  });

  test("malformed mcp.json yields no servers (and does not throw)", async () => {
    await writeFile(join(dir, ".gear", "mcp.json"), "{ not valid json ");
    const discovery = new McpDiscovery(dir);
    expect(await discovery.discover()).toEqual([]);
    await discovery.stopAll();
  });
});
