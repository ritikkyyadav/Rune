import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { TeamBus } from "../../../packages/orchestrator/src/team/bus";

/**
 * P6B.5 — the ledger becomes a queue.
 *
 * `TaskState` belonged to the lead alone: it was passed to the lead's loop and
 * to nothing else, so a fleet of four workers building four slices of one
 * feature appeared in the plan as one in-progress item with no way to say which
 * worker held it. An owner is what turns a plan into a queue; a `tasks` table
 * on the bus is what extends that across instances.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gear-ledger-"));
  dirs.push(d);
  return d;
}

function storeWith(contents: string[]): TaskStateStore {
  const store = new TaskStateStore();
  store.beginTurn("build the thing");
  store.setTodos(contents.map((content) => ({ content, status: "pending" as const })));
  return store;
}

describe("P6B.5 — claim-next on the in-process ledger", () => {
  test("a claim marks the step in progress and records its owner", () => {
    const store = storeWith(["backend", "frontend"]);
    const claimed = store.claimNext("w1");
    expect(claimed?.content).toBe("backend");
    expect(claimed?.owner).toBe("w1");
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.claimedAt).toBeDefined();
  });

  test("two claimers get different steps", () => {
    // Two workers building the same slice is the exact failure the ownership
    // model exists to prevent one layer down.
    const store = storeWith(["backend", "frontend", "docs"]);
    const a = store.claimNext("w1");
    const b = store.claimNext("w2");
    expect(a?.content).toBe("backend");
    expect(b?.content).toBe("frontend");
    expect(store.claimsOf("w1")).toHaveLength(1);
    expect(store.claimsOf("w2")).toHaveLength(1);
  });

  test("an exhausted queue returns null rather than re-handing out work", () => {
    const store = storeWith(["only one"]);
    expect(store.claimNext("w1")).not.toBeNull();
    expect(store.claimNext("w2")).toBeNull();
  });

  test("releasing puts the step back", () => {
    const store = storeWith(["backend"]);
    store.claimNext("w1");
    expect(store.releaseClaim("w1")).toBe(1);
    const retaken = store.claimNext("w2");
    expect(retaken?.content).toBe("backend");
    expect(retaken?.owner).toBe("w2");
  });

  test("a step whose owner went quiet is reclaimable", () => {
    // Without this a crashed worker strands its step forever and the fleet
    // deadlocks on an item nobody is doing and nobody may take.
    const store = storeWith(["backend"]);
    store.claimNext("w1");
    Bun.sleepSync(5);
    expect(store.claimNext("w2", { reclaimAfterMs: 1 })?.owner).toBe("w2");
  });

  test("a live owner's step is not stolen", () => {
    const store = storeWith(["backend"]);
    store.claimNext("w1");
    expect(store.claimNext("w2", { reclaimAfterMs: 60_000 })).toBeNull();
  });

  test("items written before the ledger was multi-writer have no owner", () => {
    const store = storeWith(["legacy"]);
    expect(store.snapshot().todos[0]!.owner).toBeUndefined();
  });
});

describe("P6B.5 — the tasks table on the team bus", () => {
  // The bus generates its own instance id; identity is read back off the
  // object rather than asserted, which is also how a real peer sees it.
  function bus(dir: string): TeamBus {
    return new TeamBus({ dbPath: join(dir, "team.db"), repoKey: "repo", workspace: dir });
  }

  test("a posted task is visible to another instance", () => {
    const dir = tmp();
    const a = bus(dir);
    const b = bus(dir);
    a.postTask("write the parser");
    expect(b.tasks("pending").map((t) => t.content)).toEqual(["write the parser"]);
    a.close();
    b.close();
  });

  test("only one instance wins a contested task", () => {
    // The UPDATE … WHERE status='pending' is the arbiter. A read-then-write
    // would let both believe they won.
    const dir = tmp();
    const a = bus(dir);
    const b = bus(dir);
    a.postTask("the only task");
    const first = a.claimNextTask();
    const second = b.claimNextTask();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.ownerId).toBe(a.instanceId);
    a.close();
    b.close();
  });

  test("tasks are handed out oldest first", () => {
    const dir = tmp();
    const a = bus(dir);
    a.postTask("first");
    a.postTask("second");
    expect(a.claimNextTask()?.content).toBe("first");
    expect(a.claimNextTask()?.content).toBe("second");
    a.close();
  });

  test("completing records the evidence that closed it", () => {
    const dir = tmp();
    const a = bus(dir);
    const task = a.postTask("write the parser")!;
    a.claimNextTask();
    expect(a.completeTask(task.id, "tests/parser.test.ts passes")).toBe(true);
    const done = a.tasks("completed");
    expect(done[0]!.evidence).toContain("parser.test.ts");
    a.close();
  });

  test("an instance cannot complete a task it does not hold", () => {
    const dir = tmp();
    const a = bus(dir);
    const b = bus(dir);
    const task = a.postTask("write the parser")!;
    a.claimNextTask();
    expect(b.completeTask(task.id, "no")).toBe(false);
    a.close();
    b.close();
  });

  test("releasing returns the task to the queue", () => {
    const dir = tmp();
    const a = bus(dir);
    const b = bus(dir);
    const task = a.postTask("write the parser")!;
    a.claimNextTask();
    expect(a.releaseTask(task.id)).toBe(true);
    expect(b.claimNextTask()?.ownerId).toBe(b.instanceId);
    a.close();
    b.close();
  });

  test("an expired claim releases the task rather than deleting it", () => {
    // Deleting it — the obvious symmetry with claims and writes — would
    // silently drop work the moment a session crashed.
    const dir = tmp();
    const a = bus(dir);
    a.postTask("write the parser");
    a.claimNextTask(1);
    Bun.sleepSync(10);
    const b = bus(dir);
    const taken = b.claimNextTask();
    expect(taken?.content).toBe("write the parser");
    expect(taken?.ownerId).toBe(b.instanceId);
    a.close();
    b.close();
  });

  test("a completed task is never re-handed out", () => {
    const dir = tmp();
    const a = bus(dir);
    const task = a.postTask("write the parser")!;
    a.claimNextTask();
    a.completeTask(task.id, "done");
    expect(a.claimNextTask()).toBeNull();
    a.close();
  });
});
