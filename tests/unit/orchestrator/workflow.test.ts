import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadState,
  nodeHash,
  parseWorkflow,
  renderPrompt,
  runWorkflow,
  topologicalWaves,
  type NodeResult,
  type WorkflowEvent,
  type WorkflowNode,
} from "../../../packages/orchestrator/src/workflow";

/**
 * P6B.6 — a repeatable multi-agent shape, written down.
 *
 * research.ts was the only DAG in this repository and it was hardcoded.
 * Everything good about it was trapped in one feature, and any other repeatable
 * shape had to be expressed as a prompt asking the model to please do five
 * things in order — the sort of instruction a model follows four times in five.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gear-wf-"));
  dirs.push(d);
  return d;
}

function node(
  id: string,
  dependsOn: string[] = [],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id, kind: "task", prompt: `do ${id}`, dependsOn, retry: 1, ...extra };
}

const DIAMOND = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];

describe("P6B.6 — parsing rejects graphs that would fail silently", () => {
  test("a valid workflow parses", () => {
    const wf = parseWorkflow({
      name: "x",
      nodes: [{ id: "a", kind: "task", prompt: "p" }],
    });
    expect(wf.nodes).toHaveLength(1);
  });

  test("a dependency on an unknown node is an error, not a wave that never runs", () => {
    expect(() =>
      parseWorkflow({
        name: "x",
        nodes: [{ id: "a", kind: "task", prompt: "p", dependsOn: ["ghost"] }],
      }),
    ).toThrow(/unknown node ghost/);
  });

  test("a worker without files is an error", () => {
    // Ownership is what makes a worker safe; one without it is not a worker.
    expect(() =>
      parseWorkflow({ name: "x", nodes: [{ id: "a", kind: "worker", prompt: "p" }] }),
    ).toThrow(/files/);
  });

  test("duplicate ids and self-dependencies are errors", () => {
    expect(() =>
      parseWorkflow({
        name: "x",
        nodes: [
          { id: "a", kind: "task", prompt: "p" },
          { id: "a", kind: "task", prompt: "q" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseWorkflow({
        name: "x",
        nodes: [{ id: "a", kind: "task", prompt: "p", dependsOn: ["a"] }],
      }),
    ).toThrow(/itself/);
  });
});

describe("P6B.6 — topological waves", () => {
  test("a diamond becomes three waves", () => {
    const waves = topologicalWaves(DIAMOND);
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  test("independent nodes share one wave", () => {
    expect(topologicalWaves([node("a"), node("b"), node("c")])[0]).toHaveLength(3);
  });

  test("a cycle names the nodes involved", () => {
    // "workflow did not finish" is a far worse message than "a and b depend on
    // each other".
    const cyclic = [node("a", ["b"]), node("b", ["a"])];
    expect(() => topologicalWaves(cyclic)).toThrow(/cycle among: a, b/);
  });
});

describe("P6B.6 — the cache key covers upstream results", () => {
  const upstream: NodeResult[] = [
    {
      id: "a",
      status: "completed",
      output: "one",
      attempts: 1,
      durationMs: 1,
      cached: false,
      hash: "h",
    },
  ];

  test("the same node with the same inputs hashes the same", () => {
    expect(nodeHash(node("b", ["a"]), upstream)).toBe(nodeHash(node("b", ["a"]), upstream));
  });

  test("a changed upstream result invalidates the node", () => {
    // Hashing only the node would let a changed dependency reuse a stale
    // answer, which looks like a working cache right up until it is wrong.
    const changed: NodeResult[] = [{ ...upstream[0]!, output: "two" }];
    expect(nodeHash(node("b", ["a"]), upstream)).not.toBe(nodeHash(node("b", ["a"]), changed));
  });

  test("a changed prompt invalidates the node", () => {
    const edited = { ...node("b", ["a"]), prompt: "do it differently" };
    expect(nodeHash(node("b", ["a"]), upstream)).not.toBe(nodeHash(edited, upstream));
  });
});

describe("P6B.6 — prompt assembly", () => {
  const upstream: NodeResult[] = [
    {
      id: "a",
      status: "completed",
      output: "FINDINGS",
      attempts: 1,
      durationMs: 1,
      cached: false,
      hash: "h",
    },
  ];

  test("a named token is substituted", () => {
    const n = { ...node("b", ["a"]), prompt: "review this:\n{{a}}" };
    expect(renderPrompt(n, upstream)).toBe("review this:\nFINDINGS");
  });

  test("an unnamed dependency is appended rather than dropped", () => {
    // A node that declares a dependency and never reads it is almost always a
    // prompt someone forgot to update, and running it without the input
    // produces a confident answer to the wrong question.
    const rendered = renderPrompt(node("b", ["a"]), upstream);
    expect(rendered).toContain("Results this step depends on");
    expect(rendered).toContain("FINDINGS");
  });
});

describe("P6B.6 — execution, resume and caching", () => {
  test("nodes run in dependency order", async () => {
    const order: string[] = [];
    await runWorkflow(
      { name: "w", nodes: DIAMOND },
      {
        runNode: async (n) => {
          order.push(n.id);
          return { output: n.id };
        },
      },
    );
    expect(order[0]).toBe("a");
    expect(order.at(-1)).toBe("d");
    expect(order).toHaveLength(4);
  });

  test("a failed node skips its dependents rather than running them blind", async () => {
    const ran: string[] = [];
    const state = await runWorkflow(
      { name: "w", nodes: DIAMOND },
      {
        runNode: async (n) => {
          ran.push(n.id);
          return n.id === "b" ? { output: "", error: "boom" } : { output: n.id };
        },
      },
    );
    expect(state.results.b!.status).toBe("failed");
    expect(state.results.d!.status).toBe("skipped");
    expect(state.results.d!.error).toContain("upstream did not complete: b");
    // c is independent of b and still runs — one failure must not stop the world.
    expect(state.results.c!.status).toBe("completed");
    expect(ran).not.toContain("d");
  });

  test("retry re-runs a failing node up to its limit", async () => {
    let attempts = 0;
    const state = await runWorkflow(
      { name: "w", nodes: [node("a", [], { retry: 3 })] },
      {
        runNode: async () => {
          attempts++;
          return attempts < 3 ? { output: "", error: "flaky" } : { output: "ok" };
        },
      },
    );
    expect(attempts).toBe(3);
    expect(state.results.a!.status).toBe("completed");
    expect(state.results.a!.attempts).toBe(3);
  });

  test("a kill at node 3 resumes without re-running the first two", async () => {
    // The gate: kill mid-run, restart, and the expensive nodes that already
    // succeeded are not paid for twice.
    const dir = tmp();
    const statePath = join(dir, "state.json");
    const chain = [node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["c"])];

    const controller = new AbortController();
    const firstRun: string[] = [];
    await runWorkflow(
      { name: "w", nodes: chain },
      {
        statePath,
        runNode: async (n) => {
          firstRun.push(n.id);
          // The kill lands as node 3 starts.
          if (firstRun.length >= 2) controller.abort();
          return { output: `out-${n.id}` };
        },
        signal: controller.signal,
      },
    );
    expect(firstRun).toEqual(["a", "b"]);

    const saved = loadState(statePath);
    expect(Object.keys(saved!.results).sort()).toEqual(["a", "b"]);

    const secondRun: string[] = [];
    const state = await runWorkflow(
      { name: "w", nodes: chain },
      {
        statePath,
        runNode: async (n) => {
          secondRun.push(n.id);
          return { output: `out-${n.id}` };
        },
      },
    );
    // Only the unfinished tail runs.
    expect(secondRun).toEqual(["c", "d"]);
    expect(state.results.a!.cached).toBe(true);
    expect(state.results.b!.cached).toBe(true);
    expect(state.results.d!.status).toBe("completed");
  });

  test("an edited prompt invalidates that node on resume", async () => {
    const dir = tmp();
    const statePath = join(dir, "state.json");
    await runWorkflow(
      { name: "w", nodes: [node("a"), node("b", ["a"])] },
      { statePath, runNode: async (n) => ({ output: `v1-${n.id}` }) },
    );

    const reran: string[] = [];
    await runWorkflow(
      { name: "w", nodes: [{ ...node("a"), prompt: "do a differently" }, node("b", ["a"])] },
      {
        statePath,
        runNode: async (n) => {
          reran.push(n.id);
          return { output: `v2-${n.id}` };
        },
      },
    );
    // a changed, so a re-runs — and b re-runs because its INPUT changed.
    expect(reran).toEqual(["a", "b"]);
  });

  test("state is written per node, not per wave", async () => {
    // A kill lands between two nodes far more often than between two waves.
    const dir = tmp();
    const statePath = join(dir, "state.json");
    const seenDuringRun: number[] = [];
    await runWorkflow(
      { name: "w", nodes: [node("a"), node("b"), node("c")] },
      {
        statePath,
        maxParallel: 1,
        runNode: async (n) => {
          const s = loadState(statePath);
          seenDuringRun.push(s ? Object.keys(s.results).length : 0);
          return { output: n.id };
        },
      },
    );
    expect(seenDuringRun).toEqual([0, 1, 2]);
    expect(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).results)).toHaveLength(3);
  });

  test("a corrupt state file starts over rather than blocking the run", async () => {
    const dir = tmp();
    const statePath = join(dir, "state.json");
    Bun.write(statePath, "{ not json");
    const state = await runWorkflow(
      { name: "w", nodes: [node("a")] },
      { statePath, runNode: async () => ({ output: "ok" }) },
    );
    expect(state.results.a!.status).toBe("completed");
  });
});

describe("P10.9 — every event names the node's place in the graph", () => {
  test("the runner is told which wave it is on and which edges it waited for", async () => {
    // The executor knows the topology before anything runs. A surface that has
    // to recover it afterwards — by parsing a heartbeat, or by re-deriving the
    // waves from the file — is a surface that disagrees with the executor the
    // first time either one changes.
    const seen: Array<{ id: string; wave: number; waves: number; dependsOn: string[] }> = [];
    await runWorkflow(
      { name: "w", nodes: DIAMOND },
      {
        runNode: async (n, _prompt, ctx) => {
          seen.push({ id: n.id, wave: ctx.wave, waves: ctx.waves, dependsOn: ctx.dependsOn });
          return { output: n.id };
        },
      },
    );
    expect(seen.find((s) => s.id === "a")).toEqual({
      id: "a",
      wave: 0,
      waves: 3,
      dependsOn: [],
    });
    expect(seen.find((s) => s.id === "d")).toEqual({
      id: "d",
      wave: 2,
      waves: 3,
      dependsOn: ["b", "c"],
    });
  });

  test("wave_start, node_start, node_done and node_cached all carry the level", async () => {
    const events: WorkflowEvent[] = [];
    const dir = tmp();
    const statePath = join(dir, "state.json");
    const nodes = [node("a"), node("b", ["a"])];
    await runWorkflow(
      { name: "w", nodes },
      { statePath, runNode: async (n) => ({ output: n.id }) },
    );

    // Second run: `a` is a cache hit, and the cached event must still say where
    // `a` lives — a cache hit runs nothing, so nothing else ever will.
    await runWorkflow(
      { name: "w", nodes },
      {
        statePath,
        runNode: async (n) => ({ output: n.id }),
        onEvent: (e) => events.push(e),
      },
    );
    const waveStart = events.find((e) => e.type === "wave_start");
    expect(waveStart).toMatchObject({ wave: 0, waves: 2, nodes: ["a"] });
    const cached = events.find((e) => e.type === "node_cached");
    expect(cached).toMatchObject({ id: "a", wave: 0, waves: 2, dependsOn: [] });
  });

  test("a retry is announced while it happens, not only counted afterwards", async () => {
    // `NodeResult.attempts` reports the retry when the node is over, which is
    // exactly when it has stopped being the thing anyone wanted to know.
    const events: WorkflowEvent[] = [];
    let attempts = 0;
    await runWorkflow(
      { name: "w", nodes: [node("a", [], { retry: 3 })] },
      {
        runNode: async () => {
          attempts++;
          return attempts < 3 ? { output: "", error: "flaky" } : { output: "ok" };
        },
        onEvent: (e) => events.push(e),
      },
    );
    const retries = events.filter((e) => e.type === "node_attempt");
    expect(retries.map((e) => (e as { attempt: number }).attempt)).toEqual([2, 3]);
    expect(retries.every((e) => (e as { attempts: number }).attempts === 3)).toBe(true);
    // The first attempt is node_start's, not a re-attempt.
    expect(events.filter((e) => e.type === "node_start")).toHaveLength(1);
  });

  test("a skipped node's event names the level it never ran on", async () => {
    const events: WorkflowEvent[] = [];
    await runWorkflow(
      { name: "w", nodes: DIAMOND },
      {
        runNode: async (n) => (n.id === "b" ? { output: "", error: "boom" } : { output: n.id }),
        onEvent: (e) => events.push(e),
      },
    );
    const skipped = events.find(
      (e) => e.type === "node_done" && e.result.status === "skipped",
    ) as Extract<WorkflowEvent, { type: "node_done" }>;
    expect(skipped.id).toBe("d");
    expect(skipped.wave).toBe(2);
    expect(skipped.dependsOn).toEqual(["b", "c"]);
  });
});
