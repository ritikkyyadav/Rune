// ─── rune missions — runs that resume after a provider wall ───
//
//   rune -P "…" --resume-until 8h [--resume-budget 2] [--resume-max 12]
//        opt in: if a quota wall or a lost provider stops the run, wait for the
//        provider's window (or back off, bounded) and continue the session —
//        until the deadline, the budget or the resume allowance runs out.
//   rune missions                 every plan: status, next attempt, deadline, spend
//   rune missions run             continue this workspace's due plans, then exit
//                                 (what cron or launchd calls after a restart)
//   rune missions cancel <id>     stop one — a person's call, kept in its history
//
// No daemon. A plan waits in `rune.db`; the process that made it waits for it
// while it lives, and `missions run` picks it up if that process died.

import type { Engine } from "../engine";
import type { HeadlessResult } from "../headless";
import { runWithResume, RESUME_PROMPT, type ResumeLoopDeps } from "../resume-loop";
import {
  cancelPlan,
  claimIfDue,
  RESUME_DEFAULT_MAX_ATTEMPTS,
  startPlan,
  type ResumePlan,
  type ResumePolicy,
} from "../resume-plan";
import { ResumePlanStore } from "../resume-store";
import { danger, dim, info, muted, ok, text, warn } from "./ui/theme";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `--resume-until`: a duration from now (`90m`, `8h`, `2d`) or an absolute
 * time (`2026-09-28T07:00`). Returns the deadline, or an error in words.
 */
export function parseDeadline(raw: string, now: number): number | { error: string } {
  const trimmed = raw.trim();
  const dur = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (dur) {
    const ms = Number(dur[1]) * UNIT_MS[dur[2]!.toLowerCase()]!;
    if (ms <= 0) return { error: `--resume-until ${raw}: the window must be positive` };
    return now + ms;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return {
      error: `--resume-until ${raw}: expected a duration like 8h or a time like 2026-09-28T07:00`,
    };
  }
  if (at <= now) return { error: `--resume-until ${raw}: that time has already passed` };
  return at;
}

/**
 * The policy the resume flags describe, `null` when the run did not opt in, or
 * an error. `--resume-budget` and `--resume-max` without `--resume-until` are
 * an error, not a silent no-op: a person who set a budget believes it holds.
 */
export function resumePolicyFrom(
  values: Record<string, unknown>,
  now: number,
): ResumePolicy | null | { error: string } {
  const until = values["resume-until"];
  const budget = values["resume-budget"];
  const max = values["resume-max"];
  if (typeof until !== "string") {
    if (budget !== undefined || max !== undefined) {
      return { error: "--resume-budget and --resume-max need --resume-until (the deadline)" };
    }
    return null;
  }
  const deadlineAt = parseDeadline(until, now);
  if (typeof deadlineAt !== "number") return deadlineAt;
  let budgetUsd: number | null = null;
  if (budget !== undefined) {
    const n = Number(budget);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `--resume-budget ${String(budget)}: expected dollars, like 2 or 0.5` };
    }
    budgetUsd = n;
  }
  let maxAttempts = RESUME_DEFAULT_MAX_ATTEMPTS;
  if (max !== undefined) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 0) {
      return { error: `--resume-max ${String(max)}: expected a whole number of resumes` };
    }
    maxAttempts = n;
  }
  return { deadlineAt, budgetUsd, maxAttempts };
}

/** The real world, for the loop: this engine, this session, this store. */
export function engineResumeDeps(
  engine: Engine,
  workspaceRoot: string,
  store: ResumePlanStore,
  runOnce: (prompt: string) => Promise<HeadlessResult>,
  log: (line: string) => void,
): ResumeLoopDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: runOnce,
    spentUsd: () => engine.getListCost(),
    unpriced: () => engine.getUnpricedModels().length > 0,
    providerUntil: () => {
      const provider = engine.getProvider();
      const cooling = engine.getProviderHealth().cooling.find((c) => c.provider === provider);
      return cooling ? cooling.untilMs : null;
    },
    save: (plan) => store.save(plan, workspaceRoot),
    log,
  };
}

/** `rune -P … --resume-until …`: the first run and every resume, in this process. */
export async function runHeadlessWithResume(
  engine: Engine,
  sessionId: string,
  prompt: string,
  policy: ResumePolicy,
  dbPath: string,
  workspaceRoot: string,
  runOnce: (prompt: string) => Promise<HeadlessResult>,
  log: (line: string) => void,
): Promise<{ result: HeadlessResult | null; plan: ResumePlan }> {
  const store = ResumePlanStore.open(dbPath);
  try {
    const plan = startPlan(sessionId, policy, Date.now());
    store.save(plan, workspaceRoot);
    return await runWithResume(
      prompt,
      plan,
      engineResumeDeps(engine, workspaceRoot, store, runOnce, log),
    );
  } finally {
    store.close();
  }
}

/**
 * `rune missions run`: claim and continue this workspace's due plans, one at a
 * time, each through the same loop — then exit. Returns the process exit code:
 * 0 when every claimed plan ended done or still waiting, 1 otherwise.
 */
export async function runDueMissions(
  engine: Engine,
  dbPath: string,
  workspaceRoot: string,
  runOnce: (sessionId: string, prompt: string) => Promise<HeadlessResult>,
  log: (line: string) => void,
): Promise<number> {
  const store = ResumePlanStore.open(dbPath);
  let failed = 0;
  try {
    const due = store.due(Date.now(), workspaceRoot);
    if (due.length === 0) {
      log("missions: nothing due in this workspace");
      return 0;
    }
    for (const { plan } of due) {
      const claim = claimIfDue(plan, Date.now());
      store.save(claim.plan, workspaceRoot);
      if (!claim.claimed) {
        log(
          `missions: ${plan.sessionId.slice(-8)} ${claim.plan.status} — ${claim.plan.reason ?? ""}`,
        );
        continue;
      }
      log(`missions: ${plan.sessionId.slice(-8)} resume ${claim.plan.attempts} — continuing`);
      const out = await runWithResume(
        RESUME_PROMPT,
        claim.plan,
        engineResumeDeps(
          engine,
          workspaceRoot,
          store,
          (prompt) => runOnce(plan.sessionId, prompt),
          log,
        ),
      );
      if (out.plan.status !== "done" && out.plan.status !== "waiting") failed++;
    }
    return failed === 0 ? 0 : 1;
  } finally {
    store.close();
  }
}

/** `rune missions` and `rune missions cancel <id>`: no engine, no model. */
export function runMissionsCommand(
  dbPath: string,
  args: string[],
  out: (line: string) => void,
): number {
  const sub = args[0];
  const store = ResumePlanStore.open(dbPath);
  try {
    if (sub === "cancel") {
      const id = args[1];
      const match = id
        ? store.list().filter((s) => s.plan.sessionId.endsWith(id) || s.plan.sessionId === id)
        : [];
      if (match.length !== 1) {
        out(
          `  ${danger("!")} ${id ? `no single plan matches "${id}"` : "usage: rune missions cancel <session-id>"}`,
        );
        return 2;
      }
      const { plan, workspaceRoot } = match[0]!;
      const next = cancelPlan(plan);
      if (next === plan) {
        out(dim(`  ${plan.sessionId.slice(-8)} is already ${plan.status}; nothing to cancel.`));
        return 0;
      }
      store.save(next, workspaceRoot);
      out(`  ${ok("Cancelled")} ${text(plan.sessionId.slice(-8))} ${dim("· kept in its history")}`);
      return 0;
    }
    if (sub !== undefined && sub !== "list") {
      out(dim("  Usage: rune missions [list | run | cancel <session-id>]"));
      return 2;
    }
    const plans = store.list();
    out("");
    if (plans.length === 0) {
      out(
        dim(
          '  No missions. Opt a headless run in with: rune -P "…" --resume-until 8h [--resume-budget 2]',
        ),
      );
      out("");
      return 0;
    }
    const now = Date.now();
    for (const { plan, workspaceRoot, history } of plans) {
      const status =
        plan.status === "waiting"
          ? warn("waiting")
          : plan.status === "done"
            ? ok("done")
            : plan.status === "active"
              ? info("active")
              : muted(plan.status);
      const next =
        plan.status === "waiting" && plan.nextAt !== null
          ? ` · next ${new Date(plan.nextAt).toLocaleString()}${plan.nextAt <= now ? " (due)" : ""}`
          : "";
      const budget =
        plan.policy.budgetUsd === null ? "" : ` of $${plan.policy.budgetUsd.toFixed(2)}`;
      out(
        `  ${status} ${text(plan.sessionId.slice(-8))} ${dim(workspaceRoot)}` +
          dim(
            `${next} · deadline ${new Date(plan.policy.deadlineAt).toLocaleString()} · spent $${plan.spentUsd.toFixed(4)}${budget} · resumes ${plan.attempts}/${plan.policy.maxAttempts}`,
          ),
      );
      if (plan.reason && plan.status !== "done") out(dim(`      ${plan.reason}`));
      if (history.length > 1) out(dim(`      ${history.map((h) => h.status).join(" → ")}`));
    }
    out("");
    out(
      dim("  rune missions run (in a workspace) continues what is due · rune missions cancel <id>"),
    );
    out("");
    return 0;
  } finally {
    store.close();
  }
}
