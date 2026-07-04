import type {
  ContentBlock,
  InferenceRequest,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
  StreamOpts,
} from "@alan/llm-gateway";
import {
  LlmGateway,
  providerSupportsNativeSearch,
  providerAllowsGroundingWithTools,
} from "@alan/llm-gateway";
import { parseToolArguments } from "@alan/shared";
import type { ToolCallInput, ToolCallOutput } from "@alan/tool-registry";
import { ToolRegistry } from "@alan/tool-registry";
import type { ContextEngine } from "./context-engine";
import { getMaxOutputTokens } from "./tokenizer";
import type { Verifier } from "./verifier";

// ─── Agent Turn Events (yielded to caller) ───

export type AgentTurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; callId: string; toolName: string }
  | { type: "tool_call_args_delta"; callId: string; partialJson: string }
  | {
      type: "tool_call_end";
      callId: string;
      args: Record<string, unknown>;
      output: ToolCallOutput;
    }
  | { type: "turn_complete"; stopReason: string; totalTurns: number }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "context_warning"; message: string }
  | { type: "notice"; message: string }
  | {
      type: "todo_updated";
      items: { content: string; status: "pending" | "in_progress" | "completed" }[];
    };

// ─── Permission Gate ───
// The agent loop invokes this before executing every tool call.
// Returns whether the tool may proceed. The engine wires this to the
// PermissionBroker and (for confirm-level tools) a CLI/UI prompt.

export interface PermissionCheckArgs {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export type PermissionCheck = (args: PermissionCheckArgs) => Promise<PermissionCheckResult>;

// ─── Agent Configuration ───

export interface AgentLoopConfig {
  model: string;
  provider: ProviderName;
  maxTokens: number;
  maxTurns: number;
  maxConsecutiveErrors: number;
  systemPrompt: string;
  temperature?: number;
  priorMessages?: Message[];
  contextEngine?: ContextEngine;
  /** Runs project checks after edits; on failure the agent is asked to fix. */
  verifier?: Verifier;
  /** Max times to run verification + re-prompt on failure. Default 2. */
  maxVerifyAttempts?: number;
  /** Max independent read-only tool calls to run concurrently. Default 8. */
  maxParallelTools?: number;
  /** Max times to nudge a stuck agent before bailing. Default 1. */
  maxStuckNudges?: number;
  /**
   * Use provider-native web-search grounding (Gemini/Anthropic) instead of the
   * `web_search` function tool when the provider supports it. Default false.
   */
  nativeGrounding?: boolean;
  /**
   * Ask the provider to reason before answering (extended/adaptive thinking).
   * Providers ignore this on models without thinking support. Default true —
   * coding agents benefit heavily from inter-tool-call reasoning.
   */
  thinking?: boolean;
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  maxTokens: 32000,
  maxTurns: 50,
  maxConsecutiveErrors: 3,
  systemPrompt: "You are Alan, an expert software engineering assistant.",
};

// ─── Agent State ───

export type AgentState = "idle" | "thinking" | "tool_calling" | "observing" | "done" | "error";

// ─── Tool-result transcript cap ───
// The Rust bash tool alone can return 512KB (~130k tokens) — one verbose
// command must not be able to consume the whole context window. Results over
// the cap keep their head and tail (errors usually live at one end) with an
// explicit marker so the model knows content was elided and can narrow its
// query instead of trusting a silently-holed transcript.

const TOOL_RESULT_MAX_CHARS = 30_000;
const TOOL_RESULT_HEAD_CHARS = 22_000;
const TOOL_RESULT_TAIL_CHARS = 6_000;

export function truncateForTranscript(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = text.slice(-TOOL_RESULT_TAIL_CHARS);
  const omitted = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
  return (
    `${head}\n\n… [${omitted} characters omitted: output exceeded the transcript budget. ` +
    `Re-run with a narrower pattern, path, offset/limit, or pipe through head/tail if you ` +
    `need the elided middle] …\n\n${tail}`
  );
}

// ─── Agent Loop ───

export class AgentLoop {
  private config: AgentLoopConfig;
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private messages: Message[] = [];
  private state: AgentState = "idle";
  private permissionCheck?: PermissionCheck;

  constructor(
    config: Partial<AgentLoopConfig>,
    gateway: LlmGateway,
    registry: ToolRegistry,
    permissionCheck?: PermissionCheck,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gateway = gateway;
    this.registry = registry;
    this.permissionCheck = permissionCheck;
    if (this.config.priorMessages && this.config.priorMessages.length > 0) {
      this.messages = [...this.config.priorMessages];
    }
  }

  getState(): AgentState {
    return this.state;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  async *run(
    userMessage: string,
    sessionId: string,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentTurnEvent> {
    this.state = "thinking";

    // Add user message
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userMessage }],
    });

    let turn = 0;
    let consecutiveErrors = 0;
    let verifyAttempts = 0;
    let editsSinceVerify = false;
    let stuckNudges = 0;
    let truncationRetries = 0;
    // Execution-evidence gate: when files were written but NOTHING was ever
    // executed to prove they work (no bash run, no project checks), refuse
    // the first attempt to finish and demand verification + an honest report.
    let anyWritesThisRun = false;
    let executedSinceWrite = false;
    let projectChecksPassed = false;
    let executionNudges = 0;
    const recentToolSignatures: string[] = [];
    // Repeated-failure circuit breaker: how many times each EXACT call
    // (tool + args) has failed this run. After 2 identical failures the call is
    // refused without executing — a failing fetch/command retried verbatim will
    // fail the same way, and re-hammering it burns turns and floods the log.
    const failedCalls = new Map<string, number>();
    // Rate-limit recovery: when every provider is throttled, wait out the
    // advertised retry window (bounded) and resume, instead of dying mid-task.
    let rateWaits = 0;

    while (turn < this.config.maxTurns) {
      // Check for abort before starting each turn
      if (signal?.aborted) {
        this.state = "done";
        yield { type: "turn_complete", stopReason: "aborted", totalTurns: turn };
        return;
      }

      turn++;

      // Build inference request
      const allTools = this.registry.toLlmTools();
      // When the provider can search server-side and native grounding is on,
      // ground through the provider instead of advertising the web_search
      // function tool — otherwise the model may search twice.
      //
      // Caveat: Gemini's googleSearch grounding cannot be combined with function
      // tools in one request (the API rejects it: "Built-in tools and Function
      // Calling cannot be combined"). An agent almost always carries other tools
      // (read/write/edit/bash), so for such providers we ground natively only when
      // there are no other tools to advertise; otherwise we keep the universal
      // web_search function tool, which coexists with the rest.
      const hasOtherTools = allTools.some((t) => t.name !== "web_search");
      const useNativeSearch =
        this.config.nativeGrounding === true &&
        providerSupportsNativeSearch(this.config.provider) &&
        (providerAllowsGroundingWithTools(this.config.provider) || !hasOtherTools);
      const tools = useNativeSearch ? allTools.filter((t) => t.name !== "web_search") : allTools;

      // Before building the request, apply context engine if available
      let requestMessages = this.messages;
      let requestSystemPrompt = this.config.systemPrompt;

      if (this.config.contextEngine) {
        const built = this.config.contextEngine.buildPrompt(
          this.config.systemPrompt || "",
          tools.length > 0 ? tools : [],
          this.messages,
        );
        requestMessages = built.messages;
        requestSystemPrompt = built.system;

        // Warn if context is getting full (items were evicted to fit budget)
        if (built.evictedCount > 0) {
          yield {
            type: "context_warning",
            message: `Context budget exceeded: ${built.evictedCount} items evicted, ${built.totalTokens} tokens used`,
          };
        }
      }

      const request: InferenceRequest = {
        messages: requestMessages,
        system: requestSystemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        model: this.config.model,
        provider: this.config.provider,
        // Clamp to the model's per-response output cap — most providers
        // reject requests that ask for more than the model can emit.
        maxTokens: Math.min(this.config.maxTokens, getMaxOutputTokens(this.config.model)),
        temperature: this.config.temperature,
        enableWebSearch: useNativeSearch ? true : undefined,
        thinking: { enabled: this.config.thinking !== false },
        stream: true,
      };

      // Stream inference
      const contentBlocks: ContentBlock[] = [];
      let stopReason = "end_turn";
      let streamErrored = false;
      const pendingToolCalls: Array<{
        callId: string;
        toolName: string;
        argsJson: string;
      }> = [];

      try {
        const streamOpts: StreamOpts = signal ? { signal } : {};
        for await (const event of this.gateway.inferStream(request, streamOpts)) {
          const result = this.processStreamEvent(event, contentBlocks, pendingToolCalls);
          if (result.event) yield result.event;
          if (result.stopReason) stopReason = result.stopReason;
          // Feed REAL token usage back to the context engine so compaction is
          // driven by the provider's authoritative count against the model's
          // actual context window — not a word-count heuristic.
          if (result.usage && this.config.contextEngine) {
            this.config.contextEngine.noteRealUsage(result.usage, this.config.model);
          }
          if (result.error) {
            // Terminal provider failures (bad key, no credits, every provider
            // rate-limited) won't clear by re-running — surface immediately with
            // the gateway's guidance instead of burning maxConsecutiveErrors
            // re-hammering throttled endpoints.
            if (result.retryable === false) {
              // Exception: an all-providers rate limit with a known retry window
              // is TIME-terminal, not task-terminal. Wait it out (bounded, twice
              // per run, abortable) and resume the turn instead of failing the
              // whole task at the finish line.
              const waitSecs = rateLimitWaitSecs(result.error);
              if (waitSecs != null && rateWaits < 2 && !signal?.aborted) {
                rateWaits++;
                yield {
                  type: "notice",
                  message: `All providers rate limited — waiting ${waitSecs}s, then resuming…`,
                };
                await abortableSleep(waitSecs * 1000, signal);
                if (signal?.aborted) {
                  this.state = "done";
                  yield { type: "turn_complete", stopReason: "aborted", totalTurns: turn };
                  return;
                }
                streamErrored = true;
                break;
              }
              this.state = "error";
              yield { type: "error", error: result.error, recoverable: false };
              return;
            }
            consecutiveErrors++;
            yield { type: "error", error: result.error, recoverable: true };
            if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
              this.state = "error";
              yield {
                type: "error",
                error: `Too many consecutive errors (${consecutiveErrors})`,
                recoverable: false,
              };
              return;
            }
            streamErrored = true;
            break;
          }
        }
      } catch (err) {
        // Handle clean abort
        if (signal?.aborted) {
          this.state = "done";
          yield { type: "turn_complete", stopReason: "aborted", totalTurns: turn };
          return;
        }
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: msg, recoverable: true };
        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          this.state = "error";
          yield {
            type: "error",
            error: `Too many consecutive errors (${consecutiveErrors})`,
            recoverable: false,
          };
          return;
        }
        continue;
      }

      // If the stream errored mid-turn (e.g. provider throttle / 5xx after
      // retries), don't treat it as a finished turn — retry instead of
      // silently completing as end_turn with no tool calls. Bounded by
      // maxConsecutiveErrors (checked above) and maxTurns.
      if (streamErrored) {
        continue;
      }

      // Record assistant message
      this.messages.push({ role: "assistant", content: contentBlocks });

      // ── max_tokens: the response was cut off by the output-token limit ──
      // Never execute tool calls from a truncated response: their JSON args
      // may be salvaged-but-wrong (parseToolArguments degrades partial blobs
      // to {}), and running a write/bash with garbage args is destructive.
      // Instead answer any pending calls with an error result (keeps the
      // transcript valid) and ask the model to continue — bounded so a model
      // that maxes out every response can't loop forever.
      if (stopReason === "max_tokens") {
        if (truncationRetries < 2) {
          truncationRetries++;
          if (pendingToolCalls.length > 0) {
            this.messages.push({
              role: "tool",
              content: pendingToolCalls.map(
                (tc): ContentBlock => ({
                  type: "tool_result",
                  toolCallId: tc.callId,
                  toolResultContent:
                    "Not executed: your response hit the output-token limit mid-call, so the " +
                    "arguments may be incomplete. Re-issue this tool call.",
                  isError: true,
                }),
              ),
            });
          } else {
            this.messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Your last response was cut off by the output-token limit. " +
                    "Continue exactly where you left off — do not repeat what you already said.",
                },
              ],
            });
          }
          yield {
            type: "notice",
            message: "Response hit the output-token limit — asking the agent to continue.",
          };
          this.state = "observing";
          continue;
        }
        // Retries exhausted: surface truthfully instead of pretending we finished.
        this.state = "done";
        yield { type: "turn_complete", stopReason: "max_tokens", totalTurns: turn };
        return;
      }

      // If no tool use, we're done — but first, if edits were made, run
      // verification (project checks). On failure, feed the report back and
      // continue so the agent self-corrects. Bounded by maxVerifyAttempts.
      if (stopReason !== "tool_use" || pendingToolCalls.length === 0) {
        if (
          this.config.verifier &&
          editsSinceVerify &&
          verifyAttempts < (this.config.maxVerifyAttempts ?? 2) &&
          !signal?.aborted
        ) {
          verifyAttempts++;
          yield { type: "notice", message: "Verifying changes…" };
          const result = await this.config.verifier.verify(signal);
          editsSinceVerify = false;
          if (result.ran && result.passed) projectChecksPassed = true;
          if (result.ran && !result.passed) {
            this.messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Automated verification failed after your changes. Fix the " +
                    `problems below, then finish.\n\n${result.report}`,
                },
              ],
            });
            yield {
              type: "notice",
              message: "Verification failed — asking the agent to fix it.",
            };
            continue;
          }
        }

        // ── Execution-evidence gate ──
        // The agent wrote files but nothing was ever EXECUTED to prove they
        // work: no bash run since the last write, and no project checks
        // (verifier found nothing to run — common for fresh projects). A
        // model claiming "done" here is guessing. Refuse the finish once and
        // demand verification + an honest report. Deterministic and
        // model-independent — weak models get pushed just as hard as strong
        // ones.
        if (
          anyWritesThisRun &&
          !executedSinceWrite &&
          !projectChecksPassed &&
          executionNudges < 1 &&
          !signal?.aborted
        ) {
          executionNudges++;
          this.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Stop — you created or modified files but never executed anything to prove " +
                  "they work. Before finishing:\n" +
                  "1. Run the code or its tests with bash and read the REAL output.\n" +
                  "2. Fix anything that fails and re-run until it actually works.\n" +
                  "3. Then finish with a short report: what you verified (with actual " +
                  "output), exactly how the user runs/uses what you built, and anything " +
                  "left unverified — stated plainly as untested.\n" +
                  "If execution genuinely isn't possible in this environment, say so " +
                  "explicitly and clearly mark the work as untested.",
              },
            ],
          });
          yield {
            type: "notice",
            message: "No execution evidence — asking the agent to verify its work.",
          };
          this.state = "observing";
          continue;
        }

        // Compact only when context is near budget (avoids a summarization
        // LLM call every turn).
        if (this.config.contextEngine && this.config.contextEngine.shouldCompact()) {
          const r = await this.config.contextEngine.compactWorkingSet(this.messages);
          if (r.compacted) this.messages = r.messages;
        }
        this.state = "done";
        yield { type: "turn_complete", stopReason, totalTurns: turn };
        return;
      }

      // Loop detection: if the same tool batch keeps repeating, first NUDGE the
      // agent to change approach; only bail if it's still stuck after the nudge.
      const signature = pendingToolCalls.map((tc) => `${tc.toolName}:${tc.argsJson}`).join("|");
      recentToolSignatures.push(signature);
      if (recentToolSignatures.length > 10) recentToolSignatures.shift();

      const duplicateCount = recentToolSignatures.filter((s) => s === signature).length;
      if (duplicateCount >= 3) {
        if (stuckNudges < (this.config.maxStuckNudges ?? 1)) {
          stuckNudges++;
          recentToolSignatures.length = 0; // reset the detection window
          // Answer the repeated tool_use blocks (keeps the transcript valid),
          // then nudge the model to reconsider instead of silently bailing.
          this.messages.push({
            role: "tool",
            content: pendingToolCalls.map(
              (tc): ContentBlock => ({
                type: "tool_result",
                toolCallId: tc.callId,
                toolResultContent:
                  "Skipped: this identical call was repeated without progress. " +
                  "Re-read the goal and try a different approach, or finish if the task is already done.",
                isError: true,
              }),
            ),
          });
          yield {
            type: "notice",
            message: "Detected a repeating tool call — nudging the agent to change approach.",
          };
          this.state = "observing";
          continue;
        }
        this.state = "error";
        yield {
          type: "error",
          error:
            "Infinite loop detected: same tool calls repeated without progress, even after a nudge.",
          recoverable: false,
        };
        return;
      }

      // Execute tool calls. Independent read-only (auto-permission) calls run
      // CONCURRENTLY; writes / execute / network and any confirm-gated call run
      // serially so user prompts stay ordered and edits never race. Events and
      // tool_result blocks are emitted in the original call order regardless.
      this.state = "tool_calling";

      if (signal?.aborted) {
        this.state = "done";
        yield { type: "turn_complete", stopReason: "aborted", totalTurns: turn };
        return;
      }

      type PlannedCall = {
        tc: (typeof pendingToolCalls)[number];
        parsedArgs: Record<string, unknown>;
        input: ToolCallInput;
        allowed: boolean;
        parallelSafe: boolean;
        isWrite: boolean;
        callSig: string;
        output?: ToolCallOutput;
      };

      // ── Phase A: permission gates, in order (interactive prompts are serial) ──
      const planned: PlannedCall[] = [];
      for (const tc of pendingToolCalls) {
        // Defense in depth: argsJson is normally a re-stringified object from the provider, but
        // parse defensively so a malformed blob never aborts the turn (degrades to {} args).
        const parsedArgs = parseToolArguments(tc.argsJson);
        const input: ToolCallInput = {
          toolName: tc.toolName,
          callId: tc.callId,
          args: parsedArgs,
          sessionId,
          workspaceRoot,
          signal,
        };

        let allowed = true;
        let denied: ToolCallOutput | undefined;
        if (this.permissionCheck) {
          const decision = await this.permissionCheck({
            callId: tc.callId,
            toolName: tc.toolName,
            args: parsedArgs,
          });
          if (!decision.allowed) {
            allowed = false;
            denied = {
              callId: tc.callId,
              toolName: tc.toolName,
              success: false,
              result: "",
              error: decision.reason ?? "Permission denied",
              durationMs: 0,
            };
          }
        }

        // Circuit breaker: this EXACT call already failed twice this run —
        // refuse it without executing. The refusal is itself an error result,
        // so the model reads WHY and is pushed to change strategy.
        const callSig = `${tc.toolName}:${tc.argsJson}`;
        const priorFails = failedCalls.get(callSig) ?? 0;
        if (allowed && !denied && priorFails >= 2) {
          denied = {
            callId: tc.callId,
            toolName: tc.toolName,
            success: false,
            result: "",
            error:
              `Refused without running: this exact ${tc.toolName} call already failed ` +
              `${priorFails} times this run and will fail again. Do NOT repeat it. ` +
              "Change strategy — different arguments, a different tool, or work around the " +
              "blocker and finish with an honest report of what remains undone.",
            durationMs: 0,
          };
        }

        // Only auto-permission read tools are safe to run concurrently. If the
        // registry doesn't know the tool, default to serial (safe).
        const schema = this.registry.get(tc.toolName)?.schema;
        const parallelSafe =
          allowed && !denied && schema?.category === "read" && schema.permissionLevel === "auto";
        const isWrite = schema?.category === "write";

        planned.push({ tc, parsedArgs, input, allowed, parallelSafe, isWrite, callSig, output: denied });
      }

      // ── Phase B: execute — parallel-safe reads concurrently (bounded), rest serial ──
      const parallel = planned.filter((p) => p.allowed && p.parallelSafe && !p.output);
      await mapWithConcurrency(parallel, this.config.maxParallelTools ?? 8, async (p) => {
        p.output = await this.registry.execute(p.input);
      });
      for (const p of planned) {
        if (!p.allowed || p.output) continue; // denied, or already run in parallel
        p.output = await this.registry.execute(p.input);
      }

      // ── Phase C: emit events + assemble tool_result blocks in original order ──
      const toolResults: ContentBlock[] = [];
      for (const p of planned) {
        const output = p.output!;
        yield {
          type: "tool_call_end",
          callId: p.tc.callId,
          args: p.parsedArgs,
          output,
        };

        // Emit todo_updated when todo_write succeeds
        if (output.success && p.tc.toolName === "todo_write" && output.result) {
          try {
            const parsed = JSON.parse(output.result) as {
              items?: { content: string; status: "pending" | "in_progress" | "completed" }[];
            };
            if (Array.isArray(parsed.items)) {
              yield { type: "todo_updated", items: parsed.items };
            }
          } catch {
            // Non-parsable result — skip todo_updated
          }
        }

        if (!p.allowed) {
          toolResults.push({
            type: "tool_result",
            toolCallId: p.tc.callId,
            toolResultContent: `Permission denied: ${output.error}`,
            isError: true,
          });
          consecutiveErrors++;
        } else {
          toolResults.push({
            type: "tool_result",
            toolCallId: p.tc.callId,
            toolResultContent: truncateForTranscript(
              output.success ? output.result : `Error: ${output.error}`,
            ),
            isError: !output.success,
          });
          consecutiveErrors = output.success ? 0 : consecutiveErrors + 1;
          if (!output.success) {
            failedCalls.set(p.callSig, (failedCalls.get(p.callSig) ?? 0) + 1);
          }
          if (output.success && p.isWrite) {
            editsSinceVerify = true;
            anyWritesThisRun = true;
            executedSinceWrite = false; // new writes need fresh execution evidence
          }
          // Only a real bash run counts as execution evidence — other
          // "execute"-category tools (kill_shell, ask_user) prove nothing.
          if (output.success && p.tc.toolName === "bash") {
            executedSinceWrite = true;
          }
        }
      }

      // Add tool results as user message
      this.messages.push({ role: "tool", content: toolResults });

      // Abort may have fired during tool execution (e.g. a long bash call).
      if (signal?.aborted) {
        this.state = "done";
        yield { type: "turn_complete", stopReason: "aborted", totalTurns: turn };
        return;
      }

      // After processing the assistant response, compact the working set —
      // but only when context is near budget, not every turn.
      if (this.config.contextEngine && this.config.contextEngine.shouldCompact()) {
        const r = await this.config.contextEngine.compactWorkingSet(this.messages);
        if (r.compacted) this.messages = r.messages;
      }

      this.state = "observing";
    }

    // Max turns reached
    this.state = "done";
    yield {
      type: "turn_complete",
      stopReason: "max_turns",
      totalTurns: turn,
    };
  }

  private processStreamEvent(
    event: StreamEvent,
    contentBlocks: ContentBlock[],
    pendingToolCalls: Array<{ callId: string; toolName: string; argsJson: string }>,
  ): {
    event?: AgentTurnEvent;
    stopReason?: string;
    usage?: TokenUsage;
    error?: string;
    retryable?: boolean;
  } {
    switch (event.type) {
      case "content_delta":
        if (event.delta.type === "text_delta") {
          // Ensure we have a text block
          if (
            contentBlocks.length === 0 ||
            contentBlocks[contentBlocks.length - 1].type !== "text"
          ) {
            contentBlocks.push({ type: "text", text: "" });
          }
          const last = contentBlocks[contentBlocks.length - 1];
          if (last.type === "text") {
            last.text += event.delta.text;
          }
          return { event: { type: "text_delta", text: event.delta.text } };
        }
        return {};

      case "thinking_delta":
        // Reasoning / chain-of-thought: forward to the UI (rendered dimmed) but
        // do NOT push into contentBlocks, so it never becomes part of the
        // persisted answer or confuses tool-call detection.
        return { event: { type: "thinking_delta", text: event.text } };

      case "thinking_stop":
        // The COMPLETE thinking block (text + signature) — stored in the
        // assistant message so the provider can replay it verbatim on the
        // next request. Anthropic rejects tool-use continuations whose
        // thinking blocks are missing or modified.
        contentBlocks.push({
          type: "thinking",
          thinking: event.thinking,
          signature: event.signature,
        });
        return {};

      case "redacted_thinking":
        // Opaque block — must round-trip untouched.
        contentBlocks.push({ type: "redacted_thinking", data: event.data });
        return {};

      case "tool_use_start":
        contentBlocks.push({
          type: "tool_use",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolInput: {},
        });
        pendingToolCalls.push({
          callId: event.toolCallId,
          toolName: event.toolName,
          argsJson: "",
        });
        return {
          event: {
            type: "tool_call_start",
            callId: event.toolCallId,
            toolName: event.toolName,
          },
        };

      case "tool_use_delta": {
        const tc = pendingToolCalls.find((t) => t.callId === event.toolCallId);
        if (tc) tc.argsJson += event.partialJson;
        return {
          event: {
            type: "tool_call_args_delta",
            callId: event.toolCallId,
            partialJson: event.partialJson,
          },
        };
      }

      case "tool_use_stop": {
        const block = contentBlocks.find(
          (b) => b.type === "tool_use" && b.toolCallId === event.toolCallId,
        );
        if (block && block.type === "tool_use") {
          block.toolInput = event.toolInput;
        }
        const pending = pendingToolCalls.find((t) => t.callId === event.toolCallId);
        if (pending) {
          pending.argsJson = JSON.stringify(event.toolInput);
        }
        return {};
      }

      case "message_stop":
        return { stopReason: event.stopReason, usage: event.usage };

      case "notice":
        return { event: { type: "notice", message: event.message } };

      case "error":
        return { error: event.error, retryable: event.retryable };

      default:
        return {};
    }
  }
}

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations. Used to
 * bound parallel tool execution (so the model can't, e.g., spawn dozens of
 * sub-agents or file reads at once). Preserves no ordering — callers assemble
 * results in their own order afterward.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const max = Math.max(1, limit);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
}

/**
 * Parse the wait window out of an all-providers-rate-limited error ("… Retry in
 * ~53s …"). Returns clamped seconds, or null when the message isn't a rate
 * limit / has no usable window — those stay terminal.
 */
export function rateLimitWaitSecs(message: string): number | null {
  if (!/rate.?limit/i.test(message)) return null;
  const m = message.match(/retry in ~?(\d+)\s*s/i);
  if (!m) return null;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.min(Math.max(secs + 2, 5), 90); // +2s of slack, bounded to 90s
}

/** Sleep that wakes early on abort (the wait must stay interruptible). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
