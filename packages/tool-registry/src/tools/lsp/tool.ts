// ─── The `lsp` tool: compiler-grade code intelligence ───
//
// The regex symbol index answers "what looks like this name"; LSP answers
// "what IS this symbol" — the difference between guessing among shadowed/
// overloaded names and editing the right definition. One tool, four read-only
// actions, so the schema surface stays small.

import { isAbsolute, resolve } from "node:path";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../../types";
import { LspServerManager } from "./manager";

export const LSP_SCHEMA: ToolSchema = {
  name: "lsp",
  version: "0.1.0",
  description:
    "Compiler-grade code intelligence from a real language server (TypeScript/JavaScript, Python, Rust, Go). " +
    "Use instead of grep when you need the TRUTH about a symbol: definition = where it's really defined; " +
    "references = every real usage (not string matches); hover = resolved type/signature/docs; " +
    "diagnostics = the file's current errors and warnings. " +
    "Position the cursor ON the symbol (1-based line/column, e.g. the middle of the identifier). " +
    "First call per language starts the server (a few seconds); if one isn't installed the error names the exact install command.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["definition", "references", "hover", "diagnostics"],
        description: "What to ask the language server",
      },
      file: { type: "string", description: "File path (absolute or workspace-relative)" },
      line: {
        type: "number",
        description: "1-based line of the symbol (required except for diagnostics)",
      },
      column: {
        type: "number",
        description:
          "1-based column within that line, on the symbol (required except for diagnostics)",
      },
    },
    required: ["action", "file"],
  },
  permissionLevel: "auto",
  category: "read",
};

export function createLspHandler(manager: LspServerManager): ToolHandler {
  return {
    schema: LSP_SCHEMA,

    validate: (args) => {
      const action = args.action;
      if (
        action !== "definition" &&
        action !== "references" &&
        action !== "hover" &&
        action !== "diagnostics"
      ) {
        return {
          valid: false,
          error: "action must be definition | references | hover | diagnostics",
        };
      }
      if (typeof args.file !== "string" || !args.file) {
        return { valid: false, error: "file is required and must be a string" };
      }
      if (action !== "diagnostics") {
        if (typeof args.line !== "number" || typeof args.column !== "number") {
          return { valid: false, error: `${action} requires numeric line and column (1-based)` };
        }
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (success: boolean, result: string, error?: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success,
        result,
        error,
        durationMs: Math.round(performance.now() - start),
      });

      try {
        const action = input.args.action as string;
        const rawFile = input.args.file as string;
        const file = isAbsolute(rawFile) ? rawFile : resolve(input.workspaceRoot, rawFile);
        const pos = {
          line: (input.args.line as number) ?? 1,
          column: (input.args.column as number) ?? 1,
        };

        if (action === "diagnostics") {
          const { diagnostics, analyzed } = await manager.diagnostics(file, input.workspaceRoot);
          if (!analyzed) {
            return done(
              true,
              "No diagnostics received yet — the server is still analyzing this file. Retry in a moment for a definitive answer.",
            );
          }
          if (diagnostics.length === 0)
            return done(true, "No errors or warnings — the file is clean.");
          const lines = diagnostics
            .slice(0, 50)
            .map(
              (d) =>
                `${d.severity} ${file}:${d.line}:${d.column} — ${d.message}${d.source ? ` (${d.source})` : ""}`,
            );
          if (diagnostics.length > 50) lines.push(`… and ${diagnostics.length - 50} more`);
          return done(true, lines.join("\n"));
        }

        if (action === "hover") {
          const text = await manager.hover(file, pos, input.workspaceRoot);
          return done(
            true,
            text || "No hover information at that position (is the cursor on a symbol?).",
          );
        }

        const locations =
          action === "definition"
            ? await manager.definition(file, pos, input.workspaceRoot)
            : await manager.references(file, pos, input.workspaceRoot);
        if (locations.length === 0) {
          return done(
            true,
            `No ${action} results at ${file}:${pos.line}:${pos.column}. Make sure line/column point AT the symbol (1-based).`,
          );
        }
        const lines = locations.map(
          (loc) => `${loc.file}:${loc.line}:${loc.column}${loc.preview ? ` — ${loc.preview}` : ""}`,
        );
        return done(true, lines.join("\n"));
      } catch (err) {
        return done(false, "", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
