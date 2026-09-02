// ─── Post-edit LSP diagnostics, in the same turn (P10.1) ───
//
// The syntax pass (diagnostics.ts) catches broken parses in the edit's own
// tool result; this closes the remaining gap: SEMANTIC errors — wrong types,
// bad imports, missing members — surfacing in that same result instead of
// three turns later when the verifier runs. Pull-only `lsp diagnostics`
// already existed; this wires it into the write path automatically.
//
// The contract, and why each bound is where it is:
//
//  - ONE block, keyed `diagnostics` in the tool result's JSON, rendered as
//    `file:line:col severity message`, ERRORS BEFORE WARNINGS, at most 20
//    lines plus a `+N more` tail. Errors first because a model reads the top
//    of a block; 20 lines because a whole file's warning list is a wall the
//    model learns to skip.
//  - A HARD 2s budget per edit. The manager's readiness gate may lawfully
//    wait 10s on a cold server — fine for the on-demand `lsp` tool, not for
//    the write path. On timeout the result ships with no block while the
//    server keeps warming in the background, so the NEXT edit is fast.
//  - READINESS-GATED: the manager only claims an answer once the first
//    publishDiagnostics for that document has arrived, so "no block" never
//    means "clean" on a server that has not analyzed the file yet.
//  - The syntax pass STAYS as the fallback: with no server binary (or a cold
//    one) the `syntax_check` field is exactly what it was. When a real
//    language-server block is attached it supersedes the syntax field, which
//    is a strict subset — two blocks about one file is noise.
//  - Strictly best-effort: no LSP outcome ever fails a successful write.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../../types";
import type { LspDiagnostic, LspServerManager } from "./manager";
import { serverTable } from "./manager";

// ── The switch ──

let autoFeedback = false;

export function setLspAutoFeedback(on: boolean): void {
  autoFeedback = on;
}

export function isLspAutoFeedbackEnabled(): boolean {
  return autoFeedback;
}

/** Never spend more than this waiting for a server after a write. */
export const FEEDBACK_BUDGET_MS = 2000;
/** Diagnostic lines shown before the `+N more` tail. */
export const MAX_DIAGNOSTIC_LINES = 20;

/** Severities worth a model's attention. Hints and information are not. */
const REPORTED = new Set(["error", "warning"]);

// ── Default-on detection ──
//
// The default is per-workspace, not global: TypeScript and Python projects
// where the server is actually installed get it, everything else does not.
// Rust and Go are deliberately excluded from the DEFAULT (rust-analyzer and
// gopls index a whole crate/module graph before their first publish, so the
// 2s budget would usually expire and the feature would cost latency for no
// feedback) — `[lsp] autoFeedback = true` still turns them on explicitly.

const TS_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json", "deno.json"];
const PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"];

/** Is a server for this extension both configured and present on PATH? */
function serverAvailableFor(ext: string): boolean {
  const entry = serverTable().find((s) => s.extensions.includes(ext));
  if (!entry) return false;
  const bin = entry.spec.command[0];
  return bin !== undefined && Bun.which(bin) !== null;
}

/**
 * Whether post-edit diagnostics default ON for this workspace: a TypeScript or
 * Python project whose language server is installed. Explicit config always
 * wins over this — it only decides the unset case.
 */
export function lspAutoFeedbackDefault(workspaceRoot: string): boolean {
  try {
    if (TS_MARKERS.some((m) => existsSync(join(workspaceRoot, m))) && serverAvailableFor(".ts")) {
      return true;
    }
    if (PY_MARKERS.some((m) => existsSync(join(workspaceRoot, m))) && serverAvailableFor(".py")) {
      return true;
    }
  } catch {
    // An unreadable workspace root is not a reason to enable anything.
  }
  return false;
}

// ── Rendering ──

export interface FileDiagnostics {
  /** Absolute path of the file the diagnostics belong to. */
  file: string;
  diagnostics: LspDiagnostic[];
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1 };

/**
 * Render one bounded block. Errors first (a model reads the top), then
 * warnings; within a severity, by file then line then column, so a repeated
 * edit produces a stable block instead of a reshuffled one.
 */
export function formatDiagnosticsBlock(files: FileDiagnostics[], workspaceRoot?: string): string {
  const rows: Array<{ rank: number; file: string; d: LspDiagnostic }> = [];
  for (const { file, diagnostics } of files) {
    for (const d of diagnostics) {
      if (!REPORTED.has(d.severity)) continue;
      rows.push({ rank: SEVERITY_RANK[d.severity] ?? 1, file, d });
    }
  }
  if (rows.length === 0) return "";

  rows.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.file.localeCompare(b.file) ||
      a.d.line - b.d.line ||
      a.d.column - b.d.column,
  );

  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const r of rows) {
    const shown = displayPath(r.file, workspaceRoot);
    const line = `${shown}:${r.d.line}:${r.d.column} ${r.d.severity} ${collapse(r.d.message)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    if (lines.length >= MAX_DIAGNOSTIC_LINES) {
      dropped++;
      continue;
    }
    lines.push(line);
  }
  if (dropped > 0) lines.push(`+${dropped} more`);
  return lines.join("\n");
}

/** Workspace-relative when the file is inside it — that is how edits address it. */
function displayPath(file: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return file;
  const rel = relative(workspaceRoot, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

/** One diagnostic, one line: servers wrap long messages across several. */
function collapse(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ── Collection ──

/**
 * Diagnostics for the given files, under ONE shared deadline (a 6-file patch
 * must not cost 6 × the budget). Files the manager has no server for, and
 * servers that have not published yet, contribute nothing.
 */
export async function collectDiagnostics(
  manager: LspServerManager,
  workspaceRoot: string,
  absPaths: string[],
  budgetMs = FEEDBACK_BUDGET_MS,
): Promise<FileDiagnostics[]> {
  const targets = absPaths.filter((p) => manager.specFor(p) !== null);
  if (targets.length === 0) return [];

  const deadline = new Promise<null>((r) => {
    const t = setTimeout(() => r(null), budgetMs);
    // The budget timer must never hold the process open on its own.
    (t as { unref?: () => void }).unref?.();
  });

  const settled = await Promise.all(
    targets.map(async (abs) => {
      try {
        const raced = await Promise.race([manager.diagnostics(abs, workspaceRoot), deadline]);
        // `analyzed: false` means the server never published for this document
        // — silence, not a clean bill of health.
        if (!raced || !raced.analyzed) return null;
        return { file: abs, diagnostics: raced.diagnostics };
      } catch {
        return null; // missing server, dead connection, anything
      }
    }),
  );
  return settled.filter((f): f is FileDiagnostics => f !== null);
}

/**
 * The whole post-write step for a set of files: collect, render, and return
 * the block (empty string = attach nothing). Shared by the single-path write
 * wrapper and apply_patch's multi-file path.
 */
export async function diagnosticsBlockFor(
  manager: LspServerManager,
  workspaceRoot: string,
  absPaths: string[],
  budgetMs = FEEDBACK_BUDGET_MS,
): Promise<string> {
  if (!autoFeedback || absPaths.length === 0) return "";
  try {
    const files = await collectDiagnostics(manager, workspaceRoot, absPaths, budgetMs);
    return formatDiagnosticsBlock(files, workspaceRoot);
  } catch {
    return ""; // best-effort in the strongest sense
  }
}

// ── The write-path wrapper ──

/**
 * Wrap a single-path write tool (write_file / edit_file / multi_edit) so a
 * successful edit to a file the language server understands carries that
 * server's verdict in the same tool result. Shares the ONE registered manager
 * — never spawns a parallel set of servers.
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

      const block = await diagnosticsBlockFor(manager, input.workspaceRoot, [abs]);
      if (!block) return output;

      let result: Record<string, unknown>;
      try {
        result = JSON.parse(output.result) as Record<string, unknown>;
      } catch {
        return output; // non-JSON result — leave untouched
      }
      result.diagnostics = block;
      // The server's block supersedes the syntax pass for this file: a syntax
      // error is reported by both, and two blocks about one file is noise.
      delete result.syntax_check;
      return { ...output, result: JSON.stringify(result) };
    },
  };
}
