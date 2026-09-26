/**
 * `reportCheckpoints` / `pruneCheckpoints`, on a synthetic database built
 * row by row. Never touches ~/.rune/rune.db. Written by an independent
 * verifier.
 *
 * The claim under test (phase-2c, b1b1262): "the checkpoint advisory promises
 * exactly what the prune removes", "keeps the newest 2 versions of every run
 * whose session still exists", "removes only superseded and orphaned rows",
 * dry-run by default, and the apply is transactional.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { rmTemp } from "../../helpers/tmp";

import {
  DEFAULT_KEEP_VERSIONS,
  pruneCheckpoints,
  reportCheckpoints,
} from "../../../packages/shared/src/state";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/**
 * live      — an ACTIVE session, 5 versions of run #1 and 2 of run #2
 * finished  — an archived session, 5 versions of run #1
 * ghost#1   — 3 versions whose session row does not exist (orphans)
 */
function synthetic(): Database {
  const dir = mkdtempSync(join(tmpdir(), "v2-prune-"));
  cleanup.push(() => rmTemp(dir));
  const db = new Database(join(dir, "synthetic.db"));
  cleanup.push(() => db.close());
  db.run(`CREATE TABLE sessions (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            workspace_root TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'm',
            system_prompt_hash TEXT, title TEXT,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','archived','deleted')))`);
  db.run(`CREATE TABLE checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
            version INTEGER NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(run_id, version))`);
  const session = db.prepare(
    "INSERT INTO sessions (id, created_at, updated_at, workspace_root, status) VALUES (?,?,?,?,?)",
  );
  session.run("live", "2026-01-01", "2026-01-02", "/w", "active");
  session.run("finished", "2026-01-01", "2026-01-02", "/w", "archived");
  const put = db.prepare(
    "INSERT INTO checkpoints (run_id, version, state_json, created_at) VALUES (?,?,?,?)",
  );
  const body = (tag: string) => JSON.stringify({ tag, pad: "x".repeat(40) });
  for (let v = 1; v <= 5; v++) put.run("live#1", v, body(`live1v${v}`), `2026-02-0${v}`);
  for (let v = 1; v <= 2; v++) put.run("live#2", v, body(`live2v${v}`), `2026-03-0${v}`);
  for (let v = 1; v <= 5; v++) put.run("finished#1", v, body(`fin1v${v}`), `2026-04-0${v}`);
  for (let v = 1; v <= 3; v++) put.run("ghost#1", v, body(`ghostv${v}`), `2026-05-0${v}`);
  return db;
}

const versions = (db: Database, runId: string) =>
  (
    db
      .prepare("SELECT version FROM checkpoints WHERE run_id = ? ORDER BY version")
      .all(runId) as Array<{ version: number }>
  ).map((r) => r.version);

describe("the advisory and the prune agree", () => {
  test("the dry run changes nothing and matches the report at every keep", () => {
    const db = synthetic();
    const before = reportCheckpoints(db);
    expect(before.rows).toBe(15);
    expect(before.runs).toBe(4);
    for (const keep of [1, 2, 3, 5, 9]) {
      const dry = pruneCheckpoints(db, { keep });
      expect(dry.applied).toBe(false);
      expect(reportCheckpoints(db, keep).reclaimableRows).toBe(dry.removedRows);
      expect(reportCheckpoints(db, keep).reclaimableBytes).toBe(dry.removedBytes);
    }
    expect(reportCheckpoints(db).rows).toBe(before.rows);
    // keep < 1 clamps to 1 on BOTH sides, or the doctor and the command differ.
    expect(pruneCheckpoints(db, { keep: 0 }).removedRows).toBe(
      reportCheckpoints(db, 0).reclaimableRows,
    );
  });

  test("apply removes exactly what the advisory promised, and keeps the newest two", () => {
    const db = synthetic();
    const promised = reportCheckpoints(db);
    // live#1 5→2, live#2 2→2, finished#1 5→2, ghost#1 3→0 == 3 + 0 + 3 + 3
    expect(promised.reclaimableRows).toBe(9);
    const applied = pruneCheckpoints(db, { apply: true });
    expect(applied).toMatchObject({ applied: true, removedRows: promised.reclaimableRows });
    expect(applied.removedBytes).toBe(promised.reclaimableBytes);
    expect(versions(db, "live#1")).toEqual([4, 5]);
    expect(versions(db, "live#2")).toEqual([1, 2]);
    expect(versions(db, "finished#1")).toEqual([4, 5]);
    expect(versions(db, "ghost#1")).toEqual([]);
    // Idempotent: a second apply has nothing left to do.
    expect(pruneCheckpoints(db, { apply: true })).toMatchObject({
      removedRows: 0,
      applied: false,
    });
    expect(reportCheckpoints(db).reclaimableRows).toBe(0);
  });

  test("the newest version of a run is never removed, at any keep", () => {
    const db = synthetic();
    pruneCheckpoints(db, { apply: true, keep: 1 });
    expect(versions(db, "live#1")).toEqual([5]);
    expect(versions(db, "finished#1")).toEqual([5]);
    expect(versions(db, "live#2")).toEqual([2]);
    expect(DEFAULT_KEEP_VERSIONS).toBe(2);
  });

  test("a partial failure rolls the whole apply back", () => {
    const db = synthetic();
    const before = reportCheckpoints(db).rows;
    // A trigger that refuses the last doomed delete stands in for a disk
    // error mid-way: `db.transaction` must undo the earlier ones.
    db.run(
      `CREATE TRIGGER refuse_ghost BEFORE DELETE ON checkpoints
         WHEN OLD.run_id = 'ghost#1' AND OLD.version = 3
         BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`,
    );
    expect(() => pruneCheckpoints(db, { apply: true })).toThrow();
    expect(reportCheckpoints(db).rows).toBe(before);
  });

  test("a row belonging to a LIVE session is pruned all the same", () => {
    // Recorded, not endorsed: the predicate has no notion of a terminal
    // session — `live` is `status = 'active'` and its superseded versions go.
    // Harmless today because `resumeFromCheckpoint` reads only the newest
    // version, but "it never removes rows of a non-terminal session" is not
    // a property this code has.
    const db = synthetic();
    pruneCheckpoints(db, { apply: true });
    expect(versions(db, "live#1")).toEqual([4, 5]);
  });
});
