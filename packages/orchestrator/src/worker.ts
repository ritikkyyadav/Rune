import {
  DelegatedSessions,
  withDelegatedSessions,
  delegatedHistory,
  bindDelegatedLoop,
  delegatedFallback,
  delegatedWorkerSnapshot,
  retainDelegatedWorker,
} from "./delegated-sessions";
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
//   - Each worker gets its OWN git worktree, seeded from the lead's working
//     tree, so it has a shell: two parallel `npm run`s used to collide in one
//     checkout, which is the only reason the shell was ever withheld. Network
//     stays off, and the shell exists only where the OS sandbox does.
//   - A worker runs the project's checks on its own slice before merge. A
//     worker whose checks fail keeps its branch and does not merge.
//   - No recursion: a worker's registry contains neither `task` nor `worker`.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LlmGateway, ProviderName, ReasoningEffort } from "@rune/llm-gateway";
import type { IncidentReporter, ModelTier } from "@rune/shared";
import {
  isOsIsolationAvailable,
  ToolRegistry,
  registerBuiltinTools,
  type ToolCallInput,
  type ToolCallOutput,
  type ToolHandler,
  type ToolSchema,
} from "@rune/tool-registry";
import { AgentLoop } from "./agent-loop";
import {
  SUBAGENT_RESULT_SCHEMA,
  buildSubagentResult,
  renderWorkerResult,
  repairToSchema,
} from "./subagent-result";
import {
  checkBudget,
  describeBreach,
  resolveSubagentBudget,
  type BudgetBreach,
} from "./subagent-budget";
import { CostTracker } from "@rune/llm-gateway";
import {
  createWorkerWorktree,
  mergeWorkerWorktree,
  removeWorkerWorktree,
  runWorktreeChecks,
  saveWorkerChanges,
  restoreWorkerChanges,
  type WorkerWorktree,
} from "./worker-worktree";
import { WorkerSnapshotError } from "./worker-snapshot";
import type { PermissionCheck, ToolResultProcessor } from "./agent-loop";
import { ContextEngine } from "./context-engine";

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_TOKENS = 12_000;
const MAX_OWNED_FILES = 32;

/** Per-call budget presets: how much room one worker's build gets. */
const EFFORT_PRESETS: Record<string, { maxTurns: number; maxTokens: number }> = {
  quick: { maxTurns: 12, maxTokens: 8_000 },
  standard: { maxTurns: DEFAULT_MAX_TURNS, maxTokens: DEFAULT_MAX_TOKENS },
  thorough: { maxTurns: 48, maxTokens: 24_000 },
};
const TIERS = new Set<ModelTier>(["light", "standard", "heavy"]);

/** Read tools a worker keeps from the builtin set (bash/web/network excluded). */
const WORKER_READ_TOOLS = new Set(["read_file", "list_dir", "grep", "glob", "symbol_search"]);
const WORKER_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

export interface WorkerDeps {
  delegatedSessions?: DelegatedSessions;
  /** Path to the rune-tools binary (worker registries are built per run). */
  binaryPath: string;
  /**
   * Live resolver for gateway/model/provider at execute time. Workers do real
   * implementation, so the engine routes them to the STANDARD tier (the main
   * loop's model) by default — a per-call `tier` argument overrides.
   */
  resolve: (tier?: ModelTier) => {
    gateway: LlmGateway;
    model: string;
    provider: ProviderName;
    /** Set by mirror/configured orchestration modes: the child's reasoning
     *  ceiling. Absent keeps the historical hard-coded "high". */
    thinkingEffort?: ReasoningEffort;
  };
  maxTurns?: number;
  maxTokens?: number;
  /** Same prompt-injection probe used by the lead agent. */
  /**
   * Default per-call cost and wall-clock ceilings, overriding the per-effort
   * defaults in subagent-budget.ts. A call's own `costCapUsd` / `deadlineMs`
   * arguments override these in turn.
   */
  budgetDefaults?: { costCapUsd?: number; deadlineMs?: number };
  /**
   * Give each worker its own git worktree, seeded from the lead's WORKING TREE
   * (not from HEAD — the lead's uncommitted work is the context the worker was
   * dispatched to build on). Default true; falls back to the shared tree when
   * the workspace is not a git repository.
   */
  worktrees?: boolean;
  /**
   * The project's own checks, run inside the worker's worktree before merge.
   * Empty means no checks, which the result reports honestly as `not_run`.
   */
  checkCommands?: string[];
  checkTimeoutMs?: number;
  toolResultProcessor?: ToolResultProcessor;
  /** The black-box tap, so a worker's breakers and fallbacks leave a record. */
  onIncident?: IncidentReporter;
  /**
   * Cross-instance ownership (the team bus). Local claims stop THIS engine's
   * workers racing; this hook additionally leases the files repo-wide so a
   * concurrent Rune instance's workers stay off them. `claim` returns ok:false
   * (with the reason) when enforcement is "block" and a live peer holds an
   * overlapping lease; a "warn"-mode conflict returns ok:true with a note the
   * worker's report will carry.
   */
  team?: {
    claim(paths: string[], label: string): { ok: boolean; error?: string; note?: string };
    release(label: string): void;
  };
}

export const WORKER_TOOL_SCHEMA: ToolSchema = {
  name: "worker",
  version: "0.1.0",
  description:
    "Delegate a self-contained IMPLEMENTATION task to a write-capable worker sub-agent. " +
    "The worker may create/edit ONLY the files listed in `files` (its exclusive ownership) — " +
    "it reads anything, writes only what it owns, runs the project's checks in its OWN git " +
    "worktree, and has no network. " +
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
      label: {
        type: "string",
        description:
          "A 2-5 word name for this piece ('build the settings page'), shown to the " +
          "user on the live sub-agent panel while the worker runs.",
      },
      context: {
        type: "string",
        description: "Optional extra context (key file paths to read first, style notes).",
      },
      tier: {
        type: "string",
        enum: ["light", "standard", "heavy"],
        description:
          "Model tier for this worker. Default 'standard' (the main loop's weight). Use " +
          "'light' for mechanical boilerplate, 'heavy' for the genuinely hard pieces.",
      },
      effort: {
        type: "string",
        enum: ["quick", "standard", "thorough"],
        description:
          "Budget preset: 'quick' for small contained edits, 'standard' (default), " +
          "'thorough' for large multi-file pieces.",
      },
      costCapUsd: {
        type: "number",
        description:
          "Optional list-price ceiling in USD for this sub-agent's own inference. It STOPS " +
          "and returns what it has when exceeded — a budget never destroys work. Defaults " +
          "come from `effort`.",
      },
      deadlineMs: {
        type: "number",
        description:
          "Optional wall-clock ceiling in milliseconds from dispatch. Same stop-and-return " +
          "behaviour as costCapUsd. Defaults come from `effort`.",
      },
    },
    required: ["prompt", "files"],
  },
  // Declared since the first version of ToolSchema and never populated. The
  // parent now knows the SHAPE of what comes back, not just that a string
  // arrives, and the doctrine paragraph that used to describe the shape in
  // prose shrinks to this.
  outputSchema: SUBAGENT_RESULT_SCHEMA,
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

// ── Worker registry: reads, ownership-guarded writes, and a confined shell ──

/**
 * The worker's shell, pinned to its own worktree with the network off.
 *
 * Three properties, and none of them is asked for in a prompt.
 *
 * The cwd is the worker's worktree: the tool receives `workspaceRoot`, and the
 * caller has already set that to the worktree path, so a command cannot reach
 * the lead's tree by default.
 *
 * `network` is forced false. A worker that can reach the network can install,
 * publish and exfiltrate, and building a slice of a feature needs none of that.
 *
 * OS isolation is MANDATORY, and it is enforced by not registering this tool at
 * all when the machine cannot provide it (see `buildWorkerRegistry`). That is
 * the difference between a requirement and a preference: the point of giving a
 * worker a shell is that its build cannot touch anything outside its own tree,
 * and a shell without the sandbox does not have that property, so on a machine
 * without isolation a worker goes back to having no shell rather than getting
 * an uncontained one.
 */
function withWorktreeShell(handler: ToolHandler): ToolHandler {
  return {
    schema: {
      ...handler.schema,
      description:
        handler.schema.description +
        " (worker: runs inside this worker's own git worktree, with the network OFF and the " +
        "OS sandbox mandatory — run the project's checks on your slice before you report)",
    },
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> =>
      handler.execute({
        ...input,
        // The model does not get a say in either of these.
        args: { ...input.args, network: false },
      }),
  };
}

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
export function buildWorkerRegistry(
  binaryPath: string,
  ownership: Ownership,
  opts: { shell?: boolean } = {},
): ToolRegistry {
  const scratch = new ToolRegistry();
  registerBuiltinTools(scratch, binaryPath);
  const registry = new ToolRegistry();
  for (const schema of scratch.list()) {
    const handler = scratch.get(schema.name);
    if (!handler) continue;
    if (WORKER_READ_TOOLS.has(schema.name)) registry.register(handler);
    else if (WORKER_WRITE_TOOLS.has(schema.name)) {
      registry.register(withOwnershipGuard(handler, ownership));
    } else if (opts.shell && schema.name === "bash" && isOsIsolationAvailable()) {
      // A worker gets a shell only when it has a worktree of its own, and the
      // shell is confined to it. The reason `bash` was absent was never that
      // running commands is dangerous — the OS sandbox already handles that —
      // it was that two parallel builds in ONE tree collide on node_modules,
      // dist/ and every other unowned artifact. With a worktree per worker
      // that collision cannot happen, so the tool comes back.
      //
      // Network stays off and OS isolation stays mandatory: a worker that can
      // reach the network can install, publish and exfiltrate, and nothing
      // about building a slice of a feature needs that.
      registry.register(withWorktreeShell(handler));
    }
    // everything else (web, background shells, n8n, todo_write) is
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
    "You are a Rune implementation worker: a focused engineer executing one contract inside a larger build.",
    `You EXCLUSIVELY own these files (relative to the workspace): ${ownedList}`,
    "Rules:",
    "- Create/edit ONLY the files you own — the harness mechanically refuses everything else. All other files are read-only reference: read them freely to match interfaces and style.",
    "- You work in your OWN git worktree, seeded from the lead's current tree. Nothing you do here touches anyone else's checkout until your slice merges back.",
    "- You have a shell, confined to that worktree with the network OFF. RUN THE PROJECT'S CHECKS on your slice before you finish — a compile error you could have caught is the one thing the lead cannot fix without redoing your work.",
    "- If your checks fail and you cannot fix them, say so plainly. Your branch is kept for inspection and your changes are NOT merged, which is the right outcome: merging code that does not compile turns your failure into everyone's.",
    "- Fulfill the contract COMPLETELY. Follow the surrounding codebase's conventions.",
    "- Finish with a short integrator report: what you changed per file, decisions you made, and anything the lead must wire up, verify, or change in files you don't own.",
    "- Only the text you write AFTER YOUR LAST TOOL CALL is returned to the lead — anything typed on the way to a tool call is working narration and is discarded. Write the report once, at the end, self-contained. A turn that ends on a tool call returns no report at all.",
    "- A [Budget: turn N of M] line arrives with every request. When two turns remain, stop building and write the report on what you have, naming what is unfinished.",
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

  return withDelegatedSessions(
    {
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
        if (args.tier !== undefined && !TIERS.has(args.tier as ModelTier)) {
          return { valid: false, error: "tier must be one of: light, standard, heavy" };
        }
        if (
          args.effort !== undefined &&
          !(typeof args.effort === "string" && args.effort in EFFORT_PRESETS)
        ) {
          return { valid: false, error: "effort must be one of: quick, standard, thorough" };
        }
        return { valid: true };
      },

      execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
        const start = performance.now();
        let returned: ToolCallOutput | undefined;
        const workerId = `w${++workerSeq}`;
        const { prompt, files, context, tier, effort } = input.args as {
          prompt: string;
          files: string[];
          context?: string;
          tier?: ModelTier;
          effort?: string;
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

        // Repo-wide lease: make this worker's ownership visible to (and safe
        // from) OTHER Rune instances working in the same repository.
        let teamNote = "";
        let teamClaimed = false;
        // Visible to the finally block, which owns worktree teardown. The
        // branch is kept only when the work did NOT land — a failed check or a
        // conflicted merge — because then the branch is the only copy of it.
        let keepBranch = false;
        if (deps.team) {
          const lease = deps.team.claim(files, workerId);
          if (!lease.ok) {
            claims.release(workerId);
            return fail(lease.error ?? "Files are leased by another Rune instance.");
          }
          teamClaimed = true;
          if (lease.note) teamNote = lease.note;
        }

        // The worker's own filesystem. Created AFTER the ownership claim (so a
        // refused worker never makes one) and BEFORE the registry (so the shell
        // knows whether it exists). Null means the workspace is not a git
        // repository, and the worker falls back to the shared tree exactly as
        // before — losing delegation because a directory is not a repo would be
        // far worse than losing isolation.
        let worktree: WorkerWorktree | null = null;
        // Why the worker has no checkout of its own, when it has none. Carried
        // into the result so the lead knows the manifest was written in the
        // shared tree and nothing in it was compiled.
        let isolationNote: string | undefined;
        const previousWorker = delegatedWorkerSnapshot();
        let restoredPrevious = !previousWorker;
        try {
          if (deps.worktrees !== false) {
            try {
              worktree = createWorkerWorktree(input.workspaceRoot, workerId);
            } catch (error) {
              // A snapshot that would be PARTIAL is refused outright: stale code
              // under a green report is worse than no worker. A checkout that
              // cannot be CREATED falls back to the shared tree, which has every
              // file — losing delegation because `git worktree` failed would be
              // far worse than losing isolation.
              if (error instanceof WorkerSnapshotError) throw error;
              isolationNote =
                `[ISOLATION UNAVAILABLE — ${error instanceof Error ? error.message : String(error)} ` +
                "This worker ran in the shared tree without a shell, so nothing below was compiled or tested.]";
            }
          }
          keepBranch = Boolean(worktree);
          if (previousWorker?.recoveryPath && worktree) {
            const retained = {
              path: previousWorker.recoveryPath,
              branch: previousWorker.branch,
              baseCommit: previousWorker.baseCommit,
              seededFromWorkingTree: true,
            };
            saveWorkerChanges(retained, files, prompt);
            removeWorkerWorktree(input.workspaceRoot, retained, true);
          }
          const restoredPaths =
            previousWorker && worktree ? restoreWorkerChanges(worktree, previousWorker, files) : [];
          if (previousWorker && !worktree)
            throw new Error(
              "This task_id has retained work in a Git branch; restore Git isolation before resuming it.",
            );
          restoredPrevious = true;
          const workRoot = worktree?.path ?? input.workspaceRoot;
          // Ownership is re-expressed against the worktree: the guard compares
          // resolved paths, and the worker writes inside its own checkout.
          const workOwnership = worktree ? new Ownership(workRoot, files) : ownership;
          const registry = buildWorkerRegistry(deps.binaryPath, workOwnership, {
            shell: Boolean(worktree),
          });
          const live = deps.resolve(tier);
          const budget = effort ? EFFORT_PRESETS[effort] : { maxTurns, maxTokens };
          // Nested loops used to run with NO context engine, which meant the
          // over-limit recovery in agent-loop.ts was gated off for them
          // (`isContextOverflowError(...) && this.config.contextEngine`): a
          // worker whose transcript outgrew the window died at three consecutive
          // errors instead of compacting, throwing away a multi-minute build.
          // The summarizer points at the worker's OWN model — the one model
          // guaranteed alive here, because it is serving this loop right now.
          const nestedContext = new ContextEngine(
            { summarizerModel: live.model, summarizerProvider: live.provider },
            live.gateway,
          );
          nestedContext.setSummarizer(live.model, live.provider, {
            model: live.model,
            provider: live.provider,
          });
          const loop = new AgentLoop(
            {
              priorMessages: delegatedHistory(live),
              model: live.model,
              provider: live.provider,
              maxTokens: budget.maxTokens,
              maxTurns: budget.maxTurns,
              // Delegated work is still the user's work, not Rune's overhead:
              // the ledger separates it from `primary` without calling it
              // governance. See llm-gateway/types.ts CallRole.
              callRole: "subagent",
              systemPrompt: workerSystemPrompt(ownership.describe(input.workspaceRoot)),
              // Mirror/configured orchestration passes the session's reasoning
              // dial through; absent, the child keeps its historical "high".
              ...(live.thinkingEffort ? { thinkingEffort: live.thinkingEffort } : {}),
              toolResultProcessor: deps.toolResultProcessor,
              onIncident: deps.onIncident,
              // Workers average four minutes and run to a fixed turn ceiling;
              // like scouts, they were told to budget without being shown a clock.
              turnBudgetNotice: true,
              contextEngine: nestedContext,
            },
            live.gateway,
            registry,
            createWorkerPermissionCheck(registry),
          );

          bindDelegatedLoop(loop);
          const fullPrompt =
            `Current worker workspace: ${workRoot}. Use this checkout for this follow-up; paths from earlier calls may refer to an older snapshot.\n\n` +
            (context && context.trim() ? `${context.trim()}\n\n${prompt}` : prompt);

          // As in subagent.ts: the report is the text written AFTER the last
          // tool call, not every delta of the run concatenated. The old
          // `report += event.text` returned the worker's whole running
          // commentary — half-formed reasoning and its own retractions — to a
          // parent that reads it as a finished account of what was built.
          let report = "";
          let toolCalls = 0;
          const changed = new Set<string>(restoredPaths);
          let loopError: string | undefined;
          let stopReason = "";
          // Same contract as the scout's: checked between turns, and a breach
          // stops the worker and returns what it built rather than discarding it.
          // For a worker that matters more, not less — its output is files.
          const budgetCaps = resolveSubagentBudget(effort, {
            costCapUsd: input.args.costCapUsd ?? deps.budgetDefaults?.costCapUsd,
            deadlineMs: input.args.deadlineMs ?? deps.budgetDefaults?.deadlineMs,
          });
          const costTracker = new CostTracker();
          const budgetState = { spentUsd: 0, startedAt: Date.now() };
          let breach: BudgetBreach | null = null;
          // Filled by P6B.2 when the worker runs its own checks in its worktree,
          // and by P6B.1 when the merge back reports conflicts. `not_run` until
          // then, which is the honest default: a report that does not say whether
          // anything was run reads as though something was.
          let checkOutcome: "passed" | "failed" | "not_run" | undefined;
          let mergeConflicts: string[] = [];
          let mergeFailure: string | undefined;
          let workerBranch: string | undefined;
          // Mid-run model swap (see subagent.ts): `fallback` used to be ignored
          // here too, so a worker demoted to a fallback model reported in the
          // same voice as one that never left the model it was dispatched to.
          let servedBy: { provider: string; model: string } | null = null;
          let fallbackReason: string | undefined;

          // Propagate the abort signal: without it Ctrl-C/Esc could not
          // interrupt a running worker — the turn blocked until it finished.
          // `workRoot` (P6B.1), not `input.workspaceRoot`: a worker given its own
          // git worktree runs inside it, and falls back to the shared tree when
          // it has none.
          for await (const event of loop.run(fullPrompt, input.sessionId, workRoot, input.signal)) {
            // The typed channel (P2.6): the parent gets the worker's real event,
            // and the one-line rung note is projected from it. `onProgress` is
            // still called at the two sites below for surfaces that only take
            // the string — the projection and the legacy note are the same text.
            input.onEvent?.({ agentId: workerId, label: String(prompt ?? "").slice(0, 80), event });
            if (event.type === "text_delta") report += event.text;
            else if (event.type === "stream_reset") report = "";
            else if (event.type === "fallback") {
              servedBy = event.to;
              fallbackReason = event.reason;
              input.onProgress?.(`${workerId} ↯ ${event.to.provider}/${event.to.model}`);
            } else if (event.type === "tool_call_start") {
              // Narration on the way to this call, not the report. Keyed to the
              // START so a refused or never-executed call still ends the block
              // (see subagent.ts).
              report = "";
            } else if (event.type === "tool_call_end") {
              toolCalls++;
              // Live movement for the parent's status rung — workers used to
              // run completely dark for their whole multi-minute build. The
              // worker id keys the note to ONE member of a parallel fleet.
              {
                const p = typeof event.args?.path === "string" ? ` ${event.args.path}` : "";
                input.onProgress?.(`${workerId} ${event.output.toolName}${p}`);
              }
              if (
                event.output?.success &&
                WORKER_WRITE_TOOLS.has(event.output.toolName) &&
                typeof event.args?.path === "string"
              ) {
                changed.add(event.args.path);
              }
            } else if (event.type === "usage") {
              budgetState.spentUsd += costTracker.estimate(event.model ?? live.model, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens,
                cacheCreationTokens: event.cacheCreationTokens,
              });
            } else if (event.type === "error") loopError = event.error;
            else if (event.type === "turn_complete") stopReason = event.stopReason;
            if (event.type === "turn_complete") break;
            breach = checkBudget(budgetCaps, budgetState);
            if (breach) {
              stopReason = breach.kind === "cost" ? "cost_budget" : "time_budget";
              break;
            }
          }

          const trimmed = report.trim();
          if (!trimmed && changed.size === 0) {
            // Name the model on the failure path too: a demoted worker that then
            // built nothing is the clearest signal the fallback could not do the
            // job, and the lead needs that to decide whether to retry or wait.
            const where = servedBy ? `[ran on ${servedBy.provider}/${servedBy.model}] ` : "";
            return fail(
              where +
                (loopError
                  ? `Worker produced nothing (last error: ${loopError})`
                  : "Worker produced no changes and no report"),
            );
          }

          // ── The worker verifies its own slice, in its own tree ──
          //
          // This is the half of the isolation story that pays for the other
          // half. Before it, "NOT VERIFIED: workers have no shell, so nothing
          // here was compiled, run, or tested" was the honest closing line on
          // every worker report, and the lead had to re-derive what broke from
          // files it did not write. Now the worker runs the project's checks
          // where its own changes are, before anything reaches the lead's tree.
          if (worktree && changed.size > 0) {
            const checkResult = await runWorktreeChecks(
              worktree.path,
              deps.checkCommands ?? [],
              deps.checkTimeoutMs ?? 120_000,
              deps.binaryPath,
              input.signal,
            );
            checkOutcome = checkResult.outcome;
            if (checkResult.outcome === "failed") {
              // A failing worker's branch is KEPT and not merged. Merging code
              // that does not compile into the lead's tree turns one worker's
              // failure into everyone's, and the branch is where a person looks.
              mergeConflicts = [];
              workerBranch = worktree.branch;
              keepBranch = true;
              const result = buildSubagentResult({
                finalText: trimmed,
                toolCallCount: toolCalls,
                stopReason,
                loopError,
                trail: [],
                filesChanged: [...changed],
                servedBy: servedBy ?? undefined,
                checks: "failed",
              });
              result.unresolved = [
                ...checkResult.failures.map((f) => `check failed: ${f}`),
                `The worker's branch ${worktree.branch} was kept and NOT merged; its changes are not in your tree.`,
                ...result.unresolved,
              ];
              returned = {
                callId: input.callId,
                toolName: input.toolName,
                success: true,
                result: renderWorkerResult(result, worktree.path, { branch: worktree.branch }),
                structured: { ...result, integration: "retained", branch: worktree.branch },
                durationMs: Math.round(performance.now() - start),
              };
              return returned;
            }
          }

          // ── Merge back, on the owned paths only ──
          if (worktree && changed.size > 0) {
            const merge = mergeWorkerWorktree(input.workspaceRoot, worktree, files, prompt);
            keepBranch = !merge.merged;
            mergeConflicts = merge.conflicts;
            mergeFailure = merge.reason;
            if (!merge.merged) {
              workerBranch = merge.branch;
              keepBranch = true;
            }
            // The manifest is git's diff, not the model's claim. When the merge
            // produced one it replaces the observed set, because a file the
            // worker wrote and then reverted is not a change.
            if (merge.manifest.length > 0) {
              changed.clear();
              for (const path of merge.manifest) changed.add(path);
            }
          }

          if (worktree && changed.size === 0) keepBranch = false;

          // The typed result. `filesChanged`, `toolCallCount` and `stopReason`
          // come from the harness, never from the model — those are exactly the
          // fields a model has an incentive to get wrong, and the manifest that
          // measures them off disk exists because one once claimed a twelve-line
          // "complete FastAPI backend".
          let result = buildSubagentResult({
            finalText: trimmed,
            toolCallCount: toolCalls,
            stopReason,
            loopError,
            trail: [],
            filesChanged: [...changed],
            servedBy: servedBy ?? undefined,
            checks: checkOutcome,
          });
          if (
            !breach &&
            !input.signal?.aborted &&
            result.findings.length === 0 &&
            result.unresolved.length === 0 &&
            trimmed
          ) {
            const repaired = await repairToSchema({
              gateway: live.gateway,
              provider: live.provider as ProviderName,
              model: live.model,
              text: trimmed,
              signal: input.signal,
            });
            if (repaired) {
              result = {
                ...repaired,
                filesChanged: [...changed],
                toolCallCount: toolCalls,
                stopReason,
                servedBy: servedBy ?? undefined,
                checks: checkOutcome ?? repaired.checks,
              };
            }
          }
          if (mergeFailure)
            result.unresolved.unshift(
              `Changes retained because integration failed: ${mergeFailure}`,
            );
          if (breach) {
            result.unresolved = [`The worker ${describeBreach(breach)}.`, ...result.unresolved];
          }
          // A worker that finished on a different model than it was dispatched
          // to WROTE CODE from somewhere the caller did not choose. Louder than
          // the scout's banner for that reason: the parent owns verification.
          const provenance = servedBy
            ? `[PROVENANCE — this worker did not run on ${live.provider}/${live.model}. The ` +
              `gateway switched it to ${servedBy.provider}/${servedBy.model} mid-run` +
              `${fallbackReason ? ` (${fallbackReason})` : ""}. The files below were written ` +
              `by that model: review its diff and run the project's checks yourself before ` +
              `building on it.]\n\n`
            : "";
          // What the worker's own filesystem cost, in the lead's transcript, so
          // the number the audit asked for is measured on every dispatch.
          const provisioning = worktree?.provisioning;
          const isolationLine = provisioning
            ? `[ISOLATION] own checkout: ${provisioning.untrackedFiles} untracked file${provisioning.untrackedFiles === 1 ? "" : "s"} ` +
              `(${Math.round(provisioning.untrackedBytes / 1024)} KB) snapshotted in ${provisioning.snapshotMs} ms` +
              (provisioning.provisioned.length
                ? `; ${provisioning.provisioned.join(", ")} provisioned in ${provisioning.provisionMs} ms`
                : "") +
              ".\n\n"
            : "";
          const prefix =
            provenance +
            (isolationNote ? `${isolationNote}\n\n` : "") +
            isolationLine +
            (teamNote ? `${teamNote}\n\n` : "");
          returned = {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result:
              prefix +
              renderWorkerResult(result, input.workspaceRoot, {
                conflicts: mergeConflicts,
                branch: workerBranch,
              }),
            structured: {
              ...result,
              integration: worktree ? (keepBranch ? "retained" : "merged") : "shared",
              ...(keepBranch && worktree ? { branch: worktree.branch } : {}),
              ...(isolationNote ? { isolationNote } : {}),
              ...(provisioning ? { provisioning } : {}),
            },
            durationMs: Math.round(performance.now() - start),
          };
          return returned;
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        } finally {
          claims.release(workerId);
          if (teamClaimed) deps.team?.release(workerId);
          // The checkout always goes. The BRANCH survives when the work did not
          // land — it is the only copy of a failed or conflicted worker's build,
          // and `rune/worker-<id>` is where a person looks for it.
          if (worktree && !restoredPrevious) {
            // A failed rebase must not replace the only pointer to the older
            // retained work with the new, empty dispatch snapshot.
            retainDelegatedWorker(previousWorker);
            try {
              removeWorkerWorktree(input.workspaceRoot, worktree, false);
            } catch (error) {
              if (returned)
                returned.result += `\nNew unused checkout remains at ${worktree.path}: ${String(error)}`;
            }
          } else if (worktree) {
            let saved = !keepBranch;
            try {
              if (keepBranch) saveWorkerChanges(worktree, files, prompt);
              saved = true;
              retainDelegatedWorker(
                keepBranch && worktree.baseCommit
                  ? { branch: worktree.branch, baseCommit: worktree.baseCommit }
                  : undefined,
              );
              removeWorkerWorktree(input.workspaceRoot, worktree, keepBranch);
            } catch (error) {
              if (!saved && worktree.baseCommit)
                retainDelegatedWorker({
                  branch: worktree.branch,
                  baseCommit: worktree.baseCommit,
                  recoveryPath: worktree.path,
                });
              const warning = `[RECOVERY] ${error instanceof Error ? error.message : String(error)}. The worker checkout is preserved at ${worktree.path}${saved ? "; committed work remains in its branch" : "; its latest changes have not been committed. Resuming this task_id will retry preservation"}.`;
              if (returned) {
                returned.result += `\n\n${warning}`;
                if (!returned.success)
                  returned.error = `${returned.error ?? "Worker failed"}\n${warning}`;
              }
            }
          }
        }

        function fail(error: string): ToolCallOutput {
          returned = {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error,
            durationMs: Math.round(performance.now() - start),
          };
          return returned;
        }
      },
    },
    "worker",
    deps.delegatedSessions,
  );
}

// `buildManifest` lived here. It is now the manifest half of
// `renderWorkerResult` in subagent-result.ts, driven off the result object.
// The measurement is unchanged and is still the point: per-file line counts
// and sizes read back off disk, which the worker cannot inflate.

function humanBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
