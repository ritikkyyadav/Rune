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
  tokenCounter,
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

// The token counter is a module-level singleton shared by every ContextEngine,
// so calibration learned by another test file leaks into this one: bun runs
// the suite in one process, in directory order, and that order differs between
// macOS and Linux. Start every test from a clean counter.
beforeEach(() => {
  tokenCounter.resetCalibrations();
  tokenCounter.clearCache();
  TokenCounter.clearContextLimits();
});

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

/**
 * Windows these fixtures run against, pinned rather than borrowed from the
 * family table.
 *
 * They used to ride on `anthropic/claude-sonnet-4-6`, whose window moved from
 * 200,000 to 1,000,000 when the 1M lineup landed. The fixtures did not move
 * with it: 40,000 tokens of transcript against a 300,000-token tail budget
 * fits entirely, so the budget never bound and the tiers under test were
 * reached by the minimum-head fallback rather than by the arithmetic they
 * exist to exercise. Pinning the window keeps each fixture in the regime its
 * own comment describes.
 */
const SMALL_WINDOW = "test/window-60k";
const MID_WINDOW = "test/window-200k";

describe("compactWorkingSet — tiered", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let engine: ContextEngine;

  beforeEach(() => {
    gateway = createMockGateway();
    engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);
    registerContextLimit(SMALL_WINDOW, 60_000);
    registerContextLimit(MID_WINDOW, 200_000);
  });

  /** Report authoritative usage so the engine sizes its tail against a window. */
  const noteUsage = (used: number, model = SMALL_WINDOW) => {
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

  // ─── P10.8: an evicted result must still say what it was ───

  test("an evicted result keeps a head-and-tail excerpt, not just a byte count", async () => {
    const messages: Message[] = [userMsg("Build the thing.")];
    for (let i = 0; i < 20; i++) {
      messages.push(
        toolUseMsg(`c${i}`),
        toolResultMsg(
          `c${i}`,
          `HEADLINE-${i} src/thing-${i}.ts\n${"filler ".repeat(2_000)}FAIL-${i}`,
        ),
      );
    }
    noteUsage(45_000);

    const r = await engine.compactWorkingSet(messages);

    expect(r.tier).toBe("tool_results");
    const evicted = bodiesOf(r.messages).filter((b) => b.startsWith(EVICTED));
    expect(evicted.length).toBeGreaterThan(0);
    for (const body of evicted) {
      // The two places a real tool puts what matters: the path or headline at
      // the top, the error at the bottom.
      expect(body).toMatch(/HEADLINE-\d+ src\/thing-\d+\.ts/);
      expect(body).toMatch(/FAIL-\d+/);
      // …and it is still an eviction, not a copy.
      expect(body.length).toBeLessThan(2_000);
    }
  });

  test("a result too small to be worth reclaiming is left alone", async () => {
    // A 430-byte spec read was destroyed to reclaim ~230 bytes, and its
    // contents were the decisions the whole task turned on.
    const spec = "DECISION-1: SQLite, not Postgres.\n" + "detail ".repeat(50);
    const messages: Message[] = [userMsg("Build the thing.")];
    messages.push(toolUseMsg("spec"), toolResultMsg("spec", spec));
    for (let i = 0; i < 20; i++) {
      messages.push(toolUseMsg(`c${i}`), toolResultMsg(`c${i}`, "x".repeat(15_000)));
    }
    noteUsage(45_000);

    const r = await engine.compactWorkingSet(messages);

    expect(r.tier).toBe("tool_results");
    expect(bodiesOf(r.messages)[0]).toBe(spec);
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
    noteUsage(180_000, MID_WINDOW); // 200k window

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
    const messages = Array.from({ length: 400 }, (_, i) => userMsg("z".repeat(1_600) + i));
    noteUsage(180_000, MID_WINDOW);
    const r = await engine.compactWorkingSet(messages, 6);
    const tail = r.messages.slice(-6);
    expect(tail).toEqual(messages.slice(-6));
  });

  // ─── P10.8: the count floor defeated the budget from both sides ───

  test("six tool-heavy messages do not defeat the token budget", async () => {
    // Two parallel batches of four big reads: four messages, each far larger
    // than the whole tail budget. Honouring recentK here kept 32,649 of 33,046
    // tokens and freed 1.2% — a summarizer round trip that bought nothing.
    const batchUse = (ids: string[]): Message => ({
      role: "assistant",
      content: ids.map((id) => ({
        type: "tool_use" as const,
        toolCallId: id,
        toolName: "read_file",
        toolInput: { path: id },
      })),
    });
    const batchResult = (ids: string[], chars: number): Message => ({
      role: "tool",
      content: ids.map((id) => ({
        type: "tool_result" as const,
        toolCallId: id,
        toolResultContent: "x".repeat(chars),
      })),
    });
    const messages: Message[] = [userMsg("Build the thing.")];
    for (let i = 0; i < 5; i++) {
      messages.push(batchUse([`s${i}`]), batchResult([`s${i}`], 400));
    }
    messages.push(
      batchUse(["b0", "b1", "b2", "b3"]),
      batchResult(["b0", "b1", "b2", "b3"], 15_000),
    );
    messages.push(
      batchUse(["b4", "b5", "b6", "b7"]),
      batchResult(["b4", "b5", "b6", "b7"], 15_000),
    );

    noteUsage(45_000); // 60k window → an 18k tail budget

    const r = await engine.compactWorkingSet(messages);

    expect(r.compacted).toBe(true);
    const freed = (r.beforeTokens! - r.afterTokens!) / r.beforeTokens!;
    expect(freed).toBeGreaterThan(0.15);
  });

  test("a compaction that would grow the working set is not applied", async () => {
    // The summary is longer than the handful of short messages it replaces:
    // applying it pays a round trip to make the prompt bigger and loses the
    // verbatim text as well. Measured on a real compact_context: 16,929 →
    // 16,931.
    const long = "S".repeat(4_000);
    const wordy = new ContextEngine({ summarizeTurnsThreshold: 4 }, createMockGateway(long));
    const messages = Array.from({ length: 12 }, (_, i) => userMsg(`t${i}`));

    const r = await wordy.compactWorkingSet(messages, 6, { force: true });

    expect(r.compacted).toBe(false);
    expect(r.noop).toBe(true);
    expect(r.noopReason).toMatch(/no smaller/);
  });

  test("a head that is a sliver of the working set is not worth a round trip", async () => {
    // 13 small messages in front of a large verbatim tail: 387 tokens of a
    // 20,938-token set, folded for the price of a summarizer call.
    const messages: Message[] = Array.from({ length: 13 }, (_, i) => userMsg(`note ${i}`));
    messages.push(userMsg("z".repeat(100_000)));
    noteUsage(45_000);

    const r = await engine.compactWorkingSet(messages);

    expect(r.compacted).toBe(false);
    expect(r.noop).toBe(true);
    expect(gateway.infer).not.toHaveBeenCalled();
  });

  test("an explicit compaction cuts to the recent exchange, not to 30%", async () => {
    // `compact_context` against a tail budget larger than the whole
    // conversation could only nibble the oldest few messages — 141 tokens of a
    // 5,027-token set. Force keeps the recent exchange and folds the rest.
    const messages = Array.from({ length: 20 }, (_, i) => userMsg("w".repeat(400) + i));
    noteUsage(45_000); // 18k tail budget, far larger than this transcript

    const r = await engine.compactWorkingSet(messages, 6, { force: true });

    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("summarized");
    expect(r.trigger).toBe("overflow");
    expect(r.messages).toHaveLength(7); // summary + recentK
  });

  test("the trigger says which policy produced the tail", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => userMsg("y".repeat(4_000) + i));
    noteUsage(150_000);
    const auto = await engine.compactWorkingSet(messages);
    expect(auto.trigger).toBe("auto");

    engine.requestCompaction();
    const asked = await engine.compactWorkingSet(messages);
    expect(asked.trigger).toBe("requested");
  });
});

describe("replay: the run that motivated this", () => {
  test("a 155k tool-heavy working set no longer collapses to under 1% of budget", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);

    // Shape and volume of the observed compaction: 212 messages, ~155k tokens,
    // dominated by tool results — a build loop running tests and reading files.
    const messages = toolHeavyRun(106, 6_000);
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
