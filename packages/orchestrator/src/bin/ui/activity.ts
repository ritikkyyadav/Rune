// ─── Activity rendering: the thought-chain visual language ───
// The single source of truth for how a turn reads on screen, shared by the live
// stream and the session-resume replay so a resumed session looks just like
// watching it happen. It transcribes the `docs/design/gear-customizer-v2.html` stream:
//
//   ● Plan: <one paragraph of intent>          ← plan bullet
//   ● Searching src/bin/ui/ · grep             ← tool bullet: verb + target + meta
//     └ $ grep -rn "renderStatus" src/bin/ui/  ← cmd tree on the code surface
//   ● Editing src/bin/ui/status.ts · hash-guarded
//     packages/…/status.ts        +2 −1 · lines 41–46   ← diff card header
//       41 - old                                          ← red wash
//       41 + new                                          ← green wash
//   ● Verifying tests/unit/ · bash · sandboxed
//     └ $ bun test tests/unit/  # 214 pass · 0 fail
//
// renderToolActivity renders ONE tool call and is used by both paths. Only the
// batch replay renderer (renderTranscript) — which can see the whole list —
// aggregates consecutive reads into "Read N files"; the live stream can't look
// ahead, so it shows each read as it lands.

import { isOsIsolationAvailable, isSandboxEnabled } from "@alan/tool-registry";
import {
  bold,
  text,
  muted,
  faint,
  info,
  ok,
  accent,
  warn,
  brand,
  codeSurface,
  diffSurface,
  diffHeaderSurface,
  positiveSurface,
  negativeSurface,
} from "./theme";
import { truncate, termWidth, visLen } from "./render";

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
  task: "Scouted",
  worker: "Worker",
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
  task: "Scouting",
  worker: "Worker building",
};

/** A short label for an in-flight tool call (args aren't known yet at start). */
export function runningLabel(toolName: string): string {
  return RUNNING[toolName] ?? toolName;
}

/** Commands whose result is evidence, rather than merely another action. */
export function isVerificationCommand(command: string): boolean {
  const cmd = command.toLowerCase();
  return (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)/.test(cmd) ||
    /(^|[\s;&|])(lint|eslint|ruff|mypy|typecheck|tsc|check|build)([\s;&|]|$)/.test(cmd) ||
    /\b(cargo\s+(test|check|clippy)|go\s+test|swift\s+test|xcodebuild|gradle\w*\s+test|mvn\w*\s+test)\b/.test(
      cmd,
    )
  );
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
  return result
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
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
  return `  ${text(STEP)} ${text(line)}`;
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

/** A progress paragraph rendered in the reference's explicit Plan row:
 *  `● Plan:` in primary weight, the intent itself in the secondary tone. */
export function planBlock(prose: string): string[] {
  const clean = prose.trim();
  if (!clean) return [];
  const segs = clean.split("\n");
  const first = (segs[0] ?? "").replace(/^plan\s*:\s*/i, "");
  const out = [`  ${text(STEP)} ${bold(text("Plan:"))} ${muted(first)}`];
  for (const seg of segs.slice(1)) out.push(`    ${muted(seg)}`);
  return out;
}

// ─── Tool bullet grammar ───

/** The faint `· grep` / `· bash · sandboxed` meta after a tool header. */
function toolMeta(...parts: Array<string | false | undefined | null>): string {
  const shown = parts.filter((part): part is string => Boolean(part));
  return shown.length ? ` ${faint("· " + shown.join(" · "))}` : "";
}

/** `● Verb target · meta` — verb and target carry the weight, meta stays faint. */
function toolHead(verb: string, target = "", meta = ""): string {
  return `  ${text(STEP)} ${bold(text(verb))}${target ? " " + bold(text(target)) : ""}${meta}`;
}

/** Honest execution posture for a shell command: the live sandbox state plus
 *  the call's own `network` escape hatch. Never claims isolation that the
 *  machine cannot provide. */
function bashPosture(args: Record<string, unknown>): string[] {
  if (args.network === true) return ["bash", "host", "network"];
  if (isSandboxEnabled() && isOsIsolationAvailable()) return ["bash", "sandboxed"];
  return ["bash", "host"];
}

/** The target a verification command checks: its path-like argument
 *  (`bun test tests/unit/` → `tests/unit/`), else the runner itself. */
function verificationTarget(command: string): string {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const args = tokens.slice(1);
  const pathLike = [...args]
    .reverse()
    .find((token) => !token.startsWith("-") && (token.includes("/") || /\.\w{1,5}$/.test(token)));
  if (pathLike) return pathLike.replace(/^['"]|['"]$/g, "");
  return tokens.slice(0, 2).join(" ") || command;
}

/** The one-line outcome of a command: a test runner's `214 pass · 0 fail`
 *  tally when it printed one, else the last non-empty output line. */
export function commandOutcome(output: string): string {
  const passed = /^\s*(\d+)\s+pass(?:ed|ing)?\b/m.exec(output)?.[1];
  const failed = /^\s*(\d+)\s+fail(?:ed|ing|ures?)?\b/m.exec(output)?.[1];
  if (passed != null && failed != null) return `${passed} pass · ${failed} fail`;
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

type SurfacePainter = (value: string) => string;

/** Solid, padded evidence row. Padding matters: it makes the code/diff surface
 * visible as a card instead of only colouring the glyphs themselves. */
function surfaceRow(
  content: string,
  surface: SurfacePainter,
  options: { indent?: string; width?: number } = {},
): string {
  const indent = options.indent ?? "    ";
  const available = Math.max(12, termWidth() - visLen(indent) - 2);
  const width = Math.max(10, Math.min(options.width ?? available, available));
  const shown = truncate(content, Math.max(1, width - 2));
  const fill = " ".repeat(Math.max(0, width - 2 - visLen(shown)));
  return `${indent}${surface(` ${shown}${fill} `)}`;
}

/** Shell syntax in the customizer's cmd-tree grammar: keyword ochre, flags in
 *  the accent, quoted strings green, the result comment green (or ochre when
 *  the command went wrong). */
function commandCard(command: string, hint = "", tone: "ok" | "warn" = "ok"): string {
  const max = Math.max(18, Math.min(100, termWidth() - 6));
  const paintHint = tone === "warn" ? warn : ok;
  const suffix = hint ? `  ${paintHint("# " + hint)}` : "";
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const syntax = tokens
    .map((token, index) => {
      if (/^(['"]).*\1$/.test(token)) return ok(token);
      if (/^-{1,2}[\w-]+/.test(token)) return brand(token);
      if (index === 0) return bold(warn(token));
      return text(token);
    })
    .join(" ");
  return surfaceRow(`${faint("└")} ${bold(muted("$"))} ${syntax}${suffix}`, codeSurface, {
    width: max,
  });
}

function diffCard(path: string, raw: string): { text: string; added: number; removed: number } {
  const source = raw
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  const body: string[] = [];
  const limit = 26;
  for (const row of source) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (row.startsWith("+")) added++;
    if (row.startsWith("-")) removed++;
    if (body.length >= limit) continue;
    const kind = row.startsWith("+") ? "add" : row.startsWith("-") ? "remove" : "context";
    const number = kind === "add" ? newLine++ : kind === "remove" ? oldLine++ : newLine++;
    if (kind === "context") oldLine++;
    const gutter = `${String(number || "").padStart(4)} `;
    const marker = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
    const code = kind === "context" ? row.replace(/^ /, "") : row.slice(1);
    const payload = truncate(code || " ", Math.max(8, termWidth() - 19));
    const content =
      kind === "add"
        ? `${faint(gutter)}${bold(ok(marker))} ${ok(payload)}`
        : kind === "remove"
          ? `${faint(gutter)}${bold(accent(marker))} ${accent(payload)}`
          : `${faint(gutter)}  ${muted(payload)}`;
    body.push(
      surfaceRow(
        content,
        kind === "add" ? positiveSurface : kind === "remove" ? negativeSurface : diffSurface,
      ),
    );
  }
  const range = source.find((row) => row.startsWith("@@"))?.match(/\+(\d+)(?:,(\d+))?/);
  const first = Number(range?.[1] ?? 1);
  const count = Number(range?.[2] ?? Math.max(1, added));
  const cardWidth = Math.max(18, Math.min(100, termWidth() - 6));
  const rangeText = `lines ${first}–${first + Math.max(0, count - 1)}`;
  const counts = `${ok(`+${added}`)} ${accent(`−${removed}`)} ${faint(`· ${rangeText}`)}`;
  const shownPath = truncate(path, Math.max(6, cardWidth - visLen(counts) - 5));
  const gap = " ".repeat(Math.max(1, cardWidth - 2 - visLen(shownPath) - visLen(counts)));
  const header = surfaceRow(`${muted(shownPath)}${gap}${counts}`, diffHeaderSurface, {
    width: cardWidth,
  });
  if (source.length > limit)
    body.push(surfaceRow(faint(`… ${source.length - limit} more diff lines`), diffSurface));
  return { text: [header, ...body].join("\n"), added, removed };
}

/**
 * Render a single completed tool call as ONE compact activity line (indented two
 * spaces, no bullet/preview — that 6-line preview was the clutter). Edits are the
 * exception: they always show their diff, because the diff is the thing you want.
 * Failures are red (L'Atlas: one emphasis = the thing that's wrong).
 */
export function renderToolActivity(v: ToolActivityView): string {
  const verb = VERB[v.toolName] ?? v.toolName;

  // ── Failure: one red line + a short reason — hard-bounded, because an
  // over-wide line breaks the pinned region's row math (the leak failure mode). ──
  if (!v.success) {
    const tgt = truncate(compactTarget(v), 48);
    const headPlain = 4 + verb.length + (tgt ? 2 + tgt.length : 0);
    const budget = Math.max(12, termWidth() - headPlain - 6);
    const head = `  ${accent(STEP)} ${bold(accent(verb))}${tgt ? " " + accent(tgt) : ""}`;
    const reason = truncate(firstLine(v.error ?? "failed"), budget);
    return `${head}  ${faint("· " + reason)}`;
  }

  // ── Edit: always show the diff. Every edit is hash-guarded by the harness
  // (read-before-edit freshness + the tool's own content-hash check). ──
  if (v.toolName === "edit_file") {
    const parsed = tryJson(v.result);
    if (parsed?.diff) {
      const fullPath = s(parsed.path ?? v.args.path);
      const file = truncate(listingPath(fullPath), 64);
      const card = diffCard(fullPath, String(parsed.diff));
      return `${toolHead("Editing", file, toolMeta("hash-guarded"))}\n${card.text}`;
    }
  }

  // ── Write: name + size ──
  if (v.toolName === "write_file") {
    const parsed = tryJson(v.result);
    const file = truncate(listingPath(s(parsed?.path ?? v.args.path)), 64);
    const bytes = parsed?.bytes_written;
    return toolHead("Writing", file, toolMeta(bytes != null && `${bytes} bytes`));
  }

  // ── Compact one-liners (each component bounded so the line never overflows) ──
  switch (v.toolName) {
    // Reads render as bare paths (the Codex idiom): a browse through the tree
    // should look like a quiet file listing, not a wall of repeated verbs.
    case "read_file":
      return toolHead("Reading", truncate(listingPath(s(v.args.path)), 72));

    case "list_dir":
      return toolHead(
        "Exploring",
        truncate((listingPath(s(v.args.path) || ".") + "/").replace(/\/+$/, "/"), 72),
      );

    case "grep": {
      // Result is JSON ({ matches, total_matches, truncated }) — use the real count,
      // then show the search as the reference's nested command evidence card.
      const pat = truncate(s(v.args.pattern), 32);
      const target = truncate(listingPath(s(v.args.path) || "."), 48);
      const out = tryJson(v.result);
      const n =
        typeof out?.total_matches === "number" ? out.total_matches : nonEmptyLines(v.result).length;
      const hits = n === 0 ? "no matches" : `${n} match${n === 1 ? "" : "es"}`;
      const command = `grep -rn ${JSON.stringify(pat)} ${target}`;
      return `${toolHead("Searching", target, toolMeta("grep"))}\n${commandCard(command, hits)}`;
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
        hintPlain = truncate(commandOutcome(stdout.trim() ? stdout : stderr), 40);
      }
      // Budget: 2 indent + "Ran  " (5) + 2 safety, then reserve room for the hint.
      const hintVis = hintPlain ? hintPlain.length + 4 : 0; // "  # " + hint
      const raw = firstLine(s(v.args.command));
      const cmd = truncate(raw, Math.max(12, termWidth() - 16 - hintVis));
      const posture = toolMeta(...bashPosture(v.args));
      const head = bad
        ? toolHead("Command failed", "", posture)
        : isVerificationCommand(raw)
          ? toolHead("Verifying", truncate(verificationTarget(raw), 48), posture)
          : toolHead("Running command", "", posture);
      return `${head}\n${commandCard(cmd, hintPlain, bad ? "warn" : "ok")}`;
    }

    case "web_search": {
      const q = truncate(s(v.args.query ?? v.args.q ?? ""), 48);
      return toolHead("Searching web", q ? `"${q}"` : "");
    }

    case "web_fetch": {
      const u = truncate(s(v.args.url ?? v.args.uri ?? ""), 56);
      return toolHead("Reading source", u);
    }

    // The plan tool renders as its checklist elsewhere (todo_updated) — here
    // just a quiet acknowledgement, never the raw items JSON.
    case "todo_write": {
      const items = Array.isArray(v.args.items) ? v.args.items.length : 0;
      return toolHead(
        "Plan updated",
        "",
        toolMeta(items > 0 && `${items} item${items === 1 ? "" : "s"}`),
      );
    }

    case "bash_output": {
      const id = s(v.args.shell_id ?? v.args.id ?? "");
      return toolHead("Checking shell", id);
    }

    case "kill_shell": {
      const id = s(v.args.shell_id ?? v.args.id ?? "");
      return toolHead("Stopping shell", id);
    }

    // Parallel implementation workers: show the contract gist + what changed.
    case "worker": {
      const contract = truncate(firstLine(s(v.args.prompt)), 44);
      const m = /worker changed (\d+) files?[^)]*/.exec(v.result ?? "");
      return toolHead("Worker", `"${contract}"`, toolMeta(m?.[0]));
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
      const head = toolHead(verb2, title ? `"${title}"` : "");
      return url ? `${head}  ${info(truncate(url, 60))}` : head;
    }

    default: {
      // MCP / unknown tool — name + a compact args summary.
      return toolHead(v.toolName, "", toolMeta(compactArgs(v.args)));
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
    case "worker":
      return `"${truncate(firstLine(s(v.args.prompt)), 40)}"`;
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
      out.push(`  ${info("›")} ${text(ln.text)}`);
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
        out.push(`  ${bold(text("Read"))}  ${bold(text(`${run} files`))}`);
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
