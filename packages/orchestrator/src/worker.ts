// ─── `worker` tool: write-capable parallel sub-agents ───
//
// The scaling story for big builds: the LEAD agent splits implementation
// across workers, each with a self-contained contract and a DISJOINT set of
// files it owns; workers run concurrently (the tool is parallel-safe) and the
// lead integrates and verifies. This is the "delegate to many sub-agents"
// architecture, made safe by construction:
//
//   - A worker can create/edit ONLY the files it owns. The guard wraps the
//     write tools themselves, so ownership is enforced mechanically, not by
//     prompt obedience.
//   - Ownership is claimed atomically for the duration of a worker run;
//     two concurrent workers claiming the same path = instant refusal, so
//     parallel writers can never race on a file.
//   - Workers have NO shell and NO network — writing code is their whole
//     job. The lead runs builds/tests after integration (two parallel npm
//     runs would collide anyway).
//   - No recursion: a worker's registry contains neither `task` nor `worker`.

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LlmGateway, ProviderName } from "@gear/llm-gateway";
import {
  ToolRegistry,
  registerBuiltinTools,
  type ToolCallInput,
  type ToolCallOutput,
  type ToolHandler,
  type ToolSchema,
} from "@gear/tool-registry";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck, ToolResultProcessor } from "./agent-loop";

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_TOKENS = 12_000;
const MAX_OWNED_FILES = 32;

/** Read tools a worker keeps from the builtin set (bash/web/network excluded). */
const WORKER_READ_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "symbol_search",
  "ast_query",
]);
const WORKER_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

export interface WorkerDeps {
  /** Path to the gear-tools binary (worker registries are built per run). */
  binaryPath: string;
  /**
   * Live resolver for gateway/model/provider at execute time. Workers do real
   * implementation, so the engine routes them to the STANDARD tier (the main
   * loop's model), not the light tier used by read-only scouts.
   */
  resolve: () => { gateway: LlmGateway; model: string; provider: ProviderName };
  maxTurns?: number;
  maxTokens?: number;
  /** Same prompt-injection probe used by the lead agent. */
  toolResultProcessor?: ToolResultProcessor;
}

export const WORKER_TOOL_SCHEMA: ToolSchema = {
  name: "worker",
  version: "0.1.0",
  description:
    "Delegate a self-contained IMPLEMENTATION task to a write-capable worker sub-agent. " +
    "The worker may create/edit ONLY the files listed in `files` (its exclusive ownership) — " +
    "it reads anything, writes only what it owns, and has no shell/network. " +
    "To parallelize a build, issue SEVERAL worker calls in ONE response with DISJOINT files — " +
    "they run concurrently; overlapping ownership is refused. Give each worker a complete " +
    "contract: what to build, exact interfaces/exports it must expose, and how its piece fits. " +
    "You remain the integrator: after workers return, read the seams, wire up, run checks yourself. " +
    "Returns the worker's report of what it changed.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The implementation contract: what to build, exact interfaces/exports, constraints. Self-contained — the worker sees none of this conversation.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Workspace-relative files (or directories, end with '/') this worker exclusively owns and may create/edit. Keep disjoint from every other concurrent worker.",
      },
      context: {
        type: "string",
        description: "Optional extra context (key file paths to read first, style notes).",
      },
    },
    required: ["prompt", "files"],
  },
  permissionLevel: "confirm",
  category: "execute",
  // Workers are the one execute-category tool that MUST run concurrently —
  // ownership claims make parallel writers safe by construction.
  parallelSafe: true,
};

// ── Ownership ──

/** Normalize an ownership entry to an absolute path inside the workspace. */
function normalizeOwned(workspaceRoot: string, entry: string): { abs: string; isDir: boolean } {
  const isDir = entry.endsWith("/");
  const abs = isAbsolute(entry) ? resolve(entry) : resolve(workspaceRoot, entry);
  const root = resolve(workspaceRoot);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`owned path must be inside the workspace: ${entry}`);
  }
  return { abs, isDir };
}

/** A worker's ownership set: exact files plus directory subtrees. */
export class Ownership {
  private files = new Set<string>();
  private dirs: string[] = [];

  constructor(workspaceRoot: string, entries: string[]) {
    for (const e of entries) {
      const { abs, isDir } = normalizeOwned(workspaceRoot, e);
      if (isDir) this.dirs.push(abs + sep);
      else this.files.add(abs);
    }
  }

  /** Whether `path` (resolved against the workspace) is owned. */
  owns(workspaceRoot: string, path: string): boolean {
    const abs = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
    if (this.files.has(abs)) return true;
    return this.dirs.some((d) => abs.startsWith(d));
  }

  /** All claimed keys (exact paths + dir prefixes) for conflict checks. */
  keys(): string[] {
    return [...this.files, ...this.dirs];
  }

  describe(workspaceRoot: string): string {
    const root = resolve(workspaceRoot);
    return this.keys()
      .map((k) => relative(root, k) + (k.endsWith(sep) ? "/" : ""))
      .join(", ");
  }
}

/**
 * Concurrent-claims table shared by all worker calls of one engine: a path
 * (or dir subtree) may belong to at most ONE active worker at a time.
 */
export class OwnershipClaims {
  private active = new Map<string, string>(); // key → workerId

  /** Claim all keys or none. Returns the conflicting key on failure. */
  claim(workerId: string, ownership: Ownership): string | null {
    const keys = ownership.keys();
    for (const key of keys) {
      for (const [held] of this.active) {
        if (this.overlaps(key, held)) return held;
      }
    }
    for (const key of keys) this.active.set(key, workerId);
    return null;
  }

  release(workerId: string): void {
    for (const [key, owner] of [...this.active]) {
      if (owner === workerId) this.active.delete(key);
    }
  }

  /** Two claims overlap if equal, or one is a dir prefix of the other. */
  private overlaps(a: string, b: string): boolean {
    if (a === b) return true;
    const aDir = a.endsWith(sep) ? a : null;
    const bDir = b.endsWith(sep) ? b : null;
    if (aDir && (b.startsWith(aDir) || aDir.startsWith(b + sep) || b + sep === aDir)) return true;
    if (bDir && (a.startsWith(bDir) || bDir.startsWith(a + sep) || a + sep === bDir)) return true;
    return false;
  }
}

// ── Worker registry: reads + ownership-guarded writes, nothing else ──

function withOwnershipGuard(handler: ToolHandler, ownership: Ownership): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const path = typeof input.args.path === "string" ? input.args.path : "";
      if (!path || !ownership.owns(input.workspaceRoot, path)) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error:
            `Ownership violation: this worker may only create/edit [${ownership.describe(input.workspaceRoot)}]. ` +
            `"${path}" is outside your ownership — treat it as read-only reference. ` +
            "If it must change, say so in your final report so the integrator handles it.",
          durationMs: 0,
        };
      }
      return handler.execute(input);
    },
  };
}

/** Build the restricted registry one worker run sees. Exported for tests. */
export function buildWorkerRegistry(binaryPath: string, ownership: Ownership): ToolRegistry {
  const scratch = new ToolRegistry();
  registerBuiltinTools(scratch, binaryPath);
  const registry = new ToolRegistry();
  for (const schema of scratch.list()) {
    const handler = scratch.get(schema.name);
    if (!handler) continue;
    if (WORKER_READ_TOOLS.has(schema.name)) registry.register(handler);
    else if (WORKER_WRITE_TOOLS.has(schema.name)) {
      registry.register(withOwnershipGuard(handler, ownership));
    }
    // everything else (bash, web, background shells, n8n, todo_write) is
    // deliberately absent from a worker's world.
  }
  return registry;
}

/** Allow read + write categories only; the ownership wrapper does the rest. */
export function createWorkerPermissionCheck(registry: ToolRegistry): PermissionCheck {
  return async ({ toolName }) => {
    const handler = registry.get(toolName);
    if (!handler) return { allowed: false, reason: `Unknown tool: ${toolName}` };
    if (handler.schema.category !== "read" && handler.schema.category !== "write") {
      return {
        allowed: false,
        reason: `Workers may only read and write owned files; "${toolName}" is category "${handler.schema.category}"`,
      };
    }
    return { allowed: true };
  };
}

/** Exported for tests: the doctrine every worker carries. */
export function workerSystemPrompt(ownedList: string): string {
  return [
    "You are a Gear implementation worker: a focused engineer executing one contract inside a larger build.",
    `You EXCLUSIVELY own these files (relative to the workspace): ${ownedList}`,
    "Rules:",
    "- Create/edit ONLY the files you own — the harness mechanically refuses everything else. All other files are read-only reference: read them freely to match interfaces and style.",
    "- You have no shell and no network. Verify by re-reading what you wrote; if a write reports syntax errors, fix them before finishing.",
    "- Fulfill the contract COMPLETELY. Follow the surrounding codebase's conventions.",
    "- Finish with a short integrator report: what you changed per file, decisions you made, and anything the lead must wire up, verify, or change in files you don't own.",
    "",
    // The doctrine steers big builds to workers, which made the frontend of
    // every large build the one thing written WITHOUT the interface doctrine.
    // This block is the distilled "Building interfaces" law — without it,
    // worker-built UI is exactly the generated-looking output users report.
    'If any owned file renders UI (HTML/CSS/components), visual quality is part of correctness — the bar is "a senior product designer built this":',
    "- Match the project's existing design system exactly if one exists; otherwise commit to ONE art direction and execute it consistently — never average two styles.",
    "- Structure does the design: a real type scale (one dominant display size, quiet body, 10-11px uppercase letter-spaced labels), a 4/8px spacing grid, ONE accent color on a neutral ground, one corner-radius family, tabular numerals where numbers align.",
    "- Real copy (never lorem ipsum), units on numbers, designed hover/empty/loading states, inline SVG icons (never emoji), no CDNs or web fonts unless the project already uses them.",
    "- Banned slop: purple-blue gradient washes, drop-shadow soup, mixed corner radii, emoji as icons or in headings, 8-color palettes, rainbow charts, centered walls of text, decoration that carries no information.",
  ].join("\n");
}

let workerSeq = 0;

/** Create the `worker` tool. One shared claims table per tool instance (= per engine). */
export function createWorkerTool(deps: WorkerDeps): ToolHandler {
  const claims = new OwnershipClaims();
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    schema: WORKER_TOOL_SCHEMA,

    validate: (args) => {
      if (typeof args.prompt !== "string" || !args.prompt.trim()) {
        return { valid: false, error: "prompt (the implementation contract) is required" };
      }
      if (
        !Array.isArray(args.files) ||
        args.files.length === 0 ||
        args.files.length > MAX_OWNED_FILES ||
        !args.files.every((f) => typeof f === "string" && f.trim())
      ) {
        return {
          valid: false,
          error: `files must be 1-${MAX_OWNED_FILES} non-empty workspace-relative paths (end directories with '/')`,
        };
      }
      if (args.context !== undefined && typeof args.context !== "string") {
        return { valid: false, error: "context must be a string when provided" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const workerId = `w${++workerSeq}`;
      const { prompt, files, context } = input.args as {
        prompt: string;
        files: string[];
        context?: string;
      };

      let ownership: Ownership;
      try {
        ownership = new Ownership(input.workspaceRoot, files);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      // Atomic claim: overlapping ownership with a RUNNING worker is refused
      // instantly — the lead must keep parallel workers disjoint.
      const conflict = claims.claim(workerId, ownership);
      if (conflict) {
        return fail(
          `Ownership conflict: "${conflict}" is already claimed by another active worker. ` +
            "Give concurrent workers disjoint files, or wait for the other worker to finish.",
        );
      }

      try {
        const registry = buildWorkerRegistry(deps.binaryPath, ownership);
        const live = deps.resolve();
        const loop = new AgentLoop(
          {
            model: live.model,
            provider: live.provider,
            maxTokens,
            maxTurns,
            systemPrompt: workerSystemPrompt(ownership.describe(input.workspaceRoot)),
            toolResultProcessor: deps.toolResultProcessor,
          },
          live.gateway,
          registry,
          createWorkerPermissionCheck(registry),
        );

        const fullPrompt = context && context.trim() ? `${context.trim()}\n\n${prompt}` : prompt;

        let report = "";
        let toolCalls = 0;
        const changed = new Set<string>();
        let loopError: string | undefined;

        // Propagate the abort signal: without it Ctrl-C/Esc could not
        // interrupt a running worker — the turn blocked until it finished.
        for await (const event of loop.run(
          fullPrompt,
          input.sessionId,
          input.workspaceRoot,
          input.signal,
        )) {
          if (event.type === "text_delta") report += event.text;
          else if (event.type === "tool_call_end") {
            toolCalls++;
            // Live movement for the parent's status rung — workers used to
            // run completely dark for their whole multi-minute build.
            {
              const p = typeof event.args?.path === "string" ? ` ${event.args.path}` : "";
              input.onProgress?.(`${event.output.toolName}${p}`);
            }
            if (
              event.output?.success &&
              WORKER_WRITE_TOOLS.has(event.output.toolName) &&
              typeof event.args?.path === "string"
            ) {
              changed.add(event.args.path);
            }
          } else if (event.type === "error") loopError = event.error;
          if (event.type === "turn_complete") break;
        }

        const trimmed = report.trim();
        if (!trimmed && changed.size === 0) {
          return fail(
            loopError
              ? `Worker produced nothing (last error: ${loopError})`
              : "Worker produced no changes and no report",
          );
        }

        const summary = `\n\n(worker changed ${changed.size} file${changed.size === 1 ? "" : "s"}${
          changed.size ? `: ${[...changed].join(", ")}` : ""
        } in ${toolCalls} tool call${toolCalls === 1 ? "" : "s"})`;
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: (trimmed || "(no report)") + summary,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      } finally {
        claims.release(workerId);
      }

      function fail(error: string): ToolCallOutput {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error,
          durationMs: Math.round(performance.now() - start),
        };
      }
    },
  };
}
