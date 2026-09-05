// ─── NotebookStore: the tactics notebook (evolution loop v1) ───
// A structured, queryable store of learned facts and tactics — NOT loose
// markdown. Entries are scoped: `repo` (this exact workspace), `stack`
// (any workspace with a similar stack fingerprint — how a tactic learned on
// one project transfers to a similar one), or `global`. Everything is
// data: inspectable (`rune notebook`), deletable, decayable. Nothing here
// ever spends a model token — capture is rule-based and retrieval is
// scope-keyed ranking.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUIDv7 } from "bun";

export type NotebookKind = "fact" | "tactic";
export type NotebookScope = "repo" | "stack" | "global";

/**
 * Where a lesson is in its lifecycle (P7.6).
 *
 *   candidate — learned once. STORED AND NEVER INJECTED. The backfill path only
 *               ever writes candidates: deriving a lesson from history is not
 *               the same as having watched it hold.
 *   trial     — learned in ≥2 distinct sessions. Injected, and every injection
 *               is logged so the win rate means something.
 *   active    — ≥5 firings with a win rate above the ambient baseline. Only
 *               active lessons reach the playbook.
 *   retired   — decayed, disused, contradicted, or turned off by the user.
 *               Kept and inspectable; revives if re-learned.
 *
 * The stages exist because "learned" and "believed" were the same thing before:
 * one observation was injected into every later run with no measurement between.
 */
export type LessonStage = "candidate" | "trial" | "active" | "retired";

export interface NotebookEntry {
  id: string;
  kind: NotebookKind;
  scope: NotebookScope;
  /** sha of the workspace path for scope=repo. */
  repoKey: string | null;
  /** stack fingerprint (e.g. "bun+rust+ts+turbo") for scope=stack. */
  stackKey: string | null;
  /** Stable dedupe key within a scope (e.g. "test-command"). */
  title: string;
  /** The advice itself. Hard-capped — the notebook must stay cheap to inject. */
  body: string;
  provenance: { sessions: string[]; note?: string };
  uses: number;
  wins: number;
  createdAt: string;
  updatedAt: string;
  lastUsed: string | null;
  retired: boolean;
  /** Lifecycle stage. `retired` here always agrees with `retired` above. */
  stage: LessonStage;
}

const BODY_MAX = 400;

interface Row {
  id: string;
  kind: string;
  scope: string;
  repo_key: string | null;
  stack_key: string | null;
  title: string;
  body: string;
  provenance_json: string;
  uses: number;
  wins: number;
  created_at: string;
  updated_at: string;
  last_used: string | null;
  retired: number;
  stage: string | null;
}

export class NotebookStore {
  private db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        repo_key TEXT,
        stack_key TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{"sessions":[]}',
        uses INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used TEXT,
        retired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope, repo_key, stack_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_dedupe
        ON entries(scope, COALESCE(repo_key,''), COALESCE(stack_key,''), title);
    `);
    this.migrate();
  }

  /**
   * Additive, idempotent. Existing rows were being injected on every run, so
   * they migrate to `trial`, not to `candidate`: silently withdrawing lessons
   * the user has been running with would be a behaviour change disguised as a
   * schema change.
   */
  private migrate(): void {
    const cols = this.db.query("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "stage")) {
      this.db.exec("ALTER TABLE entries ADD COLUMN stage TEXT");
      this.db.exec(
        "UPDATE entries SET stage = CASE WHEN retired = 1 THEN 'retired' ELSE 'trial' END",
      );
    }
  }

  /**
   * Insert or refresh an entry. The (scope, keys, title) tuple is the identity:
   * re-learning the same thing updates the body and timestamp instead of
   * duplicating — the notebook converges instead of growing.
   */
  upsert(entry: {
    kind: NotebookKind;
    scope: NotebookScope;
    repoKey?: string | null;
    stackKey?: string | null;
    title: string;
    body: string;
    sessionId?: string;
    note?: string;
    /**
     * Stage for a NEW row.
     *
     * Defaults to `trial`, which is the notebook's own capture path: a FACT
     * observed directly by the harness ("`bun test` passed here", "this is a
     * bun+turbo monorepo") is not advice, it is a reading, and withholding it
     * until it recurs would degrade the notebook for no gain.
     *
     * `recordLessons` passes `candidate` explicitly, because a retro LESSON is
     * advice — "avoid X here" — and one run's inference is not something later
     * runs should be told. That is the distinction the stage exists to hold.
     *
     * Re-learning an existing row never demotes it; `advanceLessons` is the
     * only thing that moves a row along.
     */
    stage?: LessonStage;
  }): string {
    const now = new Date().toISOString();
    const body = entry.body.slice(0, BODY_MAX);
    const existing = this.db
      .query(
        `SELECT id, provenance_json FROM entries
         WHERE scope = ? AND COALESCE(repo_key,'') = ? AND COALESCE(stack_key,'') = ? AND title = ?`,
      )
      .get(entry.scope, entry.repoKey ?? "", entry.stackKey ?? "", entry.title) as {
      id: string;
      provenance_json: string;
    } | null;

    if (existing) {
      const prov = JSON.parse(existing.provenance_json) as { sessions: string[]; note?: string };
      if (entry.sessionId && !prov.sessions.includes(entry.sessionId)) {
        prov.sessions.push(entry.sessionId);
        if (prov.sessions.length > 20) prov.sessions.splice(0, prov.sessions.length - 20);
      }
      this.db
        .query(
          // A revived row (re-learned after being retired) comes back as a
          // CANDIDATE, whatever it was before: it was retired because it stopped
          // being true, so it has to earn the ladder again rather than resume
          // where it left off.
          `UPDATE entries SET body = ?, provenance_json = ?, updated_at = ?, retired = 0,
             stage = CASE WHEN stage IS NULL THEN 'trial' WHEN stage = 'retired' THEN 'candidate' ELSE stage END
           WHERE id = ?`,
        )
        .run(body, JSON.stringify(prov), now, existing.id);
      return existing.id;
    }

    const id = randomUUIDv7();
    this.db
      .query(
        `INSERT INTO entries
         (id, kind, scope, repo_key, stack_key, title, body, provenance_json, created_at, updated_at, stage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.kind,
        entry.scope,
        entry.repoKey ?? null,
        entry.stackKey ?? null,
        entry.title,
        body,
        JSON.stringify({ sessions: entry.sessionId ? [entry.sessionId] : [], note: entry.note }),
        now,
        now,
        entry.stage ?? "trial",
      );
    return id;
  }

  /**
   * Scope-keyed retrieval, ranked: repo entries first (most specific), then
   * matching-stack entries (cross-project transfer), then global. Within a
   * scope: win-rate, then recency.
   */
  retrieve(opts: { repoKey: string; stackKey: string; limit?: number }): NotebookEntry[] {
    const rows = this.db
      .query(
        // Candidates are stored and NEVER injected: one observation is not a
        // belief. Only trial and active rows reach the prompt.
        `SELECT * FROM entries
         WHERE retired = 0 AND COALESCE(stage, 'trial') IN ('trial', 'active') AND (
           (scope = 'repo' AND repo_key = ?) OR
           (scope = 'stack' AND stack_key = ?) OR
           scope = 'global'
         )
         ORDER BY
           CASE scope WHEN 'repo' THEN 3 WHEN 'stack' THEN 2 ELSE 1 END DESC,
           CASE WHEN uses > 0 THEN CAST(wins AS REAL) / uses ELSE 0.5 END DESC,
           updated_at DESC
         LIMIT ?`,
      )
      .all(opts.repoKey, opts.stackKey, opts.limit ?? 20) as Row[];
    return rows.map(rowToEntry);
  }

  list(opts: { includeRetired?: boolean; limit?: number } = {}): NotebookEntry[] {
    const rows = (
      opts.includeRetired
        ? this.db
            .query(`SELECT * FROM entries ORDER BY updated_at DESC LIMIT ?`)
            .all(opts.limit ?? 100)
        : this.db
            .query(`SELECT * FROM entries WHERE retired = 0 ORDER BY updated_at DESC LIMIT ?`)
            .all(opts.limit ?? 100)
    ) as Row[];
    return rows.map(rowToEntry);
  }

  /**
   * Everything learned about one workspace, retired entries included — the
   * playbook renders from this, and the retro checks it for contradictions.
   */
  listRepo(repoKey: string): NotebookEntry[] {
    const rows = this.db
      .query(`SELECT * FROM entries WHERE scope = 'repo' AND repo_key = ? ORDER BY updated_at DESC`)
      .all(repoKey) as Row[];
    return rows.map(rowToEntry);
  }

  /**
   * Retire one entry now — a later run contradicted it. It stays inspectable
   * and revives if re-learned, exactly like decay.
   */
  retire(id: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .query(
          `UPDATE entries SET retired = 1, stage = 'retired', updated_at = ? WHERE id = ? AND retired = 0`,
        )
        .run(now, id).changes > 0
    );
  }

  /**
   * Move one entry to a stage. The only writer is `advanceLessons`, which
   * applies the lifecycle rules; nothing else in the codebase may set a stage,
   * because a stage set without the rule behind it is a claim without evidence.
   */
  setStage(id: string, stage: LessonStage): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .query(
          `UPDATE entries SET stage = ?, retired = ?, updated_at = ? WHERE id = ? AND stage IS NOT ?`,
        )
        .run(stage, stage === "retired" ? 1 : 0, now, id, stage).changes > 0
    );
  }

  /** Short-id match — suffix first (UUIDv7 prefixes collide for same-time ids). */
  getByPrefix(shortId: string): NotebookEntry | null {
    const bySuffix = this.db
      .query(`SELECT * FROM entries WHERE id LIKE ? LIMIT 2`)
      .all(`%${shortId}`) as Row[];
    if (bySuffix.length === 1) return rowToEntry(bySuffix[0]);
    const byPrefix = this.db
      .query(`SELECT * FROM entries WHERE id LIKE ? LIMIT 2`)
      .all(`${shortId}%`) as Row[];
    return byPrefix.length === 1 ? rowToEntry(byPrefix[0]) : null;
  }

  remove(id: string): boolean {
    return this.db.query(`DELETE FROM entries WHERE id = ?`).run(id).changes > 0;
  }

  /** Mark entries as injected this run (uses++), for later win attribution. */
  touchUses(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const q = this.db.query(`UPDATE entries SET uses = uses + 1, last_used = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) q.run(now, id);
    });
    tx();
  }

  /** The run those entries were injected into ended well → wins++. */
  recordWins(ids: string[]): void {
    if (ids.length === 0) return;
    const q = this.db.query(`UPDATE entries SET wins = wins + 1 WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) q.run(id);
    });
    tx();
  }

  /**
   * Decay: retire entries that are stale (no activity in `staleDays`) OR have
   * a proven losing record (win rate < 40% over ≥5 uses). Never deletes —
   * retired entries stay inspectable and revive if re-learned.
   */
  decay(staleDays = 60): number {
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    const r = this.db
      .query(
        `UPDATE entries SET retired = 1
         , stage = 'retired'
         WHERE retired = 0 AND (
           COALESCE(last_used, updated_at) < ?
           OR (uses >= 5 AND CAST(wins AS REAL) / uses < 0.4)
         )`,
      )
      .run(cutoff);
    return r.changes;
  }

  count(): number {
    const row = this.db.query(`SELECT COUNT(*) as n FROM entries WHERE retired = 0`).get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function rowToEntry(r: Row): NotebookEntry {
  return {
    id: r.id,
    kind: r.kind as NotebookKind,
    scope: r.scope as NotebookScope,
    repoKey: r.repo_key,
    stackKey: r.stack_key,
    title: r.title,
    body: r.body,
    provenance: JSON.parse(r.provenance_json),
    uses: r.uses,
    wins: r.wins,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsed: r.last_used,
    retired: r.retired === 1,
    stage: (r.retired === 1 ? "retired" : ((r.stage as LessonStage) ?? "trial")) as LessonStage,
  };
}
