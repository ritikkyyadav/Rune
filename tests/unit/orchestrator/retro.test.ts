import { describe, expect, test } from "bun:test";
import {
  deriveRunRetro,
  foldTurnRetros,
  gardenerBrief,
  gardenerCandidates,
  observationsFromRows,
  recordLessons,
  retroLessons,
  scorecard,
  scoreRates,
  tuneProposals,
  GARDENER_OFF_LIMITS,
} from "../../../packages/orchestrator/src/retro";
import type { EventRow, RetroSample, RunRetro } from "../../../packages/orchestrator/src/retro";
import { NotebookStore } from "../../../packages/orchestrator/src/notebook/store";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { ToolObservation } from "../../../packages/orchestrator/src/notebook/capture";

// ─── Row builders: the exact shapes the engine persists ───

let seq = 0;
const row = (type: string, payload: Record<string, unknown>): EventRow => ({
  seq: ++seq,
  event: { type, payload },
});

type Call = { name: string; args: Record<string, unknown>; ok: boolean; out?: string };

/** One completion: an assistant message with tool uses, then their results. */
function turn(calls: Call[], text = ""): EventRow[] {
  const ids = calls.map((_, i) => `call_${seq}_${i}`);
  const rows: EventRow[] = [
    row("assistant_msg", {
      content: text,
      toolUses: calls.map((c, i) => ({ callId: ids[i], toolName: c.name, toolInput: c.args })),
      contentBlocks: [],
    }),
  ];
  calls.forEach((c, i) => {
    rows.push(
      row("tool_result", {
        callId: ids[i],
        content: c.out ?? (c.ok ? "ok" : "failed"),
        isError: !c.ok,
      }),
    );
  });
  return rows;
}

const bash = (
  command: string,
  ok: boolean,
  out?: string,
  extra: Record<string, unknown> = {},
): Call => ({
  name: "bash",
  args: { command, ...extra },
  ok,
  out,
});

const obs = (
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

function stateRow(mutate: (s: TaskStateStore) => void): EventRow {
  const store = new TaskStateStore();
  mutate(store);
  return row("task_state", { state: store.snapshot() });
}

describe("observationsFromRows", () => {
  test("joins tool uses to their results and keeps the error text", () => {
    seq = 0;
    const rows = [
      ...turn([
        bash("bun test", true, "12 pass"),
        bash("npm install", false, "ENOTFOUND registry"),
      ]),
      row("tool_result", { callId: "orphan", content: "x", isError: true }),
    ];
    const out = observationsFromRows(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      toolName: "bash",
      success: true,
      args: { command: "bun test" },
    });
    expect(out[1]).toMatchObject({ success: false, error: "ENOTFOUND registry" });
  });
});

describe("deriveRunRetro", () => {
  test("states the run in numbers: steps by evidence, checks, tools, gates, cost", () => {
    seq = 0;
    const rows: EventRow[] = [
      row("user_msg", { content: "add a parser" }),
      ...turn([{ name: "read_file", args: { path: "a.ts" }, ok: true }]),
      ...turn([{ name: "write_file", args: { path: "a.ts", content: "x" }, ok: true }]),
      ...turn([bash("bun test", true, "3 pass"), bash("bun run typecheck", false, "error TS2304")]),
      row("cost", { costUsd: 0.01, listCostUsd: 0.05, inputTokens: 1000, outputTokens: 200 }),
      row("cost", { costUsd: 0.02, listCostUsd: 0.07, inputTokens: 500, outputTokens: 100 }),
      stateRow((s) => {
        s.beginTurn("add a parser");
        s.setTodos(
          [
            { content: "read", status: "completed" },
            { content: "write", status: "completed" },
            { content: "verify", status: "in_progress" },
          ],
          { enforce: false },
        );
        s.logEvent("gate", "finish refused: 1 step open");
        s.logEvent("unproven", "write closed without evidence");
      }),
    ];
    const r = deriveRunRetro(rows, { durationMs: 1234.6, now: "2026-09-02T00:00:00.000Z" })!;
    expect(r.v).toBe(1);
    expect(r.outcome).toBe("finished");
    expect(r.goal).toBe("add a parser");
    expect(r.steps).toEqual({ total: 3, done: 2, unproven: 0, open: 1 });
    expect(r.checks).toEqual({ passed: 1, failed: 1, lastPassed: "bun test" });
    expect(r.tools.calls).toBe(4);
    expect(r.tools.failed).toBe(1);
    expect(r.tools.byName).toEqual({ read_file: 1, write_file: 1, bash: 2 });
    expect(r.gates.gate).toBe(1);
    expect(r.gates.unproven).toBe(1);
    expect(r.completions).toBe(3);
    expect(r.filesWritten).toBe(1);
    expect(r.cost).toEqual({ usd: 0.03, listUsd: 0.12, inputTokens: 1500, outputTokens: 300 });
    expect(r.durationMs).toBe(1235);
    expect(r.at).toBe("2026-09-02T00:00:00.000Z");
    expect(r.backfilled).toBeUndefined();
  });

  test("outcome follows the handoff, the abort, the error — in that precedence order", () => {
    seq = 0;
    const open = stateRow((s) => {
      s.beginTurn("x");
      s.setTodos([{ content: "a", status: "in_progress" }], { enforce: false });
      s.setHandoff("open_steps");
    });
    const base = [row("user_msg", { content: "x" }), ...turn([], "done")];
    expect(deriveRunRetro([...base, open])!.outcome).toBe("open_steps");
    expect(deriveRunRetro([...base, open], { runError: "boom" })!.outcome).toBe("error");
    expect(deriveRunRetro([...base, open], { runError: "boom", aborted: true })!.outcome).toBe(
      "aborted",
    );
    expect(deriveRunRetro(base)!.outcome).toBe("finished");
  });

  test("a backfilled session that died between boundaries reads as an error", () => {
    seq = 0;
    const rows = [
      row("user_msg", { content: "x" }),
      ...turn([], "working"),
      row("system_note", { content: "agent loop terminated: provider stream error" }),
    ];
    const r = deriveRunRetro(rows, { backfilled: true })!;
    expect(r.outcome).toBe("error");
    expect(r.backfilled).toBe(true);
  });

  test("only spine log lines from this run count when sinceAt is given", () => {
    seq = 0;
    const store = new TaskStateStore();
    store.beginTurn("x");
    store.logEvent("gate", "old");
    const snapshot = store.snapshot();
    snapshot.log![0].at = "2026-01-01T00:00:00.000Z";
    const rows = [
      row("user_msg", { content: "x" }),
      ...turn([], "hi"),
      row("task_state", { state: snapshot }),
    ];
    expect(
      deriveRunRetro(rows, { sinceAt: "2026-06-01T00:00:00.000Z" })!.gates.gate,
    ).toBeUndefined();
    expect(deriveRunRetro(rows)!.gates.gate).toBe(1);
  });

  test("returns null when the rows hold nothing a run leaves behind", () => {
    seq = 0;
    expect(deriveRunRetro([])).toBeNull();
    expect(
      deriveRunRetro([row("user_msg", { content: "hi" }), row("checkpoint", { summary: "x" })]),
    ).toBeNull();
  });
});

describe("retroLessons — precision over recall", () => {
  test("a command that fails twice with one error and never passes is a pitfall", () => {
    const lessons = retroLessons([
      obs(
        "bun test tests/unit/",
        false,
        "error: EADDRINUSE: address already in use 127.0.0.1:4310",
      ),
      obs(
        "bun test tests/unit/",
        false,
        "error: EADDRINUSE: address already in use 127.0.0.1:4312",
      ),
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].kind).toBe("pitfall");
    expect(lessons[0].title).toMatch(/^avoid:bun:[0-9a-f]{6}$/);
    expect(lessons[0].body).toContain("`bun test tests/unit/` fails here: error: EADDRINUSE");
    expect(lessons[0].command).toBe("bun test tests/unit/");
  });

  test("one failure is not a lesson; neither is a failure the same command later beats", () => {
    expect(retroLessons([obs("cargo build", false, "error[E0433]")])).toHaveLength(0);
    expect(
      retroLessons([
        obs("cargo build", false, "error[E0433]"),
        obs("cargo build", false, "error[E0433]"),
        obs("cargo build", true),
      ]),
    ).toHaveLength(0);
  });

  test("transient errors and the user saying no never become pitfalls", () => {
    expect(
      retroLessons([
        obs("bun test", false, "command timed out after 120s"),
        obs("bun test", false, "command timed out after 120s"),
      ]),
    ).toHaveLength(0);
    expect(
      retroLessons([
        obs("git push", false, "denied by the user"),
        obs("git push", false, "denied by the user"),
      ]),
    ).toHaveLength(0);
    expect(
      retroLessons([
        obs("curl https://x", false, "rate limit exceeded (429)"),
        obs("curl https://x", false, "rate limit exceeded (429)"),
      ]),
    ).toHaveLength(0);
  });

  test("the same command failing then passing with different arguments is a fix", () => {
    const lessons = retroLessons([
      obs("npm install", false, "getaddrinfo ENOTFOUND registry.npmjs.org"),
      obs("npm install", true, undefined, { network: true }),
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ kind: "fix", command: "npm install" });
    expect(lessons[0].body).toBe("`npm install` needs network: true here — it failed without.");
  });

  test("a command that simply passes on retry with the same arguments teaches nothing", () => {
    expect(retroLessons([obs("bun test", false, "1 fail"), obs("bun test", true)])).toHaveLength(0);
  });

  test("a secondary runner's passing check is recorded; runner facts and greps are not", () => {
    const secondary = retroLessons([obs("./scripts/check.sh test", true)]);
    expect(secondary).toHaveLength(1);
    expect(secondary[0]).toMatchObject({ kind: "check", title: "verified-check" });
    expect(secondary[0].body).toContain("`./scripts/check.sh test`");
    // `bun test` is already a notebook command fact; `grep` is not a check.
    expect(retroLessons([obs("bun test", true)])).toHaveLength(0);
    expect(retroLessons([obs("grep -rn test src/", true)])).toHaveLength(0);
  });

  test("multi-line scripts and non-bash tools are never named in a lesson", () => {
    expect(
      retroLessons([
        obs("for f in *; do\n echo $f; done", false, "syntax error"),
        obs("for f in *; do\n echo $f; done", false, "syntax error"),
        { toolName: "edit_file", args: { path: "a" }, success: false, error: "old_text not found" },
        { toolName: "edit_file", args: { path: "a" }, success: false, error: "old_text not found" },
      ]),
    ).toHaveLength(0);
  });
});

describe("recordLessons → notebook", () => {
  test("writes lessons as repo-scoped entries with the command in provenance", () => {
    const store = new NotebookStore(":memory:");
    const lessons = retroLessons([
      obs("bun test tests/unit/", false, "EADDRINUSE"),
      obs("bun test tests/unit/", false, "EADDRINUSE"),
      obs("npm install", false, "ENOTFOUND"),
      obs("npm install", true, undefined, { network: true }),
    ]);
    const r = recordLessons(store, { repoKey: "r1", sessionId: "s1" }, lessons);
    expect(r.written).toHaveLength(2);
    const entries = store.listRepo("r1");
    const pitfall = entries.find((e) => e.title.startsWith("avoid:"))!;
    expect(pitfall.kind).toBe("tactic");
    expect(pitfall.provenance.note).toBe("bun test tests/unit/");
    expect(pitfall.provenance.sessions).toEqual(["s1"]);
    store.close();
  });

  test("a pitfall the next run contradicts is retired, and revives if re-learned", () => {
    const store = new NotebookStore(":memory:");
    const pitfall = retroLessons([
      obs("bun test tests/unit/", false, "EADDRINUSE"),
      obs("bun test tests/unit/", false, "EADDRINUSE"),
    ]);
    recordLessons(store, { repoKey: "r1", sessionId: "s1" }, pitfall);
    // Next run: the very command passes as-is.
    const r = recordLessons(
      store,
      { repoKey: "r1", sessionId: "s2" },
      [],
      [obs("bun test tests/unit/", true)],
    );
    expect(r.retired).toHaveLength(1);
    expect(store.listRepo("r1")[0].retired).toBe(true);
    expect(store.retrieve({ repoKey: "r1", stackKey: "x" })).toHaveLength(0);
    // Learned again later: back, with both sessions on record.
    recordLessons(store, { repoKey: "r1", sessionId: "s3" }, pitfall);
    const revived = store.listRepo("r1")[0];
    expect(revived.retired).toBe(false);
    expect(revived.provenance.sessions).toEqual(["s1", "s3"]);
    store.close();
  });
});

// ─── Scorecard, proposals, gardener ───

function retroOf(partial: Partial<RunRetro>): RunRetro {
  return {
    v: 1,
    at: "2026-09-02T00:00:00.000Z",
    outcome: "finished",
    goal: "",
    steps: { total: 4, done: 4, unproven: 0, open: 0 },
    checks: { passed: 2, failed: 0 },
    tools: { calls: 10, failed: 1, byName: {} },
    gates: {},
    completions: 8,
    filesWritten: 2,
    cost: { usd: 0, listUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    durationMs: 1000,
    lessons: [],
    ...partial,
  };
}

const sample = (model: string, partial: Partial<RunRetro>, ws = "/w"): RetroSample => ({
  retro: retroOf(partial),
  model,
  workspaceRoot: ws,
  sessionId: "s",
});

describe("scorecard", () => {
  test("aggregates outcomes and evidence per model, and per workspace", () => {
    const samples = [
      sample("a", {}),
      sample("a", { outcome: "open_steps", steps: { total: 5, done: 2, unproven: 1, open: 3 } }),
      sample("a", { outcome: "stalled", gates: { gate: 2, unproven: 1 } }),
      sample("b", { outcome: "error" }, "/other"),
    ];
    const rows = scorecard(samples, "model");
    expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
    const a = rows[0];
    expect(a).toMatchObject({
      runs: 3,
      finished: 1,
      openSteps: 1,
      stalled: 1,
      stepsDone: 10,
      stepsUnproven: 1,
      gates: 3,
    });
    const rates = scoreRates(a);
    expect(rates.finishedRate).toBeCloseTo(1 / 3);
    expect(rates.unprovenRate).toBeCloseTo(0.1);
    expect(rates.checkPassRate).toBe(1);
    expect(rates.usdPerRun).toBeCloseTo(0.5);
    expect(scorecard(samples, "workspace").map((r) => r.key)).toEqual(["/w", "/other"]);
  });

  test("proposals need enough runs and name a knob that exists", () => {
    const few = scorecard(
      [sample("a", { steps: { total: 3, done: 3, unproven: 3, open: 0 } })],
      "model",
    );
    expect(tuneProposals(few)).toHaveLength(0);
    const many = scorecard(
      Array.from({ length: 6 }, () =>
        sample("a", { steps: { total: 3, done: 3, unproven: 2, open: 0 } }),
      ),
      "model",
    );
    const props = tuneProposals(many);
    expect(props).toHaveLength(1);
    expect(props[0].signal).toContain("12 of 18 completed steps");
    expect(props[0].config).toContain("[verify] perStep = true");
    expect(props[0].confidence).toBe("medium");
  });

  test("a model that mostly finishes gets no proposal", () => {
    const rows = scorecard(
      Array.from({ length: 8 }, () => sample("a", {})),
      "model",
    );
    expect(tuneProposals(rows)).toHaveLength(0);
  });
});

describe("gardener", () => {
  const fp = (cls: string, count: number, extra: Partial<{ lastSeen: string }> = {}) => ({
    fingerprint: `fp-${cls}-${count}`,
    class: cls,
    component: "engine",
    messageSample: `sample ${cls}`,
    count,
    firstSeen: "2026-08-01T00:00:00.000Z",
    lastSeen: extra.lastSeen ?? "2026-09-01T00:00:00.000Z",
    versions: ["0.3.0"],
  });

  test("candidates are crash-class fingerprints above the floor, most frequent first", () => {
    const rows = [
      fp("tool.sandbox_denial", 40),
      fp("crash.unhandled_rejection", 3),
      fp("crash.uncaught_exception", 9),
      fp("crash.dirty_exit", 2),
      fp("provider.rate_limit", 100),
    ];
    expect(gardenerCandidates(rows).map((r) => r.class)).toEqual([
      "crash.uncaught_exception",
      "crash.unhandled_rejection",
    ]);
    expect(gardenerCandidates(rows, { min: 5 })).toHaveLength(1);
  });

  test("the brief carries the evidence and every rule a person would insist on", () => {
    const brief = gardenerBrief(fp("crash.uncaught_exception", 9), [
      {
        ts: "2026-09-01T10:00:00.000Z",
        message: "TypeError: x is undefined",
        stack: "at a.ts:1\nat b.ts:2",
        context: { turn: 3 },
      },
    ]);
    expect(brief).toContain("fp-crash.uncaught_exception-9");
    expect(brief).toContain("Seen 9×");
    expect(brief).toContain("at a.ts:1");
    expect(brief).toContain("failing unit test");
    expect(brief).toContain("bun run typecheck");
    expect(brief).toContain("Do not push, merge, or open a pull request");
    for (const p of GARDENER_OFF_LIMITS) expect(brief).toContain(p);
    expect(brief).toContain(".gear/gardener-report.md");
  });
});

describe("deriveRunRetro — outcome across runs", () => {
  const handoffState = (at: string, reason: string = "max_turns") => {
    const store = new TaskStateStore();
    store.beginTurn("x");
    const snapshot = store.snapshot();
    (snapshot as { handoff?: unknown }).handoff = { reason, state: "open", at };
    return snapshot;
  };
  const HANDOFF_AT = "2026-09-01T20:26:53.115Z";

  test("a termination after an earlier run's handoff reads as an error", () => {
    seq = 0;
    const rows = [
      row("user_msg", { content: "build" }),
      ...turn([], "working"),
      row("task_state", { state: handoffState(HANDOFF_AT) }),
      row("user_msg", { content: "show me the preview" }),
      ...turn([], "resumed"),
      row("task_state", { state: handoffState(HANDOFF_AT) }),
      row("system_note", { content: "agent loop terminated: Too many consecutive errors (3)" }),
    ];
    expect(deriveRunRetro(rows, { backfilled: true })!.outcome).toBe("error");
    expect(deriveRunRetro(rows)!.outcome).toBe("error");
  });

  test("a handoff recorded after a termination still wins", () => {
    seq = 0;
    const rows = [
      row("user_msg", { content: "build" }),
      ...turn([], "working"),
      row("system_note", { content: "agent loop terminated: provider stream error" }),
      row("user_msg", { content: "continue" }),
      ...turn([], "resumed"),
      row("task_state", { state: handoffState("2026-09-01T21:00:00.000Z") }),
    ];
    expect(deriveRunRetro(rows, { backfilled: true })!.outcome).toBe("max_turns");
  });

  test("a handoff the dying run itself recorded keeps its reason", () => {
    seq = 0;
    const rows = [
      row("user_msg", { content: "build" }),
      ...turn([], "working"),
      row("task_state", { state: handoffState("2026-09-01T22:08:29.000Z", "provider_lost") }),
      row("system_note", { content: "agent loop terminated: Too many consecutive errors (3)" }),
    ];
    expect(deriveRunRetro(rows, { backfilled: true })!.outcome).toBe("provider_lost");
    expect(deriveRunRetro(rows, { runError: "Too many consecutive errors (3)" })!.outcome).toBe(
      "provider_lost",
    );
  });

  test("a handoff older than this run's start belongs to an earlier run", () => {
    seq = 0;
    const rows = [
      row("user_msg", { content: "show me the preview" }),
      ...turn([], "resumed"),
      row("task_state", { state: handoffState(HANDOFF_AT) }),
    ];
    expect(deriveRunRetro(rows)!.outcome).toBe("max_turns");
    expect(deriveRunRetro(rows, { sinceAt: "2026-09-01T20:27:28.626Z" })!.outcome).toBe("finished");
  });
});

// ─── The scope defect ───
// The engine writes a retro per RUN, and a run is one turn. Before the fix,
// every turn retro carried the SESSION's cumulative step counts and the
// SESSION's goal, so `gear audit` showed a two-word greeting as the whole
// mission and `gear evolve scorecard` counted each turn as a run. The contract
// now: work counters are a delta over the window, the plan's shape is absolute,
// the goal belongs to the session, and N turn retros fold into one sample.

/** A spine with `done` of `total` steps completed, `unproven` of them unproven. */
function spine(total: number, done: number, unproven = 0, goal = "ship the thing") {
  const store = new TaskStateStore();
  store.beginTurn(goal);
  store.setTodos(
    Array.from({ length: total }, (_, i) => ({
      content: `step ${i + 1}`,
      status: i < done ? ("completed" as const) : ("pending" as const),
    })),
    { enforce: false },
  );
  const state = store.snapshot();
  // `unproven` is the harness's verdict, never the model's input: `setTodos`
  // drops it and the step gate stamps it. Stamp the persisted shape directly.
  for (let i = 0; i < unproven; i++) state.todos[i]!.unproven = true;
  return state;
}

describe("retro scope", () => {
  test("a turn retro reports the steps THAT TURN closed, not the session's", () => {
    seq = 0;
    // The session had 8 steps with 5 already done when this turn opened; the
    // turn closed one more. Before the fix this reported done: 6.
    const rows: EventRow[] = [
      ...turn([{ name: "write_file", args: { path: "a.ts", content: "x" }, ok: true }]),
      row("task_state", { state: spine(8, 6) }),
    ];
    const retro = deriveRunRetro(rows, { scope: "turn", priorState: spine(8, 5) })!;
    expect(retro.scope).toBe("turn");
    expect(retro.steps.done).toBe(1);
    // The plan's shape is absolute: 8 steps, 2 still open at the turn's end.
    expect(retro.steps.total).toBe(8);
    expect(retro.steps.open).toBe(2);
  });

  test("a turn that touched no step still reports the plan, not zeros", () => {
    seq = 0;
    // No `task_state` row in the window at all — the turn read and answered.
    // This is the shape that reported "0 steps" for real work.
    const rows = turn([{ name: "read_file", args: { path: "a.ts" }, ok: true }]);
    const retro = deriveRunRetro(rows, { scope: "turn", priorState: spine(8, 5) })!;
    expect(retro.steps).toEqual({ total: 8, done: 0, unproven: 0, open: 3 });
  });

  test("unproven closes are a delta too, and a shrinking plan never goes negative", () => {
    seq = 0;
    const rows: EventRow[] = [
      ...turn([{ name: "write_file", args: { path: "a.ts", content: "x" }, ok: true }]),
      row("task_state", { state: spine(8, 6, 2) }),
    ];
    expect(
      deriveRunRetro(rows, { scope: "turn", priorState: spine(8, 5, 1) })!.steps.unproven,
    ).toBe(1);
    // The model rewrote the plan smaller mid-turn: clamp, never report -3.
    seq = 0;
    const shrunk: EventRow[] = [
      ...turn([{ name: "write_file", args: { path: "a.ts", content: "x" }, ok: true }]),
      row("task_state", { state: spine(2, 2) }),
    ];
    const r = deriveRunRetro(shrunk, { scope: "turn", priorState: spine(8, 5) })!;
    expect(r.steps.done).toBe(0);
    expect(r.steps.total).toBe(2);
  });

  test("the goal belongs to the session: turn scope omits it, session scope keeps it", () => {
    seq = 0;
    const rows: EventRow[] = [
      ...turn([{ name: "read_file", args: { path: "a.ts" }, ok: true }]),
      row("task_state", { state: spine(3, 1, 0, "build me a config parser") }),
    ];
    expect(deriveRunRetro(rows, { scope: "turn" })!.goal).toBeUndefined();
    expect(deriveRunRetro(rows, { scope: "session" })!.goal).toBe("build me a config parser");
    // Unspecified scope stays what every derived (backfilled) retro was.
    expect(deriveRunRetro(rows)!.scope).toBe("session");
  });

  test("an empty window is still nothing, prior spine or not", () => {
    seq = 0;
    expect(deriveRunRetro([], { priorState: spine(8, 5) })).toBeNull();
    expect(deriveRunRetro([row("user_msg", { content: "hi" })], { priorState: spine(8, 5) })).toBe(
      null,
    );
  });
});

describe("foldTurnRetros", () => {
  const turnRetro = (over: Partial<RunRetro> = {}): RunRetro => ({
    v: 1,
    at: "2026-09-02T10:00:00.000Z",
    outcome: "finished",
    scope: "turn",
    steps: { total: 4, done: 0, unproven: 0, open: 4 },
    checks: { passed: 0, failed: 0 },
    tools: { calls: 0, failed: 0, byName: {} },
    gates: {},
    completions: 1,
    filesWritten: 0,
    cost: { usd: 0, listUsd: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 1000,
    lessons: [],
    ...over,
  });

  test("N turn retros become one session: work sums, the plan's shape is the last", () => {
    const folded = foldTurnRetros([
      turnRetro({
        steps: { total: 4, done: 1, unproven: 0, open: 3 },
        checks: { passed: 1, failed: 0, lastPassed: "bun test" },
        tools: { calls: 3, failed: 1, byName: { bash: 2, read_file: 1 } },
        gates: { gate: 1 },
        cost: { usd: 0.01, listUsd: 0.05, inputTokens: 100, outputTokens: 10 },
      }),
      turnRetro({
        at: "2026-09-02T11:00:00.000Z",
        outcome: "open_steps",
        steps: { total: 5, done: 2, unproven: 1, open: 2 },
        checks: { passed: 2, failed: 1 },
        tools: { calls: 4, failed: 0, byName: { bash: 4 } },
        gates: { gate: 2, unproven: 1 },
        completions: 3,
        filesWritten: 2,
        cost: { usd: 0.02, listUsd: 0.07, inputTokens: 200, outputTokens: 20 },
        durationMs: 5000,
      }),
    ])!;
    expect(folded.scope).toBe("session");
    // Deltas sum back to the session's real totals.
    expect(folded.steps).toEqual({ total: 5, done: 3, unproven: 1, open: 2 });
    // How the session ended is how its last turn ended.
    expect(folded.outcome).toBe("open_steps");
    expect(folded.at).toBe("2026-09-02T11:00:00.000Z");
    expect(folded.checks).toEqual({ passed: 3, failed: 1, lastPassed: "bun test" });
    expect(folded.tools).toEqual({ calls: 7, failed: 1, byName: { bash: 6, read_file: 1 } });
    expect(folded.gates).toEqual({ gate: 3, unproven: 1 });
    expect(folded.completions).toBe(4);
    expect(folded.cost).toEqual({ usd: 0.03, listUsd: 0.12, inputTokens: 300, outputTokens: 30 });
    expect(folded.durationMs).toBe(6000);
  });

  test("the fold takes the goal it is given, and dedupes lessons by title", () => {
    const lesson = { kind: "check" as const, title: "bun test", body: "b", evidence: "e" };
    const folded = foldTurnRetros(
      [turnRetro({ lessons: [lesson] }), turnRetro({ lessons: [lesson] })],
      "  build   me a parser ",
    )!;
    expect(folded.goal).toBe("build me a parser");
    expect(folded.lessons).toHaveLength(1);
  });

  test("nothing folds to nothing", () => {
    expect(foldTurnRetros([])).toBeNull();
  });

  test("one session of many turns scores as one run, not many", () => {
    const session = foldTurnRetros([
      turnRetro({ steps: { total: 2, done: 1, unproven: 0, open: 1 } }),
      turnRetro({ steps: { total: 2, done: 1, unproven: 0, open: 0 } }),
      turnRetro({ steps: { total: 2, done: 0, unproven: 0, open: 0 } }),
    ])!;
    const sample: RetroSample = {
      retro: session,
      model: "m",
      workspaceRoot: "/w",
      sessionId: "s1",
    };
    const scored = scorecard([sample], "model");
    expect(scored[0].runs).toBe(1);
    expect(scored[0].stepsDone).toBe(2);
  });
});
