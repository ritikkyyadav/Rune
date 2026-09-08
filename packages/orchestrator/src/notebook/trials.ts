import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { NotebookEntry } from "./store";

export const TRIAL_ARM_SIZE = 20;
export interface TrialArm {
  runs: number;
  wins: number;
  cost: number;
}
export interface LessonEvidence {
  eligible: boolean;
  reason: string;
  cohort?: string;
  treatment: TrialArm;
  control: TrialArm;
}
export function lessonRevision(
  entry: Pick<NotebookEntry, "body" | "title" | "kind" | "scope" | "repoKey" | "stackKey">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.kind,
        entry.scope,
        entry.repoKey,
        entry.stackKey,
        entry.title,
        entry.body,
      ]),
    )
    .digest("hex");
}
function interval(arm: TrialArm): [number, number] {
  const n = arm.runs;
  if (!n) return [0, 1];
  const p = arm.wins / n,
    z = 1.96,
    d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [mid - radius, mid + radius];
}

/** A fixed first-20-per-arm analysis prevents promotion by repeatedly peeking
 * at an ever-growing counter. Later runs remain inspectable, but changing the
 * advice starts a new experiment. There are no extra model calls. */
export class LessonTrials {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS lesson_trials (
      session_id TEXT NOT NULL, lesson_id TEXT NOT NULL, revision TEXT NOT NULL,
      cohort TEXT NOT NULL, arm TEXT NOT NULL, won INTEGER, cost REAL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (session_id, lesson_id, revision)
    ); CREATE INDEX IF NOT EXISTS lesson_trials_evidence ON lesson_trials(lesson_id, revision, cohort);`);
  }
  assign(entry: NotebookEntry, sessionId: string, cohort: string): "include" | "withhold" {
    const revision = lessonRevision(entry);
    const arm =
      parseInt(
        createHash("sha256")
          .update(`${sessionId}:${entry.id}:${revision}`)
          .digest("hex")
          .slice(0, 8),
        16,
      ) %
        2 ===
      0
        ? "include"
        : "withhold";
    this.db
      .query(
        "INSERT OR IGNORE INTO lesson_trials (session_id,lesson_id,revision,cohort,arm) VALUES (?,?,?,?,?)",
      )
      .run(sessionId, entry.id, revision, cohort, arm);
    const row = this.db
      .query(
        "SELECT arm,cohort FROM lesson_trials WHERE session_id=? AND lesson_id=? AND revision=?",
      )
      .get(sessionId, entry.id, revision) as { arm: "include" | "withhold"; cohort: string };
    // Keep assignment stable even if configuration changes. Completion will
    // reject the mismatched cohort, so that run cannot promote this advice.
    return row.arm;
  }
  finish(sessionId: string, cohort: string, outcome: { won: boolean; cost: number }): void {
    if (!Number.isFinite(outcome.cost) || outcome.cost < 0) return;
    this.db
      .query(
        "UPDATE lesson_trials SET won=?,cost=? WHERE session_id=? AND cohort=? AND won IS NULL",
      )
      .run(outcome.won ? 1 : 0, outcome.cost, sessionId, cohort);
  }
  evidence(entry: NotebookEntry, cohortFilter?: string): LessonEvidence {
    const rows = this.db
      .query(
        `SELECT cohort,arm,won,cost FROM lesson_trials
      WHERE lesson_id=? AND revision=? AND won IS NOT NULL AND (? IS NULL OR cohort=?) ORDER BY started_at,session_id`,
      )
      .all(entry.id, lessonRevision(entry), cohortFilter ?? null, cohortFilter ?? null) as Array<{
      cohort: string;
      arm: string;
      won: number;
      cost: number;
    }>;
    const cohorts = new Map<string, { treatment: TrialArm; control: TrialArm }>();
    for (const row of rows) {
      let pair = cohorts.get(row.cohort);
      if (!pair) {
        pair = { treatment: { runs: 0, wins: 0, cost: 0 }, control: { runs: 0, wins: 0, cost: 0 } };
        cohorts.set(row.cohort, pair);
      }
      const arm = row.arm === "include" ? pair.treatment : pair.control;
      if (arm.runs >= TRIAL_ARM_SIZE) continue;
      arm.runs++;
      arm.wins += row.won;
      arm.cost += row.cost;
    }
    let best: LessonEvidence = {
      eligible: false,
      reason: `needs ${TRIAL_ARM_SIZE} verified outcomes per arm in one model/configuration cohort`,
      treatment: { runs: 0, wins: 0, cost: 0 },
      control: { runs: 0, wins: 0, cost: 0 },
    };
    for (const [cohort, pair] of cohorts) {
      const { treatment: t, control: c } = pair;
      const enough = Math.min(t.runs, c.runs) >= TRIAL_ARM_SIZE;
      const lift = enough && interval(t)[0] > interval(c)[1];
      // Compare total spend per verified success, including failed attempts.
      const efficiency = c.wins > 0 && t.wins > 0 && t.cost / t.wins <= (c.cost / c.wins) * 1.1;
      const eligible = lift && efficiency;
      const reason = !enough
        ? best.reason
        : !lift
          ? "no separated 95% success intervals in the fixed trial"
          : !efficiency
            ? "cost per verified success did not meet the control budget"
            : "fixed controlled trial improved verified success without more than 10% higher cost per success";
      const candidate = { eligible, reason, cohort, ...pair };
      if (eligible) return candidate;
      if (
        Math.min(t.runs, c.runs) > Math.min(best.treatment.runs, best.control.runs) ||
        t.runs + c.runs > best.treatment.runs + best.control.runs
      )
        best = candidate;
    }
    return best;
  }
}
