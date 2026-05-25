// ─── Diff Renderer ───
// Unified diff with green/vermillion coloring matching the terminal design

import { bold, dim, vermillion as red, cyanotype as cyan, green } from "./colors";

const MAX_DIFF_LINES = 60;

export interface RenderedDiff {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * Render a unified diff with ANSI colors. Truncates long diffs and reports
 * +/- line counts. Returns indented text suitable for CLI output.
 */
export function renderUnifiedDiff(diff: string, indent = "  "): RenderedDiff {
  const lines = diff.split("\n");
  const rendered: string[] = [];
  let added = 0;
  let removed = 0;
  let bodyLineCount = 0;
  let truncated = false;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      rendered.push(`${indent}${cyan(line)}`);
      continue;
    }

    if (bodyLineCount >= MAX_DIFF_LINES) {
      truncated = true;
      continue;
    }

    if (line.startsWith("+")) {
      rendered.push(`${indent}${green(line)}`);
      added++;
      bodyLineCount++;
    } else if (line.startsWith("-")) {
      rendered.push(`${indent}${red(line)}`);
      removed++;
      bodyLineCount++;
    } else {
      rendered.push(`${indent}${dim(line)}`);
      bodyLineCount++;
    }
  }

  if (truncated) {
    rendered.push(`${indent}${dim(`\u2026 diff truncated at ${MAX_DIFF_LINES} lines \u2026`)}`);
  }

  return {
    text: rendered.join("\n"),
    added,
    removed,
    truncated,
  };
}

/**
 * Pretty-print an edit_file tool result.
 */
export function renderEditResult(
  parsed: { path?: string; diff?: string; replacements?: number },
  indent = "  ",
): string {
  if (!parsed.diff) return "";
  const r = renderUnifiedDiff(parsed.diff, indent);
  const reps = parsed.replacements ?? 1;
  const summary =
    `${indent}${bold("edit")} ${cyan(shortenPath(parsed.path ?? ""))}  ` +
    `${green(`+${r.added}`)} ${red(`-${r.removed}`)}  ` +
    `${dim(`(${reps} replacement${reps === 1 ? "" : "s"})`)}`;
  return `${summary}\n${r.text}`;
}

/**
 * Pretty-print a write_file tool result.
 */
export function renderWriteResult(
  parsed: { path?: string; bytes_written?: number; created?: boolean },
  indent = "  ",
): string {
  const verb = parsed.created ? "create" : "overwrite";
  const bytes = parsed.bytes_written ?? 0;
  return (
    `${indent}${bold(verb)} ${cyan(shortenPath(parsed.path ?? ""))}  ` +
    `${dim(`(${bytes} byte${bytes === 1 ? "" : "s"})`)}`
  );
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-3).join("/");
}
