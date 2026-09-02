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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPathInside } from "@gear/shared";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { CHART_UMD, CHART_UMD_VERSION } from "./assets/chart-umd";
import { CHART_DEFAULTS_JS, FAB_CSS, THEME_CSS, specShellHtml } from "./dashboard-theme";

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
  /** Declarative spec, when the dashboard was built through the spec path. */
  spec?: unknown;
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
  /** Launch the user's browser on create/open. Default: yes unless GEAR_NO_OPEN=1. */
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
  if (process.env.GEAR_NO_OPEN === "1") return false;
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

/** Filesystem-safe name derived from a dashboard title. */
function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "dashboard";
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const raw =
    typeof v === "object"
      ? String(
          (v as { chip?: unknown; text?: unknown }).chip ?? (v as { text?: unknown }).text ?? "",
        )
      : String(v);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/**
 * Best-effort CSV from a spec (KPIs, tables, chart series, progress) or, for
 * html dashboards, from array-shaped data. Null when nothing is tabular.
 */
export function buildCsv(spec: unknown, data: unknown): string | null {
  const sections: string[] = [];
  const s = spec as {
    kpis?: Array<{ label?: unknown; value?: unknown; delta?: unknown }>;
    items?: Array<{
      type?: string;
      title?: unknown;
      columns?: unknown[];
      rows?: unknown[][] | unknown[];
      cols?: unknown[];
      values?: unknown[][];
      chart?: { labels?: unknown[]; series?: Array<{ name?: unknown; data?: unknown[] }> };
      items?: Array<{
        label?: unknown;
        value?: unknown;
        title?: unknown;
        sub?: unknown;
        time?: unknown;
      }>;
    }>;
  } | null;

  if (s && typeof s === "object") {
    if (Array.isArray(s.kpis) && s.kpis.length > 0) {
      const rows = s.kpis.map((k) => [k.label, k.value, k.delta].map(csvCell).join(","));
      sections.push(["Metric,Value,Delta", ...rows].join("\n"));
    }
    for (const item of s.items ?? []) {
      const title = item.title ? `# ${String(item.title)}` : null;
      if (Array.isArray(item.columns) && Array.isArray(item.rows)) {
        const head = item.columns.map(csvCell).join(",");
        const rows = item.rows.map((r) =>
          Array.isArray(r) ? r.map(csvCell).join(",") : csvCell(r),
        );
        sections.push([title, head, ...rows].filter((x): x is string => x !== null).join("\n"));
      } else if (item.chart?.series && Array.isArray(item.chart.series)) {
        const labels = Array.isArray(item.chart.labels) ? item.chart.labels : [];
        const series = item.chart.series;
        const head = ["Label", ...series.map((x, i) => csvCell(x.name ?? `Series ${i + 1}`))].join(
          ",",
        );
        const n = Math.max(
          labels.length,
          ...series.map((x) => (Array.isArray(x.data) ? x.data.length : 0)),
        );
        const rows: string[] = [];
        for (let i = 0; i < n; i++) {
          rows.push(
            [csvCell(labels[i] ?? i), ...series.map((x) => csvCell(x.data?.[i]))].join(","),
          );
        }
        sections.push([title, head, ...rows].filter((x): x is string => x !== null).join("\n"));
      } else if (
        (item.type === "progress" || item.type === "list" || item.type === "timeline") &&
        Array.isArray(item.items)
      ) {
        const rows = item.items.map((it) =>
          [it.label ?? it.title, it.value ?? it.time, it.sub].map(csvCell).join(","),
        );
        sections.push(
          [title, "Label,Value,Detail", ...rows].filter((x): x is string => x !== null).join("\n"),
        );
      } else if (
        item.type === "heatmap" &&
        Array.isArray(item.values) &&
        Array.isArray(item.cols)
      ) {
        const head = ["", ...item.cols.map(csvCell)].join(",");
        const labels = Array.isArray(item.rows) ? (item.rows as unknown[]) : [];
        const body = item.values.map((vr, ri) =>
          [csvCell(labels[ri] ?? ri), ...(Array.isArray(vr) ? vr : []).map(csvCell)].join(","),
        );
        sections.push([title, head, ...body].filter((x): x is string => x !== null).join("\n"));
      }
    }
  }
  if (sections.length === 0 && Array.isArray(data) && data.length > 0) {
    if (data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const keys = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
      const rows = data.map((r) =>
        keys.map((k) => csvCell((r as Record<string, unknown>)[k])).join(","),
      );
      sections.push([keys.map(csvCell).join(","), ...rows].join("\n"));
    } else if (data.every((r) => Array.isArray(r))) {
      sections.push(data.map((r) => (r as unknown[]).map(csvCell).join(",")).join("\n"));
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Locate a Chromium-family browser for PDF export (they all support
 * --headless --print-to-pdf). GEAR_BROWSER_BIN overrides discovery.
 */
export function findHeadlessBrowser(): string | null {
  const override = process.env.GEAR_BROWSER_BIN;
  if (override) return existsSync(override) ? override : null;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
          ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Print a dashboard URL to PDF with a headless Chromium-family browser. */
export function printUrlToPdf(browserBin: string, url: string, outPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      browserBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--no-pdf-header-footer",
        `--print-to-pdf=${outPath}`,
        url,
      ],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error("PDF export timed out after 45s"));
    }, 45_000);
    // Bun's type shim omits ChildProcess.on; the runtime implements it fully.
    const on = (child as unknown as { on(ev: string, cb: (a?: unknown) => void): void }).on.bind(
      child,
    );
    on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    on("exit", () => {
      clearTimeout(timer);
      if (existsSync(outPath)) resolvePromise();
      else reject(new Error("browser exited without writing the PDF"));
    });
  });
}

/** Confine an export path to the workspace and ensure its directory exists. */
function resolveExportPath(
  workspaceRoot: string,
  path: string | undefined,
  fallback: string,
): string {
  const rel = path && path.trim() ? path.trim() : fallback;
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(workspaceRoot, rel);
  // `isPathInside` rather than two hand-written separator cases: the "\\" arm
  // here happened to cover Windows, the watch-path check below did not, and one
  // tested helper beats remembering which spellings a platform uses (P10.2).
  if (!isPathInside(workspaceRoot, abs)) {
    throw new Error(`export path must be inside the workspace (got ${rel})`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
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
    this.shouldOpen = opts.openInBrowser ?? process.env.GEAR_NO_OPEN !== "1";
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
   * Create (and by default open) a dashboard. Content comes either as a
   * declarative `spec` (preferred — rendered by the built-in design system)
   * or as model-authored `html`. `watchFile` binds a workspace JSON file:
   * its parsed contents become the live data feed.
   */
  async create(args: {
    title: string;
    html?: string;
    spec?: unknown;
    data?: unknown;
    watchFile?: string;
    workspaceRoot: string;
    open?: boolean;
  }): Promise<DashboardInfo> {
    await this.ensureServer();
    const id = randomBytes(4).toString("hex");
    const rec: DashboardRecord = {
      id,
      title: args.title || "Gear dashboard",
      html: args.spec !== undefined ? specShellHtml(jsonForScript(args.spec)) : (args.html ?? ""),
      spec: args.spec,
      // For spec dashboards the spec itself is the initial render payload
      // (unless a watch file supplies live data below).
      data: args.data ?? (args.watchFile === undefined ? (args.spec ?? null) : null),
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
   * Update a live dashboard. A new spec or data-only update re-renders in
   * place through the page's window.render(payload); an html change reloads.
   */
  update(
    id: string,
    changes: { html?: string; spec?: unknown; data?: unknown; title?: string },
  ): DashboardInfo {
    const rec = this.dashboards.get(id);
    if (!rec) throw new Error(`no dashboard with id "${id}" — create one first`);
    if (changes.title) rec.title = changes.title;
    if (changes.spec !== undefined) {
      // Spec updates ride the live data channel (no reload); the html shell is
      // refreshed too so a later browser reload shows the current spec.
      rec.spec = changes.spec;
      rec.data = changes.spec;
      rec.html = specShellHtml(jsonForScript(changes.spec));
      this.broadcast(rec, "data", changes.spec);
    } else if (typeof changes.html === "string" && changes.html.length > 0) {
      rec.html = changes.html;
      rec.spec = undefined;
      if (changes.data !== undefined) rec.data = changes.data;
      rec.version++;
      this.broadcast(rec, "reload", { version: rec.version });
    } else if (changes.data !== undefined) {
      rec.data = changes.data;
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
    // Both sides are already canonical, so this is purely the containment
    // question — and on Windows the old `startsWith(root + "/")` answered "no"
    // for every path in the workspace.
    if (!isPathInside(root, canonical)) {
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
      if (rest[2] === "export" && rest[3]) {
        this.handleExport(rec, String(rest[3]), res);
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

  // ── Exports ──

  private handleExport(rec: DashboardRecord, format: string, res: ServerResponse): void {
    const name = slugify(rec.title);
    if (format === "view") {
      // Renderable (non-download) standalone page with no SSE channel: what
      // headless PDF printing loads. Charts are frozen to images, and the
      // page's load event is held back (see "hold") until that had time to
      // happen — headless print fires at load.
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(this.buildStandalonePage(rec, `/t/${this.token}/d/${rec.id}`));
      return;
    }
    if (format === "hold") {
      // Load-event brake for the print view: respond after the charts have
      // had real time to render + freeze. Headless PDF printing waits for
      // load, so the printed frame contains finished charts.
      const timer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/javascript" }).end("// charts settled");
      }, 2500);
      timer.unref?.();
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (format === "html") {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}.html"`,
        })
        .end(this.buildStandalonePage(rec));
      return;
    }
    if (format === "json") {
      res
        .writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}.json"`,
        })
        .end(JSON.stringify(rec.data ?? rec.spec ?? null, null, 2));
      return;
    }
    if (format === "csv") {
      const csv = buildCsv(rec.spec, rec.data);
      if (csv === null) {
        res.writeHead(422).end("no tabular data to export as CSV");
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}.csv"`,
        })
        .end(csv);
      return;
    }
    res.writeHead(404).end("unknown export format (html, json, csv)");
  }

  /** Export payload for the tool's export action. Throws on unknown id. */
  exportString(id: string, format: "html" | "json" | "csv"): string {
    const rec = this.dashboards.get(id);
    if (!rec) throw new Error(`no dashboard with id "${id}"`);
    if (format === "html") return this.buildStandalonePage(rec);
    if (format === "json") return JSON.stringify(rec.data ?? rec.spec ?? null, null, 2);
    const csv = buildCsv(rec.spec, rec.data);
    if (csv === null) throw new Error("this dashboard has no tabular data to export as CSV");
    return csv;
  }

  /**
   * A single self-contained HTML document: theme, Chart.js, and the current
   * data inlined; no server dependencies — share it, mail it, archive it.
   * `printBase` (the dashboard's token path) switches to the print variant:
   * charts are frozen to <img> snapshots once drawn (the print-layout resize
   * clears live canvases — the blank-chart PDF bug) and the load event is
   * held back via the hold route so headless print sees finished charts.
   */
  private buildStandalonePage(rec: DashboardRecord, printBase?: string): string {
    const print = printBase !== undefined;
    const body = rec.spec !== undefined ? specShellHtml(jsonForScript(rec.spec)) : rec.html;
    // Model-authored full documents: inline the vendor lib + a render-once
    // bootstrap so the exported file works without our server.
    const freeze = print
      ? `
  if (window.Chart) window.Chart.defaults.animation = false;
  function freezeCharts() {
    try {
      var canvases = Array.prototype.slice.call(document.querySelectorAll("canvas"));
      for (var i = 0; i < canvases.length; i++) {
        var c = canvases[i];
        var ch = window.Chart && window.Chart.getChart ? window.Chart.getChart(c) : null;
        if (!ch) continue;
        var img = document.createElement("img");
        img.src = ch.toBase64Image("image/png", 1);
        img.style.width = "100%";
        img.style.height = "100%";
        if (c.parentNode) c.parentNode.replaceChild(img, c);
        ch.destroy();
      }
    } catch (e) { console.error("chart freeze failed:", e); }
  }
  // Freeze once chart creation (deferred by the renderer) has settled: poll
  // until at least one chart exists and the count is stable, then snapshot.
  var lastCount = -1, tries = 0;
  (function waitCharts() {
    var count = 0;
    try {
      var cs = document.querySelectorAll("canvas");
      for (var i = 0; i < cs.length; i++) {
        if (window.Chart && window.Chart.getChart && window.Chart.getChart(cs[i])) count++;
      }
    } catch (e) { /* keep polling */ }
    tries++;
    if ((count > 0 && count === lastCount) || tries > 40) return setTimeout(freezeCharts, 120);
    lastCount = count;
    setTimeout(waitCharts, 120);
  })();`
      : "";
    const staticBootstrap = `
<script>
(function () {
  window.__GEAR_STANDALONE__ = true;
  window.__GEAR_DATA__ = ${jsonForScript(rec.spec ?? rec.data)};
  function boot() {
    try { if (typeof window.render === "function") window.render(window.__GEAR_DATA__); }
    catch (e) { console.error("dashboard render failed:", e); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();${freeze}
})();
</script>${print ? `\n<script src="${printBase}/export/hold"></script>` : ""}`;
    if (/^\s*(<!doctype|<html)/i.test(rec.html) && rec.spec === undefined) {
      const inject = `<script>${CHART_UMD}</script><script>${CHART_DEFAULTS_JS}</script>${staticBootstrap}`;
      const i = rec.html.toLowerCase().lastIndexOf("</body>");
      return i === -1 ? rec.html + inject : rec.html.slice(0, i) + inject + rec.html.slice(i);
    }
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rec.title)}</title>
<script>${CHART_UMD}</script>
<script>${CHART_DEFAULTS_JS}</script>
<style>${THEME_CSS}</style>
</head>
<body>
${body}
${staticBootstrap}
</body>
</html>`;
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
   * Wrap the dashboard content in the page shell: vendored Chart.js, tuned
   * chart defaults, the design-system stylesheet, the live bootstrap (initial
   * data + SSE re-render/reload), and the floating live/export cluster
   * (PDF via print, standalone HTML, JSON, CSV).
   */
  private buildPage(rec: DashboardRecord): string {
    const base = `/t/${this.token}/d/${rec.id}`;
    const vendor = `/t/${this.token}/vendor/chart.umd.js`;
    const bootstrap = `
<script>
(function () {
  window.__GEAR_DATA__ = ${jsonForScript(rec.data)};
  var VERSION = ${rec.version};
  var BASE = ${JSON.stringify(base)};
  function fire(d) {
    try { if (typeof window.render === "function") window.render(d); }
    catch (e) { console.error("dashboard render failed:", e); }
  }
  function boot() { fire(window.__GEAR_DATA__); mountFab(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  var markLive = function () {};
  function mountFab() {
    if (document.getElementById("gear-fab")) return;
    var style = document.createElement("style");
    style.id = "gear-fab-css";
    style.textContent = ${JSON.stringify(FAB_CSS)};
    document.head.appendChild(style);

    var fab = document.createElement("div");
    fab.id = "gear-fab";
    fab.className = "gear-fab";

    var live = document.createElement("span");
    live.className = "gear-live";
    live.style.display = ${rec.watchFile ? '""' : '"none"'};
    var dot = document.createElement("span");
    dot.className = "gear-live-dot";
    live.appendChild(dot);
    live.appendChild(document.createTextNode("LIVE"));
    fab.appendChild(live);
    markLive = function () { live.style.display = ""; };

    var exp = document.createElement("div");
    exp.className = "gear-export";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Export \\u2193";
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      exp.className = exp.className.indexOf("open") === -1 ? "gear-export open" : "gear-export";
    });
    exp.appendChild(btn);
    var menu = document.createElement("div");
    menu.className = "gear-export-menu";
    function link(label, href) {
      var a = document.createElement("a");
      a.textContent = label;
      a.href = BASE + href;
      a.setAttribute("download", "");
      menu.appendChild(a);
    }
    var pdf = document.createElement("button");
    pdf.type = "button";
    pdf.textContent = "PDF report (print)";
    pdf.addEventListener("click", function () {
      exp.className = "gear-export";
      window.print();
    });
    menu.appendChild(pdf);
    link("Standalone HTML", "/export/html");
    link("Data (JSON)", "/export/json");
    link("Data (CSV)", "/export/csv");
    exp.appendChild(menu);
    fab.appendChild(exp);
    document.addEventListener("click", function () { exp.className = "gear-export"; });
    document.body.appendChild(fab);
  }

  try {
    var es = new EventSource(BASE + "/events");
    es.addEventListener("data", function (ev) {
      try { window.__GEAR_DATA__ = JSON.parse(ev.data); } catch (e) { return; }
      markLive();
      fire(window.__GEAR_DATA__);
    });
    es.addEventListener("reload", function () { location.reload(); });
    es.addEventListener("hello", function (ev) {
      try { if (JSON.parse(ev.data).version !== VERSION) location.reload(); } catch (e) {}
    });
  } catch (e) { console.error("dashboard live channel failed:", e); }
})();
</script>`;

    // Full documents keep their own shell; we still splice in the vendor
    // script + chart theming + bootstrap so live updates and exports work.
    if (/^\s*(<!doctype|<html)/i.test(rec.html)) {
      const inject = `<script src="${vendor}"></script><script>${CHART_DEFAULTS_JS}</script>${bootstrap}`;
      const i = rec.html.toLowerCase().lastIndexOf("</body>");
      return i === -1 ? rec.html + inject : rec.html.slice(0, i) + inject + rec.html.slice(i);
    }

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rec.title)}</title>
<script src="${vendor}"></script>
<script>${CHART_DEFAULTS_JS}</script>
<style>${THEME_CSS}</style>
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
  version: "0.3.0",
  description:
    "Render a designed, interactive dashboard in the user's browser (local URL, offline, LIVE updates over SSE) — for reports, metrics, benchmarks, comparisons, timelines, monitoring. " +
    "PREFER `spec` over `html`: the built-in design system renders it as a polished dark bento-grid dashboard with guaranteed typography, spacing, and chart theming — never hand-write CSS for standard analytics. " +
    "Spec shape: { title, subtitle?, direction? ('console' dark bento for live ops/monitoring — the default | 'paper' cream + serif for reports and studies meant to be READ | 'swiss' white + strict rules + red for scientific, institutional and archival work), accent? ('#rrggbb' — the view's ONE accent; pick from the palette to fit the subject: lime #c8f169 default, orange #ff9f68 ops, amber #ffd66e cost, sky #7cc7ff infra, violet #b8a1ff ML, teal #6fe3c2 finance, coral #ff8fa8 consumer), badges?: [string|{text,tone}], " +
    "kpis?: [{label, value, prefix?, suffix? (units), delta? (+/- number = % chip), spark?: [8-24 nums], icon? (single emoji tile), hero? (true = display-size number for THE headline figure), note?, key?}], " +
    "items: [{type:'chart'|'table'|'list'|'progress'|'heatmap'|'timeline'|'section'|'text', title?, aside? (period, e.g. 'Last 30 days'), span? (of 12 — hero chart 8 beside breakdown 4; table 12; charts default 6, lists/progress/timeline 4), note? (source/method), key?, ...}], footer? (data-as-of + caveats) }. " +
    "chart items: {chart: {kind:'line'|'area'|'bar'|'stacked-bar'|'hbar'|'doughnut'|'pie'|'radar'|'scatter', labels:[...], series:[{name, data:[...], color?, fill?, dashed?}], stacked?, max?, center?:{value,label} (doughnut total), raw?: full Chart.js config escape hatch}, height?: px (hero ~300, support ~240)} — line/area=trend, bar=comparison, stacked-bar=composition, hbar=ranking, doughnut=share (≤5 slices); ≤4 series, short labels. " +
    "table items: {columns:[...], rows:[[cell,...]]} — number cells auto-format + right-align; {chip:'text', tone:'good'|'bad'|'warn'|'info'|'accent'} renders a status pill. " +
    "list items: {items:[{title, sub?, value?|chip?, tone?, icon? (emoji)}]}. progress items: {items:[{label, value (0-100), display?, color?}], multicolor?}. " +
    "heatmap items: {rows:['Mon',...], cols:['00',...], values:[[...]], max?} — intensity grid (by-day/by-hour activity) shaded in the view accent. " +
    "timeline items: {items:[{title, sub?, time?, tone? ('accent' highlights current)}]} — event history on a dot rail. section items: {title, aside?} — full-width chapter divider. text items: {body} ('- ' lines become bullets). " +
    "Actions: create (spec or html; opens browser) | update (id + new spec/data re-renders the open page instantly, NO reload — use for real-time/progress) | open | close | export. " +
    "LIVE data: set watch_file (workspace JSON file streamed to the page on change) and give items `key`s — payload {<key>: value} updates just those blocks: kpi key → number or {value, delta, spark}; chart key → {labels?, series: [[...],...]}; table key → {rows}; progress key → [values]. Or push action:'update' yourself. " +
    "EXPORT: every page has an Export menu (PDF via print, standalone HTML, JSON, CSV). action:'export' {format:'pdf'|'html'|'json'|'csv', path?} writes the file into the workspace and is how you deliver report files. " +
    "Raw html escape hatch (bespoke visuals a spec can't express): body-only HTML, self-contained/offline (no CDNs, no web fonts, no external images — inline SVG icons). The page INHERITS the design system: compose with .dash > .grid > .card.span-N, .card-head/.card-title/.card-aside, .kpi-label/.kpi-value/.kpi-foot, .chip.good|bad|warn|info|accent, table.tbl, .rows/.row-item, .prog, .tl, .hm, .sec, .prose and tokens var(--bg,--panel,--panel-2,--line,--line-strong,--ink,--muted,--faint,--accent,--accent-soft,--up,--down,--warn,--info,--font,--mono) — never restyle from browser defaults. Chart.js v" +
    CHART_UMD_VERSION +
    " is preloaded as `Chart` with themed defaults + window.GEAR {palette, rgba, fmt, gradient}; define window.render(data) and draw from data, never hardcode numbers in markup.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "open", "close", "export"],
        description:
          "create a dashboard, update a live one, re-open one, close one, or export one to a file.",
      },
      title: { type: "string", description: "Short dashboard title (tab title + header)." },
      spec: {
        type: "object",
        description:
          "Declarative dashboard spec (see tool description) — the preferred way to build. On update, a new spec re-renders the page in place.",
      },
      html: {
        type: "string",
        description:
          "Escape hatch: body-only HTML (may include <style>/<script>) defining window.render(data). Use spec instead for standard dashboards.",
      },
      data: {
        type: "object",
        description:
          "JSON payload for window.render / key-bound updates. On update, sending only data live-refreshes the page without reload. Requires data_source — every number on the page has to say where it came from.",
      },
      data_source: {
        type: "object",
        description:
          "REQUIRED whenever you send `data`: where those numbers came from. One of " +
          '{"kind":"file","path":"<workspace-relative file you read>"} — the path is checked to exist; ' +
          '{"kind":"command","command":"<the command whose output you are plotting, verbatim>"}; or ' +
          '{"kind":"conversation","note":"<which message or tool result these came from>"} — the weakest form, ' +
          "for numbers the user gave you directly. Omit `data` entirely and bind watch_file instead when the " +
          "values live in a file that changes. There is no option for numbers you produced yourself: if you " +
          "cannot name a source, you do not have data to plot.",
      },
      watch_file: {
        type: "string",
        description:
          "Workspace-relative JSON file to watch — its parsed contents stream to the page in real time whenever it changes.",
      },
      id: {
        type: "string",
        description:
          "Dashboard id (from create). Required for update/close; export/open default to the latest.",
      },
      format: {
        type: "string",
        enum: ["pdf", "html", "json", "csv"],
        description: "Export format: pdf (report file), html (standalone document), json, csv.",
      },
      path: {
        type: "string",
        description: "Workspace-relative output path for export (default: <title-slug>.<ext>).",
      },
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

/** A declared origin for plotted numbers. See `data_source` in the schema. */
export type DataSource =
  | { kind: "file"; path: string }
  | { kind: "command"; command: string }
  | { kind: "conversation"; note: string };

/**
 * Shape-check a `data_source`. Returns an error string, or null when valid.
 *
 * Deliberately strict about the discriminant: an unrecognized `kind` is
 * refused rather than waved through as "some other source", because a source
 * field that accepts anything is decoration, not provenance.
 */
export function validateDataSource(raw: unknown): string | null {
  const need =
    "data requires data_source — where these numbers came from: " +
    '{"kind":"file","path":…}, {"kind":"command","command":…}, or {"kind":"conversation","note":…}';
  if (raw === undefined || raw === null) return need;

  const src = (typeof raw === "string" ? coerceData(raw) : raw) as Record<string, unknown>;
  if (typeof src !== "object" || Array.isArray(src)) return need;

  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  switch (src.kind) {
    case "file":
      return nonEmpty(src.path)
        ? null
        : 'data_source {"kind":"file"} requires a workspace-relative `path` you actually read';
    case "command":
      return nonEmpty(src.command)
        ? null
        : 'data_source {"kind":"command"} requires the `command` whose output you are plotting, verbatim';
    case "conversation":
      return nonEmpty(src.note)
        ? null
        : 'data_source {"kind":"conversation"} requires a `note` naming the message or tool result these came from';
    default:
      return need;
  }
}

/**
 * The one source form the runtime can check by itself: a file either exists in
 * the workspace or it does not. Returns an error string, or null.
 *
 * Path containment matters as much as existence — a source pointing outside the
 * workspace is not a source this run can stand behind.
 */
export function verifyDataSource(source: unknown, workspaceRoot: string): string | null {
  const src = source as Record<string, unknown> | undefined;
  if (!src || src.kind !== "file" || typeof src.path !== "string") return null;

  const root = resolve(workspaceRoot);
  const abs = isAbsolute(src.path) ? resolve(src.path) : resolve(root, src.path);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return `data_source path "${src.path}" is outside the workspace`;
  }
  if (!existsSync(abs)) {
    return (
      `data_source names "${src.path}", which does not exist. Cite the file you actually read, ` +
      "or use watch_file to bind the page to it."
    );
  }
  return null;
}

export function createDashboardTool(manager: DashboardManager): ToolHandler {
  return {
    schema: INTERACTIVE_DASHBOARD_SCHEMA,

    validate: (args) => {
      const action = args.action;
      if (
        action !== "create" &&
        action !== "update" &&
        action !== "open" &&
        action !== "close" &&
        action !== "export"
      ) {
        return {
          valid: false,
          error: "action must be one of: create, update, open, close, export",
        };
      }
      const specSize = args.spec === undefined ? 0 : (JSON.stringify(args.spec)?.length ?? 0);
      if (specSize > MAX_HTML_CHARS) {
        return { valid: false, error: `spec too large (max ${MAX_HTML_CHARS} chars as JSON)` };
      }
      if (typeof args.html === "string" && args.html.length > MAX_HTML_CHARS) {
        return { valid: false, error: `html too large (max ${MAX_HTML_CHARS} chars)` };
      }
      if (action === "create") {
        const hasHtml = typeof args.html === "string" && args.html.trim().length > 0;
        const hasSpec = args.spec !== undefined && args.spec !== null;
        if (!hasHtml && !hasSpec) {
          return {
            valid: false,
            error: "create requires a spec (preferred — see tool description) or body-only html",
          };
        }
      }
      // Provenance for plotted numbers.
      //
      // `data` is a free-form object the model authors, and it is the one tool
      // output a reader takes as fact — a chart reads as measurement whether or
      // not anything measured it. The rule "plot the REAL numbers, never invent
      // data" lived only in the doctrine, and a prose rule is exactly what does
      // not survive a model swap. So the schema asks the question instead, and
      // the file form is checked against the filesystem at execute time.
      if ((action === "create" || action === "update") && args.data !== undefined) {
        const sourceError = validateDataSource(args.data_source);
        if (sourceError) return { valid: false, error: sourceError };
      }
      if (action === "update" && (typeof args.id !== "string" || !args.id)) {
        return { valid: false, error: "update requires the dashboard id returned by create" };
      }
      if (action === "close" && (typeof args.id !== "string" || !args.id)) {
        return { valid: false, error: "close requires the dashboard id" };
      }
      if (action === "export") {
        const f = args.format;
        if (f !== "pdf" && f !== "html" && f !== "json" && f !== "csv") {
          return { valid: false, error: "export requires format: pdf, html, json, or csv" };
        }
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
        // The half of provenance the runtime can settle by itself: a cited
        // file either exists inside the workspace or it does not. validate()
        // has no workspace root, so the check lands here.
        if (args.data !== undefined) {
          const sourceError = verifyDataSource(args.data_source, input.workspaceRoot);
          if (sourceError) return fail(sourceError);
        }
        switch (args.action) {
          case "create": {
            const info = await manager.create({
              title: typeof args.title === "string" ? args.title : "Gear dashboard",
              html: typeof args.html === "string" ? args.html : undefined,
              spec: coerceData(args.spec) ?? undefined,
              data: coerceData(args.data),
              watchFile: typeof args.watch_file === "string" ? args.watch_file : undefined,
              workspaceRoot: input.workspaceRoot,
              open: args.open !== false,
            });
            return done(
              JSON.stringify({
                ...info,
                note:
                  "Dashboard is live (opened in the browser). Tell the user the URL and that the page's Export menu offers PDF/HTML/JSON/CSV. " +
                  "Push new data or a new spec with action:'update' — the page refreshes instantly.",
              }),
            );
          }
          case "update": {
            const info = manager.update(args.id as string, {
              html: typeof args.html === "string" ? args.html : undefined,
              spec: coerceData(args.spec) ?? undefined,
              data: args.data === undefined ? undefined : coerceData(args.data),
              title: typeof args.title === "string" ? args.title : undefined,
            });
            return done(JSON.stringify({ ...info, updated: true }));
          }
          case "export": {
            const id = typeof args.id === "string" && args.id ? args.id : manager.last()?.id;
            if (!id) return fail("no dashboard to export — create one first");
            const info = manager.list().find((d) => d.id === id);
            if (!info) return fail(`no dashboard with id "${id}"`);
            const format = args.format as "pdf" | "html" | "json" | "csv";
            const fallback = `${slugify(info.title)}.${format}`;
            const outPath = resolveExportPath(
              input.workspaceRoot,
              typeof args.path === "string" ? args.path : undefined,
              fallback,
            );
            if (format === "pdf") {
              const browser = findHeadlessBrowser();
              if (!browser) {
                return fail(
                  "PDF export needs a Chromium-family browser (Chrome/Brave/Edge) and none was found. " +
                    "The user can still export: the open dashboard's Export menu → 'PDF report (print)'. " +
                    "Or set GEAR_BROWSER_BIN to a browser binary.",
                );
              }
              await printUrlToPdf(browser, `${manager.url(id)}/export/view`, outPath);
            } else {
              writeFileSync(outPath, manager.exportString(id, format), "utf8");
            }
            return done(JSON.stringify({ id, exported: outPath, format, title: info.title }));
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
