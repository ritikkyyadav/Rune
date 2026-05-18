// ─── Diff Renderer ───
// Parses unified diff output from the edit_file tool and renders it
// with colored +/- lines, hunk headers, and a line-count summary.

const esc = (code: string) => `\x1b[${code}m`;
const reset = esc("0");
const dim = (s: string) => `${esc("2")}${s}${reset}`;
const green = (s: string) => `${esc("32")}${s}${reset}`;
const red = (s: string) => `${esc("31")}${s}${reset}`;
const cyan = (s: string) => `${esc("36")}${s}${reset}`;
const bold = (s: string) => `${esc("1")}${s}${reset}`;

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
      // File headers — skip; they're redundant with the tool's path summary
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
    rendered.push(`${indent}${dim(`… diff truncated at ${MAX_DIFF_LINES} lines …`)}`);
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
 * Expects parsed JSON shape: { path, hash, diff, replacements }.
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
 * Expects parsed JSON shape: { path, hash, bytes_written, created }.
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
  // Show last 3 path components for context
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-3).join("/");
}
