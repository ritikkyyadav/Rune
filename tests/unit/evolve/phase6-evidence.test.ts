/**
 * Phase 6 — "failed, unpriced, mixed-revision, or interrupted outcomes cannot
 * become positive evidence" (docs/CLAUDE_CODE_HANDOFF.md, Phase 6; the M6
 * clause of docs/program/guarantees-plan-review-20260914.md).
 *
 * Each test is one way the evolution loop could have manufactured a belief at
 * the parent commit. They were written red first, against the code as found:
 *
 *   G1  a mock-mode win promoted, though mock replays a script and cannot show lift
 *   G2  an unpriced arm skipped the cost gate instead of failing it
 *   G3  a provider outage in one arm counted as a capability miss (a fake fix)
 *   G4  re-running a live A/B until it won erased the earlier loss
 *   G5  a measurement taken under an older doctrine or yardstick still promoted
 *   G6  the experiment's own spend was never recorded
 *   G7  a learned lesson could advise leaving the sandbox
 *   G8  a lesson a person retired came back as soon as a run re-learned it
 *   G10 a session could trial a lesson it had itself taught
 *   G11 `rune evolve ab` ran the eval suite inside the invoking user's profile
 *       (found while wiring the CLI: the notebook variants opened the real
 *       notebook.db, and sandboxed commands appended to the real audit log)
 *
 * Everything runs against a temporary RUNE_HOME and an in-memory notebook.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configHash } from "../../../packages/orchestrator/src/evolve/config-hash";
import {
  appendLedger,
  learningSpend,
  readLedger,
  type LedgerEntry,
} from "../../../packages/orchestrator/src/evolve/ledger";
import { promote } from "../../../packages/orchestrator/src/evolve/promote";
import { variantConfig } from "../../../packages/orchestrator/src/evolve/variants";
import { NotebookStore } from "../../../packages/orchestrator/src/notebook/store";
import { buildNotebookBlock } from "../../../packages/orchestrator/src/notebook/retrieval";
import type { ToolObservation } from "../../../packages/orchestrator/src/notebook/capture";
import { retroLessons } from "../../../packages/orchestrator/src/retro";
import { BASH_CONTAINMENT_ESCAPES } from "../../../packages/tool-registry/src/tools/builtin";
import { abChildEnv } from "../../../packages/orchestrator/src/bin/evolve-cli";
import { compareArms, type SuiteReport } from "../../../tests/eval/report";
import { classifyInfra, type TaskResult } from "../../../tests/eval/harness";

// ─── fixtures ───

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-phase6-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const YARD = "aaaa11112222";
const DOCTRINE = "d0c7d0c7d0c7";
const ENV = { yardstick: YARD, blessedYardstick: YARD, doctrineHash: DOCTRINE } as const;

function measurement(extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    v: 1,
    at: "2026-01-01T00:00:00.000Z",
    kind: "measurement",
    subject: "doctrine_full",
    controlConfigHash: configHash({}),
    treatmentConfigHash: configHash(variantConfig("doctrine_full")),
    doctrineHash: DOCTRINE,
    yardstick: YARD,
    mode: "real",
    win: true,
    rateDelta: 0.1,
    costDelta: 0.01,
    compared: 20,
    fixes: ["a", "b"],
    regressions: [],
    refusals: [],
    ...extra,
  };
}

function task(name: string, pass: boolean, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    name,
    category: "core",
    pass,
    durationMs: 100,
    cost: 0,
    listCost: 0.01,
    turns: 3,
    ...extra,
  };
}

function report(tasks: TaskResult[], mode: "mock" | "real" = "real"): SuiteReport {
  const passed = tasks.filter((t) => t.pass).length;
  return {
    timestamp: "2026-09-27T00:00:00.000Z",
    mode,
    total: tasks.length,
    passed,
    passRate: tasks.length ? passed / tasks.length : 0,
    throttled: 0,
    measured: tasks.length,
    cleanPassRate: tasks.length ? passed / tasks.length : 0,
    totalCost: 0,
    avgCostPerTask: 0,
    totalListCost: tasks.reduce((s, t) => s + (t.listCost ?? 0), 0),
    avgListCostPerTask: 0,
    avgDurationMs: 100,
    avgTurns: 3,
    categories: [],
    tasks,
  } as SuiteReport;
}

const bash = (
  command: string,
  success: boolean,
  error?: string,
  extra: Record<string, unknown> = {},
): ToolObservation => ({
  toolName: "bash",
  args: { command, ...extra },
  success,
  ...(error ? { error } : {}),
});

// ─── G1: mock can show harm, never lift ───

describe("G1 — a mock-mode win is not evidence of improvement", () => {
  it("refuses to promote on a mock-mode measurement alone", () => {
    appendLedger(measurement({ mode: "mock" }), home);
    const r = promote("doctrine_full", { home, ...ENV });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("mock");
  });

  it("still promotes on a real-mode win at the same configuration", () => {
    appendLedger(measurement({ mode: "mock" }), home);
    appendLedger(measurement({ mode: "real", at: "2026-01-02T00:00:00.000Z" }), home);
    const r = promote("doctrine_full", { home, ...ENV, now: new Date("2026-01-03T00:00:00Z") });
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ─── G2: unknown cost cannot pass a cost gate ───

describe("G2 — an unpriced arm cannot win", () => {
  it("refuses, and marks the comparison inconclusive, when a compared task ran unpriced", () => {
    const control = report([task("a", false, { listCost: 0, unpriced: true }), task("b", true)]);
    const treatment = report([task("a", true, { listCost: 0, unpriced: true }), task("b", true)]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.win).toBe(false);
    expect(cmp.inconclusive).toBe(true);
    expect(cmp.refusals.join(" ")).toContain("no list price");
  });

  it("refuses a treatment that costs something where the control cost nothing", () => {
    const control = report([task("a", false, { listCost: 0 })]);
    const treatment = report([task("a", true, { listCost: 0.4 })]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.win).toBe(false);
    expect(cmp.refusals.join(" ")).toContain("from $0");
  });
});

// ─── G3: an outage is not a capability miss ───

describe("G3 — infrastructure failures are unscored, like throttling", () => {
  it("classifies a lost provider and a transport error as infrastructure", () => {
    expect(
      classifyInfra({ pass: false, turns: 4, errors: [], outcome: "provider_lost" }),
    ).not.toBeNull();
    expect(
      classifyInfra({ pass: false, turns: 0, errors: ["502 Bad Gateway from upstream"] }),
    ).not.toBeNull();
    expect(
      classifyInfra({ pass: false, turns: 0, errors: ["fetch failed: ECONNRESET"] }),
    ).not.toBeNull();
  });

  it("does not excuse a genuine miss, a cap, or a run that recovered and passed", () => {
    expect(classifyInfra({ pass: false, turns: 6, errors: [], outcome: "finished" })).toBeNull();
    expect(classifyInfra({ pass: false, turns: 30, errors: [], outcome: "max_turns" })).toBeNull();
    // A transient 502 the retry absorbed does not turn a finished run into noise.
    expect(
      classifyInfra({ pass: false, turns: 5, errors: ["502 Bad Gateway"], outcome: "finished" }),
    ).toBeNull();
    expect(classifyInfra({ pass: true, turns: 0, errors: ["ECONNRESET"] })).toBeNull();
  });

  it("excludes an infra-failed task on either arm instead of scoring a fix", () => {
    const control = report([task("a", false, { infra: true }), task("b", true)]);
    const treatment = report([task("a", true), task("b", true)]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.fixes).toEqual([]);
    expect(cmp.excluded.join(" ")).toContain("infrastructure");
    expect(cmp.win).toBe(false);
  });

  it("refuses a win when the exclusions fall on the treatment arm", () => {
    // A treatment that CAUSES outages or throttling (a heavier prompt, more
    // tokens) must not win on the tasks that survived it.
    const control = report([task("a", false), task("b", false), task("c", true), task("d", true)]);
    const treatment = report([
      task("a", true),
      task("b", true),
      task("c", false, { infra: true }),
      task("d", true),
    ]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.fixes).toEqual(["a", "b"]);
    expect(cmp.win).toBe(false);
    expect(cmp.inconclusive).toBe(true);
    expect(cmp.refusals.join(" ")).toContain("one arm");
  });

  it("calls a suite that was mostly unscored inconclusive, not a loss", () => {
    const control = report([
      task("a", false, { infra: true }),
      task("b", false, { throttled: true }),
      task("c", true),
    ]);
    const treatment = report([task("a", true), task("b", true), task("c", true)]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.win).toBe(false);
    expect(cmp.inconclusive).toBe(true);
  });
});

// ─── G4: one predefined comparison, one answer ───

describe("G4 — a conclusive loss closes the question at that configuration", () => {
  it("refuses a win recorded after a loss at the same arm pair, doctrine and yardstick", () => {
    appendLedger(measurement({ win: false, rateDelta: 0, refusals: ["equal is not a win"] }), home);
    appendLedger(measurement({ at: "2026-01-02T00:00:00.000Z" }), home);
    const r = promote("doctrine_full", { home, ...ENV, now: new Date("2026-01-03T00:00:00Z") });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("second look");
  });

  it("refuses a win that a later measurement failed to replicate", () => {
    appendLedger(measurement(), home);
    appendLedger(
      measurement({ at: "2026-01-02T00:00:00.000Z", win: false, refusals: ["regressed"] }),
      home,
    );
    const r = promote("doctrine_full", { home, ...ENV, now: new Date("2026-01-03T00:00:00Z") });
    expect(r.ok).toBe(false);
  });

  it("does not let an inconclusive run close the question", () => {
    appendLedger(measurement({ win: false, inconclusive: true, compared: 1 }), home);
    appendLedger(measurement({ at: "2026-01-02T00:00:00.000Z" }), home);
    const r = promote("doctrine_full", { home, ...ENV, now: new Date("2026-01-03T00:00:00Z") });
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ─── G5: the evidence must be about the prompt and ruler in force now ───

describe("G5 — a measurement under another doctrine or yardstick does not promote", () => {
  it("refuses when the doctrine changed since the measurement", () => {
    appendLedger(measurement({ doctrineHash: "0123456789ab" }), home);
    const r = promote("doctrine_full", { home, ...ENV });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("doctrine");
  });

  it("refuses without a blessing even where the current digest is unknown", () => {
    appendLedger(measurement(), home);
    const r = promote("doctrine_full", {
      home,
      yardstick: null,
      blessedYardstick: null,
      doctrineHash: DOCTRINE,
    });
    expect(r.ok).toBe(false);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toContain("never been blessed");
  });

  it("refuses when the measurement ran against a yardstick other than the blessed one", () => {
    appendLedger(measurement({ yardstick: "bbbb33334444" }), home);
    const r = promote("doctrine_full", { home, ...ENV });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("yardstick");
  });
});

// ─── G6: learning has a price, and the ledger shows it ───

describe("G6 — the cost of learning is recorded", () => {
  it("counts every row's spend in the experiment's cost, excluded rows included", () => {
    const control = report([task("a", false, { throttled: true, listCost: 0.3 }), task("b", true)]);
    const treatment = report([task("a", true, { listCost: 0.2 }), task("b", true)]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.spentListCost).toBeCloseTo(0.3 + 0.2 + 0.01 + 0.01, 9);
  });

  it("sums the learning spend across the ledger's measurements", () => {
    appendLedger(measurement({ learningCostUsd: 0.25 }), home);
    appendLedger(measurement({ learningCostUsd: 0.5, win: false }), home);
    appendLedger({ v: 1, at: "2026-01-03T00:00:00Z", kind: "halt", subject: "loop" }, home);
    expect(learningSpend(readLedger(home))).toBeCloseTo(0.75, 9);
  });
});

// ─── G7: a learned lesson never advises leaving containment ───

describe("G7 — lessons carry no containment escape", () => {
  it("learns nothing from a command that passed only once it left the sandbox", () => {
    const lessons = retroLessons([
      bash("npm test", false, "EPERM: operation not permitted"),
      bash("npm test", true, undefined, { unsandboxed: true }),
    ]);
    expect(lessons.filter((l) => l.kind === "fix")).toEqual([]);
  });

  it("keeps the ordinary argument and drops the escape when both changed", () => {
    const lessons = retroLessons([
      bash("npm install", false, "ETIMEDOUT registry.npmjs.org"),
      bash("npm install", true, undefined, { network: true, timeout_ms: 600000 }),
    ]);
    const fix = lessons.find((l) => l.kind === "fix");
    expect(fix?.body).toContain("timeout_ms");
    for (const key of BASH_CONTAINMENT_ESCAPES) expect(fix?.body ?? "").not.toContain(key);
  });

  it("names every flag the permission layer treats as leaving containment", () => {
    expect([...BASH_CONTAINMENT_ESCAPES].sort()).toEqual([
      "network",
      "run_in_background",
      "unsandboxed",
    ]);
  });
});

// ─── G8: a person's "no" survives re-learning ───

describe("G8 — a lesson a person disabled stays disabled", () => {
  function seed(store: NotebookStore, sessionId: string) {
    return store.upsert({
      kind: "tactic",
      scope: "repo",
      repoKey: "r",
      title: "avoid:npm:abc123",
      body: "`npm test` fails here: missing fixture",
      stage: "candidate",
      sessionId,
    });
  }

  it("does not revive when a later run re-learns it, and is never retrieved", () => {
    const store = new NotebookStore(":memory:");
    const id = seed(store, "s1");
    expect(store.disable(id)).toBe(true);
    seed(store, "s2");
    seed(store, "s3");
    const entry = store.listRepo("r")[0]!;
    expect(entry.blocked).toBe(true);
    expect(entry.stage).toBe("retired");
    expect(store.retrieve({ repoKey: "r", stackKey: "s" })).toEqual([]);
    store.close();
  });

  it("comes back at the bottom rung when a person re-enables it", () => {
    const store = new NotebookStore(":memory:");
    const id = seed(store, "s1");
    store.disable(id);
    expect(store.enable(id)).toBe(true);
    const entry = store.listRepo("r")[0]!;
    expect(entry.blocked).toBe(false);
    expect(entry.stage).toBe("candidate");
    store.close();
  });

  it("cannot be moved up the ladder while disabled", () => {
    const store = new NotebookStore(":memory:");
    const id = seed(store, "s1");
    store.disable(id);
    expect(store.setStage(id, "trial")).toBe(false);
    expect(store.listRepo("r")[0]!.stage).toBe("retired");
    store.close();
  });
});

// ─── G10: a trial measures sessions the lesson did not come from ───

describe("G10 — a session never trials a lesson it taught", () => {
  it("creates no trial row for a session in the lesson's own provenance", () => {
    const store = new NotebookStore(":memory:");
    for (const sessionId of ["teacher-a", "teacher-b"])
      store.upsert({
        kind: "tactic",
        scope: "repo",
        repoKey: "r",
        title: "parser",
        body: "Preserve escaped quotes",
        stage: "trial",
        sessionId,
      });
    const entry = store.listRepo("r")[0]!;
    buildNotebookBlock(store, {
      repoKey: "r",
      stackKey: "s",
      sessionId: "teacher-b",
      cohort: "c",
    });
    // Score it as a win: a teacher's outcome must not reach either arm.
    store.trials.finish("teacher-b", "c", { won: true, cost: 1 });
    const ev = store.trials.evidence(entry, "c");
    expect(ev.treatment.runs + ev.control.runs).toBe(0);
    store.close();
  });
});

// ─── G11: an A/B runs in a home of its own ───

describe("G11 — the A/B runner never touches the invoking profile", () => {
  it("moves the home to the scratch directory and drops the legacy one", () => {
    const env = abChildEnv(
      { PATH: "/usr/bin", RUNE_HOME: "/real/home", GEAR_HOME: "/old/home" },
      "/tmp/scratch",
      "/real/home",
      "mock",
    );
    expect(env.RUNE_HOME).toBe("/tmp/scratch");
    expect(env.GEAR_HOME).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("points the credential store back at the real profile by path only", () => {
    const env = abChildEnv({}, "/tmp/scratch", "/real/home", "real");
    expect(env.RUNE_CREDENTIAL_INDEX_PATH).toBe(join("/real/home", "credentials.index.json"));
    expect(env.RUNE_CREDENTIALS_PATH).toBe(join("/real/home", "credentials.json"));
  });

  it("keeps credential overrides the caller already set", () => {
    const env = abChildEnv(
      { RUNE_CREDENTIAL_INDEX_PATH: "/custom/index.json", RUNE_CREDENTIALS_PATH: "/custom/c.json" },
      "/tmp/scratch",
      "/real/home",
      "real",
    );
    expect(env.RUNE_CREDENTIAL_INDEX_PATH).toBe("/custom/index.json");
    expect(env.RUNE_CREDENTIALS_PATH).toBe("/custom/c.json");
  });

  it("states the mode: a live arm keeps its keys, a mock arm cannot go live by inheritance", () => {
    // tests/scratch-home.ts scrubs provider keys unless RUNE_EVAL_REAL=1.
    expect(abChildEnv({}, "/s", "/r", "real").RUNE_EVAL_REAL).toBe("1");
    expect(abChildEnv({ RUNE_EVAL_REAL: "1" }, "/s", "/r", "mock").RUNE_EVAL_REAL).toBeUndefined();
  });
});
