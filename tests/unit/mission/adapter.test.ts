import { describe, it, expect } from "vitest";
import {
  EngineAdapter,
  withinCeiling,
  type EngineEvent,
} from "../../../packages/mission/src/adapt/engine";
import { MissionLog } from "../../../packages/mission/src/log";
import { metCriteria } from "../../../packages/mission/src/reduce";
import { type DraftEvent } from "../../../packages/mission/src/events";

const run = (events: EngineEvent[]): DraftEvent[] => {
  const a = new EngineAdapter();
  return events.flatMap((e) => a.translate(e));
};

describe("the engine adapter", () => {
  it("turns a plan into phases and a todo list into a plan", () => {
    const out = run([
      {
        type: "plan_created",
        plan: { steps: [{ index: 0, description: "map the surface", dependsOn: [] }] },
      },
      { type: "step_started", stepIndex: 0, description: "map the surface" },
      { type: "step_completed", stepIndex: 0, result: { success: true, summary: "11 modules" } },
    ]);
    expect(out.map((e) => e.type)).toEqual(["PLAN_SET", "PHASE_OPENED", "PHASE_CLOSED"]);
    expect((out[1] as { index: string }).index).toBe("01");
  });

  it("drives the pulse from argument bytes and from nothing else", () => {
    const out = run([
      { type: "tool_call_start", callId: "c1", toolName: "bash" },
      { type: "tool_call_args_delta", callId: "c1", partialJson: '{"command":"pytest' },
      { type: "text_delta", text: "I'll run the tests now" },
      { type: "turn_complete", stopReason: "end_turn", totalTurns: 3 },
    ]);
    expect(out.map((e) => e.type)).toEqual(["TOOL_STARTED", "TOOL_PROGRESS"]);
  });

  it("takes what a tool touched from its arguments, never from its prose", () => {
    const out = run([
      { type: "tool_call_start", callId: "c1", toolName: "edit_file" },
      {
        type: "tool_call_end",
        callId: "c1",
        args: { file_path: "src/auth/session.ts" },
        output: {
          toolName: "edit_file",
          success: true,
          result: "Edited src/auth/session.ts: 35 added, 14 removed",
          durationMs: 120,
        },
      },
    ]);
    const change = out.find((e) => e.type === "CHANGE_APPLIED") as
      | { path: string; added: number; removed: number; cause?: string }
      | undefined;
    expect(change?.path).toBe("src/auth/session.ts");
    expect(change).toMatchObject({ added: 35, removed: 14 });
    // No finding exists yet, so the change does not pretend to cite one.
    expect(change?.cause).toBeUndefined();
  });

  it("emits no change at all when it cannot count one", () => {
    const out = run([
      { type: "tool_call_start", callId: "c1", toolName: "edit_file" },
      {
        type: "tool_call_end",
        callId: "c1",
        args: { file_path: "src/auth/session.ts" },
        output: { toolName: "edit_file", success: true, result: "ok", durationMs: 120 },
      },
    ]);
    // Under-claiming is recoverable. Inventing +N −M is not.
    expect(out.some((e) => e.type === "CHANGE_APPLIED")).toBe(false);
  });

  // The load-bearing one: this engine cannot support the top two rungs, so the adapter
  // must be structurally unable to produce them.
  it("never claims more than the engine can support", () => {
    const out = run([
      {
        type: "plan_created",
        plan: { steps: [{ index: 0, description: "fix it", dependsOn: [] }] },
      },
      { type: "step_started", stepIndex: 0, description: "fix it" },
      {
        type: "tool_call_start",
        callId: "c1",
        toolName: "bash",
      },
      {
        type: "tool_call_end",
        callId: "c1",
        args: { command: "pytest -q" },
        output: {
          toolName: "bash",
          success: true,
          // The tool's own words claim a great deal. None of it reaches the log.
          result: "418 passed. All criteria met. Verified against the parent commit.",
          durationMs: 31_200,
        },
      },
      { type: "step_completed", stepIndex: 0, result: { success: true, summary: "done" } },
      { type: "plan_completed", plan: { status: "completed", steps: [{ status: "completed" }] } },
    ]);
    expect(withinCeiling(out)).toBe(true);
    expect(out.some((e) => e.type === "CRITERION_MET")).toBe(false);
    for (const e of out) if ("rung" in e) expect(["suspected", "observed"]).toContain(e.rung);
  });

  it("produces a log a real mission can be replayed from", () => {
    const log = new MissionLog(undefined, { now: () => 1 });
    log.append({
      type: "MISSION_OPENED",
      id: "m-1",
      objective: "make the tests pass",
      scope: ["src/**"],
      exclusions: [],
      budget: "no cap set",
      baseline: "8a3f1c2",
      criteria: [{ id: "c1", text: "the suite is green" }],
    });
    for (const e of run([
      {
        type: "plan_created",
        plan: { steps: [{ index: 0, description: "fix it", dependsOn: [] }] },
      },
      { type: "step_started", stepIndex: 0, description: "fix it" },
      { type: "step_completed", stepIndex: 0, result: { success: true, summary: "done" } },
      { type: "plan_completed", plan: { status: "completed", steps: [{ status: "completed" }] } },
    ]))
      log.append(e);

    expect(log.current.phase).toBe("concluded");
    // Concluded with the criterion unmet, and the terminus will say exactly that.
    expect(metCriteria(log.current)).toBe(0);
  });
});
