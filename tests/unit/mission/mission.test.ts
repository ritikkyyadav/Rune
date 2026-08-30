import { describe, it, expect } from "vitest";
import { MissionLog } from "../../../packages/mission/src/log";
import {
  InvariantError,
  elapsedMs,
  metCriteria,
  replay,
  initialState,
} from "../../../packages/mission/src/reduce";
import { terminus } from "../../../packages/mission/src/surface/holds";
import { changeRow, diffWindow } from "../../../packages/mission/src/surface/stream";
import { plainCaps } from "../../../packages/mission/src/render/caps";
import { plainText } from "../../../packages/mission/src/render/row";

const caps = plainCaps();
const clock = (start = 0) => {
  let t = start;
  return { now: () => (t += 1000) };
};

const open = (log: MissionLog) =>
  log.append({
    type: "MISSION_OPENED",
    id: "m-4f2a",
    objective: "release-ready authentication",
    scope: ["src/auth/**"],
    exclusions: ["everything else in the tree"],
    budget: "no cap set · I stop and ask at 45 minutes",
    baseline: "8a3f1c2",
    criteria: [
      { id: "c1", text: "the three reported failures reproduce, then stop" },
      { id: "c2", text: "every fix has a test that failed before it" },
    ],
  });

describe("a criterion flips only on evidence", () => {
  // Test 2, load-bearing. Assert on a fabricated log that says "done" in prose.
  it("ignores a model that says the work is finished", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({ type: "TOOL_STARTED", id: "t1", verb: "run", args: "pytest", actor: "gear" });
    log.append({
      type: "TOOL_ENDED",
      id: "t1",
      exit: 0,
      // The model's own words, verbatim, in the payload — and they change nothing.
      detail: "All criteria met. The mission is complete and every test passes.",
      bytes: 900,
      elapsedMs: 6200,
      rung: "observed",
    });
    expect(metCriteria(log.current)).toBe(0);
    expect(log.current.criteria.every((c) => !c.met)).toBe(true);
  });

  it("refuses a criterion whose test never failed on the baseline", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    expect(() =>
      log.append({
        type: "CRITERION_MET",
        id: "c2",
        detail: "6 tests",
        evidence: {
          kind: "test",
          command: "vitest",
          passed: 6,
          total: 6,
          baseline: "8a3f1c2",
          baselineFailed: false, // green before the change: it proves nothing
        },
      }),
    ).toThrow(InvariantError);
    expect(metCriteria(log.current)).toBe(0);
  });

  it("accepts one that was red on the parent commit", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "CRITERION_MET",
      id: "c2",
      detail: "6 tests · all red on 8a3f1c2",
      evidence: {
        kind: "test",
        command: "vitest tests/auth",
        passed: 6,
        total: 6,
        baseline: "8a3f1c2",
        baselineFailed: true,
      },
    });
    expect(metCriteria(log.current)).toBe(1);
  });
});

describe("a check with no baseline can never be verified", () => {
  // Test 3, load-bearing.
  it("throws rather than rendering a ✓ it cannot support", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    expect(() =>
      log.append({
        type: "CHECK_RESULT",
        kind: "integration",
        runner: "vitest",
        passed: 61,
        total: 61,
        elapsedMs: 48_000,
        rung: "verified",
      }),
    ).toThrow(/not evidence/);
  });

  it("allows the same check at the rung it can actually support", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "CHECK_RESULT",
      kind: "integration",
      runner: "vitest",
      passed: 61,
      total: 61,
      elapsedMs: 48_000,
      rung: "observed",
    });
    expect(log.current.checks[0]?.rung).toBe("observed");
  });
});

describe("concluded, not complete", () => {
  // Test 5: a mission that concludes with unmet criteria is representable and renders.
  // The inverse — a success claim with an unmet criterion — is unconstructible.
  it("renders the same shape whether or not it succeeded", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "CRITERION_MET",
      id: "c1",
      detail: "2 fixed · 1 not reproducible",
      evidence: {
        kind: "test",
        command: "pytest tests/auth",
        passed: 2,
        total: 2,
        baseline: "8a3f1c2",
        baselineFailed: true,
      },
    });
    log.append({ type: "MISSION_CONCLUDED", outcome: "concluded", elapsedMs: 1_122_000 });

    const state = log.current;
    expect(state.phase).toBe("concluded");
    expect(metCriteria(state)).toBe(1);
    expect(state.criteria.length).toBe(2);

    const rows = terminus(
      state,
      { notDone: ["f-03 is real and I left it alone"], evidence: [] },
      caps,
    );
    const text = rows.map((r) => (r ? plainText(r, caps) : "")).join("\n");
    // The unmet criterion is on screen, with its own mark, not quietly dropped.
    expect(text).toContain("every fix has a test that failed before it");
    expect(text).toContain("unmet");
    expect(text).toContain("what I did not do");
  });

  it("cannot be made to claim success while a criterion is unmet", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({ type: "MISSION_CONCLUDED", outcome: "concluded", elapsedMs: 1000 });
    // Success is not a state; it is a count. There is no field to set.
    expect(metCriteria(log.current)).toBe(0);
    expect(Object.keys(log.current)).not.toContain("succeeded");
  });
});

describe("the log is the mission", () => {
  // Test 4: replaying any prefix equals replaying it with a CHECKPOINT in the middle.
  it("replays to the same state through a checkpoint", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "PLAN_SET",
      revision: 1,
      steps: [{ index: "01", title: "map", dependsOn: [] }],
    });
    log.append({ type: "CHECKPOINT", treeSha: "deadbeef", planRevision: 1, openAgents: [] });
    log.append({ type: "PHASE_OPENED", index: "01", title: "map the auth surface" });

    const direct = replay([...log.all], initialState());
    expect(direct).toEqual(log.current);

    const seq = log.all[log.all.length - 1]!.seq;
    expect(log.at(seq)).toEqual(log.current);
  });

  it("answers the only two questions anyone has after a crash", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({ type: "CHECKPOINT", treeSha: "deadbeef", planRevision: 1, openAgents: [] });
    log.append({ type: "PHASE_OPENED", index: "08", title: "full verification" });
    const { lost, keptThrough } = log.lossReport();
    expect(keptThrough).toBe(2);
    expect(lost.map((e) => e.type)).toEqual(["PHASE_OPENED"]);
  });

  it("counts elapsed as a fact and never guesses what remains", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({ type: "CHECKPOINT", treeSha: "x", planRevision: 1, openAgents: [] });
    expect(elapsedMs(log.current)).toBeGreaterThan(0);
  });
});

describe("nothing large enters the stream without a keystroke", () => {
  // Test 7: a single CHANGE_APPLIED never floods scrollback.
  it("spends one row on a changed file", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "CHANGE_APPLIED",
      path: "src/auth/session.ts",
      hunks: 2,
      added: 35,
      removed: 14,
      cause: "f-02",
      tests: ["session_race_test.ts"],
    });
    const rows = changeRow(log.current.changes[0]!, caps, "04", 1);
    expect(rows).toHaveLength(1);
    expect(plainText(rows[0]!, caps).length).toBeLessThanOrEqual(caps.measure);
  });

  it("caps an opened diff at twelve rows plus its header and its keys", () => {
    const lines = Array.from({ length: 400 }, (_, i) => ({
      line: i + 1,
      sign: (i % 7 === 0 ? "+" : " ") as "+" | " ",
      text: `const value${i} = compute(${i})`,
    }));
    const rows = diffWindow("src/auth/session.ts", "hunk 1 of 2", lines, "04", 1);
    expect(rows.length).toBeLessThanOrEqual(14);
  });
});

describe("every opened phase closes", () => {
  // Test 8, including on failure.
  it("closes a phase that missed, rather than leaving it running", () => {
    const log = new MissionLog(undefined, clock());
    open(log);
    log.append({
      type: "PLAN_SET",
      revision: 1,
      steps: [{ index: "08", title: "verify", dependsOn: [] }],
    });
    log.append({ type: "PHASE_OPENED", index: "08", title: "full verification" });
    log.append({
      type: "PHASE_CLOSED",
      index: "08",
      outcome: "missed",
      summary: "the integration environment did not start",
      rung: "observed",
      elapsedMs: 182_000,
    });
    expect(log.current.phases.every((p) => p.state === "closed")).toBe(true);
    expect(log.current.phases[0]?.outcome).toBe("missed");
  });
});
