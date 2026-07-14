// A minimal LSP server speaking JSON-RPC over stdio — the deterministic
// stand-in for typescript-language-server in unit tests. Behavior:
//  - answers initialize/shutdown
//  - textDocument/definition → one fixed location in the opened file
//  - textDocument/references → two locations
//  - textDocument/hover → a markdown signature
//  - didOpen → publishes one diagnostic for the file (async, next tick)
//  - anything with "SLOW" in the command line: never answers definition
//    (exercises the client timeout)
//  - --mute: never publishes diagnostics (exercises the post-edit feedback
//    budget — the readiness gate must give up, not hang the edit)

const slow = process.argv.includes("--slow");
const mute = process.argv.includes("--mute");

let buffer = Buffer.alloc(0);

function send(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(msg: { id?: number; method?: string; params?: Record<string, unknown> }): void {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
  if (msg.method === "textDocument/didOpen") {
    if (mute) return;
    const doc = msg.params?.textDocument as { uri?: string } | undefined;
    if (doc?.uri) {
      const uri = doc.uri;
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            diagnostics: [
              {
                severity: 1,
                range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
                message: "fake error from fixture",
                source: "fake-lsp",
              },
            ],
          },
        });
      }, 30);
    }
    return;
  }
  if (msg.method === "textDocument/definition") {
    if (slow) return; // never answer — client must time out, not hang
    const doc = (msg.params?.textDocument ?? {}) as { uri?: string };
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          uri: doc.uri,
          range: { start: { line: 9, character: 2 }, end: { line: 9, character: 12 } },
        },
      ],
    });
    return;
  }
  if (msg.method === "textDocument/references") {
    const doc = (msg.params?.textDocument ?? {}) as { uri?: string };
    const loc = (line: number) => ({
      uri: doc.uri,
      range: { start: { line, character: 0 }, end: { line, character: 5 } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: [loc(1), loc(4)] });
    return;
  }
  if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: { language: "typescript", value: "function fake(): void" } },
    });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf-8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf-8");
    buffer = buffer.slice(headerEnd + 4 + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed test input
    }
  }
});
