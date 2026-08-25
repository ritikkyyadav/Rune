/**
 * Unit tests for the session-management surface added to SessionManager:
 * provider column + migration, auto-title, rename, archive/restore/soft-delete,
 * hard purge (event cascade), and status-filtered listing.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionManager, deriveSessionTitle } from "../../../packages/shared/src/session";

const tmpDirs: string[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-session-mgr-test-"));
  tmpDirs.push(dir);
  return join(dir, "gear.db");
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("SessionManager.createSession", () => {
  test("records the provider and starts active with no title", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "qwen3-coder:480b", "ollama-turbo");
    expect(s.provider).toBe("ollama-turbo");
    expect(s.status).toBe("active");
    expect(s.title).toBeNull();
    expect(sm.getSessionInfo(s.id)?.provider).toBe("ollama-turbo");
    sm.close();
  });

  test("provider is optional (legacy callers)", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "gemini-2.5-flash");
    expect(s.provider).toBeNull();
    sm.close();
  });
});

describe("SessionManager titles", () => {
  test("setTitleIfEmpty only fills an empty title, never overwrites", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "m");
    sm.setTitleIfEmpty(s.id, "first message title");
    expect(sm.getSessionInfo(s.id)?.title).toBe("first message title");
    sm.setTitleIfEmpty(s.id, "a later message"); // no-op
    expect(sm.getSessionInfo(s.id)?.title).toBe("first message title");
    sm.close();
  });

  test("renameSession overwrites, and empty clears back to null", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "m");
    sm.renameSession(s.id, "  My Work  ");
    expect(sm.getSessionInfo(s.id)?.title).toBe("My Work");
    sm.renameSession(s.id, "   ");
    expect(sm.getSessionInfo(s.id)?.title).toBeNull();
    sm.close();
  });
});

describe("SessionManager status transitions", () => {
  test("archive hides from the default list but getSessionInfo still finds it", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "m");
    sm.setSessionStatus(s.id, "archived");
    expect(sm.listSessions().find((x) => x.id === s.id)).toBeUndefined();
    expect(sm.getSession(s.id)).toBeNull(); // active-only accessor
    expect(sm.getSessionInfo(s.id)?.status).toBe("archived");
    sm.close();
  });

  test("status filter and 'all' include archived/deleted", () => {
    const sm = new SessionManager(dbPath());
    const a = sm.createSession("/ws", "m");
    const b = sm.createSession("/ws", "m");
    const c = sm.createSession("/ws", "m");
    sm.setSessionStatus(b.id, "archived");
    sm.setSessionStatus(c.id, "deleted");

    expect(sm.listSessions().map((x) => x.id)).toEqual([a.id]);
    expect(sm.listSessions({ status: "archived" }).map((x) => x.id)).toEqual([b.id]);
    expect(sm.listSessions({ status: "deleted" }).map((x) => x.id)).toEqual([c.id]);
    expect(sm.listSessions({ status: "all" }).length).toBe(3);
    sm.close();
  });

  test("restore brings an archived session back to active", () => {
    const sm = new SessionManager(dbPath());
    const s = sm.createSession("/ws", "m");
    sm.setSessionStatus(s.id, "archived");
    sm.setSessionStatus(s.id, "active");
    expect(sm.getSession(s.id)?.status).toBe("active");
    sm.close();
  });
});

describe("SessionManager.purgeSession", () => {
  test("hard delete removes the session and cascades its events", () => {
    const path = dbPath();
    const sm = new SessionManager(path);
    const s = sm.createSession("/ws", "m");
    sm.appendEvent(s.id, { type: "user_msg", payload: { content: "hi" } });
    sm.appendEvent(s.id, { type: "assistant_msg", payload: { content: "yo" } });

    const removed = sm.purgeSession(s.id);
    expect(removed).toBe(1);
    expect(sm.getSessionInfo(s.id)).toBeNull();

    // Events are gone too (ON DELETE CASCADE).
    const raw = new Database(path);
    const left = raw.prepare("SELECT COUNT(*) c FROM events WHERE session_id = ?").get(s.id) as {
      c: number;
    };
    expect(left.c).toBe(0);
    raw.close();
    sm.close();
  });
});

describe("SessionManager migration", () => {
  test("adds the provider column to a DB created without it", () => {
    const path = dbPath();
    // Simulate a pre-migration DB: sessions table without a provider column.
    const raw = new Database(path, { create: true });
    raw.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      workspace_root TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'm',
      system_prompt_hash TEXT, title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')));`);
    raw
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, workspace_root, model) VALUES ('old','t','t','/ws','gemini-2.5-flash')",
      )
      .run();
    raw.close();

    // Opening through SessionManager runs the migration; the legacy row reads back with provider=null.
    const sm = new SessionManager(path);
    expect(sm.getSessionInfo("old")?.provider).toBeNull();
    const fresh = sm.createSession("/ws", "m", "google");
    expect(sm.getSessionInfo(fresh.id)?.provider).toBe("google");
    sm.close();
  });
});

describe("deriveSessionTitle", () => {
  test("collapses whitespace and trims", () => {
    expect(deriveSessionTitle("  fix   the\n login  redirect  ")).toBe("fix the login redirect");
  });
  test("truncates long messages on a word boundary with an ellipsis", () => {
    const long =
      "please refactor the authentication module and split it into smaller files for clarity";
    const t = deriveSessionTitle(long, 40);
    expect(t.length).toBeLessThanOrEqual(41); // 40 + ellipsis
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toContain("  ");
  });
});
