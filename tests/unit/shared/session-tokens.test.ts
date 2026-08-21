/**
 * Session token metadata (v2 sessions manager): the last_tokens column,
 * its additive migration, and the invariant that a token report never
 * reorders the recency-sorted list (updated_at untouched).
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionManager } from "../../../packages/shared/src/session";

const tmpDirs: string[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "alan-session-tokens-test-"));
  tmpDirs.push(dir);
  return join(dir, "alan.db");
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("session token metadata", () => {
  test("noteContextTokens persists and lists; starts null", () => {
    const mgr = new SessionManager(dbPath());
    const s = mgr.createSession("/ws", "m1");
    expect(s.lastTokens).toBeNull();
    expect(mgr.listSessions()[0]!.lastTokens).toBeNull();

    mgr.noteContextTokens(s.id, 6_100);
    expect(mgr.listSessions()[0]!.lastTokens).toBe(6100);

    mgr.noteContextTokens(s.id, 8_200.7); // rounded
    expect(mgr.listSessions()[0]!.lastTokens).toBe(8201);
  });

  test("garbage counts are ignored", () => {
    const mgr = new SessionManager(dbPath());
    const s = mgr.createSession("/ws", "m1");
    mgr.noteContextTokens(s.id, 0);
    mgr.noteContextTokens(s.id, -5);
    mgr.noteContextTokens(s.id, Number.NaN);
    expect(mgr.listSessions()[0]!.lastTokens).toBeNull();
  });

  test("a token report never reorders the recency-sorted list", () => {
    const mgr = new SessionManager(dbPath());
    const older = mgr.createSession("/ws", "m1");
    const newer = mgr.createSession("/ws", "m1");
    Bun.sleepSync(2); // updated_at has millisecond resolution — avoid a same-tick tie
    mgr.appendEvent(newer.id, { type: "user_msg", payload: { content: "hi" } }); // bumps updated_at
    expect(mgr.listSessions()[0]!.id).toBe(newer.id);

    mgr.noteContextTokens(older.id, 50_000); // metadata only
    expect(mgr.listSessions()[0]!.id).toBe(newer.id); // order unchanged
    expect(mgr.listSessions().find((x) => x.id === older.id)!.lastTokens).toBe(50_000);
  });

  test("migration is additive: a pre-column database gains last_tokens on open", () => {
    const path = dbPath();
    // Build a legacy DB without the column.
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      workspace_root TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'm',
      system_prompt_hash TEXT, title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted'))
    );`);
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, workspace_root, model) VALUES ('legacy','2026-01-01','2026-01-01','/ws','m')",
    ).run();
    db.close();

    const mgr = new SessionManager(path); // migrate() adds provider + last_tokens
    const legacy = mgr.listSessions().find((s) => s.id === "legacy")!;
    expect(legacy.lastTokens).toBeNull();
    mgr.noteContextTokens("legacy", 1234);
    expect(mgr.listSessions().find((s) => s.id === "legacy")!.lastTokens).toBe(1234);
  });
});
