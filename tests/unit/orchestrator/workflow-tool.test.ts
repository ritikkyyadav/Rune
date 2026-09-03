/**
 * The `workflow` tool: what it runs, and what it says while it runs.
 *
 * P6B.6 proved the executor. This proves the SEAM — that a node is an ordinary
 * `task`/`worker` call through the live registry, and that every node's place
 * in the graph reaches the surfaces as typed data rather than as a string a
 * panel has to parse back into a topology (P10.9).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildAgentEvent } from "../../../packages/protocol/src/index";
import { createWorkflowTool } from "../../../packages/orchestrator/src/workflow-tool";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
  ToolRegistry,
} from "../../../packages/tool-registry/src/index";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gear-wft-"));
  dirs.push(d);
  return d;
}

/**
 * A registry whose `task` handler answers instantly and reports one child
 * event of its own — the same shape a real sub-agent's loop emits.
 */
function registry(behaviour: (input: ToolCallInput) => Partial<ToolCallOutput> = () => ({})) {
  const handler: ToolHandler = {
    schema: { name: "task", version: "1", description: "", inputSchema: {}, category: "execute" },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      input.onEvent?.({
        agentId: "w1",
        label: "the handler's own label",
        event: { type: "tool_call_start", callId: "inner", toolName: "grep" },
      });
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: `ran ${input.callId}`,
        durationMs: 1,
        ...behaviour(input),
      };
    },
  };
  return { get: (name: string) => (name === "task" ? handler : undefined) } as ToolRegistry;
}

function call(
  root: string,
  file: string,
  onEvent: (child: ChildAgentEvent) => void,
): ToolCallInput {
  return {
    toolName: "workflow",
    callId: "wf",
    args: { file, fresh: true },
    sessionId: "s",
    workspaceRoot: root,
    onEvent,
  };
}

const DIAMOND = {
  name: "diamond",
  nodes: [
    { id: "scope", kind: "task", prompt: "list the files" },
    { id: "security", kind: "task", prompt: "review security\n{{scope}}", dependsOn: ["scope"] },
    { id: "perf", kind: "task", prompt: "review perf\n{{scope}}", dependsOn: ["scope"] },
    {
      id: "report",
      kind: "task",
      prompt: "write it up\n{{security}}\n{{perf}}",
      dependsOn: ["security", "perf"],
    },
  ],
};

function writeWorkflow(root: string, definition: unknown): string {
  const path = join(root, "w.workflow.json");
  writeFileSync(path, JSON.stringify(definition));
  return path;
}

describe("P10.9 — a workflow node reaches the surfaces with its place in the graph", () => {
  test("every child event carries the node, its wave, and the edges it waited for", async () => {
    const root = tmp();
    const file = writeWorkflow(root, DIAMOND);
    const seen: ChildAgentEvent[] = [];
    const tool = createWorkflowTool({ registry: registry(), workspaceRoot: root });
    const out = await tool.execute(call(root, file, (c) => seen.push(c)));
    expect(out.success).toBe(true);

    const byNode = new Map(seen.filter((c) => c.node).map((c) => [c.node!.node, c.node!]));
    expect([...byNode.keys()].sort()).toEqual(["perf", "report", "scope", "security"]);
    expect(byNode.get("scope")).toMatchObject({ wave: 0, waves: 3, dependsOn: [] });
    expect(byNode.get("security")).toMatchObject({ wave: 1, waves: 3, dependsOn: ["scope"] });
    expect(byNode.get("report")).toMatchObject({
      wave: 2,
      waves: 3,
      dependsOn: ["security", "perf"],
      workflow: "diamond",
      kind: "task",
    });
  });

  test("the node id is the identity, not the handler's own agent id", async () => {
    // A worker names itself `w1` inside its own fan-out. One level up that
    // name means nothing and collides with the next workflow's `w1`; the node
    // id is what the graph, the cache key and the reader all call it.
    const root = tmp();
    const file = writeWorkflow(root, DIAMOND);
    const seen: ChildAgentEvent[] = [];
    const tool = createWorkflowTool({ registry: registry(), workspaceRoot: root });
    await tool.execute(call(root, file, (c) => seen.push(c)));

    const inner = seen.find((c) => c.event.type === "tool_call_start");
    expect(inner?.agentId).toBe("wf:scope");
    expect(inner?.label).toBe("scope");
    expect(inner?.node?.node).toBe("scope");
  });

  test("a cache hit and a skip are announced — nothing else would ever mention them", async () => {
    const root = tmp();
    // `scope` fails, so `security`/`perf`/`report` never run at all.
    const file = writeWorkflow(root, DIAMOND);
    const seen: ChildAgentEvent[] = [];
    const failing = registry((input) =>
      input.callId.endsWith(":scope")
        ? { success: false, error: "no such directory", result: "" }
        : {},
    );
    const tool = createWorkflowTool({ registry: failing, workspaceRoot: root });
    await tool.execute(call(root, file, (c) => seen.push(c)));

    const status = (id: string) =>
      seen.filter((c) => c.node?.node === id).at(-1)?.node?.status ?? null;
    expect(status("scope")).toBe("failed");
    // Skipped, not failed: these nodes behaved correctly and never ran.
    expect(status("security")).toBe("skipped");
    expect(status("report")).toBe("skipped");
  });

  test("a resumed workflow announces the nodes it did not re-run", async () => {
    const root = tmp();
    const file = writeWorkflow(root, DIAMOND);
    const tool = createWorkflowTool({ registry: registry(), workspaceRoot: root });
    // First pass writes state (fresh:false so the state file is kept).
    await tool.execute({ ...call(root, file, () => {}), args: { file } });

    const seen: ChildAgentEvent[] = [];
    await tool.execute({
      ...call(root, file, (c) => seen.push(c)),
      args: { file },
    });
    const cached = seen.filter((c) => c.node?.cached);
    // A cache hit runs no agent at all: without this event the row for a
    // resumed node would read as pending for the life of the run.
    expect(cached.map((c) => c.node!.node).sort()).toEqual(["perf", "report", "scope", "security"]);
    expect(cached.every((c) => c.node!.status === "completed")).toBe(true);
  });
});
