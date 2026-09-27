/**
 * M6, the minimal slice, end to end on a fake clock: the loop that runs a
 * headless session, waits out a provider wall, and continues — and the store
 * that lets a NEW process find a plan the old one left waiting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HeadlessResult } from "../../../packages/orchestrator/src/headless";
import {
  classifyEnding,
  RESUME_PROMPT,
  runWithResume,
  type ResumeLoopDeps,
} from "../../../packages/orchestrator/src/resume-loop";
import {
  afterRun,
  cancelPlan,
  claimIfDue,
  startPlan,
  type ResumePlan,
} from "../../../packages/orchestrator/src/resume-plan";
import { ResumePlanStore } from "../../../packages/orchestrator/src/resume-store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 27, 22, 0, 0);

function result(extra: Partial<HeadlessResult> = {}): HeadlessResult {
  return {
    text: "",
    ok: true,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    permissionsDenied: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    ...extra,
  } as HeadlessResult;
}

const QUOTA =
  "Quota exceeded on ollama/qwen3-coder:480b — usage limit reached. Stopped here instead of handing your task to a weaker model. Your work is saved: resume this session in ~30m";

/** A world with a fake clock: each run takes `runMs` and spends `spendPerRun`. */
function world(script: HeadlessResult[], opts: { runMs?: number; spendPerRun?: number } = {}) {
  let now = T0;
  let spent = 0;
  let windowUntil: number | null = null;
  const prompts: string[] = [];
  const saved: ResumePlan[] = [];
  const logs: string[] = [];
  const deps: ResumeLoopDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    run: async (prompt) => {
      prompts.push(prompt);
      now += opts.runMs ?? 10 * MIN;
      spent += opts.spendPerRun ?? 0.1;
      const next = script.shift() ?? result();
      windowUntil = next.ok ? null : now + 30 * MIN;
      return next;
    },
    spentUsd: () => spent,
    unpriced: () => false,
    providerUntil: () => windowUntil,
    save: (next) => {
      saved.push(next);
      return true;
    },
    stored: () => saved[saved.length - 1] ?? null,
    log: (l) => {
      logs.push(l);
    },
  };
  return { deps, prompts, saved, logs, clock: () => now };
}

describe("classifying how a headless run ended", () => {
  test("only a provider wall is resumable", () => {
    expect(classifyEnding(result(), null).kind).toBe("finished");
    expect(classifyEnding(result({ ok: false, error: QUOTA }), T0).kind).toBe("wall");
    expect(classifyEnding(result({ ok: false, stopReason: "provider_lost" }), null).kind).toBe(
      "wall",
    );
    expect(classifyEnding(result({ ok: false, stopReason: "max_turns" }), null).kind).toBe(
      "stopped",
    );
    expect(
      classifyEnding(result({ ok: false, error: "401 Unauthorized: invalid api key" }), null).kind,
    ).toBe("blocked");
  });

  test("carries the provider's window into the ending", () => {
    const ending = classifyEnding(result({ ok: false, error: QUOTA }), T0 + HOUR);
    expect(ending).toEqual({ kind: "wall", providerUntil: T0 + HOUR });
  });
});

describe("the loop", () => {
  test("a run that finishes is done, with no wait and no resume", async () => {
    const w = world([result()]);
    const out = await runWithResume("build it", startPlan("s1", policy(), T0), w.deps);
    expect(out.plan.status).toBe("done");
    expect(w.prompts).toEqual(["build it"]);
  });

  test("a quota wall waits for the provider's window, then continues the session", async () => {
    const w = world([result({ ok: false, error: QUOTA }), result()]);
    const out = await runWithResume("build it", startPlan("s1", policy(), T0), w.deps);
    expect(out.plan.status).toBe("done");
    expect(out.plan.attempts).toBe(1);
    expect(w.prompts).toEqual(["build it", RESUME_PROMPT]);
    // The second run started at the window, not a minute after the stop.
    expect(out.plan.waitedMs).toBe(30 * MIN);
    expect(out.plan.spentUsd).toBeCloseTo(0.2, 9);
  });

  test("a budget on an unpriced model is refused rather than run blind", async () => {
    const w = world([result({ ok: false, error: QUOTA })]);
    w.deps.unpriced = () => true;
    const out = await runWithResume("build it", startPlan("s1", policy(), T0), w.deps);
    expect(out.plan.status).toBe("blocked");
    expect(out.plan.reason).toContain("no list price");
    expect(w.prompts).toHaveLength(1);
  });

  test("a terminal plan runs nothing", async () => {
    const w = world([result()]);
    const cancelled = cancelPlan(startPlan("s1", policy(), T0));
    const out = await runWithResume("build it", cancelled, w.deps);
    expect(out.result).toBeNull();
    expect(w.prompts).toEqual([]);
  });

  test("every transition is saved, so a crash mid-wait leaves a plan to find", async () => {
    const w = world([result({ ok: false, error: QUOTA }), result()]);
    await runWithResume("build it", startPlan("s1", policy(), T0), w.deps);
    expect(w.saved.map((p) => p.status)).toEqual(["waiting", "active", "done"]);
  });
});

describe("a new process finds the plan the old one left waiting", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-resume-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("due plans are this workspace's, soonest first; not-yet-due and finished ones are not", () => {
    const db = join(dir, "rune.db");
    const store = ResumePlanStore.open(db);
    const waitingAt = (id: string, at: number): ResumePlan => ({
      ...startPlan(id, policy(), T0),
      status: "waiting",
      nextAt: at,
      hint: "provider-window",
      stoppedAt: T0,
    });
    store.save(waitingAt("late", T0 + 2 * HOUR), "/ws/a", T0);
    store.save(waitingAt("soon", T0 + HOUR), "/ws/a", T0);
    store.save(waitingAt("other-ws", T0 + HOUR), "/ws/b", T0);
    store.save({ ...startPlan("done", policy(), T0), status: "done" }, "/ws/a", T0);
    store.close();

    // The laptop restarts; a new process opens the same database.
    const again = ResumePlanStore.open(db);
    expect(again.due(T0 + 90 * MIN, "/ws/a").map((s) => s.plan.sessionId)).toEqual(["soon"]);
    expect(again.due(T0 + 3 * HOUR, "/ws/a").map((s) => s.plan.sessionId)).toEqual([
      "soon",
      "late",
    ]);
    expect(again.due(T0 + 3 * HOUR).map((s) => s.plan.sessionId)).toContain("other-ws");
    again.close();
  });

  test("claim, run, save: the restarted process continues the session and records the history", async () => {
    const db = join(dir, "rune.db");
    const store = ResumePlanStore.open(db);
    const left: ResumePlan = {
      ...startPlan("s1", policy(), T0),
      status: "waiting",
      nextAt: T0 + HOUR,
      hint: "provider-window",
      stoppedAt: T0,
      spentUsd: 0.4,
    };
    store.save(left, "/ws/a", T0);

    const w = world([result()]);
    const due = store.due(T0 + HOUR, "/ws/a")[0]!;
    const claim = claimIfDue(due.plan, T0 + HOUR);
    expect(claim.claimed).toBe(true);
    expect(store.transition(due.plan, claim.plan, "/ws/a", T0 + HOUR)).toBe(true);
    const out = await runWithResume(RESUME_PROMPT, claim.plan, {
      ...w.deps,
      now: () => T0 + HOUR + w.clock() - T0,
      spentUsd: () => 0.5,
      save: (next, prev) => store.transition(prev, next, "/ws/a", T0 + HOUR),
      stored: (id) => store.get(id)?.plan ?? null,
    });
    expect(out.plan.status).toBe("done");
    expect(out.plan.spentUsd).toBe(0.5);
    const stored = store.get("s1")!;
    expect(stored.history.map((h) => h.status)).toEqual(["waiting", "active", "done"]);
    expect(stored.plan.attempts).toBe(1);
    store.close();
  });
});

describe("one plan, several processes", () => {
  // A `-P` process waits on its plan in memory; a scheduler's `rune missions
  // run` can find the same plan due in rune.db; a person can cancel it from a
  // third shell. These drive the CLI's real wiring (engineResumeDeps) over a
  // real store, on a fake clock, and count how often the session is resumed.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-resume-race-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function race(during: {
    wait?: (db: string, store: ResumePlanStore, now: number) => void;
    firstRun?: (db: string) => void;
  }) {
    const { engineResumeDeps } =
      await import("../../../packages/orchestrator/src/bin/missions-cli");
    const db = join(dir, "rune.db");
    const store = ResumePlanStore.open(db);
    const plan = startPlan("s1", policy(), T0);
    store.save(plan, "/ws/a", T0);
    let now = T0;
    const runs: string[] = [];
    const script = [result({ ok: false, error: QUOTA }), result()];
    const engine = {
      getListCost: () => 0.1 * runs.length,
      getUnpricedModels: () => [],
      getProvider: () => "ollama",
      getProviderHealth: () => ({ cooling: [] }),
    };
    const deps = {
      ...engineResumeDeps(
        engine as never,
        "/ws/a",
        store,
        async (prompt: string) => {
          runs.push(prompt);
          if (runs.length === 1) during.firstRun?.(db);
          now += 10 * MIN;
          return script.shift() ?? result();
        },
        () => {},
      ),
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        during.wait?.(db, store, now);
      },
    };
    const out = await runWithResume("first", plan, deps);
    const stored = store.get("s1")!.plan;
    store.close();
    return { runs, out, stored };
  }

  test("two processes claim the same due plan: exactly one wins", () => {
    const db = join(dir, "rune.db");
    const first = ResumePlanStore.open(db);
    const second = ResumePlanStore.open(db);
    first.save(
      {
        ...startPlan("s1", policy(), T0),
        status: "waiting",
        nextAt: T0 + HOUR,
        hint: "backoff",
        stoppedAt: T0,
      },
      "/ws/a",
      T0,
    );
    // Both scheduled runs list the plan as due before either claims it.
    const [a] = first.due(T0 + HOUR, "/ws/a");
    const [b] = second.due(T0 + HOUR, "/ws/a");
    const claimA = claimIfDue(a!.plan, T0 + HOUR);
    const claimB = claimIfDue(b!.plan, T0 + HOUR);
    expect([claimA.claimed, claimB.claimed]).toEqual([true, true]);
    expect(first.transition(a!.plan, claimA.plan, "/ws/a", T0 + HOUR)).toBe(true);
    expect(second.transition(b!.plan, claimB.plan, "/ws/a", T0 + HOUR)).toBe(false);
    expect(second.get("s1")!.plan).toMatchObject({ status: "active", attempts: 1 });
    first.close();
    second.close();
  });

  test("a waiting -P loop does not resume a plan a scheduled `missions run` claimed", async () => {
    let claimedElsewhere = false;
    const { runs, stored } = await race({
      wait: (_db, store, now) => {
        const [due] = store.due(now, "/ws/a");
        if (claimedElsewhere || !due) return;
        const claim = claimIfDue(due.plan, now);
        if (claim.claimed) {
          store.save(claim.plan, "/ws/a", now);
          claimedElsewhere = true;
        }
      },
    });
    expect(claimedElsewhere).toBe(true);
    expect(runs).toEqual(["first"]);
    expect(stored).toMatchObject({ status: "active", attempts: 1 });
  });

  test("a -P loop that slept through another resume and its wall does not resume a stale plan", async () => {
    let elsewhere = false;
    const { runs, stored } = await race({
      wait: (_db, store, now) => {
        const [due] = store.due(now, "/ws/a");
        if (elsewhere || !due) return;
        const claim = claimIfDue(due.plan, now);
        if (!claim.claimed || !store.transition(due.plan, claim.plan, "/ws/a", now)) return;
        // The scheduled run resumes the session, and meets the wall again.
        const walled = afterRun(
          claim.plan,
          { kind: "wall", providerUntil: null },
          { spentUsd: 0.3, activeMs: MIN },
          now,
        );
        expect(store.transition(claim.plan, walled, "/ws/a", now)).toBe(true);
        elsewhere = true;
      },
    });
    expect(elsewhere).toBe(true);
    expect(runs).toEqual(["first"]);
    expect(stored).toMatchObject({ status: "waiting", attempts: 1 });
  });

  test("a cancel while a -P loop waits holds", async () => {
    const { runMissionsCommand } =
      await import("../../../packages/orchestrator/src/bin/missions-cli");
    const { runs, out, stored } = await race({
      wait: (db) => void runMissionsCommand(db, ["cancel", "s1"], () => {}),
    });
    expect(runs).toEqual(["first"]);
    expect(stored.status).toBe("cancelled");
    expect(out.plan.status).toBe("cancelled");
  });

  test("a cancel during a run is not undone when the run ends", async () => {
    const { runMissionsCommand } =
      await import("../../../packages/orchestrator/src/bin/missions-cli");
    const { runs, out, stored } = await race({
      firstRun: (db) => void runMissionsCommand(db, ["cancel", "s1"], () => {}),
    });
    expect(runs).toEqual(["first"]);
    expect(stored.status).toBe("cancelled");
    expect(out.plan.status).toBe("cancelled");
  });
});

function policy() {
  return { deadlineAt: T0 + 8 * HOUR, budgetUsd: 2, maxAttempts: 12 };
}

describe("the opt-in flags", () => {
  test("a duration or a time sets the deadline; nonsense and the past are refused in words", async () => {
    const { parseDeadline } = await import("../../../packages/orchestrator/src/bin/missions-cli");
    expect(parseDeadline("8h", T0)).toBe(T0 + 8 * HOUR);
    expect(parseDeadline("90m", T0)).toBe(T0 + 90 * MIN);
    expect(parseDeadline("2d", T0)).toBe(T0 + 48 * HOUR);
    expect(parseDeadline("2026-09-28T07:00:00Z", T0)).toBe(Date.parse("2026-09-28T07:00:00Z"));
    expect(parseDeadline("soon", T0)).toMatchObject({ error: expect.stringContaining("duration") });
    expect(parseDeadline("2026-01-01T00:00:00Z", T0)).toMatchObject({
      error: expect.stringContaining("already passed"),
    });
  });

  test("no --resume-until means no plan; a budget without a deadline is an error, not a no-op", async () => {
    const { resumePolicyFrom } =
      await import("../../../packages/orchestrator/src/bin/missions-cli");
    expect(resumePolicyFrom({}, T0)).toBeNull();
    expect(resumePolicyFrom({ "resume-budget": "2" }, T0)).toMatchObject({
      error: expect.stringContaining("--resume-until"),
    });
    expect(
      resumePolicyFrom({ "resume-until": "8h", "resume-budget": "2", "resume-max": "3" }, T0),
    ).toEqual({
      deadlineAt: T0 + 8 * HOUR,
      budgetUsd: 2,
      maxAttempts: 3,
    });
    expect(resumePolicyFrom({ "resume-until": "8h", "resume-budget": "-1" }, T0)).toMatchObject({
      error: expect.stringContaining("dollars"),
    });
  });
});
