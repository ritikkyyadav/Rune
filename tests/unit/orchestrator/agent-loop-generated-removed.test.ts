/**
 * What the harness removed after its own checks — the loop side.
 *
 * `verifier-generated-state.test.ts` holds the verifier to what it may remove.
 * This holds the loop to saying so: the paths go out on the event that reports
 * the check, and one line goes on the run's audit trail. A person's repository
 * had files deleted from it; that is on the record, or it did not happen
 * properly.
 *
 * And to saying nothing when there was nothing: no empty list, no line.
 *
 * A scripted model and a stub verifier. No child process, no model.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
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
        category: name === "write_file" ? "write" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "ok",
      durationMs: 1,
    })),
  } as any;
}

async function run(
  turns: Step[],
  opts: Record<string, unknown>,
): Promise<{ events: AgentTurnEvent[]; trail: string[] }> {
  const taskState = new TaskStateStore();
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 20,
      systemPrompt: "s",
      taskState,
      ...opts,
    } as any,
    makeGateway(turns),
    makeRegistry(),
  );
  const events: AgentTurnEvent[] = [];
  for await (const event of loop.run("add the handler", "s1", "/tmp")) events.push(event);
  const trail = (taskState.snapshot().log ?? [])
    .filter((entry) => entry.kind === "check")
    .map((entry) => entry.text);
  return { events, trail };
}

const WRITE: Step = { tool: "write_file", args: { path: "src/h.ts", content: "x" } };
const todo = (status: string): Step => ({
  tool: "todo_write",
  args: { items: [{ content: "write the handler", status }] },
});

const GREEN: VerifyResult = {
  status: "passed",
  passed: true,
  ran: true,
  report: "$ bun run typecheck  (ok)",
  runs: [{ command: "bun run typecheck", exitCode: 0, durationMs: 5, passed: true }],
};
const REMOVED = [".turbo/", "dist/"];
const NOTE = "removed 2 git-ignored paths the checks generated: .turbo/, dist/";

const verifierReturning = (result: VerifyResult) => ({ verify: mock(async () => result) });

describe("the end-of-turn checks", () => {
  test("what they generated and the harness removed is on the event and on the trail", async () => {
    const { events, trail } = await run([WRITE, { text: "done" }], {
      verifier: verifierReturning({ ...GREEN, removed: REMOVED }),
    });
    const completed = events.filter((e) => e.type === "verification_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "passed", removed: REMOVED });
    // The report is still the checks' own words.
    expect(completed[0]).toMatchObject({ report: "$ bun run typecheck  (ok)" });
    expect(trail).toContain(NOTE);
  });

  test("nothing removed: no list on the event, no line on the trail", async () => {
    for (const result of [GREEN, { ...GREEN, removed: [] }]) {
      const { events, trail } = await run([WRITE, { text: "done" }], {
        verifier: verifierReturning(result),
      });
      const completed = events.filter((e) => e.type === "verification_completed");
      expect(completed).toHaveLength(1);
      expect("removed" in completed[0]).toBe(false);
      expect(trail.filter((line) => line.startsWith("removed"))).toEqual([]);
    }
  });
});

describe("the step check", () => {
  const STEP = [todo("in_progress"), WRITE, todo("completed"), { text: "done" }];

  test("what it generated and the harness removed is on the event and on the trail", async () => {
    const { events, trail } = await run(STEP, {
      stepCheck: mock(async () => ({ ...GREEN, removed: REMOVED })),
    });
    const checks = events.filter((e) => e.type === "step_check");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ passed: true, removed: REMOVED });
    expect(trail).toContain(NOTE);
  });

  test("nothing removed: no list on the event, no line on the trail", async () => {
    for (const result of [GREEN, { ...GREEN, removed: [] }]) {
      const { events, trail } = await run(STEP, { stepCheck: mock(async () => result) });
      const checks = events.filter((e) => e.type === "step_check");
      expect(checks).toHaveLength(1);
      expect("removed" in checks[0]).toBe(false);
      expect(trail.filter((line) => line.startsWith("removed"))).toEqual([]);
    }
  });

  test("one that reached no verdict still has what was removed on the trail", async () => {
    // Killed at its deadline, half a build made and taken away again. There is
    // no `step_check` event for a check with no verdict; the trail is the record.
    const { events, trail } = await run(STEP, {
      stepCheck: mock(async (): Promise<VerifyResult> => ({
        status: "inconclusive",
        reason: "timeout",
        passed: false,
        ran: false,
        report: "$ bun run typecheck\n[timed out after 60000ms — nothing was measured]",
        removed: ["dist/"],
      })),
    });
    expect(events.filter((e) => e.type === "step_check")).toEqual([]);
    expect(trail).toContain("removed 1 git-ignored path the checks generated: dist/");
  });
});
