import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { AgentTurnEvent, ChildAgentEvent, WorkflowNodeContext } from "@gear/protocol";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
  ToolRegistry,
  ToolSchema,
} from "@gear/tool-registry";

import {
  defaultStatePath,
  parseWorkflow,
  runWorkflow,
  topologicalWaves,
  type NodeRunContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./workflow";

/**
 * The `workflow` tool: run a written-down DAG from inside a session.
 *
 * The executor never talks to a model. It calls back into the registry's own
 * `task` and `worker` tools, which is what makes a workflow node identical to a
 * hand-written delegation — same ownership, same budgets, same schema-validated
 * result, same worktree isolation — rather than a second, parallel delegation
 * path that would drift from the first one within a month.
 */

export interface WorkflowToolDeps {
  /** The live registry, so nodes reach the same task/worker handlers a turn does. */
  registry: ToolRegistry;
  workspaceRoot: string;
  maxParallel?: number;
}

export const WORKFLOW_TOOL_SCHEMA: ToolSchema = {
  name: "workflow",
  version: "0.1.0",
  description:
    "Run a deterministic multi-agent workflow from a JSON file: a node list executed in " +
    "topological waves, resumable from the last completed node, each node's result cached by " +
    "content hash. Use this INSTEAD of asking yourself to do N things in order when the shape " +
    "is worth repeating — a review, a migration, a fan-out-then-synthesize. Each node is an " +
    "ordinary `task` or `worker` call, so ownership, budgets and isolation are unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "Workspace-relative path to the .workflow.json file.",
      },
      fresh: {
        type: "boolean",
        description: "Ignore saved state and re-run every node. Default false (resume).",
      },
    },
    required: ["file"],
  },
  category: "execute",
  permissionLevel: "confirm",
};

export function createWorkflowTool(deps: WorkflowToolDeps): ToolHandler {
  return {
    schema: WORKFLOW_TOOL_SCHEMA,
    validate: (args) => {
      if (typeof args.file !== "string" || !args.file.trim()) {
        return { valid: false, error: "file is required" };
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const file = String(input.args.file);
      const path = isAbsolute(file) ? file : resolve(input.workspaceRoot, file);
      const fail = (error: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error,
        durationMs: Math.round(performance.now() - start),
      });

      if (!existsSync(path)) return fail(`no such workflow file: ${file}`);
      let definition: WorkflowDefinition;
      try {
        definition = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
        // Validate the graph before spending anything: a cycle discovered
        // after four nodes have run is four nodes of wasted money.
        topologicalWaves(definition.nodes);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      // ── The wave, announced ──
      //
      // A workflow's members are levels, not a list: the reason a node has not
      // started is almost always that its wave has not, and a panel that draws
      // a flat fan-out cannot say so. The executor already knows the topology,
      // so it is carried on the child event rather than recovered by parsing a
      // heartbeat — which is what a surface had to do before P10.9.
      const byId = new Map(definition.nodes.map((n) => [n.id, n]));
      const placeOf = new Map<string, NodeRunContext>();
      for (const [wave, level] of topologicalWaves(definition.nodes).entries()) {
        for (const n of level) {
          placeOf.set(n.id, {
            wave,
            waves: 0, // filled below, once the count is known
            dependsOn: n.dependsOn ?? [],
            attempt: 1,
            attempts: n.retry ?? 1,
          });
        }
      }
      const waveCount = Math.max(0, ...[...placeOf.values()].map((p) => p.wave + 1));
      for (const p of placeOf.values()) p.waves = waveCount;

      const contextFor = (
        id: string,
        over: Partial<WorkflowNodeContext> = {},
      ): WorkflowNodeContext => {
        const place = placeOf.get(id);
        return {
          workflow: definition.name,
          node: id,
          kind: byId.get(id)?.kind ?? "task",
          wave: place?.wave ?? 0,
          waves: waveCount,
          dependsOn: place?.dependsOn ?? [],
          attempt: place?.attempt ?? 1,
          attempts: place?.attempts ?? 1,
          cached: false,
          ...over,
        };
      };
      /** Announce something about a node that no sub-agent event can carry. */
      const announce = (id: string, event: AgentTurnEvent, over: Partial<WorkflowNodeContext>) => {
        input.onEvent?.({
          agentId: `${input.callId}:${id}`,
          label: byId.get(id)?.label ?? id,
          event,
          node: contextFor(id, over),
        } satisfies ChildAgentEvent);
      };

      const state = await runWorkflow(definition, {
        ...(input.args.fresh === true
          ? {}
          : { statePath: defaultStatePath(input.workspaceRoot, definition.name) }),
        ...(deps.maxParallel ? { maxParallel: deps.maxParallel } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onEvent: (event) => {
          switch (event.type) {
            case "node_start":
              announce(
                event.id,
                { type: "notice", message: `wave ${event.wave + 1}` },
                {
                  status: "running",
                  attempt: event.attempt,
                  attempts: event.attempts,
                },
              );
              return;
            case "node_attempt":
              // A retry is news while it is happening. `NodeResult.attempts`
              // says so afterwards, which is exactly when it stops mattering.
              announce(
                event.id,
                { type: "notice", message: `attempt ${event.attempt} of ${event.attempts}` },
                { status: "running", attempt: event.attempt, attempts: event.attempts },
              );
              return;
            case "node_cached":
              // A cache hit runs no agent at all, so nothing else would ever
              // mention this node. Drawing it as absent would read as pending.
              announce(
                event.id,
                { type: "turn_complete", stopReason: "cached", totalTurns: 0 },
                { status: "completed", cached: true },
              );
              return;
            case "node_done":
              if (event.result.status === "failed") {
                announce(
                  event.id,
                  { type: "error", error: event.result.error ?? "node failed", recoverable: false },
                  { status: "failed", attempt: event.result.attempts },
                );
              } else if (event.result.status === "skipped") {
                announce(
                  event.id,
                  {
                    type: "notice",
                    message: event.result.error ?? "upstream did not complete",
                  },
                  { status: "skipped" },
                );
              } else {
                announce(
                  event.id,
                  { type: "turn_complete", stopReason: "end_turn", totalTurns: 0 },
                  { status: "completed", attempt: event.result.attempts },
                );
              }
              return;
            default:
              return;
          }
        },
        runNode: async (node: WorkflowNode, prompt: string, ctx: NodeRunContext) => {
          const handler = deps.registry.get(node.kind);
          if (!handler) {
            return { output: "", error: `the ${node.kind} tool is not available in this session` };
          }
          const args: Record<string, unknown> = {
            prompt,
            ...(node.label ? { label: node.label } : {}),
            ...(node.tier ? { tier: node.tier } : {}),
            ...(node.effort ? { effort: node.effort } : {}),
            ...(node.kind === "worker" ? { files: node.files ?? [] } : {}),
          };
          const out = await handler.execute({
            toolName: node.kind,
            callId: `${input.callId}:${node.id}`,
            args,
            sessionId: input.sessionId,
            workspaceRoot: deps.workspaceRoot,
            ...(input.signal ? { signal: input.signal } : {}),
            // The node's own progress rides the parent call's channel, keyed by
            // node id so a fleet view can group by it.
            ...(input.onProgress
              ? { onProgress: (note: string) => input.onProgress?.(`${node.id} ${note}`) }
              : {}),
            // The typed channel, re-keyed to the NODE. A worker names itself
            // `w1` inside its own fan-out, which is a name that means nothing
            // one level up and collides with the next workflow's `w1`; the
            // node id is what the graph, the cache and the reader all call it.
            ...(input.onEvent
              ? {
                  onEvent: (child: ChildAgentEvent) =>
                    input.onEvent?.({
                      ...child,
                      agentId: `${input.callId}:${node.id}`,
                      label: node.label ?? node.id,
                      node: contextFor(node.id, {
                        status: "running",
                        attempt: ctx.attempt,
                        attempts: ctx.attempts,
                      }),
                    }),
                }
              : {}),
          });
          return {
            output: out.result,
            ...(out.structured ? { structured: out.structured } : {}),
            ...(out.success ? {} : { error: out.error ?? "node failed" }),
          };
        },
      });

      const results = Object.values(state.results);
      const failed = results.filter((r) => r.status === "failed");
      const skipped = results.filter((r) => r.status === "skipped");
      const lines = [
        `Workflow "${definition.name}": ${results.filter((r) => r.status === "completed").length} completed, ` +
          `${failed.length} failed, ${skipped.length} skipped.`,
        "",
      ];
      for (const node of definition.nodes) {
        const r = state.results[node.id];
        if (!r) continue;
        lines.push(
          `── ${node.id} [${r.status}${r.cached ? ", cached" : ""}${r.attempts > 1 ? `, ${r.attempts} attempts` : ""}] ──`,
        );
        lines.push(r.status === "completed" ? r.output : (r.error ?? "no output"));
        lines.push("");
      }
      if (failed.length > 0 || skipped.length > 0) {
        lines.push(
          "Re-running this workflow will skip every completed node and retry only the rest; " +
            "fix the cause first, or pass fresh: true to start over.",
        );
      }

      return {
        callId: input.callId,
        toolName: input.toolName,
        // A workflow with a failed node still SUCCEEDED as a tool call: it ran
        // the graph and reported what happened. Failing the call would throw
        // away every completed node's output on the way back to the model.
        success: true,
        result: lines.join("\n"),
        structured: state as unknown as Record<string, unknown>,
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
