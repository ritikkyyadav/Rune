import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

      const state = await runWorkflow(definition, {
        ...(input.args.fresh === true
          ? {}
          : { statePath: defaultStatePath(input.workspaceRoot, definition.name) }),
        ...(deps.maxParallel ? { maxParallel: deps.maxParallel } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        runNode: async (node: WorkflowNode, prompt: string) => {
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
