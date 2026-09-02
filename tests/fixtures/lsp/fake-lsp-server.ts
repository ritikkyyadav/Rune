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
//
// Diagnostic shapes for the post-edit feedback tests (P10.1), chosen with
// --case=<name>. Every one derives its payload from arguments or from the
// document text, so no test depends on a real language server:
//  - default: one error, "fake error from fixture", at line 3
//  - --case=typecheck: a tiny content-derived type check — a line matching
//    `: number = "…"` (or `: string = <digits>`) is an error, a line with an
//    unused `const _unused` is a warning. This is the shape post-edit
//    diagnostics exist for: the syntax pass parses it fine, only a
//    type-aware checker objects.
//  - --case=mixed: warnings published BEFORE errors on the wire, so the
//    renderer's error-first ordering is testable independently of the
//    server's own order
//  - --case=many: 25 errors + 5 warnings, for the 20-line truncation bound
//  - --case=noisy: one error plus one hint and one information, which must
//    never reach the block
//  - --publish-delay=<ms>: hold the publish this long (the 2s budget)

const slow = process.argv.includes("--slow");
const mute = process.argv.includes("--mute");
const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const kase = flag("case", "default");
const publishDelayMs = Number(flag("publish-delay", "30"));

interface WireDiagnostic {
  severity: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  source?: string;
}

const at = (line: number, character = 4): WireDiagnostic["range"] => ({
  start: { line, character },
  end: { line, character: character + 5 },
});

/** The diagnostics this fixture publishes for a document, by case. */
function diagnosticsFor(text: string): WireDiagnostic[] {
  if (kase === "typecheck") {
    const out: WireDiagnostic[] = [];
    text.split("\n").forEach((line, i) => {
      if (/:\s*number\s*=\s*["'`]/.test(line)) {
        out.push({
          severity: 1,
          range: at(i, Math.max(0, line.indexOf("="))),
          message: "Type 'string' is not assignable to type 'number'.",
          source: "fake-ts",
        });
      } else if (/:\s*string\s*=\s*-?\d/.test(line)) {
        out.push({
          severity: 1,
          range: at(i, Math.max(0, line.indexOf("="))),
          message: "Type 'number' is not assignable to type 'string'.",
          source: "fake-ts",
        });
      }
      if (/const\s+_unused\b/.test(line)) {
        out.push({
          severity: 2,
          range: at(i),
          message: "'_unused' is declared but its value is never read.",
          source: "fake-ts",
        });
      }
    });
    return out;
  }
  if (kase === "mixed") {
    // Deliberately warnings first on the wire.
    return [
      { severity: 2, range: at(50), message: "warning fifty", source: "fake-lsp" },
      { severity: 2, range: at(10), message: "warning ten", source: "fake-lsp" },
      { severity: 1, range: at(40), message: "error forty", source: "fake-lsp" },
      { severity: 1, range: at(20), message: "error twenty", source: "fake-lsp" },
    ];
  }
  if (kase === "many") {
    const out: WireDiagnostic[] = [];
    for (let i = 1; i <= 25; i++) {
      out.push({ severity: 1, range: at(i), message: `error ${i}`, source: "fake-lsp" });
    }
    for (let i = 1; i <= 5; i++) {
      out.push({ severity: 2, range: at(100 + i), message: `warning ${i}`, source: "fake-lsp" });
    }
    return out;
  }
  if (kase === "noisy") {
    return [
      { severity: 4, range: at(1), message: "a hint nobody asked for", source: "fake-lsp" },
      { severity: 1, range: at(2), message: "the only real error", source: "fake-lsp" },
      { severity: 3, range: at(3), message: "merely informational", source: "fake-lsp" },
    ];
  }
  return [{ severity: 1, range: at(2), message: "fake error from fixture", source: "fake-lsp" }];
}

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
    const doc = msg.params?.textDocument as { uri?: string; text?: string } | undefined;
    if (doc?.uri) {
      const uri = doc.uri;
      const diagnostics = diagnosticsFor(doc.text ?? "");
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics },
        });
      }, publishDelayMs);
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
