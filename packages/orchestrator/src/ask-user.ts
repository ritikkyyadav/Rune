// ─── ask_user Tool ───
//
// Lets the agent ask the user ONE blocking clarification question with short
// answer options — the coding-agent equivalent of Claude Code's
// AskUserQuestion. The tool delegates to a QuestionHandler wired by the
// frontend (classic CLI readline prompt / TUI option picker); headless
// environments leave it unwired and the tool degrades to an instructive error
// so the model proceeds on its best judgment instead of stalling.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@gear/tool-registry";

export interface UserQuestion {
  question: string;
  options: string[];
}

/** Resolves with the user's answer (an option or free text). */
export type QuestionHandler = (q: UserQuestion) => Promise<string>;

export const ASK_USER_SCHEMA: ToolSchema = {
  name: "ask_user",
  version: "0.2.0",
  description:
    "Ask the user clarifying questions when a decision is genuinely theirs to make: ambiguous " +
    "requirements at the START of a non-trivial task (goal, scope, or target unclear and the " +
    "codebase cannot answer it), a destructive choice, or several valid approaches with different " +
    "trade-offs. Prefer ONE call carrying 1-4 questions via the `questions` array — the user " +
    "answers them together, then work proceeds on the answers plus your stated assumptions. " +
    "Each question takes 2-6 short, mutually exclusive options (the user can also type a custom " +
    "answer). Never use this for anything a read of the codebase can resolve, and never to ask " +
    "permission for routine engineering work.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1-4 questions asked in one round (preferred — batch what you need up front).",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Clear, specific, one decision per question.",
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
        minItems: 1,
        maxItems: 4,
      },
      question: {
        type: "string",
        description: "Single-question form: the question to ask.",
      },
      options: {
        type: "array",
        description: "Single-question form: 2-6 short answer options.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 6,
      },
    },
  },
  permissionLevel: "auto",
  // "execute" keeps it out of the parallel-safe read pool — a user prompt must
  // never fire while other tools stream output over it.
  category: "execute",
};

/** Accept both wire shapes; reject anything that isn't 1-4 valid questions. */
function normalizeQuestions(args: Record<string, unknown>): UserQuestion[] | { error: string } {
  const validOne = (q: unknown): q is UserQuestion => {
    const c = q as { question?: unknown; options?: unknown };
    return (
      typeof c?.question === "string" &&
      c.question.trim().length > 0 &&
      Array.isArray(c.options) &&
      c.options.length >= 2 &&
      c.options.length <= 6 &&
      c.options.every((o) => typeof o === "string" && o.trim())
    );
  };
  if (Array.isArray(args.questions)) {
    if (args.questions.length < 1 || args.questions.length > 4) {
      return { error: "questions must contain 1-4 entries" };
    }
    if (!args.questions.every(validOne)) {
      return { error: "each question needs text and 2-6 non-empty options" };
    }
    return (args.questions as UserQuestion[]).map((q) => ({
      question: q.question.trim(),
      options: q.options,
    }));
  }
  if (validOne(args)) {
    return [{ question: (args.question as string).trim(), options: args.options as string[] }];
  }
  return {
    error:
      "provide either `questions` (1-4 of {question, options}) or a single `question` with `options` (2-6 strings)",
  };
}

export function createAskUserTool(getHandler: () => QuestionHandler | undefined): ToolHandler {
  return {
    schema: ASK_USER_SCHEMA,

    validate: (args) => {
      const normalized = normalizeQuestions(args);
      if ("error" in normalized && !Array.isArray(normalized)) {
        return { valid: false, error: normalized.error };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const handler = getHandler();
      const normalized = normalizeQuestions(input.args);
      if (!Array.isArray(normalized)) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: normalized.error,
          durationMs: Math.round(performance.now() - start),
        };
      }

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
        // One round, N questions: the picker runs per question in order. A
        // single question returns the raw answer (legacy contract); several
        // return labeled Q→A lines so the model sees which answer is whose.
        const answers: string[] = [];
        for (const q of normalized) {
          answers.push(await handler(q));
        }
        const result =
          normalized.length === 1
            ? answers[0]
            : normalized.map((q, i) => `Q: ${q.question}\nA: ${answers[i]}`).join("\n\n");
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result,
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
