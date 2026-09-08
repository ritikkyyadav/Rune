import { expect, test } from "bun:test";
import { DelegationPool } from "../../../packages/orchestrator/src/delegation-pool";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

const input = (id: string, signal?: AbortSignal): ToolCallInput => ({
  callId: id,
  toolName: "task",
  args: {},
  sessionId: "s",
  workspaceRoot: "/tmp",
  signal,
});

test("standalone and workflow delegations share capacity; queued cancellation spends nothing", async () => {
  let limit = 2;
  const pool = new DelegationPool(() => limit);
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const handler: ToolHandler = {
    schema: {
      name: "task",
      version: "1",
      description: "",
      inputSchema: {},
      category: "read",
      permissionLevel: "auto",
    },
    validate: () => ({ valid: true }),
    execute: async (call) => {
      started.push(call.callId);
      await new Promise<void>((resolve) => finish.set(call.callId, resolve));
      if (call.callId === "a") throw new Error("worker failed");
      return { ...call, success: true, result: "done", durationMs: 0 };
    },
  };
  const scout = pool.wrap(handler);
  const worker = pool.wrap({ ...handler, schema: { ...handler.schema, name: "worker" } });
  const a = scout.execute(input("a")).catch((error: Error) => error.message);
  const b = worker.execute(input("b"));
  const abort = new AbortController();
  const c = scout.execute(input("cancelled", abort.signal));
  const d = worker.execute(input("workflow-node"));
  await Promise.resolve();
  expect(started).toEqual(["a", "b"]);
  abort.abort();
  expect((await c).success).toBe(false);
  limit = 1;
  finish.get("a")!();
  expect(await a).toBe("worker failed");
  expect(started).toEqual(["a", "b"]);
  finish.get("b")!();
  await b;
  await Promise.resolve();
  expect(started).toEqual(["a", "b", "workflow-node"]);
  finish.get("workflow-node")!();
  expect((await d).success).toBe(true);
});
