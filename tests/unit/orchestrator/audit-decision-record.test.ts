/**
 * `gear audit <session> --record` and the export's Decision Record section.
 *
 * Both read a real session log, and both prefer the record the RUN persisted
 * over one generated now: what a person reads later has to be the document the
 * run itself produced, or an export and a live surface can disagree about what
 * happened. The fallback path exists for sessions that ended before the record
 * did, and for a run that died before writing one — it still works, because
 * the spine is what the record is made of.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../../packages/shared/src/session";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { buildDecisionRecord } from "../../../packages/orchestrator/src/decision-record";
import { latestDecisionRecord, runAudit } from "../../../packages/orchestrator/src/bin/audit-cli";
import { exportSession } from "../../../packages/orchestrator/src/session-export";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-audit-record-"));
  dirs.push(dir);
  return join(dir, "gear.db");
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // cleanup only
    }
  }
});

/** A finished bug hunt: three hypotheses, two refuted, a decision, a check. */
function bugHunt(): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn("why did API latency rise after v2.18.5?");
  s.setKind("investigate", "harness");
  s.setTodos([{ content: "find the regression", status: "in_progress" }]);
  s.noteHypothesis("cache eviction on deploy");
  s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
  s.noteHypothesis("connection pool exhaustion");
  s.updateHypothesis("h2", "refuted", { reason: "pool at 40 of 200" });
  s.noteHypothesis("query regression in orders.ts");
  s.updateHypothesis("h3", "confirmed", {
    reason: "seq scan on orders",
    evidence: [{ kind: "check", ref: "explain analyze" }],
  });
  s.recordDecision("restore the (customer_id, created_at) index", [
    { kind: "check", ref: "explain analyze", detail: "seq scan on 1.2M rows" },
  ]);
  s.noteFileWritten("migrations/0042_orders_index.sql");
  s.noteEffect("check_pass", { command: "bun test", source: "harness", exitCode: 0 });
  s.setTodos([{ content: "find the regression", status: "completed" }]);
  return s;
}

/** Seed a session carrying the spine, and optionally the persisted record. */
function seed(dbPath: string, opts: { persistRecord: boolean }): string {
  const sm = new SessionManager(dbPath);
  const id = sm.createSession("/tmp/ws", "claude-sonnet").id;
  const spine = bugHunt();
  sm.appendEvent(id, { type: "user_msg", payload: { content: "why did latency rise?" } });
  sm.appendEvent(id, { type: "task_state", payload: { state: spine.snapshot() } });
  if (opts.persistRecord) {
    sm.appendEvent(id, {
      type: "decision_record",
      payload: { record: buildDecisionRecord(id, spine.snapshot()) },
    });
  }
  sm.close();
  return id;
}

/** Run `gear audit --record` and capture what it printed. */
async function auditRecord(dbPath: string, id: string): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await runAudit([id], { db: dbPath, record: true });
    return { code, out: chunks.join("") };
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
}

describe("gear audit --record", () => {
  test("prints the record the run persisted, and nothing else", async () => {
    const dbPath = tempDb();
    const id = seed(dbPath, { persistRecord: true });
    const { code, out } = await auditRecord(dbPath, id);
    expect(code).toBe(0);
    expect(out).toContain("# Decision record — investigation");
    expect(out).toContain("why did API latency rise after v2.18.5?");
    expect(out).toContain("refuted: TTL unchanged");
    expect(out).toContain("refuted: pool at 40 of 200");
    expect(out).toContain("**confirmed**");
    expect(out).toContain("restore the (customer_id, created_at) index");
    // …and none of the audit page's own sections.
    expect(out).not.toContain("Gear audit");
    expect(out).not.toContain("Context");
  });

  test("falls back to the spine for a session that never wrote one", async () => {
    const dbPath = tempDb();
    const id = seed(dbPath, { persistRecord: false });
    const { code, out } = await auditRecord(dbPath, id);
    expect(code).toBe(0);
    expect(out).toContain("# Decision record");
    expect(out).toContain("query regression in orders.ts");
  });

  test("a session with nothing recorded says so and exits non-zero", async () => {
    const dbPath = tempDb();
    const sm = new SessionManager(dbPath);
    const id = sm.createSession("/tmp/ws", "claude-sonnet").id;
    sm.appendEvent(id, { type: "user_msg", payload: { content: "hello" } });
    sm.close();
    const { code, out } = await auditRecord(dbPath, id);
    expect(code).toBe(1);
    expect(out).toContain("No decision record");
  });

  test("the persisted row wins over a regeneration", () => {
    const spine = bugHunt();
    const stale = buildDecisionRecord("s1", spine.snapshot());
    const rows = [
      { seq: 1, event: { type: "task_state", payload: { state: spine.snapshot() } } },
      { seq: 2, event: { type: "decision_record", payload: { record: stale } } },
    ];
    expect(latestDecisionRecord(rows as never)?.objective).toBe(stale.objective);
    // Latest wins, as everywhere else in the log.
    const later = { ...stale, objective: "a later objective" };
    rows.push({ seq: 3, event: { type: "decision_record", payload: { record: later } } });
    expect(latestDecisionRecord(rows as never)?.objective).toBe("a later objective");
  });

  test("a session with no record row at all yields null rather than throwing", () => {
    expect(latestDecisionRecord([])).toBeNull();
    expect(
      latestDecisionRecord([{ seq: 1, event: { type: "decision_record", payload: {} } }] as never),
    ).toBeNull();
  });
});

describe("the export carries the record", () => {
  test("as Markdown, above the transcript, demoted one heading level", async () => {
    const dbPath = tempDb();
    const id = seed(dbPath, { persistRecord: true });
    const { content } = await exportSession(dbPath, id, { format: "md" });
    expect(content).toContain("## Decision record — investigation");
    expect(content).toContain("cache eviction on deploy — refuted: TTL unchanged");
    expect(content.indexOf("## Decision record")).toBeLessThan(content.indexOf("## Transcript"));
  });

  test("as structure in JSON, so a reader can render it themselves", async () => {
    const dbPath = tempDb();
    const id = seed(dbPath, { persistRecord: true });
    const { content } = await exportSession(dbPath, id, { format: "json" });
    const parsed = JSON.parse(content) as {
      decisionRecord: { hypotheses: Array<{ status: string }>; decision: { text: string } | null };
    };
    expect(parsed.decisionRecord.hypotheses.map((h) => h.status)).toEqual([
      "refuted",
      "refuted",
      "confirmed",
    ]);
    expect(parsed.decisionRecord.decision?.text).toContain("restore the");
  });

  test("a session with no narrative exports null rather than an empty document", async () => {
    const dbPath = tempDb();
    const sm = new SessionManager(dbPath);
    const id = sm.createSession("/tmp/ws", "claude-sonnet").id;
    sm.appendEvent(id, { type: "user_msg", payload: { content: "hello" } });
    sm.close();
    const { content } = await exportSession(dbPath, id, { format: "json" });
    expect(JSON.parse(content).decisionRecord).toBeNull();
    const md = await exportSession(dbPath, id, { format: "md" });
    expect(md.content).not.toContain("Decision record");
  });

  test("the record is inside the signed bytes", async () => {
    const dbPath = tempDb();
    const id = seed(dbPath, { persistRecord: true });
    const keyPath = join(dirs[dirs.length - 1], "keys");
    const signed = await exportSession(dbPath, id, { format: "md", sign: true, keyPath });
    expect(signed.signature).toBeTruthy();
    expect(signed.content).toContain("## Decision record");
  });
});
