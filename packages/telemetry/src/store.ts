// ─── BlackboxStore: durable incident storage ───
// Separate DB from sessions (~/.alan/blackbox.db) so incidents outlive session
// deletion and aggregate across every session. WAL mode; single-row synchronous
// writes (bun:sqlite is sync — a row insert is microseconds, so there is no
// async queue to lose in a crash). Raw incidents are prunable; fingerprint
// aggregates are kept forever (tiny, and they are the longitudinal signal).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  IncidentClass,
  IncidentOutcome,
  IncidentRecord,
  IncidentSeverity,
} from "@alan/shared";

export interface FingerprintRow {
  fingerprint: string;
  class: IncidentClass;
  component: string;
  messageSample: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  versions: string[];
}

export interface ListFilter {
  limit?: number;
  severity?: IncidentSeverity;
  minSeverity?: IncidentSeverity;
  class?: string; // exact class or "family." prefix
  sessionId?: string;
  sinceDays?: number;
  outcome?: IncidentOutcome;
}

interface IncidentRow {
  id: string;
  ts: string;
  version: string;
  session_id: string | null;
  turn: number | null;
  class: string;
  severity: string;
  component: string;
  where_site: string;
  message: string;
  stack: string | null;
  context_json: string;
  trail_json: string;
  outcome: string;
  fingerprint: string;
}

const SEVERITY_ORDER: IncidentSeverity[] = ["debug", "warn", "error", "critical"];

export class BlackboxStore {
  private db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        version TEXT NOT NULL,
        session_id TEXT,
        turn INTEGER,
        class TEXT NOT NULL,
        severity TEXT NOT NULL,
        component TEXT NOT NULL,
        where_site TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        trail_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT 'pending',
        fingerprint TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents(ts);
      CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
      CREATE TABLE IF NOT EXISTS fingerprints (
        fingerprint TEXT PRIMARY KEY,
        class TEXT NOT NULL,
        component TEXT NOT NULL,
        message_sample TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        versions_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  insert(record: IncidentRecord): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO incidents
           (id, ts, version, session_id, turn, class, severity, component, where_site,
            message, stack, context_json, trail_json, outcome, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.ts,
          record.version,
          record.sessionId,
          record.turn,
          record.class,
          record.severity,
          record.component,
          record.where,
          record.message,
          record.stack ?? null,
          JSON.stringify(record.context ?? {}),
          JSON.stringify(record.trail ?? []),
          record.outcome,
          record.fingerprint,
        );

      const existing = this.db
        .query(`SELECT versions_json FROM fingerprints WHERE fingerprint = ?`)
        .get(record.fingerprint) as { versions_json: string } | null;

      if (existing) {
        const versions = new Set<string>(JSON.parse(existing.versions_json) as string[]);
        versions.add(record.version);
        this.db
          .query(
            `UPDATE fingerprints
             SET count = count + 1, last_seen = ?, versions_json = ?
             WHERE fingerprint = ?`,
          )
          .run(record.ts, JSON.stringify([...versions]), record.fingerprint);
      } else {
        this.db
          .query(
            `INSERT INTO fingerprints
             (fingerprint, class, component, message_sample, count, first_seen, last_seen, versions_json)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            record.fingerprint,
            record.class,
            record.component,
            record.message.slice(0, 300),
            record.ts,
            record.ts,
            JSON.stringify([record.version]),
          );
      }
    });
    tx();
  }

  get(id: string): IncidentRecord | null {
    const row = this.db.query(`SELECT * FROM incidents WHERE id = ?`).get(id) as
      | IncidentRow
      | null;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Short-id match: UUIDv7 ids are time-ordered, so their PREFIX collides for
   * ids minted near each other — the display handle is the random SUFFIX.
   * Accepts either end (suffix first), returns the unique match or null.
   */
  getByPrefix(shortId: string): IncidentRecord | null {
    const bySuffix = this.db
      .query(`SELECT * FROM incidents WHERE id LIKE ? LIMIT 2`)
      .all(`%${shortId}`) as IncidentRow[];
    if (bySuffix.length === 1) return rowToRecord(bySuffix[0]);
    const byPrefix = this.db
      .query(`SELECT * FROM incidents WHERE id LIKE ? LIMIT 2`)
      .all(`${shortId}%`) as IncidentRow[];
    return byPrefix.length === 1 ? rowToRecord(byPrefix[0]) : null;
  }

  list(filter: ListFilter = {}): IncidentRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.severity) {
      clauses.push("severity = ?");
      params.push(filter.severity);
    }
    if (filter.minSeverity) {
      const allowed = SEVERITY_ORDER.slice(SEVERITY_ORDER.indexOf(filter.minSeverity));
      clauses.push(`severity IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }
    if (filter.class) {
      if (filter.class.endsWith(".")) {
        clauses.push("class LIKE ?");
        params.push(`${filter.class}%`);
      } else {
        clauses.push("class = ?");
        params.push(filter.class);
      }
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.outcome) {
      clauses.push("outcome = ?");
      params.push(filter.outcome);
    }
    if (filter.sinceDays !== undefined) {
      clauses.push("ts >= ?");
      params.push(daysAgoIso(filter.sinceDays));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM incidents ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, filter.limit ?? 50) as IncidentRow[];
    return rows.map(rowToRecord);
  }

  top(opts: { limit?: number; sinceDays?: number } = {}): FingerprintRow[] {
    const since = opts.sinceDays !== undefined ? daysAgoIso(opts.sinceDays) : null;
    const rows = (
      since
        ? this.db
            .query(`SELECT * FROM fingerprints WHERE last_seen >= ? ORDER BY count DESC LIMIT ?`)
            .all(since, opts.limit ?? 10)
        : this.db.query(`SELECT * FROM fingerprints ORDER BY count DESC LIMIT ?`).all(
            opts.limit ?? 10,
          )
    ) as Array<{
      fingerprint: string;
      class: string;
      component: string;
      message_sample: string;
      count: number;
      first_seen: string;
      last_seen: string;
      versions_json: string;
    }>;
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      class: r.class as IncidentClass,
      component: r.component,
      messageSample: r.message_sample,
      count: r.count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      versions: JSON.parse(r.versions_json) as string[],
    }));
  }

  /** Fingerprints grouped per version — feeds `alan incidents top --by-version`. */
  byVersion(): Map<string, FingerprintRow[]> {
    const all = this.top({ limit: 10_000 });
    const out = new Map<string, FingerprintRow[]>();
    for (const row of all) {
      for (const v of row.versions) {
        const arr = out.get(v) ?? [];
        arr.push(row);
        out.set(v, arr);
      }
    }
    return out;
  }

  /** Counts by severity within a window — feeds `alan doctor`. */
  counts(opts: { sinceDays?: number } = {}): Record<string, number> {
    const since = daysAgoIso(opts.sinceDays ?? 7);
    const rows = this.db
      .query(`SELECT severity, COUNT(*) as n FROM incidents WHERE ts >= ? GROUP BY severity`)
      .all(since) as Array<{ severity: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.severity] = r.n;
    return out;
  }

  resolve(ids: string[], outcome: IncidentOutcome): void {
    if (ids.length === 0) return;
    const q = this.db.query(
      `UPDATE incidents SET outcome = ? WHERE id = ? AND outcome = 'pending'`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) q.run(outcome, id);
    });
    tx();
  }

  /** Startup sweep: anything still pending from before `beforeIso` was abandoned. */
  sweepPending(beforeIso: string, outcome: IncidentOutcome = "abandoned"): number {
    const r = this.db
      .query(`UPDATE incidents SET outcome = ? WHERE outcome = 'pending' AND ts < ?`)
      .run(outcome, beforeIso);
    return r.changes;
  }

  /** Prune raw incidents (aggregates are never pruned). Returns rows deleted. */
  prune(opts: { maxAgeDays?: number; maxRows?: number } = {}): number {
    let deleted = 0;
    if (opts.maxAgeDays !== undefined) {
      const r = this.db
        .query(`DELETE FROM incidents WHERE ts < ?`)
        .run(daysAgoIso(opts.maxAgeDays));
      deleted += r.changes;
    }
    if (opts.maxRows !== undefined) {
      const r = this.db
        .query(
          `DELETE FROM incidents WHERE id NOT IN
           (SELECT id FROM incidents ORDER BY ts DESC LIMIT ?)`,
        )
        .run(opts.maxRows);
      deleted += r.changes;
    }
    return deleted;
  }

  getMeta(key: string): string | null {
    const row = this.db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
      .run(key, value, value);
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    ts: row.ts,
    version: row.version,
    sessionId: row.session_id,
    turn: row.turn,
    class: row.class as IncidentClass,
    severity: row.severity as IncidentSeverity,
    component: row.component,
    where: row.where_site,
    message: row.message,
    stack: row.stack ?? undefined,
    context: JSON.parse(row.context_json),
    trail: JSON.parse(row.trail_json),
    outcome: row.outcome as IncidentOutcome,
    fingerprint: row.fingerprint,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
