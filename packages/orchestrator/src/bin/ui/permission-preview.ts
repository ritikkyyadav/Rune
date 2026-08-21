// ─── Permission preview model ───
// Build a truthful, bounded preview before a risky tool executes. The renderer stays
// pure; this module performs the one filesystem read needed to locate proposed edits
// and attach real source line numbers. A failed read never blocks the permission ask.

import { readFile, stat } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";

export type PermissionPreviewLineKind = "context" | "add" | "remove" | "hunk";

export interface PermissionPreviewLine {
  kind: PermissionPreviewLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** One v2 risk-row fact: computed from real arguments, colored by tone. */
export interface PermissionRiskFact {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "accent" | "muted";
}

export interface PermissionPreview {
  /** The human question at the centre of the ask. */
  question: string;
  /** Compact trust boundary, e.g. "workspace · reversible". */
  scope: string;
  /** Command/query detail for non-file actions. */
  detail?: string;
  /** Workspace-relative target when one exists. */
  target?: string;
  /** A bounded, source-located change preview. */
  lines: PermissionPreviewLine[];
  added: number;
  removed: number;
  truncated: boolean;
  /** Used when an existing target cannot be safely loaded for an exact count. */
  summary?: string;
  /** Honest statement of what has not happened yet. */
  guard: string;
  /** Labels are action-specific so choices never become vague yes/no prompts. */
  choices: [string, string, string];
  /** Optional explanation from Auto review. */
  reason?: string;
  /** v2 risk row (writes / egress / runtime / rate limit). Absent facts stay absent. */
  risk?: PermissionRiskFact[];
}

export interface PermissionPreviewInput {
  toolName: string;
  argsSummary: string;
  rawArgs?: Record<string, unknown>;
  workspaceRoot: string;
  safety?: { reason: string; tier?: string };
  exactSessionGrant?: boolean;
  /** Live per-minute occupancy for this tool, from the engine's rate limiter. */
  rateLimit?: { used: number; limit: number };
}

const MAX_PREVIEW_ROWS = 9;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCode(value: string): string {
  return value.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function changeLines(value: string): string[] {
  if (value === "") return [];
  const rows = value.replace(/\r\n/g, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows;
}

function allLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function lineAt(value: string, index: number): string {
  return allLines(value)[index] ?? "";
}

function lineNumberAt(value: string, index: number): number {
  return value.slice(0, Math.max(0, index)).split("\n").length;
}

function shortenTarget(path: string, workspaceRoot: string): string {
  if (!path) return "";
  const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const rel = relative(workspaceRoot, absolute);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return path;
}

interface TargetSnapshot {
  exists: boolean | null;
  content: string | null;
}

async function readTarget(path: string, workspaceRoot: string): Promise<TargetSnapshot> {
  if (!path) return { exists: null, content: null };
  try {
    const target = isAbsolute(path) ? path : resolve(workspaceRoot, path);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) {
      return { exists: true, content: null };
    }
    return { exists: true, content: await readFile(target, "utf8") };
  } catch (error) {
    return {
      exists: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false : null,
      content: null,
    };
  }
}

function crop(rows: PermissionPreviewLine[]): {
  lines: PermissionPreviewLine[];
  truncated: boolean;
} {
  if (rows.length <= MAX_PREVIEW_ROWS) return { lines: rows, truncated: false };
  const head = Math.ceil((MAX_PREVIEW_ROWS - 1) / 2);
  const tail = MAX_PREVIEW_ROWS - head - 1;
  return {
    lines: [
      ...rows.slice(0, head),
      { kind: "hunk", text: `… ${rows.length - head - tail} preview lines hidden …` },
      ...rows.slice(-tail),
    ],
    truncated: true,
  };
}

function editRows(
  source: string | null,
  oldText: string,
  newText: string,
): { rows: PermissionPreviewLine[]; added: number; removed: number } {
  const oldRows = changeLines(oldText);
  const newRows = changeLines(newText);
  const found = source == null ? -1 : source.indexOf(oldText);
  const start = found >= 0 && source != null ? lineNumberAt(source, found) : undefined;
  const rows: PermissionPreviewLine[] = [];

  if (source != null && start != null && start > 1) {
    rows.push({
      kind: "context",
      text: cleanCode(lineAt(source, start - 2)),
      oldLine: start - 1,
      newLine: start - 1,
    });
  }
  oldRows.forEach((text, index) =>
    rows.push({ kind: "remove", text: cleanCode(text), oldLine: start && start + index }),
  );
  newRows.forEach((text, index) =>
    rows.push({ kind: "add", text: cleanCode(text), newLine: start && start + index }),
  );
  if (source != null && found >= 0 && start != null) {
    const afterOffset = found + oldText.length;
    const after = source
      .slice(afterOffset)
      .replace(/^\r?\n/, "")
      .split(/\r?\n/)[0];
    if (after) {
      rows.push({
        kind: "context",
        text: cleanCode(after),
        oldLine: start + oldRows.length,
        newLine: start + newRows.length,
      });
    }
  }
  return { rows, added: newRows.length, removed: oldRows.length };
}

function fullWriteRows(
  before: string | null,
  after: string,
): { rows: PermissionPreviewLine[]; added: number; removed: number } {
  const next = changeLines(after);
  if (before == null) {
    return {
      rows: next.map((text, index) => ({
        kind: "add" as const,
        text: cleanCode(text),
        newLine: index + 1,
      })),
      added: next.length,
      removed: 0,
    };
  }

  const prev = changeLines(before);
  let prefix = 0;
  while (prefix < prev.length && prefix < next.length && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < prev.length - prefix &&
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removedRows = prev.slice(prefix, prev.length - suffix);
  const addedRows = next.slice(prefix, next.length - suffix);
  const rows: PermissionPreviewLine[] = [];
  if (prefix > 0) {
    rows.push({
      kind: "context",
      text: cleanCode(prev[prefix - 1] ?? ""),
      oldLine: prefix,
      newLine: prefix,
    });
  }
  removedRows.forEach((text, index) =>
    rows.push({ kind: "remove", text: cleanCode(text), oldLine: prefix + index + 1 }),
  );
  addedRows.forEach((text, index) =>
    rows.push({ kind: "add", text: cleanCode(text), newLine: prefix + index + 1 }),
  );
  if (suffix > 0) {
    rows.push({
      kind: "context",
      text: cleanCode(next[next.length - suffix] ?? ""),
      oldLine: prev.length - suffix + 1,
      newLine: next.length - suffix + 1,
    });
  }
  return { rows, added: addedRows.length, removed: removedRows.length };
}

function stripToolPrefix(toolName: string, summary: string): string {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return clean(summary).replace(new RegExp(`^${escaped}(?::|\\s)\\s*`, "i"), "");
}

function origin(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Build the presentation once when the broker pauses. Rendering it is then side-effect free. */
/** True when the resolved target stays under the workspace root. */
function insideWorkspace(path: string, workspaceRoot: string): boolean {
  if (!path) return true;
  const absolute = isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const rel = relative(workspaceRoot, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The pending call's rate-limit occupancy (this call included). */
function rateFact(rateLimit?: { used: number; limit: number }): PermissionRiskFact | null {
  if (!rateLimit || rateLimit.limit <= 0) return null;
  const next = Math.min(rateLimit.limit, rateLimit.used + 1);
  return {
    label: "rate limit",
    value: `${next}/${rateLimit.limit} per min`,
    tone: next >= rateLimit.limit ? "warn" : "muted",
  };
}

const BASH_DEFAULT_TIMEOUT_MS = 120_000;

export async function buildPermissionPreview(
  input: PermissionPreviewInput,
): Promise<PermissionPreview> {
  const args = input.rawArgs ?? {};
  const rawPath = clean(args.path);
  const target = shortenTarget(rawPath, input.workspaceRoot);
  const session = input.exactSessionGrant ? "Allow this exact action for this session" : "";
  const reason = input.safety?.reason ? clean(input.safety.reason) : undefined;

  // v2 risk row, from real facts only: target locality, declared network
  // access, the executing tool's timeout cap, and the live rate limiter.
  const fileWriteRisk = (): PermissionRiskFact[] => {
    const inside = insideWorkspace(rawPath, input.workspaceRoot);
    return [
      inside
        ? { label: "writes outside workspace", value: "no", tone: "ok" }
        : { label: "writes outside workspace", value: "YES", tone: "accent" },
      { label: "network egress", value: "none", tone: "ok" },
      ...(rateFact(input.rateLimit) ? [rateFact(input.rateLimit)!] : []),
    ];
  };

  if (input.toolName === "edit_file") {
    const source = (await readTarget(rawPath, input.workspaceRoot)).content;
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    const diff = editRows(source, oldText, newText);
    const cropped = crop(diff.rows);
    return {
      question: `Apply this edit to ${target || "the file"}?`,
      scope: "workspace · reversible",
      target,
      lines: cropped.lines,
      added: diff.added,
      removed: diff.removed,
      truncated: cropped.truncated,
      guard: "Working tree unchanged · review before write",
      risk: fileWriteRisk(),
      choices: [
        "Yes, apply this edit",
        session || "Yes, allow file edits for this session",
        "No, tell Gear what to change",
      ],
      reason,
    };
  }

  if (input.toolName === "multi_edit") {
    let source = (await readTarget(rawPath, input.workspaceRoot)).content;
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const rows: PermissionPreviewLine[] = [];
    let added = 0;
    let removed = 0;
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index] as Record<string, unknown>;
      const oldText = String(edit.old_text ?? "");
      const newText = String(edit.new_text ?? "");
      const one = editRows(source, oldText, newText);
      if (edits.length > 1)
        rows.push({ kind: "hunk", text: `edit ${index + 1} of ${edits.length}` });
      rows.push(...one.rows);
      added += one.added;
      removed += one.removed;
      if (source != null && source.includes(oldText)) {
        source = edit.replace_all
          ? source.split(oldText).join(newText)
          : source.replace(oldText, newText);
      }
    }
    const cropped = crop(rows);
    return {
      question: `Apply ${edits.length || "these"} atomic edits to ${target || "the file"}?`,
      scope: "workspace · all-or-nothing",
      target,
      lines: cropped.lines,
      added,
      removed,
      truncated: cropped.truncated,
      guard: "Working tree unchanged · every edit must validate before write",
      risk: fileWriteRisk(),
      choices: [
        "Yes, apply these edits",
        session || "Yes, allow file edits for this session",
        "No, tell Gear what to change",
      ],
      reason,
    };
  }

  if (input.toolName === "write_file") {
    const snapshot = await readTarget(rawPath, input.workspaceRoot);
    const source = snapshot.content;
    const content = String(args.content ?? "");
    const diff = fullWriteRows(source, content);
    const cropped = crop(diff.rows);
    const creating = snapshot.exists === false;
    const existingNotPreviewed = snapshot.exists !== false && source == null;
    return {
      question: `${creating ? "Create" : "Replace the contents of"} ${target || "the file"}?`,
      scope: `workspace · ${creating ? "new file" : "full rewrite"}`,
      target,
      lines: cropped.lines,
      added: diff.added,
      removed: diff.removed,
      truncated: cropped.truncated,
      summary: existingNotPreviewed ? "new contents · existing target not loaded" : undefined,
      guard: "Working tree unchanged · review before write",
      risk: fileWriteRisk(),
      choices: [
        creating ? "Yes, create this file" : "Yes, write this file",
        session || "Yes, allow file writes for this session",
        "No, tell Gear what to change",
      ],
      reason,
    };
  }

  if (input.toolName === "bash") {
    const command = clean(args.command) || stripToolPrefix(input.toolName, input.argsSummary);
    const network = args.network === true;
    const timeoutMs =
      Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : BASH_DEFAULT_TIMEOUT_MS;
    const runtimeSecs = Math.ceil(timeoutMs / 1000);
    const bashRisk: PermissionRiskFact[] = [
      network
        ? { label: "writes outside workspace", value: "possible (host)", tone: "warn" }
        : { label: "writes outside workspace", value: "blocked (sandbox)", tone: "ok" },
      network
        ? { label: "network egress", value: "requested", tone: "warn" }
        : { label: "network egress", value: "blocked", tone: "ok" },
      {
        label: "est. runtime",
        value: `≤${runtimeSecs}s cap`,
        tone: runtimeSecs > 120 ? "warn" : "muted",
      },
      ...(rateFact(input.rateLimit) ? [rateFact(input.rateLimit)!] : []),
    ];
    return {
      question: "Run this command?",
      scope: network ? "host command · network access" : "sandboxed command · workspace",
      detail: command,
      lines: [],
      added: 0,
      removed: 0,
      truncated: false,
      guard: "Command has not run · review before execute",
      risk: bashRisk,
      choices: [
        "Yes, run this command",
        session || "Yes, allow shell commands for this session",
        "No, do not run it",
      ],
      reason,
    };
  }

  if (input.toolName === "web_fetch" || input.toolName === "web_search") {
    const url = clean(args.url ?? args.uri);
    const query = clean(args.query ?? args.q);
    const detail = url || query || stripToolPrefix(input.toolName, input.argsSummary);
    const label = input.toolName === "web_fetch" && url ? origin(url) : "the web";
    return {
      question:
        input.toolName === "web_fetch"
          ? `Fetch content from ${label}?`
          : "Search the web with this query?",
      scope: "network · read only",
      detail,
      lines: [],
      added: 0,
      removed: 0,
      truncated: false,
      guard: "No request sent · review before network access",
      risk: [
        { label: "writes outside workspace", value: "no", tone: "ok" },
        {
          label: "network egress",
          value: input.toolName === "web_fetch" && url ? origin(url) : "web search",
          tone: "warn",
        },
        ...(rateFact(input.rateLimit) ? [rateFact(input.rateLimit)!] : []),
      ],
      choices: [
        "Yes, continue",
        session || "Yes, allow this network tool for this session",
        "No, stay offline",
      ],
      reason,
    };
  }

  const detail = stripToolPrefix(input.toolName, input.argsSummary) || input.toolName;
  return {
    question: `Allow Gear to run ${input.toolName}?`,
    scope: "explicit approval",
    detail,
    target,
    lines: [],
    added: 0,
    removed: 0,
    truncated: false,
    guard: "No action taken yet",
    risk: rateFact(input.rateLimit) ? [rateFact(input.rateLimit)!] : undefined,
    choices: [
      "Yes, allow once",
      session || "Yes, allow this tool for this session",
      "No, tell Gear what to change",
    ],
    reason,
  };
}
