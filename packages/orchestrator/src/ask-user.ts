// ─── ask_user Tool ───
//
// Lets the agent ask the user ONE blocking clarification question with short
// answer options — the coding-agent equivalent of Claude Code's
// AskUserQuestion. The tool delegates to a QuestionHandler wired by the
// frontend (classic CLI readline prompt / TUI option picker); headless
// environments leave it unwired and the tool degrades to an instructive error
// so the model proceeds on its best judgment instead of stalling.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@alan/tool-registry";

export interface UserQuestion {
  question: string;
  options: string[];
}

/** Resolves with the user's answer (an option or free text). */
export type QuestionHandler = (q: UserQuestion) => Promise<string>;

export const ASK_USER_SCHEMA: ToolSchema = {
  name: "ask_user",
  version: "0.1.0",
  description:
    "Ask the user ONE clarifying question when you are genuinely blocked on a decision only they can make — ambiguous requirements, a destructive choice, or multiple valid approaches with different trade-offs. Provide 2-6 short answer options (the user can also type a custom answer). Do NOT use this for anything you can resolve by reading the codebase, or to ask permission for routine work.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask. Clear, specific, one decision per call.",
      },
      options: {
        type: "array",
        description: "2-6 short, mutually exclusive answer options.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 6,
      },
    },
    required: ["question", "options"],
  },
  permissionLevel: "auto",
  // "execute" keeps it out of the parallel-safe read pool — a user prompt must
  // never fire while other tools stream output over it.
  category: "execute",
};

export function createAskUserTool(getHandler: () => QuestionHandler | undefined): ToolHandler {
  return {
    schema: ASK_USER_SCHEMA,

    validate: (args) => {
      if (typeof args.question !== "string" || !args.question.trim()) {
        return { valid: false, error: "question is required" };
      }
      if (
        !Array.isArray(args.options) ||
        args.options.length < 2 ||
        args.options.length > 6 ||
        !args.options.every((o) => typeof o === "string" && o.trim())
      ) {
        return { valid: false, error: "options must be 2-6 non-empty strings" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const handler = getHandler();
      const { question, options } = input.args as { question: string; options: string[] };

      if (!handler) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error:
            "No interactive user is available in this environment. Proceed with your best " +
            "judgment, state the assumption you made, and continue.",
          durationMs: Math.round(performance.now() - start),
        };
      }

      try {
        const answer = await handler({ question: question.trim(), options });
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: answer,
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
