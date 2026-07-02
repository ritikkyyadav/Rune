/**
 * Execution-evidence gate: an agent that wrote files but never executed
 * anything (no bash, no project checks) is NOT allowed to finish on its first
 * try — the loop injects a verify-and-report nudge. Deterministic, harness-
 * level enforcement independent of which model is running.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Registry where write_file is category write, bash is execute; all succeed. */
function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        category: name === "bash" ? "execute" : name === "write_file" ? "write" : "read",
        permissionLevel: name === "write_file" || name === "bash" ? "confirm" : "auto",
      },
    })),
    execute: mock(async (input: any) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: JSON.stringify({ ok: true }),
      durationMs: 1,
    })),
  } as any;
}

describe("execution-evidence gate", () => {
  test("write without any execution → finish is refused once with a verify nudge", async () => {
    let turn = 0;
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
          yield ev("tool_use_stop", { toolCallId: "w1", toolInput: { path: "chess.py" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else if (turn === 2) {
          // Model tries to finish without running anything
          yield ev("content_delta", { delta: { type: "text_delta", text: "Done! Chess game ready." } });
          yield ev("message_stop", { stopReason: "end_turn" });
        } else if (turn === 3) {
          // After the nudge, the model runs it
          yield ev("tool_use_start", { toolCallId: "b1", toolName: "bash" });
          yield ev("tool_use_stop", { toolCallId: "b1", toolInput: { command: "python chess.py --selftest" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "Verified. Run: python chess.py" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, makeRegistry());
    const events = await collect(loop.run("build a chess game", "s1", "/tmp"));

    // The nudge notice fired
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("No execution evidence")),
    ).toBe(true);
    // The nudge message reached the model on turn 3
    const nudged = requests[2].messages.find((m: any) =>
      m.content.some((b: any) => b.type === "text" && String(b.text).includes("never executed")),
    );
    expect(nudged).toBeDefined();
    expect(nudged.role).toBe("user");
    // And the run completed normally after verification
    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("end_turn");
    expect(gateway.inferStream).toHaveBeenCalledTimes(4);
  });

  test("write followed by a bash run in the same session → no nudge", async () => {
    let turn = 0;
    const gateway = {
      inferStream: mock(async function* () {
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
          yield ev("tool_use_stop", { toolCallId: "w1", toolInput: { path: "a.py" } });
          yield ev("tool_use_start", { toolCallId: "b1", toolName: "bash" });
          yield ev("tool_use_stop", { toolCallId: "b1", toolInput: { command: "python a.py" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "verified" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, makeRegistry());
    const events = await collect(loop.run("task", "s1", "/tmp"));
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("No execution evidence")),
    ).toBe(false);
    expect(gateway.inferStream).toHaveBeenCalledTimes(2);
  });

  test("read-only sessions (no writes) finish without the gate", async () => {
    const gateway = {
      inferStream: mock(async function* () {
        yield ev("content_delta", { delta: { type: "text_delta", text: "the answer is 42" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
    } as any;
    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, makeRegistry());
    const events = await collect(loop.run("question", "s1", "/tmp"));
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("No execution evidence")),
    ).toBe(false);
    expect(gateway.inferStream).toHaveBeenCalledTimes(1);
  });

  test("nudge fires at most once — a stubborn model still terminates", async () => {
    let turn = 0;
    const gateway = {
      inferStream: mock(async function* () {
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
          yield ev("tool_use_stop", { toolCallId: "w1", toolInput: { path: "a.py" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          // Model refuses to verify, tries to finish every time
          yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;
    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, makeRegistry());
    const events = await collect(loop.run("task", "s1", "/tmp"));
    const nudges = events.filter(
      (e) => e.type === "notice" && e.message.includes("No execution evidence"),
    );
    expect(nudges.length).toBe(1);
    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("end_turn");
    // 1 write turn + 1 refused finish + 1 final finish = 3
    expect(gateway.inferStream).toHaveBeenCalledTimes(3);
  });

  test("passing project checks count as evidence — no nudge after verifier passes", async () => {
    let turn = 0;
    const verifier = {
      verify: mock(async () => ({ ran: true, passed: true, report: "tests: 10 passed" })),
    };
    const gateway = {
      inferStream: mock(async function* () {
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
          yield ev("tool_use_stop", { toolCallId: "w1", toolInput: { path: "a.ts" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;
    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", verifier: verifier as any },
      gateway,
      makeRegistry(),
    );
    const events = await collect(loop.run("task", "s1", "/tmp"));
    expect(verifier.verify).toHaveBeenCalled();
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("No execution evidence")),
    ).toBe(false);
    expect(gateway.inferStream).toHaveBeenCalledTimes(2);
  });
});
