/**
 * `done` (A3): a run that finished, broke nothing it was held to, left the
 * project's own checks green, and did every ask of the person's request — the
 * request check read the change against it and found each one — says so,
 * short of `met`, which still needs every criterion shown.
 *
 * Measured 2026-10-21: on fourteen live runs every one that did its work ended
 * `unmet` or `partial`. A `done` resting on the checks alone then called 19 of
 * 44 wrong or half-done corpus runs finished; the request check is the answer
 * the founder chose.
 *
 * Every line of the rule has a test that breaks if the line goes, and every
 * refusal has one that breaks if `done` starts reaching it.
 */

import { describe, expect, mock, test } from "bun:test";
import type { Criterion } from "../../../packages/protocol/src/index";
import type { CheckRun } from "../../../packages/orchestrator/src/brief";
import {
  REQUEST_GAP,
  computeVerdict,
  verdictLine,
  type FinalProjectChecks,
} from "../../../packages/orchestrator/src/contract";
import { unfinishedVerdict, verdictShortfall } from "../../../packages/orchestrator/src/headless";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { RequestCheckResult } from "../../../packages/orchestrator/src/request-check";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";

const HEAD = "4a91c2ee0000000000000000000000000000beef";
const DIGEST = "d16e57a10c9b2f40";
const NOW = { head: HEAD, dirty: false, digest: DIGEST };
const ALL_FOUND = { asks: 3, missing: [] };
const GREEN: FinalProjectChecks = {
  commands: ["bun run typecheck", "bun run test"],
  preexisting: [],
  request: ALL_FOUND,
};

function verdictOf(
  criteria: Criterion[],
  over: {
    checks?: CheckRun[];
    openSteps?: number;
    wrote?: boolean;
    stopReason?: string;
    projectChecks?: FinalProjectChecks | null;
    shape?: "fix" | "feature" | "question";
  } = {},
) {
  const projectChecks = over.projectChecks === undefined ? GREEN : over.projectChecks;
  return computeVerdict({
    criteria,
    checks: over.checks ?? [],
    openSteps: over.openSteps ?? 0,
    totalSteps: over.openSteps ?? 0,
    stopReason: over.stopReason ?? "end_turn",
    wrote: over.wrote ?? true,
    revision: NOW,
    ...(over.shape ? { shape: over.shape } : {}),
    ...(projectChecks ? { projectChecks } : {}),
  });
}

const stamp = { head: HEAD, dirty: false, digest: DIGEST };
/** A criterion the run wrote for itself, with nothing bound to it. */
const own = (text: string, extra: Partial<Criterion> = {}): Criterion => ({
  text,
  rung: null,
  source: "inferred",
  ...extra,
});
/** Shown: a check the run did not write passed for it, on this tree. */
const shown = (text: string) =>
  own(text, {
    evidence: {
      source: "bun test old.test.ts",
      verifier: "check-log@1",
      result: "passed",
      ...stamp,
    },
  });
/** Its only evidence a test the run itself wrote: `needs_review`. */
const ownTest = (text: string) =>
  own(text, {
    evidence: {
      source: "bun test new.test.ts",
      verifier: "self-authored-check@1",
      result: "passed",
      ...stamp,
    },
  });
const red = (command: string): CheckRun => ({ command, passed: false, at: 1, kind: "check" });
const missingOne = {
  asks: 3,
  missing: [{ ask: "update the changelog", why: "CHANGELOG.md is not in the change" }],
};

describe("done: finished, checks green, every ask of the request found", () => {
  test("no criteria stated: done, where it was `unmet`", () => {
    const v = verdictOf([]);
    expect(v.kind).toBe("done");
    if (v.kind !== "done") return;
    expect(v.checks).toEqual(["bun run typecheck", "bun run test"]);
    expect(v.unshown).toEqual([]);
    expect(v.requestAsks).toBe(3);
    expect(verdictLine(v)).toBe(
      "[verdict] done — the project's checks passed on the final tree (`bun run typecheck`, `bun run test`); all 3 asks of the request found in the change; no criteria stated",
    );
  });

  test("its own criteria, not each shown: done, and the ones not shown are named", () => {
    const v = verdictOf([
      own("the header shows the version"),
      ownTest("ids resolve"),
      shown("old"),
    ]);
    expect(v.kind).toBe("done");
    if (v.kind !== "done") return;
    expect(v.unshown).toEqual(["the header shows the version", "ids resolve"]);
    expect(verdictLine(v)).toContain("; 2 of 3 criteria not shown one by one");
  });

  test("every criterion shown: still `met`, not `done`", () => {
    expect(verdictOf([shown("a"), shown("b")]).kind).toBe("met");
  });

  test("a check red only on failures that were there before the run: done, and said so", () => {
    const v = verdictOf([], {
      checks: [red("bun run test")],
      projectChecks: {
        commands: ["bun run typecheck", "bun run test"],
        preexisting: ["bun run test"],
        request: { asks: 1, missing: [] },
      },
    });
    expect(v.kind).toBe("done");
    if (v.kind !== "done") return;
    expect(v.preexisting).toEqual(["bun run test"]);
    expect(verdictLine(v)).toBe(
      "[verdict] done — the project's checks found nothing this run broke (`bun run typecheck`, `bun run test`); all 1 ask of the request found in the change; already failing before the run: `bun run test`; no criteria stated",
    );
  });

  test("a finished run is not an unfinished one: no error, no shortfall", () => {
    const v = verdictOf([own("a")]);
    expect(v.kind).toBe("done");
    expect(unfinishedVerdict(v, ["src/a.ts"])).toBeUndefined();
    expect(verdictShortfall(v)).toBeUndefined();
  });
});

describe("the request check decides between done and a named gap", () => {
  test("not run: no done — the checks alone are not enough", () => {
    const { request: _request, ...checksOnly } = GREEN;
    expect(verdictOf([], { projectChecks: checksOnly }).kind).toBe("unmet");
    expect(verdictOf([own("a")], { projectChecks: checksOnly }).kind).not.toBe("done");
  });

  test("it found no asks at all: no done", () => {
    expect(
      verdictOf([], { projectChecks: { ...GREEN, request: { asks: 0, missing: [] } } }).kind,
    ).not.toBe("done");
  });

  test("an ask not found: partial, with the ask named — no criteria stated", () => {
    const v = verdictOf([], { projectChecks: { ...GREEN, request: missingOne } });
    expect(v.kind).toBe("partial");
    if (v.kind !== "partial") return;
    expect(v.gaps).toEqual([
      {
        criterion: REQUEST_GAP,
        why: "not done: update the changelog — CHANGELOG.md is not in the change",
      },
    ]);
    expect(verdictShortfall(v)).toBe(undefined); // no criteria: nothing promised (headless rule)
  });

  test("an ask not found beside the run's own criteria: partial, gap named, seen to fall short", () => {
    const v = verdictOf([own("a")], { projectChecks: { ...GREEN, request: missingOne } });
    expect(v.kind).toBe("partial");
    if (v.kind !== "partial") return;
    expect(v.gaps.some((g) => g.criterion === REQUEST_GAP)).toBe(true);
    expect(verdictShortfall(v)).toBe("observed_failure");
  });

  test("an ask not found stops even `met`: every criterion shown is not every ask done", () => {
    const v = verdictOf([shown("a")], { projectChecks: { ...GREEN, request: missingOne } });
    expect(v.kind).toBe("partial");
  });
});

describe("done is refused: the verdict stays what it was", () => {
  const cases: Array<[string, Criterion[], Parameters<typeof verdictOf>[1]]> = [
    ["the end-of-turn check did not pass on the final tree", [], { projectChecks: null }],
    [
      "it passed on no command at all",
      [],
      { projectChecks: { commands: [], preexisting: [], request: ALL_FOUND } },
    ],
    ["the run did not end on its own", [], { stopReason: "max_turns" }],
    ["the run wrote nothing", [], { wrote: false, shape: "fix" }],
    ["a planned step is open", [own("a")], { openSteps: 1 }],
    ["a check is red and it is the run's", [], { checks: [red("bun run lint")] }],
    [
      "a check is red, and it is not the one that was red before",
      [],
      {
        checks: [red("bun run lint")],
        projectChecks: {
          commands: ["bun run test"],
          preexisting: ["bun run test"],
          request: ALL_FOUND,
        },
      },
    ],
    ["a criterion is the person's", [{ text: "export every row", rung: null, source: "user" }], {}],
    [
      "a criterion is an --acceptance check",
      [{ text: "exit 0", rung: null, source: "evaluator" }],
      {},
    ],
    [
      "a criterion only a person can settle",
      [own("looks right", { method: { kind: "review" } })],
      {},
    ],
    [
      "a criterion failed",
      [
        own("a", {
          evidence: {
            source: "bun test a.test.ts",
            verifier: "check-log@1",
            result: "failed",
            ...stamp,
          },
        }),
      ],
      {},
    ],
    [
      "a criterion went stale",
      [
        own("a", {
          evidence: {
            source: "bun test a.test.ts",
            verifier: "check-log@1",
            result: "passed",
            head: "0000000000000000000000000000000000000000",
            dirty: false,
          },
        }),
      ],
      {},
    ],
  ];
  for (const [why, criteria, over] of cases) {
    test(why, () => {
      expect(verdictOf(criteria, over).kind).not.toBe("done");
    });
  }

  test("without the final checks, every verdict is what it always was", () => {
    expect(verdictOf([], { projectChecks: null })).toMatchObject({
      kind: "unmet",
      missing: ["no criteria stated"],
    });
    expect(verdictOf([own("a")], { projectChecks: null }).kind).toBe("unmet");
    expect(verdictOf([own("a"), shown("b")], { projectChecks: null }).kind).toBe("partial");
    expect(verdictOf([], { wrote: false, shape: "question", projectChecks: null }).kind).toBe(
      "none",
    );
  });
});

// ─── The loop: the end-of-turn check, then the request check ───

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tool) {
        yield { type: "tool_use_start", toolCallId: `c${i}`, toolName: t.tool };
        yield { type: "tool_use_stop", toolCallId: `c${i}`, toolInput: t.args ?? {} };
        yield { type: "message_stop", stopReason: "tool_use" };
      } else {
        yield { type: "content_delta", delta: { type: "text_delta", text: t.text ?? "done" } };
        yield { type: "message_stop", stopReason: "end_turn" };
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : input.toolName === "bash"
            ? JSON.stringify({ stdout: "ok", exitCode: 0 })
            : "ok",
      durationMs: 1,
    })),
  } as any;
}

const WRITE: Step = { tool: "write_file", args: { path: "src/h.ts", content: "x" } };
const PASSED: VerifyResult = {
  status: "passed",
  passed: true,
  ran: true,
  report: "$ bun run test  (ok)",
  runs: [{ command: "bun run test", exitCode: 0, durationMs: 5, passed: true }],
};
const FOUND: RequestCheckResult = { outcome: { asks: 2, missing: [] } };
const MISSING: RequestCheckResult = {
  outcome: { asks: 2, missing: [{ ask: "update the changelog", why: "not in the change" }] },
};

async function runLoop(
  turns: Step[],
  opts: {
    results?: VerifyResult[];
    checks?: CheckRun[];
    requestAnswers?: RequestCheckResult[];
  } = {},
) {
  let verifyCall = 0;
  let requestCall = 0;
  const results = opts.results ?? [PASSED];
  const requestAnswers = opts.requestAnswers ?? [FOUND];
  const requestCheck = mock(
    async () => requestAnswers[Math.min(requestCall++, requestAnswers.length - 1)]!,
  );
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 20,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
      verifier: {
        verify: mock(async () => results[Math.min(verifyCall++, results.length - 1)]!),
      },
      contractRecord: () => ({ criteria: [], checks: opts.checks ?? [], wrote: true }),
      requestCheck,
    } as any,
    makeGateway(turns),
    makeRegistry(),
  );
  const events: AgentTurnEvent[] = [];
  for await (const event of loop.run("add the handler", "s1", "/tmp")) events.push(event);
  const complete = events.filter((e) => e.type === "turn_complete").at(-1) as
    { verdict?: { kind: string; gaps?: Array<{ criterion: string; why: string }> } } | undefined;
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e as { message: string }).message);
  return { verdict: complete?.verdict, notices, requestCalls: requestCheck.mock.calls.length };
}

describe("the loop: the end-of-turn check, then the request check", () => {
  test("a write, the checks pass, every ask found: done", async () => {
    const r = await runLoop([WRITE, { text: "done" }]);
    expect(r.verdict?.kind).toBe("done");
    expect(r.requestCalls).toBe(1);
  });

  test("an ask not found: one re-prompt naming it; finished on the second try: done", async () => {
    const r = await runLoop([WRITE, { text: "done" }, WRITE, { text: "done" }], {
      requestAnswers: [MISSING, FOUND],
    });
    expect(r.notices).toContain(
      "The request check found 1 part of the request not done — asking once to finish it.",
    );
    expect(r.requestCalls).toBe(2);
    expect(r.verdict?.kind).toBe("done");
  });

  test("still not found after the one re-prompt: partial, the ask named", async () => {
    const r = await runLoop([WRITE, { text: "done" }, WRITE, { text: "done" }, { text: "done" }], {
      requestAnswers: [MISSING, MISSING],
    });
    expect(r.notices.filter((n) => n.startsWith("The request check found"))).toHaveLength(1);
    expect(r.verdict?.kind).toBe("partial");
    expect(r.verdict?.gaps?.[0]?.criterion).toBe(REQUEST_GAP);
  });

  test("the model answers without changing anything: the gap stands, no second check", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "it is out of scope" }], {
      requestAnswers: [MISSING, FOUND],
    });
    expect(r.requestCalls).toBe(1);
    expect(r.verdict?.kind).toBe("partial");
  });

  test("the check could not say: not done, and no re-prompt", async () => {
    const r = await runLoop([WRITE, { text: "done" }], {
      requestAnswers: [{ skipped: "the checker's answer was not the JSON asked for" }],
    });
    expect(r.verdict?.kind).not.toBe("done");
    expect(r.notices.some((n) => n.startsWith("The request check found"))).toBe(false);
  });

  test("the project's checks went red: the request check is not asked", async () => {
    const RED: VerifyResult = {
      status: "failed",
      passed: false,
      ran: true,
      report: "$ bun run test  (exit 1)",
      runs: [{ command: "bun run test", exitCode: 1, durationMs: 5, passed: false }],
    };
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], { results: [RED] });
    expect(r.requestCalls).toBe(0);
    expect(r.verdict?.kind).not.toBe("done");
  });

  test("red only on failures that were there before the run: checked, and done", async () => {
    const before = (introduced: string[]): VerifyResult => ({
      status: "failed",
      passed: false,
      ran: true,
      report: "$ bun run test  (exit 1)",
      runs: [
        { command: "bun run typecheck", exitCode: 0, durationMs: 5, passed: true },
        { command: "bun run test", exitCode: 1, durationMs: 5, passed: false },
      ],
      attribution: { known: true, existing: ["brand > a build exists"], introduced },
    });
    const log = [red("bun run test")];
    expect(
      (await runLoop([WRITE, { text: "done" }], { results: [before([])], checks: log })).verdict
        ?.kind,
    ).toBe("done");
    expect(
      (
        await runLoop([WRITE, { text: "done" }, { text: "done" }], {
          results: [before(["handler > adds"])],
          checks: log,
        })
      ).verdict?.kind,
    ).not.toBe("done");
  });

  test("the checks could not finish: not done", async () => {
    const SLOW = {
      status: "inconclusive",
      reason: "timeout",
      passed: false,
      ran: false,
      report: "$ bun run test  (timed out)",
      runs: [
        {
          command: "bun run test",
          exitCode: null,
          durationMs: 120_000,
          passed: false,
          timedOut: true,
        },
      ],
    } as VerifyResult;
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], { results: [SLOW] });
    expect(r.verdict?.kind).not.toBe("done");
  });

  test("a shell command after the checks passed: not done — it may have changed a file", async () => {
    const plan = (status: string): Step => ({
      tool: "todo_write",
      args: { items: [{ content: "add the handler", status }] },
    });
    const without: Step[] = [
      plan("in_progress"),
      WRITE,
      { text: "done" },
      plan("completed"),
      { text: "done" },
    ];
    const withShell: Step[] = [
      plan("in_progress"),
      WRITE,
      { text: "done" },
      { tool: "bash", args: { command: "node scripts/gen.mjs" } },
      plan("completed"),
      { text: "done" },
    ];
    expect((await runLoop(without)).verdict?.kind).toBe("done");
    expect((await runLoop(withShell)).verdict?.kind).not.toBe("done");
  });
});

// ─── A suite that cannot finish (2026-10-22) ───
//
// The dogfood run: on Rune's own source the suite takes about 222 s and the
// end-of-turn check stopped it at 120 s, so `done` never came, though the work
// was right and the test files the change touched passed in its place. The
// founder's choice: wait longer, then let `done` rest on that stand-in — named.

const SCOPED = "bun test './tests/unit/a.test.ts' './tests/unit/b.test.ts'";
const STOOD_IN: FinalProjectChecks = {
  commands: ["bun run typecheck", SCOPED, "bun run lint"],
  preexisting: [],
  standIns: [{ unfinished: "bun run test", ranInstead: SCOPED }],
  request: ALL_FOUND,
};

describe("a suite that cannot finish: the test files the change touched stand in, named", () => {
  test("done, and the line says which suite did not finish and what passed in its place", () => {
    const v = verdictOf([], { projectChecks: STOOD_IN });
    expect(v.kind).toBe("done");
    if (v.kind !== "done") throw new Error("unreachable");
    expect(v.standIns).toEqual([{ unfinished: "bun run test", ranInstead: SCOPED }]);
    expect(v.checks).toContain(SCOPED);
    expect(verdictLine(v)).toBe(
      "[verdict] done — the project's checks passed on the final tree " +
        "(`bun run typecheck`, `bun run lint`); `bun run test` did not finish, and the test " +
        "files the change touched passed in its place; all 3 asks of the request found in the " +
        "change; no criteria stated",
    );
  });

  test("the stand-in's own command is never printed as if it were the suite", () => {
    const line = verdictLine(verdictOf([], { projectChecks: STOOD_IN }));
    expect(line).not.toContain("a.test.ts");
  });

  test("nothing finished but the stand-in: the line says that, not 'the project's checks'", () => {
    const only: FinalProjectChecks = { ...STOOD_IN, commands: [SCOPED] };
    const line = verdictLine(verdictOf([], { projectChecks: only }));
    expect(line).toStartWith(
      "[verdict] done — the test files the change touched passed on the final tree; " +
        "`bun run test` did not finish",
    );
  });

  test("every check finished: no stand-in clause", () => {
    const line = verdictLine(verdictOf([], { projectChecks: GREEN }));
    expect(line).not.toContain("did not finish");
    expect(verdictOf([], { projectChecks: GREEN })).not.toHaveProperty("standIns");
  });
});

const TIMED_OUT = {
  command: "bun run test",
  exitCode: null,
  durationMs: 300_000,
  passed: false,
  timedOut: true,
};
const slow = (...after: VerifyResult["runs"] & object): VerifyResult =>
  ({
    status: "inconclusive",
    reason: "timeout",
    passed: false,
    ran: false,
    report: "$ bun run test\n[timed out after 300000ms — nothing was measured]",
    runs: [
      { command: "bun run typecheck", exitCode: 0, durationMs: 900, passed: true },
      TIMED_OUT,
      ...after,
    ],
  }) as VerifyResult;
const standIn = (over: Record<string, unknown> = {}) => ({
  command: SCOPED,
  exitCode: 0,
  durationMs: 4_000,
  passed: true,
  inPlaceOf: "bun run test",
  ...over,
});
const LINT_GREEN = { command: "bun run lint", exitCode: 0, durationMs: 3_000, passed: true };

describe("the loop: a suite that did not finish, and what stood in for it", () => {
  test("stood in for, green, everything after it green: done, the stand-in on the verdict", async () => {
    const r = await runLoop([WRITE, { text: "done" }], {
      results: [slow(standIn(), LINT_GREEN)],
    });
    expect(r.verdict?.kind).toBe("done");
    expect((r.verdict as { standIns?: unknown }).standIns).toEqual([
      { unfinished: "bun run test", ranInstead: SCOPED },
    ]);
    expect(r.requestCalls).toBe(1);
  });

  test("a green check after the suite is no stand-in for it: not done, the request not asked", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(LINT_GREEN)],
    });
    expect(r.verdict?.kind).not.toBe("done");
    expect(r.requestCalls).toBe(0);
  });

  test("a stand-in for some other command: not done", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(standIn({ inPlaceOf: "bun run test:e2e" }))],
    });
    expect(r.verdict?.kind).not.toBe("done");
  });

  test("the stand-in itself did not finish: not done", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(standIn({ passed: false, exitCode: null, timedOut: true }))],
    });
    expect(r.verdict?.kind).not.toBe("done");
  });

  test("two suites did not finish and only one was stood in for: not done", async () => {
    const second = { ...TIMED_OUT, command: "cd 'web' && bun run test" };
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(standIn(), second)],
    });
    expect(r.verdict?.kind).not.toBe("done");
  });

  test("stood in for, but every ask not found: partial, the ask named", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(standIn(), LINT_GREEN)],
      requestAnswers: [MISSING],
    });
    expect(r.verdict?.kind).toBe("partial");
    expect(r.verdict?.gaps?.[0]?.criterion).toBe(REQUEST_GAP);
  });

  test("the notice names what stood in, found by its mark and not by position", async () => {
    const r = await runLoop([WRITE, { text: "done" }, { text: "done" }], {
      results: [slow(LINT_GREEN)],
    });
    const notice = r.notices.find((n) => n.includes("unverified")) ?? "";
    expect(notice).not.toContain("run in its place");
  });
});

// ─── Count only real failures (2026-10-22) ───
//
// The dogfood re-run on 1.4.14: every check passed, the request check found 13
// of 13 asks, and `done` was refused by a test file that was red only inside
// the agent's sandbox — a file the suite that passed on the final tree also ran.

const SUITE: FinalProjectChecks = {
  commands: ["bun run typecheck", "bun run test"],
  preexisting: [],
  testScopes: ["tests/unit"],
  request: ALL_FOUND,
};
const redRun = (command: string): CheckRun => ({ command, passed: false, at: 1, kind: "check" });
const T20 = "bun test tests/unit/probes/t20-background-lifecycle.test.ts";

describe("a red test-file run the final suite covers does not refuse done", () => {
  test("covered: done, and the run is named on the verdict and the line", () => {
    const v = verdictOf([], { projectChecks: SUITE, checks: [redRun(T20)] });
    expect(v.kind).toBe("done");
    if (v.kind !== "done") throw new Error("unreachable");
    expect(v.superseded).toEqual([T20]);
    expect(v).not.toHaveProperty("preexisting");
    expect(verdictLine(v)).toContain(
      "an earlier red test run is covered by the suite that passed (`bun test tests/unit/probes/t20-background-lifecycle.test.ts`)",
    );
  });

  test("outside the suite's scope: not done", () => {
    const v = verdictOf([], {
      projectChecks: SUITE,
      checks: [redRun("bun test tests/integration/x.test.ts")],
    });
    expect(v.kind).not.toBe("done");
  });

  test("no scope known for the suite: not done", () => {
    const v = verdictOf([], {
      projectChecks: { ...SUITE, testScopes: undefined },
      checks: [redRun(T20)],
    });
    expect(v.kind).not.toBe("done");
  });

  test("a red check that is not a test-file run: not done", () => {
    const v = verdictOf([], { projectChecks: SUITE, checks: [redRun("bun run lint")] });
    expect(v.kind).not.toBe("done");
  });

  test("a later green run of the same file needs no covering", () => {
    const v = verdictOf([], {
      projectChecks: SUITE,
      checks: [redRun(T20), { command: T20, passed: true, at: 2, kind: "check" }],
    });
    expect(v.kind).toBe("done");
    expect(v).not.toHaveProperty("superseded");
  });

  test("covered and pre-existing together: done, each named as what it is", () => {
    const v = verdictOf([], {
      projectChecks: { ...SUITE, preexisting: ["bun run e2e"] },
      checks: [redRun(T20), redRun("bun run e2e")],
    });
    expect(v.kind).toBe("done");
    if (v.kind !== "done") throw new Error("unreachable");
    expect(v.superseded).toEqual([T20]);
    expect(v.preexisting).toEqual(["bun run e2e"]);
  });
});
