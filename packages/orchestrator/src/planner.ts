import type {
  ContentBlock,
  InferenceRequest,
  Message,
  ProviderName,
  StreamEvent,
  ToolDefinition,
} from "@alan/llm-gateway";
import { LlmGateway } from "@alan/llm-gateway";
import { parseToolArguments } from "@alan/shared";
import type { Plan, Step } from "./types";

// ─── Plan Tool Definitions ───

const CREATE_PLAN_TOOL: ToolDefinition = {
  name: "create_plan",
  description: `Create a structured execution plan for a complex multi-step task.
Use this for tasks requiring multiple distinct operations (multi-file edits, debugging, refactoring, new features).
Do NOT use for simple questions or single-step tasks — just respond directly.
Each step must be atomic with clear success criteria.`,
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Concrete description of what this step does",
            },
            tools_hint: {
              type: "array",
              items: { type: "string" },
              description: "Tools this step will likely use (read_file, edit_file, bash, etc.)",
            },
            success_criteria: {
              type: "string",
              description: "How to verify this step succeeded",
            },
            depends_on: {
              type: "array",
              items: { type: "integer" },
              description: "Indices of steps that must complete before this one (0-based)",
            },
          },
          required: ["description", "success_criteria"],
        },
        minItems: 1,
      },
    },
    required: ["steps"],
  },
};

const UPDATE_PLAN_TOOL: ToolDefinition = {
  name: "update_plan",
  description:
    "Revise the current execution plan after a step failure or when the approach needs to change.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the plan needs revision" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            tools_hint: { type: "array", items: { type: "string" } },
            success_criteria: { type: "string" },
            depends_on: { type: "array", items: { type: "integer" } },
          },
          required: ["description", "success_criteria"],
        },
      },
    },
    required: ["reason", "steps"],
  },
};

// ─── Planner Events ───

export type PlannerEvent =
  | { type: "text_delta"; text: string }
  | { type: "plan_created"; plan: Plan }
  | { type: "plan_updated"; plan: Plan; reason: string }
  | {
      type: "tool_call";
      toolName: string;
      callId: string;
      args: Record<string, unknown>;
    }
  | { type: "done"; hadPlan: boolean };

// ─── Planner Configuration ───

export interface PlannerConfig {
  model: string;
  provider: ProviderName;
  maxTokens: number;
}

// ─── Planner System Prompt Addendum ───

const PLANNER_ADDENDUM = `

PLANNING INSTRUCTIONS:
For complex tasks requiring 3+ operations (multi-file edits, debugging, refactoring, features):
  Use the create_plan tool FIRST to define an ordered list of concrete steps.
  Each step must have clear success criteria so progress is verifiable.
  Order steps by dependencies — a step can only depend on earlier steps.

For simple tasks (answering questions, reading one file, making one small edit):
  Respond directly. Do NOT create a plan for trivial work.

You may use read-only tools (read_file, list_dir, grep) during planning to gather information
before creating the plan. The plan should reflect what you've learned.`;

// ─── Planner ───

export class Planner {
  private config: PlannerConfig;
  private gateway: LlmGateway;
  private planSequence = 0;

  constructor(config: PlannerConfig, gateway: LlmGateway) {
    this.config = config;
    this.gateway = gateway;
  }

  /**
   * Analyze the user's request and either create a plan or indicate
   * that a direct response is sufficient.
   *
   * Yields text deltas (for streaming) and tool calls (for exploratory reads).
   * The final event is always `done` with `hadPlan` indicating the outcome.
   */
  async *analyze(
    messages: Message[],
    regularTools: ToolDefinition[],
    systemPrompt: string,
  ): AsyncGenerator<PlannerEvent> {
    const tools = [...regularTools, CREATE_PLAN_TOOL];

    const request: InferenceRequest = {
      messages,
      system: systemPrompt + PLANNER_ADDENDUM,
      tools,
      model: this.config.model,
      provider: this.config.provider,
      maxTokens: this.config.maxTokens,
      stream: true,
    };

    const contentBlocks: ContentBlock[] = [];
    const pendingToolCalls: ToolCallAccumulator[] = [];

    for await (const event of this.gateway.inferStream(request)) {
      const delta = accumulateStreamEvent(event, contentBlocks, pendingToolCalls);
      if (delta.text) {
        yield { type: "text_delta", text: delta.text };
      }
    }

    // Check for create_plan tool call
    const planCall = pendingToolCalls.find((tc) => tc.toolName === "create_plan");

    if (planCall) {
      const args = parseToolArguments(planCall.argsJson);
      const plan = this.buildPlan((args.steps as Parameters<typeof this.buildPlan>[0]) ?? []);
      yield { type: "plan_created", plan };
      yield { type: "done", hadPlan: true };
      return;
    }

    // No plan — yield any regular tool calls for the caller to execute
    for (const tc of pendingToolCalls) {
      yield {
        type: "tool_call",
        toolName: tc.toolName,
        callId: tc.callId,
        args: parseToolArguments(tc.argsJson),
      };
    }

    yield { type: "done", hadPlan: false };
  }

  /**
   * Revise an active plan after a step failure.
   */
  async *replan(
    messages: Message[],
    currentPlan: Plan,
    failedStep: Step,
    error: string,
    regularTools: ToolDefinition[],
    systemPrompt: string,
  ): AsyncGenerator<PlannerEvent> {
    const statusSummary = currentPlan.steps
      .map((s) => `  ${s.index}. [${s.status}] ${s.description}`)
      .join("\n");

    const replanMsg: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Step #${failedStep.index} failed: "${failedStep.description}"
Error: ${error}

Current plan status:
${statusSummary}

Use the update_plan tool to create a revised plan that accounts for this failure.`,
        },
      ],
    };

    const tools = [...regularTools, UPDATE_PLAN_TOOL];
    const request: InferenceRequest = {
      messages: [...messages, replanMsg],
      system: systemPrompt + PLANNER_ADDENDUM,
      tools,
      model: this.config.model,
      provider: this.config.provider,
      maxTokens: this.config.maxTokens,
      stream: true,
    };

    const contentBlocks: ContentBlock[] = [];
    const pendingToolCalls: ToolCallAccumulator[] = [];

    for await (const event of this.gateway.inferStream(request)) {
      const delta = accumulateStreamEvent(event, contentBlocks, pendingToolCalls);
      if (delta.text) {
        yield { type: "text_delta", text: delta.text };
      }
    }

    const updateCall = pendingToolCalls.find((tc) => tc.toolName === "update_plan");
    if (updateCall) {
      const args = parseToolArguments(updateCall.argsJson);
      const plan = this.buildPlan((args.steps as Parameters<typeof this.buildPlan>[0]) ?? []);
      yield { type: "plan_updated", plan, reason: (args.reason as string) ?? "" };
    }

    yield { type: "done", hadPlan: !!updateCall };
  }

  private buildPlan(
    rawSteps: Array<{
      description: string;
      tools_hint?: string[];
      success_criteria: string;
      depends_on?: number[];
    }>,
  ): Plan {
    this.planSequence++;
    return {
      id: `plan-${this.planSequence}-${Date.now()}`,
      steps: rawSteps.map((s, i) => ({
        index: i,
        description: s.description,
        toolsHint: s.tools_hint ?? [],
        successCriteria: s.success_criteria,
        status: "pending" as const,
        dependsOn: s.depends_on ?? [],
      })),
      status: "active",
      createdAt: new Date().toISOString(),
    };
  }
}

// ─── Stream Accumulation Helpers ───

interface ToolCallAccumulator {
  callId: string;
  toolName: string;
  argsJson: string;
}

function accumulateStreamEvent(
  event: StreamEvent,
  contentBlocks: ContentBlock[],
  pendingToolCalls: ToolCallAccumulator[],
): { text?: string } {
  switch (event.type) {
    case "content_delta":
      if (event.delta.type === "text_delta") {
        if (contentBlocks.length === 0 || contentBlocks[contentBlocks.length - 1].type !== "text") {
          contentBlocks.push({ type: "text", text: "" });
        }
        const last = contentBlocks[contentBlocks.length - 1];
        if (last.type === "text") last.text += event.delta.text;
        return { text: event.delta.text };
      }
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
      return {};

    case "tool_use_delta": {
      const tc = pendingToolCalls.find((t) => t.callId === event.toolCallId);
      if (tc) tc.argsJson += event.partialJson;
      return {};
    }

    case "tool_use_stop": {
      const block = contentBlocks.find(
        (b) => b.type === "tool_use" && b.toolCallId === event.toolCallId,
      );
      if (block && block.type === "tool_use") {
        block.toolInput = event.toolInput;
      }
      const pending = pendingToolCalls.find((t) => t.callId === event.toolCallId);
      if (pending) pending.argsJson = JSON.stringify(event.toolInput);
      return {};
    }

    default:
      return {};
  }
}
