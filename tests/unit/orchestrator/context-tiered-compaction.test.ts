/**
 * Tiered compaction + real context-window discovery.
 *
 * The failure these replace, measured from a real 640-minute build run
 * (~/.gear/gear.db session 01a03a3b, model stealth/ox-alpha via OpenRouter):
 * six auto-compactions, the worst folding 212 messages from 155,130 tokens down
 * to 834 — 0.54% of the budget. Two independent causes:
 *
 *   1. The model matched no static family rule, so its window was assumed to be
 *      the 100k default and compaction triggered at ~70k on a far larger model.
 *   2. Compaction kept a fixed SIX messages, a count rather than a size.
 *
 * Covers: live-limit registration, tool-result eviction (tier 1), the
 * token-budgeted tail (tier 2), escalation to summarization (tier 3), and a
 * replay at the shape and volume of the run that motivated all of it.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import {
  TokenCounter,
  getContextLimit,
  registerContextLimit,
  UNKNOWN_MODEL_CONTEXT_LIMIT,
} from "../../../packages/orchestrator/src/tokenizer";
import type { Message } from "../../../packages/llm-gateway/src/types";

function createMockGateway(summaryText = "## Current state & next step\nSummary.") {
  return {
    infer: mock(async () => ({
      content: [{ type: "text" as const, text: summaryText }],
      model: "test",
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getRegisteredProviderNames: () => [],
    getTotalCost: mock(() => 0),
  } as any;
}

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

const toolUseMsg = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", toolCallId: id, toolName: "bash", toolInput: { command: "ls" } }],
});

const toolResultMsg = (id: string, body: string): Message => ({
  role: "tool",
  content: [{ type: "tool_result", toolCallId: id, toolResultContent: body }],
});

/** A tool-heavy transcript: `pairs` tool_use/tool_result pairs of `bodyChars`. */
function toolHeavyRun(pairs: number, bodyChars: number): Message[] {
  const out: Message[] = [userMsg("Build the thing.")];
  for (let i = 0; i < pairs; i++) {
    out.push(toolUseMsg(`c${i}`), toolResultMsg(`c${i}`, "x".repeat(bodyChars)));
  }
  return out;
}

const bodiesOf = (messages: Message[]): string[] =>
  messages.flatMap((m) =>
    m.content.filter((b) => b.type === "tool_result").map((b) => b.toolResultContent),
  );

const EVICTED = "[tool result evicted to reclaim context]";

describe("context-window discovery", () => {
  afterEach(() => TokenCounter.clearContextLimits());

  test("an unrecognized model falls back to the conservative default", () => {
    expect(getContextLimit("stealth/ox-alpha")).toBe(UNKNOWN_MODEL_CONTEXT_LIMIT);
  });

  test("a catalog-reported window outranks the static table", () => {
    registerContextLimit("stealth/ox-alpha", 262_144);
    expect(getContextLimit("stealth/ox-alpha")).toBe(262_144);
    // ...and outranks a family rule too, since the catalog is authoritative.
    registerContextLimit("anthropic/claude-sonnet-4-6", 1_000_000);
    expect(getContextLimit("anthropic/claude-sonnet-4-6")).toBe(1_000_000);
  });

  test("a malformed catalog entry cannot shrink a window", () => {
    registerContextLimit("stealth/ox-alpha", 0);
    registerContextLimit("stealth/ox-alpha", -5);
    registerContextLimit("stealth/ox-alpha", Number.NaN);
    expect(getContextLimit("stealth/ox-alpha")).toBe(UNKNOWN_MODEL_CONTEXT_LIMIT);
  });
});

describe("compactWorkingSet — tiered", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let engine: ContextEngine;

  beforeEach(() => {
    gateway = createMockGateway();
    engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);
  });

  /** Report authoritative usage so the engine sizes its tail against a window. */
  const noteUsage = (used: number, model = "anthropic/claude-sonnet-4-6") => {
    engine.noteRealUsage({ inputTokens: used }, model);
  };

  test("tier 1: evicting old tool results alone avoids the summarizer entirely", async () => {
    const messages = toolHeavyRun(40, 4_000);
    noteUsage(150_000);

    const r = await engine.compactWorkingSet(messages);

    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("tool_results");
    expect(gateway.infer).not.toHaveBeenCalled();
    // Structure is intact — same message count, pairs unbroken.
    expect(r.messages).toHaveLength(messages.length);
    expect(r.summarizedCount).toBe(0);
    expect(r.afterTokens!).toBeLessThan(r.beforeTokens!);
    // Old bodies are stubbed; the newest ones are untouched.
    const bodies = bodiesOf(r.messages);
    expect(bodies[0]).toStartWith(EVICTED);
    expect(bodies.at(-1)).not.toStartWith(EVICTED);
  });

  test("tier 1 never orphans a tool_use, because the block survives", async () => {
    const messages = toolHeavyRun(40, 4_000);
    noteUsage(150_000);
    const r = await engine.compactWorkingSet(messages);

    const useIds = new Set(
      r.messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => b.toolCallId),
      ),
    );
    const resultIds = new Set(
      r.messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_result").map((b) => b.toolCallId),
      ),
    );
    expect(resultIds).toEqual(useIds);
  });

  test("an already-evicted result is not re-evicted on a second pass", async () => {
    const messages = toolHeavyRun(40, 4_000);
    noteUsage(150_000);
    const first = await engine.compactWorkingSet(messages);
    const second = await engine.compactWorkingSet(first.messages);

    // Nothing left to reclaim by eviction alone, so it escalates rather than
    // reporting a second successful tool_results pass over the same bytes.
    expect(second.tier).not.toBe("tool_results");
  });

  test("tier 3: escalates to summarization when eviction cannot free enough", async () => {
    // Bulk lives in USER text, which eviction never touches.
    const messages = Array.from({ length: 40 }, (_, i) => userMsg("y".repeat(4_000) + i));
    noteUsage(150_000);

    const r = await engine.compactWorkingSet(messages);

    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("summarized");
    expect(gateway.infer).toHaveBeenCalledTimes(1);
    expect(r.messages[0]!.content[0]).toMatchObject({ type: "text" });
    expect((r.messages[0]!.content[0] as { text: string }).text).toContain(
      "[Earlier conversation summary]",
    );
  });

  test("tier 2: the kept tail is sized in tokens, not in six messages", async () => {
    // Large enough that the tail budget actually binds (~160k tokens of text
    // against a 200k window); otherwise everything fits and nothing is proven.
    const messages = Array.from({ length: 400 }, (_, i) => userMsg("z".repeat(1_600) + i));
    noteUsage(180_000, "anthropic/claude-sonnet-4-6"); // 200k window

    const r = await engine.compactWorkingSet(messages);

    expect(r.tier).toBe("summarized");
    // The old behaviour kept exactly recentK (6) messages plus a summary. The
    // budgeted tail must keep far more than that.
    expect(r.messages.length).toBeGreaterThan(50);
    // And it must land well above the 0.54%-of-budget floor that motivated this.
    expect(r.afterTokens!).toBeGreaterThan(200_000 * 0.2);
  });

  test("without authoritative usage the historical count-based cut still applies", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => userMsg(`turn ${i}`));
    // No noteRealUsage() — no window to budget against.
    const r = await engine.compactWorkingSet(messages, 6);

    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("summarized");
    expect(r.messages).toHaveLength(7); // summary + recentK
  });

  test("recentK remains a hard floor on the tail", async () => {
    const messages = Array.from({ length: 400 }, (_, i) => userMsg("z".repeat(400) + i));
    noteUsage(180_000);
    const r = await engine.compactWorkingSet(messages, 6);
    const tail = r.messages.slice(-6);
    expect(tail).toEqual(messages.slice(-6));
  });
});

describe("replay: the run that motivated this", () => {
  test("a 155k tool-heavy working set no longer collapses to under 1% of budget", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);

    // Shape and volume of the observed compaction: 212 messages, ~155k tokens,
    // dominated by tool results — a build loop running tests and reading files.
    const messages = toolHeavyRun(106, 2_400);
    registerContextLimit("stealth/ox-alpha", 262_144);
    engine.noteRealUsage({ inputTokens: 155_130 }, "stealth/ox-alpha");

    const r = await engine.compactWorkingSet(messages);

    expect(r.compacted).toBe(true);
    // The observed outcome was 834 tokens — 0.54% of the budget. Anything in
    // that neighbourhood is an amnesia event, not a compaction.
    //
    // The tail TARGET is COMPACT_TAIL_RATIO (0.30); the realized share lands a
    // little under it because the cut snaps to a pair-safe boundary and whole
    // messages are the unit. 0.20 is the floor worth defending — an order of
    // magnitude clear of the failure, without pinning the exact arithmetic.
    const survivingShare = r.afterTokens! / 262_144;
    expect(survivingShare).toBeGreaterThan(0.2);
    expect(r.afterTokens!).toBeGreaterThan(834 * 20);

    TokenCounter.clearContextLimits();
  });
});
