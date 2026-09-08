import { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import { createHash } from "crypto";

// ─── Types ───

export interface SessionEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type SessionStatus = "active" | "archived" | "deleted";

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  workspace_root: string;
  model: string;
  provider: string | null;
  title: string | null;
  status: string;
  event_count: number;
  last_tokens: number | null;
  system_prompt_hash: string | null;
}

export interface SessionInfoInternal {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  model: string;
  /** Provider the session was created on (null for pre-migration rows). */
  provider: string | null;
  eventCount: number;
  title: string | null;
  status: SessionStatus;
  /** Last reported context-window occupancy in tokens (null before any report). */
  lastTokens: number | null;
  /**
   * Digest of the doctrine this session was created under. The column has
   * existed since the first schema and was NULL for every one of the 601
   * sessions on this machine, which is why no measured difference between two
   * runs could ever be attributed to the prompt that caused it.
   */
  systemPromptHash: string | null;
}

// ─── Schema (mirrors the Rust session schema exactly) ───

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    workspace_root  TEXT NOT NULL,
    model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
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
    created_at      TEXT NOT NULL,
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
    updated_at      TEXT NOT NULL,
    UNIQUE(session_id, path)
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool            TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'session'
                    CHECK (scope IN ('once', 'session', 'project', 'global')),
    pattern         TEXT,
    granted_at      TEXT NOT NULL,
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
    created_at      TEXT NOT NULL
  );
`;

function rowToSessionInfo(r: SessionRow): SessionInfoInternal {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    workspaceRoot: r.workspace_root,
    model: r.model,
    provider: r.provider ?? null,
    eventCount: r.event_count,
    title: r.title,
    status: (r.status as SessionStatus) ?? "active",
    lastTokens: r.last_tokens ?? null,
    systemPromptHash: r.system_prompt_hash ?? null,
  };
}

/**
 * Derive a short, human-readable title from a session's first user message.
 * Collapses whitespace and trims to a single readable line, so the session
 * manager shows "fix the login redirect" instead of a bare UUID.
 */
export function deriveSessionTitle(firstMessage: string, max = 60): string {
  const cleaned = firstMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  // Cut on a word boundary near the limit when possible, else hard-truncate.
  const slice = cleaned.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

// ─── Session Manager ───

export class SessionManager {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive, idempotent migrations for databases created before a column
   * existed. SQLite has no "ADD COLUMN IF NOT EXISTS", so we probe the table
   * shape first. Safe to run on every open.
   */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "provider")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT");
    }
    if (!cols.some((c) => c.name === "last_tokens")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_tokens INTEGER");
    }
    if (!cols.some((c) => c.name === "system_prompt_hash")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN system_prompt_hash TEXT");
    }
  }

  /**
   * Record the session's current context-window occupancy (provider-reported).
   * Metadata for the sessions manager only — deliberately does NOT touch
   * updated_at, so a token report never reorders the recency-sorted list.
   */
  noteContextTokens(sessionId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.db
      .prepare("UPDATE sessions SET last_tokens = ? WHERE id = ?")
      .run(Math.round(tokens), sessionId);
  }

  /**
   * `systemPromptHash` is the doctrine digest the caller is running under
   * (`doctrineHash()` in the orchestrator). Optional so every existing caller
   * keeps working; passing it is what makes a run attributable to the prompt
   * that produced it.
   */
  createSession(
    workspaceRoot: string,
    model: string,
    provider?: string,
    systemPromptHash?: string | null,
  ): SessionInfoInternal {
    const id = randomUUIDv7();
    const now = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO sessions (id, workspace_root, model, provider, system_prompt_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, workspaceRoot, model, provider ?? null, systemPromptHash ?? null, now, now);

    return {
      id,
      createdAt: now,
      updatedAt: now,
      workspaceRoot,
      model,
      provider: provider ?? null,
      eventCount: 0,
      title: null,
      status: "active",
      lastTokens: null,
      systemPromptHash: systemPromptHash ?? null,
    };
  }

  updateSessionModel(sessionId: string, model: string, provider?: string): void {
    const now = new Date().toISOString();
    if (provider !== undefined) {
      this.db
        .prepare("UPDATE sessions SET model = ?, provider = ?, updated_at = ? WHERE id = ?")
        .run(model, provider, now, sessionId);
    } else {
      this.db
        .prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
        .run(model, now, sessionId);
    }
  }

  /** Rename a session (the `title` shown in the session manager). Empty/whitespace clears it. */
  renameSession(sessionId: string, title: string): void {
    const now = new Date().toISOString();
    const clean = title.trim();
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(clean.length ? clean : null, now, sessionId);
  }

  /** Set a title only if the session has none yet — used to auto-name from the first message. */
  setTitleIfEmpty(sessionId: string, title: string): void {
    const clean = title.trim();
    if (!clean.length) return;
    this.db
      .prepare("UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')")
      .run(clean, sessionId);
  }

  /** Move a session between active / archived / deleted (soft delete keeps the data). */
  setSessionStatus(sessionId: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, sessionId);
  }

  /**
   * Permanently remove a session and (via ON DELETE CASCADE) all of its events,
   * files and permissions. Irreversible — the soft-delete path is setSessionStatus.
   */
  purgeSession(sessionId: string): number {
    // `changes` would also count cascade-deleted events; report just the session
    // row (0 or 1) so the result means "sessions removed", not "rows touched".
    const existed = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) ? 1 : 0;
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return existed;
  }

  appendEvent(sessionId: string, event: SessionEvent): number {
    const now = new Date().toISOString();
    const payloadJson = JSON.stringify(event);

    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM events WHERE session_id = ?")
      .get(sessionId) as { next_seq: number };

    const seq = row.next_seq;

    this.db
      .prepare(
        "INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, seq, event.type, payloadJson, now);

    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);

    return seq;
  }

  /**
   * List sessions, newest-activity first. Defaults to active sessions; pass a
   * status (or "all") to include archived/deleted ones for the manager view.
   */
  listSessions(opts?: { status?: SessionStatus | "all" }): SessionInfoInternal[] {
    const status = opts?.status ?? "active";
    const where = status === "all" ? "" : "WHERE s.status = ?";
    const stmt = this.db.prepare(
      `SELECT s.id, s.created_at, s.updated_at, s.workspace_root, s.model, s.provider, s.title, s.status, s.last_tokens, s.system_prompt_hash,
              (SELECT COUNT(*) FROM events WHERE session_id = s.id) as event_count
       FROM sessions s
       ${where}
       ORDER BY s.updated_at DESC`,
    );
    const rows = (status === "all" ? stmt.all() : stmt.all(status)) as SessionRow[];
    return rows.map(rowToSessionInfo);
  }

  getEvents(
    sessionId: string,
    fromSeq: number,
    limit?: number,
  ): Array<{ seq: number; event: SessionEvent; at: string }> {
    const effectiveLimit = limit ?? 999999999;

    const rows = this.db
      .prepare(
        `SELECT seq, payload_json, created_at FROM events
         WHERE session_id = ? AND seq >= ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionId, fromSeq, effectiveLimit) as Array<{
      seq: number;
      payload_json: string;
      created_at: string;
    }>;

    // `at` is the row's own clock. The retro's silence measure — how long a
    // turn goes without a new transcript row — is derived from it.
    return rows.map((r) => ({
      seq: r.seq,
      event: JSON.parse(r.payload_json) as SessionEvent,
      at: r.created_at,
    }));
  }

  /** Latest keyed checkpoint without loading the parent's full transcript. */
  getLatestKeyedEvent(sessionId: string, type: string, id: string): SessionEvent | null {
    const row = this.db
      .query(
        `SELECT payload_json FROM events
      WHERE session_id = ? AND json_extract(payload_json, '$.type') = ?
      AND json_extract(payload_json, '$.payload.id') = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, type, id) as { payload_json: string } | null;
    return row ? (JSON.parse(row.payload_json) as SessionEvent) : null;
  }

  /**
   * Delete every event for a session whose seq is strictly greater than
   * `afterSeq`. Used by `/rewind` to truncate the conversation back to an
   * earlier turn (the next chat then resumes from the truncated history).
   * Returns the number of events removed.
   */
  deleteEventsAfter(sessionId: string, afterSeq: number): number {
    const result = this.db
      .prepare("DELETE FROM events WHERE session_id = ? AND seq > ?")
      .run(sessionId, afterSeq);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    return Number(result.changes ?? 0);
  }

  /** Fetch an *active* session (null for missing/archived/deleted). Backs chat/replay. */
  getSession(sessionId: string): SessionInfoInternal | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.created_at, s.updated_at, s.workspace_root, s.model, s.provider, s.title, s.status, s.last_tokens, s.system_prompt_hash,
                (SELECT COUNT(*) FROM events WHERE session_id = s.id) as event_count
         FROM sessions s WHERE s.id = ? AND s.status = 'active'`,
      )
      .get(sessionId) as SessionRow | null;

    if (!row) return null;
    return rowToSessionInfo(row);
  }

  /** Fetch a session regardless of status (active/archived/deleted) — backs the manager. */
  getSessionInfo(sessionId: string): SessionInfoInternal | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.created_at, s.updated_at, s.workspace_root, s.model, s.provider, s.title, s.status, s.last_tokens, s.system_prompt_hash,
                (SELECT COUNT(*) FROM events WHERE session_id = s.id) as event_count
         FROM sessions s WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | null;

    if (!row) return null;
    return rowToSessionInfo(row);
  }

  // ─── Audit Log (hash-chained, tamper-evident) ───
  //
  // Each entry's hash binds it to the previous one, so any retroactive
  // edit invalidates every subsequent hash. `verifyAuditChain` recomputes
  // every hash and reports the first mismatch.

  appendAuditEntry(entry: {
    sessionId?: string | null;
    toolName: string;
    argsHash: string;
    resultHash?: string | null;
    durationMs?: number | null;
    exitCode?: number | null;
  }): { id: number; entryHash: string; prevHash: string } {
    const prevRow = this.db
      .prepare("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { entry_hash: string } | null;
    const prevHash = prevRow?.entry_hash ?? "";
    const now = new Date().toISOString();

    const entryHash = computeEntryHash({
      prevHash,
      sessionId: entry.sessionId ?? null,
      toolName: entry.toolName,
      argsHash: entry.argsHash,
      resultHash: entry.resultHash ?? null,
      durationMs: entry.durationMs ?? null,
      exitCode: entry.exitCode ?? null,
      createdAt: now,
    });

    const result = this.db
      .prepare(
        `INSERT INTO audit_log
          (session_id, tool_name, args_hash, result_hash, duration_ms, exit_code,
           prev_hash, entry_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId ?? null,
        entry.toolName,
        entry.argsHash,
        entry.resultHash ?? null,
        entry.durationMs ?? null,
        entry.exitCode ?? null,
        prevHash,
        entryHash,
        now,
      );

    return {
      id: Number(result.lastInsertRowid),
      entryHash,
      prevHash,
    };
  }

  /**
   * Walk the audit log in order and verify each entry's hash. Returns the
   * id of the first tampered entry, or null if the chain is intact.
   */
  verifyAuditChain(): { ok: true } | { ok: false; firstBadId: number } {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, tool_name, args_hash, result_hash, duration_ms,
                exit_code, prev_hash, entry_hash, created_at
         FROM audit_log ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      session_id: string | null;
      tool_name: string;
      args_hash: string;
      result_hash: string | null;
      duration_ms: number | null;
      exit_code: number | null;
      prev_hash: string;
      entry_hash: string;
      created_at: string;
    }>;

    let expectedPrev = "";
    for (const r of rows) {
      if (r.prev_hash !== expectedPrev) {
        return { ok: false, firstBadId: r.id };
      }
      const recomputed = computeEntryHash({
        prevHash: r.prev_hash,
        sessionId: r.session_id,
        toolName: r.tool_name,
        argsHash: r.args_hash,
        resultHash: r.result_hash,
        durationMs: r.duration_ms,
        exitCode: r.exit_code,
        createdAt: r.created_at,
      });
      if (recomputed !== r.entry_hash) {
        return { ok: false, firstBadId: r.id };
      }
      expectedPrev = r.entry_hash;
    }
    return { ok: true };
  }

  close(): void {
    this.db.close();
  }
}

function computeEntryHash(parts: {
  prevHash: string;
  sessionId: string | null;
  toolName: string;
  argsHash: string;
  resultHash: string | null;
  durationMs: number | null;
  exitCode: number | null;
  createdAt: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.prevHash);
  h.update("\x1f");
  h.update(parts.sessionId ?? "");
  h.update("\x1f");
  h.update(parts.toolName);
  h.update("\x1f");
  h.update(parts.argsHash);
  h.update("\x1f");
  h.update(parts.resultHash ?? "");
  h.update("\x1f");
  h.update(String(parts.durationMs ?? ""));
  h.update("\x1f");
  h.update(String(parts.exitCode ?? ""));
  h.update("\x1f");
  h.update(parts.createdAt);
  return h.digest("hex");
}

/** Hash arbitrary JSON-serialisable args with a stable encoding. */
export function hashArgs(args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(args ?? null))
    .digest("hex");
}

/** Hash a result string (or stringify-and-hash a non-string). */
export function hashResult(result: unknown): string {
  const s = typeof result === "string" ? result : JSON.stringify(result ?? "");
  return createHash("sha256").update(s).digest("hex");
}

// ─── Auto Verification ───

export interface AuditVerificationStats {
  totalCalls: number;
  lastVerified: Date | null;
  isValid: boolean;
}

/**
 * Verify the audit chain of a SessionManager instance.
 * Returns { valid: true } if intact, { valid: false, firstBadId } otherwise.
 */
function verifyAuditChain(db: SessionManager): { valid: boolean; firstBadId?: number } {
  const result = db.verifyAuditChain();
  if (result.ok) return { valid: true };
  return { valid: false, firstBadId: result.firstBadId };
}

/**
 * Create an auto-verifier that periodically checks audit chain integrity
 * after a configurable number of tool calls.
 */
export function createAutoVerifier(
  db: SessionManager,
  intervalCalls: number = 50,
): {
  onToolCall: () => void;
  getStats: () => AuditVerificationStats;
} {
  let callCount = 0;
  let lastVerified: Date | null = null;
  let isValid = true;

  return {
    onToolCall: () => {
      callCount++;
      if (callCount % intervalCalls === 0) {
        try {
          const result = verifyAuditChain(db);
          isValid = result.valid !== false;
          lastVerified = new Date();
          if (!isValid) console.error("[AUDIT] Chain integrity FAILED");
        } catch (e) {
          console.error("[AUDIT] Verification error:", e);
        }
      }
    },
    getStats: () => ({ totalCalls: callCount, lastVerified, isValid }),
  };
}
