/**
 * P7.6 — the lessons lifecycle.
 *
 * Before this, "learned" and "believed" were one thing: an observation from one
 * run was injected into every later run with nothing in between. These tests are
 * about the gaps between the rungs — what does NOT get injected, what does NOT
 * become active, and what an "outcome" is allowed to mean.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotebookStore } from "../../../packages/orchestrator/src/notebook/store";
import { CostGovernor } from "../../../packages/orchestrator/src/notebook/governor";
import {
  ACTIVE_FIRINGS,
  ACTIVE_FLOOR,
  TRIAL_SESSIONS,
  activeThreshold,
  advanceLessons,
  isWinningRun,
  lessonBaseline,
  mayDistil,
  stageCounts,
} from "../../../packages/orchestrator/src/evolve/lessons";

let dir: string;
let store: NotebookStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-lessons-"));
  store = new NotebookStore(join(dir, "notebook.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const REPO = "r1";
const clean = {
  aborted: false,
  runError: false,
  unprovenSteps: 0,
  checksFailed: 0,
  struggled: false,
};

function seed(
  title: string,
  opts: { sessions: string[]; stage?: "candidate" | "trial" | "active" },
) {
  let id = "";
  for (const s of opts.sessions) {
    id = store.upsert({
      kind: "tactic",
      scope: "repo",
      repoKey: REPO,
      title,
      body: `body for ${title}`,
      sessionId: s,
      stage: opts.stage ?? "candidate",
    });
  }
  return id;
}

describe("the outcome signal", () => {
  it("counts a run as a win only when nothing went wrong at all", () => {
    expect(isWinningRun(clean)).toBe(true);
  });

  it("does not credit a run that closed a step without evidence", () => {
    // The old signal was `!runError && !aborted`, which counted exactly this.
    expect(isWinningRun({ ...clean, unprovenSteps: 1 })).toBe(false);
  });

  it("does not credit a run where a check failed", () => {
    expect(isWinningRun({ ...clean, checksFailed: 1 })).toBe(false);
  });

  it("does not credit a run somebody had to steer", () => {
    // A rephrase or a correction means the advice did not carry the run.
    expect(isWinningRun({ ...clean, struggled: true })).toBe(false);
  });

  it("does not credit an aborted or errored run", () => {
    expect(isWinningRun({ ...clean, aborted: true })).toBe(false);
    expect(isWinningRun({ ...clean, runError: true })).toBe(false);
  });
});

describe("candidates are stored and never injected", () => {
  it("keeps a one-session candidate out of retrieval", () => {
    seed("avoid:npm:aaa", { sessions: ["s1"] });
    expect(store.listRepo(REPO)).toHaveLength(1);
    expect(store.retrieve({ repoKey: REPO, stackKey: "bun" })).toHaveLength(0);
  });

  it("promotes to trial on a second session, and only then is it injected", () => {
    seed("avoid:npm:aaa", { sessions: ["s1"] });
    expect(advanceLessons(store, store.listRepo(REPO))).toHaveLength(0);

    seed("avoid:npm:aaa", { sessions: ["s2"] });
    const moved = advanceLessons(store, store.listRepo(REPO));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ from: "candidate", to: "trial" });
    expect(moved[0].reason).toContain(`≥${TRIAL_SESSIONS}`);
    expect(store.retrieve({ repoKey: REPO, stackKey: "bun" })).toHaveLength(1);
  });
});

describe("trial → active needs firings AND a win rate above the ambient rate", () => {
  it("does not promote before ACTIVE_FIRINGS injections", () => {
    const id = seed("test-command", { sessions: ["s1", "s2"], stage: "trial" });
    for (let i = 0; i < ACTIVE_FIRINGS - 1; i++) {
      store.touchUses([id]);
      store.recordWins([id]);
    }
    expect(advanceLessons(store, store.listRepo(REPO))).toHaveLength(0);
    expect(store.listRepo(REPO)[0].stage).toBe("trial");
  });

  it("promotes once it has the firings and beats the bar", () => {
    const id = seed("test-command", { sessions: ["s1", "s2"], stage: "trial" });
    for (let i = 0; i < ACTIVE_FIRINGS; i++) {
      store.touchUses([id]);
      store.recordWins([id]);
    }
    const moved = advanceLessons(store, store.listRepo(REPO));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ from: "trial", to: "active" });
    expect(store.listRepo(REPO)[0].stage).toBe("active");
  });

  it("refuses a lesson that fires often and rarely wins", () => {
    const id = seed("test-command", { sessions: ["s1", "s2"], stage: "trial" });
    for (let i = 0; i < 10; i++) store.touchUses([id]);
    store.recordWins([id]); // 1/10
    expect(advanceLessons(store, store.listRepo(REPO))).toHaveLength(0);
    expect(store.listRepo(REPO)[0].stage).toBe("trial");
  });

  it("holds a wider-than-repo lesson at trial, whatever its counters say", () => {
    // Promoting advice across projects on one project's runs is the
    // superstition failure; that needs the offline A/B, not a counter.
    const id = store.upsert({
      kind: "tactic",
      scope: "stack",
      stackKey: "bun",
      title: "stack-wide",
      body: "b",
      sessionId: "s1",
      stage: "trial",
    });
    for (let i = 0; i < 20; i++) {
      store.touchUses([id]);
      store.recordWins([id]);
    }
    expect(advanceLessons(store, store.list({ includeRetired: true }))).toHaveLength(0);
  });
});

describe("active → retired when it stops helping", () => {
  it("retires an active lesson whose win rate falls under the floor", () => {
    const id = seed("test-command", { sessions: ["s1", "s2"], stage: "active" });
    for (let i = 0; i < 10; i++) store.touchUses([id]);
    store.recordWins([id]);
    store.recordWins([id]); // 2/10
    const moved = advanceLessons(store, store.listRepo(REPO));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ from: "active", to: "retired" });
    expect(moved[0].reason).toContain(`${ACTIVE_FLOOR * 100}% floor`);
    // Retired means out of retrieval, still inspectable.
    expect(store.retrieve({ repoKey: REPO, stackKey: "bun" })).toHaveLength(0);
    expect(store.listRepo(REPO)).toHaveLength(1);
  });

  it("brings a re-learned retired lesson back as a candidate, not where it left off", () => {
    const id = seed("avoid:x:1", { sessions: ["s1", "s2"], stage: "active" });
    store.retire(id);
    expect(store.listRepo(REPO)[0].stage).toBe("retired");
    seed("avoid:x:1", { sessions: ["s3"] });
    expect(store.listRepo(REPO)[0].stage).toBe("candidate");
    expect(store.retrieve({ repoKey: REPO, stackKey: "bun" })).toHaveLength(0);
  });
});

describe("the baseline", () => {
  it("is null with nothing injected, and the floor applies", () => {
    expect(lessonBaseline([])).toBeNull();
    expect(activeThreshold(null)).toBe(ACTIVE_FLOOR);
  });

  it("rises above the floor once the ambient rate is high", () => {
    const id = seed("t", { sessions: ["s1", "s2"], stage: "trial" });
    for (let i = 0; i < 10; i++) store.touchUses([id]);
    for (let i = 0; i < 9; i++) store.recordWins([id]);
    const baseline = lessonBaseline(store.listRepo(REPO));
    expect(baseline).toBeCloseTo(0.9);
    expect(activeThreshold(baseline)).toBeCloseTo(0.95);
  });
});

describe("stageCounts", () => {
  it("counts the ladder", () => {
    seed("a", { sessions: ["s1"] });
    seed("b", { sessions: ["s1", "s2"], stage: "trial" });
    const id = seed("c", { sessions: ["s1", "s2"], stage: "active" });
    store.retire(id);
    expect(stageCounts(store.listRepo(REPO))).toEqual({
      candidate: 1,
      trial: 1,
      active: 0,
      retired: 1,
    });
  });
});

describe("model-assisted distillation is governed", () => {
  it("allows a free job and refuses one that outbids the session", () => {
    const g = new CostGovernor({ budgetPct: 2, floorUsd: 0.002 });
    expect(mayDistil(g, 0, 0).allowed).toBe(true);
    expect(mayDistil(g, 0.001, 1).allowed).toBe(true);
    const refused = mayDistil(g, 5, 1);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("learning budget exhausted");
  });
});
