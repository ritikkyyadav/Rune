// ─── `memory_update` — the agent's own hand on its memory ───
//
// In `auto` mode the person has handed Rune the judgement call: update the
// long-term profile when it is worth updating, and never on a clock. This tool
// is that judgement, made explicit.
//
// Three bounds, all mechanical and all enforced by the engine behind `refresh`:
//
//   1. `auto` only. In `manual` the user's `/memory update` is the only door;
//      in `off` there is no door. The tool is not even registered outside auto,
//      and the handler still fails closed if the mode changed mid-session.
//   2. Once per session. A model that refreshes its profile on every turn is a
//      model spending the user's money on housekeeping.
//   3. The same shrink floor and backup as every other refresh. A refusal comes
//      back as a plain, honest tool result — never as a silent success.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@rune/tool-registry";

export interface MemoryUpdateResult {
  /** True when the profile on disk actually changed. */
  updated: boolean;
  /** Why not, in the words to hand back to the model. */
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface MemoryUpdateToolDeps {
  /**
   * Run the refresh as the AGENT. Returns the same shape the user's
   * `/memory update` returns; the engine owns the mode gate, the once-per-
   * session gate, the shrink floor and the sidecar's `origin: agent`.
   */
  refresh: (sessionId: string, focus?: string) => Promise<MemoryUpdateResult>;
}

export const MEMORY_UPDATE_TOOL_SCHEMA: ToolSchema = {
  name: "memory_update",
  version: "0.1.0",
  description:
    "Refresh Rune's long-term profile of this user from recent sessions. Memory is in auto " +
    "mode, so you decide when this is worth doing: call it when this session taught you " +
    "something durable about how the person works that a future session should already know. " +
    "Do NOT call it for ordinary task facts, for anything the user asked you to forget, or " +
    "more than once — it is allowed once per session. It costs one cheap model call.",
  inputSchema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description:
          "Optional: what the refresh should pay attention to, in one short phrase " +
          '(e.g. "how they want commits written").',
      },
    },
    required: [],
  },
  permissionLevel: "auto",
  category: "write",
};

export function createMemoryUpdateTool(deps: MemoryUpdateToolDeps): ToolHandler {
  return {
    schema: MEMORY_UPDATE_TOOL_SCHEMA,

    validate: (args: Record<string, unknown>) => {
      const focus = args.focus;
      if (focus !== undefined && typeof focus !== "string") {
        return { valid: false, error: "focus must be a string" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (result: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result,
        durationMs: Math.round(performance.now() - start),
      });
      try {
        const focus = typeof input.args.focus === "string" ? input.args.focus.trim() : "";
        const r = await deps.refresh(input.sessionId, focus || undefined);
        if (!r.updated) {
          // A refusal is still a successful call: the model asked a fair
          // question and got a true answer. Failing the call would push it to
          // retry, which is the one thing a once-per-session tool must not invite.
          return done(
            `Memory not updated — ${r.reason ?? "nothing to update"}. Do not call memory_update again this session.`,
          );
        }
        return done(
          `Memory updated (~${r.tokensBefore ?? 0} → ~${r.tokensAfter ?? 0} tokens). ` +
            "The user can see it with /memory and undo it with /memory restore. " +
            "Do not call memory_update again this session.",
        );
      } catch (err) {
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
