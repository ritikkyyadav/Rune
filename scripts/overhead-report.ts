#!/usr/bin/env bun
/**
 * Where a Rune run's cost and wall clock actually go, per role.
 *
 * Phase 3A's measurement instrument. It reads stored session databases
 * READ-ONLY, segments every session into runs (one user turn each), attributes
 * every completion to a role, and reports distributions rather than one total
 * — because the mean of 683 sessions describes no run anyone ever had.
 *
 *   bun run scripts/overhead-report.ts [--db PATH] [--out PATH] [--no-pilots] [--print]
 *
 * `JSON.stringify(…, 2)` differs from Prettier on one point — Prettier collapses
 * a short array onto one line — so regenerating the checked-in report needs a
 * `npx prettier --write docs/evidence/overhead-report-20260911.json` after it,
 * or `bun run format:check` goes red on a file nothing semantically changed.
 *
 * Two corpora, deliberately kept apart:
 *
 *   corpus  the founder's ~/.rune/rune.db — 683 sessions of real work, mixed
 *           models, mixed routes, mixed builds. Broad, and only 15% of its
 *           cost rows carry a role tag, so most of it is INFERRED.
 *   pilots  the per-run databases under .codex/**\/profile/rune.db that the
 *           comparison harness wrote. One task each, one build each, and
 *           100% role-tagged: exact attribution on controlled runs.
 *
 * ZERO model calls, zero network, zero writes to any source database. The only
 * file written is the JSON report, and it carries aggregate numbers only: no
 * prompt text, no file contents, no tool arguments, no provider response
 * bodies. Notice text is reduced to a stable label before it is counted, so
 * the report cannot leak a workspace path through a gate message.
 *
 * ## Why the attribution is two-tier
 *
 * `CostEntry.role` (packages/llm-gateway/src/types.ts:360) exists and is
 * plumbed — but only from 2026-09-07, and only by callers that pass it. On the
 * founder's database 437 of 2,931 cost rows carry it. Everything else has to
 * be INFERRED from the event sequence around it, so this script:
 *
 *   1. runs the inference on every row with the tag hidden;
 *   2. compares the inference to the tag on the rows that have one;
 *   3. reports that agreement as the inference's MEASURED accuracy.
 *
 * A heuristic whose error is unmeasured is a guess. This one is measured.
 */

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

// ─── CLI ───

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const REPO_ROOT = resolve(import.meta.dir, "..");
const DB_PATH = resolve(flag("db") ?? join(homedir(), ".rune", "rune.db"));
const BLACKBOX_PATH = resolve(flag("blackbox") ?? join(homedir(), ".rune", "blackbox.db"));
const PILOT_ROOT = resolve(flag("pilots") ?? join(REPO_ROOT, ".codex"));
const OUT_PATH = resolve(
  flag("out") ?? join(REPO_ROOT, "docs", "evidence", "overhead-report-20260911.json"),
);
const WITH_PILOTS = !process.argv.includes("--no-pilots");
const PRINT = process.argv.includes("--print");

// ─── Eras ───
//
// Both boundaries are commit timestamps on `gear/phase-0-stabilize`, in UTC.
// A run is placed by its first event's timestamp.

/** `897b192` "harness: audit follow-through, the Codex cache fold, and the step-count leaks". */
const STEP_COUNT_FIX_AT = "2026-09-10T02:36:44.000Z";
/** `54459b0` "protocol: one lifecycle event…" — the first Phase 2 commit. */
const PHASE_2_AT = "2026-09-10T15:35:30.000Z";

const ERAS = ["pre-step-count-fix", "post-step-count-fix", "phase-2"] as const;
type Era = (typeof ERAS)[number];

function eraOf(iso: string, hasLifecycleRow: boolean): Era {
  if (hasLifecycleRow || iso >= PHASE_2_AT) return "phase-2";
  if (iso >= STEP_COUNT_FIX_AT) return "post-step-count-fix";
  return "pre-step-count-fix";
}

// ─── Role taxonomy (the handoff's, not the gateway's) ───
//
// The gateway's CallRole says which CALLER made a request. This taxonomy says
// what the completion was FOR, which is the question Phase 3 asks. They differ
// in two places on purpose: a `primary` completion that only wrote todos is
// planning, and a `primary` completion the harness re-prompted for is a
// follow-up. Both are still the agent's own model — but they are overhead the
// HARNESS chose, and the ledger has to be able to say so.

const ROLES = [
  "primary",
  "planning",
  "supervisor_review",
  "compaction",
  "workers",
  "retries",
  "harness_followups",
  "unattributable",
] as const;
type Role = (typeof ROLES)[number];

/** Roles that are a separate model call the harness made, not the agent's turn. */
const HARNESS_OWN_CALL = new Set<Role>(["supervisor_review", "compaction", "workers"]);

/** Tool calls that move the harness's own bookkeeping, not the user's files. */
const PLANNING_TOOLS = new Set([
  "todo_write",
  "todo_read",
  "read_back",
  "record_evidence",
  "record_decision",
  "note_hypothesis",
  "narrate",
  "update_plan",
  "plan",
  "set_goal",
  "ask_user",
]);

/** Tool calls that change the workspace — what "the last useful edit" means. */
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "create_file",
  "apply_patch",
  "multi_edit",
  "str_replace",
  "notebook_edit",
  "mcp_filesystem_write_file",
]);

/** Tool calls that dispatch a worker or a research sub-run. */
const WORKER_TOOLS = new Set([
  "task",
  "worker",
  "research",
  "subagent",
  "delegate",
  "dispatch",
  "spawn_worker",
]);

/** How a gateway CallRole maps onto this taxonomy, when the tag is present. */
const TAG_TO_ROLE: Record<string, Role> = {
  primary: "primary",
  classifier: "supervisor_review",
  supervisor: "supervisor_review",
  summarizer: "compaction",
  intent: "planning",
  memory: "compaction",
  repair: "retries",
  subagent: "workers",
  research: "workers",
};

// ─── Event skeleton ───
//
// Deliberately NOT `SELECT payload_json`: every field is extracted in SQL, so
// no prompt text, tool argument or file body enters this process. The one
// string that does is a run_trace notice — a harness-authored constant, and it
// is reduced to a label before it is counted.

interface Ev {
  session: string;
  seq: number;
  type: string;
  at: string;
  atMs: number;
  role: string | null;
  model: string | null;
  provider: string | null;
  billing: string | null;
  priced: number | null;
  estimated: number | null;
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  listUsd: number;
  compTotal: number | null;
  compDoctrine: number | null;
  compSchemas: number | null;
  compConversation: number | null;
  compPlanLedger: number | null;
  compTaskState: number | null;
  harness: string | null;
  traceType: string | null;
  traceMessage: string | null;
  waitMs: number | null;
  sdStage: number | null;
  sdSource: string | null;
  sdTier: string | null;
  sdDurationMs: number | null;
  sdClassifierMs: number | null;
  sdRetryMs: number | null;
  sdMechanicalMs: number | null;
  toolUseCount: number | null;
  contentLen: number | null;
  beforeTokens: number | null;
  afterTokens: number | null;
}

const SKELETON_SQL = `
SELECT
  e.session_id                                                        AS session,
  e.seq                                                               AS seq,
  e.type                                                              AS type,
  e.created_at                                                        AS at,
  json_extract(e.payload_json, '$.payload.role')                      AS role,
  json_extract(e.payload_json, '$.payload.model')                     AS model,
  json_extract(e.payload_json, '$.payload.provider')                  AS provider,
  json_extract(e.payload_json, '$.payload.billing')                   AS billing,
  json_extract(e.payload_json, '$.payload.priced')                    AS priced,
  json_extract(e.payload_json, '$.payload.estimated')                 AS estimated,
  json_extract(e.payload_json, '$.payload.inputTokens')               AS inTok,
  json_extract(e.payload_json, '$.payload.outputTokens')              AS outTok,
  json_extract(e.payload_json, '$.payload.cacheReadTokens')           AS cacheRead,
  json_extract(e.payload_json, '$.payload.cacheCreationTokens')       AS cacheWrite,
  json_extract(e.payload_json, '$.payload.costUsd')                   AS costUsd,
  json_extract(e.payload_json, '$.payload.listCostUsd')               AS listUsd,
  json_extract(e.payload_json, '$.payload.composition.total')         AS compTotal,
  json_extract(e.payload_json, '$.payload.composition.doctrine')      AS compDoctrine,
  json_extract(e.payload_json, '$.payload.composition.toolSchemas')   AS compSchemas,
  json_extract(e.payload_json, '$.payload.composition.conversation')  AS compConversation,
  json_extract(e.payload_json, '$.payload.composition.planLedger')    AS compPlanLedger,
  json_extract(e.payload_json, '$.payload.composition.taskState')     AS compTaskState,
  CASE WHEN e.type = 'user_msg'
       THEN json_extract(e.payload_json, '$.payload.harness') END     AS harness,
  CASE WHEN e.type = 'run_trace'
       THEN json_extract(e.payload_json, '$.payload.type') END        AS traceType,
  CASE WHEN e.type = 'run_trace'
       THEN json_extract(e.payload_json, '$.payload.message') END     AS traceMessage,
  json_extract(e.payload_json, '$.payload.waitMs')                    AS waitMs,
  CASE WHEN e.type = 'safety_decision'
       THEN json_extract(e.payload_json, '$.payload.stage') END       AS sdStage,
  CASE WHEN e.type = 'safety_decision'
       THEN json_extract(e.payload_json, '$.payload.source') END      AS sdSource,
  CASE WHEN e.type = 'safety_decision'
       THEN json_extract(e.payload_json, '$.payload.tier') END        AS sdTier,
  CASE WHEN e.type = 'safety_decision'
       THEN json_extract(e.payload_json, '$.payload.durationMs') END  AS sdDurationMs,
  json_extract(e.payload_json, '$.payload.timings.classifierMs')      AS sdClassifierMs,
  json_extract(e.payload_json, '$.payload.timings.retryMs')           AS sdRetryMs,
  json_extract(e.payload_json, '$.payload.timings.mechanicalMs')      AS sdMechanicalMs,
  CASE WHEN e.type = 'assistant_msg'
       THEN json_array_length(json_extract(e.payload_json, '$.payload.toolUses')) END AS toolUseCount,
  CASE WHEN e.type = 'assistant_msg'
       THEN length(json_extract(e.payload_json, '$.payload.content')) END             AS contentLen,
  json_extract(e.payload_json, '$.payload.beforeTokens')              AS beforeTokens,
  json_extract(e.payload_json, '$.payload.afterTokens')               AS afterTokens
FROM events e
ORDER BY e.session_id, e.seq
`;

const TOOL_NAMES_SQL = `
SELECT e.session_id AS session, e.seq AS seq, json_extract(j.value, '$.toolName') AS tool
FROM events e, json_each(json_extract(e.payload_json, '$.payload.toolUses')) j
WHERE e.type = 'assistant_msg'
`;

const TODO_STATE_SQL = `
SELECT e.session_id AS session, e.seq AS seq,
       COUNT(*) AS total,
       SUM(CASE WHEN json_extract(j.value, '$.status') IN ('completed','dropped','cancelled')
                THEN 0 ELSE 1 END) AS open
FROM events e, json_each(json_extract(e.payload_json, '$.payload.items')) j
WHERE e.type = 'run_trace'
  AND json_extract(e.payload_json, '$.payload.type') = 'todo_updated'
GROUP BY 1, 2
`;

/**
 * Gate and replan entries in the task spine's own log, with their timestamps,
 * de-duplicated across the cumulative snapshots that carry them. These are the
 * only retroactive record of a gate firing before the origin markers landed.
 */
const SPINE_GATE_SQL = `
SELECT DISTINCT e.session_id AS session,
       json_extract(l.value, '$.at')   AS at,
       json_extract(l.value, '$.kind') AS kind
FROM events e, json_each(json_extract(e.payload_json, '$.payload.state.log')) l
WHERE e.type = 'task_state'
  AND json_extract(l.value, '$.kind') IN ('gate', 'replan')
`;

// ─── Helpers ───

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const nullNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function round(v: number | null, places = 4): number | null {
  if (v === null) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function dist(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    sum: round(sum),
    mean: s.length ? round(sum / s.length) : null,
    median: round(quantile(s, 0.5)),
    p90: round(quantile(s, 0.9)),
    max: s.length ? round(s[s.length - 1]!) : null,
  };
}

/**
 * A run_trace notice reduced to a stable label. The raw message can carry a
 * workspace URL (the UI-review notice does), so it never reaches the report.
 */
function noticeLabel(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("turn budget")) return "turn-budget-wrapup";
  if (m.includes("rate limited")) return "provider-rate-limit-wait";
  if (m.includes("never viewed") || m.includes("ui review")) return "product-sight-gate";
  if (m.includes("verification failed")) return "verification-retry";
  if (m.includes("fully refused")) return "barren-breaker";
  if (m.includes("repeating tool call")) return "tool-loop-nudge";
  if (m.includes("same result keeps")) return "result-loop-nudge";
  if (m.includes("halted the run")) return "auto-halt-report";
  if (m.includes("still open")) return "open-steps-gate";
  if (m.includes("re-plan")) return "replan-nudge";
  if (m.includes("execution evidence")) return "execution-evidence-gate";
  if (m.includes("verified check")) return "fix-verified-gate";
  if (m.includes("delegated")) return "delegation-evidence-gate";
  return "other";
}

/** Notices that re-prompt the model. Each costs at least one completion. */
const REPROMPT_NOTICES = new Set([
  "turn-budget-wrapup",
  "product-sight-gate",
  "verification-retry",
  "barren-breaker",
  "tool-loop-nudge",
  "result-loop-nudge",
  "auto-halt-report",
  "open-steps-gate",
  "replan-nudge",
  "execution-evidence-gate",
  "fix-verified-gate",
  "delegation-evidence-gate",
]);

// ─── One database, read ───

interface Corpus {
  path: string;
  events: Ev[];
  toolsAt: Map<string, string[]>;
  todoAt: Map<string, { total: number; open: number }>;
  spineGates: Map<string, Array<{ atMs: number; kind: string }>>;
  sessions: number;
  eventCount: number;
}

function load(path: string): Corpus {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(SKELETON_SQL).all() as Array<Record<string, unknown>>;
    const toolRows = db.query(TOOL_NAMES_SQL).all() as Array<{
      session: string;
      seq: number;
      tool: string | null;
    }>;
    const todoRows = db.query(TODO_STATE_SQL).all() as Array<{
      session: string;
      seq: number;
      total: number;
      open: number;
    }>;
    const gateRows = db.query(SPINE_GATE_SQL).all() as Array<{
      session: string;
      at: string | null;
      kind: string;
    }>;
    const sessions = (db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const eventCount = (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    const toolsAt = new Map<string, string[]>();
    for (const t of toolRows) {
      if (!t.tool) continue;
      const k = `${t.session}#${t.seq}`;
      const list = toolsAt.get(k);
      if (list) list.push(t.tool);
      else toolsAt.set(k, [t.tool]);
    }
    const todoAt = new Map<string, { total: number; open: number }>();
    for (const t of todoRows) todoAt.set(`${t.session}#${t.seq}`, { total: t.total, open: t.open });
    const spineGates = new Map<string, Array<{ atMs: number; kind: string }>>();
    for (const g of gateRows) {
      if (!g.at) continue;
      const list = spineGates.get(g.session) ?? [];
      list.push({ atMs: Date.parse(g.at), kind: g.kind });
      spineGates.set(g.session, list);
    }

    const events: Ev[] = rows.map((r) => ({
      session: String(r.session),
      seq: Number(r.seq),
      type: String(r.type),
      at: String(r.at),
      atMs: Date.parse(String(r.at)),
      role: (r.role as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      billing: (r.billing as string | null) ?? null,
      priced: nullNum(r.priced),
      estimated: nullNum(r.estimated),
      inTok: num(r.inTok),
      outTok: num(r.outTok),
      cacheRead: num(r.cacheRead),
      cacheWrite: num(r.cacheWrite),
      costUsd: num(r.costUsd),
      listUsd: num(r.listUsd),
      compTotal: nullNum(r.compTotal),
      compDoctrine: nullNum(r.compDoctrine),
      compSchemas: nullNum(r.compSchemas),
      compConversation: nullNum(r.compConversation),
      compPlanLedger: nullNum(r.compPlanLedger),
      compTaskState: nullNum(r.compTaskState),
      harness: (r.harness as string | null) ?? null,
      traceType: (r.traceType as string | null) ?? null,
      traceMessage: (r.traceMessage as string | null) ?? null,
      waitMs: nullNum(r.waitMs),
      sdStage: nullNum(r.sdStage),
      sdSource: (r.sdSource as string | null) ?? null,
      sdTier: (r.sdTier as string | null) ?? null,
      sdDurationMs: nullNum(r.sdDurationMs),
      sdClassifierMs: nullNum(r.sdClassifierMs),
      sdRetryMs: nullNum(r.sdRetryMs),
      sdMechanicalMs: nullNum(r.sdMechanicalMs),
      toolUseCount: nullNum(r.toolUseCount),
      contentLen: nullNum(r.contentLen),
      beforeTokens: nullNum(r.beforeTokens),
      afterTokens: nullNum(r.afterTokens),
    }));
    return { path, events, toolsAt, todoAt, spineGates, sessions, eventCount };
  } finally {
    db.close();
  }
}

// ─── Runs ───

interface Run {
  session: string;
  index: number;
  events: Ev[];
  era: Era;
  auto: boolean;
  free: boolean;
}

function segment(c: Corpus): Run[] {
  const bySession = new Map<string, Ev[]>();
  for (const e of c.events) {
    const list = bySession.get(e.session);
    if (list) list.push(e);
    else bySession.set(e.session, [e]);
  }
  const runs: Run[] = [];
  for (const [session, evs] of bySession) {
    const boundaries: number[] = [];
    evs.forEach((e, i) => {
      if (e.type === "user_msg" && !e.harness) boundaries.push(i);
    });
    if (boundaries.length === 0 || boundaries[0] !== 0) boundaries.unshift(0);
    const hasLifecycle = evs.some((e) => e.traceType === "lifecycle");
    for (let b = 0; b < boundaries.length; b++) {
      const from = boundaries[b]!;
      const to = b + 1 < boundaries.length ? boundaries[b + 1]! : evs.length;
      const slice = evs.slice(from, to);
      const costs = slice.filter((e) => e.type === "cost");
      if (costs.length === 0) continue; // "runs that have usage rows"
      const billings = new Set(costs.map((x) => x.billing ?? "unknown"));
      runs.push({
        session,
        index: b,
        events: slice,
        era: eraOf(slice[0]!.at, hasLifecycle),
        // Any safety_decision row means Auto reviewed a call: every writer of
        // that event is an Auto path (engine.ts:2241, :3152 -> :3354, :3298,
        // :6135). A run where Auto was on but no tool was reviewed reads as
        // non-Auto, which understates Auto and never overstates it.
        auto: slice.some((e) => e.type === "safety_decision"),
        // Paid when ANY completion was metered. Rows with no billing field
        // (pre-P12.1) count as free, which understates paid, never overstates.
        free: !billings.has("metered"),
      });
    }
  }
  return runs;
}

// ─── Attribution ───

interface Slice {
  ev: Ev;
  role: Role;
  exact: boolean;
  rule: string;
  inferred: Role;
}

/**
 * Attribute one completion from the event sequence, with the role tag hidden.
 *
 * `window` is every event strictly between this cost row and the next one.
 * The engine records a completion's cost on the gateway's usage listener
 * (packages/orchestrator/src/engine.ts:6289) BEFORE draining the assistant
 * message it produced, so the window is exactly "what this completion did".
 *
 * `since` is every event between the PREVIOUS cost row and this one — what
 * caused this completion to be made.
 *
 * Rule order is a precedence, and each rule's measured accuracy against the
 * tagged rows is reported in `labelledAgreement`.
 */
function infer(
  c: Corpus,
  run: Run,
  idx: number,
  window: Ev[],
  since: Ev[],
): { role: Role; rule: string } {
  // 1. A model-backed safety decision in the window. Measured on the founder's
  //    database: all 39 governance-tagged cost rows are followed, before the
  //    next cost row, by a safety_decision with classifierMs > 0; exactly one
  //    primary-tagged row is. Precision 39/40.
  if (window.some((e) => e.type === "safety_decision" && num(e.sdClassifierMs) > 0))
    return { role: "supervisor_review", rule: "model-backed safety_decision in the window" };

  // 2. Compaction leaves its own row.
  if (window.some((e) => e.type === "auto_compaction" || e.type === "compaction"))
    return { role: "compaction", rule: "compaction row in the window" };

  const assistant = window.find((e) => e.type === "assistant_msg");

  // 3. A worker is in flight: the nearest preceding assistant message
  //    dispatched one and its tool result has not come back. A worker's
  //    completions are charged to the parent session but never enter the
  //    parent transcript. Measured: 12 of 12 subagent-tagged rows.
  if (!assistant) {
    let inFlight = false;
    for (let j = idx - 1; j >= 0; j--) {
      const x = run.events[j]!;
      if (x.type === "tool_result") break;
      if (x.type === "assistant_msg") {
        const ts = c.toolsAt.get(`${x.session}#${x.seq}`) ?? [];
        inFlight = ts.some((t) => WORKER_TOOLS.has(t));
        break;
      }
    }
    if (inFlight) return { role: "workers", rule: "a worker dispatch was in flight" };
  }

  const retried = since.some((e) => e.traceType === "retry");
  const cost = run.events[idx]!;
  const prevCostMs = (() => {
    for (let j = idx - 1; j >= 0; j--)
      if (run.events[j]!.type === "cost") return run.events[j]!.atMs;
    return run.events[0]!.atMs;
  })();
  const gateBetween = (c.spineGates.get(run.session) ?? []).some(
    (g) => g.atMs > prevCostMs && g.atMs <= cost.atMs,
  );
  const causedByHarness =
    since.some((e) => e.type === "user_msg" && !!e.harness) ||
    since.some(
      (e) => e.traceType === "notice" && REPROMPT_NOTICES.has(noticeLabel(e.traceMessage ?? "")),
    ) ||
    gateBetween;

  if (assistant) {
    const tools = c.toolsAt.get(`${assistant.session}#${assistant.seq}`) ?? [];
    const empty = (assistant.toolUseCount ?? 0) === 0 && (assistant.contentLen ?? 0) <= 2;
    if (empty) return { role: "retries", rule: "the assistant message was empty" };
    if (retried) return { role: "retries", rule: "a provider retry was recorded before it" };
    if (causedByHarness)
      return { role: "harness_followups", rule: "a harness re-prompt preceded it" };
    if (tools.length > 0 && tools.every((t) => WORKER_TOOLS.has(t)))
      return { role: "workers", rule: "every tool call dispatched a worker" };
    if (tools.length > 0 && tools.every((t) => PLANNING_TOOLS.has(t)))
      return { role: "planning", rule: "every tool call was plan bookkeeping" };
    return { role: "primary", rule: "an assistant message with work in it" };
  }

  // 4. No assistant message persisted. Empty assistant messages are DROPPED at
  //    persistence (packages/orchestrator/src/engine.ts:5331), so this is
  //    either an empty completion or a harness call that left no other trace.
  if (retried) return { role: "retries", rule: "no assistant message, after a provider retry" };
  if (causedByHarness)
    return { role: "harness_followups", rule: "no assistant message, after a harness re-prompt" };
  return {
    role: "primary",
    rule: "no assistant message persisted and nothing names another caller",
  };
}

function attribute(c: Corpus, runs: Run[]): Slice[][] {
  return runs.map((run) => {
    const costIdx: number[] = [];
    run.events.forEach((e, i) => {
      if (e.type === "cost") costIdx.push(i);
    });
    return costIdx.map((i, k) => {
      const next = k + 1 < costIdx.length ? costIdx[k + 1]! : run.events.length;
      const prev = k > 0 ? costIdx[k - 1]! : -1;
      const ev = run.events[i]!;
      const guess = infer(c, run, i, run.events.slice(i + 1, next), run.events.slice(prev + 1, i));
      const tagged = ev.role ? TAG_TO_ROLE[ev.role] : undefined;
      // The tag wins for everything except `primary`: a row the gateway tagged
      // `primary` still has to be split into primary / planning / follow-up /
      // retry, which only the sequence can do.
      const useTag = tagged !== undefined && tagged !== "primary";
      return {
        ev,
        role: useTag ? tagged : guess.role,
        exact: useTag,
        rule: useTag ? `CostEntry.role = "${ev.role}"` : guess.rule,
        inferred: guess.role,
      };
    });
  });
}

// ─── Per-run measures ───

interface RunMeasure {
  era: Era;
  auto: boolean;
  free: boolean;
  completions: number;
  wallMs: number;
  costUsd: number;
  listUsd: number;
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
  reviewerBlockingMs: number;
  reviewerTotalMs: number;
  reviewerDecisions: number;
  reviewerModelBacked: number;
  retryWaitMs: number;
  retries: number;
  followups: number;
  compactions: number;
  completionsAfterPlanSettled: number;
  msAfterLastEdit: number | null;
  unpricedRows: number;
  byRole: Record<Role, { completions: number; costUsd: number; listUsd: number; ms: number }>;
}

function measure(c: Corpus, runs: Run[], slicesByRun: Slice[][]): RunMeasure[] {
  return runs.map((run, r) => {
    const slices = slicesByRun[r]!;
    const first = run.events[0]!;
    const last = run.events[run.events.length - 1]!;

    const byRole = Object.fromEntries(
      ROLES.map((role) => [role, { completions: 0, costUsd: 0, listUsd: 0, ms: 0 }]),
    ) as RunMeasure["byRole"];

    // Per-completion wall time: a completion owns the interval from the
    // previous completion's cost row to its own. Inference latency is recorded
    // nowhere (gap I3), so this is the only clock a completion has.
    let prevMs = first.atMs;
    for (const s of slices) {
      const b = byRole[s.role];
      b.completions++;
      b.costUsd += s.ev.costUsd;
      b.listUsd += s.ev.listUsd;
      b.ms += Math.max(0, s.ev.atMs - prevMs);
      prevMs = s.ev.atMs;
    }

    const sds = run.events.filter((e) => e.type === "safety_decision");
    const retryEvents = run.events.filter((e) => e.traceType === "retry");
    const notices = run.events
      .filter((e) => e.traceType === "notice")
      .map((e) => noticeLabel(e.traceMessage ?? ""))
      .filter((l) => REPROMPT_NOTICES.has(l));
    const harnessMsgs = run.events.filter((e) => e.type === "user_msg" && !!e.harness);
    const gates = (c.spineGates.get(run.session) ?? []).filter(
      (g) => g.atMs >= first.atMs && g.atMs <= last.atMs,
    );

    let settledAtSeq: number | null = null;
    for (const e of run.events) {
      if (e.traceType !== "todo_updated") continue;
      const t = c.todoAt.get(`${e.session}#${e.seq}`);
      if (t && t.total > 0 && t.open === 0) {
        settledAtSeq = e.seq;
        break;
      }
    }

    let lastEditMs: number | null = null;
    for (const e of run.events) {
      if (e.type !== "assistant_msg") continue;
      const tools = c.toolsAt.get(`${e.session}#${e.seq}`) ?? [];
      if (tools.some((t) => EDIT_TOOLS.has(t))) lastEditMs = e.atMs;
    }

    return {
      era: run.era,
      auto: run.auto,
      free: run.free,
      completions: slices.length,
      wallMs: Math.max(0, last.atMs - first.atMs),
      costUsd: slices.reduce((a, s) => a + s.ev.costUsd, 0),
      listUsd: slices.reduce((a, s) => a + s.ev.listUsd, 0),
      inTok: slices.reduce((a, s) => a + s.ev.inTok, 0),
      outTok: slices.reduce((a, s) => a + s.ev.outTok, 0),
      cacheRead: slices.reduce((a, s) => a + s.ev.cacheRead, 0),
      cacheWrite: slices.reduce((a, s) => a + s.ev.cacheWrite, 0),
      reviewerBlockingMs: sds.reduce((a, e) => a + num(e.sdClassifierMs) + num(e.sdRetryMs), 0),
      reviewerTotalMs: sds.reduce((a, e) => a + num(e.sdDurationMs), 0),
      reviewerDecisions: sds.length,
      reviewerModelBacked: sds.filter((e) => num(e.sdClassifierMs) > 0).length,
      retryWaitMs: retryEvents.reduce((a, e) => a + num(e.waitMs), 0),
      retries: retryEvents.length,
      followups: notices.length + harnessMsgs.length + gates.length,
      compactions: run.events.filter((e) => e.type === "auto_compaction" || e.type === "compaction")
        .length,
      completionsAfterPlanSettled:
        settledAtSeq === null ? 0 : slices.filter((s) => s.ev.seq > settledAtSeq!).length,
      msAfterLastEdit: lastEditMs === null ? null : Math.max(0, last.atMs - lastEditMs),
      unpricedRows: slices.filter((s) => s.ev.priced === null || s.ev.priced === 0).length,
      byRole,
    };
  });
}

// ─── Aggregation ───

function aggregate(subset: RunMeasure[]) {
  const roleTotals = Object.fromEntries(
    ROLES.map((role) => [role, { completions: 0, costUsd: 0, listUsd: 0, ms: 0, runs: 0 }]),
  ) as Record<
    Role,
    { completions: number; costUsd: number; listUsd: number; ms: number; runs: number }
  >;
  for (const m of subset) {
    for (const role of ROLES) {
      const b = m.byRole[role];
      if (b.completions === 0) continue;
      roleTotals[role].completions += b.completions;
      roleTotals[role].costUsd += b.costUsd;
      roleTotals[role].listUsd += b.listUsd;
      roleTotals[role].ms += b.ms;
      roleTotals[role].runs++;
    }
  }
  const totalList = Object.values(roleTotals).reduce((a, b) => a + b.listUsd, 0);
  const totalMs = Object.values(roleTotals).reduce((a, b) => a + b.ms, 0);
  const totalCompletions = Object.values(roleTotals).reduce((a, b) => a + b.completions, 0);
  return {
    runs: subset.length,
    completions: totalCompletions,
    listCostUsd: round(totalList, 6),
    paidCostUsd: round(
      subset.reduce((a, m) => a + m.costUsd, 0),
      6,
    ),
    attributedMs: totalMs,
    byRole: ROLES.map((role) => {
      const b = roleTotals[role];
      return {
        role,
        completions: b.completions,
        completionShare: totalCompletions ? round(b.completions / totalCompletions, 4) : null,
        listCostUsd: round(b.listUsd, 6),
        costShare: totalList > 0 ? round(b.listUsd / totalList, 4) : null,
        wallMs: b.ms,
        wallShare: totalMs > 0 ? round(b.ms / totalMs, 4) : null,
        runsTouched: b.runs,
        runShare: subset.length ? round(b.runs / subset.length, 4) : null,
      };
    }).sort((a, b) => (b.costShare ?? 0) - (a.costShare ?? 0)),
    distributions: {
      completionsPerRun: dist(subset.map((m) => m.completions)),
      wallSecondsPerRun: dist(subset.map((m) => m.wallMs / 1000)),
      listUsdPerRun: dist(subset.map((m) => m.listUsd)),
      outputTokensPerRun: dist(subset.map((m) => m.outTok)),
      freshInputTokensPerRun: dist(subset.map((m) => m.inTok)),
      reviewerBlockingSecondsPerRun: dist(subset.map((m) => m.reviewerBlockingMs / 1000)),
      reviewerDecisionsPerRun: dist(subset.map((m) => m.reviewerDecisions)),
      followupsPerRun: dist(subset.map((m) => m.followups)),
      retriesPerRun: dist(subset.map((m) => m.retries)),
      retryWaitSecondsPerRun: dist(subset.map((m) => m.retryWaitMs / 1000)),
      compactionsPerRun: dist(subset.map((m) => m.compactions)),
      completionsAfterPlanSettled: dist(subset.map((m) => m.completionsAfterPlanSettled)),
      secondsAfterLastEdit: dist(
        subset.filter((m) => m.msAfterLastEdit !== null).map((m) => m.msAfterLastEdit! / 1000),
      ),
      cacheHitRatio: dist(
        subset
          .filter((m) => m.inTok + m.cacheRead > 0)
          .map((m) => m.cacheRead / (m.inTok + m.cacheRead)),
      ),
      // EXACT shares, from timings the harness records — not from the
      // interval attribution, which cannot see a concurrent reviewer.
      reviewerBlockingShareOfRun: dist(
        subset.filter((m) => m.wallMs > 0).map((m) => m.reviewerBlockingMs / m.wallMs),
      ),
      shareOfRunAfterLastEdit: dist(
        subset
          .filter((m) => m.wallMs > 0 && m.msAfterLastEdit !== null)
          .map((m) => m.msAfterLastEdit! / m.wallMs),
      ),
      governanceCompletionShareOfRun: dist(
        subset
          .filter((m) => m.completions > 0)
          .map((m) => (m.completions - m.byRole.primary.completions) / m.completions),
      ),
      completionsAfterPlanSettledShare: dist(
        subset
          .filter((m) => m.completions > 0)
          .map((m) => m.completionsAfterPlanSettled / m.completions),
      ),
    },
    unpricedRows: subset.reduce((a, m) => a + m.unpricedRows, 0),
  };
}

function cacheByRole(slices: Slice[]) {
  const acc = Object.fromEntries(
    ROLES.map((r) => [r, { cacheRead: 0, fresh: 0, write: 0, out: 0, completions: 0 }]),
  ) as Record<
    Role,
    { cacheRead: number; fresh: number; write: number; out: number; completions: number }
  >;
  for (const s of slices) {
    const b = acc[s.role];
    b.cacheRead += s.ev.cacheRead;
    b.fresh += s.ev.inTok;
    b.write += s.ev.cacheWrite;
    b.out += s.ev.outTok;
    b.completions++;
  }
  return ROLES.map((role) => {
    const b = acc[role];
    const denom = b.cacheRead + b.fresh;
    return {
      role,
      completions: b.completions,
      freshInputTokens: b.fresh,
      cacheReadTokens: b.cacheRead,
      cacheCreationTokens: b.write,
      outputTokens: b.out,
      cacheHitRatio: denom > 0 ? round(b.cacheRead / denom, 4) : null,
      freshTokensPerCompletion: b.completions ? round(b.fresh / b.completions, 1) : null,
    };
  }).filter((r) => r.completions > 0);
}

function composition(events: Ev[]) {
  const withComp = events.filter((e) => e.type === "cost" && e.compTotal !== null);
  if (withComp.length === 0) return null;
  const sum = (f: (e: Ev) => number | null) => withComp.reduce((a, e) => a + num(f(e)), 0);
  const total = sum((e) => e.compTotal);
  const promptTokens = withComp.reduce((a, e) => a + e.inTok + e.cacheRead, 0);
  const fixed = sum((e) => e.compDoctrine) + sum((e) => e.compSchemas);
  return {
    measuredCompletions: withComp.length,
    bytes: {
      doctrine: sum((e) => e.compDoctrine),
      toolSchemas: sum((e) => e.compSchemas),
      conversation: sum((e) => e.compConversation),
      planLedger: sum((e) => e.compPlanLedger),
      taskState: sum((e) => e.compTaskState),
      total,
    },
    share: {
      doctrine: round(sum((e) => e.compDoctrine) / total, 4),
      toolSchemas: round(sum((e) => e.compSchemas) / total, 4),
      conversation: round(sum((e) => e.compConversation) / total, 4),
      planLedger: round(sum((e) => e.compPlanLedger) / total, 4),
      taskState: round(sum((e) => e.compTaskState) / total, 4),
    },
    /** Byte-weighted over every measured completion. */
    fixedOverheadShare: round(fixed / total, 4),
    /**
     * The same share computed PER COMPLETION and then distributed. The
     * byte-weighted number is dominated by long conversations; this one says
     * what a typical request looked like — and the spread between first and
     * last is the shape `run-economics.ts:44-55` exists to expose.
     */
    perCompletionFixedShare: dist(
      withComp
        .filter((e) => num(e.compTotal) > 0)
        .map((e) => (num(e.compDoctrine) + num(e.compSchemas)) / num(e.compTotal)),
    ),
    /** Measured, not assumed: assembled prompt BYTES per provider-counted prompt token. */
    bytesPerPromptToken: promptTokens > 0 ? round(total / promptTokens, 3) : null,
  };
}

function reviewerLatency(events: Ev[]) {
  const sds = events.filter((e) => e.type === "safety_decision");
  const modelBacked = sds.filter((e) => num(e.sdClassifierMs) > 0);
  const bySource = new Map<string, number[]>();
  for (const e of sds) {
    const k = e.sdSource ?? "unknown";
    const list = bySource.get(k) ?? [];
    list.push(num(e.sdDurationMs));
    bySource.set(k, list);
  }
  return {
    decisions: sds.length,
    modelBackedDecisions: modelBacked.length,
    mechanicalDecisions: sds.length - modelBacked.length,
    blockingMsAllDecisions: dist(sds.map((e) => num(e.sdClassifierMs) + num(e.sdRetryMs))),
    blockingMsModelBacked: dist(modelBacked.map((e) => num(e.sdClassifierMs) + num(e.sdRetryMs))),
    retryMsModelBacked: dist(modelBacked.map((e) => num(e.sdRetryMs))),
    byDecisionSource: [...bySource]
      .map(([source, v]) => ({ source, ...dist(v) }))
      .sort((a, b) => b.n - a.n),
  };
}

function ruleCounts(slices: Slice[]) {
  const acc = new Map<string, number>();
  for (const s of slices) acc.set(s.rule, (acc.get(s.rule) ?? 0) + 1);
  return [...acc].sort((a, b) => b[1] - a[1]).map(([rule, n]) => ({ rule, n }));
}

/**
 * The inference's measured accuracy.
 *
 * Two questions, and only the first has ground truth. `superClass` asks the
 * question the tag answers — was this a separate model call the harness made,
 * or the agent's own turn? `exactRole` asks whether the inferred role matches
 * the tag's mapping, which for `primary`-tagged rows is not a fair test: this
 * taxonomy deliberately splits `primary` into primary / planning / follow-up /
 * retry, and nothing in the database labels that split.
 */
function agreement(slices: Slice[]) {
  const byTag: Record<string, { n: number; exact: number; superClass: number }> = {};
  const confusion: Record<string, Record<string, number>> = {};
  let n = 0;
  let exact = 0;
  let superOk = 0;
  for (const s of slices) {
    const tag = s.ev.role;
    if (!tag) continue;
    const expected = TAG_TO_ROLE[tag];
    if (!expected) continue;
    n++;
    const b = (byTag[tag] ??= { n: 0, exact: 0, superClass: 0 });
    b.n++;
    if (s.inferred === expected) {
      exact++;
      b.exact++;
    }
    const expectedHarness = HARNESS_OWN_CALL.has(expected);
    const gotHarness = HARNESS_OWN_CALL.has(s.inferred);
    if (expectedHarness === gotHarness && s.inferred !== "unattributable") {
      superOk++;
      b.superClass++;
    }
    (confusion[tag] ??= {})[s.inferred] ??= 0;
    confusion[tag]![s.inferred]!++;
  }
  return {
    rowsWithRoleTag: n,
    exactRoleAgreement: n ? round(exact / n, 4) : null,
    superClassAgreement: n ? round(superOk / n, 4) : null,
    byTag,
    confusion,
    note:
      "superClassAgreement is the fair test: it asks whether the inference put the completion on " +
      "the right side of the only line the tag actually draws (a separate harness model call vs " +
      "the agent's own turn). exactRoleAgreement penalises the deliberate split of `primary` into " +
      "primary / planning / harness_followups / retries, which nothing in the database labels.",
  };
}

// ─── Analyse one corpus ───

function analyse(c: Corpus) {
  const runs = segment(c);
  const slicesByRun = attribute(c, runs);
  const flat = slicesByRun.flat();
  const measures = measure(c, runs, slicesByRun);
  return { c, runs, slicesByRun, flat, measures };
}

// ─── Load ───

const corpus = analyse(load(DB_PATH));

let incidentsByClass: Array<{ class: string; n: number }> = [];
try {
  const bb = new Database(BLACKBOX_PATH, { readonly: true });
  incidentsByClass = bb
    .query("SELECT class, COUNT(*) AS n FROM incidents GROUP BY class ORDER BY n DESC LIMIT 20")
    .all() as Array<{ class: string; n: number }>;
  bb.close();
} catch {
  incidentsByClass = [];
}

/** Every per-run database the comparison harness wrote, deepest-first. */
function findPilotDbs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name === "rune.db" && st.size > 0) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

const pilots: Array<Record<string, unknown>> = [];
if (WITH_PILOTS) {
  for (const p of findPilotDbs(PILOT_ROOT)) {
    let a: ReturnType<typeof analyse>;
    try {
      a = analyse(load(p));
    } catch {
      continue;
    }
    if (a.flat.length === 0) continue;
    const agg = aggregate(a.measures);
    pilots.push({
      run: relative(REPO_ROOT, p).replace(/\/profile\/rune\.db$/, ""),
      taggedRows: a.flat.filter((s) => s.ev.role !== null).length,
      completions: a.flat.length,
      models: [...new Set(a.flat.map((s) => s.ev.model ?? "unknown"))],
      providers: [...new Set(a.flat.map((s) => s.ev.provider ?? "unknown"))],
      wallSeconds: round(agg.distributions.wallSecondsPerRun.sum),
      listCostUsd: agg.listCostUsd,
      byRole: agg.byRole.filter((r) => r.completions > 0),
      cacheByRole: cacheByRole(a.flat),
      reviewer: reviewerLatency(a.c.events),
      composition: composition(a.c.events),
      followups: a.measures.reduce((x, m) => x + m.followups, 0),
      completionsAfterPlanSettled: a.measures.reduce(
        (x, m) => x + m.completionsAfterPlanSettled,
        0,
      ),
      secondsAfterLastEdit: round(
        a.measures.reduce((x, m) => x + (m.msAfterLastEdit ?? 0), 0) / 1000,
      ),
    });
  }
}

// ─── Report ───

const all = corpus.measures;
const auto = all.filter((m) => m.auto);
const nonAuto = all.filter((m) => !m.auto);

const report = {
  kind: "overhead-report",
  schema: 1,
  generatedAt: new Date().toISOString(),
  phase: "3A",
  script: "scripts/overhead-report.ts",
  source: {
    corpus: {
      db: DB_PATH,
      readonly: true,
      sessions: corpus.c.sessions,
      events: corpus.c.eventCount,
      costRows: corpus.c.events.filter((e) => e.type === "cost").length,
      costRowsWithRoleTag: corpus.c.events.filter((e) => e.type === "cost" && e.role !== null)
        .length,
      runsWithUsage: corpus.runs.length,
      sessionsWithUsage: new Set(corpus.runs.map((r) => r.session)).size,
      firstEvent: corpus.c.events[0]?.at ?? null,
      lastEvent: [...corpus.c.events].sort((a, b) => a.atMs - b.atMs).at(-1)?.at ?? null,
    },
    pilots: {
      root: relative(REPO_ROOT, PILOT_ROOT),
      databases: pilots.length,
      note:
        "Per-run databases written by tests/eval/comparison. One task, one build, one arm each, " +
        "and 100% role-tagged — exact attribution on controlled runs.",
    },
    blackbox: incidentsByClass.length > 0 ? BLACKBOX_PATH : null,
  },
  method: {
    runDefinition:
      "One user turn: from a user_msg with no `harness` marker to the event before the next one. " +
      "Session start opens the first run. A run with no cost row is excluded — the handoff's " +
      '"every run that has usage rows".',
    completionPairing:
      "The engine records a completion's cost on the gateway usage listener " +
      "(packages/orchestrator/src/engine.ts:6289) BEFORE draining the assistant message it " +
      "produced, so a cost row's window — the events between it and the next cost row — is " +
      "exactly what that completion did. Verified against the event order of the busiest session.",
    eras: {
      "pre-step-count-fix": `< ${STEP_COUNT_FIX_AT} (before 897b192)`,
      "post-step-count-fix": `>= ${STEP_COUNT_FIX_AT} (897b192: gate/nudge origins, settled-plan stand-down, recurrence detector, codex tail fold)`,
      "phase-2": `>= ${PHASE_2_AT} (54459b0) OR the session carries a run_trace lifecycle row`,
    },
    autoModeDetection:
      "EXACT: a run is Auto when it contains any safety_decision row. Every writer of that event " +
      "is an Auto path (packages/orchestrator/src/engine.ts:2241 held step, :3152 -> :3354 the " +
      "in-path review, :3298 the supervisor batch, :6135 the late verdict). A run where Auto was " +
      "on but no tool was reviewed reads as non-Auto; that understates Auto, never overstates it.",
    freeVsPaid:
      "CostEntry.billing. A run is paid when ANY completion was 'metered'. Rows with no billing " +
      "field (pre-P12.1) count as free, which understates paid.",
    exactAttributions: [
      "CostEntry.role, when present, for classifier/supervisor/summarizer/intent/memory/repair/" +
        "subagent/research (packages/llm-gateway/src/types.ts:360; set at agent-loop.ts:1667, " +
        "auto-mode.ts:531 and :913, context-engine.ts:974, engine.ts:2419 and :4236, " +
        "subagent-result.ts:581, worker.ts:672, subagent.ts:318, research.ts:628; carried through " +
        "gateway.ts:891 into cost-tracker.ts:274).",
      "Token counts, cache reads and cache writes: the provider's own usage block.",
      "Reviewer latency: safety_decision.timings {mechanicalMs, classifierMs, retryMs} " +
        "(packages/orchestrator/src/auto-mode.ts:1842) plus durationMs, persisted at engine.ts:3367.",
      "Provider retries and their back-off: run_trace type='retry' carrying waitMs.",
      "Compaction: auto_compaction / compaction events with before/after tokens.",
      "Prompt composition in BYTES: CostEntry.composition (packages/llm-gateway/src/types.ts:367).",
      "Gate and replan firings after 897b192: run_trace type='notice', and the task spine's own " +
        "log entries of kind gate/replan, which carry their own timestamps.",
    ],
    inferredAttributions: [
      "supervisor_review — a safety_decision with classifierMs > 0 sits in the completion's " +
        "window. Measured on the corpus: all 39 governance-tagged cost rows have one; exactly 1 " +
        "primary-tagged row does. Precision 39/40.",
      "compaction — a compaction / auto_compaction row sits in the window.",
      "workers — no assistant message, and the nearest preceding assistant message dispatched a " +
        "worker whose tool result had not returned. Measured: 12 of 12 subagent-tagged rows.",
      "retries — the assistant message was empty, or a run_trace retry was recorded since the " +
        "previous completion.",
      "harness_followups — a user_msg with a `harness` origin marker, a re-prompting run_trace " +
        "notice, or a spine gate/replan entry falls between the previous completion and this one. " +
        "This is the COMPLETION a gate caused, not the gate itself.",
      "planning — every tool call in the completion was plan bookkeeping " +
        `(${[...PLANNING_TOOLS].join(", ")}).`,
      "primary — an assistant message with work in it; or no assistant message persisted and " +
        "nothing naming another caller (empty assistant messages are dropped at engine.ts:5331, " +
        "so a genuinely empty completion lands here when no retry row accompanies it).",
    ],
    perCompletionWallClock:
      "INFERRED, and the weakest number in this report. No inference latency is recorded " +
      "anywhere, so a completion is charged the interval from the previous completion's cost row " +
      "to its own; the first completion of a run is charged from the run's first event. It " +
      "therefore charges a completion for the tool time that preceded it, and it OVERSTATES any " +
      "role that runs concurrently with the agent — the out-of-band supervisor above all, whose " +
      "batch review (packages/orchestrator/src/auto-mode.ts:1903) is off the tool's critical path " +
      "by design. Read `byRole[].wallShare` as 'share of the run's stretches that ended in this " +
      "role', never as 'share of the run's wall clock this role caused'. The EXACT wall-clock " +
      "numbers are `reviewerBlockingShareOfRun` (from safety_decision.timings), " +
      "`retryWaitSecondsPerRun` (from run_trace retry waitMs) and `shareOfRunAfterLastEdit`. " +
      "Gap I3 closes this.",
    notRecorded: [
      "Reviewer QUEUE wait. SupervisorQueue (packages/orchestrator/src/supervisor-queue.ts:44) " +
        "records no enter/leave timestamp, so reviewerBlockingMs is the classifier's own latency " +
        "only and the batch's queue delay is invisible.",
      "Worker startup and integration. Zero delegation_checkpoint / delegation_lease rows exist " +
        "in this corpus (V3-F1: the store was unwired until 0fc1c99), so worker timings could not " +
        "be measured at all.",
      "Which harness message caused which completion, before 897b192: the `harness` origin marker " +
        "is on 1 of 1,210 user_msg rows in this corpus, and 9 synthetic user messages in " +
        "agent-loop.ts still carry no origin at all.",
      "A useful_edit marker. 'Time after the last useful edit' is inferred from the last " +
        "assistant message that called an edit tool, which counts an edit later reverted.",
      "Per-request cache reads by role before the role tag: the usage block has them, the " +
        "attribution does not.",
    ],
    privacy:
      "Every field is extracted in SQL; no prompt text, tool argument, file body or provider " +
      "response entered the analysis process. run_trace notice text is reduced to a label before " +
      "it is counted.",
  },
  labelledAgreement: agreement(corpus.flat),
  attributionRules: ruleCounts(corpus.flat),
  totals: aggregate(all),
  byMode: { auto: aggregate(auto), nonAuto: aggregate(nonAuto) },
  byRoute: {
    free: aggregate(all.filter((m) => m.free)),
    paid: aggregate(all.filter((m) => !m.free)),
  },
  byEra: Object.fromEntries(ERAS.map((era) => [era, aggregate(all.filter((m) => m.era === era))])),
  byEraAuto: Object.fromEntries(
    ERAS.map((era) => [era, aggregate(auto.filter((m) => m.era === era))]),
  ),
  cacheByRole: cacheByRole(corpus.flat),
  promptComposition: composition(corpus.c.events),
  toolSurface: (() => {
    const rows = corpus.c.events.filter((e) => e.type === "tool_surface");
    return { rows: rows.length, note: "advertised/deferred tool counts; see tool_surface events" };
  })(),
  harnessFollowups: {
    noticeFirings: (() => {
      const acc = new Map<string, number>();
      for (const e of corpus.c.events) {
        if (e.traceType !== "notice") continue;
        const l = noticeLabel(e.traceMessage ?? "");
        acc.set(l, (acc.get(l) ?? 0) + 1);
      }
      return [...acc].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n }));
    })(),
    spineGateEntries: [...corpus.c.spineGates.values()].flat().length,
    userMsgWithOriginMarker: corpus.c.events.filter((e) => e.type === "user_msg" && !!e.harness)
      .length,
    userMsgTotal: corpus.c.events.filter((e) => e.type === "user_msg").length,
  },
  reviewerLatency: reviewerLatency(corpus.c.events),
  retries: {
    traceRetries: corpus.c.events.filter((e) => e.traceType === "retry").length,
    totalBackoffMs: corpus.c.events
      .filter((e) => e.traceType === "retry")
      .reduce((a, e) => a + num(e.waitMs), 0),
    incidentsByClass: incidentsByClass.slice(0, 12),
  },
  compaction: (() => {
    const rows = corpus.c.events.filter((e) => e.type === "auto_compaction");
    return {
      autoCompactions: rows.length,
      beforeTokens: dist(rows.map((e) => num(e.beforeTokens))),
      afterTokens: dist(rows.map((e) => num(e.afterTokens))),
      legacyCompactions: corpus.c.events.filter((e) => e.type === "compaction").length,
    };
  })(),
  pricing: {
    rowsWithNoPricedField: corpus.c.events.filter((e) => e.type === "cost" && e.priced === null)
      .length,
    rowsPricedFalse: corpus.c.events.filter((e) => e.type === "cost" && e.priced === 0).length,
    rowsEstimatedRate: corpus.c.events.filter((e) => e.type === "cost" && e.estimated === 1).length,
    note:
      "A row with no `priced` field predates P12.1; its dollar figure is UNKNOWN, not zero. Those " +
      "rows are counted in completions and tokens, so every dollar total here is a LOWER BOUND by " +
      "exactly that many rows.",
    byBilling: (() => {
      const acc = new Map<string, { n: number; costUsd: number; listUsd: number }>();
      for (const e of corpus.c.events) {
        if (e.type !== "cost") continue;
        const k = e.billing ?? "unknown";
        const b = acc.get(k) ?? { n: 0, costUsd: 0, listUsd: 0 };
        b.n++;
        b.costUsd += e.costUsd;
        b.listUsd += e.listUsd;
        acc.set(k, b);
      }
      return [...acc].map(([billing, b]) => ({
        billing,
        rows: b.n,
        costUsd: round(b.costUsd, 6),
        listCostUsd: round(b.listUsd, 6),
      }));
    })(),
  },
  pilots,
};

await Bun.write(OUT_PATH, JSON.stringify(report, null, 2) + "\n");

// ─── Console summary ───

const t = report.totals;
console.log(`overhead-report  ${DB_PATH}`);
console.log(
  `  ${report.source.corpus.sessions} sessions, ${report.source.corpus.events} events, ` +
    `${report.source.corpus.costRows} cost rows ` +
    `(${report.source.corpus.costRowsWithRoleTag} tagged), ${corpus.runs.length} runs with usage`,
);
console.log(
  `  inference: super-class ${((report.labelledAgreement.superClassAgreement ?? 0) * 100).toFixed(1)}%, ` +
    `exact-role ${((report.labelledAgreement.exactRoleAgreement ?? 0) * 100).toFixed(1)}% ` +
    `on ${report.labelledAgreement.rowsWithRoleTag} tagged rows`,
);
console.log(`  pilots: ${pilots.length} controlled run databases, 100% tagged`);
console.log(`\n  role                completions  cost share  wall share  runs touched`);
for (const r of t.byRole) {
  if (r.completions === 0) continue;
  console.log(
    `  ${r.role.padEnd(19)} ${String(r.completions).padStart(10)}  ` +
      `${((r.costShare ?? 0) * 100).toFixed(1).padStart(9)}%  ` +
      `${((r.wallShare ?? 0) * 100).toFixed(1).padStart(9)}%  ` +
      `${String(r.runsTouched).padStart(12)}`,
  );
}
console.log(`\n  wrote ${OUT_PATH}`);
if (PRINT) console.log(JSON.stringify(report, null, 2));
