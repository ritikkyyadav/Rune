use chrono::Utc;
use rusqlite::{Connection, params};
use std::path::Path;
use uuid::Uuid;

use crate::error::AlanError;
use crate::protocol::{SessionEvent, SessionInfo};

pub struct SessionManager {
    conn: Connection,
}

impl SessionManager {
    pub fn open(db_path: &Path) -> Result<Self, AlanError> {
        let conn = Connection::open(db_path)?;
        let mgr = Self { conn };
        mgr.initialize_schema()?;
        Ok(mgr)
    }

    fn initialize_schema(&self) -> Result<(), AlanError> {
        self.conn.execute_batch(Self::SCHEMA)?;
        Ok(())
    }

    const SCHEMA: &str = r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            workspace_root  TEXT NOT NULL,
            model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
            system_prompt_hash TEXT,
            title           TEXT,
            status          TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'archived', 'deleted'))
        );

        CREATE TABLE IF NOT EXISTS events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq             INTEGER NOT NULL,
            type            TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(session_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session_seq
            ON events(session_id, seq);

        CREATE TABLE IF NOT EXISTS files (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            path            TEXT NOT NULL,
            hash            TEXT NOT NULL,
            last_read_seq   INTEGER NOT NULL,
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(session_id, path)
        );

        CREATE TABLE IF NOT EXISTS permissions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            tool            TEXT NOT NULL,
            scope           TEXT NOT NULL DEFAULT 'session'
                            CHECK (scope IN ('once', 'session', 'project', 'global')),
            pattern         TEXT,
            granted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            expires_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT,
            tool_name       TEXT NOT NULL,
            args_hash       TEXT NOT NULL,
            result_hash     TEXT,
            duration_ms     INTEGER,
            exit_code       INTEGER,
            prev_hash       TEXT,
            entry_hash      TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
    "#;

    pub fn create_session(
        &self,
        workspace_root: &str,
        model: &str,
    ) -> Result<SessionInfo, AlanError> {
        let id = Uuid::now_v7();
        let now = Utc::now();

        self.conn.execute(
            "INSERT INTO sessions (id, workspace_root, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id.to_string(), workspace_root, model, now.to_rfc3339(),],
        )?;

        Ok(SessionInfo {
            id,
            created_at: now,
            updated_at: now,
            workspace_root: workspace_root.to_string(),
            model: model.to_string(),
            event_count: 0,
            title: None,
        })
    }

    pub fn append_event(&self, session_id: &Uuid, event: &SessionEvent) -> Result<u64, AlanError> {
        let event_type = event_type_name(event);
        let payload = serde_json::to_string(event)?;

        let seq: u64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?1",
            params![session_id.to_string()],
            |row| row.get(0),
        )?;

        self.conn.execute(
            "INSERT INTO events (session_id, seq, type, payload_json) VALUES (?1, ?2, ?3, ?4)",
            params![session_id.to_string(), seq, event_type, payload],
        )?;

        self.conn.execute(
            "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![session_id.to_string()],
        )?;

        Ok(seq)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>, AlanError> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.created_at, s.updated_at, s.workspace_root, s.model, s.title,
                    (SELECT COUNT(*) FROM events WHERE session_id = s.id) as event_count
             FROM sessions s
             WHERE s.status = 'active'
             ORDER BY s.updated_at DESC",
        )?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(SessionInfo {
                    id: row.get::<_, String>(0)?.parse().unwrap(),
                    created_at: row.get::<_, String>(1)?.parse().unwrap(),
                    updated_at: row.get::<_, String>(2)?.parse().unwrap(),
                    workspace_root: row.get(3)?,
                    model: row.get(4)?,
                    title: row.get(5)?,
                    event_count: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(sessions)
    }

    pub fn get_events(
        &self,
        session_id: &Uuid,
        from_seq: u64,
        limit: Option<u64>,
    ) -> Result<Vec<(u64, SessionEvent)>, AlanError> {
        let limit = limit.unwrap_or(i64::MAX as u64);
        let mut stmt = self.conn.prepare(
            "SELECT seq, payload_json FROM events
             WHERE session_id = ?1 AND seq >= ?2
             ORDER BY seq ASC
             LIMIT ?3",
        )?;

        let events = stmt
            .query_map(
                params![session_id.to_string(), from_seq, limit as i64],
                |row| {
                    let seq: u64 = row.get(0)?;
                    let payload: String = row.get(1)?;
                    let event: SessionEvent = serde_json::from_str(&payload).unwrap();
                    Ok((seq, event))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(events)
    }

    // ─── Crash Recovery ───

    /// Mark a session as "running" by inserting a system_note checkpoint.
    /// Call this when a session is started or resumed.
    pub fn mark_running(&self, session_id: &Uuid) -> Result<u64, AlanError> {
        self.append_event(
            session_id,
            &SessionEvent::Checkpoint {
                summary: "session_started".to_string(),
            },
        )
    }

    /// Insert a checkpoint event summarizing the current state.
    /// Call this periodically (e.g. every 10 turns).
    pub fn create_checkpoint(&self, session_id: &Uuid, summary: &str) -> Result<u64, AlanError> {
        self.append_event(
            session_id,
            &SessionEvent::Checkpoint {
                summary: summary.to_string(),
            },
        )
    }

    /// Find sessions that were active but have a "session_started" checkpoint
    /// as their last checkpoint without a corresponding "session_ended" checkpoint.
    /// These are "dirty" sessions that may have crashed mid-execution.
    pub fn find_dirty_sessions(&self) -> Result<Vec<SessionInfo>, AlanError> {
        // Sessions that have a "session_started" checkpoint but no "session_ended"
        // checkpoint after it.
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.created_at, s.updated_at, s.workspace_root, s.model, s.title,
                    (SELECT COUNT(*) FROM events WHERE session_id = s.id) as event_count
             FROM sessions s
             WHERE s.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM events e
                 WHERE e.session_id = s.id
                   AND e.type = 'checkpoint'
                   AND e.payload_json LIKE '%session_started%'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM events e2
                 WHERE e2.session_id = s.id
                   AND e2.type = 'checkpoint'
                   AND e2.payload_json LIKE '%session_ended%'
                   AND e2.seq > (
                     SELECT MAX(e3.seq) FROM events e3
                     WHERE e3.session_id = s.id
                       AND e3.type = 'checkpoint'
                       AND e3.payload_json LIKE '%session_started%'
                   )
               )
             ORDER BY s.updated_at DESC",
        )?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(SessionInfo {
                    id: row.get::<_, String>(0)?.parse().unwrap(),
                    created_at: row.get::<_, String>(1)?.parse().unwrap(),
                    updated_at: row.get::<_, String>(2)?.parse().unwrap(),
                    workspace_root: row.get(3)?,
                    model: row.get(4)?,
                    title: row.get(5)?,
                    event_count: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(sessions)
    }

    /// Mark a session as cleanly ended.
    pub fn mark_ended(&self, session_id: &Uuid) -> Result<u64, AlanError> {
        self.append_event(
            session_id,
            &SessionEvent::Checkpoint {
                summary: "session_ended".to_string(),
            },
        )
    }

    /// Rollback a dirty session to the last checkpoint before the crash.
    /// Deletes all events after the last "session_started" checkpoint.
    pub fn rollback_to_last_checkpoint(&self, session_id: &Uuid) -> Result<u64, AlanError> {
        let checkpoint_seq: u64 = self.conn.query_row(
            "SELECT MAX(seq) FROM events
             WHERE session_id = ?1
               AND type = 'checkpoint'
               AND payload_json LIKE '%session_started%'",
            params![session_id.to_string()],
            |row| row.get(0),
        )?;

        let deleted = self.conn.execute(
            "DELETE FROM events WHERE session_id = ?1 AND seq > ?2",
            params![session_id.to_string(), checkpoint_seq],
        )?;

        Ok(deleted as u64)
    }
}

fn event_type_name(event: &SessionEvent) -> &'static str {
    match event {
        SessionEvent::UserMessage { .. } => "user_msg",
        SessionEvent::AssistantMessage { .. } => "assistant_msg",
        SessionEvent::ToolCall { .. } => "tool_call",
        SessionEvent::ToolResult { .. } => "tool_result",
        SessionEvent::SystemNote { .. } => "system_note",
        SessionEvent::Checkpoint { .. } => "checkpoint",
        SessionEvent::PlanCreated { .. } => "plan_created",
        SessionEvent::PlanUpdated { .. } => "plan_updated",
        SessionEvent::StepCompleted { .. } => "step_completed",
    }
}
