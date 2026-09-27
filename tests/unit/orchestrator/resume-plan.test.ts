/**
 * M6, the minimal slice: a run that stopped at a provider wall comes back,
 * within a deadline and a budget, across process restarts. Everything here is
 * a fake clock — it proves the transitions, not that a laptop stays awake.
 */

import { describe, expect, test } from "bun:test";

import {
  afterRun,
  backoffMs,
  cancelPlan,
  claimIfDue,
  RESUME_BACKOFF_CAP_MS,
  RESUME_MIN_WAIT_MS,
  startPlan,
  type ResumePlan,
  type ResumePolicy,
} from "../../../packages/orchestrator/src/resume-plan";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 27, 22, 0, 0); // 22:00 UTC, the start of a night

function policy(extra: Partial<ResumePolicy> = {}): ResumePolicy {
  return { deadlineAt: T0 + 8 * HOUR, budgetUsd: 2, maxAttempts: 12, ...extra };
}

const wall = (providerUntil: number | null = null) => ({ kind: "wall" as const, providerUntil });
const run = (spentUsd: number, activeMs = 10 * MIN) => ({ spentUsd, activeMs });

describe("the endings a wait cannot fix", () => {
  test("a finished task is done; a run's own ending is stopped; a missing key is blocked", () => {
    const p = startPlan("s1", policy(), T0);
    expect(afterRun(p, { kind: "finished" }, run(0.2), T0 + HOUR).status).toBe("done");
    const stopped = afterRun(p, { kind: "stopped", stopReason: "max_turns" }, run(0.2), T0);
    expect(stopped.status).toBe("stopped");
    expect(stopped.reason).toContain("max_turns");
    expect(afterRun(p, { kind: "blocked", why: "no credentials" }, run(0), T0).status).toBe(
      "blocked",
    );
  });

  test("a terminal plan does not move again", () => {
    const done = afterRun(startPlan("s1", policy(), T0), { kind: "finished" }, run(0.1), T0);
    expect(afterRun(done, wall(), run(0.5), T0 + HOUR)).toBe(done);
    expect(cancelPlan(done)).toBe(done);
  });

  test("a person's cancel is terminal and says so", () => {
    const c = cancelPlan(startPlan("s1", policy(), T0));
    expect(c.status).toBe("cancelled");
    expect(c.reason).toContain("person");
  });
});

describe("backoff when the provider named no window", () => {
  test("grows ×3 from five minutes and stops at the cap", () => {
    expect(backoffMs(1)).toBe(5 * MIN);
    expect(backoffMs(2)).toBe(15 * MIN);
    expect(backoffMs(3)).toBe(45 * MIN);
    expect(backoffMs(4)).toBe(135 * MIN);
    expect(backoffMs(5)).toBe(RESUME_BACKOFF_CAP_MS);
    expect(backoffMs(40)).toBe(RESUME_BACKOFF_CAP_MS);
    expect(backoffMs(0)).toBe(5 * MIN);
  });
});

describe("claiming a waiting plan", () => {
  const waiting = (): ResumePlan => ({
    ...startPlan("s1", policy(), T0),
    status: "waiting",
    nextAt: T0 + HOUR,
    hint: "provider-window",
    stoppedAt: T0,
  });

  test("not before its time, and then exactly once", () => {
    expect(claimIfDue(waiting(), T0 + 30 * MIN).claimed).toBe(false);
    const due = claimIfDue(waiting(), T0 + HOUR);
    expect(due.claimed).toBe(true);
    expect(due.plan.status).toBe("active");
    expect(due.plan.attempts).toBe(1);
    expect(due.plan.waitedMs).toBe(HOUR);
    expect(claimIfDue(due.plan, T0 + 2 * HOUR).claimed).toBe(false);
  });

  test("a wait that outlives the deadline expires instead of resuming", () => {
    const late = claimIfDue(waiting(), T0 + 9 * HOUR);
    expect(late.claimed).toBe(false);
    expect(late.plan.status).toBe("expired");
  });

  test("sleep counts as waiting and refunds nothing", () => {
    // The laptop slept from 23:00 to 06:00: the wall clock moved seven hours.
    const due = claimIfDue(waiting(), T0 + 7 * HOUR);
    expect(due.plan.waitedMs).toBe(7 * HOUR);
    expect(due.plan.spentUsd).toBe(0);
    expect(due.plan.policy.deadlineAt).toBe(T0 + 8 * HOUR);
  });
});

// ─── The wall: the policy a person writes (TODO(human) in resume-plan.ts) ───

describe("a run that stopped at a provider wall", () => {
  test("waits for the provider's own window when it is known and ahead", () => {
    const p = afterRun(startPlan("s1", policy(), T0), wall(T0 + 2 * HOUR), run(0.3), T0);
    expect(p.status).toBe("waiting");
    expect(p.nextAt).toBe(T0 + 2 * HOUR);
    expect(p.hint).toBe("provider-window");
  });

  test("backs off, bounded, when there is no window — or it has already passed", () => {
    const base = { ...startPlan("s1", policy(), T0), attempts: 2 };
    const none = afterRun(base, wall(null), run(0.3), T0);
    expect(none.status).toBe("waiting");
    expect(none.nextAt).toBe(T0 + backoffMs(3));
    expect(none.hint).toBe("backoff");
    const stale = afterRun(base, wall(T0 - HOUR), run(0.3), T0);
    expect(stale.nextAt).toBe(T0 + backoffMs(3));
  });

  test("never knocks again sooner than the floor", () => {
    const p = afterRun(startPlan("s1", policy(), T0), wall(T0 + 10_000), run(0.3), T0);
    expect(p.nextAt).toBe(T0 + RESUME_MIN_WAIT_MS);
  });

  test("does not wait for a window that opens after the deadline", () => {
    const p = afterRun(startPlan("s1", policy(), T0), wall(T0 + 9 * HOUR), run(0.3), T0);
    expect(p.status).toBe("expired");
    expect(p.nextAt).toBeNull();
  });

  test("stops when the mission's budget is spent, even with the window open", () => {
    const p = afterRun(startPlan("s1", policy({ budgetUsd: 1 }), T0), wall(T0 + HOUR), run(1), T0);
    expect(p.status).toBe("exhausted");
    expect(p.reason).toContain("budget");
  });

  test("stops when the resume allowance is used up", () => {
    const base = { ...startPlan("s1", policy({ maxAttempts: 3 }), T0), attempts: 3 };
    const p = afterRun(base, wall(T0 + HOUR), run(0.3), T0);
    expect(p.status).toBe("exhausted");
  });

  test("with no budget, spend alone never stops it", () => {
    const p = afterRun(
      startPlan("s1", policy({ budgetUsd: null }), T0),
      wall(T0 + HOUR),
      run(50),
      T0,
    );
    expect(p.status).toBe("waiting");
  });

  test("spend only grows: a smaller reading after a resume refunds nothing", () => {
    const first = afterRun(startPlan("s1", policy(), T0), wall(T0 + HOUR), run(0.8), T0);
    const second = afterRun(
      { ...first, status: "active" },
      wall(T0 + 3 * HOUR),
      run(0.5),
      T0 + 2 * HOUR,
    );
    expect(second.spentUsd).toBe(0.8);
  });
});

describe("a 48-hour night on a fake clock", () => {
  test("walls every five hours: resumes on each window, never early, and ends at the deadline", () => {
    const deadline = T0 + 48 * HOUR;
    let plan = startPlan("night", policy({ deadlineAt: deadline, budgetUsd: 5 }), T0);
    let now = T0;
    let spent = 0;
    let resumes = 0;
    for (let guard = 0; guard < 100; guard++) {
      // Each run works an hour, spends ten cents, and hits the weekly-style cap
      // whose window reopens four hours later.
      now += HOUR;
      spent += 0.1;
      plan = afterRun(plan, wall(now + 4 * HOUR), run(spent, HOUR), now);
      if (plan.status !== "waiting") break;
      const early = claimIfDue(plan, plan.nextAt! - 1);
      expect(early.claimed).toBe(false);
      now = plan.nextAt!;
      const due = claimIfDue(plan, now);
      plan = due.plan;
      if (!due.claimed) break;
      resumes++;
    }
    expect(plan.status).toBe("expired");
    expect(resumes).toBe(plan.attempts);
    expect(resumes).toBeLessThanOrEqual(12);
    expect(now).toBeLessThanOrEqual(deadline);
    expect(plan.activeMs + plan.waitedMs).toBeLessThanOrEqual(48 * HOUR);
    expect(plan.spentUsd).toBeCloseTo(spent, 9);
  });
});
