// ─── What `~/.rune/provider-health.json` actually says, in sentences ───
//
// The gateway remembers two things across sessions: models that answered 404/410
// (`retired`) and providers whose plan cap was hit (`capped`). Both carry an
// `until` in epoch milliseconds, and both are pruned on the next WRITE — which
// means a machine that has not made a call since the window closed still has a
// file full of records nobody believes any more. Nothing surfaced that: the
// person saw "quota exceeded" in a session days ago and had no way to ask
// whether it was still true.
//
// Two failure shapes this file is built to name plainly, because the founder's
// own record carries one of each:
//
//   1. A cap whose window has already passed. The route is usable; the file just
//      has not been rewritten. Saying "expired 2d ago" is the whole fix.
//   2. A retirement recorded against the wrong route. `google` holds a
//      retirement for `gpt-5.6-sol`, which is a Codex model id — a misrouted
//      call was blamed on the provider it was sent to. Left unsaid, it reads as
//      "Google retired a model" forever.
//
// This module is pure: it reads the file and returns sentences with a severity.
// `blackbox-cli` paints them. That keeps the wording under test.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRuneHome, hasStoredCredential, PROVIDER_PRESETS } from "@rune/shared";

export type RouteHealthKind = "capped" | "retired";

export interface RouteHealthRow {
  kind: RouteHealthKind;
  provider: string;
  /** Only on a retirement. */
  model?: string;
  /** Epoch ms the record stops being believed. */
  untilMs: number;
  /** The window has already closed: the record survives only until the next write. */
  expired: boolean;
  /** The provider's own message (a 429 body) or the 404 reason. */
  detail: string;
  /**
   * Set when the retired model id is not one this provider offers but IS one
   * another preset offers — i.e. the call went to the wrong route and the
   * retirement was filed against the messenger.
   */
  misroutedTo?: string;
}

export interface ProviderRouteReport {
  path: string;
  /** No file yet. Nothing has failed on this machine — not an error. */
  missing: boolean;
  /** The file exists and could not be understood. */
  unreadable?: string;
  rows: RouteHealthRow[];
  /** Provider ids with a credential on this machine, in preset order. */
  configured: string[];
}

export interface RouteLine {
  level: "ok" | "warn" | "bad";
  text: string;
  /** Indented continuation lines: the provider's message, the misroute note. */
  sub: string[];
}

/** Which preset, if any, actually offers this model id. */
function presetOffering(model: string): string | undefined {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.models?.some((m) => m.id === model)) return preset.id;
    if (preset.defaultModel === model) return preset.id;
  }
  return undefined;
}

function offeredBy(provider: string, model: string): boolean {
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider);
  if (!preset) return true; // an unknown provider: no opinion, never accuse
  if (preset.defaultModel === model) return true;
  if (preset.models?.some((m) => m.id === model)) return true;
  // A provider whose ids are free-form (Ollama tags, OpenRouter slugs) has no
  // closed list; only accuse when the preset publishes one.
  return !preset.models || preset.models.length === 0;
}

/** A duration in the coarsest unit that still says something: "2d 3h", "14m". */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** A wall-clock stamp in the reader's own timezone — never UTC. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** "until 2026-09-10 09:06 (2d 3h left)" or "expired 2026-09-06 15:24 (2d ago)". */
export function formatWindow(untilMs: number, now: number): string {
  return untilMs > now
    ? `until ${localStamp(untilMs)} (${humanDuration(untilMs - now)} left)`
    : `expired ${localStamp(untilMs)} (${humanDuration(now - untilMs)} ago)`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function readProviderRouteReport(
  opts: { home?: string; now?: number; env?: NodeJS.ProcessEnv } = {},
): ProviderRouteReport {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const path = join(opts.home ?? getRuneHome(env), "provider-health.json");

  const configured = PROVIDER_PRESETS.filter(
    (p) =>
      p.local ||
      hasStoredCredential(p.id, env) ||
      (p.envVar !== undefined && !!env[p.envVar]?.trim()),
  ).map((p) => p.id);

  if (!existsSync(path)) return { path, missing: true, rows: [], configured };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return {
      path,
      missing: false,
      unreadable: e instanceof Error ? e.message : String(e),
      rows: [],
      configured,
    };
  }
  const file = raw as {
    version?: number;
    retired?: { provider?: string; model?: string; until?: number; reason?: string }[];
    capped?: { provider?: string; until?: number; message?: string }[];
  } | null;
  if (!file || file.version !== 1) {
    return {
      path,
      missing: false,
      unreadable: `version ${String(file?.version)} is not a record this build understands`,
      rows: [],
      configured,
    };
  }

  const rows: RouteHealthRow[] = [];
  for (const c of file.capped ?? []) {
    if (!c?.provider || typeof c.until !== "number") continue;
    rows.push({
      kind: "capped",
      provider: c.provider,
      untilMs: c.until,
      expired: c.until <= now,
      detail: clip(c.message ?? "", 160),
    });
  }
  for (const r of file.retired ?? []) {
    if (!r?.provider || !r.model || typeof r.until !== "number") continue;
    const misroutedTo = offeredBy(r.provider, r.model) ? undefined : presetOffering(r.model);
    rows.push({
      kind: "retired",
      provider: r.provider,
      model: r.model,
      untilMs: r.until,
      expired: r.until <= now,
      detail: clip(r.reason ?? "", 160),
      misroutedTo,
    });
  }
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.untilMs - b.untilMs);
  return { path, missing: false, rows, configured };
}

/** The lines `rune doctor` prints, without colour. */
export function providerRouteLines(report: ProviderRouteReport, now: number): RouteLine[] {
  const out: RouteLine[] = [];

  if (report.unreadable) {
    out.push({
      level: "bad",
      text: `provider routes: ${report.path} could not be read — ${report.unreadable}`,
      sub: ["delete it and the next session starts from a clean record"],
    });
    return out;
  }

  const named = new Set(report.rows.map((r) => r.provider));
  const healthy = report.configured.filter((id) => !named.has(id));

  if (report.missing || report.rows.length === 0) {
    out.push({
      level: "ok",
      text:
        `provider routes: no cap or retirement recorded` +
        (report.configured.length ? ` (${report.configured.length} configured)` : ""),
      sub: [],
    });
  }

  for (const row of report.rows) {
    const window = formatWindow(row.untilMs, now);
    const stale = row.expired ? " — STALE, believed by nothing; pruned on the next write" : "";
    if (row.kind === "capped") {
      out.push({
        level: row.expired ? "warn" : "bad",
        text: row.expired
          ? `${row.provider}: plan cap ${window}${stale}`
          : `${row.provider}: plan cap in force, ${window}`,
        sub: row.detail ? [row.detail] : [],
      });
    } else {
      const sub: string[] = [];
      if (row.misroutedTo) {
        sub.push(
          `${row.model} is a ${row.misroutedTo} model id, not a ${row.provider} one — ` +
            `this retirement was filed against the route the call was misdirected to, not a real ${row.provider} failure`,
        );
      }
      if (row.detail) sub.push(row.detail);
      out.push({
        level: row.misroutedTo ? "warn" : row.expired ? "warn" : "bad",
        text: `${row.provider}: model ${row.model} recorded retired, ${window}${stale}`,
        sub,
      });
    }
  }

  if (healthy.length) {
    out.push({
      level: "ok",
      text: `healthy routes: ${healthy.join(", ")}`,
      sub: [],
    });
  }

  const staleCount = report.rows.filter((r) => r.expired).length;
  if (staleCount > 0) {
    out.push({
      level: "warn",
      text:
        `${staleCount} stale entr${staleCount === 1 ? "y" : "ies"} in ${report.path} — ` +
        `already expired and kept only because nothing has written the file since`,
      sub: ["they are dropped the next time a session records provider health"],
    });
  }

  return out;
}
