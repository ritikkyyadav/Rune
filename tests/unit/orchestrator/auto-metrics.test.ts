import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatAutoSafetyMetrics,
  readAutoSafetyMetrics,
} from "../../../packages/orchestrator/src/auto-metrics";

/**
 * P6A.4 — the metric comes from the log, not from a live process.
 *
 * The property under test is unglamorous and was the whole problem: a halt
 * usually ends the process holding the counter, so a number kept in memory can
 * never describe halts. These tests build a database by hand and read it back.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDb(
  events: Array<{ type: string; payload: Record<string, unknown>; session?: string }>,
  sessions = ["s1"],
): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-metrics-"));
  dirs.push(dir);
  const path = join(dir, "gear.db");
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT,
      workspace_root TEXT, model TEXT, status TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER,
      type TEXT, payload_json TEXT, created_at TEXT);
  `);
  for (const s of sessions) {
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, workspace_root, model, status) VALUES (?,?,?,?,?,?)",
    ).run(s, "2026-09-02", "2026-09-02", "/tmp", "m", "active");
  }
  let seq = 0;
  for (const e of events) {
    seq++;
    db.prepare(
      "INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?,?,?,?,?)",
    ).run(
      e.session ?? "s1",
      seq,
      e.type,
      JSON.stringify({ type: e.type, payload: e.payload }),
      "2026-09-02",
    );
  }
  db.close();
  return path;
}

const screen = (verdict: string, session = "s1") => ({
  type: "safety_decision",
  session,
  payload: { source: "supervisor_screen", verdict, toolName: "bash", callId: "c1" },
});
const reasoned = (verdict: string, session = "s1") => ({
  type: "safety_decision",
  session,
  payload: { source: "supervisor_reasoned", verdict, toolName: "bash", callId: "c1" },
});
const held = (outcome: string, session = "s1") => ({
  type: "held_step_outcome",
  session,
  payload: { outcome, toolName: "bash", route: "unrecognized", kind: "defer" },
});

describe("P6A.4 — supervisor false positives, sourced from the DB", () => {
  test("a flag the reasoned pass declined to confirm is a false positive", () => {
    const path = makeDb([screen("allow"), screen("deny"), reasoned("allow")]);
    const m = readAutoSafetyMetrics(path);
    expect(m.supervisorScreens).toBe(2);
    expect(m.supervisorFlags).toBe(1);
    expect(m.supervisorConfirmed).toBe(0);
    expect(m.screenFalsePositiveRate).toBe(1);
    expect(m.legacyOnly).toBe(false);
  });

  test("a confirmed flag is not a false positive", () => {
    const path = makeDb([screen("deny"), reasoned("deny"), screen("deny"), reasoned("allow")]);
    const m = readAutoSafetyMetrics(path);
    expect(m.supervisorFlags).toBe(2);
    expect(m.supervisorConfirmed).toBe(1);
    expect(m.screenFalsePositiveRate).toBe(0.5);
  });

  test("no flags means no data, never zero", () => {
    // The distinction the program's rule 9 exists for: a rate with no
    // denominator is unknown, and printing 0% would assert something false.
    const path = makeDb([screen("allow"), screen("allow")]);
    const m = readAutoSafetyMetrics(path);
    expect(m.screenFalsePositiveRate).toBeNull();
    expect(formatAutoSafetyMetrics(m)[1]).toContain("no data");
  });

  test("halts per 100 runs is computed over sessions, not over decisions", () => {
    const path = makeDb(
      [
        { type: "safety_decision", payload: { source: "supervisor_halt", verdict: "deny" } },
        { type: "safety_decision", payload: { source: "supervisor_late", verdict: "deny" } },
      ],
      ["s1", "s2", "s3", "s4"],
    );
    const m = readAutoSafetyMetrics(path);
    expect(m.supervisorHalts).toBe(2);
    expect(m.haltsPerHundredRuns).toBe(50);
  });
});

describe("P6A.4 — held-step outcomes", () => {
  test("a step run unchanged is a false positive; one left unrun is not", () => {
    const path = makeDb([held("ran"), held("ran"), held("skipped"), held("skipped")]);
    const m = readAutoSafetyMetrics(path);
    expect(m.heldSteps.ran).toBe(2);
    expect(m.heldSteps.skipped).toBe(2);
    expect(m.heldStepFalsePositiveRate).toBe(0.5);
  });

  test("refused and failed stay out of the denominator", () => {
    // `refused` is policy standing by the decision and `failed` is the action
    // being wrong on its own terms. Neither is the user disagreeing, and
    // counting them either way would corrupt the rate.
    const path = makeDb([held("ran"), held("refused"), held("failed"), held("failed")]);
    const m = readAutoSafetyMetrics(path);
    expect(m.heldSteps.total).toBe(4);
    expect(m.heldStepFalsePositiveRate).toBe(1);
  });

  test("no decided held steps means no data", () => {
    const path = makeDb([held("refused")]);
    expect(readAutoSafetyMetrics(path).heldStepFalsePositiveRate).toBeNull();
  });
});

describe("P6A.4 — reading old data honestly", () => {
  test("a database recorded before P6A.1 is reported as such", () => {
    const path = makeDb([
      { type: "safety_decision", payload: { source: "classifier_reasoned", verdict: "deny" } },
      { type: "safety_decision", payload: { source: "supervised_tier", verdict: "allow" } },
    ]);
    const m = readAutoSafetyMetrics(path);
    expect(m.decisions).toBe(2);
    expect(m.legacyOnly).toBe(true);
    expect(formatAutoSafetyMetrics(m).at(-1)).toContain("predate");
  });

  test("scoping to one session excludes the others", () => {
    const path = makeDb(
      [screen("deny", "s1"), reasoned("allow", "s1"), screen("deny", "s2")],
      ["s1", "s2"],
    );
    expect(readAutoSafetyMetrics(path, { sessionId: "s1" }).supervisorFlags).toBe(1);
    expect(readAutoSafetyMetrics(path).supervisorFlags).toBe(2);
  });

  test("an unreadable database yields empty metrics rather than throwing", () => {
    const m = readAutoSafetyMetrics("/nonexistent/path/to/gear.db");
    expect(m.decisions).toBe(0);
    expect(m.screenFalsePositiveRate).toBeNull();
  });
});
