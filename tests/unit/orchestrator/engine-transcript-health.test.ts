/**
 * R5.4 of docs/program/rune-reliability-plan-20261014.md: when the session
 * database refuses writes, the run says recent messages may not be saved for
 * resume — once when it starts, again at the end of every turn while it lasts,
 * and once more when saving works again. Driven against a real SQLite file
 * put into query-only mode, which refuses writes with SQLITE_READONLY.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Engine, transcriptFailureLine } from "../../../packages/orchestrator/src/engine";

interface Internals {
  sessions: { appendEvent(id: string, e: unknown): number };
  transcriptHealthNotice(repeat?: boolean): { type: "notice"; message: string } | null;
}

describe("transcript health notices", () => {
  let root: string;
  let engine: Engine;
  let internals: Internals;
  let db: Database;
  let sessionId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rune-transcript-health-"));
    engine = new Engine({
      model: "llama3",
      provider: "ollama",
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      toolsBinaryPath: "rune-tools",
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
      memory: { enabled: false },
    } as any);
    internals = engine as unknown as Internals;
    db = (internals.sessions as unknown as { db: Database }).db;
    sessionId = engine.createSession();
  });

  afterEach(() => {
    // Closed first: Windows will not remove a folder with the database open.
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  const write = () => {
    try {
      internals.sessions.appendEvent(sessionId, { type: "note", payload: {} });
    } catch {
      // Best-effort, as every engine caller treats it.
    }
  };

  test("says it once, repeats it at a turn's end, and says when it is over", () => {
    expect(internals.transcriptHealthNotice()).toBeNull();

    db.exec("PRAGMA query_only = ON");
    write();
    const first = internals.transcriptHealthNotice();
    expect(first?.message).toContain("Recent messages may not be saved for resume");
    expect(first?.message).toContain("SQLITE_READONLY");
    // Not again on every event…
    expect(internals.transcriptHealthNotice()).toBeNull();
    // …but again at the end of a turn while it lasts.
    expect(internals.transcriptHealthNotice(true)?.message).toBe(first!.message);

    db.exec("PRAGMA query_only = OFF");
    write();
    expect(internals.transcriptHealthNotice()?.message).toBe("The session is being saved again.");
    expect(internals.transcriptHealthNotice(true)).toBeNull();
  });

  test("the line names the cause and what fixes it", () => {
    const full = transcriptFailureLine({ code: "SQLITE_FULL", since: "now" });
    expect(full).toContain("the disk is full");
    expect(full).toContain("Free some disk space.");
    expect(full).toContain("This line repeats until a write succeeds.");
    expect(transcriptFailureLine({ code: "SQLITE_READONLY_DBMOVED", since: "now" })).toContain(
      "Check that ~/.rune is writable.",
    );
    expect(transcriptFailureLine({ code: "SQLITE_IOERR_WRITE", since: "now" })).toContain(
      "I/O error",
    );
  });
});
