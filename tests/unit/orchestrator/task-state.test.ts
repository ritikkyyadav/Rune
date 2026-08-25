/**
 * Phase-2 spine: TaskStateStore — the deterministic, zero-token record of what
 * the run is doing, living OUTSIDE the transcript so compaction/resume/crash
 * can't erase it.
 */

import { describe, test, expect } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

describe("task boundary rule (beginTurn)", () => {
  test("a fresh message starts a new task and records the verbatim goal", () => {
    const s = new TaskStateStore();
    expect(s.beginTurn("build me a parser")).toBe(true);
    expect(s.snapshot().goal).toBe("build me a parser");
  });

  test("a message while todos are open is steering — goal and todos stand", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a parser");
    s.setTodos([
      { content: "read the grammar", status: "completed" },
      { content: "write the lexer", status: "in_progress" },
    ]);
    expect(s.beginTurn("also support comments")).toBe(false);
    expect(s.snapshot().goal).toBe("build me a parser");
    expect(s.snapshot().todos).toHaveLength(2);
  });

  test("all todos completed → the next message starts a NEW task", () => {
    const s = new TaskStateStore();
    s.beginTurn("task one");
    s.setTodos([{ content: "a", status: "completed" }]);
    expect(s.beginTurn("task two")).toBe(true);
    expect(s.snapshot().goal).toBe("task two");
    expect(s.snapshot().todos).toEqual([]);
  });

  test("a pending handoff makes the next message a RESUME, not a new task", () => {
    const s = new TaskStateStore();
    s.beginTurn("long task");
    s.setTodos([{ content: "step", status: "completed" }]);
    s.setHandoff("max_turns");
    expect(s.beginTurn("continue")).toBe(false);
    expect(s.snapshot().goal).toBe("long task");
  });

  test("a pure-steering push after a completed task NEVER becomes the goal", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a clone of cluely for interview meetings");
    s.setTodos([{ content: "built it", status: "completed" }]);
    // The observed rot this pins: the spine's goal became "well now proceed !!"
    // while the real ask lived only in the compaction-vulnerable transcript.
    expect(s.beginTurn("well now proceed !!")).toBe(false);
    const snap = s.snapshot();
    expect(snap.goal).toBe("build me a clone of cluely for interview meetings");
    expect(snap.directive).toBe("well now proceed !!");
  });

  test("steering variants: punctuation-only, 'ok go ahead', 'just fix it properly'", () => {
    const s = new TaskStateStore();
    s.beginTurn("original goal here");
    s.setTodos([{ content: "done", status: "completed" }]);
    for (const push of ["!!", "ok go ahead", "just fix it properly", "continue"]) {
      expect(s.beginTurn(push)).toBe(false);
      expect(s.snapshot().goal).toBe("original goal here");
    }
  });

  test("a substantive follow-up starts a new task and keeps goal lineage", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a clone of cluely");
    s.setTodos([{ content: "a", status: "completed" }]);
    expect(s.beginTurn("the application is not built correctly — find the issue")).toBe(true);
    const snap = s.snapshot();
    expect(snap.goal).toBe("the application is not built correctly — find the issue");
    expect(snap.priorGoals).toEqual(["build me a clone of cluely"]);
  });

  test("goal lineage is capped and ordered oldest-first", () => {
    const s = new TaskStateStore();
    for (const g of ["goal one", "goal two", "goal three", "goal four", "goal five"]) {
      s.beginTurn(g);
      s.setTodos([{ content: "x", status: "completed" }]);
    }
    expect(s.snapshot().goal).toBe("goal five");
    expect(s.snapshot().priorGoals).toEqual(["goal two", "goal three", "goal four"]);
  });

  test("the very first message is the goal even when it reads like steering", () => {
    const s = new TaskStateStore();
    expect(s.beginTurn("continue")).toBe(true);
    expect(s.snapshot().goal).toBe("continue");
  });
});

describe("renderBlock", () => {
  test("nothing beyond a bare goal renders nothing (trivial tasks cost nothing)", () => {
    const s = new TaskStateStore();
    s.beginTurn("what does this function do?");
    expect(s.renderBlock()).toBeNull();
  });

  test("goal + todos + files + verification render; harness identity is stated", () => {
    const s = new TaskStateStore();
    s.beginTurn("refactor auth");
    s.setTodos([
      { content: "map call sites", status: "completed" },
      { content: "extract middleware", status: "in_progress" },
      { content: "run tests", status: "pending" },
    ]);
    s.noteFileWritten("src/auth.ts");
    s.noteVerification(true, false, "FAIL: auth.test.ts 2 failures");
    const block = s.renderBlock()!;
    expect(block).toContain("[Task state — maintained by the harness");
    expect(block).toContain("Goal: refactor auth");
    expect(block).toContain("[x] map call sites");
    expect(block).toContain("[>] extract middleware");
    expect(block).toContain("[ ] run tests");
    expect(block).toContain("src/auth.ts");
    expect(block).toContain("Verification: failed");
    expect(block).toContain("todo_write");
  });

  test("under a tight budget the goal and todos survive while extras drop", () => {
    const s = new TaskStateStore();
    s.beginTurn("goal text");
    s.setTodos([{ content: "the one todo", status: "in_progress" }]);
    for (let i = 0; i < 30; i++) s.noteFileRead(`some/long/path/file-${i}.ts`);
    for (let i = 0; i < 10; i++) s.addDecision(`decision number ${i} with a fair amount of text`);
    s.noteVerification(true, false, "x".repeat(400));
    const block = s.renderBlock(60)!; // very tight
    expect(block).toContain("goal text");
    expect(block).toContain("the one todo");
    expect(block).not.toContain("decision number");
  });

  test("todo overflow shows a +N more line", () => {
    const s = new TaskStateStore();
    s.beginTurn("big");
    s.setTodos(
      Array.from({ length: 25 }, (_, i) => ({ content: `t${i}`, status: "pending" as const })),
    );
    expect(s.renderBlock(5_000)!).toContain("…+5 more");
  });

  test("a steering push renders as 'Latest user push', with the real goal intact", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a clone of cluely");
    s.setTodos([{ content: "done", status: "completed" }]);
    s.beginTurn("well now proceed !!");
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Goal: build me a clone of cluely");
    expect(block).toContain("Latest user push: well now proceed !!");
  });

  test("prior goals render as session lineage at full detail", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a clone of cluely");
    s.setTodos([{ content: "a", status: "completed" }]);
    s.beginTurn("make it actually work like the real product");
    s.setTodos([{ content: "b", status: "in_progress" }]);
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Goal: make it actually work like the real product");
    expect(block).toContain("Earlier goals this session: build me a clone of cluely");
  });

  test("verification 'unavailable' always states WHY — the nothing-runnable red flag", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me an app");
    s.setTodos([{ content: "build", status: "completed" }]);
    s.noteVerification(
      false,
      true,
      "Nothing runnable detected — no manifest, test, or build configuration found, so no command was executed.",
    );
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Verification: unavailable — Nothing runnable detected");
  });
});

describe("renderHandoff", () => {
  test("lists done, remaining, files, and names the next step", () => {
    const s = new TaskStateStore();
    s.beginTurn("migrate the DB layer");
    s.setTodos([
      { content: "inventory queries", status: "completed" },
      { content: "port to new client", status: "in_progress" },
      { content: "delete old client", status: "pending" },
    ]);
    s.noteFileWritten("db/client.ts");
    const h = s.renderHandoff();
    expect(h).toContain("Goal: migrate the DB layer");
    expect(h).toContain("✓ inventory queries");
    expect(h).toContain("· port to new client");
    expect(h).toContain("Files touched: db/client.ts");
    expect(h).toContain("Next step: port to new client");
  });
});

describe("persistence", () => {
  test("snapshot → restore round-trips", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([{ content: "a", status: "pending" }]);
    s.addClarification("which db?", "postgres");
    const r = TaskStateStore.restore(s.snapshot());
    expect(r.snapshot().goal).toBe("g");
    expect(r.snapshot().clarifications[0].answer).toBe("postgres");
  });

  test("fromEvents picks the LATEST task_state snapshot", () => {
    const s1 = new TaskStateStore();
    s1.beginTurn("old");
    const s2 = new TaskStateStore();
    s2.beginTurn("new");
    s2.setTodos([{ content: "x", status: "pending" }]);
    const events = [
      { seq: 1, event: { type: "user_msg", payload: { content: "old" } } },
      { seq: 2, event: { type: "task_state", payload: { state: s1.snapshot() } } },
      { seq: 3, event: { type: "task_state", payload: { state: s2.snapshot() } } },
    ];
    const restored = TaskStateStore.fromEvents(events)!;
    expect(restored.snapshot().goal).toBe("new");
    expect(restored.hasOpenTodos()).toBe(true);
  });

  test("fromEvents returns null for pre-spine sessions", () => {
    expect(
      TaskStateStore.fromEvents([{ seq: 1, event: { type: "user_msg", payload: {} } }]),
    ).toBeNull();
  });
});

describe("mutator hygiene", () => {
  test("setTodos drops empties and normalizes unknown statuses", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([
      { content: "  ", status: "pending" },
      { content: "ok", status: "bogus" as never },
    ]);
    expect(s.snapshot().todos).toEqual([{ content: "ok", status: "pending" }]);
  });

  test("filesRead is a recency ring, capped", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    for (let i = 0; i < 40; i++) s.noteFileRead(`f${i}`);
    const read = s.snapshot().filesRead;
    expect(read).toHaveLength(30);
    expect(read[read.length - 1]).toBe("f39");
    expect(read).not.toContain("f0");
  });
});
