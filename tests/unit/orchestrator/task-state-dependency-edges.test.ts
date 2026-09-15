/**
 * A dependency is a fact about two STEPS, not about two positions.
 *
 * `dependsOn` is 1-based indices into the list the model just submitted, which
 * is unambiguous within one call and meaningless across two. The v7 pass found
 * both ways through the "a step cannot close over an open dependency" refusal:
 *
 *   (a) omit `dependsOn` and the step closes — the check ran over the
 *       submission, and the merge then put the edge straight back from the
 *       previous item, so the stored ledger asserted BOTH halves of the
 *       contradiction the check exists to prevent;
 *   (b) renumber the plan so the index lands somewhere harmless, and there is
 *       no refusal at all — no message, no quoted step. The lane's own residual
 *       risk said a wrong pointer would be "visible rather than silent"; it was
 *       exactly silent.
 *
 * And a third thing the store did not do: a 2-cycle, a 3-cycle and a
 * self-dependency were all stored verbatim and accepted, because nothing ever
 * walked the graph.
 */

import { describe, expect, test } from "bun:test";
import type { TodoItem } from "@rune/protocol";

import { TaskStateStore, openDependencies } from "../../../packages/orchestrator/src/task-state";

const PLAN = (): TodoItem[] => [
  {
    content: "one: expose priceFor",
    status: "pending",
    interface: "priceFor(sku,qty): Money",
  },
  { content: "three: point checkout at priceFor", status: "pending", dependsOn: [1] },
];

const refusalsOf = (verdict: ReturnType<TaskStateStore["setTodos"]>) =>
  verdict.accepted ? [] : verdict.refused;

describe("an edge outlives a submission that stops mentioning it", () => {
  test("omitting dependsOn does not close the step", () => {
    const store = new TaskStateStore();
    expect(store.setTodos(PLAN()).accepted).toBe(true);

    const quiet = PLAN();
    quiet[1]!.status = "completed";
    delete (quiet[1] as { dependsOn?: number[] }).dependsOn;
    const verdict = store.setTodos(quiet);

    expect(verdict.accepted).toBe(false);
    expect(refusalsOf(verdict)[0]!.kind).toBe("open_dependency");
    // Named, so the model can see which step it is waiting on.
    expect(refusalsOf(verdict)[0]!.reason).toContain("one: expose priceFor");
  });

  test("the ledger never holds 'completed' and 'rests on an open step' at once", () => {
    const store = new TaskStateStore();
    store.setTodos(PLAN());
    const quiet = PLAN();
    quiet[1]!.status = "completed";
    delete (quiet[1] as { dependsOn?: number[] }).dependsOn;
    store.setTodos(quiet);

    const todos = store.snapshot().todos;
    expect(todos[1]!.status).not.toBe("completed");
    // And the edge is still on the record: dropping the line does not retract it.
    expect(todos[1]!.dependsOn).toEqual([1]);
  });

  test("renumbering the plan moves nothing, because edges are by step", () => {
    const store = new TaskStateStore();
    store.setTodos(PLAN());
    // The same two steps, the same statuses, the same edge — rows swapped, so
    // `dependsOn: [1]` used to resolve to the closing step itself.
    const renumbered = [
      { content: "three: point checkout at priceFor", status: "completed", dependsOn: [1] },
      { content: "one: expose priceFor", status: "pending", interface: "priceFor(sku,qty): Money" },
    ] as TodoItem[];
    const verdict = store.setTodos(renumbered);

    expect(verdict.accepted).toBe(false);
    expect(refusalsOf(verdict)[0]!.kind).toBe("open_dependency");
    expect(refusalsOf(verdict)[0]!.reason).toContain("one: expose priceFor");
  });

  test("the stored positions are re-resolved, so a reorder does not point at the wrong row", () => {
    const store = new TaskStateStore();
    store.setTodos(PLAN());
    // A legitimate reorder with nothing closed: the edge must follow the step.
    store.setTodos([
      { content: "three: point checkout at priceFor", status: "pending", dependsOn: [1] },
      { content: "one: expose priceFor", status: "pending", interface: "priceFor(sku,qty): Money" },
    ] as TodoItem[]);
    const todos = store.snapshot().todos;
    expect(todos[0]!.content).toContain("three");
    // Position 2 is now "one: expose priceFor" — the step it has always rested on.
    expect(todos[0]!.dependsOn).toEqual([2]);
  });

  test("deleting the step you rest on does not finish it", () => {
    const store = new TaskStateStore();
    store.setTodos(PLAN());
    const verdict = store.setTodos([
      { content: "three: point checkout at priceFor", status: "completed" },
    ] as TodoItem[]);
    expect(verdict.accepted).toBe(false);
    expect(refusalsOf(verdict)[0]!.reason).toContain("drops without closing");
  });

  test("closing the dependency first closes both, and the edge stops binding", () => {
    // The way out has to stay open, or the refusal is a trap rather than a rule.
    const store = new TaskStateStore();
    store.setEvidenceGate("attest");
    store.setTodos(PLAN());
    const first = PLAN();
    first[0]!.status = "completed";
    expect(store.setTodos(first).accepted).toBe(true);
    const second = PLAN();
    second[0]!.status = "completed";
    second[1]!.status = "completed";
    expect(store.setTodos(second).accepted).toBe(true);
    // And once satisfied it is not resurrected by a later plan that drops the
    // finished step.
    expect(
      store.setTodos([
        { content: "three: point checkout at priceFor", status: "completed" },
      ] as TodoItem[]).accepted,
    ).toBe(true);
  });
});

describe("a plan no order can satisfy is refused", () => {
  test("a two-step cycle is refused, naming the loop", () => {
    const store = new TaskStateStore();
    const verdict = store.setTodos([
      { content: "a: the reader", status: "pending", dependsOn: [2] },
      { content: "b: the writer", status: "pending", dependsOn: [1] },
    ] as TodoItem[]);
    expect(verdict.accepted).toBe(false);
    expect(refusalsOf(verdict)[0]!.kind).toBe("dependency_cycle");
    expect(refusalsOf(verdict)[0]!.reason).toContain("a: the reader");
    expect(refusalsOf(verdict)[0]!.reason).toContain("b: the writer");
  });

  test("a three-step cycle is refused too, and does not hang", () => {
    const store = new TaskStateStore();
    const verdict = store.setTodos([
      { content: "a", status: "pending", dependsOn: [3] },
      { content: "b", status: "pending", dependsOn: [1] },
      { content: "c", status: "pending", dependsOn: [2] },
    ] as TodoItem[]);
    expect(verdict.accepted).toBe(false);
    expect(refusalsOf(verdict)[0]!.kind).toBe("dependency_cycle");
  });

  test("a self-dependency is still a typo, not a loop", () => {
    // Refusing it would make the step unclosable forever, and the model has no
    // way to express "this step depends on nothing" more clearly than by not
    // saying it.
    const store = new TaskStateStore();
    const verdict = store.setTodos([
      { content: "a", status: "pending", dependsOn: [1] },
    ] as TodoItem[]);
    expect(verdict.accepted).toBe(true);
    expect(store.snapshot().todos[0]!.dependsOn).toBeUndefined();
  });

  test("a chain that is not a cycle is accepted", () => {
    const store = new TaskStateStore();
    expect(
      store.setTodos([
        { content: "a", status: "pending" },
        { content: "b", status: "pending", dependsOn: [1] },
        { content: "c", status: "pending", dependsOn: [2] },
      ] as TodoItem[]).accepted,
    ).toBe(true);
  });
});

describe("openDependencies reads the stored plan as well as the submitted one", () => {
  test("with no stored plan it is the single-list check it always was", () => {
    expect(
      openDependencies([
        { content: "a", status: "completed", dependsOn: [2] },
        { content: "b", status: "pending" },
      ] as TodoItem[]),
    ).toHaveLength(1);
  });

  test("with a stored plan, an edge the submission dropped still counts", () => {
    const stored = PLAN();
    const submitted = PLAN();
    submitted[1]!.status = "completed";
    delete (submitted[1] as { dependsOn?: number[] }).dependsOn;
    const violations = openDependencies(submitted, stored);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.open[0]!.content).toContain("one: expose priceFor");
  });
});
