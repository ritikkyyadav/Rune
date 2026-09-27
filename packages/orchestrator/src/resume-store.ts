// ─── Where resume plans live: one table in the session database ───
//
// Not a second mission database (docs/program/guarantees-plan-review-20260914.md,
// M6): the plans sit in `rune.db` beside the sessions they resume, one row per
// session, keyed by it. The table is created here rather than in the shared
// session schema, the way `LessonTrials` owns its table inside `notebook.db`.
//
// A row is the plan's current state plus a short history of how it got there,
// so "what happened overnight" is one row to read.

import { Database } from "bun:sqlite";

import type { ResumePlan, ResumeStatus } from "./resume-plan";

/** How many transitions a row remembers. */
const HISTORY_LIMIT = 24;

export interface ResumeTransition {
  at: number;
  status: ResumeStatus;
  attempts: number;
  nextAt: number | null;
  spentUsd: number;
  reason?: string;
}

export interface StoredResumePlan {
  plan: ResumePlan;
  workspaceRoot: string;
  history: ResumeTransition[];
}

export class ResumePlanStore {
  private constructor(private readonly db: Database) {
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS resume_plans (
      session_id     TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      status         TEXT NOT NULL,
      next_at        INTEGER,
      updated_at     TEXT NOT NULL,
      plan_json      TEXT NOT NULL,
      history_json   TEXT NOT NULL DEFAULT '[]'
    ); CREATE INDEX IF NOT EXISTS resume_plans_due ON resume_plans(status, next_at);`);
  }

  static open(dbPath: string): ResumePlanStore {
    return new ResumePlanStore(new Database(dbPath, { create: true }));
  }

  /** Upsert, appending the transition when the status or the attempt changed. */
  save(plan: ResumePlan, workspaceRoot: string, now: number = Date.now()): void {
    const prior = this.get(plan.sessionId);
    const history = prior?.history ?? [];
    const last = history[history.length - 1];
    if (!last || last.status !== plan.status || last.attempts !== plan.attempts) {
      history.push({
        at: now,
        status: plan.status,
        attempts: plan.attempts,
        nextAt: plan.nextAt,
        spentUsd: plan.spentUsd,
        ...(plan.reason ? { reason: plan.reason } : {}),
      });
    }
    this.db
      .query(
        `INSERT INTO resume_plans (session_id, workspace_root, status, next_at, updated_at, plan_json, history_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           workspace_root = excluded.workspace_root, status = excluded.status,
           next_at = excluded.next_at, updated_at = excluded.updated_at,
           plan_json = excluded.plan_json, history_json = excluded.history_json`,
      )
      .run(
        plan.sessionId,
        workspaceRoot,
        plan.status,
        plan.nextAt,
        new Date(now).toISOString(),
        JSON.stringify(plan),
        JSON.stringify(history.slice(-HISTORY_LIMIT)),
      );
  }

  get(sessionId: string): StoredResumePlan | null {
    const row = this.db
      .query(
        "SELECT workspace_root, plan_json, history_json FROM resume_plans WHERE session_id = ?",
      )
      .get(sessionId) as { workspace_root: string; plan_json: string; history_json: string } | null;
    return row ? parseRow(row) : null;
  }

  /** Every plan, most recently touched first. */
  list(): StoredResumePlan[] {
    const rows = this.db
      .query(
        "SELECT workspace_root, plan_json, history_json FROM resume_plans ORDER BY updated_at DESC",
      )
      .all() as Array<{ workspace_root: string; plan_json: string; history_json: string }>;
    return rows.flatMap((r) => {
      const parsed = parseRow(r);
      return parsed ? [parsed] : [];
    });
  }

  /** Waiting plans whose time has come, optionally only this workspace's; soonest first. */
  due(now: number, workspaceRoot?: string): StoredResumePlan[] {
    const rows = this.db
      .query(
        `SELECT workspace_root, plan_json, history_json FROM resume_plans
         WHERE status = 'waiting' AND next_at IS NOT NULL AND next_at <= ?
           AND (? IS NULL OR workspace_root = ?)
         ORDER BY next_at ASC`,
      )
      .all(now, workspaceRoot ?? null, workspaceRoot ?? null) as Array<{
      workspace_root: string;
      plan_json: string;
      history_json: string;
    }>;
    return rows.flatMap((r) => {
      const parsed = parseRow(r);
      return parsed ? [parsed] : [];
    });
  }

  close(): void {
    this.db.close();
  }
}

/** A row that does not parse is skipped, not fatal: one bad row must not hide the rest. */
function parseRow(r: {
  workspace_root: string;
  plan_json: string;
  history_json: string;
}): StoredResumePlan | null {
  try {
    const plan = JSON.parse(r.plan_json) as ResumePlan;
    if (plan?.v !== 1 || typeof plan.sessionId !== "string") return null;
    const history = JSON.parse(r.history_json) as ResumeTransition[];
    return {
      plan,
      workspaceRoot: r.workspace_root,
      history: Array.isArray(history) ? history : [],
    };
  } catch {
    return null;
  }
}
