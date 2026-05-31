import type { Message, ProviderName, ToolDefinition } from "@alan/llm-gateway";
import { LlmGateway } from "@alan/llm-gateway";
import { ToolRegistry } from "@alan/tool-registry";
import { AgentLoop } from "./agent-loop";
import type { AgentTurnEvent, PermissionCheck } from "./agent-loop";
import type { ContextEngine } from "./context-engine";
import { Planner } from "./planner";
import type { PlannerEvent } from "./planner";
import type { ModelRouting, Plan, Step, StepResult } from "./types";
import type { Verifier } from "./verifier";

// ─── Plan Runner Events ───
// Extends AgentTurnEvent with plan-level events.

export type PlanRunnerEvent =
  | AgentTurnEvent
  | { type: "plan_created"; plan: Plan }
  | { type: "plan_updated"; plan: Plan; reason: string }
  | { type: "step_started"; stepIndex: number; description: string }
  | { type: "step_completed"; stepIndex: number; result: StepResult }
  | { type: "plan_completed"; plan: Plan }
  | { type: "replanning"; failedStep: number; reason: string }
  | { type: "todo_updated"; items: { content: string; status: "pending" | "in_progress" | "completed" }[] };

// ─── Plan Runner Config ───

export interface PlanRunnerConfig {
  routing: ModelRouting;
  maxTokens: number;
  maxTurnsPerStep: number;
  maxStepRetries: number;
  maxReplanAttempts: number;
  systemPrompt: string;
  priorMessages?: Message[];
  contextEngine?: ContextEngine;
  verifier?: Verifier;
}

const DEFAULT_CONFIG: PlanRunnerConfig = {
  routing: {
    planner: "claude-sonnet-4-20250514",
    executor: "claude-sonnet-4-20250514",
    plannerProvider: "anthropic",
    executorProvider: "anthropic",
  },
  maxTokens: 8192,
  maxTurnsPerStep: 20,
  maxStepRetries: 2,
  maxReplanAttempts: 2,
  systemPrompt: "You are Alan, an expert software engineering assistant.",
};

// ─── Step Execution Prompt ───

function buildStepPrompt(step: Step, plan: Plan, priorResults: StepResult[]): string {
  const completedSummary = priorResults
    .map((r, i) => `  Step ${i}: ${r.success ? "OK" : "FAILED"} — ${r.summary}`)
    .join("\n");

  return `You are executing step ${step.index} of a plan.

STEP: ${step.description}
SUCCESS CRITERIA: ${step.successCriteria}
${step.toolsHint.length > 0 ? `SUGGESTED TOOLS: ${step.toolsHint.join(", ")}` : ""}

${completedSummary ? `PRIOR STEPS:\n${completedSummary}\n` : ""}
REMAINING STEPS:
${plan.steps
  .filter((s) => s.status === "pending" && s.index > step.index)
  .map((s) => `  ${s.index}. ${s.description}`)
  .join("\n")}

Execute this step using the available tools. Be focused — only do what this step requires.
When done, provide a brief summary of what you accomplished.`;
}

// ─── Plan Runner ───

export class PlanRunner {
  private config: PlanRunnerConfig;
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private permissionCheck?: PermissionCheck;
  private messages: Message[] = [];

  constructor(
    config: Partial<PlanRunnerConfig>,
    gateway: LlmGateway,
    registry: ToolRegistry,
    permissionCheck?: PermissionCheck,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gateway = gateway;
    this.registry = registry;
    this.permissionCheck = permissionCheck;

    if (this.config.priorMessages) {
      this.messages = [...this.config.priorMessages];
    }
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Run the two-tier agent loop:
   * 1. Planner analyzes the request → direct response OR creates a Plan
   * 2. If Plan → execute each Step via a scoped AgentLoop
   * 3. Handle failures with replanning
   */
  async *run(
    userMessage: string,
    sessionId: string,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PlanRunnerEvent> {
    // Add user message
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userMessage }],
    });

    // ─── Phase 1: Planning ───
    const planner = new Planner(
      {
        model: this.config.routing.planner,
        provider: this.config.routing.plannerProvider as ProviderName,
        maxTokens: this.config.maxTokens,
      },
      this.gateway,
    );

    const tools = this.registry.toLlmTools();
    let plan: Plan | null = null;
    let plannerTextAccum = "";

    for await (const event of planner.analyze(this.messages, tools, this.config.systemPrompt)) {
      switch (event.type) {
        case "text_delta":
          plannerTextAccum += event.text;
          yield { type: "text_delta", text: event.text };
          break;

        case "plan_created":
          plan = event.plan;
          yield { type: "plan_created", plan };
          break;

        case "tool_call":
          // Planner made a regular tool call (exploratory read).
          // Execute it and feed result back to the planner in a follow-up.
          // For simplicity in v1: skip planner tool calls, they'll be
          // handled during step execution.
          break;

        case "done":
          if (!event.hadPlan) {
            // Simple task — the planner responded directly.
            // Record the text as an assistant message.
            if (plannerTextAccum) {
              this.messages.push({
                role: "assistant",
                content: [{ type: "text", text: plannerTextAccum }],
              });
            }
            yield {
              type: "turn_complete",
              stopReason: "end_turn",
              totalTurns: 1,
            };
            return;
          }
          break;
      }
    }

    if (!plan || plan.steps.length === 0) {
      // Planner didn't produce a usable plan
      yield {
        type: "turn_complete",
        stopReason: "end_turn",
        totalTurns: 1,
      };
      return;
    }

    // ─── Phase 2: Step Execution ───
    // After this point, `plan` is guaranteed non-null and may be reassigned on replan.
    let activePlan: Plan = plan;
    let replanAttempts = 0;
    const stepResults: StepResult[] = [];

    while (true) {
      const nextStep = activePlan.steps.find((s) => s.status === "pending");
      if (!nextStep) break; // All steps done

      // Check dependencies
      const depsReady = nextStep.dependsOn.every((depIdx) => {
        const dep = activePlan.steps[depIdx];
        return dep && dep.status === "completed";
      });
      if (!depsReady) {
        // Skip steps with unmet dependencies
        nextStep.status = "skipped";
        stepResults.push({
          success: false,
          summary: "Skipped: unmet dependencies",
          artifacts: [],
          error: "Dependency not met",
        });
        continue;
      }

      nextStep.status = "running";
      yield {
        type: "step_started",
        stepIndex: nextStep.index,
        description: nextStep.description,
      };

      let stepSuccess = false;
      let lastError = "";
      let retries = 0;

      while (retries <= this.config.maxStepRetries && !stepSuccess) {
        // Check for abort before each step attempt
        if (signal?.aborted) {
          yield { type: "turn_complete", stopReason: "aborted", totalTurns: stepResults.length };
          return;
        }

        const result = yield* this.executeStep(
          nextStep,
          activePlan,
          stepResults,
          sessionId,
          workspaceRoot,
          retries > 0 ? lastError : undefined,
          signal,
        );

        if (result.success) {
          stepSuccess = true;
          nextStep.status = "completed";
          nextStep.result = result;
          stepResults.push(result);
          yield { type: "step_completed", stepIndex: nextStep.index, result };
        } else {
          lastError = result.error ?? "Step failed";
          retries++;
          if (retries <= this.config.maxStepRetries) {
            // Retry
            continue;
          }
          // Max retries exceeded — attempt replan
          nextStep.status = "failed";
          nextStep.result = result;
          stepResults.push(result);
          yield { type: "step_completed", stepIndex: nextStep.index, result };
        }
      }

      // If step failed after retries, try replanning
      if (!stepSuccess && replanAttempts < this.config.maxReplanAttempts) {
        replanAttempts++;
        yield {
          type: "replanning",
          failedStep: nextStep.index,
          reason: lastError,
        };

        const revisedPlan: Plan | null = yield* this.doReplan(
          planner,
          activePlan,
          nextStep,
          lastError,
          tools,
        );

        if (revisedPlan) {
          activePlan = revisedPlan;
          yield { type: "plan_updated", plan: revisedPlan, reason: lastError };
          continue;
        }
        // Replan failed — abort
        break;
      }

      if (!stepSuccess) break;
    }

    // ─── Phase 3: Completion ───
    const allDone = activePlan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );
    activePlan.status = allDone ? "completed" : "failed";

    yield { type: "plan_completed", plan: activePlan };
    yield {
      type: "turn_complete",
      stopReason: allDone ? "end_turn" : "max_turns",
      totalTurns: stepResults.length,
    };
  }

  /**
   * Execute a single step using a fresh AgentLoop (the "Executor" model).
   */
  private async *executeStep(
    step: Step,
    plan: Plan,
    priorResults: StepResult[],
    sessionId: string,
    workspaceRoot: string,
    priorError?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentTurnEvent, StepResult> {
    const stepPrompt = buildStepPrompt(step, plan, priorResults);
    const retryNote = priorError
      ? `\n\nPrevious attempt failed: ${priorError}\nPlease try a different approach.`
      : "";

    const executor = new AgentLoop(
      {
        model: this.config.routing.executor,
        provider: this.config.routing.executorProvider as ProviderName,
        maxTokens: this.config.maxTokens,
        maxTurns: this.config.maxTurnsPerStep,
        systemPrompt: stepPrompt,
        contextEngine: this.config.contextEngine,
        verifier: this.config.verifier,
      },
      this.gateway,
      this.registry,
      this.permissionCheck,
    );

    let hadError = false;
    let errorMsg = "";
    let textAccum = "";
    let totalTurns = 0;

    for await (const event of executor.run(
      step.description + retryNote,
      sessionId,
      workspaceRoot,
      signal,
    )) {
      // Forward events to the caller
      yield event;

      switch (event.type) {
        case "text_delta":
          textAccum += event.text;
          break;
        case "error":
          if (!event.recoverable) {
            hadError = true;
            errorMsg = event.error;
          }
          break;
        case "turn_complete":
          totalTurns = event.totalTurns;
          break;
      }
    }

    // Build step result
    const success = !hadError;
    const summary = textAccum.slice(0, 500) || (success ? "Step completed" : errorMsg);

    return {
      success,
      summary,
      artifacts: [],
      error: hadError ? errorMsg : undefined,
    };
  }

  /**
   * Ask the planner to revise the plan after a step failure.
   */
  private async *doReplan(
    planner: Planner,
    currentPlan: Plan,
    failedStep: Step,
    error: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<PlanRunnerEvent, Plan | null, undefined> {
    let newPlan: Plan | null = null as Plan | null;

    for await (const event of planner.replan(
      this.messages,
      currentPlan,
      failedStep,
      error,
      tools,
      this.config.systemPrompt,
    )) {
      switch (event.type) {
        case "text_delta":
          yield { type: "text_delta", text: event.text };
          break;
        case "plan_updated":
          newPlan = event.plan;
          break;
      }
    }

    return newPlan;
  }
}
