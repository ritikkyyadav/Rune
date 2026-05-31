// ─── Tool-call Rendering (Codex-style) ───
// One activity unit per completed tool call:
//   • Verb  target
//     └ first output line
//       …more
//       … +N lines (ctrl+t for transcript)
// Vermillion is reserved for failures (L'Atlas: one emphasis = the thing that's wrong).

import { bold, text, muted, faint, info, ok, accent } from "./theme";
import { bullet, connector, truncate, termWidth, visLen } from "./render";
import { renderUnifiedDiff } from "../diff-render";

const MAX_PREVIEW_LINES = 6;

const VERB: Record<string, string> = {
  bash: "Ran",
  read_file: "Read",
  list_dir: "Explored",
  grep: "Searched",
  write_file: "Wrote",
  edit_file: "Edited",
};

export interface ToolCallView {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function verbFor(toolName: string): string {
  return VERB[toolName] ?? toolName;
}

function targetFor(toolName: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (toolName) {
    case "bash":
      return s(args.command).split("\n")[0];
    case "read_file":
    case "write_file":
    case "edit_file":
      return shortenPath(s(args.path));
    case "list_dir":
      return shortenPath(s(args.path) || ".");
    case "grep": {
      const pat = s(args.pattern);
      const where = args.path ? ` in ${shortenPath(s(args.path))}` : "";
      return pat + where;
    }
    default: {
      const json = (() => {
        try {
          return JSON.stringify(args);
        } catch {
          return "";
        }
      })();
      return json;
    }
  }
}

/** Lines of result to preview under the `└` connector, plus a truncation note. */
function previewLines(result: string): { head: string; sub: string[] } {
  const all = result.split("\n").filter((l, i, a) => !(l === "" && i === a.length - 1));
  if (all.length === 0 || (all.length === 1 && all[0] === "")) {
    return { head: faint("(no output)"), sub: [] };
  }
  const width = Math.max(20, Math.min(termWidth() - 8, 100));
  const shown = all.slice(0, MAX_PREVIEW_LINES).map((l) => truncate(l, width));
  const head = shown[0];
  const sub = shown.slice(1);
  const remaining = all.length - shown.length;
  if (remaining > 0) {
    sub.push(faint(`… +${remaining} lines (ctrl+t for transcript)`));
  }
  return { head, sub };
}

/** Render a completed tool call as a Codex-style activity block. */
export function renderToolCall(v: ToolCallView): string {
  const verb = verbFor(v.toolName);
  const target = targetFor(v.toolName, v.args);

  // ── Failure ──
  if (!v.success) {
    const head = `${accent(bold(verb))}${target ? "  " + accent(target) : ""}`;
    const errLine = truncate(v.error ?? "failed", Math.max(20, termWidth() - 8));
    return [bullet(head, { color: accent }), connector(accent(errLine), { color: accent })].join("\n");
  }

  // ── Edits / writes: show the diff ──
  if (v.toolName === "edit_file" || v.toolName === "write_file") {
    try {
      const parsed = JSON.parse(v.result);
      if (v.toolName === "edit_file" && parsed.diff) {
        const r = renderUnifiedDiff(parsed.diff, "    ");
        const counts = `${ok("+" + r.added)} ${accent("-" + r.removed)}`;
        const head = `${bold(text(verb))}  ${info(shortenPath(parsed.path ?? target))}  ${counts}`;
        return [bullet(head), r.text].filter(Boolean).join("\n");
      }
      if (v.toolName === "write_file") {
        const bytes = parsed.bytes_written ?? 0;
        const head = `${bold(text(verb))}  ${info(shortenPath(parsed.path ?? target))}  ${faint(`(${bytes} bytes)`)}`;
        return bullet(head);
      }
    } catch {
      // fall through to generic preview
    }
  }

  // ── Generic: bullet + output preview ──
  const head = `${bold(text(verb))}${target ? "  " + info(target) : ""}`;
  const { head: outHead, sub } = previewLines(v.result);
  return [bullet(head), connector(muted(outHead), { sub })].join("\n");
}
