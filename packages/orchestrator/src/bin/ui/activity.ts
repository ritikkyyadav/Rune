// ─── Activity rendering: the thought-chain visual language ───
// The single source of truth for how a turn reads on screen, shared by the live
// stream and the session-resume replay so a resumed session looks just like
// watching it happen:
//
//   ● <assistant narration>        ← a "step" the model is taking
//     Read 3 files                 ← compact, faithful tool lines under it
//     Searched "foo" · 4 matches
//     Edited bar.ts  +12 -3        ← edits always show their diff
//        12 │ - old
//        12 │ + new
//
// renderToolActivity renders ONE tool call and is used by both paths. Only the
// batch replay renderer (renderTranscript) — which can see the whole list —
// aggregates consecutive reads into "Read N files"; the live stream can't look
// ahead, so it shows each read as it lands.

import { bold, text, muted, faint, info, ok, accent, warn } from "./theme";
import { truncate, termWidth } from "./render";
import { renderUnifiedDiff } from "../diff-render";

/** The assistant-narration marker (Claude-Code-style filled dot). */
export const STEP = "●";

export interface ToolActivityView {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** One replayed transcript line. Structurally compatible with the engine's
 *  TranscriptLine so callers can pass `engine.getTranscript()` straight in. */
export interface TranscriptLineView {
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

const VERB: Record<string, string> = {
  bash: "Ran",
  read_file: "Read",
  list_dir: "Explored",
  grep: "Searched",
  write_file: "Wrote",
  edit_file: "Edited",
  interactive_dashboard: "Dashboard",
};

/** Present-tense verb for the live "what's running now" status line. */
const RUNNING: Record<string, string> = {
  bash: "Running",
  read_file: "Reading",
  list_dir: "Exploring",
  grep: "Searching",
  write_file: "Writing",
  edit_file: "Editing",
  interactive_dashboard: "Building dashboard",
};

/** A short label for an in-flight tool call (args aren't known yet at start). */
export function runningLabel(toolName: string): string {
  return RUNNING[toolName] ?? toolName;
}

const s = (v: unknown): string => (v == null ? "" : String(v));
const firstLine = (v: string): string => v.split("\n")[0] ?? "";

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

/** Looser shortening for the bare-path file listing: workspace-relative paths
 *  show whole (`src/apps/ipod/ClickWheel.tsx`); only deep/absolute ones cut. */
function listingPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (!p.startsWith("/") && parts.length <= 6) return p;
  if (parts.length <= 4) return p;
  return ".../" + parts.slice(-4).join("/");
}

/** Usable width for an inline target/command, leaving room for the verb + indent. */
function inlineWidth(): number {
  return Math.max(20, Math.min(termWidth() - 12, 100));
}

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Non-empty result lines — a cheap proxy for grep match / output counts. */
function nonEmptyLines(result: string): string[] {
  return result.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Compact `{k:v}`-ish summary of an unknown/MCP tool's args. */
function compactArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    if (!json || json === "{}") return "";
    return truncate(json, 60);
  } catch {
    return "";
  }
}

/** The `● <text>` head that opens an assistant narration step (first line only). */
export function stepHead(line: string): string {
  return `  ${info(STEP)} ${text(line)}`;
}

/**
 * An assistant narration block: a `● ` head on the first line, the rest of the
 * prose indented to align beneath it. Returns one string per output line.
 */
export function stepBlock(prose: string): string[] {
  const segs = prose.split("\n");
  const out: string[] = [stepHead(segs[0] ?? "")];
  for (const seg of segs.slice(1)) out.push(`    ${text(seg)}`);
  return out;
}

/**
 * Render a single completed tool call as ONE compact activity line (indented two
 * spaces, no bullet/preview — that 6-line preview was the clutter). Edits are the
 * exception: they always show their diff, because the diff is the thing you want.
 * Failures are vermillion (L'Atlas: one emphasis = the thing that's wrong).
 */
export function renderToolActivity(v: ToolActivityView): string {
  const verb = VERB[v.toolName] ?? v.toolName;

  // ── Failure: one vermillion line + a short reason — hard-bounded, because an
  // over-wide line breaks the pinned region's row math (the leak failure mode). ──
  if (!v.success) {
    const tgt = truncate(compactTarget(v), 48);
    const headPlain = 2 + verb.length + (tgt ? 2 + tgt.length : 0);
    const budget = Math.max(12, termWidth() - headPlain - 6);
    const head = `  ${accent(bold(verb))}${tgt ? "  " + accent(tgt) : ""}`;
    const reason = truncate(firstLine(v.error ?? "failed"), budget);
    return `${head}  ${faint("· " + reason)}`;
  }

  // ── Edit: always show the diff ──
  if (v.toolName === "edit_file") {
    const parsed = tryJson(v.result);
    if (parsed?.diff) {
      const r = renderUnifiedDiff(String(parsed.diff), "     ");
      const counts = `${ok("+" + r.added)} ${accent("-" + r.removed)}`;
      const file = truncate(shortenPath(s(parsed.path ?? v.args.path)), 64);
      const head = `  ${bold(text(verb))}  ${info(file)}  ${counts}`;
      return r.text ? `${head}\n${r.text}` : head;
    }
  }

  // ── Write: name + size ──
  if (v.toolName === "write_file") {
    const parsed = tryJson(v.result);
    const file = truncate(shortenPath(s(parsed?.path ?? v.args.path)), 64);
    const bytes = parsed?.bytes_written;
    const meta = bytes != null ? `  ${faint(`(${bytes} bytes)`)}` : "";
    return `  ${bold(text(verb))}  ${info(file)}${meta}`;
  }

  // ── Compact one-liners (each component bounded so the line never overflows) ──
  switch (v.toolName) {
    // Reads render as bare paths (the Codex idiom): a browse through the tree
    // should look like a quiet file listing, not a wall of repeated verbs.
    case "read_file":
      return `  ${muted(truncate(listingPath(s(v.args.path)), 72))}`;

    case "list_dir":
      return `  ${muted(truncate((listingPath(s(v.args.path) || ".") + "/").replace(/\/+$/, "/"), 72))}`;

    case "grep": {
      // Result is JSON ({ matches, total_matches, truncated }) — use the real count.
      const pat = truncate(s(v.args.pattern), 32);
      const where = v.args.path ? faint(` in ${truncate(shortenPath(s(v.args.path)), 20)}`) : "";
      const out = tryJson(v.result);
      const n = typeof out?.total_matches === "number" ? out.total_matches : nonEmptyLines(v.result).length;
      const hits = n === 0 ? faint("· no matches") : faint(`· ${n} match${n === 1 ? "" : "es"}`);
      return `  ${bold(text(verb))}  ${info(`"${pat}"`)}${where}  ${hits}`;
    }

    case "bash": {
      // Result is JSON ({ stdout, stderr, exit_code, timed_out, truncated }) — parse it,
      // don't dump it. Surface a failure/timeout, else the last line of output.
      const out = tryJson(v.result);
      const stdout = typeof out?.stdout === "string" ? out.stdout : "";
      const stderr = typeof out?.stderr === "string" ? out.stderr : "";
      const exit = typeof out?.exit_code === "number" ? out.exit_code : null;
      let hintPlain = "";
      let bad = false;
      if (out?.timed_out === true) {
        hintPlain = "timed out";
        bad = true;
      } else if (exit != null && exit !== 0) {
        hintPlain = `exit ${exit}`;
        bad = true;
      } else {
        const body = (stdout.trim() ? stdout : stderr).split("\n").map((l) => l.trim()).filter(Boolean);
        hintPlain = truncate(body.at(-1) ?? "", 40);
      }
      // Budget: 2 indent + "Ran  " (5) + 2 safety, then reserve room for the hint.
      const hintVis = hintPlain ? hintPlain.length + 4 : 0; // "  · " + hint
      const cmd = truncate(firstLine(s(v.args.command)), Math.max(12, termWidth() - 9 - hintVis));
      const hint = hintPlain ? `  ${faint("·")} ${(bad ? warn : faint)(hintPlain)}` : "";
      return `  ${bold(text("Ran"))}  ${text(cmd)}${hint}`;
    }

    case "web_search": {
      const q = truncate(s(v.args.query ?? v.args.q ?? ""), 48);
      return `  ${bold(text("Searched web"))}${q ? "  " + info(`"${q}"`) : ""}`;
    }

    case "web_fetch": {
      const u = truncate(s(v.args.url ?? v.args.uri ?? ""), 56);
      return `  ${bold(text("Fetched"))}${u ? "  " + info(u) : ""}`;
    }

    // The plan tool renders as its checklist elsewhere (todo_updated) — here
    // just a quiet acknowledgement, never the raw items JSON.
    case "todo_write": {
      const items = Array.isArray(v.args.items) ? v.args.items.length : 0;
      return `  ${bold(text("Updated plan"))}${items ? "  " + faint(`${items} item${items === 1 ? "" : "s"}`) : ""}`;
    }

    case "bash_output": {
      const id = s(v.args.shell_id ?? v.args.id ?? "");
      return `  ${bold(text("Checked shell"))}${id ? "  " + info(id) : ""}`;
    }

    case "kill_shell": {
      const id = s(v.args.shell_id ?? v.args.id ?? "");
      return `  ${bold(text("Stopped shell"))}${id ? "  " + info(id) : ""}`;
    }

    // Live dashboards: surface the action + title, and above all the URL —
    // it's the thing the user clicks.
    case "interactive_dashboard": {
      const out = tryJson(v.result);
      const action = s(v.args.action) || "create";
      const verb2 =
        action === "update"
          ? "Updated dashboard"
          : action === "open"
            ? "Opened dashboard"
            : action === "close"
              ? "Closed dashboard"
              : "Built dashboard";
      const title = truncate(s(out?.title ?? v.args.title ?? ""), 32);
      const url = s(out?.url ?? "");
      const head = `  ${bold(text(verb2))}${title ? "  " + text(`"${title}"`) : ""}`;
      return url ? `${head}  ${info(truncate(url, 60))}` : head;
    }

    default: {
      // MCP / unknown tool — name + a compact args summary.
      const a = compactArgs(v.args);
      return `  ${bold(text(v.toolName))}${a ? "  " + faint(a) : ""}`;
    }
  }
}

/** Best-effort `verb target` for a failed call (args only — the result is an error). */
function compactTarget(v: ToolActivityView): string {
  switch (v.toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return shortenPath(s(v.args.path));
    case "grep":
      return `"${truncate(s(v.args.pattern), 44)}"`;
    case "bash":
      return truncate(firstLine(s(v.args.command)), inlineWidth());
    case "web_fetch":
      return truncate(s(v.args.url ?? v.args.uri ?? ""), 48);
    case "web_search":
      return `"${truncate(s(v.args.query ?? v.args.q ?? ""), 40)}"`;
    case "todo_write":
      return "plan";
    case "bash_output":
    case "kill_shell":
      return s(v.args.shell_id ?? v.args.id ?? "");
    case "interactive_dashboard":
      return s(v.args.title ?? v.args.id ?? v.args.action ?? "");
    default:
      return compactArgs(v.args);
  }
}

function toView(ln: TranscriptLineView): ToolActivityView {
  return {
    toolName: ln.toolName ?? ln.text,
    args: ln.args ?? {},
    result: ln.result ?? "",
    success: !ln.isError,
    error: ln.isError ? ln.result || "failed" : undefined,
  };
}

/**
 * Batch-render a replayed transcript (session resume / startup seeding) into the
 * same thought-chain language as a live turn. Consecutive successful reads
 * collapse into a single `Read N files` line; everything else renders per-call.
 */
export function renderTranscript(lines: TranscriptLineView[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.role === "user") {
      out.push(`  ${accent("›")} ${text(ln.text)}`);
      i++;
    } else if (ln.role === "assistant") {
      out.push(...stepBlock(ln.text));
      i++;
    } else if (ln.role === "note") {
      out.push(`  ${faint(`— ${ln.text} —`)}`);
      i++;
    } else if (ln.role === "tool") {
      // Collapse a run of successful reads into one count line.
      let j = i;
      while (
        j < lines.length &&
        lines[j]!.role === "tool" &&
        lines[j]!.toolName === "read_file" &&
        !lines[j]!.isError
      ) {
        j++;
      }
      const run = j - i;
      if (run >= 2) {
        out.push(`  ${bold(text("Read"))}  ${info(`${run} files`)}`);
        i = j;
      } else {
        out.push(renderToolActivity(toView(ln)));
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("\n");
}
