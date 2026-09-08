/**
 * `completions.governance` — the retro's account of how many model calls a run
 * actually made, and how many of them were Rune's own.
 *
 * `completions` counts assistant messages, so it counts the WORK and nothing
 * else: the safety classifier, the compaction summarizer, the intent read and
 * the sub-agent report repair never appear in it. On a free tier that omission
 * is the whole story, because the thing being metered is requests.
 */

import { describe, expect, test } from "bun:test";
import { deriveRunRetro, foldTurnRetros } from "../../../packages/orchestrator/src/retro";
import type { EventRow, RunRetro } from "../../../packages/orchestrator/src/retro";

let seq = 0;
const row = (type: string, payload: Record<string, unknown>): EventRow => ({
  seq: ++seq,
  event: { type, payload },
});

const cost = (over: Record<string, unknown> = {}): EventRow =>
  row("cost", {
    costUsd: 0,
    listCostUsd: 0.01,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...over,
  });

const assistant = (): EventRow =>
  row("assistant_msg", { content: "done", toolUses: [], contentBlocks: [] });

describe("callsByRole", () => {
  test("splits the run's completions into work and governance", () => {
    seq = 0;
    const r = deriveRunRetro([
      row("user_msg", { content: "add a parser" }),
      assistant(),
      cost({ role: "primary", inputTokens: 20_000 }),
      cost({ role: "classifier", inputTokens: 34_000 }),
      cost({ role: "summarizer", inputTokens: 30_000 }),
      cost({ role: "subagent", inputTokens: 5_000 }),
    ])!;

    expect(r.callsByRole).toBeDefined();
    expect(r.callsByRole!.total).toBe(4);
    expect(r.callsByRole!.governance).toBe(2);
    // A sub-agent's turn is delegated WORK, not overhead.
    expect(r.callsByRole!.primary).toBe(2);
    expect(r.callsByRole!.fresh).toBe(89_000);
    expect(r.callsByRole!.governanceFresh).toBe(64_000);

    // The transcript-derived count is untouched, and it is a DIFFERENT number:
    // one assistant message, four requests. That gap is the finding.
    expect(r.completions).toBe(1);
  });

  test("a cost row with no role is the work — every row written before P12.1", () => {
    seq = 0;
    const r = deriveRunRetro([assistant(), cost(), cost({ role: "classifier" })])!;
    expect(r.callsByRole!.primary).toBe(1);
    expect(r.callsByRole!.governance).toBe(1);
  });

  test("absent, not zeroed, when the window carried no cost rows", () => {
    seq = 0;
    const r = deriveRunRetro([row("user_msg", { content: "hi" }), assistant()])!;
    // "Not measured" and "made no calls" are different facts, and an eval gate
    // must never read a missing meter as a perfect score.
    expect(r.callsByRole).toBeUndefined();
  });

  test("the cache read ratio is absent when no input was reported at all", () => {
    seq = 0;
    const none = deriveRunRetro([
      assistant(),
      cost({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ])!;
    expect(none.callsByRole!.cacheReadRatio).toBeUndefined();

    seq = 0;
    const warm = deriveRunRetro([
      assistant(),
      cost({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 0 }),
    ])!;
    expect(warm.callsByRole!.cacheReadRatio).toBeCloseTo(0.75);
  });
});

describe("folding turn retros into a session", () => {
  const turnRetro = (over: Partial<RunRetro>): RunRetro => ({
    v: 1,
    at: "2026-09-08T00:00:00.000Z",
    outcome: "finished",
    scope: "turn",
    steps: { total: 0, done: 0, unproven: 0, open: 0 },
    checks: { passed: 0, failed: 0 },
    tools: { calls: 0, failed: 0, byName: {} },
    gates: {},
    completions: 1,
    filesWritten: 0,
    cost: { usd: 0, listUsd: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
    lessons: [],
    ...over,
  });

  test("governance completions sum across a session's turns", () => {
    const folded = foldTurnRetros([
      turnRetro({
        callsByRole: {
          total: 4,
          primary: 2,
          governance: 2,
          fresh: 40_000,
          governanceFresh: 30_000,
          cacheReadRatio: 0.5,
        },
      }),
      turnRetro({
        callsByRole: {
          total: 6,
          primary: 5,
          governance: 1,
          fresh: 60_000,
          governanceFresh: 10_000,
          cacheReadRatio: 1,
        },
      }),
    ])!;
    expect(folded.callsByRole!.total).toBe(10);
    expect(folded.callsByRole!.governance).toBe(3);
    expect(folded.callsByRole!.fresh).toBe(100_000);
    // Completion-WEIGHTED, so a six-call turn is not averaged flat against a
    // four-call one: (0.5·4 + 1·6) / 10.
    expect(folded.callsByRole!.cacheReadRatio).toBeCloseTo(0.8);
  });

  test("a session of turns that measured nothing reports nothing", () => {
    const folded = foldTurnRetros([turnRetro({}), turnRetro({})])!;
    expect(folded.callsByRole).toBeUndefined();
  });
});
