// ─── Post-edit LSP auto-feedback (opt-in) ───
//
// The syntax pass (diagnostics.ts) catches broken parses in the same turn;
// this closes the remaining gap to OpenCode's edge: SEMANTIC errors (wrong
// types, bad imports) surfacing in the edit's own tool result instead of
// three turns later when the verifier runs. Pull-only `lsp diagnostics`
// already exists — this wires it into the write path automatically.
//
// Guards, because language servers are heavyweight where edits are hot:
//  - opt-in: `[lsp] autoFeedback = true` (default OFF until eval-proven);
//  - hard budget per edit (1.5s): the manager's readiness gate may lawfully
//    wait 10s on a cold server — fine for the on-demand tool, unacceptable
//    per edit. On timeout the edit result ships without the field while the
//    server keeps warming in the background, so the NEXT edit is fast;
//  - errors only (severity "error"), never hints/warnings — feedback noise
//    trains the model to ignore the channel;
//  - strictly best-effort: no LSP outcome ever fails a successful write.

import { isAbsolute, resolve } from "node:path";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../../types";
import type { LspServerManager } from "./manager";

let autoFeedback = false;

export function setLspAutoFeedback(on: boolean): void {
  autoFeedback = on;
}

export function isLspAutoFeedbackEnabled(): boolean {
  return autoFeedback;
}

const FEEDBACK_BUDGET_MS = 1500;
const MAX_ERRORS = 5;

function formatLspErrors(errors: Array<{ line: number; column: number; message: string }>): string {
  const shown = errors.slice(0, MAX_ERRORS);
  const more = errors.length > shown.length ? ` (+${errors.length - shown.length} more)` : "";
  return (
    `TYPE/SEMANTIC ERRORS (language server)${more}: ` +
    shown
      .map((e) => `line ${e.line}: ${e.message}`)
      .join("; ")
      .slice(0, 600)
  );
}

/**
 * Wrap a write tool so a successful edit to an LSP-supported file appends an
 * `lsp_check` field to its JSON result when the language server reports
 * errors. Shares the ONE registered manager — never spawns a parallel set of
 * servers.
 */
export function withLspFeedback(handler: ToolHandler, manager: LspServerManager): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const output = await handler.execute(input);
      if (!autoFeedback || !output.success || !output.result) return output;

      const rel = typeof input.args.path === "string" ? input.args.path : "";
      if (!rel) return output;
      const abs = isAbsolute(rel) ? rel : resolve(input.workspaceRoot, rel);
      if (!manager.specFor(abs)) return output;

      try {
        const raced = await Promise.race([
          manager.diagnostics(abs, input.workspaceRoot),
          new Promise<null>((r) => {
            const t = setTimeout(() => r(null), FEEDBACK_BUDGET_MS);
            // Never let the budget timer hold the process open.
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
        if (!raced || !raced.analyzed) return output; // cold server / timeout — syntax pass stands
        const errors = raced.diagnostics.filter((d) => d.severity === "error");
        if (errors.length === 0) return output;

        let result: Record<string, unknown>;
        try {
          result = JSON.parse(output.result) as Record<string, unknown>;
        } catch {
          return output; // non-JSON result — leave untouched
        }
        result.lsp_check = formatLspErrors(errors);
        return { ...output, result: JSON.stringify(result) };
      } catch {
        return output; // missing server, dead conn, anything — best-effort only
      }
    },
  };
}
