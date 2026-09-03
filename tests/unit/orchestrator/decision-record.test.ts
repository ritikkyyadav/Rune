/**
 * The Decision Record (P11.1) — the one artifact a person reads top to bottom.
 *
 * Two properties are under test, and the second is the one that matters:
 *
 *  1. It is GENERATED, not written: a pure function of TaskState, so the same
 *     state always renders the same document and nothing in it was authored by
 *     the model that did the work.
 *  2. It states absences. "No decision was recorded", "Nothing was produced",
 *     "No verification-shaped command ran" — each is a finding a reader has to
 *     see, and a blank section would read as an omission instead.
 */

import { describe, expect, test } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  buildDecisionRecord,
  hasRecord,
  renderDecisionRecordMarkdown,
} from "../../../packages/orchestrator/src/decision-record";

/** The three-hypothesis bug hunt, as a spine. */
function bugHunt(): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn("why did API latency rise after v2.18.5?");
  s.setKind("investigate", "harness");
  s.setTodos([
    { content: "test the cache theory", status: "in_progress" },
    { content: "test the pool theory", status: "pending" },
    { content: "test the query theory", status: "pending" },
  ]);

  s.noteHypothesis("cache eviction on deploy");
  s.updateHypothesis("h1", "refuted", {
    reason: "TTL unchanged across the deploy",
    evidence: [{ kind: "check", ref: "bun test cache.test.ts" }],
  });
  s.noteHypothesis("connection pool exhaustion");
  s.updateHypothesis("h2", "refuted", {
    reason: "pool at 40 of 200",
    evidence: [{ kind: "check", ref: "bun test pool.test.ts" }],
  });
  s.noteHypothesis("query regression in orders.ts");
  s.updateHypothesis("h3", "confirmed", {
    reason: "seq scan on orders (1.2M rows)",
    evidence: [{ kind: "check", ref: "explain analyze", detail: "seq scan" }],
  });

  s.recordDecision("restore the (customer_id, created_at) index", [
    { kind: "check", ref: "explain analyze", detail: "seq scan on orders" },
  ]);
  s.noteFileWritten("migrations/0042_orders_index.sql");
  s.noteEffect("check_pass", {
    command: "bun test",
    source: "harness",
    exitCode: 0,
    durationMs: 4200,
    summary: "12 pass",
  });
  s.noteEffect("write");
  s.setTodos([
    { content: "test the cache theory", status: "completed" },
    { content: "test the pool theory", status: "completed" },
    { content: "test the query theory", status: "completed" },
  ]);
  return s;
}

describe("the record is a function of the state", () => {
  test("it carries the objective verbatim, never a paraphrase", () => {
    const record = buildDecisionRecord("s1", bugHunt().snapshot());
    expect(record.objective).toBe("why did API latency rise after v2.18.5?");
    expect(record.kind).toBe("investigate");
    expect(record.taskId).toBe("s1");
  });

  test("the decision is the last one committed, with the earlier ones kept", () => {
    const s = bugHunt();
    s.recordDecision("and backfill on the replica", [{ kind: "file", ref: "ops/backfill.md" }]);
    const record = buildDecisionRecord("s1", s.snapshot());
    expect(record.decision?.text).toBe("and backfill on the replica");
    expect(record.decisions).toHaveLength(2);
    expect(record.decisions[0].text).toContain("restore the");
  });

  test("every hypothesis is present, in order, refuted ones included", () => {
    const record = buildDecisionRecord("s1", bugHunt().snapshot());
    expect(record.hypotheses.map((h) => h.status)).toEqual(["refuted", "refuted", "confirmed"]);
    expect(record.hypotheses[0].reason).toContain("TTL unchanged");
  });

  test("open steps and unresolved decisions are what remains — resolved ones are not", () => {
    const s = bugHunt();
    s.setTodos([
      { content: "test the cache theory", status: "completed" },
      { content: "test the pool theory", status: "completed" },
      { content: "test the query theory", status: "completed" },
      { content: "backfill on the replica", status: "pending" },
    ]);
    s.addPendingDecision({ id: "q1", kind: "question", summary: "JSON or YAML?" });
    s.resolvePendingDecision("q1", "JSON");
    s.addPendingDecision({ id: "h9", kind: "held_step", summary: "run the backfill" });
    const record = buildDecisionRecord("s1", s.snapshot());
    expect(record.remains.openSteps).toEqual(["backfill on the replica"]);
    expect(record.remains.pending.map((p) => p.id)).toEqual(["h9"]);
  });

  test("the same state renders the same document", () => {
    const state = bugHunt().snapshot();
    const at = new Date("2026-09-03T12:00:00.000Z");
    expect(renderDecisionRecordMarkdown(buildDecisionRecord("s1", state, at))).toBe(
      renderDecisionRecordMarkdown(buildDecisionRecord("s1", state, at)),
    );
  });

  test("progress rides along, and is absent when there is no plan", () => {
    expect(buildDecisionRecord("s1", bugHunt().snapshot()).progress).toBe(1);
    const bare = new TaskStateStore();
    bare.beginTurn("what does this repo do?");
    expect(buildDecisionRecord("s1", bare.snapshot()).progress).toBeUndefined();
  });
});

describe("the rendering", () => {
  test("the six sections, in the order a reader needs them", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    const order = [
      "## Objective",
      "## Decision",
      "## How we got here",
      "## What changed",
      "## Checks",
      "## What remains",
    ];
    let cursor = -1;
    for (const heading of order) {
      const at = md.indexOf(heading);
      expect(at, `${heading} is missing`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("the two refuted branches survive with their reasons, and the confirmed one is marked", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    expect(md).toContain("1. cache eviction on deploy — refuted: TTL unchanged across the deploy");
    expect(md).toContain("2. connection pool exhaustion — refuted: pool at 40 of 200");
    expect(md).toContain("**confirmed**");
    expect(md).toContain("seq scan on orders (1.2M rows)");
  });

  test("the decision names the evidence it stood on", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    expect(md).toContain("restore the (customer_id, created_at) index");
    expect(md).toContain("Evidence: `check: explain analyze` — seq scan on orders");
  });

  test("checks name the command, its exit code and its duration", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    expect(md).toContain("| `bun test` | passed | 0 | 4.2s | harness |");
  });

  test("what changed lists the artifacts", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    expect(md).toContain("- file: `migrations/0042_orders_index.sql`");
  });

  test("a finished task says so instead of leaving the section empty", () => {
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", bugHunt().snapshot()));
    expect(md).toContain("Nothing: every planned step closed");
    expect(md).toContain("100% of planned steps closed on evidence");
  });
});

describe("absences are stated, never blank", () => {
  test("no decision, no hypotheses, no artifacts, no checks — each says so", () => {
    const s = new TaskStateStore();
    s.beginTurn("look at the config");
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", s.snapshot()));
    expect(md).toContain("_No decision was recorded for this task._");
    expect(md).toContain("_No hypotheses were recorded._");
    expect(md).toContain("_Nothing was produced._");
    expect(md).toContain("_No verification-shaped command ran._");
  });

  test("an uncited decision is shown as uncited", () => {
    const s = new TaskStateStore();
    s.beginTurn("pick a database");
    s.recordDecision("SQLite, because the workload is single-writer");
    const md = renderDecisionRecordMarkdown(buildDecisionRecord("s1", s.snapshot()));
    expect(md).toContain("Evidence: _no evidence cited_");
  });

  test("an empty task produces no record at all — a heading is not a document", () => {
    const s = new TaskStateStore();
    s.beginTurn("hello");
    expect(hasRecord(buildDecisionRecord("s1", s.snapshot()))).toBe(false);
    // One hypothesis is enough to be worth showing.
    s.noteHypothesis("something is wrong with the parser");
    expect(hasRecord(buildDecisionRecord("s1", s.snapshot()))).toBe(true);
  });
});

describe("it survives the round trip the surfaces take", () => {
  test("built from a restored spine, it is the same record", () => {
    const original = bugHunt();
    const restored = TaskStateStore.restore(original.snapshot());
    const at = new Date("2026-09-03T12:00:00.000Z");
    expect(renderDecisionRecordMarkdown(buildDecisionRecord("s1", restored.snapshot(), at))).toBe(
      renderDecisionRecordMarkdown(buildDecisionRecord("s1", original.snapshot(), at)),
    );
  });

  test("built from the session log, it is the same record", () => {
    const s = bugHunt();
    const events = [{ seq: 1, event: { type: "task_state", payload: { state: s.snapshot() } } }];
    const replayed = TaskStateStore.fromEvents(events as never)!;
    const at = new Date("2026-09-03T12:00:00.000Z");
    expect(renderDecisionRecordMarkdown(buildDecisionRecord("s1", replayed.snapshot(), at))).toBe(
      renderDecisionRecordMarkdown(buildDecisionRecord("s1", s.snapshot(), at)),
    );
  });

  test("JSON survives the wire without losing a branch", () => {
    const record = buildDecisionRecord("s1", bugHunt().snapshot());
    const overWire = JSON.parse(JSON.stringify(record));
    expect(renderDecisionRecordMarkdown(overWire)).toBe(renderDecisionRecordMarkdown(record));
  });
});
