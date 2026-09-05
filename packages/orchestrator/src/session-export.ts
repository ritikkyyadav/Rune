/**
 * session-export.ts — Contract C4
 *
 * Produces a tamper-evident, optionally Ed25519-signed session export.
 * Sections: metadata, audit-chain verification, the Decision Record (how the
 * run reached its answer), full transcript, tool-call audit table
 * (argsHash/resultHash/durationMs/exitCode), and file diffs parsed from
 * tool_result payloads.
 *
 * CLI agent usage:
 *   import { exportSession, verifyExport } from "./session-export";
 *   const result = await exportSession(dbPath, sessionId, { format: "md", sign: true, keyPath: "~/.rune/keys" });
 *   const ok = verifyExport(result.content, result.signature!, result.publicKey!);
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionManager, getRuneHome } from "@rune/shared";
import type { SessionInfoInternal } from "@rune/shared";
import { eventsToMessages } from "./session-replay";
import { loadOrGenerateKeyPair, signBytes, verifySignature } from "./signing";
import { TaskStateStore } from "./task-state";
import { buildDecisionRecord, hasRecord, renderDecisionRecordMarkdown } from "./decision-record";
import type { DecisionRecord } from "@rune/protocol";

// ─── Public API types ──────────────────────────────────────────────────────

export interface ExportOptions {
  format: "md" | "json";
  sign?: boolean;
  /**
   * Path to a directory holding ed25519.key / ed25519.pub.
   * If the files do not exist they are generated automatically.
   * Defaults to ~/.rune/keys.
   */
  keyPath?: string;
}

export interface ExportResult {
  content: string;
  /** Base64 Ed25519 signature over the UTF-8 bytes of `content`. Present when sign:true. */
  signature?: string;
  /** PEM-encoded Ed25519 public key. Present when sign:true. */
  publicKey?: string;
  /** SHA-256 of the last audit-log entry_hash (the "chain head"). Present when sign:true. */
  chainHead?: string;
}

// ─── Internal shapes ──────────────────────────────────────────────────────

interface AuditRow {
  id: number;
  session_id: string | null;
  tool_name: string;
  args_hash: string;
  result_hash: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash: string | null;
  durationMs: number | null;
  exitCode: number | null;
  createdAt: string;
  entryHash: string;
}

interface FileDiff {
  callId: string;
  toolName: string;
  path?: string;
  diff?: string;
  raw?: string;
}

interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

// ─── Main export function ─────────────────────────────────────────────────

/**
 * Export a session from `dbPath` as Markdown or JSON, optionally signed
 * with Ed25519.
 */
export async function exportSession(
  dbPath: string,
  sessionId: string,
  opts: ExportOptions,
): Promise<ExportResult> {
  const sm = new SessionManager(dbPath);

  try {
    // 1. Session metadata
    const session = sm.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 2. All events for this session
    const rawEvents = sm.getEvents(sessionId, 1);

    // 3. Transcript (user / assistant / tool messages)
    const messages = eventsToMessages(rawEvents);
    const transcript: TranscriptMessage[] = messages.map((m) => ({
      role: m.role as TranscriptMessage["role"],
      content: contentToString(m.content),
    }));

    // 4. File diffs from tool_result payloads (edit_file / write_file)
    const fileDiffs = extractFileDiffs(rawEvents);

    // 5. Audit entries for this session (separate read-only DB connection)
    const auditRows = getAuditRowsByPath(dbPath, sessionId);
    const toolCalls: ToolCallRecord[] = auditRows.map((r) => ({
      toolName: r.tool_name,
      argsHash: r.args_hash,
      resultHash: r.result_hash,
      durationMs: r.duration_ms,
      exitCode: r.exit_code,
      createdAt: r.created_at,
      entryHash: r.entry_hash,
    }));

    // 6. Chain head = SHA-256 of the last entry_hash (stable fixed-width id)
    const chainHead =
      auditRows.length > 0
        ? createHash("sha256")
            .update(auditRows[auditRows.length - 1].entry_hash)
            .digest("hex")
        : undefined;

    // 7. Audit chain verification
    const chainResult = sm.verifyAuditChain();

    // 8. Cost — summed from the `cost` events the engine writes per billed
    // request. This used to be hardcoded "unknown" because the CostTracker
    // lives in the Engine and an export is a standalone reader; persisting the
    // priced entries is what closes that gap. A session logged before the
    // engine started writing them still reports "unknown" rather than a
    // confident $0.00 — an audit artifact must not round absence down to zero.
    const totalCostUsd: number | "unknown" = sumCostEvents(rawEvents);

    // 9. The Decision Record — how the run reached its answer.
    //
    // An export is what someone forwards, signs, or attaches to a review, and
    // until now the only account of the reasoning in it was the transcript:
    // the whole conversation, in the order it happened, with the two refuted
    // branches buried somewhere in the middle. The record is the same facts as
    // a document — and it is built from the run's own persisted state, so it
    // is covered by the signature like everything else here.
    const decisionRecord = decisionRecordFor(sessionId, rawEvents);

    // ── Render ──────────────────────────────────────────────────────────
    const content =
      opts.format === "md"
        ? renderMarkdown({
            session,
            transcript,
            toolCalls,
            fileDiffs,
            chainResult,
            chainHead,
            totalCostUsd,
            decisionRecord,
          })
        : renderJson({
            session,
            transcript,
            toolCalls,
            fileDiffs,
            chainResult,
            chainHead,
            totalCostUsd,
            decisionRecord,
          });

    // ── Sign ────────────────────────────────────────────────────────────
    if (!opts.sign) {
      return { content };
    }

    const keyDir = opts.keyPath ?? join(getRuneHome(), "keys");
    const { privateKeyPem, publicKeyPem } = loadOrGenerateKeyPair(keyDir);
    const contentBytes = Buffer.from(content, "utf8");
    const signature = signBytes(contentBytes, privateKeyPem);

    return { content, signature, publicKey: publicKeyPem, chainHead };
  } finally {
    sm.close();
  }
}

/**
 * Verify the Ed25519 signature over a previously exported report.
 *
 * @param content   - The exact report string (Markdown or JSON)
 * @param signature - Base64-encoded Ed25519 signature
 * @param publicKey - PEM-encoded Ed25519 public key
 */
export function verifyExport(content: string, signature: string, publicKey: string): boolean {
  return verifySignature(Buffer.from(content, "utf8"), signature, publicKey);
}

/**
 * Total USD across the session's persisted `cost` events.
 *
 * Returns "unknown" — never 0 — when the session carries no cost events at
 * all. Those are two different facts: "this run was free" and "this run's
 * spend was never recorded". Collapsing them would let an export understate
 * cost with total confidence, which is the failure mode an audit artifact
 * exists to prevent. A malformed or non-finite entry is skipped rather than
 * poisoning the sum, but its presence still counts as "recorded".
 */
function sumCostEvents(
  events: Array<{ seq: number; event: { type: string; payload: Record<string, unknown> } }>,
): number | "unknown" {
  let seen = false;
  let total = 0;
  for (const { event } of events) {
    if (event.type !== "cost") continue;
    seen = true;
    const usd = event.payload?.costUsd;
    if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) total += usd;
  }
  return seen ? total : "unknown";
}

// ─── DB helpers ───────────────────────────────────────────────────────────

/** Open a read-only connection and fetch audit rows for the given session. */
function getAuditRowsByPath(dbPath: string, sessionId: string): AuditRow[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, session_id, tool_name, args_hash, result_hash, duration_ms,
                exit_code, prev_hash, entry_hash, created_at
         FROM audit_log
         WHERE session_id = ?
         ORDER BY id ASC`,
      )
      .all(sessionId) as AuditRow[];
    return rows;
  } finally {
    db.close();
  }
}

// ─── Content helpers ──────────────────────────────────────────────────────

/** Flatten a Message's content field (string or ContentBlock[]) to a string. */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push(String(block.text ?? ""));
        break;
      case "tool_use":
        parts.push(
          `[tool_use: ${String(block.toolName ?? block.name ?? "")} args=${JSON.stringify(block.toolInput ?? block.input ?? {})}]`,
        );
        break;
      case "tool_result":
        parts.push(
          `[tool_result: ${String(block.toolCallId ?? "")} ${block.isError ? "ERROR" : "OK"}: ${String(block.toolResultContent ?? block.content ?? "")}]`,
        );
        break;
    }
  }
  return parts.join("\n");
}

/**
 * Parse file diffs from `tool_result` events whose content looks like a
 * unified diff (from edit_file / write_file operations).
 */
function extractFileDiffs(
  events: Array<{ seq: number; event: { type: string; payload: Record<string, unknown> } }>,
): FileDiff[] {
  const diffs: FileDiff[] = [];

  for (const { event } of events) {
    if (event.type !== "tool_result") continue;

    const p = event.payload as {
      callId?: string;
      toolName?: string;
      content?: string;
      isError?: boolean;
    };

    const toolName = String(p.toolName ?? "");
    const content = String(p.content ?? "");

    // Only file-mutation tools or payloads containing a diff marker
    const isFileOp = toolName === "edit_file" || toolName === "write_file";
    const hasDiffMarker =
      content.includes("@@") ||
      content.startsWith("diff --git") ||
      content.includes("--- ") ||
      content.includes("+++ ");

    if (!isFileOp && !hasDiffMarker) continue;

    const diff: FileDiff = { callId: String(p.callId ?? ""), toolName };

    // Try to extract a file path from the content (unified diff header)
    const pathMatch = content.match(/---\s+(?:a\/)?(.+?)\n/);
    if (pathMatch) diff.path = pathMatch[1].trim();

    if (content.includes("@@") || content.startsWith("diff --git")) {
      diff.diff = content;
    } else {
      diff.raw = content;
    }

    diffs.push(diff);
  }

  return diffs;
}

// ─── Renderers ────────────────────────────────────────────────────────────

interface ReportData {
  session: SessionInfoInternal;
  transcript: TranscriptMessage[];
  toolCalls: ToolCallRecord[];
  fileDiffs: FileDiff[];
  chainResult: { ok: true } | { ok: false; firstBadId: number };
  chainHead: string | undefined;
  totalCostUsd: number | "unknown";
  /** Null when the run recorded no narrative, artifacts or checks. */
  decisionRecord: DecisionRecord | null;
}

/**
 * The record the run persisted, or one generated from its final spine.
 *
 * The persisted row wins: it is what the run itself produced at task end, and
 * regenerating over it would let an export drift from the document a person
 * already read. Falling back to a fresh build is for sessions that ended
 * before the record existed, and for a run that died before writing one.
 */
function decisionRecordFor(
  sessionId: string,
  rawEvents: Array<{ seq: number; event: { type: string; payload?: Record<string, unknown> } }>,
): DecisionRecord | null {
  for (let i = rawEvents.length - 1; i >= 0; i--) {
    if (rawEvents[i].event.type !== "decision_record") continue;
    const record = (rawEvents[i].event.payload as { record?: DecisionRecord } | undefined)?.record;
    if (record && typeof record.objective === "string") return record;
  }
  const store = TaskStateStore.fromEvents(rawEvents as never);
  if (!store) return null;
  const built = buildDecisionRecord(sessionId, store.snapshot());
  return hasRecord(built) ? built : null;
}

function renderMarkdown(d: ReportData): string {
  const lines: string[] = [];

  lines.push(`# Session Export: ${d.session.id}`, "");

  // ── Metadata ──────────────────────────────────────────────────────────
  lines.push("## Metadata", "");
  lines.push("| Key | Value |");
  lines.push("|-----|-------|");
  lines.push(`| Session ID | \`${d.session.id}\` |`);
  lines.push(`| Model | ${d.session.model} |`);
  lines.push(`| Workspace | ${d.session.workspaceRoot} |`);
  lines.push(`| Created | ${d.session.createdAt} |`);
  lines.push(`| Updated | ${d.session.updatedAt} |`);
  lines.push(`| Event Count | ${d.session.eventCount} |`);
  if (d.session.title) lines.push(`| Title | ${d.session.title} |`);
  lines.push(
    `| Cost (USD) | ${typeof d.totalCostUsd === "number" ? `$${d.totalCostUsd.toFixed(6)}` : "unknown"} |`,
  );
  lines.push("");

  // ── Audit Chain Integrity ──────────────────────────────────────────────
  lines.push("## Audit Chain Integrity", "");
  if (d.chainResult.ok) {
    lines.push("**Status:** VERIFIED — chain intact");
  } else {
    const bad = (d.chainResult as { ok: false; firstBadId: number }).firstBadId;
    lines.push(`**Status:** TAMPERED — first bad entry id: \`${bad}\``);
  }
  if (d.chainHead) {
    lines.push(`**Chain Head:** \`${d.chainHead}\``);
  }
  lines.push("");

  // ── The Decision Record ────────────────────────────────────────────────
  // Before the transcript on purpose: the reader wants the account of the
  // reasoning, and the transcript is the material it was drawn from.
  if (d.decisionRecord) {
    // The generator writes its own `# Decision record` heading; demote it one
    // level so it nests under this export rather than competing with its title.
    lines.push(renderDecisionRecordMarkdown(d.decisionRecord).replace(/^# /, "## "), "");
  }

  // ── Transcript ────────────────────────────────────────────────────────
  lines.push("## Transcript", "");
  for (const msg of d.transcript) {
    lines.push(`### ${roleLabel(msg.role)}`, "");
    lines.push(msg.content.length > 0 ? msg.content : "*(empty)*");
    lines.push("");
  }

  // ── Tool Calls ────────────────────────────────────────────────────────
  if (d.toolCalls.length > 0) {
    lines.push("## Tool Calls (Audit Log)", "");
    lines.push("| # | Tool | Args Hash | Result Hash | Duration | Exit |");
    lines.push("|---|------|-----------|-------------|----------|------|");
    d.toolCalls.forEach((tc, i) => {
      const rh = tc.resultHash ? `\`${tc.resultHash.slice(0, 12)}…\`` : "—";
      lines.push(
        `| ${i + 1} | \`${tc.toolName}\` | \`${tc.argsHash.slice(0, 12)}…\` | ${rh} | ${tc.durationMs != null ? `${tc.durationMs}ms` : "—"} | ${tc.exitCode ?? "—"} |`,
      );
    });
    lines.push("");
  }

  // ── File Diffs ────────────────────────────────────────────────────────
  if (d.fileDiffs.length > 0) {
    lines.push("## File Diffs", "");
    for (const fd of d.fileDiffs) {
      lines.push(`### ${fd.toolName || "unknown"}: ${fd.path ?? fd.callId}`, "");
      if (fd.diff) {
        lines.push("```diff", fd.diff, "```");
      } else if (fd.raw) {
        lines.push("```", fd.raw, "```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderJson(d: ReportData): string {
  const chainInfo = d.chainResult.ok
    ? { ok: true, chainHead: d.chainHead ?? null }
    : {
        ok: false,
        firstBadId: (d.chainResult as { ok: false; firstBadId: number }).firstBadId,
        chainHead: d.chainHead ?? null,
      };

  const obj = {
    schemaVersion: "1.0",
    session: {
      id: d.session.id,
      model: d.session.model,
      workspaceRoot: d.session.workspaceRoot,
      createdAt: d.session.createdAt,
      updatedAt: d.session.updatedAt,
      eventCount: d.session.eventCount,
      title: d.session.title ?? null,
    },
    auditChain: chainInfo,
    cost:
      typeof d.totalCostUsd === "number"
        ? { usd: d.totalCostUsd }
        : { usd: null, note: "unknown — cost is tracked by Engine at runtime" },
    decisionRecord: d.decisionRecord,
    transcript: d.transcript,
    toolCalls: d.toolCalls,
    fileDiffs: d.fileDiffs,
  };

  return JSON.stringify(obj, null, 2);
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool Results";
    default:
      return role;
  }
}

// ─── Re-export signing primitives for CLI convenience ─────────────────────

export { generateEd25519KeyPair, loadOrGenerateKeyPair } from "./signing";
