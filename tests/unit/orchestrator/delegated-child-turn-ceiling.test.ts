/**
 * The child turn-ceiling rule, and what actually bounds a task that keeps
 * asking for more. Written by an independent verifier.
 *
 * The lane proves the two shapes it designed for. This asks the question its
 * report leaves open: a child that reached `max_turns` gets a FRESH ceiling on
 * every follow-up, so what stops a parent from buying unlimited child turns by
 * asking again? The answer must be the cumulative spend cap and the backdated
 * wall clock — this drives ten consecutive follow-ups and reads both.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../../packages/shared/src/session";
import {
  DelegatedSessions,
  bindDelegatedBudget,
  bindDelegatedLoop,
  delegatedBudgetSeed,
  delegatedHistory,
  delegatedTurnCeiling,
  withDelegatedSessions,
} from "../../../packages/orchestrator/src/delegated-sessions";
import {
  checkBudget,
  resolveSubagentBudget,
  resumeBudgetState,
} from "../../../packages/orchestrator/src/subagent-budget";
import type { Message } from "../../../packages/llm-gateway/src/types";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* the OS reaps it */
    }
  }
});

function endingHandler(onCall: (input: ToolCallInput) => void, status: string): ToolHandler {
  return {
    schema: {
      name: "task",
      version: "0.1.0",
      description: "stub",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      onCall(input);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "out of turns",
        structured: { stopReason: status, child: { status } },
        durationMs: 1,
      };
    },
  };
}

test("ten follow-ups on a max_turns child: the ceiling never narrows, the caps do the bounding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v2-child-turns-"));
  dirs.push(dir);
  const manager = new SessionManager(join(dir, "sessions.db"));
  const parent = manager.createSession(dir, "m", "anthropic").id;
  const store = new DelegatedSessions(manager);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

  const ceilings: number[] = [];
  const spends: number[] = [];
  const clocks: number[] = [];
  const caps = resolveSubagentBudget("standard"); // $2.00, 10 minutes
  const breaches: string[] = [];

  const tool = withDelegatedSessions(
    endingHandler(() => {
      delegatedHistory({ provider: "anthropic", model: "m" });
      bindDelegatedLoop({ getMessages: () => messages });
      const prior = delegatedBudgetSeed();
      const state = resumeBudgetState(prior);
      spends.push(state.spentUsd);
      clocks.push(Date.now() - state.startedAt);
      const breach = checkBudget(caps, {
        spentUsd: state.spentUsd + 0.3,
        startedAt: state.startedAt,
      });
      if (breach) breaches.push(breach.kind);
      bindDelegatedBudget(() => ({
        spentUsd: (prior?.spentUsd ?? 0) + 0.3,
        elapsedMs: (prior?.elapsedMs ?? 0) + 120_000,
        turnsUsed: (prior?.turnsUsed ?? 0) + 8,
      }));
      ceilings.push(delegatedTurnCeiling(8));
    }, "max_turns"),
    "task",
    store,
  );

  const base = {
    toolName: "task",
    callId: "c0",
    sessionId: parent,
    workspaceRoot: dir,
    args: { prompt: "go" },
  } as unknown as ToolCallInput;

  const first = await tool.execute(base);
  const id = (first.structured as { task_id?: string } | undefined)?.task_id;
  expect(typeof id).toBe("string");
  for (let i = 1; i < 10; i++) {
    await tool.execute({
      ...base,
      callId: `c${i}`,
      args: { prompt: "keep going", task_id: id },
    } as unknown as ToolCallInput);
  }

  // 1. The turn ceiling is fresh every single time — nothing narrows it.
  expect(ceilings).toEqual(Array(10).fill(8));
  // 2. Spend accumulates across the ten calls, which is what bounds the task.
  expect(spends[0]).toBe(0);
  expect(spends.at(-1)).toBeCloseTo(2.7, 5);
  // 3. …and the clock is backdated, not restarted.
  expect(clocks.at(-1)!).toBeGreaterThanOrEqual(9 * 120_000);
  // 4. So the caps DO fire — from the call at which cumulative spend passes
  //    $2.00 (0.3 × 7 = 2.1) and the clock passes 10 minutes.
  // (cost is checked first in `checkBudget`, so it is the one reported)
  expect(breaches.length).toBeGreaterThan(0);
  expect(new Set(breaches)).toEqual(new Set(["cost"]));
  expect(breaches.length).toBe(4); // calls 7..10 of 10
  manager.close();
});
