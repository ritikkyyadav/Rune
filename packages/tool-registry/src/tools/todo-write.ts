import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof VALID_STATUSES)[number];

interface TodoItem {
  content: string;
  status: TodoStatus;
  kind?: "inspect" | "change" | "verify";
}

export const TODO_WRITE_SCHEMA: ToolSchema = {
  name: "todo_write",
  version: "0.1.0",
  description:
    "Record or replace your plan as a to-do list. This IS the plan: for any task with 3+ steps, " +
    "write the list BEFORE your first file edit, keep exactly one item in_progress, mark items " +
    "completed the moment they are genuinely done, and REWRITE the list whenever the approach " +
    "changes. Set kind to inspect, change, or verify. Implementation steps require actual " +
    "writes; verification steps require a passing check after the latest change. Reading " +
    "a file does not prove implementation. A compound implementation-and-test step needs " +
    "both. Insufficient evidence is reported as unproven; strict mode refuses once. " +
    "The harness may run the project's compile check after writes. The list lives outside the " +
    "conversation and re-shown to you every turn (it survives compaction and resume), and it " +
    "powers the live checklist the user watches. The full list is replaced on each call — " +
    "include every item you want to keep; dropping unfinished steps is noted. Skip it for " +
    "single trivial actions.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The complete to-do list. Replaces any previous list.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Description of the to-do item.",
            },
            kind: {
              type: "string",
              enum: ["inspect", "change", "verify"],
              description:
                "Required effect: inspect code, change implementation, or verify behavior. Clear step wording also establishes the minimum evidence.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status of the item.",
            },
          },
          required: ["content", "status"],
        },
        minItems: 1,
      },
    },
    required: ["items"],
  },
  permissionLevel: "auto",
  category: "read",
};

export function createTodoWriteHandler(): ToolHandler {
  return {
    schema: TODO_WRITE_SCHEMA,

    validate: (args) => {
      if (!Array.isArray(args.items)) {
        return { valid: false, error: "items is required and must be an array" };
      }
      if ((args.items as unknown[]).length === 0) {
        return { valid: false, error: "items must not be empty" };
      }
      for (let i = 0; i < (args.items as unknown[]).length; i++) {
        const item = (args.items as unknown[])[i];
        if (typeof item !== "object" || item === null) {
          return { valid: false, error: `items[${i}] must be an object` };
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.content !== "string" || !obj.content) {
          return {
            valid: false,
            error: `items[${i}].content is required and must be a non-empty string`,
          };
        }
        if (obj.kind !== undefined && !["inspect", "change", "verify"].includes(String(obj.kind)))
          return { valid: false, error: `items[${i}].kind must be inspect, change, or verify` };
        if (!VALID_STATUSES.includes(obj.status as TodoStatus)) {
          return {
            valid: false,
            error: `items[${i}].status must be one of: ${VALID_STATUSES.join(", ")}`,
          };
        }
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const { items } = input.args as { items: TodoItem[] };

      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({ items }),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
