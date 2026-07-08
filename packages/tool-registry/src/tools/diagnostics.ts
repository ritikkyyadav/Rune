// ─── Post-Edit Syntax Diagnostics ───
//
// After every successful write_file / edit_file / multi_edit, the edited file
// is syntax-checked and any errors are appended to the tool RESULT — so the
// model learns it broke the file in the SAME turn, instead of three turns
// later when the build fails. This is the surgical form of OpenCode's LSP
// feedback loop: no language servers to install or babysit, just fast native
// checkers per file type:
//
//   .ts/.tsx/.js/.jsx/...  TypeScript compiler API, syntactic pass only
//   .json                  JSON.parse
//   .sh/.bash              bash -n
//   .py                    python3 ast.parse
//
// Semantic errors (types, imports) stay the Verifier's job — a single-file
// syntactic pass is the highest signal-to-noise feedback available per edit:
// zero false positives, catches the dominant failure (unbalanced braces,
// truncated strings, stray diff markers).
//
// Checks are strictly best-effort: missing interpreters, oversized files, and
// checker crashes all degrade to "no diagnostics", never to a failed edit.

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../types";

export interface SyntaxIssue {
  line: number;
  message: string;
}

/** Files above this size are skipped — nobody hand-edits a 2MB file. */
const MAX_CHECK_BYTES = 2 * 1024 * 1024;
/** Subprocess checkers get this long before we give up (best-effort). */
const CHECK_TIMEOUT_MS = 3_000;
/** At most this many issues are reported back to the model. */
const MAX_ISSUES = 5;

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SHELL_EXTS = new Set([".sh", ".bash"]);

// The typescript package is a devDependency of the workspace; load it lazily
// and only once. If it's not installed, TS checks silently disable.
let tsModule: typeof import("typescript") | null | undefined;
async function loadTs(): Promise<typeof import("typescript") | null> {
  if (tsModule !== undefined) return tsModule;
  try {
    tsModule = await import("typescript");
  } catch {
    tsModule = null;
  }
  return tsModule;
}

function checkTypescript(
  ts: typeof import("typescript"),
  path: string,
  content: string,
): SyntaxIssue[] {
  const kind = /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const program = ts.createProgram({
    rootNames: [path],
    options: {
      noEmit: true,
      noResolve: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: false,
      types: [],
      lib: [],
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    host: {
      // Minimal in-memory host: the only file that exists is the one we check.
      getSourceFile: (name) => (name === path ? source : undefined),
      writeFile: () => {},
      getDefaultLibFileName: () => "lib.d.ts",
      getCurrentDirectory: () => "/",
      getDirectories: () => [],
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => name === path,
      readFile: (name) => (name === path ? content : undefined),
    },
  });
  return program.getSyntacticDiagnostics(source).map((d) => {
    const pos = d.start !== undefined ? source.getLineAndCharacterOfPosition(d.start) : null;
    return {
      line: pos ? pos.line + 1 : 0,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    };
  });
}

function checkJson(content: string): SyntaxIssue[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lineMatch = msg.match(/line (\d+)/i);
    return [{ line: lineMatch ? Number(lineMatch[1]) : 0, message: msg }];
  }
}

/** Run a subprocess checker; null on missing binary / timeout (best-effort). */
async function runChecker(argv: string[], errorPattern: RegExp): Promise<SyntaxIssue[] | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), CHECK_TIMEOUT_MS);
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode === 0) return [];
    const issues: SyntaxIssue[] = [];
    for (const line of stderr.split("\n")) {
      const m = line.match(errorPattern);
      if (m) issues.push({ line: Number(m[1] ?? 0) || 0, message: line.trim() });
    }
    // Non-zero exit but nothing parseable: report the first stderr line.
    if (issues.length === 0 && stderr.trim()) {
      issues.push({ line: 0, message: stderr.trim().split("\n")[0]! });
    }
    return issues;
  } catch {
    return null; // checker unavailable — not a diagnostic
  }
}

/**
 * Syntax-check a file. Returns the issues found ([] = clean), or null when no
 * checker applies (unknown extension, checker unavailable, file too big).
 */
export async function checkSyntax(path: string, content: string): Promise<SyntaxIssue[] | null> {
  if (Buffer.byteLength(content, "utf8") > MAX_CHECK_BYTES) return null;
  const ext = extname(path).toLowerCase();

  if (TS_EXTS.has(ext)) {
    const ts = await loadTs();
    if (!ts) return null;
    try {
      return checkTypescript(ts, path, content);
    } catch {
      return null;
    }
  }
  if (ext === ".json") return checkJson(content);
  if (SHELL_EXTS.has(ext)) {
    return runChecker(["bash", "-n", path], /line (\d+)/);
  }
  if (ext === ".py") {
    if (!Bun.which("python3")) return null;
    return runChecker(
      ["python3", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])", path],
      /line (\d+)/,
    );
  }
  return null;
}

/** Render issues as the compact warning string appended to the tool result. */
export function formatIssues(issues: SyntaxIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES);
  const lines = shown.map((i) => (i.line > 0 ? `line ${i.line}: ${i.message}` : i.message));
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  return (
    `SYNTAX ERRORS INTRODUCED — fix before moving on${more}: ` + lines.join("; ").slice(0, 600)
  );
}

/**
 * Wrap a write-category tool so every successful call syntax-checks the
 * written file and appends a `syntax_check` field to the JSON result when
 * errors are found. The write itself still succeeds — the file IS on disk —
 * but the model sees the breakage immediately.
 */
export function withSyntaxCheck(handler: ToolHandler): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const output = await handler.execute(input);
      if (!output.success || !output.result) return output;

      const rel = typeof input.args.path === "string" ? input.args.path : "";
      if (!rel) return output;
      const abs = isAbsolute(rel) ? rel : resolve(input.workspaceRoot, rel);

      try {
        const content = await readFile(abs, "utf8");
        const issues = await checkSyntax(abs, content);
        if (!issues || issues.length === 0) return output;

        let result: Record<string, unknown>;
        try {
          result = JSON.parse(output.result) as Record<string, unknown>;
        } catch {
          return output; // non-JSON result — leave untouched
        }
        result.syntax_check = formatIssues(issues);
        return { ...output, result: JSON.stringify(result) };
      } catch {
        return output; // diagnostics are strictly best-effort
      }
    },
  };
}
