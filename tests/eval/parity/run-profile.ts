/**
 * Where one Rune run's time and money went, read from the run's own database.
 *
 * The comparison rig records a total per attempt: wall time, list cost, exit.
 * A total says that a run was slower or dearer and not why, and one run a
 * task swings ±40% on its own (ledger, 2026-10-08) — so a change that removes
 * forty seconds of waiting cannot be seen in six totals. It can be seen in
 * what it removes. This reads those things, one by one:
 *
 *   · when the first tool ran, and when the first file was written;
 *   · how long the end-of-turn checks held the finish, and what they said;
 *   · what the reviewer cost, call by call, apart from the work;
 *   · how many completions did nothing but keep the ledger;
 *   · how much of the input was read from the cache;
 *   · which reasoning effort each call asked for, and how often it changed.
 *
 * Read-only, and it makes no model call. It reads `events` as the Engine
 * wrote them — nothing here is estimated, and what a database does not hold is
 * reported as not held (`null`), never as zero. A call the gateway could not
 * price leaves the run's cost `null`: an unknown price is not a free one.
 *
 *   bun tests/eval/parity/run-profile.ts <rune.db | run directory>…
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Tools that write a file. A shell command may too, and is not counted: it is not known to. */
const WRITERS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "worker"]);
/** Calls that keep the plan or the evidence ledger, and do none of the work. */
const LEDGER_TOOLS = new Set(["todo_write", "record_evidence"]);

export interface RoleSpend {
  calls: number;
  /** Summed latency. For any role but `primary` the calls overlap the work: this is not wall time. */
  latencyMs: number;
  /** `null` when a call in it had no known price. */
  listUsd: number | null;
  /** Input paid for at the full rate. What was read from the cache is NOT in this number. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface RunProfile {
  /** First event to last, ms. */
  wallMs: number;
  /** First tool result of any kind, ms from the start. */
  firstActionMs: number | null;
  /** First result of a tool that writes a file. */
  firstWriteMs: number | null;
  lastWriteMs: number | null;
  /** Each end-of-turn check, in order. */
  checks: Array<{ startedMs: number; ms: number; status: string; reason?: string }>;
  /** Wall time the checks held the finish for. */
  checkMs: number;
  roles: Record<string, RoleSpend>;
  /** `null` when any call had no known price. */
  listUsd: number | null;
  unpricedCalls: number;
  /** Of everything the primary model was sent, the share read from the cache: cached ÷ (full-rate + cached). `null` with no input. */
  primaryCachedShare: number | null;
  /** Completions of the primary model, and the ones that only kept the ledger. */
  turns: number;
  ledgerOnlyTurns: number;
  ledgerOnlyMs: number;
  ledgerOnlyUsd: number | null;
  /** Reasoning effort per primary call, in order of first use; empty when the build did not record it. */
  efforts: Record<string, number>;
  /** How many primary calls asked for a different effort from the one before. */
  effortChanges: number | null;
  tools: Record<string, number>;
}

type Payload = Record<string, unknown>;

const unwrap = (json: string): Payload => {
  const parsed = JSON.parse(json) as Payload;
  const inner = parsed.payload;
  return inner && typeof inner === "object" ? (inner as Payload) : parsed;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const emptySpend = (): RoleSpend => ({
  calls: 0,
  latencyMs: 0,
  listUsd: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
});

/** A priced call's list cost, or `null`. `priced: false` is "not known", whatever number sits beside it. */
function priceOf(cost: Payload): number | null {
  if (cost.priced === false) return null;
  return typeof cost.listCostUsd === "number" ? cost.listCostUsd : null;
}

export function profileRun(dbPath: string): RunProfile {
  const db = new Database(dbPath, { readonly: true });
  let rows: Array<{ type: string; payload_json: string; created_at: string }>;
  try {
    rows = db
      .query("select type, payload_json, created_at from events order by seq")
      .all() as typeof rows;
  } finally {
    db.close();
  }
  if (rows.length === 0) throw new Error(`${dbPath}: no events`);
  const t0 = Date.parse(rows[0]!.created_at);
  const at = (iso: string): number => Date.parse(iso) - t0;

  const profile: RunProfile = {
    wallMs: at(rows.at(-1)!.created_at),
    firstActionMs: null,
    firstWriteMs: null,
    lastWriteMs: null,
    checks: [],
    checkMs: 0,
    roles: {},
    listUsd: 0,
    unpricedCalls: 0,
    primaryCachedShare: null,
    turns: 0,
    ledgerOnlyTurns: 0,
    ledgerOnlyMs: 0,
    ledgerOnlyUsd: 0,
    efforts: {},
    effortChanges: null,
    tools: {},
  };

  const toolOf = new Map<string, string>();
  let pendingPrimary: Payload | null = null;
  let checkStarted: number | null = null;
  let lastEffort: string | undefined;
  let effortSeen = false;

  for (const row of rows) {
    const p = unwrap(row.payload_json);
    const ms = at(row.created_at);
    if (row.type === "cost") {
      const role = typeof p.role === "string" ? p.role : "primary";
      const spend = (profile.roles[role] ??= emptySpend());
      const price = priceOf(p);
      spend.calls++;
      spend.latencyMs += num(p.latencyMs);
      spend.inputTokens += num(p.inputTokens);
      spend.cachedTokens += num(p.cacheReadTokens);
      spend.outputTokens += num(p.outputTokens);
      if (price === null) {
        spend.listUsd = null;
        profile.listUsd = null;
        profile.unpricedCalls++;
      } else {
        if (spend.listUsd !== null) spend.listUsd += price;
        if (profile.listUsd !== null) profile.listUsd += price;
      }
      if (role === "primary") {
        pendingPrimary = p;
        if (typeof p.effort === "string") {
          effortSeen = true;
          profile.efforts[p.effort] = (profile.efforts[p.effort] ?? 0) + 1;
          if (lastEffort !== undefined && p.effort !== lastEffort) {
            profile.effortChanges = (profile.effortChanges ?? 0) + 1;
          }
          lastEffort = p.effort;
        }
      }
    } else if (row.type === "assistant_msg") {
      const uses = Array.isArray(p.toolUses) ? (p.toolUses as Payload[]) : [];
      const names = uses.map((u) => String(u.toolName ?? ""));
      for (const use of uses) {
        const name = String(use.toolName ?? "");
        toolOf.set(String(use.callId ?? ""), name);
        profile.tools[name] = (profile.tools[name] ?? 0) + 1;
      }
      profile.turns++;
      if (names.length > 0 && names.every((n) => LEDGER_TOOLS.has(n))) {
        profile.ledgerOnlyTurns++;
        // The completion that produced this message is the cost row before it.
        if (pendingPrimary) {
          profile.ledgerOnlyMs += num(pendingPrimary.latencyMs);
          const price = priceOf(pendingPrimary);
          if (price === null) profile.ledgerOnlyUsd = null;
          else if (profile.ledgerOnlyUsd !== null) profile.ledgerOnlyUsd += price;
        }
      }
      pendingPrimary = null;
    } else if (row.type === "tool_result") {
      profile.firstActionMs ??= ms;
      if (WRITERS.has(toolOf.get(String(p.callId ?? "")) ?? "")) {
        profile.firstWriteMs ??= ms;
        profile.lastWriteMs = ms;
      }
    } else if (row.type === "run_trace") {
      if (p.type === "verification_started") checkStarted = ms;
      else if (p.type === "verification_completed" && checkStarted !== null) {
        profile.checks.push({
          startedMs: checkStarted,
          ms: ms - checkStarted,
          status: String(p.status ?? (p.passed ? "passed" : "failed")),
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
        });
        profile.checkMs += ms - checkStarted;
        checkStarted = null;
      }
    }
  }

  if (effortSeen) profile.effortChanges ??= 0;
  const primary = profile.roles.primary;
  // A cost row keeps the two apart: `inputTokens` is what was paid for in
  // full, and the cached tokens are beside it, not inside it.
  const sent = primary ? primary.inputTokens + primary.cachedTokens : 0;
  if (primary && sent > 0) profile.primaryCachedShare = primary.cachedTokens / sent;
  return profile;
}

const secs = (ms: number | null): string => (ms === null ? "—" : `${Math.round(ms / 1000)}s`);
const usd = (n: number | null): string => (n === null ? "price unknown" : `$${n.toFixed(3)}`);
const pct = (n: number | null): string => (n === null ? "—" : `${Math.round(n * 100)}%`);

/** One run, as lines a person reads. */
export function formatProfile(label: string, p: RunProfile): string {
  const others = Object.entries(p.roles).filter(([role]) => role !== "primary");
  const primary = p.roles.primary ?? emptySpend();
  const lines = [
    `${label}`,
    `  wall ${secs(p.wallMs)} · cost ${usd(p.listUsd)}` +
      (p.unpricedCalls ? ` (${p.unpricedCalls} call(s) with no known price)` : ""),
    `  first tool ${secs(p.firstActionMs)} · first write ${secs(p.firstWriteMs)} · last write ${secs(p.lastWriteMs)}`,
    `  checks held the finish ${secs(p.checkMs)}` +
      (p.checks.length
        ? `: ${p.checks.map((c) => `${c.status}${c.reason ? `/${c.reason}` : ""} ${secs(c.ms)}`).join(", ")}`
        : " (none ran)"),
    `  work: ${primary.calls} calls, ${secs(primary.latencyMs)} of model time, ${usd(primary.listUsd)}, ` +
      `${pct(p.primaryCachedShare)} of input from cache`,
    `  ledger-only completions: ${p.ledgerOnlyTurns} of ${p.turns} (${secs(p.ledgerOnlyMs)}, ${usd(p.ledgerOnlyUsd)})`,
    ...others.map(
      ([role, s]) =>
        `  ${role}: ${s.calls} calls, ${usd(s.listUsd)} (alongside the work — ${secs(s.latencyMs)} summed, not wall time)`,
    ),
    `  effort: ` +
      (Object.keys(p.efforts).length
        ? `${Object.entries(p.efforts)
            .map(([e, n]) => `${e} ×${n}`)
            .join(", ")}; changed ${p.effortChanges} time(s)`
        : "not recorded by this build"),
  ];
  return lines.join("\n");
}

/** A run directory or its database: wherever `rune.db` is under it. */
export function findDatabase(path: string): string | null {
  if (!existsSync(path)) return null;
  if (statSync(path).isFile()) return path;
  for (const rel of ["rune.db", "profile/rune.db", "rune/profile/rune.db"]) {
    if (existsSync(join(path, rel))) return join(path, rel);
  }
  return null;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: bun tests/eval/parity/run-profile.ts <rune.db | run directory>…");
    process.exit(2);
  }
  let failed = false;
  for (const path of paths) {
    const db = findDatabase(path);
    if (!db) {
      console.error(`${path}: no rune.db found`);
      failed = true;
      continue;
    }
    console.log(formatProfile(path, profileRun(db)));
  }
  process.exit(failed ? 1 : 0);
}
