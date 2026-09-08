/**
 * Run economics: completions split work vs governance, prompt composition in
 * bytes, and the rules the readouts depend on.
 *
 * The load-bearing claims here are the ones a wrong number would hide:
 *  - a row with no `role` is the WORK (every row written before P12.1 has none);
 *  - "no data" is null and never 0% (the rule the whole cost surface keeps);
 *  - a composition is reported only over the calls that measured one, so a
 *    governance call that attributes nothing cannot dilute the average into a
 *    fiction.
 */

import { describe, test, expect } from "bun:test";
import {
  summarizeRunEconomics,
  completionsByProvider,
  measureComposition,
  compositionShares,
  messageBytes,
  toolSchemaBytes,
  utf8Bytes,
  isGovernanceRole,
  GOVERNANCE_ROLES,
  CostTracker,
} from "../../../packages/llm-gateway/src/index";
import type { CallRole, Message, ProviderName } from "../../../packages/llm-gateway/src/index";

type Entry = Parameters<typeof summarizeRunEconomics>[0][number];

function entry(over: Partial<Entry> = {}): Entry {
  return {
    model: "claude-sonnet-4-6",
    provider: "anthropic" as ProviderName,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    listCostUsd: 0.01,
    ...over,
  };
}

describe("governance roles", () => {
  test("the six overhead roles are governance; work roles are not", () => {
    for (const role of GOVERNANCE_ROLES) expect(isGovernanceRole(role)).toBe(true);
    for (const role of ["primary", "subagent", "research"] as CallRole[]) {
      expect(isGovernanceRole(role)).toBe(false);
    }
  });

  test("an absent role is NOT governance — pre-P12.1 rows are the work", () => {
    expect(isGovernanceRole(undefined)).toBe(false);
  });
});

describe("summarizeRunEconomics", () => {
  test("splits completions work vs governance and names each role", () => {
    const e = summarizeRunEconomics([
      entry({ role: "primary" }),
      entry({ role: "primary" }),
      entry({ role: "classifier", inputTokens: 3000 }),
      entry({ role: "summarizer", inputTokens: 5000 }),
      entry({ role: "subagent" }),
    ]);
    expect(e.completions).toBe(5);
    expect(e.governanceCompletions).toBe(2);
    // A sub-agent's turn is delegated WORK, not overhead.
    expect(e.primaryCompletions).toBe(3);
    expect(e.governanceShare).toBeCloseTo(2 / 5);
    expect(e.byRole.map((r) => r.role).sort()).toEqual([
      "classifier",
      "primary",
      "subagent",
      "summarizer",
    ]);
    expect(e.byRole.find((r) => r.role === "primary")!.completions).toBe(2);
  });

  test("a row with no role counts as the work", () => {
    const e = summarizeRunEconomics([entry(), entry({ role: "classifier" })]);
    expect(e.primaryCompletions).toBe(1);
    expect(e.governanceCompletions).toBe(1);
    expect(e.byRole.find((r) => r.role === "primary")!.completions).toBe(1);
  });

  test("fresh tokens per completion is reported overall and for governance alone", () => {
    const e = summarizeRunEconomics([
      entry({ role: "primary", inputTokens: 2000 }),
      entry({ role: "classifier", inputTokens: 34_000 }),
      entry({ role: "summarizer", inputTokens: 30_000 }),
    ]);
    expect(e.freshInputTokens).toBe(66_000);
    expect(e.freshTokensPerCompletion).toBe(22_000);
    // The number this lane exists to move: what a GOVERNANCE call carries.
    expect(e.governanceFreshTokensPerCompletion).toBe(32_000);
  });

  test("cache read ratio is null for no data, never zero", () => {
    const none = summarizeRunEconomics([
      entry({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);
    expect(none.cacheReadRatio).toBeNull();

    const cold = summarizeRunEconomics([entry({ inputTokens: 100, cacheReadTokens: 0 })]);
    expect(cold.cacheReadRatio).toBe(0);

    const warm = summarizeRunEconomics([entry({ inputTokens: 100, cacheReadTokens: 300 })]);
    expect(warm.cacheReadRatio).toBeCloseTo(0.75);
  });

  test("an empty ledger reports null shares rather than inventing zeros", () => {
    const e = summarizeRunEconomics([]);
    expect(e.completions).toBe(0);
    expect(e.governanceShare).toBeNull();
    expect(e.freshTokensPerCompletion).toBeNull();
    expect(e.cacheReadRatio).toBeNull();
    expect(e.composition).toBeNull();
  });

  test("governance list cost is attributed separately from the total", () => {
    const e = summarizeRunEconomics([
      entry({ role: "primary", listCostUsd: 1 }),
      entry({ role: "classifier", listCostUsd: 0.25 }),
    ]);
    expect(e.listCostUsd).toBeCloseTo(1.25);
    expect(e.governanceListCostUsd).toBeCloseTo(0.25);
  });

  test("composition folds only over the calls that measured one", () => {
    const composition = {
      doctrine: 100,
      planLedger: 20,
      taskState: 10,
      toolSchemas: 60,
      conversation: 810,
      total: 1000,
    };
    const e = summarizeRunEconomics([
      entry({ role: "primary", composition }),
      entry({ role: "primary", composition }),
      // A governance call attributes nothing. It must not drag the average
      // toward zero and claim prompts got smaller.
      entry({ role: "classifier" }),
    ]);
    expect(e.composition).not.toBeNull();
    expect(e.composition!.measured).toBe(2);
    expect(e.composition!.total).toBe(2000);
    expect(e.composition!.total / e.composition!.measured).toBe(1000);
  });

  test("the fixed overhead is reported first-to-last, not as an average", () => {
    // The shape a run actually has: a bigger opening prefix (the opening
    // doctrine), then a smaller one — and a tool loaded mid-run growing the
    // schema back. An average over the three describes no request that was
    // ever sent, which is why both ends are carried.
    const at = (doctrine: number, toolSchemas: number) => ({
      doctrine,
      planLedger: 0,
      taskState: 0,
      toolSchemas,
      conversation: 100,
      total: doctrine + toolSchemas + 100,
    });
    const e = summarizeRunEconomics([
      entry({ role: "primary", composition: at(400, 200) }),
      entry({ role: "primary", composition: at(300, 200) }),
      // Governance measures nothing and must not be mistaken for the last call.
      entry({ role: "classifier" }),
      entry({ role: "primary", composition: at(300, 250) }),
    ]);
    expect(e.composition!.fixedFirst).toBe(600);
    expect(e.composition!.fixedLast).toBe(550);
  });

  test("one measured completion reports the same value at both ends", () => {
    const e = summarizeRunEconomics([
      entry({
        role: "primary",
        composition: {
          doctrine: 10,
          planLedger: 0,
          taskState: 0,
          toolSchemas: 5,
          conversation: 1,
          total: 16,
        },
      }),
    ]);
    expect(e.composition!.fixedFirst).toBe(15);
    expect(e.composition!.fixedLast).toBe(15);
  });

  test("an unpriced model is named so the list estimate is not read as complete", () => {
    const e = summarizeRunEconomics([entry({ model: "some-model-nobody-priced" })]);
    expect(e.unpricedModels).toEqual(["some-model-nobody-priced"]);
  });
});

describe("completionsByProvider", () => {
  test("counts calls and their governance share per provider", () => {
    const rows = completionsByProvider([
      { provider: "openrouter" as ProviderName, role: "primary" },
      { provider: "openrouter" as ProviderName, role: "classifier" },
      { provider: "ollama" as ProviderName, role: "summarizer" },
    ]);
    expect(rows[0]).toEqual({ provider: "openrouter", completions: 2, governance: 1 });
    expect(rows[1]).toEqual({ provider: "ollama", completions: 1, governance: 1 });
  });
});

describe("prompt composition", () => {
  const text = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });

  test("utf8 bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // The em dash this codebase writes everywhere is three bytes, not one.
    expect(utf8Bytes("—")).toBe(3);
    expect(utf8Bytes("")).toBe(0);
  });

  test("a message counts tool arguments and tool results, not just prose", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", toolCallId: "1", toolName: "bash", toolInput: { command: "ls" } },
      ],
    };
    expect(messageBytes(m)).toBe(
      utf8Bytes("ok") + utf8Bytes("bash") + utf8Bytes(JSON.stringify({ command: "ls" })),
    );

    const result: Message = {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "1", toolResultContent: "a".repeat(500) }],
    };
    expect(messageBytes(result)).toBe(500);
  });

  test("the five parts sum to the total", () => {
    const c = measureComposition({
      system: "doctrine",
      tools: [{ name: "bash", description: "run", inputSchema: {} }],
      messages: [text("hello"), text("world")],
      planLedger: "PLAN",
      taskState: ["budget", null, "team"],
    });
    expect(c.doctrine).toBe(8);
    expect(c.planLedger).toBe(4);
    expect(c.taskState).toBe(utf8Bytes("budget") + utf8Bytes("team"));
    expect(c.toolSchemas).toBe(
      toolSchemaBytes([{ name: "bash", description: "run", inputSchema: {} }]),
    );
    expect(c.conversation).toBe(10);
    expect(c.total).toBe(c.doctrine + c.planLedger + c.taskState + c.toolSchemas + c.conversation);
  });

  test("no plan ledger and no tools cost nothing", () => {
    const c = measureComposition({ system: "d", messages: [] });
    expect(c.planLedger).toBe(0);
    expect(c.taskState).toBe(0);
    expect(c.toolSchemas).toBe(0);
    expect(c.total).toBe(1);
  });

  test("shares are null for an empty prompt and sum to one otherwise", () => {
    expect(
      compositionShares({
        doctrine: 0,
        planLedger: 0,
        taskState: 0,
        toolSchemas: 0,
        conversation: 0,
        total: 0,
      }),
    ).toBeNull();
    const s = compositionShares({
      doctrine: 250,
      planLedger: 250,
      taskState: 0,
      toolSchemas: 250,
      conversation: 250,
      total: 1000,
    })!;
    expect(s.doctrine).toBe(0.25);
    expect(s.doctrine + s.planLedger + s.taskState + s.toolSchemas + s.conversation).toBeCloseTo(1);
  });
});

describe("CostTracker attribution", () => {
  test("role and composition ride onto the recorded entry", () => {
    const tracker = new CostTracker();
    const composition = {
      doctrine: 1,
      planLedger: 2,
      taskState: 3,
      toolSchemas: 4,
      conversation: 5,
      total: 15,
    };
    const e = tracker.record(
      "claude-sonnet-4-6",
      "anthropic" as ProviderName,
      { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      new Date(),
      { role: "summarizer", composition },
    );
    expect(e.role).toBe("summarizer");
    expect(e.composition).toEqual(composition);
  });

  test("a caller that says nothing leaves both fields absent, not zeroed", () => {
    const tracker = new CostTracker();
    const e = tracker.record("claude-sonnet-4-6", "anthropic" as ProviderName, {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(e.role).toBeUndefined();
    expect(e.composition).toBeUndefined();
    // …and it reads back as the work, which is what it was.
    expect(summarizeRunEconomics([e]).governanceCompletions).toBe(0);
  });
});
