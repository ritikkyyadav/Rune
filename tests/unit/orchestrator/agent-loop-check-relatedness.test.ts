/**
 * A model-run check closes the step it SPEAKS TO (Lane A2, 2026-09-10).
 *
 * Lane A's first remaining defect: the loop attributed a `bash` check to
 * whichever step was `in_progress`, with nothing comparing the command to
 * that step. So `bun -e 'if (1 + 1 !== 2) throw new Error("math")'` run while
 * a verify step was open closed that step. The harness's own step check has
 * always been scoped to the step's files (`stepCheck(signal,
 * ts.touchedFiles)`); this is the same scope, applied to the model's.
 *
 * A check that is set aside is still executed, still on the check ledger,
 * still counted by the retro, and still counts against the step as a command
 * that RAN — it simply is not that step's proof.
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

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    calls: () => i,
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: t.args ?? {} });
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
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : input.toolName === "bash"
            ? JSON.stringify({
                exit_code: String(input.args.command ?? "").includes("failing") ? 1 : 0,
                stdout: "",
                stderr: String(input.args.command ?? "").includes("failing") ? "1 fail" : "",
              })
            : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, taskState: TaskStateStore) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      effortRouting: "off",
      taskState,
    } as any,
    gateway,
    makeRegistry(),
  );
}

/**
 * Open a step, optionally write `src/csv.ts` under it, run `command`, then
 * try to close it. Returns the store so the ledger can be read.
 *
 * `gate` is the ledger's own knob (`[reliability] evidenceGate`): `attest`,
 * the default, closes an unproven step and says so; `refuse` sends the list
 * back and the step stays open. Relatedness decides what the evidence IS;
 * the gate decides what the ledger does about it, and both are asserted.
 */
async function runWithCheck(
  command: string,
  step: { content: string; kind: "change" | "verify" },
  opts: { write?: boolean; gate?: "attest" | "refuse" } = {},
): Promise<{ ts: TaskStateStore; loop: AgentLoop }> {
  const ts = new TaskStateStore();
  if (opts.gate) ts.setEvidenceGate(opts.gate);
  const steps: Step[] = [
    { tool: "todo_write", args: { items: [{ ...step, status: "in_progress" }] } },
    ...(opts.write === false
      ? []
      : [{ tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } }]),
    { tool: "bash", args: { command } },
    { tool: "todo_write", args: { items: [{ ...step, status: "completed" }] } },
    { text: "Done." },
  ];
  const gw = makeGateway(steps);
  const loop = makeLoop(gw, ts);
  await collect(loop.run("fix parseCsv", "s1", "/tmp"));
  return { ts, loop };
}

const CHANGE = { content: "repair parseCsv", kind: "change" as const };
const VERIFY = { content: "prove parseCsv round-trips", kind: "verify" as const };

describe("a model-run check is attributed only to the step it speaks to", () => {
  test.each([
    ["a whole-suite run", "bun test"],
    ["a file-targeted test naming the touched file's test", "bun test tests/unit/csv.test.ts"],
    ["an inline script requiring the touched module", `node -e "require('./src/csv'); assert(1)"`],
  ])("closes the step: %s", async (_name, command) => {
    const { ts } = await runWithCheck(command, CHANGE);
    const todo = ts.todos[0]!;
    expect(todo.evidence?.lastCheck?.passed).toBe(true);
    expect(todo.evidence?.checksPassed).toBe(1);
    expect(todo.status).toBe("completed");
    expect(todo.unproven).toBeUndefined();
  });

  test.each([
    ["an unrelated inline assertion", `bun -e "if (1 + 1 !== 2) throw new Error('math')"`],
    ["a check naming a different, untouched file", "bun test tests/unit/other.test.ts"],
  ])("does not close the step: %s", async (_name, command) => {
    // A VERIFY step is the one that needs a check. At the default gate the
    // completion is accepted but marked unproven, in the check's own words.
    const { ts } = await runWithCheck(command, VERIFY);
    const todo = ts.todos[0]!;
    expect(todo.evidence?.lastCheck).toBeUndefined();
    expect(todo.evidence?.checksPassed).toBe(0);
    expect(todo.unproven).toBe("no_evidence");
    expect(todo.unprovenReason).toContain("no passing check");
    expect(ts.todoCounts().unproven).toBe(1);
  });

  test.each([
    ["an unrelated inline assertion", `bun -e "if (1 + 1 !== 2) throw new Error('math')"`],
    ["a check naming a different, untouched file", "bun test tests/unit/other.test.ts"],
  ])("leaves the step open where the gate refuses: %s", async (_name, command) => {
    const { ts } = await runWithCheck(command, VERIFY, { gate: "refuse" });
    const todo = ts.todos[0]!;
    expect(todo.evidence?.lastCheck).toBeUndefined();
    expect(todo.status).toBe("in_progress");
    expect(ts.todoCounts().open).toBe(1);
    expect(ts.hasOpenTodos()).toBe(true);
  });

  test("the set-aside check is still on the ledger, and the refusal does not say nothing ran", async () => {
    const command = `bun -e "if (1 + 1 !== 2) throw new Error('math')"`;
    const { ts, loop } = await runWithCheck(command, VERIFY, { gate: "refuse" });
    // Executed, and recorded as such: the run's own check ledger keeps it.
    expect(ts.checks).toHaveLength(1);
    expect(ts.checks[0]).toMatchObject({ command, passed: true, source: "model" });
    // It counts against the step as a command that RAN.
    expect(ts.todos[0]!.evidence?.runs).toBe(1);
    // The log says why it did not close the step.
    const log = (ts.snapshot().log ?? []) as Array<{ kind: string; text: string }>;
    expect(log.some((e) => e.kind === "check" && /does not speak to/.test(e.text))).toBe(true);
    // The refusal the model reads names the missing check, not missing activity.
    const refusals = loop
      .getMessages()
      .flatMap((m: any) => m.content)
      .filter(
        (b: any) => b.type === "tool_result" && /Plan not updated/.test(b.toolResultContent ?? ""),
      );
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0]!.toolResultContent)).toContain("no passing check");
    expect(String(refusals[0]!.toolResultContent)).not.toContain("nothing ran");
  });

  test("a set-aside check does not reach the NEXT step through the pending pool", async () => {
    const ts = new TaskStateStore();
    const first = { content: "read the csv module", kind: "inspect" as const };
    const second = { content: "prove parseCsv round-trips", kind: "verify" as const };
    const steps: Step[] = [
      { tool: "todo_write", args: { items: [{ ...first, status: "in_progress" }] } },
      { tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } },
      { tool: "bash", args: { command: "bun test tests/unit/other.test.ts" } },
      {
        tool: "todo_write",
        args: {
          items: [
            { ...first, status: "completed" },
            { ...second, status: "completed" },
          ],
        },
      },
      { text: "Done." },
    ];
    const gw = makeGateway(steps);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("fix parseCsv", "s1", "/tmp"));
    // The second step never went in progress, so it draws on the pending
    // pool. An unrelated check must not be the proof it finds there.
    const proved = ts.todos.find((t) => t.content === second.content)!;
    expect(proved.evidence?.lastCheck).toBeUndefined();
    expect(proved.unproven).toBe("no_evidence");
    expect(proved.unprovenReason).toContain("no passing check");
  });

  test("a step that touched nothing keeps the cheap path", async () => {
    // No write, so no file set to judge against: the check the step was
    // opened to run still closes it, exactly as before.
    const { ts } = await runWithCheck("node browser-test.mjs", VERIFY, { write: false });
    const todo = ts.todos[0]!;
    expect(todo.evidence?.lastCheck?.passed).toBe(true);
    expect(todo.status).toBe("completed");
    expect(todo.unproven).toBeUndefined();
  });

  test("a failing unrelated check is set aside the same way", async () => {
    const { ts } = await runWithCheck("bun test tests/unit/other-failing.test.ts", CHANGE);
    const todo = ts.todos[0]!;
    // Not this step's verdict — a step is not blocked by a failure that is
    // about other files — but still on the ledger as a failure that happened.
    expect(todo.evidence?.lastCheck).toBeUndefined();
    expect(todo.evidence?.checksFailed).toBe(0);
    expect(ts.checks).toHaveLength(1);
    expect(ts.checks[0]).toMatchObject({ passed: false, source: "model" });
  });
});
