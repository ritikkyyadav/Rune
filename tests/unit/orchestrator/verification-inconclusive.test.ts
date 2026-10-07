/**
 * V2 — a verification that reached no verdict buys no repair.
 *
 * `verifier.test.ts` pins what the verifier RETURNS for a deadline, a
 * cancelled run and an absent toolchain. This file runs the real `AgentLoop`
 * against a scripted gateway and pins what the loop DOES with each — every
 * case twice, with the repair classes in `[controller] authority` and without,
 * because the rule has to hold either way: with every key absent the legacy
 * answer to any failure class is "repair", so a rule that lived only in the
 * classifier would hold only for a run that had turned the controller on.
 *
 *   I1  a check killed at its deadline: no repair turn, no effort escalation,
 *       no replan, and the run does not say it failed
 *   I2  a check that ran and went red still gets its bounded repair
 *   I3  a pass followed by a timeout is not a pass
 *   I4  every check skipped is not a pass and not a failure
 *   I5  a run cancelled inside verification records no failure
 *   I6  every surface says the same thing about one event
 *
 * **Zero model calls.** The gateway is a script; no credential, no network.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { toUpdate } from "../../../packages/orchestrator/src/bin/acp-cli";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { projectChildEvent } from "../../../packages/orchestrator/src/subagent-events";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";
import { describeVerification, verificationOutcome } from "../../../packages/protocol/src/index";

// ─── The rig ───

type Step =
  { kind: "tool"; tool: string; args?: Record<string, unknown> } | { kind: "text"; text: string };

function makeGateway(script: Step[], efforts: string[]) {
  let i = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inferStream: async function* (request: any) {
      efforts.push(String(request?.thinking?.effort ?? ""));
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.kind === "tool") {
        yield { type: "tool_use_start", toolCallId: `c${i}`, toolName: step.tool };
        yield { type: "tool_use_stop", toolCallId: `c${i}`, toolInput: step.args ?? {} };
        yield { type: "message_stop", stopReason: "tool_use" };
        return;
      }
      yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
      yield { type: "message_stop", stopReason: "end_turn" };
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

// What `CommandVerifier` returns for each outcome, as the loop receives it.

const TIMEOUT: VerifyResult = {
  status: "inconclusive",
  reason: "timeout",
  passed: false,
  ran: false,
  report: "$ bun run test\n[timed out after 120000ms — nothing was measured]",
  runs: [
    { command: "bun run test", exitCode: null, durationMs: 120_000, passed: false, timedOut: true },
  ],
};

const PASS_THEN_TIMEOUT: VerifyResult = {
  status: "inconclusive",
  reason: "timeout",
  passed: false,
  ran: false,
  report:
    "$ bun run typecheck  (ok)\n\n$ bun run test\n[timed out after 120000ms — nothing was measured]",
  runs: [
    { command: "bun run typecheck", exitCode: 0, durationMs: 900, passed: true },
    { command: "bun run test", exitCode: null, durationMs: 120_000, passed: false, timedOut: true },
  ],
};

const ALL_SKIPPED: VerifyResult = {
  status: "inconclusive",
  reason: "missing_runner",
  passed: false,
  ran: false,
  report: "No check could run — cargo is not installed on this machine.",
  runs: [
    {
      command: "cargo check --quiet",
      exitCode: null,
      durationMs: 2,
      passed: true,
      skipped: "cargo is not installed on this machine",
    },
  ],
};

const CANCELLED: VerifyResult = {
  status: "inconclusive",
  reason: "cancelled",
  passed: false,
  ran: false,
  report: "$ bun run test\n[cancelled]\n\n[cancelled — the remaining checks did not run]",
  runs: [
    { command: "bun run test", exitCode: null, durationMs: 40, passed: false, cancelled: true },
  ],
};

const RED: VerifyResult = {
  status: "failed",
  passed: false,
  ran: true,
  report: "$ bun run test  (exit 1)\n✗ parses a nested list\n\n1 fail, 12 pass",
  runs: [{ command: "bun run test", exitCode: 1, durationMs: 5, passed: false }],
};

const GREEN: VerifyResult = {
  status: "passed",
  passed: true,
  ran: true,
  report: "$ bun run test  (ok)",
  runs: [{ command: "bun run test", exitCode: 0, durationMs: 5, passed: true }],
};

/**
 * The two-boolean shape a verifier written before `status` existed returns for
 * a timeout: `(ran, !passed)`, the same cell as a real failure. The loop reads
 * the run's own `timedOut` mark and must not repair this either.
 */
const LEGACY_TIMEOUT = {
  passed: false,
  ran: true,
  report: "$ bun run test\n[timed out after 120000ms]",
  runs: [
    { command: "bun run test", exitCode: 143, durationMs: 120_000, passed: false, timedOut: true },
  ],
} as VerifyResult;

interface RunOptions {
  script: Step[];
  authority: string[];
  verifyResults: VerifyResult[];
  /** Abort the run from inside the Nth `verify()` call (1-based). */
  abortInVerify?: number;
}

async function runLoop(options: RunOptions) {
  const efforts: string[] = [];
  const incidents: string[] = [];
  const decisions: unknown[] = [];
  const taskState = new TaskStateStore();
  const controller = new AbortController();
  let verifyCalls = 0;
  const verifier = {
    verify: async () => {
      verifyCalls++;
      if (options.abortInVerify === verifyCalls) controller.abort();
      return options.verifyResults[Math.min(verifyCalls - 1, options.verifyResults.length - 1)]!;
    },
  };
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
      verifier,
      // Effort routing ON, so a latch is observable: a routed turn runs below
      // the ceiling and a latched one runs at it.
      effortRouting: "conservative",
      thinkingEffort: "high",
      onIncident: (i: { class: string }) => incidents.push(i.class),
      controller: {
        runId: "run#1",
        authority: new Set(options.authority),
        record: (row: unknown) => decisions.push(row),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(options.script, efforts),
    makeRegistry(),
    async () => ({ allowed: true }),
  );
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("add the parser", "s1", "/tmp", controller.signal)) events.push(e);
  const messages = loop.getMessages();
  const harnessNotes = messages.flatMap((m) =>
    m.role === "user"
      ? m.content.flatMap((b) => (b.type === "text" ? [(b as { text: string }).text] : []))
      : [],
  );
  return {
    events,
    efforts,
    incidents,
    decisions,
    verifyCalls,
    taskState,
    harnessNotes,
    notices: events.flatMap((e) => (e.type === "notice" ? [e.message] : [])),
    completed: events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "verification_completed" }> =>
        e.type === "verification_completed",
    ),
    stopReason: (
      events.find((e) => e.type === "turn_complete") as { stopReason?: string } | undefined
    )?.stopReason,
    repairs: harnessNotes.filter((t) => t.includes("Automated verification failed")),
    replans: harnessNotes.filter((t) => t.includes("Automated checks are still failing")),
  };
}

/**
 * The model writes a file, runs something itself, and says it is done. The
 * `bash` call matters: it is execution evidence, so the execution-evidence gate
 * (a different gate, asked about below) has nothing to say and the only thing
 * that could buy a second turn here is the verification result.
 */
const WRITE_RUN_FINISH: Step[] = [
  { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "x" } },
  { kind: "tool", tool: "bash", args: { command: "bun test src/parser.test.ts" } },
  { kind: "text", text: "done" },
  { kind: "text", text: "done again" },
];

/** Authority off, and authority on for both classes a check can fall into. */
const AUTHORITIES: Array<[string, string[]]> = [
  ["authority empty", []],
  ["authority enabled", ["check_failed", "missing_dependency"]],
];

// ─── I1 — a deadline is not a red check ───

describe.each(AUTHORITIES)("I1 — a check killed at its deadline (%s)", (_label, authority) => {
  test("buys no repair turn and no replan, and the run ends", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, verifyResults: [TIMEOUT] });
    expect(out.repairs).toEqual([]);
    expect(out.replans).toEqual([]);
    expect(out.notices).not.toContain("Verification failed — asking the agent to fix it.");
    expect(out.stopReason).toBe("end_turn");
    // One verification, and exactly the three completions the script needed:
    // write, run, finish. A repair turn would be a fourth.
    expect(out.verifyCalls).toBe(1);
    expect(out.efforts.length).toBe(3);
  });

  test("does not escalate reasoning effort", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, verifyResults: [TIMEOUT] });
    expect(out.incidents).not.toContain("loop.effort_latched");
    expect(out.incidents).not.toContain("loop.verification_failed");
    expect(out.incidents).toContain("loop.verification_inconclusive");
  });

  test("the controller is not asked: no decision row is written for it", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, verifyResults: [TIMEOUT] });
    expect(out.decisions).toEqual([]);
  });

  test("says what happened: inconclusive on the event, in the state, and to the reader", async () => {
    const out = await runLoop({ script: WRITE_RUN_FINISH, authority, verifyResults: [TIMEOUT] });
    expect(out.completed.length).toBe(1);
    const event = out.completed[0]!;
    expect(event.status).toBe("inconclusive");
    expect(event.reason).toBe("timeout");
    // The pair a pre-`status` client reads: not a pass, and not a verdict.
    expect(event.passed).toBe(false);
    expect(event.ran).toBe(false);

    const state = out.taskState.snapshot();
    expect(state.verification.status).toBe("inconclusive");
    expect(state.verification.reason).toBe("timeout");
    // A killed command is not a red check in the audit trail.
    expect((state.checks ?? []).filter((c) => c.source === "harness")).toEqual([]);
    expect(out.taskState.renderBlock()).toContain("Verification: inconclusive");
    expect(out.taskState.renderBlock()).not.toContain("Verification: failed");

    expect(out.notices.some((n) => n.includes("time limit") && n.includes("unverified"))).toBe(
      true,
    );
  });

  test("a pre-`status` verifier's timeout is read the same way", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      verifyResults: [LEGACY_TIMEOUT],
    });
    expect(out.repairs).toEqual([]);
    expect(out.completed[0]!.status).toBe("inconclusive");
    expect(out.completed[0]!.reason).toBe("timeout");
  });
});

// ─── I2 — a real failure is still repaired, and still bounded ───

describe.each(AUTHORITIES)("I2 — a check that ran and went red (%s)", (_label, authority) => {
  const EDIT_THEN_FIX: Step[] = [
    { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "x" } },
    { kind: "tool", tool: "bash", args: { command: "bun test src/parser.test.ts" } },
    { kind: "text", text: "done" },
    { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "y" } },
    { kind: "text", text: "fixed" },
  ];

  test("gets one repair turn naming the output, then passes", async () => {
    const out = await runLoop({ script: EDIT_THEN_FIX, authority, verifyResults: [RED, GREEN] });
    expect(out.repairs.length).toBe(1);
    expect(out.repairs[0]).toContain("parses a nested list");
    expect(out.completed.map((e) => e.status)).toEqual(["failed", "passed"]);
    expect(out.incidents).toContain("loop.verification_failed");
    expect(out.incidents).toContain("loop.effort_latched");
    expect(out.taskState.snapshot().verification.status).toBe("passed");
    expect(out.stopReason).toBe("end_turn");
  });

  test("a red check followed by a timeout: the timeout buys nothing further", async () => {
    const out = await runLoop({ script: EDIT_THEN_FIX, authority, verifyResults: [RED, TIMEOUT] });
    // The red check bought its repair. The re-verify did not finish, and that
    // is not a second failure: no second repair and no replan on a failure
    // nobody confirmed.
    expect(out.repairs.length).toBe(1);
    expect(out.replans).toEqual([]);
    expect(out.completed.map((e) => e.status)).toEqual(["failed", "inconclusive"]);
    expect(out.taskState.snapshot().verification.status).toBe("inconclusive");
    expect(out.stopReason).toBe("end_turn");
  });
});

// ─── I3 / I4 — the other inconclusive shapes ───

describe.each(AUTHORITIES)("I3/I4 — no verdict by other routes (%s)", (_label, authority) => {
  test("I3 — a pass followed by a timeout is inconclusive; the pass is kept as evidence", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      verifyResults: [PASS_THEN_TIMEOUT],
    });
    expect(out.repairs).toEqual([]);
    expect(out.completed[0]!.status).toBe("inconclusive");
    const state = out.taskState.snapshot();
    expect(state.verification.status).toBe("inconclusive");
    // The command that finished is on the record as green; the killed one is
    // on the record as nothing.
    expect(
      (state.checks ?? []).filter((c) => c.source === "harness").map((c) => [c.command, c.passed]),
    ).toEqual([["bun run typecheck", true]]);
    expect(state.log?.at(-1)?.text ?? "").toContain("did not finish: bun run test");
  });

  test("I4 — every check skipped: unavailable, no repair, and no word about a time limit", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      verifyResults: [ALL_SKIPPED],
    });
    expect(out.repairs).toEqual([]);
    expect(out.completed[0]!.status).toBe("inconclusive");
    expect(out.completed[0]!.reason).toBe("missing_runner");
    expect(out.completed[0]!.passed).toBe(false);
    const state = out.taskState.snapshot();
    expect(state.verification.status).toBe("unavailable");
    expect(state.verification.reason).toBe("missing_runner");
    expect(out.notices.some((n) => n.includes("time limit"))).toBe(false);
    expect(out.incidents).not.toContain("loop.verification_inconclusive");
    expect(out.stopReason).toBe("end_turn");
  });
});

// ─── I5 — cancellation ───

describe.each(AUTHORITIES)("I5 — a cancelled run (%s)", (_label, authority) => {
  test("cancelled inside verification: no repair, and nothing is recorded as failed", async () => {
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority,
      verifyResults: [CANCELLED],
      abortInVerify: 1,
    });
    expect(out.repairs).toEqual([]);
    expect(out.completed[0]!.status).toBe("inconclusive");
    expect(out.completed[0]!.reason).toBe("cancelled");
    const state = out.taskState.snapshot();
    expect(state.verification.status).toBe("inconclusive");
    expect(state.verification.reason).toBe("cancelled");
    expect((state.checks ?? []).filter((c) => !c.passed)).toEqual([]);
    expect(out.incidents).not.toContain("loop.verification_failed");
    expect(out.incidents).not.toContain("loop.effort_latched");
    // Cancellation wins: the run ends as aborted, not as though it were done.
    expect(out.stopReason).toBe("aborted");
  });

  test("cancelled before the finish: verification is not started at all", async () => {
    const efforts: string[] = [];
    const controller = new AbortController();
    let verifyCalls = 0;
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 12,
        systemPrompt: "s",
        verifier: {
          verify: async () => {
            verifyCalls++;
            return RED;
          },
        },
        controller: { runId: "run#1", authority: new Set(authority) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      makeGateway(WRITE_RUN_FINISH, efforts),
      {
        ...makeRegistry(),
        // The run is cancelled while the model's own command is executing.
        execute: async (input: { toolName: string; callId: string }) => {
          if (input.toolName === "bash") controller.abort();
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: "ok",
            durationMs: 1,
          };
        },
      },
      async () => ({ allowed: true }),
    );
    const events: AgentTurnEvent[] = [];
    for await (const e of loop.run("add the parser", "s1", "/tmp", controller.signal))
      events.push(e);
    expect(verifyCalls).toBe(0);
    expect(events.some((e) => e.type === "verification_completed")).toBe(false);
  });
});

// ─── A different gate, on purpose ───

describe("the execution-evidence gate is a separate question", () => {
  test("a timeout with nothing EVER executed is still asked for one real run — by that gate, not as a repair", async () => {
    const out = await runLoop({
      script: [
        { kind: "tool", tool: "write_file", args: { path: "src/parser.ts", content: "x" } },
        { kind: "text", text: "done" },
        { kind: "tool", tool: "bash", args: { command: "bun test src/parser.test.ts" } },
        { kind: "text", text: "ran it" },
      ],
      authority: [],
      verifyResults: [TIMEOUT],
    });
    // Not a repair: nothing told the model its work had failed.
    expect(out.repairs).toEqual([]);
    expect(out.incidents).not.toContain("loop.verification_failed");
    // The run wrote files and no command — the harness's or the model's —
    // ever finished. That is the evidence gate's case, unchanged by V2.
    expect(out.incidents).toContain("loop.evidence_gate");
    expect(out.harnessNotes.some((t) => t.includes("never executed anything"))).toBe(true);
  });
});

// ─── I6 — one event, one story ───

describe("I6 — every surface says the same thing about one verification", () => {
  function tui(event: AgentTurnEvent): string {
    const commits: string[] = [];
    const sink: TurnSink = { commit: (block) => commits.push(block), preview: () => {} };
    const turn = new TurnRenderer(sink, { getCost: () => 0 });
    turn.onEvent({ type: "verification_started", attempt: 1 });
    turn.onEvent(event);
    turn.onEvent({ type: "text_delta", text: "Done." });
    turn.finish();
    return stripAnsi(commits.join("\n"));
  }
  const acp = (event: AgentTurnEvent): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (toUpdate(event as any)?.content as { text?: string } | undefined)?.text ?? "";
  const child = (event: AgentTurnEvent): string => projectChildEvent("w1", event) ?? "";

  const timeoutEvent: AgentTurnEvent = {
    type: "verification_completed",
    attempt: 1,
    status: "inconclusive",
    reason: "timeout",
    ran: false,
    passed: false,
    report: "$ bun run test\n[timed out after 120000ms — nothing was measured]",
  };

  test("a timeout: the terminal, the editor stream and the parent's row all say it did not finish", () => {
    const phrase = describeVerification(verificationOutcome(timeoutEvent));
    expect(phrase).toBe("did not finish (timed out)");
    for (const said of [tui(timeoutEvent), acp(timeoutEvent), child(timeoutEvent)]) {
      expect(said).toContain(phrase);
      expect(said).not.toMatch(/FAILED|checks fail|checks failed|✗/);
      expect(said).not.toMatch(/checks passed|verification: passed|✓ check/);
    }
  });

  test("the headless stream carries the event as the loop wrote it — status and all", async () => {
    // `--stream-json` writes each event verbatim, so what a machine consumer
    // reads is exactly what the loop yields.
    const out = await runLoop({
      script: WRITE_RUN_FINISH,
      authority: [],
      verifyResults: [TIMEOUT],
    });
    const wire = JSON.parse(JSON.stringify(out.completed[0]!));
    expect(verificationOutcome(wire)).toEqual({ status: "inconclusive", reason: "timeout" });
    expect(describeVerification(verificationOutcome(wire))).toBe("did not finish (timed out)");
  });

  test.each([
    ["passed", { status: "passed", ran: true, passed: true }, /passed/, /FAILED|did not finish/],
    ["failed", { status: "failed", ran: true, passed: false }, /FAILED|failed/, /did not finish/],
  ] as const)("a %s verification is still said plainly", (_name, fields, says, never) => {
    const event = {
      type: "verification_completed",
      attempt: 1,
      report: "$ bun run test  (exit 1)\n1 fail",
      ...fields,
    } as AgentTurnEvent;
    for (const said of [acp(event), child(event)]) {
      expect(said).toMatch(says);
      expect(said).not.toMatch(never);
    }
  });

  test("an event from before `status` existed is read as it always was", () => {
    const legacy = (ran: boolean, passed: boolean) =>
      ({ type: "verification_completed", attempt: 1, ran, passed, report: "r" }) as AgentTurnEvent;
    expect(acp(legacy(true, true))).toContain("verification: passed");
    expect(acp(legacy(true, false))).toContain("verification: FAILED");
    expect(acp(legacy(false, true))).toContain("nothing runnable detected");
    expect(child(legacy(true, true))).toContain("checks passed");
    expect(child(legacy(true, false))).toContain("checks failed");
    // The one that used to be wrong: nothing ran, and the parent was told
    // "checks passed".
    expect(child(legacy(false, true))).not.toContain("checks passed");
  });
});
