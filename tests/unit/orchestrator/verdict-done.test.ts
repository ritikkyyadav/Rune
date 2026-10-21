/**
 * `done` (A3): a run that finished, broke nothing it was held to and left the
 * project's own checks green says so — short of `met`, which still needs every
 * criterion shown. Measured 2026-10-21 on fourteen live runs: every one that
 * did its work ended `unmet` ("no criteria stated") or `partial` ("no check
 * bound"), and the project's checks had passed on the final tree in thirteen.
 *
 * Every line of the rule has a test that breaks if the line goes, and every
 * refusal has one that breaks if `done` starts reaching it.
 */

import { describe, expect, mock, test } from "bun:test";
import type { Criterion } from "../../../packages/protocol/src/index";
import type { CheckRun } from "../../../packages/orchestrator/src/brief";
import {
  computeVerdict,
  verdictLine,
  type FinalProjectChecks,
} from "../../../packages/orchestrator/src/contract";
import { unfinishedVerdict, verdictShortfall } from "../../../packages/orchestrator/src/headless";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";

const HEAD = "4a91c2ee0000000000000000000000000000beef";
const DIGEST = "d16e57a10c9b2f40";
const NOW = { head: HEAD, dirty: false, digest: DIGEST };
const GREEN: FinalProjectChecks = {
  commands: ["bun run typecheck", "bun run test"],
  preexisting: [],
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

describe("done: the run finished and the project's checks passed on the tree it left", () => {
  test("no criteria stated: done, where it was `unmet`", () => {
    const v = verdictOf([]);
    expect(v.kind).toBe("done");
    if (v.kind !== "done") return;
    expect(v.checks).toEqual(["bun run typecheck", "bun run test"]);
    expect(v.unshown).toEqual([]);
    expect(verdictLine(v)).toBe(
      "[verdict] done — the project's checks passed on the final tree (`bun run typecheck`, `bun run test`); no criteria stated",
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
      },
    });
    expect(v.kind).toBe("done");
    if (v.kind !== "done") return;
    expect(v.preexisting).toEqual(["bun run test"]);
    expect(verdictLine(v)).toBe(
      "[verdict] done — the project's checks found nothing this run broke (`bun run typecheck`, `bun run test`); already failing before the run: `bun run test`; no criteria stated",
    );
  });

  test("a finished run is not an unfinished one: no error, no shortfall", () => {
    const v = verdictOf([own("a")]);
    expect(v.kind).toBe("done");
    expect(unfinishedVerdict(v, ["src/a.ts"])).toBeUndefined();
    expect(verdictShortfall(v)).toBeUndefined();
  });
});

describe("done is refused: the verdict stays what it was", () => {
  const cases: Array<[string, Criterion[], Parameters<typeof verdictOf>[1]]> = [
    ["the end-of-turn check did not pass on the final tree", [], { projectChecks: null }],
    ["it passed on no command at all", [], { projectChecks: { commands: [], preexisting: [] } }],
    ["the run did not end on its own", [], { stopReason: "max_turns" }],
    ["the run wrote nothing", [], { wrote: false, shape: "fix" }],
    ["a planned step is open", [own("a")], { openSteps: 1 }],
    ["a check is red and it is the run's", [], { checks: [red("bun run lint")] }],
    [
      "a check is red, and it is not the one that was red before",
      [],
      {
        checks: [red("bun run lint")],
        projectChecks: { commands: ["bun run test"], preexisting: ["bun run test"] },
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

// ─── The loop: what the end-of-turn check leaves the verdict ───

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

async function finalVerdict(turns: Step[], results: VerifyResult[], checks: CheckRun[] = []) {
  let call = 0;
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 20,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
      verifier: { verify: mock(async () => results[Math.min(call++, results.length - 1)]!) },
      contractRecord: () => ({ criteria: [], checks, wrote: true }),
    } as any,
    makeGateway(turns),
    makeRegistry(),
  );
  const events: AgentTurnEvent[] = [];
  for await (const event of loop.run("add the handler", "s1", "/tmp")) events.push(event);
  const complete = events.filter((e) => e.type === "turn_complete").at(-1) as
    { verdict?: { kind: string } } | undefined;
  return complete?.verdict?.kind;
}

describe("the loop hands the verdict the end-of-turn check", () => {
  test("a write, then the checks pass: done", async () => {
    expect(await finalVerdict([WRITE, { text: "done" }], [PASSED])).toBe("done");
  });

  test("the checks go red on the run's own failure: not done", async () => {
    const RED: VerifyResult = {
      status: "failed",
      passed: false,
      ran: true,
      report: "$ bun run test  (exit 1)",
      runs: [{ command: "bun run test", exitCode: 1, durationMs: 5, passed: false }],
    };
    expect(await finalVerdict([WRITE, { text: "done" }, { text: "done" }], [RED])).not.toBe("done");
  });

  test("red only on failures that were there before the run: done", async () => {
    // The end-of-turn check writes its red run into the check log, as the
    // engine's verifier does; the loop's reading of the attribution is what
    // lets the verdict set it aside.
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
    expect(await finalVerdict([WRITE, { text: "done" }], [before([])], log)).toBe("done");
    expect(
      await finalVerdict(
        [WRITE, { text: "done" }, { text: "done" }],
        [before(["handler > adds"])],
        log,
      ),
    ).not.toBe("done");
  });

  test("the checks could not finish: not done", async () => {
    const SLOW: VerifyResult = {
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
    expect(await finalVerdict([WRITE, { text: "done" }, { text: "done" }], [SLOW])).not.toBe(
      "done",
    );
  });

  test("a shell command after the checks passed: not done — it may have changed a file", async () => {
    // The checks pass on the first finish; the second finish comes after a
    // shell command the verdict cannot see into.
    const plan = (status: string): Step => ({
      tool: "todo_write",
      args: { items: [{ content: "add the handler", status }] },
    });
    const turns: Step[] = [
      plan("in_progress"),
      WRITE,
      { text: "done" },
      { tool: "bash", args: { command: "node scripts/gen.mjs" } },
      plan("completed"),
      { text: "done" },
    ];
    const without: Step[] = [
      plan("in_progress"),
      WRITE,
      { text: "done" },
      plan("completed"),
      { text: "done" },
    ];
    expect(await finalVerdict(without, [PASSED])).toBe("done");
    expect(await finalVerdict(turns, [PASSED])).not.toBe("done");
  });
});
