/**
 * Shared SQL schema constants for Alan's SQLite databases.
 *
 * These are additive index definitions that can be applied on top of
 * the core tables created in session.ts and state.ts.
 */

export const CHECKPOINT_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_run_ver ON checkpoints(run_id, version);
`;

export const AUDIT_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
`;

export const SESSION_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_root);
`;

/**
 * Apply all additive indexes to the given database.
 * Safe to call multiple times (all statements use IF NOT EXISTS).
 */
export function applyIndexes(db: { exec: (sql: string) => void }): void {
  db.exec(CHECKPOINT_INDEXES);
  db.exec(AUDIT_INDEXES);
  db.exec(SESSION_INDEXES);
}
