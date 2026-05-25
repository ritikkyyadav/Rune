import { Database } from "bun:sqlite";

// ─── Run State ───

export interface RunState {
  runId: string;
  sessionId: string;
  messages: unknown[];
  turnCount: number;
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

export interface CheckpointPolicy {
  intervalTurns: number; // default 5
  intervalMs: number; // default 60000
  onToolSuccess: boolean; // default true
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  intervalTurns: 5,
  intervalMs: 60000,
  onToolSuccess: true,
};

// ─── Checkpoint Store Interface ───

export interface CheckpointStore {
  save(runId: string, state: RunState): void;
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
   * Save a checkpoint for the given run. Automatically increments the version
   * number based on the highest existing version for this run.
   */
  save(runId: string, state: RunState): void {
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(state);

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
