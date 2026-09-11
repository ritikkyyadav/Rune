/**
 * A2 — a citation that arrived one completion late.
 *
 * `RECORD_EVIDENCE_SCHEMA` tells the model to put the citation in the SAME
 * response as its check, and the loop keeps that promise: serial calls are a
 * barrier, so `bash` then `record_evidence` in one response cites a check
 * already on record and costs no extra turn. A model that runs the check,
 * reads the result, and cites it on the NEXT completion gets an identical
 * verdict and pays a whole completion for it — 21.3% of pilot J's list cost
 * was plan bookkeeping of that shape (`docs/program/phase-3-auto-efficiency.md`
 * §2.2).
 *
 * The loop now recognises that batch after the fact and gives the turn back,
 * through the same `TurnRefunds` cap every gate refund uses. What it must NOT
 * do is give the turn back for a batch that did anything else, cite a check
 * that is not the previous completion's, or move any verdict.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string; calls?: Step[] };

/** One completion per entry; `calls` makes a multi-call response. */
function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    calls: () => i,
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      const batch = t.calls ?? (t.tool ? [t] : []);
      if (batch.length > 0) {
        let n = 0;
        for (const call of batch) {
          const id = `c${i}_${++n}`;
          yield ev("tool_use_start", { toolCallId: id, toolName: call.tool });
          yield ev("tool_use_stop", { toolCallId: id, toolInput: call.args ?? {} });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
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
        category: ["write_file", "edit_file", "multi_edit"].includes(name) ? "write" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "bash"
          ? JSON.stringify({ exit_code: 0, stdout: "44 pass", stderr: "" })
          : input.toolName === "record_evidence"
            ? "Recorded as observed."
            : "ok",
      durationMs: 1,
    })),
  } as any;
}

interface Run {
  loop: AgentLoop;
  gw: ReturnType<typeof makeGateway>;
  incidents: string[];
  maxTurns: () => number;
}

function build(turns: Step[], maxTurns = 12): Run {
  const incidents: string[] = [];
  const config: Record<string, unknown> = {
    model: "m",
    provider: "anthropic",
    maxTokens: 100,
    maxTurns,
    systemPrompt: "s",
    effortRouting: "off",
    taskState: new TaskStateStore(),
    onIncident: (i: { class: string }) => incidents.push(i.class),
  };
  const gw = makeGateway(turns);
  // The loop copies its config, so the ceiling a refund moves is the loop's
  // own — read it there, not from the object handed in.
  const loop = new AgentLoop(config as never, gw, makeRegistry());
  return {
    loop,
    gw,
    incidents,
    maxTurns: () => (loop as unknown as { config: { maxTurns: number } }).config.maxTurns,
  };
}

const CHECK: Step = { tool: "bash", args: { command: "bun test" } };
const CITE: Step = { tool: "record_evidence", args: { criterion: 0, command: "bun test" } };
const DONE: Step = { text: "Checked and reported." };

describe("A2 — a lone citation for the previous completion's check", () => {
  test("is carried forward, and the turn it spent is given back", async () => {
    const run = build([CHECK, CITE, DONE]);
    const before = run.maxTurns();
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).toContain("loop.citation_carried_forward");
    // The refund rides the loop's own incident funnel, so the ceiling moves by
    // exactly one and says so.
    expect(run.incidents).toContain("loop.turn_refunded");
    expect(run.maxTurns()).toBe(before + 1);
  });

  test("a citation in the SAME response as its check is untouched", async () => {
    // It never cost a turn, so there is nothing to give back. This is the path
    // the schema asks for and the one A2 must not disturb.
    const run = build([{ calls: [CHECK, CITE] }, DONE]);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.citation_carried_forward");
  });

  test("a citation two completions after its check is not carried forward", async () => {
    // "The previous completion" is the whole claim. A citation the model got
    // round to later is an ordinary bookkeeping turn.
    const run = build([CHECK, { tool: "read_file", args: { path: "src/csv.ts" } }, CITE, DONE]);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.citation_carried_forward");
  });

  test("a citation that rides with real work is not carried forward", async () => {
    // The completion did something else too, so it was not spent on the gap
    // between "same response" and "next response".
    const run = build([
      CHECK,
      { calls: [CITE, { tool: "write_file", args: { path: "src/csv.ts", content: "x" } }] },
      DONE,
    ]);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.citation_carried_forward");
  });

  test("a citation for a command that never ran is not carried forward", async () => {
    const run = build([
      CHECK,
      { tool: "record_evidence", args: { criterion: 0, command: "bun test tests/other.test.ts" } },
      DONE,
    ]);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.citation_carried_forward");
  });

  test("a check that FAILED cannot be carried forward", async () => {
    // The verdict is the exit code's, not the tool's. A red check is not
    // evidence and a citation for it is an ordinary turn (the ledger refuses
    // it separately).
    const run = build([
      { tool: "bash", args: { command: "bun test failing" } },
      { tool: "record_evidence", args: { criterion: 0, command: "bun test failing" } },
      DONE,
    ]);
    // The registry above always exits 0, so red is scripted by hand here.
    (run.loop as unknown as { registry: { execute: unknown } }).registry.execute = mock(
      async (input: { toolName: string; callId: string }) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result:
          input.toolName === "bash"
            ? JSON.stringify({ exit_code: 1, stdout: "", stderr: "1 fail" })
            : "ok",
        durationMs: 1,
      }),
    );
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.citation_carried_forward");
  });

  test("the refund is bounded by the same cap every gate refund uses", async () => {
    // Ten check/cite pairs against a base ceiling of 8: the cap is a quarter of
    // the base (2), so the ceiling can move by 2 and no further, however many
    // citations arrive late.
    const pairs: Step[] = [];
    for (let i = 0; i < 10; i++) {
      pairs.push({ tool: "bash", args: { command: `bun test tests/${i}.test.ts` } });
      pairs.push({
        tool: "record_evidence",
        args: { criterion: i, command: `bun test tests/${i}.test.ts` },
      });
    }
    const run = build(pairs, 8);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.maxTurns()).toBeLessThanOrEqual(8 + 2);
  });

  test("a lone citation does not read as a single-READ turn", async () => {
    // `record_evidence` is read-CATEGORY and is not reading. Counting it made
    // the check/cite rhythm the plan asks for look like a serial crawl, so a
    // run doing exactly what it was told earned a batching note on top of the
    // completion the citation already cost.
    const run = build([CITE, CITE, CITE, CITE, CITE, DONE]);
    await collect(run.loop.run("prove the parser round-trips", "s1", "/tmp"));
    expect(run.incidents).not.toContain("loop.batch_nudge");
  });
});
