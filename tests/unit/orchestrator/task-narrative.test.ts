/**
 * The narrative half of the spine (P11.1).
 *
 * The plan ledger made "completed" mean something. It still could not say why
 * one approach was taken and two abandoned — a run that tried three things and
 * reported only the one that worked left no trace of the other two, and the
 * `decisions` field that was supposed to carry that had exactly one writer in
 * the whole repository, a test.
 *
 * What is under test here:
 *  - a hypothesis is raised BEFORE it is tested, and its verdict carries the
 *    reason that settled it;
 *  - a decision is bound to evidence, and reviving `decisions` means the
 *    injected block and the mission file carry it too;
 *  - `progress` is DERIVED from the ledger — a step closed with nothing behind
 *    it does not move it, so a run cannot report progress by claiming it;
 *  - all of it survives a snapshot/restore round trip, ids included, because a
 *    resumed run that starts again at `h1` updates the wrong hypothesis;
 *  - the narrative belongs to the mission: a new goal does not inherit the old
 *    task's dead ends.
 */

import { describe, expect, test } from "bun:test";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  interpretIntent,
  parseTaskKind,
  readIntent,
} from "../../../packages/orchestrator/src/intent";

/** A store with a goal and one open step, ready to carry a narrative. */
function investigating(goal = "why did latency rise after v2.18.5?"): TaskStateStore {
  const s = new TaskStateStore();
  s.beginTurn(goal);
  s.setTodos([{ content: "reproduce the regression", status: "in_progress" }]);
  return s;
}

describe("hypotheses", () => {
  test("a hypothesis is raised as testing, before anything settles it", () => {
    const s = investigating();
    const h = s.noteHypothesis("cache eviction on deploy");
    expect(h.id).toBe("h1");
    expect(h.status).toBe("testing");
    expect(h.evidence).toEqual([]);
    expect(h.reason).toBeUndefined();
  });

  test("a verdict carries the reason that settled it, and the evidence", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction on deploy");
    const updated = s.updateHypothesis("h1", "refuted", {
      reason: "TTL unchanged across the deploy",
      evidence: [{ kind: "check", ref: "bun test cache", detail: "12 pass" }],
    });
    expect(updated?.status).toBe("refuted");
    expect(updated?.reason).toContain("TTL unchanged");
    expect(updated?.evidence).toHaveLength(1);
    expect(updated?.evidence[0].ref).toBe("bun test cache");
  });

  test("an unknown id is reported, never invented", () => {
    const s = investigating();
    expect(s.updateHypothesis("h9", "confirmed")).toBeNull();
    expect(s.hypotheses).toHaveLength(0);
  });

  test("refuted branches are KEPT — that is the whole point", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction");
    s.noteHypothesis("connection pool exhaustion");
    s.noteHypothesis("query regression in orders.ts");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    s.updateHypothesis("h2", "refuted", { reason: "pool at 20%" });
    s.updateHypothesis("h3", "confirmed", { reason: "seq scan on orders" });
    expect(s.hypotheses.map((h) => h.status)).toEqual(["refuted", "refuted", "confirmed"]);
  });

  test("openHypothesis names the one a verdict should land on", () => {
    const s = investigating();
    s.noteHypothesis("first");
    s.noteHypothesis("second");
    expect(s.openHypothesis()?.id).toBe("h2");
    s.updateHypothesis("h2", "refuted", { reason: "no" });
    expect(s.openHypothesis()?.id).toBe("h1");
    s.updateHypothesis("h1", "confirmed");
    expect(s.openHypothesis()).toBeNull();
  });

  test("a settled hypothesis is written into the run's own log", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    const log = (s.snapshot().log ?? []).map((e) => e.text).join("\n");
    expect(log).toContain("h1 refuted");
    expect(log).toContain("TTL unchanged");
  });
});

describe("decisions", () => {
  test("a decision carries the evidence it stood on", () => {
    const s = investigating();
    const d = s.recordDecision("restore the (customer_id, created_at) index", [
      { kind: "check", ref: "explain analyze", detail: "seq scan on orders" },
    ]);
    expect(d.id).toBe("d1");
    expect(d.basedOn).toHaveLength(1);
    expect(s.decisionsRecorded).toHaveLength(1);
  });

  test("recording revives the dead `decisions` field the block already renders", () => {
    // Before P11.1 nothing in production called addDecision, so the injected
    // block's Decisions line was permanently empty and the model forgot every
    // commitment it made the moment the transcript compacted.
    const s = investigating();
    s.recordDecision("standard library only, no external deps");
    expect(s.snapshot().decisions).toContain("standard library only, no external deps");
    const block = s.renderBlock(2_000);
    expect(block).toContain("standard library only");
  });

  test("an unbacked decision is recorded as unbacked, not refused", () => {
    // The harness cannot know whether a commitment needed a citation. It makes
    // the absence visible instead of arguing with the model about it.
    const s = investigating();
    const d = s.recordDecision("keep the existing schema");
    expect(d.basedOn).toEqual([]);
    expect(s.renderMissionFile()).toContain("no evidence cited");
  });
});

describe("artifacts", () => {
  test("a written file is an artifact of the task", () => {
    const s = investigating();
    s.noteFileWritten("migrations/0042_orders_index.sql");
    expect(s.artifacts.map((a) => a.ref)).toEqual(["migrations/0042_orders_index.sql"]);
    expect(s.artifacts[0].kind).toBe("file");
  });

  test("a file edited nine times is one artifact", () => {
    const s = investigating();
    for (let i = 0; i < 9; i++) s.noteFileWritten("src/orders.ts");
    expect(s.artifacts).toHaveLength(1);
  });

  test("reports and previews are recorded beside the files", () => {
    const s = investigating();
    s.recordArtifact("report", ".rune/research/latency.md");
    s.recordArtifact("preview", "http://localhost:7799/dash");
    expect(s.artifacts.map((a) => a.kind).sort()).toEqual(["preview", "report"]);
  });
});

describe("pending decisions — one inbox for four round-trips", () => {
  test("each round-trip lands in the same list", () => {
    const s = investigating();
    s.addPendingDecision({ id: "q1", kind: "question", summary: "JSON or YAML?" });
    s.addPendingDecision({ id: "p1", kind: "approval", summary: "bash: rm -rf build" });
    s.addPendingDecision({ id: "r1", kind: "review", summary: "read-back: you want …" });
    s.addPendingDecision({ id: "h1", kind: "held_step", summary: "deploy: fly deploy" });
    expect(s.pendingDecisions.map((p) => p.kind).sort()).toEqual([
      "approval",
      "held_step",
      "question",
      "review",
    ]);
    expect(s.openDecisions()).toHaveLength(4);
  });

  test("resolving one closes it with its outcome and leaves the record", () => {
    const s = investigating();
    s.addPendingDecision({ id: "q1", kind: "question", summary: "JSON or YAML?" });
    expect(s.resolvePendingDecision("q1", "JSON")).toBe(true);
    expect(s.openDecisions()).toHaveLength(0);
    expect(s.pendingDecisions[0].resolution?.outcome).toBe("JSON");
    // Twice is not a second resolution.
    expect(s.resolvePendingDecision("q1", "YAML")).toBe(false);
    expect(s.pendingDecisions[0].resolution?.outcome).toBe("JSON");
  });

  test("re-recording an id updates rather than duplicating", () => {
    const s = investigating();
    s.addPendingDecision({ id: "p1", kind: "approval", summary: "first" });
    s.addPendingDecision({ id: "p1", kind: "approval", summary: "second" });
    expect(s.pendingDecisions).toHaveLength(1);
    expect(s.pendingDecisions[0].summary).toBe("second");
  });

  test("an unknown id resolves nothing", () => {
    const s = investigating();
    expect(s.resolvePendingDecision("nope", "x")).toBe(false);
  });
});

describe("progress is derived, never asserted", () => {
  test("no plan means no progress — absent, not zero", () => {
    const s = new TaskStateStore();
    s.beginTurn("what does this repo do?");
    expect(s.progress()).toBeUndefined();
    expect(s.snapshot().progress).toBeUndefined();
  });

  test("steps closed on evidence over steps", () => {
    const s = new TaskStateStore();
    s.beginTurn("build the thing");
    s.setTodos([
      { content: "one", status: "in_progress" },
      { content: "two", status: "pending" },
    ]);
    s.noteEffect("write");
    s.setTodos([
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
    ]);
    expect(s.progress()).toBeCloseTo(0.5, 5);
    s.noteEffect("write");
    s.setTodos([
      { content: "one", status: "completed" },
      { content: "two", status: "completed" },
    ]);
    expect(s.progress()).toBe(1);
    expect(s.snapshot().progress).toBe(1);
  });

  test("an UNPROVEN completion does not move it", () => {
    // The claim the ledger already refuses once. Letting it count here would
    // put the same unearned tick back on the number a person reads.
    const s = new TaskStateStore();
    s.beginTurn("build the thing");
    s.setTodos([{ content: "run the tests", status: "in_progress" }]);
    const first = s.setTodos([{ content: "run the tests", status: "completed" }]);
    expect(first.accepted).toBe(false);
    const second = s.setTodos([{ content: "run the tests", status: "completed" }]);
    expect(second.accepted).toBe(true);
    expect(s.snapshot().todos[0].unproven).toBe("no_evidence");
    expect(s.progress()).toBe(0);
  });
});

describe("the task kind", () => {
  test("the harness reads it once; a second harness read is ignored", () => {
    const s = investigating();
    expect(s.setKind("investigate", "harness")).toBe(true);
    expect(s.setKind("build", "harness")).toBe(false);
    expect(s.kind).toBe("investigate");
  });

  test("the model gets exactly one revision", () => {
    const s = investigating();
    s.setKind("build", "harness");
    expect(s.setKind("investigate", "model")).toBe(true);
    expect(s.kind).toBe("investigate");
    expect(s.setKind("research", "model")).toBe(false);
    expect(s.kind).toBe("investigate");
  });

  test("the one revision survives a restore — a resume must not hand out a second", () => {
    const s = investigating();
    s.setKind("build", "harness");
    s.setKind("investigate", "model");
    const restored = TaskStateStore.restore(s.snapshot());
    expect(restored.setKind("write", "model")).toBe(false);
    expect(restored.kind).toBe("investigate");
  });
});

describe("persistence and replay", () => {
  test("the whole narrative survives a snapshot round trip", () => {
    const s = investigating();
    s.setKind("investigate", "harness");
    s.noteHypothesis("cache eviction");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    s.noteHypothesis("query regression");
    s.updateHypothesis("h2", "confirmed", {
      reason: "seq scan",
      evidence: [{ kind: "check", ref: "explain analyze" }],
    });
    s.recordDecision("restore the index", [{ kind: "check", ref: "explain analyze" }]);
    s.noteFileWritten("migrations/0042.sql");
    s.addPendingDecision({ id: "h9", kind: "held_step", summary: "backfill on the replica" });

    const restored = TaskStateStore.restore(s.snapshot());
    expect(restored.kind).toBe("investigate");
    expect(restored.hypotheses.map((h) => [h.id, h.status])).toEqual([
      ["h1", "refuted"],
      ["h2", "confirmed"],
    ]);
    expect(restored.decisionsRecorded[0].text).toBe("restore the index");
    expect(restored.artifacts[0].ref).toBe("migrations/0042.sql");
    expect(restored.openDecisions()[0].summary).toContain("backfill");
  });

  test("ids continue past the snapshot instead of colliding with it", () => {
    const s = investigating();
    s.noteHypothesis("first");
    s.noteHypothesis("second");
    s.recordDecision("one");
    const restored = TaskStateStore.restore(s.snapshot());
    expect(restored.noteHypothesis("third").id).toBe("h3");
    expect(restored.recordDecision("two").id).toBe("d2");
  });

  test("it reconstructs from the session log, latest snapshot wins", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction");
    const early = { seq: 1, event: { type: "task_state", payload: { state: s.snapshot() } } };
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    const late = { seq: 2, event: { type: "task_state", payload: { state: s.snapshot() } } };
    const store = TaskStateStore.fromEvents([early, late] as never);
    expect(store?.hypotheses[0].status).toBe("refuted");
    expect(store?.hypotheses[0].reason).toContain("TTL unchanged");
  });

  test("a pre-P11.1 snapshot restores with no narrative and no crash", () => {
    const old = {
      version: 1 as const,
      goal: "build it",
      clarifications: [],
      todos: [],
      filesWritten: [],
      filesRead: [],
      decisions: [],
      verification: { status: "none" as const, attempts: 0 },
      updatedAt: new Date().toISOString(),
    };
    const restored = TaskStateStore.restore(old);
    expect(restored.hypotheses).toEqual([]);
    expect(restored.artifacts).toEqual([]);
    expect(restored.openDecisions()).toEqual([]);
    expect(restored.kind).toBeUndefined();
    expect(restored.noteHypothesis("first").id).toBe("h1");
  });
});

describe("the narrative belongs to the mission", () => {
  test("a new goal does not inherit the old task's dead ends", () => {
    const s = investigating();
    s.setKind("investigate", "harness");
    s.noteHypothesis("cache eviction");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    s.noteFileWritten("src/orders.ts");
    // Close the plan, then start a genuinely new mission.
    s.noteEffect("write");
    s.setTodos([{ content: "reproduce the regression", status: "completed" }]);
    s.beginTurn("now write the release notes for 2.19");
    s.noteEffect("write");
    s.setTodos([{ content: "draft the notes", status: "in_progress" }]);

    expect(s.snapshot().goal).toContain("release notes");
    expect(s.hypotheses).toEqual([]);
    expect(s.kind).toBeUndefined();
    // The FILE ledger is true of the workspace and survives, per the boundary
    // doctrine: a new goal does not un-write a file.
    expect(s.snapshot().filesWritten).toContain("src/orders.ts");
    expect(s.artifacts.map((a) => a.ref)).toContain("src/orders.ts");
  });
});

describe("rendering", () => {
  test("the injected block carries the hypotheses the model must not re-test", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction on deploy");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    s.noteHypothesis("query regression in orders.ts");
    const block = s.renderBlock(2_000)!;
    expect(block).toContain("Hypotheses:");
    expect(block).toContain("h1 [refuted]");
    expect(block).toContain("TTL unchanged");
    expect(block).toContain("h2 [testing]");
  });

  test("a hypothesis alone is enough substance to inject a block", () => {
    const s = new TaskStateStore();
    s.beginTurn("why is it slow?");
    expect(s.renderBlock(2_000)).toBeNull();
    s.noteHypothesis("the index is missing");
    expect(s.renderBlock(2_000)).toContain("the index is missing");
  });

  test("the mission file keeps the branches in order, refuted ones included", () => {
    const s = investigating();
    s.noteHypothesis("cache eviction");
    s.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });
    s.noteHypothesis("query regression");
    s.updateHypothesis("h2", "confirmed", { reason: "seq scan on orders" });
    s.recordDecision("restore the index", [{ kind: "check", ref: "explain analyze" }]);
    const file = s.renderMissionFile();
    expect(file).toContain("## How we got here");
    expect(file.indexOf("cache eviction")).toBeLessThan(file.indexOf("query regression"));
    expect(file).toContain("refuted: TTL unchanged");
    expect(file).toContain("## Decisions (with evidence)");
    expect(file).toContain("based on check: explain analyze");
  });

  test("the block stays inside its budget with a full narrative", () => {
    const s = investigating();
    for (let i = 0; i < 12; i++) {
      s.noteHypothesis(`hypothesis number ${i} with a reasonably long sentence attached to it`);
      s.updateHypothesis(`h${i + 1}`, "refuted", { reason: "a reason of moderate length" });
    }
    const block = s.renderBlock(600);
    expect(block).not.toBeNull();
    // The budget is enforced by shedding detail levels; the goal and the plan
    // are never dropped, and the narrative is.
    expect(block).toContain("Goal:");
  });
});

describe("the Intent Interpreter", () => {
  test("the verb of the ask decides, with no model call", () => {
    const cases: Array<[string, string]> = [
      ["why did latency rise after v2.18.5?", "investigate"],
      ["the build is failing on CI", "investigate"],
      ["build me a small calculator", "build"],
      ["add a --json flag to the CLI", "build"],
      ["research the state of the art in vector databases", "research"],
      ["analyze last quarter's signup numbers", "analyze"],
      ["deploy the api to production", "operate"],
      ["write a readme for this package", "write"],
    ];
    for (const [message, kind] of cases) {
      const reading = readIntent(message);
      expect(reading.kind, message).toBe(kind as never);
      expect(reading.confident, message).toBe(true);
    }
  });

  test("nothing to go on is not confidence", () => {
    const reading = readIntent("the thing from yesterday");
    expect(reading.confident).toBe(false);
    expect(reading.source).toBe("default");
  });

  test("a confident reading never spends a model call", async () => {
    let calls = 0;
    const reading = await interpretIntent({
      message: "why is the API slow?",
      ask: async () => {
        calls++;
        return "build";
      },
    });
    expect(calls).toBe(0);
    expect(reading.kind).toBe("investigate");
  });

  test("an ambiguous ask spends exactly one, and takes its answer", async () => {
    let calls = 0;
    const reading = await interpretIntent({
      message: "the thing from yesterday",
      ask: async () => {
        calls++;
        return "  Analyze.\n";
      },
    });
    expect(calls).toBe(1);
    expect(reading.kind).toBe("analyze");
    expect(reading.source).toBe("model");
  });

  test("a junk answer, a throw, or no gateway all leave the deterministic reading", async () => {
    const junk = await interpretIntent({
      message: "the thing from yesterday",
      ask: async () => "## Goals & requirements\n(mock summary)",
    });
    expect(junk.source).toBe("default");
    const thrown = await interpretIntent({
      message: "the thing from yesterday",
      ask: async () => {
        throw new Error("no provider");
      },
    });
    expect(thrown.source).toBe("default");
    const none = await interpretIntent({ message: "the thing from yesterday" });
    expect(none.source).toBe("default");
  });

  test("only the six words are an answer", () => {
    expect(parseTaskKind("investigate")).toBe("investigate");
    expect(parseTaskKind(" Build \n")).toBe("build");
    expect(parseTaskKind("investigation")).toBeNull();
    expect(parseTaskKind("")).toBeNull();
    expect(parseTaskKind("the task is a build")).toBeNull();
  });
});
