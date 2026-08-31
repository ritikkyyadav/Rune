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
  /**
   * Where this question sits in the round, 0-based, and how many there are.
   *
   * A round of four is asked one question at a time, each replacing the last.
   * Without these the person answers four unrelated-looking interruptions and
   * cannot tell after the first whether they are nearly done or have only just
   * started. The frontends render them as `2 of 4`; a frontend that ignores
   * them is unaffected.
   */
  index?: number;
  total?: number;
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
              description:
                "2-6 short, mutually exclusive answer options. Omit for a " +
                "free-form question the user answers in their own words.",
              items: { type: "string" },
              minItems: 2,
              maxItems: 6,
            },
          },
          required: ["question"],
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

/**
 * Whatever the model sent for `options`, as displayable strings.
 *
 * This tool exists to hand a decision to a human, and it used to refuse to do
 * that over a formatting slip: a weak model that wrote a perfectly good
 * question with no options (or options as `{label}` objects) got
 * `Validation failed` back, reworded the question, and got it again — nine
 * times in one observed run, seven minutes of orbit, and the user was never
 * asked anything. A malformed OPTION list is not a reason to withhold the
 * QUESTION. So options are salvaged, not policed: strings pass, labeled
 * objects give up their label, everything unusable drops, and anything past
 * six is cut. What cannot be salvaged degrades to a free-form question — the
 * picker already accepts an answer typed in the user's own words.
 */
function salvageOptions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : [];
  const strings = list
    .map((o) => {
      if (typeof o === "string") return o;
      if (o && typeof o === "object") {
        const c = o as Record<string, unknown>;
        const label = c.label ?? c.option ?? c.text ?? c.value ?? c.answer;
        return typeof label === "string" ? label : "";
      }
      return typeof o === "number" || typeof o === "boolean" ? String(o) : "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
  // One option is not a choice; the free-form field serves that question
  // better than a picker with a single button would.
  return strings.length >= 2 ? strings.slice(0, 6) : [];
}

/** Accept both wire shapes. The QUESTION text is the only hard requirement --
 *  see salvageOptions for why the option list never blocks the ask. */
function normalizeQuestions(args: Record<string, unknown>): UserQuestion[] | { error: string } {
  const salvageOne = (q: unknown): UserQuestion | null => {
    const c = q as { question?: unknown; options?: unknown };
    if (typeof c?.question !== "string" || !c.question.trim()) return null;
    return { question: c.question.trim(), options: salvageOptions(c.options) };
  };
  if (Array.isArray(args.questions)) {
    const salvaged = args.questions.map(salvageOne).filter((q): q is UserQuestion => q !== null);
    if (salvaged.length === 0) {
      return { error: "each question needs non-empty question text" };
    }
    // More than four: the first four are asked rather than none of them.
    return salvaged.slice(0, 4);
  }
  const single = salvageOne(args);
  if (single) return [single];
  return {
    error:
      "provide either `questions` (1-4 of {question, options}) or a single `question` " +
      "(with 2-6 short string `options` when the answer has natural choices)",
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
        for (const [index, q] of normalized.entries()) {
          answers.push(await handler({ ...q, index, total: normalized.length }));
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
