// ─── LSP server lifecycle manager ───
//
// Owns real language servers (typescript-language-server, pyright,
// rust-analyzer, gopls): lazy spawn on first use per (language, workspace),
// initialize handshake, document sync, and guaranteed teardown — the
// non-negotiable from the build brief is NO zombie processes, so every server
// dies with the manager and a process-exit hook covers hard exits.
//
// Phase-1 policy: servers must already be on PATH. When one is missing, the
// error names the exact install command (the browser tool's self-heal
// pattern) so the model can install it with bash (network: true) and retry.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { JsonRpcConnection } from "./jsonrpc";

export interface ServerSpec {
  id: string;
  command: string[];
  installHint: string;
  languageId: (ext: string) => string;
  /** Server-specific initialize options (e.g. tsserver path resolution). */
  initializationOptions?: (workspaceRoot: string) => unknown;
}

/**
 * Locate a classic tsserver.js for typescript-language-server: the workspace
 * install wins (exact project version), else the global install next to the
 * server binary. TypeScript 7+ (the native rewrite) ships no tsserver.js and
 * silently degrades the server to syntax-only mode — hence 5.x pins in the
 * install hint. Returns undefined to let the server run its own discovery.
 */
function resolveTsserver(workspaceRoot: string): string | undefined {
  const local = join(workspaceRoot, "node_modules", "typescript", "lib", "tsserver.js");
  if (existsSync(local)) return local;
  const bin = Bun.which("typescript-language-server");
  if (bin) {
    try {
      // <root>/node_modules/typescript-language-server/… → <root>/node_modules
      const real = realpathSync(bin);
      const marker = `${sep}node_modules${sep}`;
      const idx = real.lastIndexOf(marker);
      if (idx !== -1) {
        const globalTs = join(
          real.slice(0, idx + marker.length - 1),
          "typescript",
          "lib",
          "tsserver.js",
        );
        if (existsSync(globalTs)) return globalTs;
      }
    } catch {
      // fall through to server-side discovery
    }
  }
  return undefined;
}

const SERVERS: Array<{ extensions: string[]; spec: ServerSpec }> = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    spec: {
      id: "typescript",
      command: ["typescript-language-server", "--stdio"],
      installHint: "npm install -g typescript-language-server typescript@5",
      languageId: (ext) =>
        ext === ".ts" || ext === ".mts" || ext === ".cts"
          ? "typescript"
          : ext === ".tsx"
            ? "typescriptreact"
            : ext === ".jsx"
              ? "javascriptreact"
              : "javascript",
      initializationOptions: (workspaceRoot) => {
        const tsserver = resolveTsserver(workspaceRoot);
        return tsserver ? { tsserver: { path: tsserver } } : undefined;
      },
    },
  },
  {
    extensions: [".py", ".pyi"],
    spec: {
      id: "python",
      command: ["pyright-langserver", "--stdio"],
      installHint: "npm install -g pyright",
      languageId: () => "python",
    },
  },
  {
    extensions: [".rs"],
    spec: {
      id: "rust",
      command: ["rust-analyzer"],
      installHint: "rustup component add rust-analyzer",
      languageId: () => "rust",
    },
  },
  {
    extensions: [".go"],
    spec: {
      id: "go",
      command: ["gopls"],
      installHint: "go install golang.org/x/tools/gopls@latest",
      languageId: () => "go",
    },
  },
];

export type ServerTable = Array<{ extensions: string[]; spec: ServerSpec }>;

/**
 * Process-wide server table override, as JSON in `RUNE_LSP_SERVERS`:
 *
 *   [{ "id": "fake", "extensions": [".ts"], "command": ["bun", "server.ts"] }]
 *
 * The seam exists because post-edit diagnostics have to be measurable without
 * a language server installed: the benchmark suite points this at the fake
 * stdio server in tests/fixtures/lsp so the measurement is deterministic on
 * any machine. It is also the escape hatch for a language whose server is not
 * in the built-in table. Malformed JSON is ignored and the built-in table
 * stands — a typo in an env var must never silently disable code intelligence.
 */
function envServerTable(): ServerTable | null {
  const raw = process.env.RUNE_LSP_SERVERS;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Array<{
      id?: string;
      extensions?: string[];
      command?: string[];
      installHint?: string;
      languageId?: string;
    }>;
    if (!Array.isArray(parsed)) return null;
    const table: ServerTable = [];
    for (const e of parsed) {
      if (!Array.isArray(e?.extensions) || !Array.isArray(e?.command) || e.command.length === 0) {
        continue;
      }
      const languageId = typeof e.languageId === "string" ? e.languageId : (e.id ?? "plaintext");
      table.push({
        extensions: e.extensions.map((x) => String(x).toLowerCase()),
        spec: {
          id: String(e.id ?? "custom"),
          command: e.command.map(String),
          installHint: String(e.installHint ?? `install ${e.command[0]} and put it on PATH`),
          languageId: () => languageId,
        },
      });
    }
    return table.length > 0 ? table : null;
  } catch {
    return null;
  }
}

let cachedTable: ServerTable | null = null;

/** The server table in force for this process (built-in unless overridden). */
export function serverTable(): ServerTable {
  cachedTable ??= envServerTable() ?? SERVERS;
  return cachedTable;
}

/** Test seam: re-read RUNE_LSP_SERVERS after a test changes it. */
export function resetServerTable(): void {
  cachedTable = null;
}

export interface LspPosition {
  /** 1-based, the way models and editors talk about lines. */
  line: number;
  /** 1-based character column. */
  column: number;
}

export interface LspLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  preview?: string;
}

export interface LspDiagnostic {
  severity: string;
  line: number;
  column: number;
  message: string;
  source?: string;
}

interface RunningServer {
  spec: ServerSpec;
  conn: JsonRpcConnection;
  /** uri → { version, mtimeMs } for open documents. */
  open: Map<string, { version: number; mtimeMs: number }>;
  /** uri → latest publishDiagnostics payload (undefined = none received yet). */
  diagnostics: Map<string, LspDiagnostic[]>;
  /** uri → waiters for the next diagnostics publish. */
  diagnosticWaiters: Map<string, Array<() => void>>;
}

const SEVERITIES = ["", "error", "warning", "information", "hint"];

export class LspServerManager {
  private servers = new Map<string, RunningServer>();
  private initTimeoutMs: number;
  private requestTimeoutMs: number;
  private override: ServerTable | null;

  constructor(
    opts: {
      initTimeoutMs?: number;
      requestTimeoutMs?: number;
      /** Test seam: replace the real server table with fixtures. */
      serversOverride?: ServerTable;
    } = {},
  ) {
    this.initTimeoutMs = opts.initTimeoutMs ?? 15_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 8_000;
    this.override = opts.serversOverride ?? null;
    // Hard-exit teardown: kill synchronously, no awaiting allowed here.
    process.on("exit", () => this.killAll());
  }

  /**
   * Resolved per lookup, not pinned at construction: the manager is a process
   * singleton that outlives any one workspace, so a RUNE_LSP_SERVERS change
   * (followed by resetServerTable) has to reach it. An explicit
   * serversOverride still wins for its whole life.
   */
  private table(): ServerTable {
    return this.override ?? serverTable();
  }

  /** Which server spec (if any) handles this file. */
  specFor(file: string): ServerSpec | null {
    const ext = extname(file).toLowerCase();
    for (const { extensions, spec } of this.table()) {
      if (extensions.includes(ext)) return spec;
    }
    return null;
  }

  supportedExtensions(): string[] {
    return this.table().flatMap((s) => s.extensions);
  }

  async definition(file: string, pos: LspPosition, workspaceRoot: string): Promise<LspLocation[]> {
    return this.locationsRequest("textDocument/definition", file, pos, workspaceRoot);
  }

  async references(file: string, pos: LspPosition, workspaceRoot: string): Promise<LspLocation[]> {
    const server = await this.ensureServer(file, workspaceRoot);
    const uri = await this.ensureOpen(server, file);
    const result = await server.conn.request(
      "textDocument/references",
      {
        textDocument: { uri },
        position: toLspPosition(pos),
        context: { includeDeclaration: true },
      },
      this.requestTimeoutMs,
    );
    return normalizeLocations(result).slice(0, 50);
  }

  async hover(file: string, pos: LspPosition, workspaceRoot: string): Promise<string> {
    const server = await this.ensureServer(file, workspaceRoot);
    const uri = await this.ensureOpen(server, file);
    const result = (await server.conn.request(
      "textDocument/hover",
      { textDocument: { uri }, position: toLspPosition(pos) },
      this.requestTimeoutMs,
    )) as { contents?: unknown } | null;
    return flattenHover(result?.contents);
  }

  /**
   * Diagnostics for a file. ensureOpen already waited for the first publish;
   * an empty array means the server analyzed the file and found nothing,
   * which is only claimable once a publish actually arrived.
   */
  async diagnostics(
    file: string,
    workspaceRoot: string,
  ): Promise<{ diagnostics: LspDiagnostic[]; analyzed: boolean }> {
    const server = await this.ensureServer(file, workspaceRoot);
    const uri = await this.ensureOpen(server, file);
    const published = server.diagnostics.get(uri);
    return { diagnostics: published ?? [], analyzed: published !== undefined };
  }

  /** Graceful shutdown of every server (engine stop, tests). */
  async stopAll(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.conn.stop()));
  }

  /** Synchronous kill for the process-exit hook. */
  killAll(): void {
    for (const server of this.servers.values()) server.conn.kill();
    this.servers.clear();
  }

  private async locationsRequest(
    method: string,
    file: string,
    pos: LspPosition,
    workspaceRoot: string,
  ): Promise<LspLocation[]> {
    const server = await this.ensureServer(file, workspaceRoot);
    const uri = await this.ensureOpen(server, file);
    const result = await server.conn.request(
      method,
      { textDocument: { uri }, position: toLspPosition(pos) },
      this.requestTimeoutMs,
    );
    return normalizeLocations(result);
  }

  private async ensureServer(file: string, workspaceRoot: string): Promise<RunningServer> {
    const spec = this.specFor(file);
    if (!spec) {
      throw new Error(
        `No language server configured for "${extname(file)}" files. ` +
          `Supported: ${this.supportedExtensions().join(", ")}`,
      );
    }
    const key = `${spec.id} ${workspaceRoot}`;
    const existing = this.servers.get(key);
    if (existing && !existing.conn.isDead()) return existing;
    if (existing) this.servers.delete(key);

    if (Bun.which(spec.command[0]) === null) {
      throw new Error(
        `${spec.command[0]} is not installed. Install it with bash (network: true): ` +
          `${spec.installHint} — then retry this call.`,
      );
    }

    const conn = new JsonRpcConnection(spec.command, workspaceRoot);
    const server: RunningServer = {
      spec,
      conn,
      open: new Map(),
      diagnostics: new Map(),
      diagnosticWaiters: new Map(),
    };
    conn.onNotification("textDocument/publishDiagnostics", (params) => {
      const p = params as {
        uri?: string;
        diagnostics?: Array<{
          severity?: number;
          range?: { start?: { line?: number; character?: number } };
          message?: string;
          source?: string;
        }>;
      };
      if (!p?.uri) return;
      server.diagnostics.set(
        p.uri,
        (p.diagnostics ?? []).map((d) => ({
          severity: SEVERITIES[d.severity ?? 1] ?? "error",
          line: (d.range?.start?.line ?? 0) + 1,
          column: (d.range?.start?.character ?? 0) + 1,
          message: d.message ?? "",
          source: d.source,
        })),
      );
      const waiters = server.diagnosticWaiters.get(p.uri);
      if (waiters) {
        server.diagnosticWaiters.delete(p.uri);
        for (const wake of waiters) wake();
      }
    });

    try {
      await conn.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(workspaceRoot).href,
          workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).href, name: "workspace" }],
          initializationOptions: spec.initializationOptions?.(workspaceRoot),
          capabilities: {
            textDocument: {
              publishDiagnostics: {},
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: {},
              references: {},
            },
          },
        },
        this.initTimeoutMs,
      );
    } catch (err) {
      // A server that failed its handshake must not outlive the failure —
      // it was never registered, so stopAll() could never reach it (the
      // orphan held a live event loop for 2 minutes in the first live proof).
      conn.kill();
      throw err;
    }
    conn.notify("initialized", {});

    this.servers.set(key, server);
    return server;
  }

  /**
   * Open (or re-open after on-disk changes) the document on the server.
   * LSP servers answer position queries against the text THEY hold — serving
   * stale content silently returns wrong definitions, so freshness is keyed
   * to the file's mtime.
   */
  private async ensureOpen(server: RunningServer, file: string): Promise<string> {
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
    const uri = pathToFileURL(file).href;
    const mtimeMs = statSync(file).mtimeMs;
    const existing = server.open.get(uri);
    if (existing && existing.mtimeMs === mtimeMs) return uri;

    if (existing) {
      server.conn.notify("textDocument/didClose", { textDocument: { uri } });
      server.diagnostics.delete(uri);
    }
    const ext = extname(file).toLowerCase();
    server.conn.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: server.spec.languageId(ext),
        version: (existing?.version ?? 0) + 1,
        text: readFileSync(file, "utf-8"),
      },
    });
    server.open.set(uri, { version: (existing?.version ?? 0) + 1, mtimeMs });

    // Semantic readiness gate: servers load their project graph AFTER didOpen
    // and answer positional queries from a syntax-only fallback until then —
    // which returns confidently WRONG results (a definition that stops at the
    // import statement). The first publishDiagnostics for the document is the
    // reliable "analysis is live" signal, so wait for it (bounded — a server
    // that never publishes costs one wait, not a hang).
    if (!server.diagnostics.has(uri)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        // A caller may abandon this wait (the post-edit feedback race gives
        // up at 1.5s) — the bound must not keep the process alive on its own.
        (timer as { unref?: () => void }).unref?.();
        const waiters = server.diagnosticWaiters.get(uri) ?? [];
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        server.diagnosticWaiters.set(uri, waiters);
      });
    }
    return uri;
  }
}

// ─── Conversions ───

function toLspPosition(pos: LspPosition): { line: number; character: number } {
  // Models speak 1-based; LSP is 0-based UTF-16. Column conversion is naive
  // (code units ≈ chars) — exact for the ASCII that dominates source code.
  return { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.column - 1) };
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    // Location { uri, range } or LocationLink { targetUri, targetRange }.
    const uri = (item.uri ?? item.targetUri) as string | undefined;
    const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as
      { start?: { line?: number; character?: number }; end?: { line?: number } } | undefined;
    if (!uri || !range?.start) continue;
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    const line = (range.start.line ?? 0) + 1;
    out.push({
      file,
      line,
      column: (range.start.character ?? 0) + 1,
      endLine: range.end?.line !== undefined ? range.end.line + 1 : undefined,
      preview: previewLine(file, line),
    });
  }
  return out;
}

function previewLine(file: string, line: number): string | undefined {
  try {
    const abs = isAbsolute(file) ? file : join(process.cwd(), file);
    const text = readFileSync(abs, "utf-8").split("\n")[line - 1];
    return text?.trim().slice(0, 200);
  } catch {
    return undefined;
  }
}

function flattenHover(contents: unknown): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(flattenHover).join("\n\n");
  const obj = contents as { value?: string; language?: string };
  if (typeof obj.value === "string") {
    return obj.language ? `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` : obj.value;
  }
  return "";
}
