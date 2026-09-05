/**
 * The spine: TaskStateStore — the deterministic, zero-token record of what
 * the run is doing, living OUTSIDE the transcript so compaction/resume/crash
 * can't erase it.
 *
 * Two rules are under test here, and both are pinned to observed failures:
 *  - the boundary FOLLOWS THE PLAN (a message never replaces the goal; a fresh
 *    plan written against a pending follow-up does);
 *  - a step is COMPLETED BY EVIDENCE (nothing ran → refused once → unproven).
 */

import { beforeEach, describe, test, expect } from "bun:test";
import { TaskStateStore, stepReceipt } from "../../../packages/orchestrator/src/task-state";
import { tokenCounter } from "../../../packages/orchestrator/src/tokenizer";

/** A finished single-step task, set up without going through the evidence rule. */
function finished(goal: string): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn(goal);
  s.setTodos([{ content: "built it", status: "completed" }], { enforce: false });
  return s;
}

describe("task boundary rule (beginTurn)", () => {
  test("a fresh message starts a new task and records the verbatim goal", () => {
    const s = new TaskStateStore();
    expect(s.beginTurn("build me a parser")).toBe(true);
    expect(s.snapshot().goal).toBe("build me a parser");
  });

  test("a message while todos are open is steering — goal and todos stand", () => {
    const s = new TaskStateStore();
    s.beginTurn("build me a parser");
    s.noteEffect("read");
    s.setTodos([
      { content: "read the grammar", status: "completed" },
      { content: "write the lexer", status: "in_progress" },
    ]);
    expect(s.beginTurn("also support comments")).toBe(false);
    expect(s.snapshot().goal).toBe("build me a parser");
    expect(s.snapshot().todos).toHaveLength(2);
    expect(s.snapshot().directive).toBe("also support comments");
  });

  test("all todos completed → a substantive follow-up is a CANDIDATE goal, not the goal", () => {
    const s = finished("task one");
    expect(s.beginTurn("task two")).toBe(true);
    const snap = s.snapshot();
    expect(snap.goal).toBe("task one"); // the message alone never replaces the goal
    expect(snap.pendingGoal).toBe("task two");
    expect(snap.todos).toHaveLength(1); // and never empties the plan
    expect(s.currentRequest()).toBe("task two");
  });

  test("a fresh plan written against the candidate rolls the goal and keeps lineage", () => {
    const s = finished("build me a clone of cluely");
    s.beginTurn("the application is not built correctly — find the issue");
    const v = s.setTodos([{ content: "reproduce the failure", status: "in_progress" }]);
    expect(v.accepted && v.rolledGoal).toBe(true);
    const snap = s.snapshot();
    expect(snap.goal).toBe("the application is not built correctly — find the issue");
    expect(snap.priorGoals).toEqual(["build me a clone of cluely"]);
    expect(snap.pendingGoal).toBeUndefined();
  });

  test("the observed wipe: a casual follow-up on no list keeps the spec as the goal", () => {
    const s = finished(
      "# EvoLab — Master Product, Scientific, and Engineering Implementation Prompt …",
    );
    // 57 chars, no question mark, not on any push-word list — this exact
    // message replaced a six-hour build's spec as the goal and emptied its plan.
    s.beginTurn("well i am unablle to see the preview could you show me");
    const snap = s.snapshot();
    expect(snap.goal).toContain("EvoLab");
    expect(snap.todos).toHaveLength(1);
    expect(snap.pendingGoal).toBe("well i am unablle to see the preview could you show me");
    // …and the model answering WITHOUT a plan never rolls anything.
    expect(s.renderBlock(5_000)!).toContain("Goal: # EvoLab");
  });

  test("a pending handoff makes the next message a RESUME, not a new task", () => {
    const s = finished("long task");
    s.setHandoff("max_turns");
    expect(s.beginTurn("continue")).toBe(false);
    expect(s.snapshot().goal).toBe("long task");
    expect(s.snapshot().pendingGoal).toBeUndefined();
  });

  test("a pure-steering push after a completed task NEVER becomes the goal", () => {
    const s = finished("build me a clone of cluely for interview meetings");
    // The observed rot this pins: the spine's goal became "well now proceed !!"
    // while the real ask lived only in the compaction-vulnerable transcript.
    expect(s.beginTurn("well now proceed !!")).toBe(false);
    const snap = s.snapshot();
    expect(snap.goal).toBe("build me a clone of cluely for interview meetings");
    expect(snap.directive).toBe("well now proceed !!");
    expect(snap.pendingGoal).toBeUndefined();
  });

  test("steering variants: punctuation-only, 'ok go ahead', 'just fix it properly'", () => {
    const s = finished("original goal here");
    for (const push of ["!!", "ok go ahead", "just fix it properly", "continue"]) {
      expect(s.beginTurn(push)).toBe(false);
      expect(s.snapshot().goal).toBe("original goal here");
    }
  });

  test("goal lineage is capped and ordered oldest-first", () => {
    const s = new TaskStateStore();
    for (const g of ["goal one", "goal two", "goal three", "goal four", "goal five"]) {
      s.beginTurn(g);
      s.setTodos([{ content: `do ${g}`, status: "in_progress" }]); // fresh plan → roll
      s.noteEffect("write");
      s.setTodos([{ content: `do ${g}`, status: "completed" }]);
    }
    expect(s.snapshot().goal).toBe("goal five");
    expect(s.snapshot().priorGoals).toEqual(["goal two", "goal three", "goal four"]);
  });

  test("the very first message is the goal even when it reads like steering", () => {
    const s = new TaskStateStore();
    expect(s.beginTurn("continue")).toBe(true);
    expect(s.snapshot().goal).toBe("continue");
  });

  test("a short INSPECTION of finished work never becomes the goal (observed: evolab4)", () => {
    const s = finished(
      "# EvoLab — Master Product, Scientific, and Engineering Implementation Prompt …",
    );
    expect(s.beginTurn("well then show me the preview if its done !!")).toBe(false);
    const snap = s.snapshot();
    expect(snap.goal).toContain("EvoLab");
    expect(snap.directive).toBe("well then show me the preview if its done !!");
  });

  test("a trailing question mark is an inspection, not a new goal", () => {
    const s = finished("build the API");
    expect(s.beginTurn("tell me which model are you and on which effort ?")).toBe(false);
    expect(s.snapshot().goal).toBe("build the API");
  });

  test("the boundary ARCHIVES: files, decisions, and verification survive a new goal", () => {
    const s = finished("build the parser");
    s.noteFileWritten("src/parser.ts");
    s.addDecision("recursive descent, not a generator");
    s.noteVerification(true, true, "12 tests passed");
    expect(s.beginTurn("now migrate the whole CLI to use the new parser end to end")).toBe(true);
    s.setTodos([{ content: "inventory the call sites", status: "in_progress" }]);
    const snap = s.snapshot();
    expect(snap.goal).toBe("now migrate the whole CLI to use the new parser end to end");
    expect(snap.todos.map((t) => t.content)).toEqual(["inventory the call sites"]);
    expect(snap.filesWritten).toEqual(["src/parser.ts"]); // the ledger does not reset
    expect(snap.decisions).toEqual(["recursive descent, not a generator"]);
    expect(snap.verification.status).toBe("passed"); // known state of the tree
    expect(snap.verification.attempts).toBe(0); // but the counter is per-task
  });

  test("a mid-run interjection reaches the spine as the latest push", () => {
    const s = new TaskStateStore();
    s.beginTurn("build the parser");
    s.noteSteer("use postgres, not sqlite");
    expect(s.snapshot().directive).toBe("use postgres, not sqlite");
    expect(s.renderMissionFile()).toContain("steer: use postgres, not sqlite");
  });

  test("a long goal survives capture far beyond the old 2k cap", () => {
    const s = new TaskStateStore();
    const spec = "SPEC-START " + "requirement detail ".repeat(600) + "SPEC-END";
    s.beginTurn(spec);
    expect(s.snapshot().goal.length).toBeGreaterThan(10_000);
    expect(s.snapshot().goal).toContain("SPEC-START");
  });
});

describe("a step is completed by evidence", () => {
  test("a completion with nothing behind it is refused once, then accepted as unproven", () => {
    const s = new TaskStateStore();
    s.beginTurn("run the tests and fix what fails");
    s.setTodos([{ content: "run the test suite", status: "in_progress" }]);
    const first = s.setTodos([{ content: "run the test suite", status: "completed" }]);
    expect(first.accepted).toBe(false);
    if (!first.accepted) {
      expect(first.refused).toHaveLength(1);
      expect(first.refused[0].reason).toContain("nothing ran");
    }
    // The list did not move.
    expect(s.snapshot().todos[0].status).toBe("in_progress");
    // The same claim again is accepted — visibly unproven.
    const second = s.setTodos([{ content: "run the test suite", status: "completed" }]);
    expect(second.accepted).toBe(true);
    const item = s.snapshot().todos[0];
    expect(item.status).toBe("completed");
    expect(item.unproven).toBe("no_evidence");
    expect(stepReceipt(item)).toContain("unproven");
    expect(s.todoCounts()).toEqual({ done: 1, total: 1, unproven: 1, open: 0 });
  });

  test("a write while the step was open is evidence, and the receipt says so", () => {
    const s = new TaskStateStore();
    s.beginTurn("add the endpoint");
    s.setTodos([{ content: "write the handler", status: "in_progress" }]);
    s.noteEffect("write");
    s.noteEffect("run");
    const v = s.setTodos([{ content: "write the handler", status: "completed" }]);
    expect(v.accepted).toBe(true);
    const item = s.snapshot().todos[0];
    expect(item.unproven).toBeUndefined();
    expect(item.evidence?.writes).toBe(1);
    expect(stepReceipt(item)).toBe("1 write · 1 run");
  });

  test("work done BEFORE the plan was written counts for the steps closed with it", () => {
    const s = new TaskStateStore();
    s.beginTurn("audit the workspace");
    s.noteEffect("read");
    s.noteEffect("read");
    const v = s.setTodos([
      { content: "inventory the tree", status: "completed" },
      { content: "read the entry points", status: "in_progress" },
    ]);
    expect(v.accepted).toBe(true);
    expect(s.snapshot().todos[0].evidence?.reads).toBe(2);
  });

  test("a step closed right after a FAILING check is refused; a fix re-opens the question", () => {
    const s = new TaskStateStore();
    s.beginTurn("make the suite green");
    s.setTodos([{ content: "fix the parser tests", status: "in_progress" }]);
    s.noteEffect("write");
    s.noteEffect("check_fail", { command: "bun test", summary: "2 failed" });
    const refused = s.setTodos([{ content: "fix the parser tests", status: "completed" }]);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.refused[0].reason).toContain("FAILED");
    // Another edit after the failure means the step check should run again,
    // not that the step is unproven.
    s.noteEffect("write");
    expect(
      s.planCompletions([{ content: "fix the parser tests", status: "completed" }])[0]
        .uncheckedWrites,
    ).toBe(true);
    s.noteEffect("check_pass", { command: "bun test", summary: "ok" });
    const ok = s.setTodos([{ content: "fix the parser tests", status: "completed" }]);
    expect(ok.accepted).toBe(true);
    expect(s.snapshot().todos[0].unproven).toBeUndefined();
    expect(stepReceipt(s.snapshot().todos[0])).toContain("check ok");
  });

  test("planCompletions names the steps that wrote files nobody checked", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([{ content: "a", status: "in_progress" }]);
    s.noteEffect("write");
    expect(s.planCompletions([{ content: "a", status: "completed" }])).toEqual([
      { item: { content: "a", status: "completed" }, uncheckedWrites: true },
    ]);
    s.noteEffect("check_pass", { command: "tsc" });
    expect(s.planCompletions([{ content: "a", status: "completed" }])[0].uncheckedWrites).toBe(
      false,
    );
  });

  test("exactly one step is in progress — extras are demoted, and the note says so", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    const v = s.setTodos([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
    expect(v.accepted).toBe(true);
    if (v.accepted) expect(v.notes.join(" ")).toContain("set back to pending");
    expect(s.snapshot().todos.map((t) => t.status)).toEqual(["in_progress", "pending", "pending"]);
  });

  test("dropping unfinished steps is noted and logged, never silent", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([
      { content: "keep me", status: "in_progress" },
      { content: "the one that vanishes", status: "pending" },
    ]);
    const v = s.setTodos([{ content: "keep me", status: "in_progress" }]);
    expect(v.accepted).toBe(true);
    if (v.accepted) expect(v.notes.join(" ")).toContain("dropped 1 unfinished step");
    expect(s.renderMissionFile()).toContain("dropped: the one that vanishes");
  });

  test("evidence rides through a re-submitted list and survives a restore", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([{ content: "a", status: "in_progress" }]);
    s.noteEffect("write");
    s.setTodos([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
    const r = TaskStateStore.restore(s.snapshot());
    expect(r.snapshot().todos[0].evidence?.writes).toBe(1);
    expect(r.todoCounts()).toEqual({ done: 1, total: 2, unproven: 0, open: 1 });
  });

  test("the block shows the tally and marks unproven steps for the model", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    s.setTodos([{ content: "a", status: "in_progress" }]);
    s.setTodos([{ content: "a", status: "completed" }]); // refused
    s.setTodos([{ content: "a", status: "completed" }]); // unproven
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Todos (1/1 done, 1 unproven)");
    expect(block).toContain("[x] a (unproven — nothing ran)");
  });
});

describe("renderBlock", () => {
  // `renderBlock` sheds sections until the block fits a token BUDGET, and the
  // counter it asks is a module-level singleton whose calibration another test
  // file can have taught. Bun runs the suite in one process in directory order,
  // and that order differs per platform — so "under a tight budget the extras
  // drop" passed on macOS and failed on Windows, where a polluted ratio made a
  // 1,000-character block measure under 60 tokens and nothing ever dropped.
  // Same class as ede10e9; start every case from a clean counter.
  beforeEach(() => {
    tokenCounter.resetCalibrations();
    tokenCounter.clearCache();
  });

  test("nothing beyond a bare goal renders nothing (trivial tasks cost nothing)", () => {
    const s = new TaskStateStore();
    s.beginTurn("what does this function do?");
    expect(s.renderBlock()).toBeNull();
  });

  test("goal + todos + files + verification render; harness identity is stated", () => {
    const s = new TaskStateStore();
    s.beginTurn("refactor auth");
    s.noteEffect("read");
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
    const s = finished("build me a clone of cluely");
    s.beginTurn("well now proceed !!");
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Goal: build me a clone of cluely");
    expect(block).toContain("Latest user push: well now proceed !!");
  });

  test("a pending follow-up renders as the latest request, with the real goal intact", () => {
    const s = finished("build me a clone of cluely");
    s.beginTurn("now add a settings page with dark mode");
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Goal: build me a clone of cluely");
    expect(block).toContain("Latest request");
    expect(block).toContain("now add a settings page with dark mode");
  });

  test("prior goals render as session lineage at full detail", () => {
    const s = finished("build me a clone of cluely");
    s.beginTurn("make it actually work like the real product");
    s.setTodos([{ content: "b", status: "in_progress" }]);
    const block = s.renderBlock(5_000)!;
    expect(block).toContain("Goal: make it actually work like the real product");
    expect(block).toContain("Earlier goals this session: build me a clone of cluely");
  });

  test("the post-compaction budget carries far more of the goal, plus the mission pointer", () => {
    const s = new TaskStateStore();
    s.setMissionPath(".rune/mission.md");
    const spec = "SPEC-HEAD " + "the requirement continues ".repeat(200);
    s.beginTurn(spec);
    s.setTodos([{ content: "step", status: "in_progress" }]);
    const normal = s.renderBlock()!;
    const boosted = s.renderBlock(1_400)!;
    const goalLine = (b: string) => b.split("\n").find((l) => l.startsWith("Goal:"))!;
    expect(goalLine(boosted).length).toBeGreaterThan(goalLine(normal).length + 1_000);
    // A truncated goal always names where the full brief lives.
    expect(boosted).toContain(".rune/mission.md");
    expect(normal).toContain(".rune/mission.md");
  });

  test("verification 'unavailable' always states WHY — the nothing-runnable red flag", () => {
    const s = finished("build me an app");
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
    s.noteEffect("read");
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

describe("renderMissionFile", () => {
  test("the dossier carries the verbatim goal, plan, ledger, lineage, and log at full fidelity", () => {
    const s = new TaskStateStore();
    const spec = ("BUILD-SPEC " + "every requirement matters ".repeat(300)).trim();
    s.beginTurn(spec);
    s.noteEffect("write");
    s.setTodos([
      { content: "scaffold", status: "completed" },
      { content: "core loop", status: "in_progress" },
    ]);
    s.noteFileWritten("src/app.ts");
    s.addDecision("SQLite over Postgres for the local case");
    s.addClarification("which platform?", "web");
    s.noteVerification(true, false, "2 failures in core.test.ts");
    const doc = s.renderMissionFile();
    expect(doc).toContain("# Mission");
    expect(doc).toContain(spec); // VERBATIM — the whole point
    // P11.1 added the derived progress to the header: steps closed on
    // evidence over steps, which is exactly what the receipts below say.
    expect(doc).toContain("## Plan (1/2 done, 50% closed on evidence)");
    expect(doc).toContain("[x] scaffold — 1 write");
    expect(doc).toContain("[>] core loop");
    expect(doc).toContain("src/app.ts");
    expect(doc).toContain("SQLite over Postgres");
    expect(doc).toContain("which platform? → web");
    expect(doc).toContain("failed");
    expect(doc).toContain("## Log");
    expect(doc).toContain("done: scaffold — 1 write");
    expect(doc).toContain("check: project checks FAILED");
  });

  test("earlier goals ride along after a boundary", () => {
    const s = finished("first mission text");
    s.beginTurn("second mission entirely different and clearly substantive work");
    s.setTodos([{ content: "start the second", status: "in_progress" }]);
    const doc = s.renderMissionFile();
    expect(doc).toContain("second mission entirely different");
    expect(doc).toContain("Earlier goals this session");
    expect(doc).toContain("first mission text");
    expect(doc).toContain("boundary: new goal: second mission");
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

  test("an older snapshot without evidence fields restores and keeps counting", () => {
    const r = TaskStateStore.restore({
      version: 1,
      goal: "g",
      clarifications: [],
      todos: [{ content: "a", status: "in_progress" }],
      filesWritten: [],
      filesRead: [],
      decisions: [],
      verification: { status: "none", attempts: 0 },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    r.noteEffect("write");
    const v = r.setTodos([{ content: "a", status: "completed" }]);
    expect(v.accepted).toBe(true);
    expect(r.snapshot().todos[0].evidence?.writes).toBe(1);
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

  test("the log is bounded", () => {
    const s = new TaskStateStore();
    s.beginTurn("g");
    for (let i = 0; i < 200; i++) s.logEvent("gate", `entry ${i}`);
    expect(s.snapshot().log!.length).toBeLessThanOrEqual(80);
    expect(s.snapshot().log![s.snapshot().log!.length - 1].text).toBe("entry 199");
  });
});
