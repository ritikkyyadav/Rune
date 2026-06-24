#!/usr/bin/env bun
// Minimal stdio MCP server fixture for tests. Newline-delimited JSON-RPC.
// Env knobs:
//   MCP_FIXTURE_FLOOD=1  → write a large stderr burst + a non-JSON stdout line
//                          at startup (exercises the client's stderr drain and
//                          non-JSON stdout skipping; must not deadlock).

const FLOOD = process.env.MCP_FIXTURE_FLOOD === "1";

const tools = [
  {
    name: "echo",
    description: "echo text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

if (FLOOD) {
  // ~150KB of stderr with no reader on the other side would fill the OS pipe
  // buffer and wedge a non-draining client; the hardened client drains it.
  for (let i = 0; i < 2000; i++) process.stderr.write(`fixture log ${i} ${"x".repeat(60)}\n`);
  // Some real servers print banners to stdout — the client must skip non-JSON.
  process.stdout.write("echo-server starting (this line is not JSON)\n");
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg: { id?: number | string; method?: string; params?: any }): void {
  if (msg.id === undefined) return; // notification — nothing to answer
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "echo-fixture", version: "1" },
        },
      });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      break;
    case "tools/call":
      if (msg.params?.name === "echo") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `echo:${msg.params?.arguments?.text}` }] },
        });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
      }
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed input
    }
  }
});

// Keep the process alive until stdin closes.
process.stdin.resume();
