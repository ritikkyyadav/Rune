// ─── Team bus: cross-instance coordination ───
//
// Two Gear processes in one repository used to be completely blind to each
// other: worker ownership claims lived in-process, so parallel instances could
// write the same files, and there was no way for one session to tell another
// anything. The bus is the fix — a small shared SQLite ledger (same WAL +
// busy-timeout pattern as gear.db / notebook.db / blackbox.db) holding, per
// repository:
//
//   presence  — who is here (pid-liveness checked, heartbeat-staled)
//   claims    — path scopes an instance is working on (atomic, TTL'd)
//   messages  — teammate mail, delivered at the receiver's turn boundaries
//   writes    — recent file writes, for soft "you're both editing X" warnings
//
// Repository identity is the git COMMON dir (all worktrees of one repo share
// it), so instances in different worktrees of the same project see each other
// too — claims, however, only ever conflict within the SAME working tree,
// because separate checkouts cannot race on a file.
//
// Design rules, in order: coordination must NEVER break a session (every
// public method degrades to a safe default instead of throwing); liveness is
// mechanical (pid + heartbeat, no cooperation needed from a crashed peer);
// and everything is local — the bus never leaves ~/.gear.

import { Database } from "bun:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface TeamBusOptions {
  /** Absolute path of the shared bus DB (default: <gearHome>/team.db). */
  dbPath: string;
  /** Repository identity — realpath of the git common dir, or the workspace. */
  repoKey: string;
  /** Realpath of THIS instance's working tree. */
  workspace: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  branch?: string;
  /** Presence-liveness window; a beat older than this marks the peer stale. */
  staleMs?: number;
  /** Message retention. */
  messageTtlMs?: number;
  /** Default claim lease. */
  claimTtlMs?: number;
  /** Recent-write advisory window. */
  writeWindowMs?: number;
  /** Test seam: liveness probe for a pid (default: process.kill(pid, 0)). */
  pidAlive?: (pid: number) => boolean;
}

export interface TeamPeer {
  id: string;
  pid: number;
  workspace: string;
  /** True when the peer runs in the SAME working tree (files can collide). */
  sameTree: boolean;
  sessionId?: string;
  model?: string;
  provider?: string;
  branch?: string;
  /** What the peer is working on — auto-set from its task goal, or explicit. */
  intent?: string;
  startedAt: number;
  lastBeat: number;
}

export interface TeamClaim {
  id: string;
  instanceId: string;
  workspace: string;
  /** Workspace-relative paths; a trailing "/" claims the whole subtree. */
  paths: string[];
  reason?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A unit of work any instance in this repository can take.
 *
 * Distinct from a `TeamClaim`, and the distinction is the point: a claim says
 * "these paths are mine, stay off them", a task says "this needs doing, whoever
 * is free". The bus carried the first and not the second, which is why
 * docs/teamwork.md said it was not a task queue.
 */
export interface TeamTask {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** The instance holding it; absent when the task is free. */
  ownerId?: string;
  createdBy: string;
  createdAt: number;
  claimedAt?: number;
  /** Claim TTL. An owner that goes quiet past this releases the task. */
  expiresAt?: number;
  /** What closed it. A task completed with no evidence is a task nobody can check. */
  evidence?: string;
}

interface TaskRow {
  id: string;
  repo_key: string;
  content: string;
  status: string;
  owner_id: string | null;
  created_by: string;
  created_at: number;
  claimed_at: number | null;
  expires_at: number | null;
  evidence: string | null;
}

function rowToTask(row: TaskRow): TeamTask {
  return {
    id: row.id,
    content: row.content,
    status: (row.status as TeamTask["status"]) ?? "pending",
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {}),
  };
}

export interface TeamMessage {
  seq: number;
  fromId: string;
  /** null = broadcast to every instance in the repository. */
  toId: string | null;
  fromIntent?: string;
  body: string;
  createdAt: number;
}

export type ClaimResult =
  | { ok: true; id: string; expiresAt: number }
  | { ok: false; conflict: { claim: TeamClaim; peer?: TeamPeer } };

const DEFAULT_STALE_MS = 45_000;
const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CLAIM_TTL_MS = 30 * 60_000;
const DEFAULT_WRITE_WINDOW_MS = 10 * 60_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_INTENT_CHARS = 140;
const MAX_CLAIM_PATHS = 32;
const WRITES_KEPT_PER_INSTANCE = 40;
/** Full sweeps (dead peers, old messages) run at most this often. */
const SWEEP_INTERVAL_MS = 60_000;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS instances (
    id          TEXT PRIMARY KEY,
    repo_key    TEXT NOT NULL,
    workspace   TEXT NOT NULL,
    pid         INTEGER NOT NULL,
    session_id  TEXT,
    model       TEXT,
    provider    TEXT,
    branch      TEXT,
    intent      TEXT,
    started_at  INTEGER NOT NULL,
    last_beat   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_instances_repo ON instances(repo_key);

  CREATE TABLE IF NOT EXISTS claims (
    id           TEXT PRIMARY KEY,
    repo_key     TEXT NOT NULL,
    workspace    TEXT NOT NULL,
    instance_id  TEXT NOT NULL,
    paths        TEXT NOT NULL,
    reason       TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_claims_repo ON claims(repo_key);

  -- The cross-instance work queue.
  --
  -- docs/teamwork.md said plainly that the bus "is not a task queue", and that
  -- was correct: it carried presence, path claims and messages, so two Gear
  -- instances in one repository could avoid each other but could not divide
  -- work. A task here is claimed the same way a path is — atomically, with a
  -- TTL, swept by the same liveness pass — so an instance that dies releases
  -- its task instead of stranding it.
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    repo_key     TEXT NOT NULL,
    content      TEXT NOT NULL,
    status       TEXT NOT NULL,            -- pending | in_progress | completed
    owner_id     TEXT,                     -- instance holding it, NULL when free
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    claimed_at   INTEGER,
    expires_at   INTEGER,                  -- claim TTL; NULL when unclaimed
    evidence     TEXT                      -- what closed it
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_key, status);

  CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_key    TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_id       TEXT,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_repo ON messages(repo_key, seq);

  CREATE TABLE IF NOT EXISTS writes (
    instance_id  TEXT NOT NULL,
    repo_key     TEXT NOT NULL,
    workspace    TEXT NOT NULL,
    path         TEXT NOT NULL,
    at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_writes_repo ON writes(repo_key, at);
`;

/**
 * Overlap between two normalized workspace-relative path keys: equal, or one
 * is a directory prefix of the other ("src/auth/" vs "src/auth/session.ts").
 * Same semantics as the worker Ownership table, on strings.
 */
export function pathKeysOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && (b.startsWith(a) || b + "/" === a)) return true;
  if (b.endsWith("/") && (a.startsWith(b) || a + "/" === b)) return true;
  return false;
}

/**
 * Normalize a claim/write path to a workspace-relative key with "/" separators
 * (a trailing "/" marks a directory subtree). Returns null for paths outside
 * the workspace — those can never conflict inside it.
 */
export function toPathKey(workspace: string, path: string): string | null {
  const isDir = path.endsWith("/") || path.endsWith(sep);
  const abs = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const rel = relative(resolve(workspace), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const key = rel.split(sep).join("/");
  return isDir ? key + "/" : key;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

interface InstanceRow {
  id: string;
  repo_key: string;
  workspace: string;
  pid: number;
  session_id: string | null;
  model: string | null;
  provider: string | null;
  branch: string | null;
  intent: string | null;
  started_at: number;
  last_beat: number;
}

interface ClaimRow {
  id: string;
  workspace: string;
  instance_id: string;
  paths: string;
  reason: string | null;
  created_at: number;
  expires_at: number;
}

export class TeamBus {
  readonly instanceId: string;
  private db: Database | null;
  private readonly opts: Required<Pick<TeamBusOptions, "dbPath" | "repoKey" | "workspace">> &
    TeamBusOptions;
  private readonly staleMs: number;
  private readonly messageTtlMs: number;
  private readonly claimTtlMs: number;
  private readonly writeWindowMs: number;
  private readonly pidAlive: (pid: number) => boolean;
  private inboxCursor = 0;
  private lastSweep = 0;
  private exitHandler: (() => void) | null = null;

  /**
   * Open (or create) the shared bus and register this process. Returns null
   * when the DB cannot be opened — the session then simply runs without a
   * team layer, which must never be fatal.
   */
  static open(opts: TeamBusOptions): TeamBus | null {
    try {
      return new TeamBus(opts);
    } catch {
      return null;
    }
  }

  private constructor(opts: TeamBusOptions) {
    this.opts = { ...opts };
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.messageTtlMs = opts.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
    this.claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.writeWindowMs = opts.writeWindowMs ?? DEFAULT_WRITE_WINDOW_MS;
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.instanceId = shortId("g");
    this.db = new Database(opts.dbPath, { create: true });
    this.db.exec(SCHEMA);

    const now = Date.now();
    this.db
      .query(
        `INSERT INTO instances (id, repo_key, workspace, pid, session_id, model, provider, branch, intent, started_at, last_beat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        this.instanceId,
        opts.repoKey,
        opts.workspace,
        process.pid,
        opts.sessionId ?? null,
        opts.model ?? null,
        opts.provider ?? null,
        opts.branch ?? null,
        now,
        now,
      );

    // Deliver only what arrives AFTER this instance joined.
    const row = this.db
      .query(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE repo_key = ?`)
      .get(opts.repoKey) as { max_seq: number } | null;
    this.inboxCursor = row?.max_seq ?? 0;

    this.sweep(now);

    // Best-effort departure on clean exit; crashes are covered by pid reaping.
    this.exitHandler = () => this.leave();
    process.on("exit", this.exitHandler);
  }

  /** False once the DB has failed or been closed — every method then no-ops. */
  get healthy(): boolean {
    return this.db !== null;
  }

  /** Run a DB operation, degrading to `fallback` on any failure. */
  private guard<T>(fallback: T, fn: (db: Database) => T): T {
    if (!this.db) return fallback;
    try {
      return fn(this.db);
    } catch {
      return fallback;
    }
  }

  private liveInstanceRows(db: Database, now: number): InstanceRow[] {
    const rows = db
      .query(`SELECT * FROM instances WHERE repo_key = ?`)
      .all(this.opts.repoKey) as InstanceRow[];
    return rows.filter((r) => now - r.last_beat <= this.staleMs && this.pidAlive(r.pid));
  }

  private toPeer(row: InstanceRow): TeamPeer {
    return {
      id: row.id,
      pid: row.pid,
      workspace: row.workspace,
      sameTree: row.workspace === this.opts.workspace,
      sessionId: row.session_id ?? undefined,
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
      branch: row.branch ?? undefined,
      intent: row.intent ?? undefined,
      startedAt: row.started_at,
      lastBeat: row.last_beat,
    };
  }

  private toClaim(row: ClaimRow): TeamClaim {
    let paths: string[] = [];
    try {
      const parsed = JSON.parse(row.paths);
      if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // a corrupt row claims nothing
    }
    return {
      id: row.id,
      instanceId: row.instance_id,
      workspace: row.workspace,
      paths,
      reason: row.reason ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Refresh this instance's presence row (and optionally its metadata). */
  heartbeat(patch?: {
    model?: string;
    provider?: string;
    branch?: string;
    intent?: string;
    sessionId?: string;
  }): void {
    this.guard(undefined, (db) => {
      const now = Date.now();
      db.query(
        `UPDATE instances SET last_beat = ?,
           model = COALESCE(?, model), provider = COALESCE(?, provider),
           branch = COALESCE(?, branch), intent = COALESCE(?, intent),
           session_id = COALESCE(?, session_id)
         WHERE id = ?`,
      ).run(
        now,
        patch?.model ?? null,
        patch?.provider ?? null,
        patch?.branch ?? null,
        patch?.intent ? patch.intent.slice(0, MAX_INTENT_CHARS) : null,
        patch?.sessionId ?? null,
        this.instanceId,
      );
      if (now - this.lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
    });
  }

  /** Set the one-line "what I'm doing" shown to peers. */
  setIntent(intent: string): void {
    this.heartbeat({ intent });
  }

  /** Live peers in this repository, excluding self. */
  peers(): TeamPeer[] {
    return this.guard([] as TeamPeer[], (db) => {
      const now = Date.now();
      return this.liveInstanceRows(db, now)
        .filter((r) => r.id !== this.instanceId)
        .map((r) => this.toPeer(r));
    });
  }

  /** Unexpired claims held by LIVE instances (self included). */
  liveClaims(): Array<TeamClaim & { peer?: TeamPeer }> {
    return this.guard([] as Array<TeamClaim & { peer?: TeamPeer }>, (db) => {
      const now = Date.now();
      const live = new Map(this.liveInstanceRows(db, now).map((r) => [r.id, r]));
      const rows = db
        .query(`SELECT * FROM claims WHERE repo_key = ? AND expires_at > ?`)
        .all(this.opts.repoKey, now) as ClaimRow[];
      return rows
        .filter((r) => live.has(r.instance_id))
        .map((r) => {
          const claim = this.toClaim(r) as TeamClaim & { peer?: TeamPeer };
          const owner = live.get(r.instance_id);
          if (owner && owner.id !== this.instanceId) claim.peer = this.toPeer(owner);
          return claim;
        });
    });
  }

  /**
   * Atomically claim a set of paths for this instance. Conflicts only with
   * unexpired claims of live PEERS in the same working tree; the whole claim
   * succeeds or fails as one unit.
   */
  claim(paths: string[], opts?: { reason?: string; ttlMs?: number }): ClaimResult {
    const keys = paths
      .slice(0, MAX_CLAIM_PATHS)
      .map((p) => toPathKey(this.opts.workspace, p))
      .filter((k): k is string => k !== null);
    if (keys.length === 0) {
      // Nothing inside the workspace to claim — report success with no lease
      // rather than failing a coordination nicety.
      return { ok: true, id: "", expiresAt: 0 };
    }
    const fallback: ClaimResult = { ok: true, id: "", expiresAt: 0 };
    return this.guard<ClaimResult>(fallback, (db) => {
      const now = Date.now();
      const expiresAt = now + (opts?.ttlMs ?? this.claimTtlMs);
      const id = shortId("c");
      const insert = db.transaction(() => {
        const conflict = this.findConflictInternal(db, keys, now);
        if (conflict) return conflict;
        db.query(
          `INSERT INTO claims (id, repo_key, workspace, instance_id, paths, reason, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          this.opts.repoKey,
          this.opts.workspace,
          this.instanceId,
          JSON.stringify(keys),
          opts?.reason?.slice(0, 200) ?? null,
          now,
          expiresAt,
        );
        return null;
      });
      const conflict = insert() as (TeamClaim & { peer?: TeamPeer }) | null;
      if (conflict) return { ok: false, conflict: { claim: conflict, peer: conflict.peer } };
      return { ok: true, id, expiresAt };
    });
  }

  private findConflictInternal(
    db: Database,
    keys: string[],
    now: number,
  ): (TeamClaim & { peer?: TeamPeer }) | null {
    const live = new Map(this.liveInstanceRows(db, now).map((r) => [r.id, r]));
    const rows = db
      .query(
        `SELECT * FROM claims WHERE repo_key = ? AND workspace = ? AND expires_at > ? AND instance_id != ?`,
      )
      .all(this.opts.repoKey, this.opts.workspace, now, this.instanceId) as ClaimRow[];
    for (const row of rows) {
      const owner = live.get(row.instance_id);
      if (!owner) continue;
      const claim = this.toClaim(row);
      if (claim.paths.some((held) => keys.some((k) => pathKeysOverlap(held, k)))) {
        return { ...claim, peer: this.toPeer(owner) };
      }
    }
    return null;
  }

  /** A live peer claim (same tree) overlapping `path`, or null. */
  findConflictingClaim(path: string): (TeamClaim & { peer?: TeamPeer }) | null {
    const key = toPathKey(this.opts.workspace, path);
    if (!key) return null;
    return this.guard(null, (db) => this.findConflictInternal(db, [key], Date.now()));
  }

  /** Release one claim by id, or every claim this instance holds. */
  releaseClaim(id?: string): number {
    return this.guard(0, (db) => {
      const res = id
        ? db.query(`DELETE FROM claims WHERE id = ? AND instance_id = ?`).run(id, this.instanceId)
        : db.query(`DELETE FROM claims WHERE instance_id = ?`).run(this.instanceId);
      return res.changes;
    });
  }

  myClaims(): TeamClaim[] {
    return this.guard([] as TeamClaim[], (db) => {
      const now = Date.now();
      const rows = db
        .query(`SELECT * FROM claims WHERE instance_id = ? AND expires_at > ?`)
        .all(this.instanceId, now) as ClaimRow[];
      return rows.map((r) => this.toClaim(r));
    });
  }

  /**
   * Send a message to one live peer (`toId`) or to every instance in the
   * repository (no `toId`). Returns a human-readable error instead of
   * throwing when the target is unknown.
   */
  /** Publish work for any instance in this repository to pick up. */
  postTask(content: string): TeamTask | null {
    return this.guard<TeamTask | null>(null, (db) => {
      const now = Date.now();
      const id = `t${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      db.query(
        `INSERT INTO tasks (id, repo_key, content, status, owner_id, created_by, created_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
      ).run(id, this.opts.repoKey, content.slice(0, 2000), this.instanceId, now);
      return {
        id,
        content,
        status: "pending",
        createdBy: this.instanceId,
        createdAt: now,
      };
    });
  }

  /**
   * Take the oldest unclaimed task, atomically.
   *
   * The UPDATE … WHERE status='pending' is the arbiter: two instances racing
   * for the same row means one UPDATE changes a row and the other changes
   * none, and the loser simply asks again. A read-then-write would let both
   * believe they won, which is the failure the path-claim model already exists
   * to prevent one layer down.
   */
  claimNextTask(ttlMs?: number): TeamTask | null {
    return this.guard<TeamTask | null>(null, (db) => {
      const now = Date.now();
      if (now - this.lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
      const ttl = ttlMs ?? this.claimTtlMs;
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = db
          .query(
            `SELECT * FROM tasks WHERE repo_key = ? AND status = 'pending'
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(this.opts.repoKey) as TaskRow | null;
        if (!row) return null;
        const res = db
          .query(
            `UPDATE tasks SET status = 'in_progress', owner_id = ?, claimed_at = ?, expires_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(this.instanceId, now, now + ttl, row.id);
        if ((res.changes ?? 0) > 0)
          return rowToTask({ ...row, status: "in_progress", owner_id: this.instanceId });
      }
      return null;
    });
  }

  /** Close a task with the evidence that closed it. */
  completeTask(id: string, evidence?: string): boolean {
    return this.guard(false, (db) => {
      const res = db
        .query(
          `UPDATE tasks SET status = 'completed', expires_at = NULL, evidence = ?
           WHERE id = ? AND owner_id = ?`,
        )
        .run(evidence?.slice(0, 1000) ?? null, id, this.instanceId);
      return (res.changes ?? 0) > 0;
    });
  }

  /** Put a task back. A worker that could not finish it must not hold it. */
  releaseTask(id: string): boolean {
    return this.guard(false, (db) => {
      const res = db
        .query(
          `UPDATE tasks SET status = 'pending', owner_id = NULL, claimed_at = NULL, expires_at = NULL
           WHERE id = ? AND owner_id = ? AND status != 'completed'`,
        )
        .run(id, this.instanceId);
      return (res.changes ?? 0) > 0;
    });
  }

  /** Every task in this repository, newest last. */
  tasks(status?: TeamTask["status"]): TeamTask[] {
    return this.guard<TeamTask[]>([], (db) => {
      const now = Date.now();
      if (now - this.lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
      const rows = (
        status
          ? db
              .query(
                `SELECT * FROM tasks WHERE repo_key = ? AND status = ? ORDER BY created_at ASC`,
              )
              .all(this.opts.repoKey, status)
          : db
              .query(`SELECT * FROM tasks WHERE repo_key = ? ORDER BY created_at ASC`)
              .all(this.opts.repoKey)
      ) as TaskRow[];
      return rows.map(rowToTask);
    });
  }

  send(body: string, toId?: string): { ok: boolean; error?: string } {
    const text = body.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) return { ok: false, error: "empty message" };
    return this.guard({ ok: false, error: "team bus unavailable" }, (db) => {
      if (toId) {
        const now = Date.now();
        const target = this.liveInstanceRows(db, now).find((r) => r.id === toId);
        if (!target) {
          return { ok: false, error: `no live instance "${toId}" in this repository` };
        }
      }
      db.query(
        `INSERT INTO messages (repo_key, from_id, to_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(this.opts.repoKey, this.instanceId, toId ?? null, text, Date.now());
      return { ok: true };
    });
  }

  /** New messages addressed to this instance (or broadcast), oldest first. */
  drainInbox(): TeamMessage[] {
    return this.guard([] as TeamMessage[], (db) => {
      const rows = db
        .query(
          `SELECT m.*, i.intent AS from_intent FROM messages m
           LEFT JOIN instances i ON i.id = m.from_id
           WHERE m.repo_key = ? AND m.seq > ? AND m.from_id != ?
             AND (m.to_id IS NULL OR m.to_id = ?)
           ORDER BY m.seq ASC`,
        )
        .all(this.opts.repoKey, this.inboxCursor, this.instanceId, this.instanceId) as Array<{
        seq: number;
        from_id: string;
        to_id: string | null;
        from_intent: string | null;
        body: string;
        created_at: number;
      }>;
      if (rows.length > 0) this.inboxCursor = rows[rows.length - 1].seq;
      return rows.map((r) => ({
        seq: r.seq,
        fromId: r.from_id,
        toId: r.to_id,
        fromIntent: r.from_intent ?? undefined,
        body: r.body,
        createdAt: r.created_at,
      }));
    });
  }

  /** Count of undelivered messages without consuming them. */
  pendingMessageCount(): number {
    return this.guard(0, (db) => {
      const row = db
        .query(
          `SELECT COUNT(*) AS n FROM messages
           WHERE repo_key = ? AND seq > ? AND from_id != ? AND (to_id IS NULL OR to_id = ?)`,
        )
        .get(this.opts.repoKey, this.inboxCursor, this.instanceId, this.instanceId) as {
        n: number;
      } | null;
      return row?.n ?? 0;
    });
  }

  /** Record a successful file write for peers' soft-conflict warnings. */
  noteWrite(path: string): void {
    const key = toPathKey(this.opts.workspace, path);
    if (!key) return;
    this.guard(undefined, (db) => {
      const now = Date.now();
      db.query(
        `INSERT INTO writes (instance_id, repo_key, workspace, path, at) VALUES (?, ?, ?, ?, ?)`,
      ).run(this.instanceId, this.opts.repoKey, this.opts.workspace, key, now);
      // Ring-cap: keep only the newest rows for this instance.
      db.query(
        `DELETE FROM writes WHERE instance_id = ? AND at NOT IN (
           SELECT at FROM writes WHERE instance_id = ? ORDER BY at DESC LIMIT ?
         )`,
      ).run(this.instanceId, this.instanceId, WRITES_KEPT_PER_INSTANCE);
    });
  }

  /** A live peer's recent write overlapping `path` (same tree), or null. */
  recentPeerWrite(path: string): { peer: TeamPeer; path: string; at: number } | null {
    const key = toPathKey(this.opts.workspace, path);
    if (!key) return null;
    return this.guard(null, (db) => {
      const now = Date.now();
      const live = new Map(this.liveInstanceRows(db, now).map((r) => [r.id, r]));
      const rows = db
        .query(
          `SELECT * FROM writes WHERE repo_key = ? AND workspace = ? AND instance_id != ? AND at > ?
           ORDER BY at DESC`,
        )
        .all(
          this.opts.repoKey,
          this.opts.workspace,
          this.instanceId,
          now - this.writeWindowMs,
        ) as Array<{
        instance_id: string;
        path: string;
        at: number;
      }>;
      for (const row of rows) {
        const owner = live.get(row.instance_id);
        if (owner && pathKeysOverlap(row.path, key)) {
          return { peer: this.toPeer(owner), path: row.path, at: row.at };
        }
      }
      return null;
    });
  }

  /** Remove dead/stale instances (with their claims), and expired rows. */
  private sweep(now: number): void {
    this.lastSweep = now;
    if (!this.db) return;
    const db = this.db;
    const rows = db.query(`SELECT id, pid, last_beat FROM instances`).all() as Array<{
      id: string;
      pid: number;
      last_beat: number;
    }>;
    for (const row of rows) {
      if (row.id === this.instanceId) continue;
      const stale = now - row.last_beat > this.staleMs;
      if (stale || !this.pidAlive(row.pid)) {
        db.query(`DELETE FROM instances WHERE id = ?`).run(row.id);
        db.query(`DELETE FROM claims WHERE instance_id = ?`).run(row.id);
        db.query(`DELETE FROM writes WHERE instance_id = ?`).run(row.id);
        // A dead peer's TASK is released, not deleted: the work still needs
        // doing and somebody else can now take it. Deleting it — the obvious
        // symmetry with claims and writes — would silently drop work the
        // moment a session crashed, which is exactly when it matters most.
        db.query(
          `UPDATE tasks SET status = 'pending', owner_id = NULL, claimed_at = NULL, expires_at = NULL
           WHERE owner_id = ? AND status != 'completed'`,
        ).run(row.id);
      }
    }
    db.query(`DELETE FROM claims WHERE expires_at <= ?`).run(now);
    // An expired task claim is released the same way, for the same reason.
    db.query(
      `UPDATE tasks SET status = 'pending', owner_id = NULL, claimed_at = NULL, expires_at = NULL
       WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'completed'`,
    ).run(now);
    db.query(`DELETE FROM messages WHERE created_at <= ?`).run(now - this.messageTtlMs);
    db.query(`DELETE FROM writes WHERE at <= ?`).run(now - this.writeWindowMs);
  }

  /** Withdraw this instance's presence, claims, and write records. */
  leave(): void {
    this.guard(undefined, (db) => {
      db.query(`DELETE FROM instances WHERE id = ?`).run(this.instanceId);
      db.query(`DELETE FROM claims WHERE instance_id = ?`).run(this.instanceId);
      db.query(`DELETE FROM writes WHERE instance_id = ?`).run(this.instanceId);
    });
  }

  /** Leave and close the DB. Safe to call more than once. */
  close(): void {
    this.leave();
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }
}
