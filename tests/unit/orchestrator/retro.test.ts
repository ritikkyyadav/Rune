import { describe, expect, test } from "bun:test";
import {
  deriveRunRetro,
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
