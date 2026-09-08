// ─── The P12.2 gate: the MCP client against real servers ───
//
// Four thousand lines of client — stdio framing, Streamable HTTP, legacy SSE,
// OAuth, pagination, progress, cancellation — and every test of it until now
// spoke to a mock this repository also wrote. A mock agrees with the client
// about the protocol by construction, which is exactly the thing that needed
// checking.
//
// So this test spawns the reference servers the MCP project publishes:
//
//   @modelcontextprotocol/server-filesystem   stdio, 14 tools, no resources
//   @modelcontextprotocol/server-memory       stdio, a mutable knowledge graph
//   @modelcontextprotocol/server-everything    stdio + streamableHttp + sse,
//                                              resources, prompts, progress,
//                                              images, structured content
//
// It needs `npx` and the network the first time (afterwards npm's cache serves
// it), and a free loopback port for the HTTP half. All three are things a CI
// box or a sandboxed shell may not have, so every one of them is PROBED and the
// affected tests skip rather than fail: a red suite that means "no network" is
// a suite people learn to ignore.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "../../packages/tool-registry/src/mcp/client";

const FILESYSTEM = "@modelcontextprotocol/server-filesystem";
const MEMORY = "@modelcontextprotocol/server-memory";
const EVERYTHING = "@modelcontextprotocol/server-everything";

/** npx's first run downloads; every later one is cache-warm and fast. */
const START_MS = 180_000;

const workspace = mkdtempSync(join(tmpdir(), "rune-mcp-live-"));
writeFileSync(join(workspace, "hello.txt"), "live check\n");

const started: McpClient[] = [];
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

afterAll(async () => {
  for (const client of started) await client.stop().catch(() => {});
  for (const proc of spawned) {
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }
  rmSync(workspace, { recursive: true, force: true });
});

async function connect(config: ConstructorParameters<typeof McpClient>[0]): Promise<McpClient> {
  const client = new McpClient(config);
  started.push(client);
  await client.start();
  return client;
}

function stdio(name: string, pkg: string, args: string[] = []): Parameters<typeof connect>[0] {
  return { name, command: "npx", args: ["-y", pkg, ...args] };
}

/**
 * Can we run these servers at all?
 *
 * Probed by actually starting one, because every cheaper proxy lies: `npx
 * --version` succeeds with no network, and a registry ping succeeds behind a
 * proxy that then refuses the tarball.
 */
async function probe(): Promise<string | null> {
  try {
    const client = new McpClient(stdio("probe", FILESYSTEM, [workspace]));
    try {
      await client.start();
      const ok = client.isReady && client.getTools().length > 0;
      return ok ? null : "the filesystem server started but exposed no tools";
    } finally {
      await client.stop().catch(() => {});
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const blocked = await probe();
const live = blocked === null;
if (!live) {
  console.log(`  [mcp-live] skipped — npx/network unavailable: ${blocked}`);
}

/** A loopback port nothing else holds, or null when the shell may not bind. */
function freePort(): number | null {
  try {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port;
    server.stop(true);
    return port;
  } catch {
    return null;
  }
}

describe("MCP live — filesystem over stdio", () => {
  test.skipIf(!live)(
    "handshakes, lists tools, and reads a real file",
    async () => {
      const client = await connect(stdio("files", FILESYSTEM, [workspace]));
      const info = client.getServerInfo();

      expect(client.isReady).toBe(true);
      expect(client.dialect).toBe("stdio");
      expect(info.protocolVersion).toBe("2025-06-18");
      expect(info.serverInfo.name).toBeTruthy();

      const names = client.getTools().map((t) => t.name);
      expect(names).toContain("read_text_file");
      expect(names).toContain("list_directory");

      const listed = await client.callTool("list_directory", { path: workspace });
      expect(listed.isError).toBeFalsy();
      expect(client.flattenContent(listed)).toContain("hello.txt");

      const read = await client.callTool("read_text_file", {
        path: join(workspace, "hello.txt"),
      });
      expect(client.flattenContent(read)).toContain("live check");
    },
    START_MS,
  );

  test.skipIf(!live)(
    "refuses a path outside its roots, as an error result rather than a crash",
    async () => {
      const client = await connect(stdio("files-guard", FILESYSTEM, [workspace]));
      const out = await client.callTool("read_text_file", { path: "/etc/passwd" });
      expect(out.isError).toBe(true);
      expect(client.isReady).toBe(true); // the connector survives its own refusal
    },
    START_MS,
  );
});

describe("MCP live — memory over stdio", () => {
  test.skipIf(!live)(
    "writes and reads back a knowledge graph",
    async () => {
      const client = await connect({
        ...stdio("memory", MEMORY),
        env: { MEMORY_FILE_PATH: join(workspace, "memory.json") },
      });

      expect(client.getTools().map((t) => t.name)).toContain("create_entities");

      const created = await client.callTool("create_entities", {
        entities: [{ name: "Rune", entityType: "project", observations: ["terminal agent"] }],
      });
      expect(created.isError).toBeFalsy();

      const graph = await client.callTool("read_graph", {});
      const text = client.flattenContent(graph);
      expect(text).toContain("Rune");
      expect(text).toContain("terminal agent");
    },
    START_MS,
  );
});

describe("MCP live — everything over stdio", () => {
  test.skipIf(!live)(
    "calls a tool, reads a resource, lists prompts, and receives progress",
    async () => {
      const client = await connect(stdio("everything", EVERYTHING, ["stdio"]));

      expect(client.supportsResources).toBe(true);
      expect(client.supportsPrompts).toBe(true);
      // The server's own operating instructions have been typed since the first
      // handshake; this is the check that they actually arrive.
      expect(client.getInstructions()).toBeTruthy();

      const echoed = await client.callTool("echo", { message: "rune live check" });
      expect(client.flattenContent(echoed)).toContain("rune live check");

      const resources = await client.listResources();
      expect(resources.length).toBeGreaterThan(0);
      const contents = await client.readResource(resources[0]!.uri);
      expect(contents.length).toBeGreaterThan(0);
      expect(contents[0]!.text ?? contents[0]!.blob).toBeTruthy();

      const prompts = await client.listPrompts();
      expect(prompts.length).toBeGreaterThan(0);

      const seen: number[] = [];
      const long = await client.callTool(
        "trigger-long-running-operation",
        { duration: 1, steps: 3 },
        { onProgress: (p) => seen.push(p.progress) },
      );
      expect(long.isError).toBeFalsy();
      expect(seen.length).toBeGreaterThan(0);
    },
    START_MS,
  );

  test.skipIf(!live)(
    "lifts an image result into an attachment rather than a placeholder",
    async () => {
      const client = await connect(stdio("everything-img", EVERYTHING, ["stdio"]));
      const handler = client
        .toToolHandlers()
        .find((h) => h.schema.name === "mcp_everything-img_get-tiny-image");
      expect(handler).toBeDefined();

      const out = await handler!.execute({
        callId: "c1",
        toolName: handler!.schema.name,
        args: {},
      } as never);
      expect(out.success).toBe(true);
      expect(out.attachments?.[0]?.kind).toBe("image");
      expect(out.attachments?.[0]?.mediaType).toBe("image/png");
    },
    START_MS,
  );
});

describe("MCP live — everything over streamable HTTP", () => {
  const port = live ? freePort() : null;
  const canBind = port !== null;
  if (live && !canBind) {
    console.log("  [mcp-live] HTTP skipped — this shell may not bind a loopback port");
  }

  test.skipIf(!live || !canBind)(
    "handshakes over HTTP, keeps a session, and streams progress back",
    async () => {
      const proc = Bun.spawn(["npx", "-y", EVERYTHING, "streamableHttp"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });
      spawned.push(proc);

      const url = `http://127.0.0.1:${port}/mcp`;
      const deadline = Date.now() + 120_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          await fetch(url, { method: "GET" });
          up = true;
          break;
        } catch {
          await Bun.sleep(500);
        }
      }
      expect(up).toBe(true);

      const client = await connect({ name: "everything-http", url });
      expect(client.isReady).toBe(true);
      expect(client.dialect).toBe("http");
      expect(client.getTools().length).toBeGreaterThan(0);

      const echoed = await client.callTool("echo", { message: "http live check" });
      expect(client.flattenContent(echoed)).toContain("http live check");

      const resources = await client.listResources();
      expect(resources.length).toBeGreaterThan(0);

      const seen: number[] = [];
      await client.callTool(
        "trigger-long-running-operation",
        { duration: 1, steps: 3 },
        { onProgress: (p) => seen.push(p.progress) },
      );
      expect(seen.length).toBeGreaterThan(0);
    },
    START_MS,
  );
});

describe("MCP live — everything over the 2024-11-05 SSE pair", () => {
  const port = live ? freePort() : null;
  const canBind = port !== null;

  test.skipIf(!live || !canBind)(
    "falls back from Streamable HTTP without being told to",
    async () => {
      const proc = Bun.spawn(["npx", "-y", EVERYTHING, "sse"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });
      spawned.push(proc);

      const url = `http://127.0.0.1:${port}/sse`;
      const deadline = Date.now() + 120_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          // POST is 404 on this vintage — which is precisely the signal the
          // client reads to switch dialects. Reaching the server is enough.
          const res = await fetch(url, { method: "POST" });
          up = res.status > 0;
          break;
        } catch {
          await Bun.sleep(500);
        }
      }
      expect(up).toBe(true);

      const client = await connect({ name: "everything-sse", url });
      expect(client.isReady).toBe(true);
      // The user configured one URL and never said which protocol vintage it is.
      expect(client.dialect).toBe("sse");

      const echoed = await client.callTool("echo", { message: "sse live check" });
      expect(client.flattenContent(echoed)).toContain("sse live check");
    },
    START_MS,
  );
});
