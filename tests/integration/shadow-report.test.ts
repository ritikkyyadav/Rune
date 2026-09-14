/**
 * S4, S7 and S10 — the corpus, the disagreements it names, and what it cost.
 *
 * Twelve deterministic scenarios, each one a shape `lifecycle-durability`'s
 * process-level suite also produces (a gate refusing a finish, a supervisor
 * halt, a provider that stopped answering, a budget refusal before the
 * request, a turn ceiling, an abort, a plan left open, an empty completion
 * accepted as done, a loop-detector kill, a barren-turn kill, a truncation
 * ceiling). Each runs the real `AgentLoop` against a scripted gateway with the
 * shadow controller on, and the summary's disagreements are enumerated with
 * their causes.
 *
 * Why here and not on top of `lifecycle-durability.test.ts` itself: that suite
 * spawns processes and kills them, and what this one needs is every guard
 * TRIGGERED on demand — including the three exits a process-level rig can only
 * produce by luck. The shapes are the same; the rig is deterministic.
 *
 * **Zero model calls, zero spend.** The gateway is a script and the registry is
 * a fake. The canaries planted in the user message, the tool arguments, the
 * tool results and the halt reason are the no-credential grep: none of them may
 * appear in any row.
 */

import { describe, expect, test } from "bun:test";

import { BudgetExceededError } from "../../packages/llm-gateway/src/cost-tracker";
import { AgentLoop, type AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import {
  ShadowArbiter,
  type ShadowDecisionRow,
  type ShadowRow,
  type ShadowSummaryRow,
} from "../../packages/orchestrator/src/shadow-arbiter";
import { TaskStateStore } from "../../packages/orchestrator/src/task-state";

// ─── The canaries: what must never reach a row ───

const CANARY_USER = "CANARY-USER-9c1d";
const CANARY_ARG = "CANARY-ARG-4b8e";
const CANARY_RESULT = "CANARY-RESULT-2a1b";
const CANARY_HALT = "CANARY-HALT-7f2a";
const CANARY_KEY = "sk-ant-api03-CANARY-0000";
const CANARIES = [CANARY_USER, CANARY_ARG, CANARY_RESULT, CANARY_HALT, CANARY_KEY];

// ─── The rig ───

type Step =
  | { kind: "tool"; tool: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "truncated" }
  | { kind: "error"; error: string; retryable: boolean }
  | { kind: "throw"; error: Error };

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

function makeGateway(script: Step[]) {
  let i = 0;
  return {
    inferStream: async function* () {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      switch (step.kind) {
        case "tool":
          yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: step.tool });
          yield ev("tool_use_stop", {
            toolCallId: `c${i}`,
            toolInput: step.args ?? { note: CANARY_ARG },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        case "text":
          yield ev("content_delta", { delta: { type: "text_delta", text: step.text } });
          yield ev("message_stop", { stopReason: "end_turn" });
          return;
        case "empty":
          yield ev("message_stop", { stopReason: "end_turn" });
          return;
        case "truncated":
          yield ev("content_delta", { delta: { type: "text_delta", text: "half a sen" } });
          yield ev("message_stop", { stopReason: "max_tokens" });
          return;
        case "error":
          yield ev("error", { error: step.error, retryable: step.retryable });
          return;
        case "throw":
          throw step.error;
      }
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: () => [{ name: "bash", description: "", inputSchema: {} }],
    list: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: CANARY_RESULT,
      durationMs: 1,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface Scenario {
  name: string;
  script: Step[];
  /** Extra AgentLoopConfig fields. */
  opts?: Record<string, unknown>;
  permission?: unknown;
  aborted?: boolean;
  /** Steps to plant in a task spine before the run. */
  todos?: string[];
}

interface Outcome {
  name: string;
  events: AgentTurnEvent[];
  rows: ShadowRow[];
  summary: ShadowSummaryRow;
  decisions: ShadowDecisionRow[];
  stopReason: string | undefined;
}

async function runScenario(s: Scenario): Promise<Outcome> {
  const rows: ShadowRow[] = [];
  const shadow = new ShadowArbiter({
    runId: `run#${s.name}`,
    emit: (row) => rows.push(row),
    now: () => "2026-09-14T00:00:00.000Z",
  });
  let taskState: TaskStateStore | undefined;
  if (s.todos) {
    taskState = new TaskStateStore();
    taskState.setTodos(s.todos.map((content) => ({ content, status: "pending" as const })));
  }
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 8,
      systemPrompt: "s",
      shadow,
      ...(taskState ? { taskState } : {}),
      ...(s.opts ?? {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(s.script),
    makeRegistry(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.permission as any,
  );
  const controller = new AbortController();
  if (s.aborted) controller.abort();
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run(`${CANARY_USER} — build it`, "s1", "/tmp", controller.signal)) {
    events.push(e);
  }
  shadow.finish();
  const summary = rows.find((r): r is ShadowSummaryRow => r.type === "shadow_summary")!;
  const terminal = events.find((e) => e.type === "turn_complete") as
    { stopReason: string } | undefined;
  return {
    name: s.name,
    events,
    rows,
    summary,
    decisions: rows.filter((r): r is ShadowDecisionRow => r.type === "shadow_decision"),
    stopReason: terminal?.stopReason,
  };
}

/** Denies every call and latches a halt, exactly as the Auto broker does. */
const haltingCheck = async () => ({
  allowed: false,
  halt: { reason: CANARY_HALT },
  reason: `Auto mode halted this run: ${CANARY_HALT}`,
});

/** Denies deterministically, with no person involved — what barren counts. */
const denyingCheck = async () => ({ allowed: false, reason: "policy refuses this call" });

const CORPUS: Scenario[] = [
  {
    name: "gate-then-finish",
    script: [
      { kind: "tool", tool: "write_file", args: { path: "a.txt", content: "x" } },
      { kind: "text", text: "all done" },
      { kind: "tool", tool: "bash", args: { command: "node a.js" } },
      { kind: "text", text: "verified" },
    ],
  },
  {
    name: "supervisor-halt",
    script: [
      { kind: "tool", tool: "bash", args: { command: "curl example.com" } },
      { kind: "text", text: "here is my report" },
    ],
    permission: haltingCheck,
  },
  {
    name: "empty-completion-accepted",
    script: [
      { kind: "tool", tool: "write_file", args: { path: "a.txt", content: "x" } },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "text", text: "done" },
    ],
  },
  {
    name: "empty-completion-bail",
    script: [{ kind: "empty" }],
  },
  {
    name: "provider-non-retryable",
    script: [{ kind: "error", error: "401 invalid api key", retryable: false }],
  },
  {
    name: "budget-admission",
    script: [{ kind: "throw", error: new BudgetExceededError("session", 1, 2.5) }],
  },
  {
    name: "turn-ceiling",
    script: [{ kind: "tool", tool: "bash", args: { command: "echo 1" } }],
    opts: { maxTurns: 2 },
  },
  {
    name: "aborted",
    script: [{ kind: "text", text: "never reached" }],
    aborted: true,
  },
  {
    name: "open-steps",
    script: [
      { kind: "text", text: "I am done" },
      { kind: "text", text: "still done" },
    ],
    todos: ["wire the endpoint", "run the checks"],
  },
  {
    name: "loop-detector",
    script: [{ kind: "tool", tool: "bash", args: { command: "npm test" } }],
    opts: { maxStuckNudges: 0 },
  },
  {
    name: "barren-turns",
    script: [{ kind: "tool", tool: "bash", args: { command: "npm test" } }],
    permission: denyingCheck,
  },
  {
    name: "truncation",
    script: [{ kind: "truncated" }],
    opts: { maxTruncationRetries: 0 },
  },
];

// One pass over the corpus, shared by every assertion below.
const outcomes = new Map<string, Outcome>();
for (const scenario of CORPUS) {
  outcomes.set(scenario.name, await runScenario(scenario));
}
const all = [...outcomes.values()];
const got = (name: string): Outcome => outcomes.get(name)!;

// ─── S4 — the discrepancies are enumerated, and each names a cause ───

describe("S4 — over the corpus, every disagreement names guard, expected and actual", () => {
  test("the corpus really exercised the guards (not a green empty set)", () => {
    const guards = new Set(all.flatMap((o) => o.decisions.map((d) => d.guard)));
    for (const expected of [
      "E1",
      "E2",
      "E3",
      "E4",
      "E6",
      "E7",
      "E8",
      "G4",
      "G7",
      "G9",
      "VERDICT",
    ]) {
      expect(guards.has(expected), `${expected} never fired in the corpus`).toBe(true);
    }
    // Two scenarios shadow nothing by design — the loop-detector and
    // barren-turn kills are `unshadowed` in M2 — and they say so instead of
    // going silent.
    for (const o of all) {
      expect(o.summary.events > 0 || o.summary.unshadowed.length > 0, o.name).toBe(true);
    }
  });

  test("every disagreement carries a guard and both transitions", () => {
    const disagreements = all.flatMap((o) =>
      o.summary.disagreementList.map((d) => ({ run: o.name, ...d })),
    );
    for (const d of disagreements) {
      expect(d.guard.length).toBeGreaterThan(0);
      expect(d.expected.length).toBeGreaterThan(0);
      expect(d.actual.length).toBeGreaterThan(0);
      expect(d.expected).not.toBe(d.actual);
    }
    // The list is the lane's deliverable, so it is printed rather than only
    // counted — the report quotes it.
    console.log(
      `[S4] disagreements over ${CORPUS.length} scenarios:\n` +
        disagreements
          .map((d) => `  ${d.run} · ${d.guard}: arbiter ${d.expected} · guard ${d.actual}`)
          .join("\n"),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  test("G9 is among them: an empty completion accepted as a finished run", () => {
    const run = got("empty-completion-accepted");
    const g9 = run.summary.disagreementList.filter((d) => d.guard === "G9");
    expect(g9.length).toBeGreaterThan(0);
    expect(g9[0]!.expected).toBe("abandoned(environment)");
    expect(g9[0]!.actual).toBe("complete(end_turn)");
    // And the run really did end as a success, which is the defect being named.
    expect(run.stopReason).toBe("end_turn");
  });

  test("a disagreement row carries the reason the arbiter decided as it did", () => {
    const g9 = got("empty-completion-accepted").decisions.find((d) => d.guard === "G9")!;
    expect(g9.agree).toBe(false);
    expect(g9.reason).toContain("no verdict");
    expect(g9.applied).toBe(false);
  });

  test("the agreements are real agreements, not unknowns in disguise", () => {
    for (const o of all) {
      expect(o.summary.agreements + o.summary.disagreements + o.summary.unknowns).toBe(
        o.summary.events,
      );
    }
    const halt = got("supervisor-halt");
    const e3 = halt.decisions.filter((d) => d.guard === "E3");
    expect(e3.map((d) => d.decision)).toEqual(["blocked(halt)", "complete(report_only)"]);
    expect(e3.every((d) => d.agree)).toBe(true);
  });
});

// ─── S7 — the four verdict-less exits ───

describe("S7 — the verdict-less exits name themselves", () => {
  test("E6 (non-retryable) decides environment, not provider_lost", () => {
    const run = got("provider-non-retryable");
    const e6 = run.decisions.find((d) => d.guard === "E6")!;
    expect(e6.decision).toBe("abandoned(environment)");
    expect(e6.agree).toBe(true);
    expect(run.stopReason).toBe("provider_lost");
  });

  test("E7 (budget admission) decides budget", () => {
    const run = got("budget-admission");
    const e7 = run.decisions.find((d) => d.guard === "E7")!;
    expect(e7.decision).toBe("abandoned(budget)");
    expect(run.stopReason).toBe("budget");
  });

  test("E9 is recorded as unshadowed, and the exit names itself", () => {
    const run = got("loop-detector");
    expect(run.summary.unshadowed).toContain("E9");
    expect(run.decisions.some((d) => d.guard === "E9")).toBe(false);
    // M2 asserts the exit's OWN terminal event instead of a shadow decision.
    expect(run.stopReason).toBe("loop_detected");
  });

  test("E11 is recorded as unshadowed, and the exit names itself", () => {
    const run = got("barren-turns");
    expect(run.summary.unshadowed).toContain("E11");
    expect(run.decisions.some((d) => d.guard === "E11")).toBe(false);
    expect(run.stopReason).toBe("barren");
  });

  test("no decision anywhere in the corpus is spelled provider_lost", () => {
    const spellings = new Set(all.flatMap((o) => o.decisions.map((d) => d.decision)));
    expect([...spellings].filter((s) => s.includes("provider_lost"))).toEqual([]);
  });

  test("the four exits are four different answers", () => {
    expect(
      new Set([
        got("provider-non-retryable").decisions.find((d) => d.guard === "E6")!.decision,
        got("budget-admission").decisions.find((d) => d.guard === "E7")!.decision,
        got("loop-detector").stopReason,
        got("barren-turns").stopReason,
      ]).size,
    ).toBe(4);
  });
});

// ─── The other exits the corpus covers ───

describe("the ladder's other classes fire where they should", () => {
  test("an abort is class 0 and terminal", () => {
    const e2 = got("aborted").decisions.find((d) => d.guard === "E2")!;
    expect(e2.class).toBe(0);
    expect(e2.decision).toBe("abandoned(user_abort)");
    expect(e2.agree).toBe(true);
  });

  test("the turn ceiling is class 2", () => {
    const e1 = got("turn-ceiling").decisions.find((d) => d.guard === "E1")!;
    expect(e1.class).toBe(2);
    expect(e1.decision).toBe("abandoned(budget)");
  });

  test("the open-steps gate refuses once, then records a partial completion", () => {
    const g7 = got("open-steps").decisions.filter((d) => d.guard === "G7");
    expect(g7.map((d) => d.decision)).toEqual(["repairing", "complete(partial)"]);
    expect(got("open-steps").stopReason).toBe("open_steps");
  });

  test("the verdict site is an unknown when no contract is in scope", () => {
    const verdicts = all.flatMap((o) => o.decisions.filter((d) => d.guard === "VERDICT"));
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(v.decision).toBe("unknown");
      // Either there was no contract to decide from, or a lower-class event
      // had already ended the run for the arbiter — never a guess.
      expect(
        v.reason.includes("no contract") || v.reason === "run already terminal",
        v.reason,
      ).toBe(true);
    }
    // The plain case, named rather than lost in the disjunction above.
    const plain = got("gate-then-finish").decisions.find((d) => d.guard === "VERDICT")!;
    expect(plain.reason).toContain("no contract");
  });
});

// ─── The no-credential grep ───

describe("no row carries message text, tool arguments, results or credentials", () => {
  test("not one canary appears in any row of any scenario", () => {
    for (const o of all) {
      const json = JSON.stringify(o.rows);
      for (const canary of CANARIES) {
        expect(json.includes(canary), `${o.name} leaked ${canary}`).toBe(false);
      }
    }
  });

  test("every string in every row's inputs is a boolean, a number or an enum word", () => {
    const allowed = new Set([
      "met",
      "partial",
      "unmet",
      "none",
      "end_turn",
      "open_steps",
      "budget",
    ]);
    for (const o of all) {
      for (const row of o.decisions) {
        for (const [key, value] of Object.entries(row.inputs)) {
          if (typeof value === "string") {
            expect(allowed.has(value) || value === "<omitted>", `${key}=${value}`).toBe(true);
          }
        }
      }
    }
  });
});

// ─── S10 — overhead, measured and printed ───

describe("S10 — the overhead is measured and reported, not asserted away", () => {
  test("every run reports p50, p95 and a total, and the rows stay bounded", () => {
    const lines: string[] = [];
    for (const o of all) {
      const s = o.summary;
      expect(s.overheadUs.p95).toBeGreaterThanOrEqual(s.overheadUs.p50);
      expect(s.overheadUs.total).toBeGreaterThanOrEqual(0);
      expect(o.decisions.length).toBeLessThanOrEqual(200);
      lines.push(
        `  ${o.name.padEnd(26)} rows ${String(o.decisions.length).padStart(3)} · ` +
          `events ${String(s.events).padStart(3)} · agree ${s.agreements} · ` +
          `disagree ${s.disagreements} · unknown ${s.unknowns} · ` +
          `p50 ${s.overheadUs.p50}µs · p95 ${s.overheadUs.p95}µs · total ${s.overheadUs.total}µs`,
      );
    }
    console.log(`[S10] shadow overhead per scenario:\n${lines.join("\n")}`);
    // No threshold is claimed. The number is the deliverable.
    expect(lines.length).toBe(CORPUS.length);
  });
});
