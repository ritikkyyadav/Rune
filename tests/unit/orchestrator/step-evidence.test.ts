import { expect, test } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { stepShape } from "../../../packages/orchestrator/src/step-evidence";

test("a read cannot prove a compound implementation-and-verification step", () => {
  const state = new TaskStateStore();
  state.beginTurn("Implement working authentication.");
  const step = { content: "Implement and verify authentication", status: "in_progress" as const };
  state.setTodos([step]);
  state.noteEffect("read");
  state.setTodos([{ ...step, status: "completed" }]);
  expect(state.snapshot().todos[0]?.unproven).toBe("no_evidence");
  expect(state.progress()).toBe(0);
  state.noteEffect("write");
  state.setTodos([{ ...step, status: "completed" }]);
  expect(state.progress()).toBe(0);
  state.noteEffect("check_pass", { command: "bun test auth.test.ts" });
  state.setTodos([{ ...step, status: "completed" }]);
  expect(state.snapshot().todos[0]?.unproven).toBeUndefined();
  expect(state.progress()).toBe(1);
});

test("inspection of tests is not execution of tests, and cannot downgrade implementation", () => {
  const state = new TaskStateStore();
  state.beginTurn("Inspect the tests.");
  state.setTodos([{ content: "Read current tests", status: "in_progress", kind: "inspect" }]);
  state.noteEffect("read");
  state.setTodos([{ content: "Read current tests", status: "completed" }]);
  expect(state.progress()).toBe(1);
  state.setTodos([{ content: "Implement login", status: "in_progress", kind: "inspect" }]);
  state.noteEffect("read");
  state.setTodos([{ content: "Implement login", status: "completed", kind: "inspect" }]);
  expect(state.progress()).toBe(0);
});

test("later edits invalidate an older passing check for a verification step", () => {
  const state = new TaskStateStore();
  state.beginTurn("Verify parser behavior.");
  state.setTodos([{ content: "Verify parser", status: "in_progress" }]);
  state.noteEffect("check_pass", { command: "bun test" });
  state.noteEffect("write");
  state.setTodos([{ content: "Verify parser", status: "completed" }]);
  expect(state.progress()).toBe(0);
});

test("stepShape recognises change, verify and inspect wording, and nothing else", () => {
  expect(stepShape({ content: "Implement login" })).toMatchObject({
    change: true,
    recognised: true,
  });
  expect(stepShape({ content: "Run the checks" })).toMatchObject({
    verify: true,
    recognised: true,
  });
  expect(stepShape({ content: "Read the router" })).toMatchObject({
    change: false,
    verify: false,
    recognised: true,
  });
  expect(stepShape({ content: "Auth flow" }).recognised).toBe(false);
  expect(stepShape({ content: "Auth flow", kind: "change" })).toMatchObject({
    change: true,
    recognised: true,
  });
});

test("a step with no recognisable action is asked for its kind once, as a note, never a refusal", () => {
  const state = new TaskStateStore();
  state.beginTurn("Ship the auth flow.");
  const list = [
    { content: "Auth flow", status: "in_progress" as const },
    { content: "Implement login", status: "pending" as const },
  ];
  const first = state.setTodos(list);
  expect(first.accepted).toBe(true);
  expect(first.notes.join(" ")).toMatch(/Step 1 names no recognisable action; set kind/);
  expect(first.notes.join(" ")).not.toMatch(/Step 2/);
  expect(state.setTodos(list).notes.join(" ")).not.toMatch(/recognisable action/);
  const typed = new TaskStateStore();
  typed.beginTurn("Ship the auth flow.");
  expect(
    typed
      .setTodos([{ content: "Auth flow", status: "in_progress", kind: "change" }])
      .notes.join(" "),
  ).not.toMatch(/recognisable action/);
});
