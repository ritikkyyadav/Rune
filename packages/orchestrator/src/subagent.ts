import type { LlmGateway, ProviderName, ReasoningEffort } from "@gear/llm-gateway";
import type { IncidentReporter, ModelTier } from "@gear/shared";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
  ToolRegistry,
  ToolSchema,
} from "@gear/tool-registry";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck, ToolResultProcessor } from "./agent-loop";
import { ContextEngine } from "./context-engine";
import {
  SUBAGENT_RESULT_SCHEMA,
  buildSubagentResult,
  renderTaskResult,
  repairToSchema,
} from "./subagent-result";
import {
  checkBudget,
  describeBreach,
  resolveSubagentBudget,
  type BudgetBreach,
} from "./subagent-budget";
import { CostTracker } from "@gear/llm-gateway";

/**
 * Dependencies the orchestrator must supply when constructing the `task` tool.
 *
 * IMPORTANT — `registry` must be a READ-ONLY tool set that does NOT contain the
 * `task` tool itself. The caller (engine) guarantees this. If the task tool were
 * present in the sub-agent's registry, a sub-agent could spawn further
 * sub-agents, leading to unbounded recursive nesting. The permission gate below
 * additionally denies any tool whose category is not "read", so even a registry
 * that accidentally includes write/execute/network tools cannot be used by a
 * sub-agent — but the caller should still pass a curated read-only registry.
 */
export interface SubagentDeps {
  gateway: LlmGateway;
  registry: ToolRegistry;
  model: string;
  provider: ProviderName;
  maxTokens?: number;
  maxTurns?: number;
  systemPrompt?: string;
  /**
   * Optional live resolver, called at EXECUTE time instead of using the
   * construction-time snapshot above. Lets the engine (a) route sub-agents to
   * the cheap "light" model tier — or the tier the CALL requested via its
   * `tier` argument — and (b) hand over the CURRENT gateway — the engine
   * rebuilds its gateway on every key edit/provider toggle, and a snapshot
   * taken at startup would go stale.
   */
  resolve?: (tier?: ModelTier) => {
    gateway: LlmGateway;
    model: string;
    provider: ProviderName;
    /** Set by mirror/configured orchestration modes: the child's reasoning
     *  ceiling. Absent keeps the historical hard-coded "high". */
    thinkingEffort?: ReasoningEffort;
  };
  /**
   * Default per-call cost and wall-clock ceilings, overriding the per-effort
   * defaults in subagent-budget.ts. A call's own `costCapUsd` / `deadlineMs`
   * arguments override these in turn.
   */
  budgetDefaults?: { costCapUsd?: number; deadlineMs?: number };
  /** Same prompt-injection probe used by the parent agent. */
  toolResultProcessor?: ToolResultProcessor;
  /**
   * The black-box tap. Without it a scout that burned its whole budget on
   * context overflow, or was swapped onto a fallback model mid-run, left no
   * incident anywhere — the child loops were an audit blind spot.
   */
  onIncident?: IncidentReporter;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOKENS = 8192;

/** Per-call budget presets: how much room the investigation gets. */
const EFFORT_PRESETS: Record<string, { maxTurns: number; maxTokens: number }> = {
  quick: { maxTurns: 8, maxTokens: 4096 },
  standard: { maxTurns: DEFAULT_MAX_TURNS, maxTokens: DEFAULT_MAX_TOKENS },
  thorough: { maxTurns: 32, maxTokens: 16_384 },
};
const TIERS = new Set<ModelTier>(["light", "standard", "heavy"]);
const DEFAULT_SYSTEM_PROMPT =
  "You are a focused sub-agent performing a read-only investigation (exploration, " +
  "search, and analysis). You have access only to read-only tools. Gather what you " +
  "need, then produce a single concise final summary of your findings for the agent " +
  "that delegated this task. Do not attempt to modify files or run commands.";

/**
 * The half of the contract the old prompt left implicit — and that nearly half
 * of all `task` calls then failed on.
 *
 * A scout's WRITTEN TEXT is the entire return value. Tool results stay inside
 * the sub-agent; nothing the parent sees comes from them directly. A run that
 * spends its last turn on one more `read_file` therefore returns nothing at
 * all, no matter how much it found. The old prompt said "produce a final
 * summary" without saying that, and without mentioning that the turn budget is
 * finite — so ending on a tool call looked free. It never was.
 */
function budgetContract(maxTurns: number): string {
  return (
    `\n\nYour written summary IS the entire result — the agent that delegated this ` +
    `never sees your tool results, only the text you write at the end. Specifically: ` +
    `only the text you write AFTER YOUR LAST TOOL CALL is returned. Anything you type ` +
    `on the way to a tool call is working narration and is discarded, so do not spread ` +
    `your findings across the run — collect them and write them once, at the end, as a ` +
    `single self-contained report. A turn that ends on a tool call returns NOTHING and ` +
    `wastes the whole investigation.\n` +
    `You have at most ${maxTurns} turns. A [Budget: turn N of ${maxTurns}] line arrives ` +
    `with every request — read it. When two turns remain, stop searching and write up ` +
    `what you have: a partial answer that names what you found and what you did not ` +
    `reach is worth far more than silence. Never end without text.`
  );
}

/** How many tool calls the fallback report lists before eliding. */
const MAX_TRAIL_ENTRIES = 24;

/**
 * The most identifying argument of a tool call, for the progress line and the
 * fallback trail: the path read, the pattern searched, the symbol looked up.
 */
function describeCall(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["path", "pattern", "query", "name", "glob"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const v = value.length > 80 ? `${value.slice(0, 79)}…` : value;
      return ` ${v}`;
    }
  }
  return "";
}

// `partialReport` lived here. It is now `renderTaskResult` in subagent-result.ts,
// driven off the result object instead of reconstructed from loop variables —
// which is what stops the prose and the object from disagreeing.

export const TASK_TOOL_SCHEMA: ToolSchema = {
  name: "task",
  version: "0.1.0",
  description:
    "Delegate a focused, read-only sub-task (exploration/search/analysis) to a " +
    "sub-agent. Returns the sub-agent's final summary. To fan out, issue SEVERAL " +
    "task calls in ONE response — independent investigations run concurrently " +
    "and all summaries come back together. One self-contained question per call.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The task for the sub-agent to perform. Should be a self-contained, " +
          "read-only investigation (e.g. 'find where X is configured').",
      },
      label: {
        type: "string",
        description:
          "A 2-5 word name for this investigation ('map the deploy surface'), shown " +
          "to the user on the live sub-agent panel while it runs.",
      },
      context: {
        type: "string",
        description:
          "Optional additional context to prepend to the prompt (e.g. relevant " +
          "file paths or constraints).",
      },
      tier: {
        type: "string",
        enum: ["light", "standard", "heavy"],
        description:
          "Model tier for this sub-agent. Default 'light' (cheap scout). Use 'standard' " +
          "for analyses needing real reasoning, 'heavy' only when the investigation itself " +
          "is the hard part.",
      },
      effort: {
        type: "string",
        enum: ["quick", "standard", "thorough"],
        description:
          "Budget preset: 'quick' for one-lookup questions, 'standard' (default), " +
          "'thorough' for wide surveys that must visit many files.",
      },
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
    required: ["prompt"],
  },
  // Declared since the first version of ToolSchema and never populated. The
  // parent now knows the SHAPE of what comes back, not just that a string
  // arrives, and the doctrine paragraph that used to describe the shape in
  // prose shrinks to this.
  outputSchema: SUBAGENT_RESULT_SCHEMA,
  permissionLevel: "auto",
  category: "read",
};

/**
 * Build a PermissionCheck that allows ONLY tools whose registry schema category
 * is "read" and denies everything else. A sub-agent can therefore never write,
 * execute, or hit the network — regardless of what the registry exposes.
 *
 * Exported for direct unit testing of the permission gate.
 */
export function createReadOnlyPermissionCheck(registry: ToolRegistry): PermissionCheck {
  return async ({ toolName }) => {
    const handler = registry.get(toolName);
    if (!handler) {
      return { allowed: false, reason: `Unknown tool: ${toolName}` };
    }
    if (handler.schema.category !== "read") {
      return {
        allowed: false,
        reason: `Sub-agent may only use read-only tools; "${toolName}" is category "${handler.schema.category}"`,
      };
    }
    return { allowed: true };
  };
}

/**
 * Create the `task` tool handler. The handler spins up a nested {@link AgentLoop}
 * restricted to read-only tools, runs the delegated prompt to completion, and
 * returns the sub-agent's accumulated final text.
 *
 * The returned handler never throws out of `execute`: any failure is reported as
 * `success: false` with a descriptive error.
 */
export function createSubagentTool(deps: SubagentDeps): ToolHandler {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    schema: TASK_TOOL_SCHEMA,

    validate: (args) => {
      if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
        return { valid: false, error: "prompt is required and must be a non-empty string" };
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
      const { prompt, context, tier, effort } = input.args as {
        prompt: string;
        context?: string;
        tier?: ModelTier;
        effort?: string;
      };

      try {
        const permissionCheck = createReadOnlyPermissionCheck(deps.registry);

        // Live resolution (tier routing + current gateway) when available.
        // A per-call `tier` routes THIS investigation up from the light default.
        const live = deps.resolve?.(tier) ?? {
          gateway: deps.gateway,
          model: deps.model,
          provider: deps.provider,
        };
        const budget = effort ? EFFORT_PRESETS[effort] : { maxTurns, maxTokens };
        // See worker.ts: without a context engine the loop's over-limit
        // recovery is gated off, so a long scout dies on three consecutive
        // errors rather than compacting. Summarizer = this scout's own model,
        // the one id guaranteed not to have rotted (it is serving this loop).
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
            model: live.model,
            provider: live.provider,
            maxTokens: budget.maxTokens,
            maxTurns: budget.maxTurns,
            // The budget is stated in the prompt, not just enforced behind it:
            // a scout that does not know its limit cannot summarize before it.
            systemPrompt: systemPrompt + budgetContract(budget.maxTurns),
            // Mirror/configured orchestration passes the session's reasoning
            // dial through; absent, the child keeps its historical "high".
            ...(live.thinkingEffort ? { thinkingEffort: live.thinkingEffort } : {}),
            toolResultProcessor: deps.toolResultProcessor,
            onIncident: deps.onIncident,
            // Show the clock the contract above tells it to watch.
            turnBudgetNotice: true,
            contextEngine: nestedContext,
          },
          live.gateway,
          deps.registry,
          permissionCheck,
        );

        const fullPrompt =
          context && context.trim().length > 0 ? `${context}\n\n${prompt}` : prompt;

        // The summary is the text written AFTER the last tool call — not the
        // sum of every delta the scout ever emitted.
        //
        // This used to be one `finalText += event.text` across the whole run,
        // with no reset and no separator, so what came back was the scout's
        // entire running commentary glued end to end ("…verify invariants.No
        // tests exist. Now let me look at…"). The parent then read abandoned
        // hypotheses ("Critical issue spotted: …") and their retractions three
        // lines later as findings, and wrote them into the user's report. It
        // was not the model hallucinating; it was faithfully summarizing a
        // stream of consciousness handed to it as an answer.
        //
        // Text before a tool call is narration by construction — the turn
        // continued. Only the trailing block is the scout addressing its
        // parent, which is exactly the contract budgetContract() states.
        let finalText = "";
        let toolCallCount = 0;
        let loopError: string | undefined;
        // The provider/model that actually served this run, when the gateway
        // swapped mid-flight. Sub-agents used to drop `fallback` events on the
        // floor (they hit the `default:` arm), so a scout demoted from the
        // session's frontier model to a free fallback reported its findings in
        // exactly the same voice, with no way for the parent — or the user —
        // to know they came from somewhere else.
        let servedBy: { provider: string; model: string } | null = null;
        let fallbackReason: string | undefined;
        // Why the loop stopped. Previously discarded, which is why running out
        // of turns and genuinely returning nothing were reported identically —
        // all 33 recorded failures carried no cause at all.
        let stopReason = "";
        // Cost and wall clock, checked between turns. Never mid-call: aborting
        // a request already in flight pays for it and loses the reply.
        const budgetCaps = resolveSubagentBudget(effort, {
          costCapUsd: input.args.costCapUsd ?? deps.budgetDefaults?.costCapUsd,
          deadlineMs: input.args.deadlineMs ?? deps.budgetDefaults?.deadlineMs,
        });
        const costTracker = new CostTracker();
        const budgetState = { spentUsd: 0, startedAt: Date.now() };
        let breach: BudgetBreach | null = null;
        // What the scout actually did, kept so an empty summary still returns
        // the ground it covered instead of nothing. Bounded: this rides back
        // into the parent's context.
        const trail: string[] = [];

        // Propagate the abort signal: without it Ctrl-C/Esc could not
        // interrupt a running sub-agent — the turn blocked until it finished.
        for await (const event of loop.run(
          fullPrompt,
          input.sessionId,
          input.workspaceRoot,
          input.signal,
        )) {
          switch (event.type) {
            case "text_delta":
              finalText += event.text;
              break;
            case "stream_reset":
              // The provider abandoned this assistant message mid-flight and
              // is re-streaming it. Anything accumulated for it is about to
              // arrive again — keeping it would duplicate the summary.
              finalText = "";
              break;
            case "fallback":
              servedBy = event.to;
              fallbackReason = event.reason;
              input.onProgress?.(`↯ ${event.to.provider}/${event.to.model}`);
              break;
            case "tool_call_start":
              // Everything written before this call was narration on the way
              // to it, not the report. Drop it: the summary is what follows
              // the LAST tool call.
              //
              // Keyed to the START, not the end: a call the permission gate
              // refuses, the repeated-failure breaker blocks, or the run ends
              // before executing never produces a `tool_call_end` — and the
              // narration ahead of it is narration either way. Keying this to
              // completion let exactly those runs return "And now the routes."
              // as their findings.
              finalText = "";
              break;
            case "tool_call_end": {
              toolCallCount++;
              // Live movement for the parent's status rung — sub-agents used
              // to run completely dark for their whole multi-minute life.
              const p = describeCall(event.args);
              const label = `${event.output.toolName}${p}`;
              input.onProgress?.(label);
              // Deduplicated, order preserved: the parent wants the ground
              // covered, not a transcript. Re-reads are already surfaced as a
              // struggle signal; repeating them here would just spend the
              // parent's context to say the same file eight times.
              if (trail.length < MAX_TRAIL_ENTRIES && !trail.includes(label)) {
                trail.push(label);
              }
              break;
            }
            case "usage":
              // List price, from the provider's own numbers. An unpriced model
              // contributes 0, which means its budget is effectively the
              // deadline — correct, since a price nobody knows cannot be capped.
              budgetState.spentUsd += costTracker.estimate(event.model ?? live.model, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens,
                cacheCreationTokens: event.cacheCreationTokens,
              });
              break;
            case "error":
              // Keep the last error; only fatal (non-recoverable) errors end the run.
              loopError = event.error;
              break;
            case "turn_complete":
              // Sub-agent finished (end_turn, max_turns, aborted, …). Stop consuming.
              stopReason = event.stopReason;
              break;
            default:
              break;
          }
          if (event.type === "turn_complete") break;
          // A budget is a stop, not a failure: the loop ends here and whatever
          // the scout has found so far comes back, exactly as it does on
          // max_turns. The parent is told which budget and by how much, so
          // "re-dispatch with more" is actionable rather than a guess.
          breach = checkBudget(budgetCaps, budgetState);
          if (breach) {
            stopReason = breach.kind === "cost" ? "cost_budget" : "time_budget";
            break;
          }
        }

        const trimmed = finalText.trim();

        // Provenance banner. A scout that finished on a different model than
        // the one it was dispatched to is reporting SECONDHAND from somewhere
        // the caller did not choose — usually a free fallback picked up after
        // the session model hit a plan quota. The parent has no other way to
        // learn this (the swap happens inside a nested loop), and it changes
        // how much the findings are worth, so it leads the result instead of
        // being buried at the end.
        const provenance = servedBy
          ? `[PROVENANCE — this sub-agent did not run on ${live.provider}/${live.model}. ` +
            `The gateway switched it to ${servedBy.provider}/${servedBy.model} mid-run` +
            `${fallbackReason ? ` (${fallbackReason})` : ""}. Treat everything below as ` +
            `UNVERIFIED: re-check any claim before you rely on it or repeat it to the user.]\n\n`
          : "";

        // An empty summary is not an empty investigation.
        //
        // This used to return `success: false, result: ""` — discarding every
        // file the scout read and every search it ran, and reporting a cause
        // it had not bothered to capture. It was ~48% of all `task` calls
        // (33 of 68 in this install's audit log), against 0 of 43 for
        // `worker`. The asymmetry was never the model: worker falls back to
        // its changed-file list when it writes no prose, so its work survives.
        // A read-only scout has no file changes to fall back on — but it does
        // have the ground it covered, which is exactly what the parent needs
        // to either finish the job itself or re-dispatch with more budget.
        if (trimmed.length === 0) {
          // Nothing written AND nothing done: there is genuinely no result.
          // This is the only case that still fails, mirroring worker's
          // `!trimmed && changed.size === 0`.
          if (toolCallCount === 0) {
            return {
              callId: input.callId,
              toolName: input.toolName,
              success: false,
              result: "",
              // The swap belongs on the ERROR path too. A scout that was
              // demoted and then produced nothing is the single most useful
              // place to name the model: it usually means the fallback could
              // not do the job at all, and without this the parent reads a
              // bare "did nothing" and re-dispatches into the same wall.
              error:
                (servedBy ? `[ran on ${servedBy.provider}/${servedBy.model}] ` : "") +
                (loopError
                  ? `Sub-agent did nothing and wrote nothing (last error: ${loopError})`
                  : `Sub-agent did nothing and wrote nothing${stopReason ? ` (stopped: ${stopReason})` : ""}`),
              durationMs: Math.round(performance.now() - start),
            };
          }

          // Partial, but real: the parent can act on this. Failing here is
          // what threw the work away.
          const partial = buildSubagentResult({
            finalText: "",
            toolCallCount,
            stopReason,
            loopError,
            trail,
            servedBy: servedBy ?? undefined,
          });
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: renderTaskResult(partial, {
              maxTurns: budget.maxTurns,
              topBudget: EFFORT_PRESETS.thorough.maxTurns,
              effort,
              dispatched: { provider: live.provider, model: live.model },
              fallbackReason,
            }),
            structured: partial as unknown as Record<string, unknown>,
            durationMs: Math.round(performance.now() - start),
          };
        }

        // The schema, forced — but only when the prose did not already carry
        // it, so a sub-agent that answers in shape costs nothing extra. The
        // repair call is tool-less by construction: a JSON schema on a turn
        // that still offers tools makes providers choose between structured
        // output and tool calling, and they choose differently.
        let result = buildSubagentResult({
          finalText: trimmed,
          toolCallCount,
          stopReason,
          loopError,
          trail,
          servedBy: servedBy ?? undefined,
        });
        if (result.findings.length === 0 && result.unresolved.length === 0) {
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
              // Harness facts still win over anything the repair call says.
              toolCallCount,
              stopReason,
              servedBy: servedBy ?? undefined,
              filesExamined: repaired.filesExamined.length ? repaired.filesExamined : trail,
            };
          }
        }
        // A summary written on the way out of a turn budget is a summary of an
        // investigation that did not finish. Unmarked, it reads to the parent
        // exactly like a complete answer.
        if (stopReason === "max_turns") {
          result.unresolved = [
            `Hit the ${budget.maxTurns}-turn limit, so this covers only what it reached.`,
            ...result.unresolved,
          ];
        } else if (stopReason === "aborted") {
          result.unresolved = ["Aborted before finishing.", ...result.unresolved];
        } else if (breach) {
          result.unresolved = [`The sub-agent ${describeBreach(breach)}.`, ...result.unresolved];
        }

        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: renderTaskResult(result, {
            maxTurns: budget.maxTurns,
            topBudget: EFFORT_PRESETS.thorough.maxTurns,
            effort,
            dispatched: { provider: live.provider, model: live.model },
            fallbackReason,
          }),
          structured: result as unknown as Record<string, unknown>,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        // Never throw out of execute — surface as a failed tool result instead.
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Math.round(performance.now() - start),
        };
      }
    },
  };
}
