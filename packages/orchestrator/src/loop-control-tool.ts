// ─── loop_control tool ───
// Allows an adaptive /loop iteration to choose its next wait or stop itself.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@rune/tool-registry";
import type { LoopControlRequest, LoopControlResult } from "./loop-mode";

export interface LoopControlToolDeps {
  control(sessionId: string, request: LoopControlRequest): LoopControlResult;
}

export const LOOP_CONTROL_SCHEMA: ToolSchema = {
  name: "loop_control",
  version: "0.1.0",
  description:
    "Control the adaptive /loop iteration that is currently running. Call exactly once at the end of an adaptive scheduled turn: stop when its recurring objective is genuinely complete, or continue with a 1-60 minute delay based on current evidence. This tool is unavailable outside an active adaptive loop and must not be used for fixed loops.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["continue", "stop"],
        description: "Whether this adaptive loop should run again or end after this iteration.",
      },
      delayMinutes: {
        type: "number",
        minimum: 1,
        maximum: 60,
        description: "For continue: delay before the next iteration, from 1 to 60 minutes.",
      },
      reason: {
        type: "string",
        description: "Short evidence-based reason for continuing, stopping, or choosing the delay.",
      },
    },
    required: ["action", "reason"],
  },
  permissionLevel: "auto",
  category: "execute",
};

export function createLoopControlTool(deps: LoopControlToolDeps): ToolHandler {
  return {
    schema: LOOP_CONTROL_SCHEMA,
    validate: (args) => {
      if (args.action !== "continue" && args.action !== "stop") {
        return { valid: false, error: "action must be continue or stop" };
      }
      if (typeof args.reason !== "string" || !args.reason.trim()) {
        return { valid: false, error: "reason is required" };
      }
      if (
        args.delayMinutes !== undefined &&
        (typeof args.delayMinutes !== "number" ||
          !Number.isFinite(args.delayMinutes) ||
          args.delayMinutes < 1 ||
          args.delayMinutes > 60)
      ) {
        return { valid: false, error: "delayMinutes must be between 1 and 60" };
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const request = input.args as unknown as LoopControlRequest;
      const result = deps.control(input.sessionId, request);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: result.ok,
        result: result.ok ? result.message : "",
        ...(result.ok ? {} : { error: result.message }),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
