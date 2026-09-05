import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { mapWithConcurrency } from "./agent-loop";

/**
 * Deterministic workflows.
 *
 * `research.ts` is the one DAG in this repository, and it is hardcoded: plan →
 * approve → fan-out → reflect → synthesize, written as control flow around
 * `mapWithConcurrency`. It works, and every property that makes it good — the
 * fan-out, the bounded concurrency, the fixed shape — is trapped inside one
 * feature. Anything else that wants a repeatable multi-agent shape has to be
 * expressed as a prompt asking the model to please do these five things in this
 * order, which is exactly the sort of instruction a model follows four times
 * out of five.
 *
 * A workflow is that shape, written down:
 *
 *   { id, kind: "task" | "worker", prompt, dependsOn[], retry, schema }
 *
 * Executed in topological waves through the same `mapWithConcurrency` the
 * research DAG already uses, resumable from the last completed node, with each
 * node's result cached by content hash.
 *
 * ## What the cache key is, and why
 *
 * A node's hash covers its own definition AND the resolved results of
 * everything it depends on. So editing a prompt invalidates that node and
 * everything downstream of it, and re-running an unchanged workflow costs
 * nothing. Hashing only the node itself would produce the far worse failure:
 * a changed upstream result silently reusing a stale downstream answer, which
 * looks like a working cache right up until it is wrong.
 */

export type NodeKind = "task" | "worker";

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  prompt: string;
  /** Ids that must complete first. Their results are interpolated into the prompt. */
  dependsOn?: string[];
  /** Files a `worker` node owns. Required for workers, ignored for tasks. */
  files?: string[];
  /** Attempts on failure, including the first. Default 1. */
  retry?: number;
  /** Model tier for this node. */
  tier?: "light" | "standard" | "heavy";
  effort?: "quick" | "standard" | "thorough";
  /** A human label for the fleet view. */
  label?: string;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Concurrency within a wave. Defaults to the engine's own ceiling. */
  maxParallel?: number;
  nodes: WorkflowNode[];
}

export interface NodeResult {
  id: string;
  status: "completed" | "failed" | "skipped";
  /** The rendered text a downstream node interpolates. */
  output: string;
  /** The typed result when the sub-agent produced one. */
  structured?: Record<string, unknown>;
  error?: string;
  attempts: number;
  durationMs: number;
  /** True when this came from the cache rather than from a run. */
  cached: boolean;
  /** The content hash that keyed it. */
  hash: string;
}

export interface WorkflowState {
  workflow: string;
  startedAt: string;
  updatedAt: string;
  results: Record<string, NodeResult>;
}

/**
 * Where a node sits in the graph, handed to the runner and to every event.
 *
 * The executor knows all of this before a node runs, and a surface that has to
 * recover it afterwards — by parsing a heartbeat, or by re-deriving the waves
 * from the file — is a surface that will disagree with the executor the first
 * time either one changes. So it is passed, not inferred.
 */
export interface NodeRunContext {
  /** Topological level, 0-based, and how many levels the graph has. */
  wave: number;
  waves: number;
  /** The ids this node waited for: the wave's incoming edges, named. */
  dependsOn: string[];
  /** Attempt in progress (1-based) and the ceiling `retry` allows. */
  attempt: number;
  attempts: number;
}

export interface WorkflowRunOptions {
  /**
   * Runs a node and returns its output. The executor never talks to a model
   * itself.
   *
   * `ctx` is the node's place in the graph. A runner that only needs the
   * prompt ignores it; a runner that reports upward (the `workflow` tool)
   * carries it into the child event so a fleet view can group by wave without
   * re-deriving the topology it was already given.
   */
  runNode: (
    node: WorkflowNode,
    prompt: string,
    ctx: NodeRunContext,
  ) => Promise<{
    output: string;
    structured?: Record<string, unknown>;
    error?: string;
  }>;
  /** Where resume state lives. Omit to run without resumability. */
  statePath?: string;
  maxParallel?: number;
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
}

export type WorkflowEvent =
  | { type: "wave_start"; wave: number; waves: number; nodes: string[] }
  | ({ type: "node_start"; id: string } & NodeRunContext)
  // A retry, announced as it happens. The final `NodeResult` counts attempts,
  // but only afterwards — and a node on its third attempt looks exactly like a
  // slow node until something says so.
  | ({ type: "node_attempt"; id: string } & NodeRunContext)
  | ({ type: "node_done"; id: string; result: NodeResult } & Omit<
      NodeRunContext,
      "attempt" | "attempts"
    >)
  | ({ type: "node_cached"; id: string } & Omit<NodeRunContext, "attempt" | "attempts">)
  | { type: "workflow_done"; completed: number; failed: number; skipped: number };

// ─── Validation ───

export function parseWorkflow(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== "object") throw new Error("workflow must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "";
  if (!name) throw new Error("workflow needs a `name`");
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error("workflow needs a non-empty `nodes` array");
  }
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of (obj.nodes as unknown[]).entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`node ${i} is not an object`);
    const n = entry as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id.trim() : "";
    if (!id) throw new Error(`node ${i} needs an \`id\``);
    if (seen.has(id)) throw new Error(`duplicate node id: ${id}`);
    seen.add(id);
    const kind = n.kind === "worker" ? "worker" : n.kind === "task" ? "task" : null;
    if (!kind) throw new Error(`node ${id}: \`kind\` must be "task" or "worker"`);
    const prompt = typeof n.prompt === "string" ? n.prompt : "";
    if (!prompt.trim()) throw new Error(`node ${id} needs a \`prompt\``);
    const dependsOn = Array.isArray(n.dependsOn)
      ? n.dependsOn.filter((d): d is string => typeof d === "string")
      : [];
    const files = Array.isArray(n.files)
      ? n.files.filter((f): f is string => typeof f === "string")
      : undefined;
    if (kind === "worker" && (!files || files.length === 0)) {
      throw new Error(`node ${id}: a worker node must declare the \`files\` it owns`);
    }
    nodes.push({
      id,
      kind,
      prompt,
      dependsOn,
      ...(files ? { files } : {}),
      retry: Number.isFinite(n.retry) ? Math.max(1, Math.floor(Number(n.retry))) : 1,
      ...(typeof n.tier === "string" ? { tier: n.tier as WorkflowNode["tier"] } : {}),
      ...(typeof n.effort === "string" ? { effort: n.effort as WorkflowNode["effort"] } : {}),
      ...(typeof n.label === "string" ? { label: n.label } : {}),
    });
  }
  // Every dependency must exist, or a wave silently never runs.
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!seen.has(dep)) throw new Error(`node ${node.id} depends on unknown node ${dep}`);
      if (dep === node.id) throw new Error(`node ${node.id} depends on itself`);
    }
  }
  return {
    name,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(Number.isFinite(obj.maxParallel) ? { maxParallel: Number(obj.maxParallel) } : {}),
    nodes,
  };
}

/**
 * Group nodes into topological waves. Throws on a cycle, naming the nodes
 * involved — "workflow did not finish" is a much worse message than "a and b
 * depend on each other".
 */
export function topologicalWaves(nodes: WorkflowNode[]): WorkflowNode[][] {
  const remaining = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const waves: WorkflowNode[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((n) =>
      (n.dependsOn ?? []).every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      throw new Error(
        `workflow has a dependency cycle among: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    waves.push(ready);
    for (const n of ready) {
      remaining.delete(n.id);
      done.add(n.id);
    }
  }
  return waves;
}

// ─── Caching ───

/**
 * A node's identity: its own definition plus every upstream result it consumed.
 *
 * Including the upstream results is the whole point. Hashing only the node
 * would let a changed dependency reuse a stale answer, which looks like a
 * working cache right up until it is wrong.
 */
export function nodeHash(node: WorkflowNode, upstream: NodeResult[]): string {
  const material = JSON.stringify({
    id: node.id,
    kind: node.kind,
    prompt: node.prompt,
    files: node.files ?? [],
    tier: node.tier ?? null,
    effort: node.effort ?? null,
    upstream: upstream.map((u) => ({ id: u.id, output: u.output })),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function loadState(statePath: string): WorkflowState | null {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState;
  } catch {
    // A corrupt state file must not block a re-run; the workflow simply starts
    // over, which is the same outcome as never having run it.
    return null;
  }
}

function saveState(statePath: string, state: WorkflowState): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Resumability is a convenience; losing it must not fail the run.
  }
}

/** Where a workflow's resume state lives by default. */
export function defaultStatePath(workspaceRoot: string, workflowName: string): string {
  const safe = workflowName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return join(workspaceRoot, ".rune", "workflows", `${safe}.state.json`);
}

// ─── Prompt assembly ───

/**
 * Splice upstream results into a node's prompt.
 *
 * `{{node_id}}` is replaced with that node's output. Any dependency the prompt
 * does not name explicitly is appended under a heading, because a node that
 * declares a dependency and never reads it is almost always a prompt someone
 * forgot to update — and silently running it without the input it asked for
 * produces a confident answer to the wrong question.
 */
export function renderPrompt(node: WorkflowNode, upstream: NodeResult[]): string {
  let prompt = node.prompt;
  const used = new Set<string>();
  for (const result of upstream) {
    const token = `{{${result.id}}}`;
    if (prompt.includes(token)) {
      prompt = prompt.split(token).join(result.output);
      used.add(result.id);
    }
  }
  const unused = upstream.filter((u) => !used.has(u.id));
  if (unused.length === 0) return prompt;
  return [
    prompt,
    "",
    "── Results this step depends on ──",
    ...unused.map((u) => `\n### ${u.id}\n${u.output}`),
  ].join("\n");
}

// ─── Execution ───

export async function runWorkflow(
  definition: WorkflowDefinition,
  opts: WorkflowRunOptions,
): Promise<WorkflowState> {
  const waves = topologicalWaves(definition.nodes);
  const prior = opts.statePath ? loadState(opts.statePath) : null;
  const state: WorkflowState = {
    workflow: definition.name,
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    results: { ...(prior?.results ?? {}) },
  };

  const limit = Math.max(1, opts.maxParallel ?? definition.maxParallel ?? 4);

  for (const [waveIndex, wave] of waves.entries()) {
    if (opts.signal?.aborted) break;
    opts.onEvent?.({
      type: "wave_start",
      wave: waveIndex,
      waves: waves.length,
      nodes: wave.map((n) => n.id),
    });

    await mapWithConcurrency(wave, limit, async (node) => {
      if (opts.signal?.aborted) return;

      const dependsOn = node.dependsOn ?? [];
      const place = { wave: waveIndex, waves: waves.length, dependsOn };
      const upstream = dependsOn
        .map((id) => state.results[id])
        .filter((r): r is NodeResult => Boolean(r));

      // A node whose dependency failed does not run. Running it anyway would
      // hand a model a prompt with a hole where its input should be, and get
      // back a confident answer to a question nobody asked.
      const blocked = dependsOn.filter(
        (id) => !state.results[id] || state.results[id]!.status !== "completed",
      );
      if (blocked.length > 0) {
        state.results[node.id] = {
          id: node.id,
          status: "skipped",
          output: "",
          error: `upstream did not complete: ${blocked.join(", ")}`,
          attempts: 0,
          durationMs: 0,
          cached: false,
          hash: "",
        };
        opts.onEvent?.({
          type: "node_done",
          id: node.id,
          result: state.results[node.id]!,
          ...place,
        });
        return;
      }

      const hash = nodeHash(node, upstream);
      const cached = state.results[node.id];
      if (cached && cached.status === "completed" && cached.hash === hash) {
        // Same node, same inputs, already answered. This is what makes a resume
        // after a kill cheap rather than a full re-run.
        state.results[node.id] = { ...cached, cached: true };
        opts.onEvent?.({ type: "node_cached", id: node.id, ...place });
        return;
      }

      const attemptCeiling = node.retry ?? 1;
      opts.onEvent?.({
        type: "node_start",
        id: node.id,
        ...place,
        attempt: 1,
        attempts: attemptCeiling,
      });
      const prompt = renderPrompt(node, upstream);
      const started = Date.now();
      let attempts = 0;
      let last: { output: string; structured?: Record<string, unknown>; error?: string } = {
        output: "",
        error: "not run",
      };
      while (attempts < attemptCeiling) {
        attempts++;
        if (opts.signal?.aborted) break;
        const ctx: NodeRunContext = { ...place, attempt: attempts, attempts: attemptCeiling };
        // The first attempt is announced by node_start; only a RE-attempt is
        // news, and it is news the moment it starts rather than at the end.
        if (attempts > 1) opts.onEvent?.({ type: "node_attempt", id: node.id, ...ctx });
        try {
          last = await opts.runNode(node, prompt, ctx);
          if (!last.error) break;
        } catch (err) {
          last = { output: "", error: err instanceof Error ? err.message : String(err) };
        }
      }

      const result: NodeResult = {
        id: node.id,
        status: last.error ? "failed" : "completed",
        output: last.output,
        ...(last.structured ? { structured: last.structured } : {}),
        ...(last.error ? { error: last.error } : {}),
        attempts,
        durationMs: Date.now() - started,
        cached: false,
        hash,
      };
      state.results[node.id] = result;
      opts.onEvent?.({ type: "node_done", id: node.id, result, ...place });

      // Persisted per node, not per wave. A kill lands between two nodes far
      // more often than between two waves, and the whole value of resume is
      // not repeating the expensive node that already succeeded.
      state.updatedAt = new Date().toISOString();
      if (opts.statePath) saveState(opts.statePath, state);
    });
  }

  state.updatedAt = new Date().toISOString();
  if (opts.statePath) saveState(opts.statePath, state);

  const values = Object.values(state.results);
  opts.onEvent?.({
    type: "workflow_done",
    completed: values.filter((r) => r.status === "completed").length,
    failed: values.filter((r) => r.status === "failed").length,
    skipped: values.filter((r) => r.status === "skipped").length,
  });
  return state;
}
