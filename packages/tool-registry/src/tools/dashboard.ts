// ─── Interactive Dashboards ───
//
// The `interactive_dashboard` tool renders model-authored HTML dashboards
// (reports, metrics, comparisons, live telemetry) in the user's browser,
// served from a loopback-only HTTP server owned by DashboardManager.
//
// Real-time by construction: every open page holds an SSE stream. The model
// pushes new data with action:"update" (no reload — the page's
// window.render(data) re-draws), and a dashboard bound to a workspace JSON
// file via watch_file re-renders whenever that file changes, so a running
// process that writes metrics.json drives a live dashboard for free.
//
// Security posture:
//   - Binds 127.0.0.1 only; every route lives under an unguessable
//     per-process token path (/t/<token>/…) so other local users can't
//     enumerate dashboards.
//   - A strict CSP pins the page offline: no external scripts/fetches, so a
//     hostile page can't exfiltrate report contents. Chart.js is vendored
//     and served locally to make offline-first practical.
//   - watch_file must resolve inside the workspace root (symlink-aware),
//     mirroring the PathGuard rule for file tools.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { CHART_UMD, CHART_UMD_VERSION } from "./assets/chart-umd";

/** Max HTML/data payload accepted from the model (chars). */
const MAX_HTML_CHARS = 1_500_000;
/** Max watch-file size read per poll (bytes). */
const MAX_WATCH_BYTES = 2_000_000;
/** SSE keep-alive comment cadence. */
const PING_MS = 25_000;

interface DashboardRecord {
  id: string;
  title: string;
  /** Model-provided page content (body fragment or full document). */
  html: string;
  /** Last data payload — injected on page load, pushed on updates. */
  data: unknown;
  /** Bumped on every html change; the page reloads when it sees a new one. */
  version: number;
  /** Canonicalized absolute path of the watched JSON file, when bound. */
  watchFile?: string;
  watchMtimeMs?: number;
  watchSize?: number;
  clients: Set<ServerResponse>;
}

export interface DashboardManagerOptions {
  /** Bind host. Loopback only — do not widen without adding real auth. */
  host?: string;
  /** Poll cadence for watch_file bindings (ms). Tests shrink this. */
  watchIntervalMs?: number;
  /** Launch the user's browser on create/open. Default: yes unless BERNE_NO_OPEN=1. */
  openInBrowser?: boolean;
}

export interface DashboardInfo {
  id: string;
  title: string;
  url: string;
  watching?: string;
}

/** Escape text destined for an HTML context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON.stringify safe to embed inside a <script> block. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Open a URL in the platform browser; best-effort, never throws. */
export function openInBrowser(url: string): boolean {
  if (process.env.BERNE_NO_OPEN === "1") return false;
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    // Bun's type shim omits ChildProcess.on; the runtime implements it fully.
    (child as unknown as { on(event: "error", cb: () => void): void }).on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export class DashboardManager {
  private server: Server | null = null;
  private port = 0;
  private readonly host: string;
  private readonly token = randomBytes(16).toString("hex");
  private dashboards = new Map<string, DashboardRecord>();
  private lastId: string | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watchIntervalMs: number;
  private readonly shouldOpen: boolean;
  private starting: Promise<void> | null = null;

  constructor(opts: DashboardManagerOptions = {}) {
    this.host = opts.host ?? "127.0.0.1";
    this.watchIntervalMs = opts.watchIntervalMs ?? 500;
    this.shouldOpen = opts.openInBrowser ?? process.env.BERNE_NO_OPEN !== "1";
  }

  /** The dashboard page URL for an id (server must be started). */
  url(id: string): string {
    return `http://${this.host}:${this.port}/t/${this.token}/d/${id}`;
  }

  /** Info for the most recently created dashboard, if any. */
  last(): DashboardInfo | null {
    if (!this.lastId) return null;
    const rec = this.dashboards.get(this.lastId);
    if (!rec) return null;
    return { id: rec.id, title: rec.title, url: this.url(rec.id), watching: rec.watchFile };
  }

  list(): DashboardInfo[] {
    return [...this.dashboards.values()].map((r) => ({
      id: r.id,
      title: r.title,
      url: this.url(r.id),
      watching: r.watchFile,
    }));
  }

  /** Lazily start the loopback server (idempotent, race-safe). */
  private ensureServer(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise((resolvePromise, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      // Never hold the process open: the CLI must exit cleanly with dashboards
      // still being served — they simply die with the process.
      server.on("connection", (socket) => socket.unref());
      server.once("error", (err) => {
        this.starting = null;
        reject(err);
      });
      server.listen(0, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        this.server = server;
        server.unref();
        this.pingTimer = setInterval(() => this.broadcastPing(), PING_MS);
        this.pingTimer.unref?.();
        resolvePromise();
      });
    });
    return this.starting;
  }

  /**
   * Create (and by default open) a dashboard. `watchFile` binds a workspace
   * JSON file: its parsed contents become the live data feed.
   */
  async create(args: {
    title: string;
    html: string;
    data?: unknown;
    watchFile?: string;
    workspaceRoot: string;
    open?: boolean;
  }): Promise<DashboardInfo> {
    await this.ensureServer();
    const id = randomBytes(4).toString("hex");
    const rec: DashboardRecord = {
      id,
      title: args.title || "Berne dashboard",
      html: args.html,
      data: args.data ?? null,
      version: 1,
      clients: new Set(),
    };
    if (args.watchFile) {
      rec.watchFile = this.resolveWatchFile(args.workspaceRoot, args.watchFile);
      const initial = this.readWatchFile(rec);
      if (initial !== undefined && args.data === undefined) rec.data = initial;
      this.ensureWatchTimer();
    }
    this.dashboards.set(id, rec);
    this.lastId = id;
    const url = this.url(id);
    if (args.open !== false && this.shouldOpen) openInBrowser(url);
    return { id, title: rec.title, url, watching: rec.watchFile };
  }

  /**
   * Update a live dashboard. Data-only updates re-render in place through the
   * page's window.render(data); an html change reloads the page.
   */
  update(
    id: string,
    changes: { html?: string; data?: unknown; title?: string },
  ): DashboardInfo {
    const rec = this.dashboards.get(id);
    if (!rec) throw new Error(`no dashboard with id "${id}" — create one first`);
    if (changes.title) rec.title = changes.title;
    if (changes.data !== undefined) rec.data = changes.data;
    if (typeof changes.html === "string" && changes.html.length > 0) {
      rec.html = changes.html;
      rec.version++;
      this.broadcast(rec, "reload", { version: rec.version });
    } else if (changes.data !== undefined) {
      this.broadcast(rec, "data", rec.data);
    }
    return { id, title: rec.title, url: this.url(id), watching: rec.watchFile };
  }

  /** Re-open a dashboard (default: the last one) in the browser. */
  open(id?: string): DashboardInfo | null {
    const target = id ?? this.lastId;
    if (!target) return null;
    const rec = this.dashboards.get(target);
    if (!rec) return null;
    const url = this.url(target);
    openInBrowser(url);
    return { id: rec.id, title: rec.title, url, watching: rec.watchFile };
  }

  /** Stop serving one dashboard and drop its SSE clients. */
  close(id: string): boolean {
    const rec = this.dashboards.get(id);
    if (!rec) return false;
    for (const res of rec.clients) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.dashboards.delete(id);
    if (this.lastId === id) this.lastId = this.dashboards.keys().next().value ?? null;
    return true;
  }

  /** Shut everything down (engine.close / tests). */
  closeAll(): void {
    for (const id of [...this.dashboards.keys()]) this.close(id);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.watchTimer = null;
    this.pingTimer = null;
    this.server?.close();
    this.server = null;
    this.starting = null;
  }

  // ── Watch-file plumbing ──

  /** Canonicalize and confine a watch path to the workspace root. */
  private resolveWatchFile(workspaceRoot: string, path: string): string {
    const abs = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
    // Canonicalize through symlinks (the freshness-tracker lesson: /var vs
    // /private/var). The file — or even its directory — may not exist yet;
    // fall back progressively so a future metrics file still binds.
    let canonical: string;
    try {
      canonical = realpathSync(abs);
    } catch {
      try {
        canonical = join(realpathSync(dirname(abs)), abs.split("/").pop()!);
      } catch {
        canonical = abs;
      }
    }
    let root: string;
    try {
      root = realpathSync(resolve(workspaceRoot));
    } catch {
      root = resolve(workspaceRoot);
    }
    if (canonical !== root && !canonical.startsWith(root + "/")) {
      throw new Error(`watch_file must be inside the workspace (got ${path})`);
    }
    return canonical;
  }

  /** Read + parse the watched file; undefined when missing/oversized/invalid. */
  private readWatchFile(rec: DashboardRecord): unknown {
    if (!rec.watchFile) return undefined;
    try {
      const st = statSync(rec.watchFile);
      if (!st.isFile() || st.size > MAX_WATCH_BYTES) return undefined;
      rec.watchMtimeMs = st.mtimeMs;
      rec.watchSize = st.size;
      return JSON.parse(readFileSync(rec.watchFile, "utf8"));
    } catch {
      return undefined;
    }
  }

  private ensureWatchTimer(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.pollWatches(), this.watchIntervalMs);
    this.watchTimer.unref?.();
  }

  private pollWatches(): void {
    for (const rec of this.dashboards.values()) {
      if (!rec.watchFile) continue;
      let st;
      try {
        st = statSync(rec.watchFile);
      } catch {
        continue; // not there (yet) — keep waiting
      }
      if (st.mtimeMs === rec.watchMtimeMs && st.size === rec.watchSize) continue;
      const data = this.readWatchFile(rec);
      // Mid-write torn reads parse as garbage — skip; the next poll catches
      // the settled file because mtime/size were already recorded above.
      if (data === undefined) continue;
      rec.data = data;
      this.broadcast(rec, "data", data);
    }
  }

  // ── HTTP plumbing ──

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const parts = url.pathname.split("/").filter(Boolean); // [t, token, ...]
    if (parts[0] !== "t" || parts[1] !== this.token) {
      res.writeHead(404).end("not found");
      return;
    }
    const rest = parts.slice(2);
    if (rest[0] === "vendor" && rest[1] === "chart.umd.js") {
      res
        .writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "max-age=86400",
        })
        .end(CHART_UMD);
      return;
    }
    if (rest[0] === "d" && rest[1]) {
      const rec = this.dashboards.get(rest[1]);
      if (!rec) {
        res.writeHead(404).end("dashboard closed");
        return;
      }
      if (rest[2] === "events") {
        this.attachSse(rec, res);
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // Offline pin: no external scripts/styles/fetches — a page can't
          // exfiltrate report data or pull CDNs. SSE rides connect-src 'self'.
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
            "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
            "connect-src 'self'; base-uri 'none'; form-action 'none'",
        })
        .end(this.buildPage(rec));
      return;
    }
    res.writeHead(404).end("not found");
  }

  private attachSse(rec: DashboardRecord, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`retry: 1500\nevent: hello\ndata: {"version":${rec.version}}\n\n`);
    rec.clients.add(res);
    res.on("close", () => rec.clients.delete(res));
  }

  private broadcast(rec: DashboardRecord, event: "data" | "reload", payload: unknown): void {
    const frame = `event: ${event}\ndata: ${jsonForScript(payload)}\n\n`;
    for (const res of rec.clients) {
      try {
        res.write(frame);
      } catch {
        rec.clients.delete(res);
      }
    }
  }

  private broadcastPing(): void {
    for (const rec of this.dashboards.values()) {
      for (const res of rec.clients) {
        try {
          res.write(`: ping\n\n`);
        } catch {
          rec.clients.delete(res);
        }
      }
    }
  }

  /**
   * Wrap the model's HTML in the page shell: charset/viewport/title, vendored
   * Chart.js, a dark base style, and the live bootstrap (initial data +
   * SSE subscription that re-calls window.render / reloads on html changes).
   */
  private buildPage(rec: DashboardRecord): string {
    const base = `/t/${this.token}/d/${rec.id}`;
    const vendor = `/t/${this.token}/vendor/chart.umd.js`;
    const bootstrap = `
<script>
(function () {
  window.__BERNE_DATA__ = ${jsonForScript(rec.data)};
  var VERSION = ${rec.version};
  function fire(d) {
    try { if (typeof window.render === "function") window.render(d); }
    catch (e) { console.error("dashboard render failed:", e); }
  }
  function boot() { fire(window.__BERNE_DATA__); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  try {
    var es = new EventSource(${JSON.stringify(base)} + "/events");
    es.addEventListener("data", function (ev) {
      try { window.__BERNE_DATA__ = JSON.parse(ev.data); } catch (e) { return; }
      fire(window.__BERNE_DATA__);
    });
    es.addEventListener("reload", function () { location.reload(); });
    es.addEventListener("hello", function (ev) {
      try { if (JSON.parse(ev.data).version !== VERSION) location.reload(); } catch (e) {}
    });
  } catch (e) { console.error("dashboard live channel failed:", e); }
})();
</script>`;

    // Full documents keep their own shell; we still splice in the vendor
    // script + bootstrap so live updates work.
    if (/^\s*(<!doctype|<html)/i.test(rec.html)) {
      const inject = `<script src="${vendor}"></script>${bootstrap}`;
      const i = rec.html.toLowerCase().lastIndexOf("</body>");
      return i === -1
        ? rec.html + inject
        : rec.html.slice(0, i) + inject + rec.html.slice(i);
    }

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rec.title)}</title>
<script src="${vendor}"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100%; }
  body {
    background: #0b0d10; color: #e6e8eb;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
</style>
</head>
<body>
${rec.html}
${bootstrap}
</body>
</html>`;
  }
}

// ─── The interactive_dashboard tool ───

export const INTERACTIVE_DASHBOARD_SCHEMA: ToolSchema = {
  name: "interactive_dashboard",
  version: "0.1.0",
  description:
    "Render an interactive HTML dashboard in the user's browser — for reports, metrics, benchmarks, comparisons, timelines, architecture/data visualizations. Served from a local URL with LIVE updates over SSE. " +
    "Actions: create (html required; opens the browser), update (id required; new data re-renders the open page instantly without reload — use this for real-time/progress; new html reloads it), open (re-open in browser), close. " +
    "HTML contract: provide BODY content only (divs/style/script — no <html>/<head>/<body>; they are added). Everything must be inline and self-contained: NO external URLs, CDNs, fonts, or images — the page runs offline and external requests are blocked. " +
    "Chart.js v" +
    CHART_UMD_VERSION +
    " is preloaded as the global `Chart` — prefer it (<canvas> + new Chart(...)) for charts; hand-rolled SVG is also fine. " +
    "Define window.render(data) to draw everything from the data object: it is called on load with `data` and again on every live update, so keep chart instances in variables and update/destroy them on re-render. " +
    "Pass the numbers in `data` (not hardcoded in markup) so updates flow. For live data from a running process, have it write JSON to a workspace file and set watch_file — the dashboard then updates in real time as the file changes. " +
    "Style: polished dark dashboard (page background #0b0d10) unless the user asks otherwise; responsive layout; readable spacing.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "open", "close"],
        description: "create a new dashboard, update a live one, re-open one, or close one.",
      },
      title: { type: "string", description: "Short dashboard title (tab title + header)." },
      html: {
        type: "string",
        description:
          "Body-only HTML (may include <style>/<script>) defining window.render(data). Required for create.",
      },
      data: {
        type: "object",
        description:
          "JSON data passed to window.render. On update, sending only data live-refreshes the page without reload.",
      },
      watch_file: {
        type: "string",
        description:
          "Workspace-relative JSON file to watch — its parsed contents stream to the page in real time whenever it changes.",
      },
      id: { type: "string", description: "Dashboard id (from create). Required for update/close." },
      open: { type: "boolean", description: "Open the browser on create (default true)." },
    },
    required: ["action"],
  },
  permissionLevel: "auto",
  // "execute" keeps it out of the parallel-safe read pool: creates/updates
  // mutate shared server state and may pop a browser window.
  category: "execute",
};

/** Tolerate models sending data as a JSON string instead of an object. */
function coerceData(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // let the page receive the string — better than dropping it
  }
}

export function createDashboardTool(manager: DashboardManager): ToolHandler {
  return {
    schema: INTERACTIVE_DASHBOARD_SCHEMA,

    validate: (args) => {
      const action = args.action;
      if (action !== "create" && action !== "update" && action !== "open" && action !== "close") {
        return { valid: false, error: "action must be one of: create, update, open, close" };
      }
      if (action === "create") {
        if (typeof args.html !== "string" || !args.html.trim()) {
          return { valid: false, error: "create requires html (body-only HTML content)" };
        }
        if (args.html.length > MAX_HTML_CHARS) {
          return { valid: false, error: `html too large (max ${MAX_HTML_CHARS} chars)` };
        }
      }
      if (action === "update") {
        if (typeof args.id !== "string" || !args.id) {
          return { valid: false, error: "update requires the dashboard id returned by create" };
        }
        if (typeof args.html === "string" && args.html.length > MAX_HTML_CHARS) {
          return { valid: false, error: `html too large (max ${MAX_HTML_CHARS} chars)` };
        }
      }
      if (action === "close" && (typeof args.id !== "string" || !args.id)) {
        return { valid: false, error: "close requires the dashboard id" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (result: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result,
        durationMs: Math.round(performance.now() - start),
      });
      const fail = (error: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error,
        durationMs: Math.round(performance.now() - start),
      });

      try {
        const args = input.args;
        switch (args.action) {
          case "create": {
            const info = await manager.create({
              title: typeof args.title === "string" ? args.title : "Berne dashboard",
              html: args.html as string,
              data: coerceData(args.data),
              watchFile: typeof args.watch_file === "string" ? args.watch_file : undefined,
              workspaceRoot: input.workspaceRoot,
              open: args.open !== false,
            });
            return done(
              JSON.stringify({
                ...info,
                note:
                  "Dashboard is live (opened in the browser). Tell the user the URL. " +
                  "Push new data with action:'update' — the page refreshes instantly.",
              }),
            );
          }
          case "update": {
            const info = manager.update(args.id as string, {
              html: typeof args.html === "string" ? args.html : undefined,
              data: args.data === undefined ? undefined : coerceData(args.data),
              title: typeof args.title === "string" ? args.title : undefined,
            });
            return done(JSON.stringify({ ...info, updated: true }));
          }
          case "open": {
            const info = manager.open(typeof args.id === "string" ? args.id : undefined);
            if (!info) return fail("no dashboard to open — create one first");
            return done(JSON.stringify({ ...info, opened: true }));
          }
          case "close": {
            const closed = manager.close(args.id as string);
            return closed
              ? done(JSON.stringify({ id: args.id, closed: true }))
              : fail(`no dashboard with id "${args.id}"`);
          }
          default:
            return fail("unknown action");
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
