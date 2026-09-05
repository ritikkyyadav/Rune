import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@rune/tool-registry";

/**
 * `compact_context` — the /compress behaviour as a model-invocable tool, so
 * "compact the conversation" asked in plain chat actually frees context.
 *
 * The tool itself only FLAGS the context engine (requestCompaction): the agent
 * loop performs the actual summarize-and-shrink at the next turn boundary,
 * where it owns the message array and can cut it without splitting a
 * tool_use/tool_result pair. That keeps this tool instant, side-effect-safe to
 * run in parallel, and impossible to corrupt a transcript with.
 */

export interface CompactToolDeps {
  /**
   * Flag the live context engine to force-compact before the next model call;
   * returns the current usage snapshot for the tool's report.
   */
  requestCompaction: () => { used: number; limit: number; percent: number };
}

export const COMPACT_TOOL_SCHEMA: ToolSchema = {
  name: "compact_context",
  version: "0.1.0",
  description:
    "Compact this conversation's context: older turns are summarized into a " +
    "comprehensive summary before your next step, freeing context window while the " +
    "recent exchange stays verbatim. Use when the user asks to compact/compress/free " +
    "up context, or when you need room mid-task (context warnings, very long " +
    "transcripts). The full session history on disk is untouched. Call it at most " +
    "once per turn.",
  inputSchema: { type: "object", properties: {}, required: [] },
  permissionLevel: "auto",
  category: "read",
};

export function createCompactTool(deps: CompactToolDeps): ToolHandler {
  return {
    schema: COMPACT_TOOL_SCHEMA,

    validate: () => ({ valid: true }),

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      try {
        const usage = deps.requestCompaction();
        const snapshot =
          usage.limit > 0 && usage.used > 0
            ? `Context in use before compaction: ~${usage.percent}% (${usage.used}/${usage.limit} tokens).`
            : "Context usage not yet measured this session.";
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result:
            `Compaction scheduled — the older conversation will be summarized and ` +
            `replaced before your next step. ${snapshot} Continue the task; do not ` +
            `call this again this turn.`,
          durationMs: Math.round(performance.now() - start),
        };
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
