/**
 * The turn ceiling is a reliability bound — `[reliability] maxTurns` and
 * `[reliability] secondWinds` — resolved through the same policy as every
 * other loop limit, and the engine builds the loop from that policy. It was
 * a constant in engine.ts for a month with no knob; nine runs ended at it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RELIABILITY,
  loopTurnCeiling,
  parseMaxBudgetFlag,
  parseMaxTurnsFlag,
  policyForModel,
  turnCeilingOverride,
  UNBOUNDED_TURNS,
} from "../../../packages/orchestrator/src/reliability-policy";
import { applyInheritance } from "../../../packages/orchestrator/src/turn-budget";
import {
  displaySettingValue,
  normalizeSettingValue,
  resolveSetting,
  settingChoices,
} from "../../../packages/orchestrator/src/config-settings";

describe("turn ceiling as a reliability bound", () => {
  test("defaults: 80 turns, 2 second winds", () => {
    expect(DEFAULT_RELIABILITY.maxTurns).toBe(80);
    expect(DEFAULT_RELIABILITY.secondWinds).toBe(2);
    const p = policyForModel("gpt-5.6-sol");
    expect(p.maxTurns).toBe(80);
    expect(p.secondWinds).toBe(2);
  });

  test("[reliability] overrides both, field by field, integers only", () => {
    const p = policyForModel("gpt-5.6-sol", { maxTurns: 200, secondWinds: 0 });
    expect(p.maxTurns).toBe(200);
    expect(p.secondWinds).toBe(0);
    expect(p.maxStuckNudges).toBe(DEFAULT_RELIABILITY.maxStuckNudges);
    const bad = policyForModel("gpt-5.6-sol", { maxTurns: -1 as number, secondWinds: 1.9 });
    expect(bad.maxTurns).toBe(80);
    expect(bad.secondWinds).toBe(1);
  });

  test("the engine builds the loop from the policy, not a constant", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/engine.ts"),
      "utf8",
    );
    expect(src).toContain(
      "turnBudgetForMessage(userMessage, loopTurnCeiling(reliability.maxTurns))",
    );
    expect(src).toContain("reliability.secondWinds");
    expect(src).not.toMatch(/\bMAX_TURNS\b/);
  });
});

/**
 * R3.3 of docs/program/rune-reliability-plan-20261014.md, decision D7: the
 * turn ceiling belongs to the person. Five runs between 14 September and 14
 * October ended at 80 turns. An interactive session has none unless the
 * person sets one; a headless run keeps 80 unless `--max-turns` says.
 */
describe("the turn ceiling belongs to the person (D7)", () => {
  test("which ceiling a launch runs under", () => {
    // Interactive, nothing set: none.
    expect(turnCeilingOverride({ interactive: true })).toBe(0);
    // Headless, nothing set: the default stands.
    expect(turnCeilingOverride({ interactive: false })).toBeUndefined();
    // What the person set wins in either mode, and the flag wins over it.
    expect(turnCeilingOverride({ configured: 120, interactive: true })).toBe(120);
    expect(turnCeilingOverride({ configured: 120, interactive: false })).toBe(120);
    expect(turnCeilingOverride({ flag: 30, configured: 120, interactive: true })).toBe(30);
    expect(turnCeilingOverride({ flag: 0, interactive: false })).toBe(0);
  });

  test("0 is no ceiling: the loop gets a bound no run reaches", () => {
    expect(policyForModel("gpt-5.6-sol", { maxTurns: 0 }).maxTurns).toBe(0);
    expect(loopTurnCeiling(0)).toBe(UNBOUNDED_TURNS);
    expect(loopTurnCeiling(80)).toBe(80);
  });

  test("--max-turns takes a whole number, 0 for none", () => {
    expect(parseMaxTurnsFlag(undefined)).toBeUndefined();
    expect(parseMaxTurnsFlag("40")).toBe(40);
    expect(parseMaxTurnsFlag(" 0 ")).toBe(0);
    for (const bad of ["abc", "-3", "2.5", ""]) {
      expect((parseMaxTurnsFlag(bad) as { error: string }).error).toContain("--max-turns");
    }
  });

  test("--max-budget-usd takes dollars above zero", () => {
    expect(parseMaxBudgetFlag(undefined)).toBeUndefined();
    expect(parseMaxBudgetFlag("2.50")).toBe(2.5);
    expect(parseMaxBudgetFlag("$5")).toBe(5);
    for (const bad of ["0", "-1", "lots", ""]) {
      expect((parseMaxBudgetFlag(bad) as { error: string }).error).toContain("--max-budget-usd");
    }
  });

  test("a resumed run with no ceiling keeps none, and says what was spent", () => {
    const out = applyInheritance({ maxTurns: UNBOUNDED_TURNS, conversational: false }, 2, {
      turnsUsed: 60,
      secondWindsUsed: 0,
      spentUsd: 1.25,
      from: "running",
    });
    expect(out.budget.maxTurns).toBe(UNBOUNDED_TURNS);
    expect(out.line).toContain("60 turns were used");
    expect(out.line).toContain("$1.25");
    expect(out.line).toContain("no turn ceiling");
    expect(out.line).not.toContain(String(UNBOUNDED_TURNS - 60));
  });

  test("/config turns accepts 0 and its words for none, and still refuses 1 to 7", () => {
    const turns = resolveSetting("turns")!;
    for (const none of ["0", "none", "off", "unlimited"]) {
      expect(normalizeSettingValue(turns, none)).toEqual({ value: "0" });
    }
    expect(normalizeSettingValue(turns, "120")).toEqual({ value: "120" });
    const five = normalizeSettingValue(turns, "5") as { error: string };
    expect(five.error).toContain("or 0 for no ceiling");
    expect(displaySettingValue(turns, "0")).toBe("0 (no ceiling)");
    expect(settingChoices(turns)).toContain("0 (no ceiling)");
  });
});

describe("a run with no ceiling", () => {
  test("goes past eighty turns and ends on its own answer", async () => {
    const { AgentLoop } = await import("../../../packages/orchestrator/src/agent-loop");
    const TURNS = 95;
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls <= TURNS) {
          // A different file each turn: real progress, nothing for the loop
          // detector or the read-thrash signal to find.
          const id = `c${calls}`;
          yield { type: "tool_use_start", toolCallId: id, toolName: "read_file" };
          yield { type: "tool_use_stop", toolCallId: id, toolInput: { path: `src/f${calls}.ts` } };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "content_start", contentIndex: 0 };
        yield {
          type: "content_delta",
          contentIndex: 0,
          delta: { type: "text_delta", text: "Read all of them." },
        };
        yield { type: "content_stop", contentIndex: 0 };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as any;
    const registry = {
      toLlmTools: () => [],
      get: (name: string) => ({
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: "read",
          permissionLevel: "auto",
        },
      }),
      execute: async (i: { toolName: string; callId: string }) => ({
        callId: i.callId,
        toolName: i.toolName,
        success: true,
        result: "contents",
        durationMs: 1,
      }),
    } as any;
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: loopTurnCeiling(0),
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        suspendClock: false,
      } as any,
      gateway,
      registry,
    );
    const events: any[] = [];
    for await (const e of loop.run("read every file", "s1", "/tmp")) events.push(e);
    const last = events.at(-1);
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("end_turn");
    expect(calls).toBe(TURNS + 1);
    expect(loop.getBudgetProgress().turnsUsed).toBeGreaterThan(80);
  }, 60_000);
});
