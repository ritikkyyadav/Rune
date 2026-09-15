/**
 * M4 deliverable B — the controller repairs by class, once.
 *
 * `repair-classifier.test.ts` pins what kind a failure is and
 * `repair-arbiter.test.ts` pins what the arbiter proposes. This file runs the
 * REAL `AgentLoop` against a scripted gateway and pins what the loop DOES —
 * twice wherever it matters, with the class's key in `[controller] authority`
 * and without it, because the two must be indistinguishable from outside
 * unless the key is on.
 *
 * Exit tests, by the spec's numbers (`docs/program/m4-repair-and-delegation.md`):
 *
 *   R1  a red check → exactly one repair turn naming it; the re-verify runs
 *       only the impacted commands, not the suite
 *   R2  unrelated checks are not rerun endlessly; the count is bounded and named
 *   R3  denied is not an invitation — no alternative command is attempted
 *   R7  exhausted repair leaves the failure on the record, not a retry
 *   R8  rollback: every key absent → the same events, requests and transcript
 *   R9  a missing runner is not a failure of the work
 *
 * Plus the mutation the spec names, performed on a real instance: force the
 * class to `transport` for every failure, and R1, R3 and R9 go red.
 *
 * **Zero model calls.** The gateway is a script; no credential, no network.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { AppliedDecisionRow } from "../../../packages/orchestrator/src/arbiter";
import {
  ShadowArbiter,
  type ShadowDecisionRow,
  type ShadowRow,
} from "../../../packages/orchestrator/src/shadow-arbiter";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";

// ─── The rig ───

type Step =
  | { kind: "tool"; tool: string; args?: Record<string, unknown>; text?: string }
  | { kind: "text"; text: string }
  | { kind: "error"; error: string; retryable?: boolean };

interface Request {
  messages: number;
  lastRole: string | undefined;
}

function makeGateway(script: Step[], requests: Request[]) {
  let i = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inferStream: async function* (request: any) {
      const messages = (request?.messages ?? []) as Array<{ role: string }>;
      requests.push({ messages: messages.length, lastRole: messages[messages.length - 1]?.role });
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      switch (step.kind) {
        case "tool":
          if (step.text) {
            yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
          }
          yield { type: "tool_use_start", toolCallId: `c${i}`, toolName: step.tool };
          yield { type: "tool_use_stop", toolCallId: `c${i}`, toolInput: step.args ?? {} };
          yield { type: "message_stop", stopReason: "tool_use" };
          return;
        case "text":
          yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
          yield { type: "message_stop", stopReason: "end_turn" };
          return;
        case "error":
          yield {
            type: "error",
            error: step.error,
            ...(step.retryable === undefined ? {} : { retryable: step.retryable }),
          };
          return;
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
      result: "ok",
      durationMs: 1,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** One `verify()` call, as the loop made it. */
interface VerifyCall {
  touched: string[] | undefined;
  /** The impacted set the loop asked for, or `undefined` for the whole suite. */
  only: string[] | undefined;
}

interface RunOptions {
  script: Step[];
  authority?: string[];
  inheritedRepairTurns?: Record<string, number>;
  /** Successive verifier answers. The last one repeats. */
  verifyResults?: VerifyResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permission?: any;
  failedAcceptance?: Array<{ text: string; outputTail: string }>;
  /** The mutation: every failure is `transport`, whatever it was. */
  forceTransport?: boolean;
  opts?: Record<string, unknown>;
}

interface Outcome {
  events: AgentTurnEvent[];
  decisions: AppliedDecisionRow[];
  shadow: ShadowDecisionRow[];
  requests: Request[];
  verifyCalls: VerifyCall[];
  permissionCalls: string[];
  messages: ReturnType<AgentLoop["getMessages"]>;
  stopReason: string | undefined;
  notices: string[];
}

const RED: VerifyResult = {
  passed: false,
  ran: true,
  report: "$ bun test\nFAIL src/parser.test.ts\n  ✗ parses a nested list\n\n1 fail, 12 pass",
  runs: [
    { command: "bun test", exitCode: 1, durationMs: 5, passed: false },
    { command: "bunx tsc --noEmit", exitCode: 0, durationMs: 5, passed: true },
  ],
};

const NO_RUNNER: VerifyResult = {
  passed: false,
  ran: true,
  report: "$ bun test\nbash: bun: command not found",
  runs: [{ command: "bun test", exitCode: 127, durationMs: 1, passed: false }],
};

const GREEN: VerifyResult = {
  passed: true,
  ran: true,
  report: "$ bun test\n12 pass, 0 fail",
  runs: [{ command: "bun test", exitCode: 0, durationMs: 5, passed: true }],
};

async function runLoop(options: RunOptions): Promise<Outcome> {
  const requests: Request[] = [];
  const rows: ShadowRow[] = [];
  const decisions: AppliedDecisionRow[] = [];
  const permissionCalls: string[] = [];
  const verifyCalls: VerifyCall[] = [];
  const shadow = new ShadowArbiter({
    runId: "run#1",
    emit: (row) => rows.push(row),
    now: () => "2026-09-15T00:00:00.000Z",
  });
  const permission =
    options.permission ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (call: any) => {
      permissionCalls.push(String(call?.toolName ?? "?"));
      return { allowed: true };
    });
  const answers = options.verifyResults ?? [];
  const verifier = answers.length
    ? {
        verify: async (_s?: AbortSignal, touched?: string[], only?: string[]) => {
          verifyCalls.push({ touched, only });
          return answers[Math.min(verifyCalls.length - 1, answers.length - 1)]!;
        },
      }
    : undefined;
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 10,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      shadow,
      ...(verifier ? { verifier } : {}),
      ...(options.failedAcceptance ? { failedAcceptance: () => options.failedAcceptance! } : {}),
      controller: {
        runId: "run#1",
        authority: new Set(options.authority ?? []),
        ...(options.inheritedRepairTurns
          ? { inheritedRepairTurns: options.inheritedRepairTurns }
          : {}),
        record: (row: AppliedDecisionRow) => decisions.push(row),
      },
      ...(options.opts ?? {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(options.script, requests),
    makeRegistry(),
    permission,
  );
  if (options.forceTransport) {
    // The mutation, on the real seam: every failure is a transport failure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loop as any).classifyFailure = () => ({
      cls: "transport",
      response: "retry",
      reason: "forced",
    });
  }
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("do the thing", "s1", "/tmp", undefined)) events.push(e);
  shadow.finish();
  const terminal = events.find((e) => e.type === "turn_complete") as
    { stopReason: string } | undefined;
  return {
    events,
    decisions,
    shadow: rows.filter((r): r is ShadowDecisionRow => r.type === "shadow_decision"),
    requests,
    verifyCalls,
    permissionCalls,
    messages: loop.getMessages(),
    stopReason: terminal?.stopReason,
    notices: events.flatMap((e) => (e.type === "notice" ? [e.message] : [])),
  };
}

/** Harness messages the loop appended, by their origin tag's own words. */
function gateMessages(messages: ReturnType<AgentLoop["getMessages"]>, needle: string): string[] {
  return messages.flatMap((m) =>
    m.role === "user"
      ? m.content.flatMap((b) =>
          b.type === "text" && (b as { text: string }).text.includes(needle)
            ? [(b as { text: string }).text]
            : [],
        )
      : [],
  );
}

/** A run that edits a file and then tries to finish, twice. */
const EDIT_THEN_FINISH: Step[] = [
  { kind: "tool", tool: "write_file", args: { path: "a.ts", content: "x" } },
  { kind: "text", text: "done" },
  { kind: "tool", tool: "write_file", args: { path: "a.ts", content: "y" } },
  { kind: "text", text: "done again" },
  { kind: "text", text: "still done" },
];

// ─── R1 / R2 — a red check buys exactly one repair turn, and names it ───

describe("R1 — a red project check leads to exactly one bounded repair", () => {
  test("one repair turn, naming the failing command and the tail of its output", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, RED, GREEN],
    });
    const repairs = gateMessages(out.messages, "Automated verification failed");
    expect(repairs.length).toBe(1);
    // It NAMES the check. Before M4 the model got the whole report and had to
    // find the failing command in it.
    expect(repairs[0]).toContain("Failing check: bun test");
    expect(repairs[0]).toContain("parses a nested list");
  });

  test("R1/R2 — the re-verify asks for the impacted set, not the suite", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, GREEN],
    });
    expect(out.verifyCalls.length).toBeGreaterThanOrEqual(2);
    // The first verification has nothing to narrow to.
    expect(out.verifyCalls[0]!.only).toBeUndefined();
    // The one after the repair turn names only the command that went red —
    // not `bunx tsc --noEmit`, which passed and is nobody's business here.
    expect(out.verifyCalls[1]!.only).toEqual(["bun test"]);
  });

  test("with the key ABSENT the re-verify is the whole suite, exactly as before", async () => {
    const out = await runLoop({ script: EDIT_THEN_FINISH, verifyResults: [RED, GREEN] });
    for (const call of out.verifyCalls) expect(call.only).toBeUndefined();
  });

  test("the decision row carries the class, and never the command or the output", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, GREEN],
    });
    const row = out.decisions.find((d) => d.guard === "REPAIR_CHECK");
    expect(row).toBeDefined();
    expect(row!.inputs.repairClass).toBe("check_failed");
    expect(row!.inputs.repairResponse).toBe("repair_turn");
    expect(row!.transition).toBe("repairing");
    const rendered = JSON.stringify(row);
    expect(rendered).not.toContain("bun test");
    expect(rendered).not.toContain("parses a nested list");
  });
});

describe("R2 — checks are not rerun endlessly, and the bound is named", () => {
  test("a check that stays red is verified twice, not until the turns run out", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, RED, RED, RED],
    });
    // One repair turn, so at most two verification rounds: the one that found
    // it and the one that re-checked it. Without the key the enclosing ladder
    // allows three, plus a replan and three more.
    expect(out.verifyCalls.length).toBeLessThanOrEqual(2);
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(1);
  });
});

// ─── R7 — the exhausted repair leaves the failure on the record ───

describe("R7 — after the bound, the gap is named and the text is intact", () => {
  test("the second red buys nothing, and the run says so once", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, RED, RED],
    });
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(1);
    expect(out.notices.some((n) => n.includes("repair budget is spent"))).toBe(true);
    // The run ENDS. It does not sit in a verify/replan cycle.
    expect(out.stopReason).toBe("end_turn");
    // And the model's own closing text is still in the transcript: a bounded
    // repair does not throw the work away.
    const assistant = out.messages.filter((m) => m.role === "assistant");
    expect(JSON.stringify(assistant)).toContain("done");
  });

  test("the bounded decision says the finish will name the gap", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      verifyResults: [RED, RED, RED],
    });
    const bounded = out.decisions.filter(
      (d) => d.guard === "REPAIR_CHECK" && d.transition === "verifying",
    );
    expect(bounded.length).toBe(1);
    expect(bounded[0]!.reason).toContain("gap named");
  });

  test("the count is durable — a resumed run at the bound gets no repair turn", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed"],
      inheritedRepairTurns: { check_failed: 1 },
      verifyResults: [RED, RED],
    });
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(0);
    expect(out.decisions.some((d) => d.transition === "verifying")).toBe(true);
  });

  test("the same inheritance with the key ABSENT buys the full ladder", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      inheritedRepairTurns: { check_failed: 1 },
      verifyResults: [RED, RED],
    });
    expect(gateMessages(out.messages, "Automated verification failed").length).toBeGreaterThan(0);
  });
});

// ─── R9 — a missing runner is not a failure of the work ───

describe("R9 — `bun: command not found` is needs_review, not a retry", () => {
  /** One write, one finish — so there is exactly one verification to judge. */
  const EDIT_ONCE: Step[] = [
    { kind: "tool", tool: "write_file", args: { path: "a.ts", content: "x" } },
    { kind: "text", text: "done" },
  ];

  test("no repair turn, no retry, one sentence", async () => {
    const out = await runLoop({
      script: EDIT_ONCE,
      authority: ["missing_dependency"],
      verifyResults: [NO_RUNNER, NO_RUNNER],
    });
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(0);
    const said = out.notices.filter((n) => n.includes("its runner is missing"));
    expect(said.length).toBe(1);
    expect(out.stopReason).toBe("end_turn");
  });

  test("the decision names the class and refuses to install anything", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["missing_dependency"],
      verifyResults: [NO_RUNNER, NO_RUNNER],
    });
    const row = out.decisions.find((d) => d.guard === "REPAIR_DEPENDENCY");
    expect(row).toBeDefined();
    expect(row!.inputs.repairClass).toBe("missing_dependency");
    expect(row!.transition).toBe("verifying");
    expect(row!.reason).toContain("nothing is installed");
  });

  test("with the key ABSENT the missing runner is repaired like any other red", async () => {
    const out = await runLoop({ script: EDIT_THEN_FINISH, verifyResults: [NO_RUNNER, GREEN] });
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(1);
  });
});

// ─── R3 — denied is not an invitation ───

describe("R3 — a permission denial attempts no alternative", () => {
  const DENYING = async (call: { toolName: string }) => ({
    allowed: call.toolName !== "bash",
    ...(call.toolName === "bash" ? { reason: "bash is not allowed in this workspace" } : {}),
  });

  test("the row says denied, and no second command is tried", async () => {
    const out = await runLoop({
      script: [
        { kind: "tool", tool: "bash", args: { command: "rm -rf /" } },
        { kind: "text", text: "understood, stopping" },
      ],
      authority: ["denied"],
      permission: DENYING,
    });
    const row = out.decisions.find((d) => d.guard === "REPAIR_DENIED");
    expect(row).toBeDefined();
    expect(row!.inputs.repairClass).toBe("denied");
    expect(row!.inputs.repairResponse).toBe("stop");
    expect(row!.transition).toBe("blocked(ask)");
    expect(row!.reason).toContain("no alternative route");
    // Exactly one tool call was attempted: the one that was refused. The
    // harness offered the model no route around it.
    const calls = out.events.filter((e) => e.type === "tool_call_start");
    expect(calls.length).toBe(1);
    expect(out.stopReason).toBe("end_turn");
  });

  test("R8 — the denial behaves identically with the key on and off", async () => {
    const script: Step[] = [
      { kind: "tool", tool: "bash", args: { command: "rm -rf /" } },
      { kind: "text", text: "understood, stopping" },
    ];
    const off = await runLoop({ script, permission: DENYING });
    const on = await runLoop({ script, authority: ["denied"], permission: DENYING });
    expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));
    expect(JSON.stringify(on.messages)).toBe(JSON.stringify(off.messages));
    expect(on.requests).toEqual(off.requests);
    // The only difference is the ledger.
    expect(off.decisions.length).toBe(0);
    expect(on.decisions.length).toBeGreaterThan(0);
  });
});

// ─── transport ───

describe("transport — retry to the bound, then the environment", () => {
  const FLAKY: Step[] = [
    { kind: "error", error: "fetch failed", retryable: true },
    { kind: "error", error: "fetch failed", retryable: true },
    { kind: "error", error: "fetch failed", retryable: true },
  ];

  test("three transport failures end the run on the environment, not the work", async () => {
    for (const authority of [[], ["transport"]]) {
      const out = await runLoop({ script: FLAKY, authority });
      expect(out.stopReason).toBe("provider_lost");
    }
  });

  test("the count is durable — a resumed run at two abandons on its first", async () => {
    const out = await runLoop({
      script: FLAKY,
      authority: ["transport"],
      inheritedRepairTurns: { transport: 2 },
    });
    expect(out.stopReason).toBe("provider_lost");
    // One request, not three: the killed run's two failures came with it.
    expect(out.requests.length).toBe(1);
  });

  test("the same inheritance with the key ABSENT buys a fresh three", async () => {
    const out = await runLoop({ script: FLAKY, inheritedRepairTurns: { transport: 2 } });
    expect(out.requests.length).toBe(3);
  });

  test("R8 — on and off are indistinguishable from outside", async () => {
    const off = await runLoop({ script: FLAKY });
    const on = await runLoop({ script: FLAKY, authority: ["transport"] });
    expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));
    expect(on.requests).toEqual(off.requests);
  });
});

// ─── acceptance ───

describe("acceptance — one re-prompt naming the criterion, then partial", () => {
  /** What the oracle says. The model never sees this string. */
  const HIDDEN_TEXT = "the CSV importer accepts a file with a BOM";
  const FAILED = [
    {
      id: "a1",
      outputTail: "AssertionError: expected 3 rows, got 0\n  at import.test.ts:41",
    },
  ];

  test("one re-prompt, naming the criterion's ID and the tail — never its text or command", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["acceptance"],
      failedAcceptance: FAILED,
    });
    const asked = gateMessages(out.messages, "acceptance stated for this task");
    expect(asked.length).toBe(1);
    // The id says WHICH criterion failed; the tail says what its check saw.
    expect(asked[0]).toContain("acceptance criterion a1 failed");
    expect(asked[0]).toContain("expected 3 rows, got 0");
    // V7 finding 19: the first version printed up to four hidden criteria
    // VERBATIM plus `(and N more)`, so with `acceptance` in `[controller]
    // authority` a model that failed deliberately could enumerate the oracle's
    // own words and count them — retiring M1's "the acceptance the model never
    // sees" without saying so. There is no field for the text any more.
    expect(asked[0]).not.toContain(HIDDEN_TEXT);
    expect(JSON.stringify(FAILED)).not.toContain(HIDDEN_TEXT);
    // The oracle's command is not in the transcript and there is no field for
    // it: quoting it teaches a model to satisfy the command, not the criterion.
    expect(asked[0]).not.toContain("bun test");
    expect(asked[0]).not.toContain("$ ");
  });

  test("the second finish is not re-prompted, whatever happens", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["acceptance"],
      failedAcceptance: FAILED,
    });
    expect(gateMessages(out.messages, "acceptance stated for this task").length).toBe(1);
    const spent = out.decisions.filter(
      (d) => d.guard === "REPAIR_ACCEPTANCE" && d.transition === "complete(partial)",
    );
    expect(spent.length).toBeGreaterThanOrEqual(1);
  });

  test("the count is durable — a resumed run that already asked does not ask again", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["acceptance"],
      failedAcceptance: FAILED,
      inheritedRepairTurns: { acceptance: 1 },
    });
    expect(gateMessages(out.messages, "acceptance stated for this task").length).toBe(0);
  });

  test("R8 — with the key ABSENT the gate is advisory, exactly as M1 left it", async () => {
    const out = await runLoop({ script: EDIT_THEN_FINISH, failedAcceptance: FAILED });
    expect(gateMessages(out.messages, "acceptance stated for this task").length).toBe(0);
    expect(out.decisions.length).toBe(0);
  });
});

// ─── no_progress ───

describe("no_progress — one nudge, then abandoned", () => {
  const RUT: Step[] = [
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
    { kind: "tool", tool: "read_file", args: { path: "a.ts" } },
  ];

  test("the run ends on the loop detector, with the key on and off alike", async () => {
    for (const authority of [[], ["no_progress"]]) {
      const out = await runLoop({ script: RUT, authority });
      expect(out.stopReason).toBe("loop_detected");
    }
  });

  test("the decision names the class and never proposes a completion", async () => {
    const out = await runLoop({ script: RUT, authority: ["no_progress"] });
    const rows = out.decisions.filter((d) => d.guard === "REPAIR_PROGRESS");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.inputs.repairClass).toBe("no_progress");
      expect(row.class).toBe(5);
      expect(row.transition.startsWith("complete(")).toBe(false);
    }
    expect(rows.some((r) => r.transition === "abandoned(no_progress)")).toBe(true);
  });

  test("a resumed run whose nudge is spent bails on its first rut", async () => {
    const out = await runLoop({
      script: RUT,
      authority: ["no_progress"],
      inheritedRepairTurns: { no_progress: 1 },
    });
    expect(out.stopReason).toBe("loop_detected");
    expect(out.notices.some((n) => n.includes("nudging the agent"))).toBe(false);
  });
});

// ─── The mutation ───

describe("the mutation — force the class to `transport` for every failure", () => {
  test("R1 goes red: the red check is no longer repaired as a red check", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["check_failed", "transport", "missing_dependency", "denied"],
      verifyResults: [RED, GREEN],
      forceTransport: true,
    });
    const row = out.decisions.find((d) => d.guard === "REPAIR_CHECK");
    expect(row?.inputs.repairClass).toBe("transport");
    // The assertion R1 makes on the honest tree, inverted: the class the row
    // carries is a lie, so a reader grouping by type sees a transport failure
    // where a check went red.
    expect(row?.inputs.repairClass).not.toBe("check_failed");
  });

  test("R9 goes red: the missing runner is repaired instead of reported", async () => {
    const out = await runLoop({
      script: EDIT_THEN_FINISH,
      authority: ["missing_dependency", "check_failed"],
      verifyResults: [NO_RUNNER, NO_RUNNER],
      forceTransport: true,
    });
    // On the honest tree this is 0 and one notice says the runner is missing.
    expect(gateMessages(out.messages, "Automated verification failed").length).toBe(1);
    expect(out.notices.some((n) => n.includes("its runner is missing"))).toBe(false);
    expect(out.decisions.some((d) => d.guard === "REPAIR_DEPENDENCY")).toBe(false);
  });

  test("R3 goes red: the denial's row no longer says it was a boundary", async () => {
    const out = await runLoop({
      script: [
        { kind: "tool", tool: "bash", args: { command: "rm -rf /" } },
        { kind: "text", text: "understood" },
      ],
      authority: ["denied"],
      permission: async (call: { toolName: string }) => ({
        allowed: call.toolName !== "bash",
        reason: "no",
      }),
      forceTransport: true,
    });
    const row = out.decisions.find((d) => d.guard === "REPAIR_DENIED");
    expect(row?.inputs.repairClass).toBe("transport");
    expect(row?.inputs.repairResponse).toBe("retry");
    // The row that should have said "stop" now says "retry" — the class table's
    // `never` column, breached in the ledger.
    expect(row?.inputs.repairResponse).not.toBe("stop");
  });
});

// ─── R8 — the safety surface is untouched ───

describe("R8 — permissions, and the calls that ask about them, are identical", () => {
  test("every class on and every class off make the same permission calls", async () => {
    const all = [
      "transport",
      "check_failed",
      "acceptance",
      "missing_dependency",
      "denied",
      "no_progress",
    ];
    const script = EDIT_THEN_FINISH;
    const off = await runLoop({ script, verifyResults: [GREEN] });
    const on = await runLoop({ script, authority: all, verifyResults: [GREEN] });
    expect(on.permissionCalls).toEqual(off.permissionCalls);
    expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));
    expect(on.requests).toEqual(off.requests);
  });
});
