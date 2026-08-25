#!/usr/bin/env bun
// ─── Gear telemetry collector (the receiving end) ───
// A single, dependency-free Bun server you run on your own machine or a small
// box. It receives the opt-in reports Gear clients POST, stores them in a
// local SQLite file, and serves a tiny live adoption/health dashboard. This is
// the "diagnostics land on MY computer" half of the channel.
//
// It is deliberately minimal and auditable:
//   • Raw IP addresses are NEVER stored. The request IP is used, at most, for a
//     coarse country lookup you opt into (geoLookup below) and then discarded.
//   • Ingest is guarded by a shared bearer token (GEAR_COLLECTOR_TOKEN).
//   • No external dependencies, no outbound calls — inspect it in one read.
//
// Run:
//   GEAR_COLLECTOR_TOKEN=your-secret bun collector/gear-collector.ts
//
// Env:
//   GEAR_COLLECTOR_PORT   default 8787
//   GEAR_COLLECTOR_TOKEN  shared secret; if set, POST /ingest requires it
//   GEAR_COLLECTOR_DB     default ~/.gear-collector/reports.db
//
// Point a Gear build at it by setting, in the client's ~/.gear/config.toml:
//   [telemetry]
//   enabled  = true
//   endpoint = "https://your-host:8787/ingest"
//   token    = "your-secret"

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.GEAR_COLLECTOR_PORT ?? 8787);
const TOKEN = process.env.GEAR_COLLECTOR_TOKEN ?? "";
const DB_PATH =
  process.env.GEAR_COLLECTOR_DB ??
  process.env.BERNE_COLLECTOR_DB ??
  join(homedir(), ".gear-collector", "reports.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
// Continuity for upgraded deployments: a collector that previously ran under
// the Berne name kept its reports at ~/.berne-collector. When the new default
// DB does not exist yet and the legacy one does, adopt it by copy (copy, not
// move — a rollback to the old entry point keeps working).
if (!process.env.GEAR_COLLECTOR_DB && !process.env.BERNE_COLLECTOR_DB && !existsSync(DB_PATH)) {
  const legacy = join(homedir(), ".berne-collector", "reports.db");
  if (existsSync(legacy)) {
    copyFileSync(legacy, DB_PATH);
    console.log(`adopted legacy collector data: ${legacy} → ${DB_PATH}`);
  }
}
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    type TEXT NOT NULL,
    install_id TEXT,
    version TEXT,
    os TEXT,
    arch TEXT,
    country TEXT,
    class TEXT,
    severity TEXT,
    fingerprint TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reports_received ON reports(received_at);
  CREATE INDEX IF NOT EXISTS idx_reports_install ON reports(install_id);
  CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
`);

const insertStmt = db.query(`
  INSERT INTO reports
    (received_at, type, install_id, version, os, arch, country, class, severity, fingerprint, payload_json)
  VALUES ($received_at, $type, $install_id, $version, $os, $arch, $country, $class, $severity, $fingerprint, $payload_json)
`);

// ─── Optional coarse geo. Returns a country string or null. The raw IP is
// passed in ONLY here and never leaves this function. Default: no lookup (null),
// so nothing location-derived is stored until you wire a real GeoIP database. ───
function geoLookup(_ip: string | undefined): string | null {
  return null;
}

interface WireReport {
  t?: string;
  installId?: string;
  version?: string;
  os?: string;
  arch?: string;
  class?: string;
  severity?: string;
  fingerprint?: string;
  [k: string]: unknown;
}

function store(report: WireReport, country: string | null): void {
  insertStmt.run({
    $received_at: new Date().toISOString(),
    $type: typeof report.t === "string" ? report.t : "unknown",
    $install_id: str(report.installId),
    $version: str(report.version),
    $os: str(report.os),
    $arch: str(report.arch),
    $country: country,
    $class: str(report.class),
    $severity: str(report.severity),
    $fingerprint: str(report.fingerprint),
    $payload_json: JSON.stringify(report),
  });
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v.slice(0, 2000) : null;
}

function authorized(req: Request): boolean {
  if (!TOKEN) return true; // no token configured ⇒ open (dev only)
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${TOKEN}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── Aggregates for the dashboard + /stats ───

function activeInstalls(days: number): number {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const row = db
    .query(`SELECT COUNT(DISTINCT install_id) AS n FROM reports WHERE received_at >= ?`)
    .get(since) as { n: number };
  return row.n;
}

function groupBy(column: "version" | "os" | "country", limit = 12): Array<[string, number]> {
  const rows = db
    .query(
      `SELECT COALESCE(${column}, 'unknown') AS k, COUNT(DISTINCT install_id) AS n
       FROM reports GROUP BY k ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as Array<{ k: string; n: number }>;
  return rows.map((r) => [r.k, r.n]);
}

function topClasses(limit = 12): Array<[string, number]> {
  const rows = db
    .query(
      `SELECT class AS k, COUNT(*) AS n FROM reports
       WHERE type = 'incident' AND class IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as Array<{ k: string; n: number }>;
  return rows.map((r) => [r.k, r.n]);
}

function recentIncidents(limit = 25): Array<Record<string, unknown>> {
  const rows = db
    .query(
      `SELECT received_at, version, os, class, severity, fingerprint, payload_json
       FROM reports WHERE type = 'incident' ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows;
}

function stats() {
  return {
    db: DB_PATH,
    totals: {
      reports: (db.query(`SELECT COUNT(*) AS n FROM reports`).get() as { n: number }).n,
      incidents: (
        db.query(`SELECT COUNT(*) AS n FROM reports WHERE type='incident'`).get() as { n: number }
      ).n,
    },
    activeInstalls: { d1: activeInstalls(1), d7: activeInstalls(7), d30: activeInstalls(30) },
    byVersion: groupBy("version"),
    byOs: groupBy("os"),
    byCountry: groupBy("country"),
    topIncidentClasses: topClasses(),
  };
}

// ─── Minimal self-contained HTML dashboard (no external requests) ───

function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function bars(rows: Array<[string, number]>): string {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return rows
    .map(
      ([k, n]) =>
        `<div class="row"><span class="k">${esc(k)}</span><span class="bar" style="width:${(n / max) * 100}%"></span><span class="n">${n}</span></div>`,
    )
    .join("");
}

function dashboardHtml(): string {
  const s = stats();
  const incidents = recentIncidents(25)
    .map((r) => {
      let msg = "";
      try {
        msg = (JSON.parse(String(r.payload_json)) as { msg?: string }).msg ?? "";
      } catch {
        msg = "";
      }
      return `<tr><td class="mono dim">${esc(String(r.received_at).slice(0, 16).replace("T", " "))}</td><td class="mono">${esc(r.class)}</td><td>${esc(r.severity)}</td><td class="mono dim">${esc(r.version)}</td><td class="msg">${esc(msg).slice(0, 120)}</td></tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Gear · telemetry</title>
<meta http-equiv="refresh" content="30">
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--text:#e6e8ec;--dim:#8a92a6;--accent:#6ea8fe;--ok:#5bd6a0;--warn:#e0b567}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
  h1{font-size:18px;margin:0 0 4px}.sub{color:var(--dim);margin-bottom:24px;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 12px}
  .kpis{display:flex;gap:24px}.kpi .v{font-size:28px;font-weight:600}.kpi .l{color:var(--dim);font-size:12px}
  .row{display:flex;align-items:center;gap:8px;margin:4px 0}.row .k{width:120px;color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .bar{height:10px;background:var(--accent);border-radius:3px;min-width:2px}.row .n{width:32px;text-align:right;color:var(--dim);font-size:12px}
  table{width:100%;border-collapse:collapse;margin-top:8px}td{padding:5px 8px;border-top:1px solid var(--line);font-size:12px;vertical-align:top}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.dim{color:var(--dim)}.msg{color:var(--dim)}
  .foot{color:var(--dim);font-size:12px;margin-top:24px}
</style></head><body>
  <h1>Gear · telemetry</h1>
  <div class="sub">${esc(s.totals.reports)} reports · ${esc(s.totals.incidents)} incidents · auto-refreshes every 30s · ${esc(DB_PATH)}</div>
  <div class="grid">
    <div class="card"><h2>Active installs</h2><div class="kpis">
      <div class="kpi"><div class="v">${s.activeInstalls.d1}</div><div class="l">24h</div></div>
      <div class="kpi"><div class="v">${s.activeInstalls.d7}</div><div class="l">7d</div></div>
      <div class="kpi"><div class="v">${s.activeInstalls.d30}</div><div class="l">30d</div></div>
    </div></div>
    <div class="card"><h2>By version</h2>${bars(s.byVersion) || '<span class="dim">no data</span>'}</div>
    <div class="card"><h2>By OS</h2>${bars(s.byOs) || '<span class="dim">no data</span>'}</div>
    <div class="card"><h2>By country</h2>${bars(s.byCountry.filter(([k]) => k !== "unknown")) || '<span class="dim">geo lookup not configured</span>'}</div>
    <div class="card" style="grid-column:1/-1"><h2>Top error classes</h2>${bars(s.topIncidentClasses) || '<span class="dim">no incidents yet</span>'}</div>
    <div class="card" style="grid-column:1/-1"><h2>Recent incidents</h2>
      <table><tbody>${incidents || '<tr><td class="dim">nothing yet</td></tr>'}</tbody></table>
    </div>
  </div>
  <div class="foot">Raw IP addresses are never stored. Reports are opt-in and redacted at the source.</div>
</body></html>`;
}

// ─── Server ───

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/ingest") {
      if (!authorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      const reports = (body as { reports?: unknown })?.reports;
      if (!Array.isArray(reports)) return json({ ok: false, error: "missing reports[]" }, 400);
      const country = geoLookup(server.requestIP(req)?.address); // used, then discarded
      let stored = 0;
      const tx = db.transaction(() => {
        for (const r of reports) {
          if (r && typeof r === "object") {
            store(r as WireReport, country);
            stored++;
          }
        }
      });
      tx();
      return json({ ok: true, stored });
    }

    if (url.pathname === "/stats") return json(stats());
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/") {
      return new Response(dashboardHtml(), { headers: { "content-type": "text/html" } });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
});

console.log(`
  Gear telemetry collector
  ─────────────────────────
  dashboard : http://localhost:${server.port}/
  ingest    : POST http://localhost:${server.port}/ingest   ${TOKEN ? "(token required)" : "(open — set GEAR_COLLECTOR_TOKEN!)"}
  stats     : http://localhost:${server.port}/stats
  database  : ${DB_PATH}

  Point Gear clients at this via [telemetry] endpoint/token in ~/.gear/config.toml.
`);
