/**
 * Phase 5 F4 — an architecture plan carries its interfaces and closes in
 * dependency order.
 *
 * Two rules, both structural: the runtime carries the model's `interface` /
 * `invariant` / `migration` / `acceptance` / `dependsOn` fields and invents
 * none of them, and a step whose dependency is still open cannot be marked
 * completed — whatever the evidence mode says, because that is a contradiction
 * inside the plan rather than a shortage of receipts.
 */

import { describe, expect, test } from "bun:test";
import { openDependencies, TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { normalizeTodoItems } from "../../../packages/tool-registry/src/tools/todo-write";
import type { TodoItem } from "@rune/protocol";

function store(): TaskStateStore {
  return new TaskStateStore();
}

const PLAN: TodoItem[] = [
  {
    content: "expose priceFor(sku, qty) from pricing/index.ts",
    status: "pending",
    kind: "change",
    interface: "export function priceFor(sku: string, qty: number): Money",
    invariant: "every existing caller of computeTotal keeps its result",
    migration: "callers move one at a time; the old export stays until step 3",
    acceptance: "bun test tests/pricing.test.ts",
  },
  {
    content: "move the rules into pricing/rules.ts",
    status: "pending",
    kind: "change",
    dependsOn: [1],
  },
  {
    content: "point the checkout at priceFor and delete computeTotal",
    status: "pending",
    kind: "change",
    dependsOn: [1, 2],
  },
];

describe("the fields the model supplies survive; the runtime invents none", () => {
  test("the tool normaliser carries all five, and drops what was not given", () => {
    const result = normalizeTodoItems([
      {
        content: "expose priceFor",
        status: "pending",
        interface: "export function priceFor(sku: string, qty: number): Money",
        invariant: "computeTotal keeps its result",
        migration: "callers move one at a time",
        acceptance: "bun test tests/pricing.test.ts",
        dependsOn: [],
      },
      { content: "move the rules", status: "pending", dependsOn: [1, "2", 99, -1] },
      { content: "a plain step", status: "pending" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]!.interface).toContain("priceFor");
    expect(result.items[0]!.acceptance).toBe("bun test tests/pricing.test.ts");
    // An empty dependsOn is no dependsOn.
    expect(result.items[0]!.dependsOn).toBeUndefined();
    // Out-of-range positions are dropped, strings are coerced.
    expect(result.items[1]!.dependsOn).toEqual([1, 2]);
    // A step that said nothing gets nothing invented for it.
    expect(result.items[2]!.interface).toBeUndefined();
    expect(result.items[2]!.invariant).toBeUndefined();
    expect(result.items[2]!.dependsOn).toBeUndefined();
  });

  test("the ledger keeps them across a re-submission that does not repeat them", () => {
    const ts = store();
    ts.setTodos(PLAN, { enforce: false });
    expect(ts.todos[0]!.interface).toContain("priceFor");
    // The model rewrites the list and leaves the interface off step 1.
    ts.setTodos(
      PLAN.map((t, i) => (i === 0 ? { content: t.content, status: "in_progress" as const } : t)),
      { enforce: false },
    );
    expect(ts.todos[0]!.interface).toContain("priceFor");
    expect(ts.todos[0]!.invariant).toContain("computeTotal");
    expect(ts.todos[1]!.dependsOn).toEqual([1]);
  });
});

describe("dependency order", () => {
  test("openDependencies names the closing step and every open step it rests on", () => {
    const items: TodoItem[] = [
      { ...PLAN[0]!, status: "pending" },
      { ...PLAN[1]!, status: "completed" },
      { ...PLAN[2]!, status: "completed" },
    ];
    const violations = openDependencies(items);
    expect(violations.map((v) => v.index)).toEqual([1, 2]);
    expect(violations[1]!.open.map((o) => o.at)).toEqual([1]);
    expect(violations[1]!.open[0]!.content).toContain("priceFor");
  });

  test("a self-reference is ignored; a forward reference on an open step is not", () => {
    // Step 1 naming itself is a typo, and refusing it would make the step
    // unclosable forever.
    expect(openDependencies([{ content: "a", status: "completed", dependsOn: [1] }])).toEqual([]);
    // Step 1 resting on an open step 2 is the same contradiction written
    // backwards, and is refused.
    const backwards = openDependencies([
      { content: "a", status: "completed", dependsOn: [2] },
      { content: "b", status: "pending" },
    ]);
    expect(backwards).toHaveLength(1);
    expect(backwards[0]!.open[0]!.at).toBe(2);
  });

  test("a step that depends on an open step is refused, in either evidence mode", () => {
    for (const gate of ["attest", "refuse"] as const) {
      const ts = store();
      ts.setEvidenceGate(gate);
      ts.setTodos(PLAN);
      const verdict = ts.setTodos([
        PLAN[0]!,
        { ...PLAN[1]!, status: "completed" },
        PLAN[2]!,
      ] as TodoItem[]);
      expect(verdict.accepted).toBe(false);
      expect(verdict.refused).toHaveLength(1);
      expect(verdict.refused[0]!.kind).toBe("open_dependency");
      expect(verdict.refused[0]!.reason).toContain("step 1");
      expect(verdict.refused[0]!.reason).toContain("still open");
      // The plan on record never took the lie.
      expect(ts.todos[1]!.status).not.toBe("completed");
    }
  });

  test("it is refused EVERY time, not once — the model always has a way out", () => {
    const ts = store();
    ts.setEvidenceGate("refuse");
    ts.setTodos(PLAN);
    const bad = [PLAN[0]!, { ...PLAN[1]!, status: "completed" as const }, PLAN[2]!];
    const first = ts.setTodos(bad);
    const second = ts.setTodos(bad);
    expect(first.accepted).toBe(false);
    expect(second.accepted).toBe(false);
    expect(second.accepted === false && second.refused[0]!.kind).toBe("open_dependency");
    // Closing the dependency in the same submission is the way out: the
    // dependency refusal is gone. (The evidence gate still has its own say —
    // that is a different rule, and this one is no longer firing.)
    const ok = ts.setTodos([
      { ...PLAN[0]!, status: "completed" },
      { ...PLAN[1]!, status: "completed" },
      PLAN[2]!,
    ] as TodoItem[]);
    if (!ok.accepted) {
      expect(ok.refused.every((r) => r.kind !== "open_dependency")).toBe(true);
    }
  });

  test("a plan with no dependsOn behaves exactly as it always did", () => {
    const ts = store();
    const plain: TodoItem[] = [
      { content: "read the parser", status: "completed", kind: "inspect" },
      { content: "fix the quote handling", status: "pending", kind: "change" },
    ];
    ts.setTodos([
      { content: "read the parser", status: "in_progress", kind: "inspect" },
      plain[1]!,
    ]);
    const verdict = ts.setTodos(plain);
    expect(
      verdict.accepted === false && verdict.refused.some((r) => r.kind === "open_dependency"),
    ).toBe(false);
  });

  test("restoring known state (enforce: false) is never refused", () => {
    const ts = store();
    const verdict = ts.setTodos(
      [PLAN[0]!, { ...PLAN[1]!, status: "completed" }, PLAN[2]!] as TodoItem[],
      { enforce: false },
    );
    expect(verdict.accepted).toBe(true);
  });
});
