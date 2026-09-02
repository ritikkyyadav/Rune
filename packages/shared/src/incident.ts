// ─── Incident contracts (the Black Box vocabulary) ───
// Shared by the recorder (packages/telemetry), the engine/loop tap sites, and
// the CLI surfaces (doctor / incidents / bug). Lives in shared so tap sites
// never need to depend on the telemetry package itself — they speak in these
// types through a narrow callback.

import { createHash } from "node:crypto";

/**
 * Hierarchical incident classes, `family.kind`. Families:
 *  - provider.*  — LLM provider / gateway failures and degradations
 *  - tool.*      — tool execution failures (built-in, MCP, rust bridge)
 *  - loop.*      — agent-loop reliability events (breakers, gates, nudges)
 *  - context.*   — context-engine pressure events
 *  - struggle.*  — behavioral struggle signals (no exception was thrown)
 *  - crash.*     — process-level failures
 *  - ux.*        — user-originated reports
 */
export const INCIDENT_CLASSES = [
  "provider.rate_limit",
  "provider.rate_limit_wait",
  "provider.auth",
  "provider.no_credits",
  "provider.stream_error",
  "provider.terminal",
  "provider.fallback_triggered",
  "provider.truncation",
  "provider.malformed_tool_json_salvaged",
  "provider.malformed_tool_json_fatal",
  "provider.empty_completion",
  "tool.exec_failure",
  "tool.invalid_input",
  "tool.timeout",
  "tool.sandbox_denial",
  "tool.path_violation",
  "tool.permission_denied",
  "tool.mcp_error",
  "loop.repeated_call_refused",
  /** A tool declared an outputSchema and returned something that does not match it. */
  "loop.schema_violation",
  "loop.same_shape_failures",
  "loop.same_shape_refused",
  "loop.stuck_nudge",
  "loop.infinite_loop",
  "loop.barren_nudge",
  "loop.barren_turns",
  "loop.auto_halt",
  "loop.auto_halt_reported",
  /**
   * A step Auto held was then approved and run unchanged by the user. The
   * containment stopped an action that was fine — the direction of error that
   * costs trust rather than safety, and the ground truth the corpus is
   * labelled from.
   */
  "auto.supervisor_false_positive",
  "loop.evidence_gate",
  "loop.delegation_gate",
  "loop.verification_failed",
  "loop.consecutive_errors",
  "loop.max_turns",
  "loop.second_wind",
  "loop.user_abort",
  "loop.plan_nudge",
  "loop.replan_nudge",
  "loop.struggle_nudge",
  "loop.greenfield_nudge",
  "loop.art_direction_nudge",
  "loop.fix_verified_gate",
  "loop.product_sight_gate",
  "loop.batch_nudge",
  "loop.wrapup_reserve",
  "loop.effort_routed",
  "loop.effort_latched",
  "loop.effort_released",
  "loop.handoff",
  // The plan as a ledger: step completions judged by evidence, the step
  // check at a step boundary, the open-steps finish gate, the results-side
  // progress breaker, and the goal rolling to a pending follow-up.
  "loop.step_refused",
  "loop.step_check_passed",
  "loop.step_check_failed",
  "loop.open_steps_gate",
  "loop.open_steps",
  "loop.stale_nudge",
  "loop.stalled",
  "loop.goal_rolled",
  "context.forced_compaction",
  "context.budget_overflow",
  "context.freshness_mismatch",
  "struggle.thrash_reads",
  "struggle.thrash_edits",
  "struggle.thrash_search",
  "struggle.rephrase",
  "struggle.correction",
  "struggle.interrupt_burst",
  "struggle.todo_unfinished",
  "struggle.abandoned_midtask",
  "crash.uncaught_exception",
  "crash.unhandled_rejection",
  "crash.dirty_exit",
  "crash.rust_tool_panic",
  "crash.store_corruption",
  "ux.user_reported",
] as const;

export type IncidentClass = (typeof INCIDENT_CLASSES)[number];

/** The `family` part of an IncidentClass ("provider.auth" → "provider"). */
export function incidentFamily(cls: IncidentClass): string {
  return cls.split(".")[0] ?? cls;
}

/**
 * debug    — recovered invisibly (salvage worked, retry succeeded)
 * warn     — degraded but recovered (fallback, forced compaction, nudge)
 * error    — a tool or turn hard-failed
 * critical — crash, session loss, data risk
 */
export type IncidentSeverity = "debug" | "warn" | "error" | "critical";

export const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  debug: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/**
 * pending           — just captured; resolution unknown
 * recovered         — the run this belonged to completed fine
 * turn_failed       — the run ended in an unrecoverable error
 * user_interrupted  — the user aborted the run
 * abandoned         — never resolved; session was never resumed
 * crash             — the process died before resolution
 */
export type IncidentOutcome =
  "pending" | "recovered" | "turn_failed" | "user_interrupted" | "abandoned" | "crash";

/** One compact entry in the flight trail: what Gear did leading up to an incident. */
export interface TrailEntry {
  /** Monotonic position within the run's trail (not the session event seq). */
  seq: number;
  /** Event kind, e.g. "user_msg", "tool:bash", "text", "notice". */
  kind: string;
  /** One-line human summary, pre-redacted, capped. */
  summary: string;
}

/** Machine context captured with an incident — all cheap, all optional. */
export interface IncidentContext {
  provider?: string;
  model?: string;
  tier?: string;
  tool?: string;
  argsHash?: string;
  retries?: number;
  status?: number;
  permissionMode?: string;
  ui?: string;
  [key: string]: string | number | boolean | undefined;
}

/** What a tap site supplies. The recorder fills in the rest. */
export interface IncidentInput {
  class: IncidentClass;
  severity: IncidentSeverity;
  /** Component that observed it: "gateway", "agent-loop", "tool:edit_file", "tui", … */
  component: string;
  /** Code site, "module#function" — greppable, stable. */
  where: string;
  message: string;
  /** Optional stack trace (app frames). Redacted before storage. */
  stack?: string;
  context?: IncidentContext;
}

/** The full stored record. */
export interface IncidentRecord extends IncidentInput {
  id: string;
  ts: string;
  version: string;
  sessionId: string | null;
  turn: number | null;
  trail: TrailEntry[];
  outcome: IncidentOutcome;
  fingerprint: string;
}

/**
 * Narrow reporting seam for tap sites (agent-loop, gateway adapters). Kept as a
 * bare function type so packages below the orchestrator never import telemetry.
 */
export type IncidentReporter = (input: IncidentInput) => void;

// ─── Fingerprinting ───
// Same defect ⇒ same fingerprint across sessions and versions, so repetition
// becomes a counter instead of spam. Normalization strips the volatile parts
// of a message (numbers, ids, paths, quoted payloads) while keeping its shape.

export function normalizeForFingerprint(message: string): string {
  let s = message.toLowerCase();
  // strip quoted payloads first (paths/args often live inside quotes)
  s = s
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/`[^`]*`/g, "`…`");
  // absolute and home-relative paths
  s = s.replace(/(?:~|\/)[\w.@+-]+(?:\/[\w.@+-]+)+/g, "<path>");
  // uuids, long hex (hashes), then remaining digit runs
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  s = s.replace(/\b[0-9a-f]{8,}\b/g, "<hex>");
  s = s.replace(/\d+/g, "#");
  // collapse whitespace, cap length
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 200);
}

export function fingerprintIncident(
  cls: IncidentClass,
  component: string,
  message: string,
): string {
  const basis = `${cls}|${component}|${normalizeForFingerprint(message)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
