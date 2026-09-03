// ─── `gear audit`: what a session did, and on what evidence ───
//
// The session log already holds everything — the plan with its evidence, the
// harness's own log, every safety decision with its reason, the held steps,
// the cost rows, the terminations. Nothing read it back as one page: the
// reason a call was allowed lived in a SQLite row reachable only by hand, and
// the plan's evidence lived in the mission file of whichever workspace the
// run happened in. This is that page. It opens ~/.gear/gear.db read-only, no
// Engine, no provider — instant, like `gear incidents`.

import { join } from "node:path";
import { getGearHome, SessionManager } from "@gear/shared";
import type { SessionEvent } from "@gear/shared";
import { BlackboxStore } from "@gear/telemetry";
import { formatAutoSafetyMetrics, readAutoSafetyMetrics } from "../auto-metrics";
import { TaskStateStore, stepReceipt } from "../task-state";
import { runEnding, type RunRetro } from "../retro";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { formatCacheRate } from "../cost-report";
import { getContextLimit, UNKNOWN_MODEL_CONTEXT_LIMIT } from "../tokenizer";
import { MODEL_PRICING } from "@gear/llm-gateway";

type Row = { seq: number; event: SessionEvent };

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

function shortTs(iso: string | undefined): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "";
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** The session id to audit: an id prefix, or `last` (default) for the newest. */
function resolveSession(sm: SessionManager, arg: string | undefined): string | null {
  const all = sm
    .listSessions({ status: "all" })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (!arg || arg === "last" || arg === "latest") return all[0]?.id ?? null;
  const hit = all.find((s) => s.id === arg) ?? all.find((s) => s.id.startsWith(arg));
  return hit?.id ?? null;
}

function payloadOf(row: Row): Record<string, unknown> {
  return row.event.payload ?? {};
}

// ─── Post-edit diagnostics (P10.1) ───

/** Tools whose results can carry a `diagnostics` block. */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

export interface DiagnosticsLedger {
  /** Successful edits whose result carried a diagnostics block. */
  edits: number;
  /** Diagnostic lines across those blocks (bounded per edit, so: reported). */
  reported: number;
  /** Distinct files a block ever named. */
  files: number;
  /**
   * Files whose block was gone by the next edit of that same file, before the
   * verifier ran — the loop this feature exists to close.
   */
  cleared: number;
  /** Files still carrying a block when the verifier ran (or at the end). */
  outstanding: number;
  /** Seq at which project checks first ran; null when they never did. */
  verifierSeq: number | null;
}

/** The first row whose task-state snapshot shows the verifier having run. */
function firstVerificationSeq(rows: Row[]): number | null {
  for (const r of rows) {
    if (r.event.type !== "task_state") continue;
    const state = (payloadOf(r) as { state?: { verification?: { status?: string } } }).state;
    if (state?.verification && state.verification.status !== "none") return r.seq;
  }
  return null;
}

/**
 * How post-edit diagnostics actually behaved in this session: how many edits
 * came back carrying the language server's verdict, and how many of those
 * files were clean again by the next edit — before the verifier ran, which is
 * the whole point of putting the block in the edit's own result.
 *
 * "Cleared" means the NEXT edit of that file came back with no block. That is
 * the same evidence the model had, and it is deliberately not called "fixed":
 * a block can also be absent because the server had not published in time.
 * Pure, so it can be tested without a database.
 */
export function diagnosticsLedger(rows: Row[]): DiagnosticsLedger {
  const verifierSeq = firstVerificationSeq(rows);
  // callId → the write tool it belongs to (results carry no tool name).
  const calls = new Map<string, string>();
  // file → whether its most recent edit left a block outstanding.
  const dirty = new Map<string, boolean>();
  let edits = 0;
  let reported = 0;
  let cleared = 0;

  for (const r of rows) {
    if (r.event.type === "assistant_msg") {
      const uses = payloadOf(r).toolUses;
      if (!Array.isArray(uses)) continue;
      for (const u of uses as Array<{ callId?: string; toolName?: string }>) {
        if (typeof u.callId === "string" && typeof u.toolName === "string") {
          calls.set(u.callId, u.toolName);
        }
      }
      continue;
    }
    if (r.event.type !== "tool_result") continue;
    const p = payloadOf(r);
    if (p.isError === true) continue;
    const toolName = calls.get(String(p.callId ?? ""));
    if (!toolName || !WRITE_TOOLS.has(toolName)) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(p.content ?? "")) as Record<string, unknown>;
    } catch {
      continue; // truncated or non-JSON result — nothing to account for
    }
    const block = typeof parsed.diagnostics === "string" ? parsed.diagnostics : "";
    const touched = filesInResult(parsed, block);

    if (block) {
      edits++;
      // The `+N more` tail is a count, not a diagnostic.
      reported += block.split("\n").filter((l) => !/^\+\d+ more$/.test(l)).length;
      for (const f of touched) dirty.set(f, true);
    } else {
      for (const f of touched) {
        // Only before the verifier: after it, the checks are the evidence and
        // this stops being the loop the number is about.
        if (dirty.get(f) && (verifierSeq === null || r.seq < verifierSeq)) cleared++;
        dirty.set(f, false);
      }
    }
  }

  return {
    edits,
    reported,
    files: dirty.size,
    cleared,
    outstanding: [...dirty.values()].filter(Boolean).length,
    verifierSeq,
  };
}

// ─── Context utilization (P10.8) ───

/** One model round trip's occupancy of its own context window. */
export interface ContextTurn {
  seq: number;
  model: string;
  /** Fresh + cache-read + cache-creation input, or null when none was reported. */
  used: number | null;
  /** The model's window. */
  limit: number;
  /** True when no table rule recognized the model and the default stood in. */
  assumed: boolean;
  /** Share of the input served warm, or null when nothing was reported. */
  cacheShare: number | null;
}

/** One compaction, as the session log recorded it. */
export interface ContextCompaction {
  seq: number;
  before: number | null;
  after: number | null;
  summarized: number;
  /** What was dropped: `summarized` (folded into the merged state) or
   *  `tool_results` (old bodies stripped). Null on pre-P10.8 rows. */
  tier: string | null;
  /** What asked: `auto`, `requested`, `overflow`. Null on pre-P10.8 rows. */
  trigger: string | null;
}

export interface ContextLedger {
  turns: ContextTurn[];
  compactions: ContextCompaction[];
  /** The fullest the window ever got, among turns that reported anything. */
  peak: ContextTurn | null;
  /** Where it stood at the end. */
  last: ContextTurn | null;
}

/**
 * How full the context window ran, turn by turn, and what compaction did about
 * it — read back out of the persisted usage rows rather than from a live
 * counter. The distinction matters for the same reason it does for the
 * supervisor's metrics: the process holding a counter is frequently the one
 * that died.
 *
 * A turn whose provider reported no usage carries `used: null`, and renders as
 * "no data" rather than as a zero it did not earn. Pure over the rows, so it is
 * tested without a database.
 */
export function contextLedger(rows: Row[]): ContextLedger {
  const turns: ContextTurn[] = [];
  const compactions: ContextCompaction[] = [];

  for (const r of rows) {
    if (r.event.type === "cost") {
      const p = payloadOf(r);
      const model = String(p.model ?? "");
      const fresh = Number(p.inputTokens ?? 0) || 0;
      const read = Number(p.cacheReadTokens ?? 0) || 0;
      const written = Number(p.cacheCreationTokens ?? 0) || 0;
      const total = fresh + read + written;
      const limit = model ? getContextLimit(model) : UNKNOWN_MODEL_CONTEXT_LIMIT;
      turns.push({
        seq: r.seq,
        model,
        used: total > 0 ? total : null,
        limit,
        assumed: !model || limit === UNKNOWN_MODEL_CONTEXT_LIMIT,
        cacheShare: total > 0 ? read / total : null,
      });
      continue;
    }
    if (r.event.type === "auto_compaction" || r.event.type === "compaction") {
      const p = payloadOf(r);
      const before = Number(p.beforeTokens ?? p.sourceTokens ?? 0) || 0;
      const after = Number(p.afterTokens ?? p.summaryTokens ?? 0) || 0;
      compactions.push({
        seq: r.seq,
        before: before > 0 ? before : null,
        after: after > 0 ? after : null,
        summarized: Number(p.summarizedCount ?? p.originalMessages ?? 0) || 0,
        tier: typeof p.tier === "string" ? p.tier : null,
        // The /compress path records `trigger: "manual"`; auto-compaction rows
        // carry the engine's own auto/requested/overflow.
        trigger: typeof p.trigger === "string" ? p.trigger : null,
      });
    }
  }

  const measured = turns.filter((t) => t.used !== null);
  const peak = measured.reduce<ContextTurn | null>(
    (best, t) => (best === null || t.used! / t.limit > best.used! / best.limit ? t : best),
    null,
  );
  return { turns, compactions, peak, last: measured.at(-1) ?? null };
}

/** `68%` of a window, or "no data" when the provider reported none. */
function occupancy(t: ContextTurn | null): string {
  if (!t || t.used === null) return "no data";
  return `${Math.round((t.used / t.limit) * 100)}%`;
}

/** What a compaction dropped, in words a reader can act on. */
function droppedBy(c: ContextCompaction): string {
  if (c.tier === "tool_results") {
    return "old tool-result bodies, kept as excerpts";
  }
  if (c.tier === "summarized") {
    return `${num(c.summarized)} message${c.summarized === 1 ? "" : "s"} folded into the merged state`;
  }
  // Pre-P10.8 rows, and the /compress path, recorded neither tier nor trigger.
  return c.summarized > 0
    ? `${num(c.summarized)} message${c.summarized === 1 ? "" : "s"} folded`
    : "unrecorded";
}

/** Which policy sized the tail — the reason two rows are not comparable. */
function triggeredBy(c: ContextCompaction): string {
  switch (c.trigger) {
    case "auto":
      return "auto (high-water mark, 30% tail)";
    case "requested":
      return "requested (compact_context, cuts to the recent exchange)";
    case "overflow":
      return "overflow (provider rejected the prompt)";
    case "manual":
      return "manual (/compress)";
    default:
      return "trigger not recorded";
  }
}

/** Which files an edit result is about: its own path, or a patch's file list. */
function filesInResult(parsed: Record<string, unknown>, block: string): string[] {
  const out = new Set<string>();
  if (typeof parsed.path === "string" && parsed.path) out.add(parsed.path);
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files as Array<{ path?: string; moved_to?: string }>) {
      const p = f?.moved_to ?? f?.path;
      if (typeof p === "string" && p) out.add(p);
    }
  }
  // A block names its own files, which covers results whose shape we don't
  // otherwise recognise.
  for (const line of block.split("\n")) {
    const m = /^(.+?):\d+:\d+ (?:error|warning) /.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export async function runAudit(args: string[], values: Record<string, unknown>): Promise<number> {
  const dbPath =
    (typeof values.db === "string" && values.db) ||
    process.env.GEAR_DB_PATH ||
    join(getGearHome(), "gear.db");
  let sm: SessionManager;
  try {
    sm = new SessionManager(dbPath);
  } catch (err) {
    say(`  ${danger("!")} could not open ${dbPath}: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  try {
    const id = resolveSession(sm, args[0]);
    if (!id) {
      say(dim("  No session found. Usage: gear audit [sessionId|last]"));
      return 1;
    }
    const session = sm.getSession(id)!;
    const rows = sm.getEvents(id, 1) as Row[];

    // ── Header ──
    say();
    say(
      `  ${accent("Gear audit")} ${dim("·")} ${info(id)}${session.title ? `  ${text(session.title.slice(0, 70))}` : ""}`,
    );
    say(
      `  ${dim(session.workspaceRoot)} ${dim("·")} ${text(session.model)}${session.provider ? dim(` on ${session.provider}`) : ""} ${dim("·")} ${dim(`${shortTs(session.createdAt)} → ${shortTs(session.updatedAt)}`)} ${dim("·")} ${dim(`${num(rows.length)} events`)}`,
    );

    // ── The spine ──
    const store = TaskStateStore.fromEvents(rows);
    const state = store?.snapshot();
    say();
    if (!state) {
      say(`  ${dim("No task spine recorded (pre-spine session).")}`);
    } else {
      say(`  ${text("Goal")}  ${state.goal.replace(/\s+/g, " ").slice(0, 200) || dim("(none)")}`);
      if (state.pendingGoal) {
        say(`  ${text("Latest request")}  ${state.pendingGoal.replace(/\s+/g, " ").slice(0, 160)}`);
      } else if (state.directive) {
        say(`  ${text("Latest push")}  ${state.directive.slice(0, 160)}`);
      }
      const counts = store!.todoCounts();
      if (state.todos.length > 0) {
        say();
        say(
          `  ${text("Plan")}  ${ok(`${counts.done}/${counts.total} done`)}${counts.unproven > 0 ? `  ${warn(`${counts.unproven} unproven`)}` : ""}${counts.open > 0 ? `  ${dim(`${counts.open} open`)}` : ""}`,
        );
        for (const t of state.todos.slice(0, 40)) {
          const mark =
            t.status === "completed"
              ? t.unproven
                ? warn("~")
                : ok("x")
              : t.status === "in_progress"
                ? info(">")
                : dim(" ");
          const receipt = stepReceipt(t);
          say(
            `    [${mark}] ${t.content.slice(0, 90)}${receipt ? `  ${t.unproven ? warn(receipt) : faint(receipt)}` : ""}`,
          );
        }
        if (state.todos.length > 40) say(dim(`    …+${state.todos.length - 40} more`));
      }
      if (state.verification.status !== "none") {
        const v = state.verification;
        say(
          `  ${text("Verification")}  ${v.status === "passed" ? ok(v.status) : v.status === "failed" ? danger(v.status) : warn(v.status)}${v.attempts ? dim(` (attempt ${v.attempts})`) : ""}${v.lastReport ? dim(` — ${v.lastReport.split("\n")[0].slice(0, 100)}`) : ""}`,
        );
      }
      // ── Checks: WHICH command, its exit code, how long (P10.4) ──
      //
      // "Verification: passed" and a receipt reading "check ok" were the whole
      // record. Neither said what had actually been run, so a page whose
      // purpose is evidence could not name the evidence. This can.
      if (state.checks && state.checks.length > 0) {
        const cs = state.checks;
        const failed = cs.filter((c) => !c.passed).length;
        say();
        say(
          `  ${text("Checks")}  ${num(cs.length)} run${cs.length === 1 ? "" : "s"}` +
            ` ${dim("·")} ${ok(`${cs.length - failed} passed`)}` +
            (failed > 0 ? ` ${dim("·")} ${danger(`${failed} failed`)}` : ""),
        );
        for (const c of cs.slice(-12)) {
          const code = c.exitCode != null ? `exit ${c.exitCode}` : c.passed ? "ok" : "failed";
          const took = c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : "—";
          say(
            `    ${dim(c.at.slice(11, 16))} ${c.passed ? ok("✓") : danger("✗")} ${c.command.slice(0, 72).padEnd(72)}` +
              ` ${dim(code.padEnd(9))} ${dim(took.padStart(6))} ${dim(c.source)}`,
          );
        }
        if (cs.length > 12) say(dim(`    …+${cs.length - 12} earlier`));
      }
      // The later of the spine's handoff and a termination note wins, unless
      // the dying run recorded the handoff itself (provider_lost, error).
      const ending = runEnding(rows, state.handoff?.at);
      const died = ending.diedWins ? rows.find((r) => r.seq === ending.diedSeq) : undefined;
      if (died) {
        say(
          `  ${text("Ended")}  ${danger("error")} ${dim(`#${died.seq}`)} ${dim("—")} ${String(payloadOf(died).content ?? "").slice(0, 100)}`,
        );
      } else if (state.handoff) {
        say(`  ${text("Ended")}  ${warn(state.handoff.reason)} ${dim(shortTs(state.handoff.at))}`);
      }
      if (state.log && state.log.length > 0) {
        say();
        say(`  ${text("Log")}`);
        for (const e of state.log.slice(-30)) {
          const paint =
            e.kind === "unproven" ||
            e.kind === "dropped" ||
            e.kind === "gate" ||
            e.kind === "handoff"
              ? warn
              : e.kind === "done" || e.kind === "check"
                ? ok
                : dim;
          say(`    ${dim(e.at.slice(11, 16))} ${paint(e.kind)}${dim(":")} ${e.text.slice(0, 110)}`);
        }
      }
    }

    // ── Retro: the last run's account of itself ──
    const retroRow = [...rows].reverse().find((r) => r.event.type === "retro");
    const rt = retroRow ? (payloadOf(retroRow).retro as RunRetro | undefined) : undefined;
    if (rt && rt.v === 1) {
      say();
      say(
        `  ${text("Retro")}  ${rt.outcome === "finished" ? ok(rt.outcome) : warn(rt.outcome)} ${dim("·")} steps ${rt.steps.done}/${rt.steps.total}${rt.steps.unproven > 0 ? ` ${warn(`~${rt.steps.unproven}`)}` : ""} ${dim("·")} checks ${ok(String(rt.checks.passed))}/${rt.checks.failed > 0 ? danger(String(rt.checks.failed)) : "0"} ${dim("·")} ${num(rt.tools.calls)} tool calls${rt.tools.failed > 0 ? ` (${warn(`${rt.tools.failed} failed`)})` : ""} ${dim("·")} ${num(rt.completions)} completions ${dim("·")} $${rt.cost.listUsd.toFixed(4)} ${dim("list")}`,
      );
      for (const l of rt.lessons.slice(0, 6)) {
        say(
          `    ${l.kind === "pitfall" ? warn(l.kind) : ok(l.kind)}${dim(":")} ${l.body.slice(0, 110)}`,
        );
      }
    }

    // ── Runs and terminations ──
    const userMsgs = rows.filter((r) => r.event.type === "user_msg");
    const notes = rows.filter((r) => r.event.type === "system_note");
    say();
    say(
      `  ${text("Runs")}  ${num(userMsgs.length)} message${userMsgs.length === 1 ? "" : "s"} from the user${notes.length > 0 ? `, ${warn(`${notes.length} early termination${notes.length === 1 ? "" : "s"}`)}` : ""}`,
    );
    for (const n of notes.slice(-5)) {
      say(`    ${dim(`#${n.seq}`)} ${String(payloadOf(n).content ?? "").slice(0, 120)}`);
    }

    // ── Tools ──
    const toolCounts = new Map<string, number>();
    for (const r of rows) {
      if (r.event.type !== "assistant_msg") continue;
      const uses = payloadOf(r).toolUses;
      if (!Array.isArray(uses)) continue;
      for (const u of uses as Array<{ toolName?: string }>) {
        const name = u.toolName ?? "?";
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      }
    }
    const failures = rows.filter(
      (r) => r.event.type === "tool_result" && payloadOf(r).isError === true,
    ).length;
    const totalCalls = [...toolCounts.values()].reduce((a, b) => a + b, 0);
    if (totalCalls > 0) {
      const top = [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([n, c]) => `${n} ${dim(String(c))}`)
        .join(dim(" · "));
      say(
        `  ${text("Tools")}  ${num(totalCalls)} calls${failures > 0 ? `, ${warn(`${failures} failed`)}` : ""}  ${top}`,
      );
    }

    // ── Post-edit diagnostics (P10.1) ──
    //
    // The claim the feature makes is that a type error is corrected in the
    // edit's own turn instead of at the verifier. This is the line that says
    // whether it happened here, from the log rather than from a live counter.
    const diag = diagnosticsLedger(rows);
    if (diag.edits > 0) {
      const before =
        diag.verifierSeq === null
          ? dim("no checks ran")
          : dim(`before the verifier at #${diag.verifierSeq}`);
      say(
        `  ${text("Diagnostics")}  ${num(diag.edits)} edit${diag.edits === 1 ? "" : "s"} carried a language-server block` +
          ` ${dim("·")} ${num(diag.reported)} error${diag.reported === 1 ? "" : "s"}/warnings reported` +
          ` ${dim("·")} ${diag.cleared > 0 ? ok(`${diag.cleared} cleared`) : dim("0 cleared")} ${before}` +
          (diag.outstanding > 0
            ? ` ${dim("·")} ${warn(`${diag.outstanding} still outstanding`)}`
            : ""),
      );
    }

    // ── What the tool surface costs, per request ──
    // Every advertised schema is paid on EVERY request for the life of the
    // session. Deferred loading (P4.1) turns most connector tools into one
    // catalog line each; this is the line that says whether it worked.
    const surface = [...rows].reverse().find((r) => r.event.type === "tool_surface");
    if (surface) {
      const p = payloadOf(surface) as {
        advertised?: number;
        deferred?: number;
        tokens?: number;
        eagerTokens?: number;
        savedPct?: number;
      };
      const saved = typeof p.savedPct === "number" ? p.savedPct : null;
      say(
        `  ${text("Schema tokens")}  ${num(p.tokens ?? 0)} per request` +
          ` ${dim("·")} ${num(p.advertised ?? 0)} advertised` +
          (p.deferred ? ` ${dim("·")} ${num(p.deferred)} deferred` : "") +
          (saved !== null && (p.deferred ?? 0) > 0
            ? ` ${dim("·")} ${saved >= 40 ? ok(`${saved}% below`) : warn(`${saved}% below`)} ${dim(`${num(p.eagerTokens ?? 0)} eager`)}`
            : ""),
      );
    }

    // ── Safety decisions ──
    const decisions = rows.filter((r) => r.event.type === "safety_decision");
    if (decisions.length > 0) {
      const byVerdict = new Map<string, number>();
      for (const d of decisions) {
        const p = payloadOf(d);
        const key = `${p.verdict ?? "?"}/${p.source ?? "?"}`;
        byVerdict.set(key, (byVerdict.get(key) ?? 0) + 1);
      }
      say();
      say(
        `  ${text("Safety")}  ${num(decisions.length)} recorded decisions  ${[
          ...byVerdict.entries(),
        ]
          .sort((a, b) => b[1] - a[1])
          .map(([k, c]) => `${k} ${dim(String(c))}`)
          .join(dim(" · "))}`,
      );
      const notable = decisions.filter((d) => payloadOf(d).verdict !== "allow").slice(-8);
      for (const d of notable) {
        const p = payloadOf(d);
        say(
          `    ${dim(`#${d.seq}`)} ${danger(String(p.verdict))} ${text(String(p.toolName))} ${dim(`[${p.risk ?? "?"} · ${p.source ?? "?"}]`)} ${String(
            p.reason ?? "",
          )
            .replace(/\s+/g, " ")
            .slice(0, 110)}`,
        );
      }
    }

    // ── The supervisor's own record ──
    //
    // Sourced from the database, not from a counter in a live process. The
    // distinction is the whole point: the risk this measures is a halt, and a
    // halt frequently ends the process that was holding the count.
    //
    // Two scopes, because they answer different questions. This session says
    // what happened here; the whole store says whether the calibration is
    // drifting, which one session can never show.
    {
      const here = readAutoSafetyMetrics(dbPath, { sessionId: id });
      const everywhere = readAutoSafetyMetrics(dbPath);
      say();
      say(`  ${text("Supervisor")}  ${dim("false positives, read back from the log")}`);
      for (const line of formatAutoSafetyMetrics(everywhere)) {
        say(`    ${dim("all sessions")}  ${line}`);
      }
      if (here.supervisorScreens > 0 || here.heldSteps.total > 0 || here.supervisorHalts > 0) {
        for (const line of formatAutoSafetyMetrics(here)) {
          say(`    ${dim("this session")}  ${line}`);
        }
      }
    }

    // ── Held steps ──
    const held = rows.filter((r) => r.event.type === "auto_deferrals");
    if (held.length > 0) {
      say();
      say(
        `  ${text("Held steps")}  ${dim("outward actions Auto mode declined to take on its own")}`,
      );
      for (const h of held.slice(-3)) {
        const list = payloadOf(h).deferrals;
        if (!Array.isArray(list)) continue;
        for (const d of list as Array<{ toolName?: string; summary?: string; reason?: string }>) {
          say(
            `    ${warn("!")} ${text(String(d.toolName))} ${String(d.summary ?? "").slice(0, 80)} ${dim(String(d.reason ?? "").slice(0, 70))}`,
          );
        }
      }
    }

    // ── Gates and breakers, from the black box ──
    try {
      const bb = new BlackboxStore(join(getGearHome(), "blackbox.db"));
      try {
        const incidents = bb.list({ sessionId: id, class: "loop.", limit: 200 });
        if (incidents.length > 0) {
          const byClass = new Map<string, number>();
          for (const i of incidents) byClass.set(i.class, (byClass.get(i.class) ?? 0) + 1);
          say();
          say(
            `  ${text("Harness")}  ${[...byClass.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, c]) => `${k.replace(/^loop\./, "")} ${dim(String(c))}`)
              .join(dim(" · "))}`,
          );
        }
      } finally {
        bb.close();
      }
    } catch {
      // No black box, no harness section.
    }

    // ── Context utilization (P10.8) ──
    //
    // How full the window ran, and what compaction took out of it. Sourced from
    // the persisted usage rows: a live counter dies with the process, and the
    // turns worth reading are usually the ones just before it did.
    {
      const ctx = contextLedger(rows);
      const measured = ctx.turns.filter((t) => t.used !== null);
      if (ctx.turns.length > 0 || ctx.compactions.length > 0) {
        say();
        if (measured.length === 0) {
          say(
            `  ${text("Context")}  ${dim(`${num(ctx.turns.length)} turns`)} ${dim("·")} ${dim("no data")} ${faint("— no provider on this run reported input usage")}`,
          );
        } else {
          const warm = measured.reduce((sum, t) => sum + (t.cacheShare ?? 0) * t.used!, 0);
          const totalUsed = measured.reduce((sum, t) => sum + t.used!, 0);
          const rate = totalUsed > 0 ? warm / totalUsed : null;
          const anyAssumed = measured.some((t) => t.assumed);
          say(
            `  ${text("Context")}  ${num(measured.length)} turn${measured.length === 1 ? "" : "s"} measured` +
              ` ${dim("·")} peak ${occupancy(ctx.peak)} of ${num(ctx.peak?.limit ?? 0)}` +
              ` ${dim(`(${num(ctx.peak?.used ?? 0)})`)}` +
              ` ${dim("·")} last ${occupancy(ctx.last)}` +
              ` ${dim("·")} cache ${formatCacheRate(rate)}` +
              (anyAssumed ? ` ${dim("·")} ${warn("window assumed for some turns")}` : ""),
          );
          // The tail of the run, where the interesting turns are.
          for (const t of measured.slice(-8)) {
            const pct = Math.round((t.used! / t.limit) * 100);
            // Clamped: an assumed window can be smaller than what the provider
            // actually served, and a 300% bar would run off the line while
            // saying nothing the number beside it does not.
            const filled = Math.min(10, Math.max(1, Math.round(pct / 10)));
            const bar = "█".repeat(filled).padEnd(10, "·");
            say(
              `    ${dim(`#${t.seq}`.padEnd(6))} ${(pct >= 70 ? warn : dim)(bar)} ${String(pct).padStart(3)}%` +
                ` ${dim(`${num(t.used!)} / ${num(t.limit)}`)}` +
                ` ${dim("·")} ${dim(`cache ${formatCacheRate(t.cacheShare)}`)}` +
                (t.assumed ? ` ${dim("(window assumed)")}` : ""),
            );
          }
        }
        for (const c of ctx.compactions.slice(-6)) {
          const delta =
            c.before !== null && c.after !== null && c.before > 0
              ? `${num(c.before)} → ${num(c.after)} ${dim(`(-${Math.round((1 - c.after / c.before) * 100)}%)`)}`
              : "sizes not recorded";
          say(
            `    ${dim(`#${c.seq}`.padEnd(6))} ${info("compacted")} ${delta}` +
              ` ${dim("·")} ${dim(droppedBy(c))} ${dim("·")} ${faint(triggeredBy(c))}`,
          );
        }
      }
    }

    // ── Cost ──
    let usd = 0;
    let list = 0;
    let subscription = false;
    let tokIn = 0;
    let tokOut = 0;
    // Per provider, because that is the axis a cache answer varies on: a run
    // that fell back from a caching provider to one with none reports a
    // blended rate describing neither, and the blend is the flattering number.
    const cache = new Map<string, { read: number; total: number }>();
    for (const r of rows) {
      if (r.event.type !== "cost") continue;
      const p = payloadOf(r);
      usd += Number(p.costUsd ?? 0) || 0;
      list += Number(p.listCostUsd ?? 0) || 0;
      if (p.billing === "subscription") subscription = true;
      const fresh = Number(p.inputTokens ?? 0) || 0;
      const read = Number(p.cacheReadTokens ?? 0) || 0;
      const written = Number(p.cacheCreationTokens ?? 0) || 0;
      tokIn += fresh;
      tokOut += Number(p.outputTokens ?? 0) || 0;
      const provider = String(p.provider ?? "unknown");
      const acc = cache.get(provider) ?? { read: 0, total: 0 };
      acc.read += read;
      acc.total += fresh + read + written;
      cache.set(provider, acc);
    }
    if (tokIn + tokOut > 0) {
      say();
      say(
        `  ${text("Cost")}  $${list.toFixed(4)} ${dim("list")} ${dim("·")} $${usd.toFixed(4)} ${dim(subscription ? "paid (subscription)" : "paid")} ${dim("·")} ${num(tokIn)} in ${dim("·")} ${num(tokOut)} out`,
      );
      for (const [provider, acc] of cache) {
        // null, NOT zero, when the provider reported no input at all. Rendered
        // through the one formatter every cost surface uses, so "no data"
        // reads the same here as in /cost and the status line.
        const rate = acc.total > 0 ? acc.read / acc.total : null;
        const saved = savedByCache(rows, provider);
        say(
          `  ${dim("cache")}  ${text(provider)} ${dim("·")} ${formatCacheRate(rate)}` +
            `${rate === null ? "" : ` ${dim(`(${num(acc.read)} of ${num(acc.total)} warm)`)}`}` +
            `${saved > 0 ? ` ${dim("·")} saved $${saved.toFixed(4)} ${dim("list")}` : ""}`,
        );
      }
    }
    say();
    say(dim(`  full record: gear export ${id} --format md`));
    say();
    return 0;
  } finally {
    sm.close();
  }
}

/**
 * What the cache saved on one provider, in list dollars: the cost of the warm
 * tokens had they all been billed fresh, minus what a cached read costs. The
 * per-token rates live in MODEL_PRICING, so this reads them per row rather
 * than assuming one model ran the whole session.
 */
function savedByCache(
  rows: { event: { type: string; payload?: unknown } }[],
  provider: string,
): number {
  let saved = 0;
  for (const r of rows) {
    if (r.event.type !== "cost") continue;
    const p = (r.event.payload ?? {}) as Record<string, unknown>;
    if (String(p.provider ?? "unknown") !== provider) continue;
    const read = Number(p.cacheReadTokens ?? 0) || 0;
    if (read <= 0) continue;
    const price = MODEL_PRICING[String(p.model ?? "")];
    if (!price) continue;
    // A cache read bills at a fraction of the fresh input rate; the saving is
    // the difference. Anthropic reads at 10%, and the OpenAI-compatible hosts
    // that report cached tokens discount at least as much, so 90% of the fresh
    // rate is the conservative floor of what was saved.
    saved += (read / 1_000_000) * price.inputPerMillion * 0.9;
  }
  return saved;
}
