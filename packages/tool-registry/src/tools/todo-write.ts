import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof VALID_STATUSES)[number];

interface TodoItem {
  content: string;
  status: TodoStatus;
  kind?: "inspect" | "change" | "verify";
}

/**
 * Normalise a heterogeneous list of todo items into the canonical {@link TodoItem} shape.
 *
 * Returns `{ok:true, items: TodoItem[]}` on success or `{ok:false, error:string}` on failure.
 * The error message always ends with an example JSON payload that satisfies the schema.
 */
export function normalizeTodoItems(
  items: unknown,
): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  const example = '{"items":[{"content":"...","status":"pending"}]}';
  if (!Array.isArray(items)) {
    return { ok: false, error: `items is required and must be an array. Example: ${example}` };
  }
  if (items.length === 0) {
    return { ok: false, error: `items must not be empty. Example: ${example}` };
  }

  const contentSynonyms = ["title", "text", "task", "description", "step"] as const;
  const statusSynonyms: Record<string, TodoStatus> = {
    // completed
    done: "completed",
    complete: "completed",
    finished: "completed",
    // in_progress
    doing: "in_progress",
    "in-progress": "in_progress",
    "in progress": "in_progress",
    active: "in_progress",
    current: "in_progress",
    wip: "in_progress",
    // pending
    todo: "pending",
    open: "pending",
    not_started: "pending",
    "not started": "pending",
  };

  const kindSynonyms: Record<string, "inspect" | "change" | "verify"> = {
    read: "inspect",
    review: "inspect",
    look: "inspect",
    investigate: "inspect",
    implement: "change",
    edit: "change",
    write: "change",
    build: "change",
    fix: "change",
    test: "verify",
    check: "verify",
    validate: "verify",
  };

  const normalized: TodoItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    // ----- string shortcut -----
    if (typeof raw === "string") {
      let str = raw.trim();
      let status: TodoStatus = "pending";
      const checkboxMatch = str.match(/^\[([ xX-])\]\s*(.*)$/);
      if (checkboxMatch) {
        const mark = checkboxMatch[1];
        const rest = checkboxMatch[2];
        if (mark.toLowerCase() === "x") status = "completed";
        else status = "pending";
        str = rest.trim();
      } else if (str.startsWith("- ") || str.startsWith("* ")) {
        str = str.slice(2).trim();
        status = "pending";
      }
      if (!str) {
        return {
          ok: false,
          error: `items[${i}] string after prefix is empty. Example: ${example}`,
        };
      }
      normalized.push({ content: str, status });
      continue;
    }

    // ----- object -----
    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      // content extraction
      let content: unknown = obj.content;
      if (typeof content !== "string" || !content) {
        for (const key of contentSynonyms) {
          const maybe = obj[key];
          if (typeof maybe === "string" && maybe) {
            content = maybe;
            break;
          }
        }
      }
      if (typeof content !== "string" || !content) {
        // likely a read-back shape – special message
        const hasReadBackKeys = ["done_when", "reading", "leave", "touch"].some((k) => k in obj);
        if (hasReadBackKeys) {
          return {
            ok: false,
            error: `items[${i}] appears to be a read-back shape, which is not a valid todo_write payload. Example: ${example}`,
          };
        }
        return { ok: false, error: `items[${i}] missing non-empty content. Example: ${example}` };
      }

      // status extraction & mapping
      let statusRaw = obj.status as unknown;
      let status: TodoStatus = "pending";
      if (typeof statusRaw === "string" && statusRaw) {
        const lower = statusRaw.toLowerCase();
        if (VALID_STATUSES.includes(lower as TodoStatus)) {
          status = lower as TodoStatus;
        } else if (lower in statusSynonyms) {
          status = statusSynonyms[lower];
        } else {
          return {
            ok: false,
            error: `items[${i}].status '${statusRaw}' is invalid. Example: ${example}`,
          };
        }
      }

      // kind mapping (optional, drop unknown)
      let kind: "inspect" | "change" | "verify" | undefined;
      if (typeof obj.kind === "string") {
        const lowerKind = obj.kind.toLowerCase();
        // Preserve canonical kinds (case-insensitive) rather than dropping them.
        if (lowerKind === "inspect" || lowerKind === "change" || lowerKind === "verify") {
          kind = lowerKind as typeof kind;
        } else if (lowerKind in kindSynonyms) {
          kind = kindSynonyms[lowerKind];
        }
      }

      normalized.push({ content: content as string, status, ...(kind ? { kind } : {}) });
      continue;
    }

    // ----- other types -----
    return { ok: false, error: `items[${i}] is a ${typeof raw}. Example: ${example}` };
  }

  return { ok: true, items: normalized };
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
      const { items } = args as { items: unknown };
      const result = normalizeTodoItems(items);
      if (!result.ok) {
        return { valid: false, error: result.error };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const { items: rawItems } = input.args as { items: unknown };
      const norm = normalizeTodoItems(rawItems);
      if (!norm.ok) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: norm.error,
          durationMs: Math.round(performance.now() - start),
        };
      }
      // Validation already ran, but ensure we output canonical form
      const items = norm.items;
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
