import { Database } from "bun:sqlite";

// ─── Run State ───

/**
 * Where a run had got to — a POINTER, not a transcript.
 *
 * It used to carry `messages: unknown[]`, the loop's entire working set, saved
 * after every file write. Measured on the founder's own database on
 * 2026-09-10: 747 checkpoint rows holding 193 414 376 bytes — 184 MiB of a
 * 250 MiB file — spanning three months, never read and never pruned, because
 * `runId` was `${sessionId}-${Date.now()}` and no row could be addressed
 * again. The messages were never the point either: a resumed run rebuilds its
 * transcript from the `events` table, which already holds every one of them.
 *
 * So this is what a restart genuinely needs and cannot derive: how far the
 * dead run got, what it had spent, and the last event it managed to write.
 */
export interface RunState {
  runId: string;
  sessionId: string;
  /** Turns the dead run had completed. */
  turnCount: number;
  /** The last `events.seq` this run wrote — where a reader picks up. */
  lastSeq: number;
  /** What it had spent, so the next run can inherit it rather than reset. */
  budget: { turnsUsed: number; secondWindsUsed: number; spentUsd: number };
  /** The workspace revision it was working against. */
  head: string | null;
  dirty: boolean;
  /** Model, provider — small, flat, and bounded by construction. */
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointVersion {
  runId: string;
  version: number;
  state: RunState;
  createdAt: string;
}

// ─── Checkpoint Policy ───

/**
 * When a checkpoint is written.
 *
 * `intervalTurns` and `intervalMs` used to live here too. The interval save
 * was dead code from the day it was written — `turnCount` is declared inside
 * `chat()` and incremented only on `turn_complete`, which the loop emits
 * exactly once per call, so `turnCount % 5 === 0` was never true. Nothing
 * timed the `intervalMs` one at all. Both are gone rather than left looking
 * like policy someone could tune.
 */
export interface CheckpointPolicy {
  /** Write at a tool boundary that changed the workspace. Default true. */
  onToolSuccess: boolean;
  /** Versions kept per run. Older ones are rotated away on each save. */
  keepVersions: number;
}

/**
 * Versions kept per run: the one a restart reads, and the one before it, so a
 * torn write is recoverable. A third has never answered a question the second
 * could not.
 *
 * Named rather than repeated, because `reportCheckpoints` and
 * `pruneCheckpoints` MUST agree on it — when they did not, the doctor
 * advertised more reclaimable rows than the command it named could remove.
 */
export const DEFAULT_KEEP_VERSIONS = 2;

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  onToolSuccess: true,
  keepVersions: DEFAULT_KEEP_VERSIONS,
};

// ─── Checkpoint Store Interface ───

export interface CheckpointStore {
  save(runId: string, state: RunState, keep?: number): void;
  load(runId: string): CheckpointVersion | null;
  loadVersion(runId: string, version: number): CheckpointVersion | null;
  getLastCheckpoint(runId: string): CheckpointVersion | null;
  listCheckpoints(runId: string): CheckpointVersion[];
}

// ─── SQLite Checkpoint Store ───

const CHECKPOINT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    version     INTEGER NOT NULL,
    state_json  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(run_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_run_ver ON checkpoints(run_id, version);
`;

export class SqliteCheckpointStore implements CheckpointStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(CHECKPOINT_SCHEMA);
  }

  /**
   * Save a checkpoint for the given run, and rotate the superseded ones.
   *
   * Transactional for the same reason `appendEvent` is: `MAX(version) + 1`
   * followed by an INSERT is a read-modify-write and the UNIQUE constraint is
   * the only thing between two writers and a lost row.
   *
   * `keep` rotation is what stops the table growing without bound. It deletes
   * only rows of THIS run — never another session's, and never on a schedule
   * nobody asked for. Existing history is left alone; `rune doctor` reports it
   * and `rune doctor prune-checkpoints` removes it, on purpose, with a flag.
   */
  save(runId: string, state: RunState, keep = 2): void {
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(state);

    const write = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM checkpoints WHERE run_id = ?",
        )
        .get(runId) as { next_version: number };

      const version = row.next_version;

      this.db
        .prepare(
          "INSERT INTO checkpoints (run_id, version, state_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(runId, version, stateJson, now);

      if (keep > 0 && version > keep) {
        this.db
          .prepare("DELETE FROM checkpoints WHERE run_id = ? AND version <= ?")
          .run(runId, version - keep);
      }
    });

    write();
  }

  /**
   * Load the latest checkpoint for a given run.
   * Returns null if no checkpoint exists.
   */
  load(runId: string): CheckpointVersion | null {
    const row = this.db
      .prepare(
        `SELECT run_id, version, state_json, created_at
         FROM checkpoints
         WHERE run_id = ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(runId) as {
      run_id: string;
      version: number;
      state_json: string;
      created_at: string;
    } | null;

    if (!row) return null;

    return {
      runId: row.run_id,
      version: row.version,
      state: JSON.parse(row.state_json) as RunState,
      createdAt: row.created_at,
    };
  }

  /**
   * Load a specific version of a checkpoint for a given run.
   * Returns null if no such version exists.
   */
  loadVersion(runId: string, version: number): CheckpointVersion | null {
    const row = this.db
      .prepare(
        `SELECT run_id, version, state_json, created_at
         FROM checkpoints
         WHERE run_id = ? AND version = ?`,
      )
      .get(runId, version) as {
      run_id: string;
      version: number;
      state_json: string;
      created_at: string;
    } | null;

    if (!row) return null;

    return {
      runId: row.run_id,
      version: row.version,
      state: JSON.parse(row.state_json) as RunState,
      createdAt: row.created_at,
    };
  }

  /**
   * Get the last checkpoint for a given run (alias for load).
   */
  getLastCheckpoint(runId: string): CheckpointVersion | null {
    return this.load(runId);
  }

  /**
   * List all checkpoints for a given run, ordered by version ascending.
   */
  listCheckpoints(runId: string): CheckpointVersion[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, version, state_json, created_at
         FROM checkpoints
         WHERE run_id = ?
         ORDER BY version ASC`,
      )
      .all(runId) as Array<{
      run_id: string;
      version: number;
      state_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      version: row.version,
      state: JSON.parse(row.state_json) as RunState,
      createdAt: row.created_at,
    }));
  }
}

// ─── Reporting and pruning ───

export interface CheckpointReport {
  rows: number;
  bytes: number;
  runs: number;
  /** Rows whose session no longer exists, or that belong to a finished run. */
  reclaimableRows: number;
  reclaimableBytes: number;
  oldest: string | null;
  newest: string | null;
}

/**
 * What the checkpoints table currently holds, and how much of it is dead.
 *
 * "Reclaimable" is deliberately conservative: a row is only counted when its
 * session row is gone, or when the row is superseded past `keep` newer
 * versions of the same run. Nothing here deletes anything.
 *
 * `keep` must match `pruneCheckpoints`'s default, and does. It used to count
 * every row with ANY newer version, so the doctor advertised 552 rows / 136 MB
 * as reclaimable while the command it named in the same sentence removed 428 /
 * 106 MB — the report promised more than the prune delivered, and the
 * difference was exactly the versions the keep rule preserves.
 */
export function reportCheckpoints(db: Database, keep = DEFAULT_KEEP_VERSIONS): CheckpointReport {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(state_json)), 0) AS bytes,
              COUNT(DISTINCT run_id) AS runs,
              MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM checkpoints`,
    )
    .get() as {
    rows: number;
    bytes: number;
    runs: number;
    oldest: string | null;
    newest: string | null;
  };

  // The same predicate `pruneCheckpoints` uses, with the same keep rule, so
  // the number the doctor prints is the number the prune command removes.
  const dead = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(c.state_json)), 0) AS bytes
         FROM checkpoints c
        WHERE (
                SELECT COUNT(*) FROM checkpoints newer
                 WHERE newer.run_id = c.run_id AND newer.version > c.version
              ) >= ?
           OR NOT EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.id = c.run_id
                    OR c.run_id LIKE s.id || '%'
              )`,
    )
    .get(Math.max(1, Math.floor(keep))) as { rows: number; bytes: number };

  return {
    rows: totals.rows ?? 0,
    bytes: totals.bytes ?? 0,
    runs: totals.runs ?? 0,
    reclaimableRows: dead.rows ?? 0,
    reclaimableBytes: dead.bytes ?? 0,
    oldest: totals.oldest,
    newest: totals.newest,
  };
}

/**
 * Remove superseded and orphaned checkpoint rows.
 *
 * DRY RUN unless `apply` is true, because this is the founder's own history
 * and a build agent must not be able to delete it by running a report. Keeps
 * the newest `keep` versions of every run whose session still exists.
 */
export function pruneCheckpoints(
  db: Database,
  opts: { apply?: boolean; keep?: number } = {},
): { removedRows: number; removedBytes: number; applied: boolean } {
  const keep = Math.max(1, Math.floor(opts.keep ?? DEFAULT_KEEP_VERSIONS));
  const doomed = db
    .prepare(
      `SELECT c.id AS id, LENGTH(c.state_json) AS bytes
         FROM checkpoints c
        WHERE (
                SELECT COUNT(*) FROM checkpoints newer
                 WHERE newer.run_id = c.run_id AND newer.version > c.version
              ) >= ?
           OR NOT EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.id = c.run_id
                    OR c.run_id LIKE s.id || '%'
              )`,
    )
    .all(keep) as Array<{ id: number; bytes: number }>;

  const removedBytes = doomed.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  if (!opts.apply || doomed.length === 0) {
    return { removedRows: doomed.length, removedBytes, applied: false };
  }

  const remove = db.transaction((ids: number[]) => {
    const stmt = db.prepare("DELETE FROM checkpoints WHERE id = ?");
    for (const id of ids) stmt.run(id);
  });
  remove(doomed.map((row) => row.id));
  return { removedRows: doomed.length, removedBytes, applied: true };
}
