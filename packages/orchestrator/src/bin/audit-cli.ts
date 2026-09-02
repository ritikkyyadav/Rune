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
import { TaskStateStore, stepReceipt } from "../task-state";
import { runEnding, type RunRetro } from "../retro";
import { accent, danger, dim, faint, info, ok, text, warn } from "./ui/theme";
import { formatCacheRate } from "../cost-report";
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
