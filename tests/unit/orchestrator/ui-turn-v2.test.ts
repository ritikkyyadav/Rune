/**
 * TurnRenderer v2 metadata: real ↓ tokens in the live/completion meta,
 * thinking time, the fallback banner + model-switch counter, the one-per-event
 * compaction line, and the checkpoint receipt (+ /rewind hint) in the summary
 * strip. Uses the same sink harness as ui-turn.test.ts.
 */

import { describe, test, expect } from "bun:test";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

function harness() {
  const commits: string[] = [];
  const previews: (string[] | null)[] = [];
  const sink: TurnSink = { commit: (b) => commits.push(b), preview: (l) => previews.push(l) };
  const turn = new TurnRenderer(sink, { getCost: () => 0.01 });
  return {
    commits,
    previews,
    turn,
    output: () => stripAnsi(commits.join("\n")),
    preview: () => stripAnsi((previews.at(-1) ?? []).join("\n")),
  };
}

const editEnd = (path: string) => ({
  type: "tool_call_end",
  callId: "c1",
  args: { path },
  output: {
    toolName: "edit_file",
    success: true,
    durationMs: 5,
    result: JSON.stringify({ path, diff: "@@ -1 +1 @@\n-a\n+b\n+c" }),
  },
});

describe("turn v2 metadata", () => {
  test("usage events surface real ↓ tokens in the live meta and completion row", () => {
    const h = harness();
    h.turn.onEvent({ type: "usage", inputTokens: 900, outputTokens: 1800 });
    expect(h.preview()).toContain("↓ 1.8k tokens");
    h.turn.onEvent({ type: "usage", inputTokens: 100, outputTokens: 200 });
    h.turn.onEvent(editEnd("src/a.ts")); // makes the turn "worked" so completion commits
    h.turn.finish();
    expect(h.output()).toContain("↓ 2.0k tokens"); // 1800 + 200, accumulated
  });

  test("thinking time accumulates across delta bursts and prints once ≥100ms", () => {
    const h = harness();
    const realNow = Date.now;
    let t = 1_000_000;
    // Two bursts 250ms apart, then a >3s gap that must NOT count as thinking.
    try {
      Date.now = () => t;
      h.turn.onEvent({ type: "thinking_delta", text: "…" });
      t += 250;
      h.turn.onEvent({ type: "thinking_delta", text: "…" });
      t += 10_000;
      h.turn.onEvent({ type: "thinking_delta", text: "…" });
      h.turn.onEvent(editEnd("src/a.ts"));
      h.turn.finish();
    } finally {
      Date.now = realNow;
    }
    expect(h.output()).toContain("thought for 0.3s");
    expect(h.output()).not.toContain("thought for 10");
  });

  test("a typed fallback event renders the banner and counts as a model switch", () => {
    const h = harness();
    h.turn.onEvent({
      type: "fallback",
      from: { provider: "anthropic", model: "claude-x" },
      to: { provider: "openrouter", model: "qwen3" },
      status: 429,
      reason: "rate limited",
    });
    h.turn.onEvent(editEnd("src/a.ts"));
    h.turn.finish();
    const out = h.output();
    expect(out).toContain("provider degraded — rerouted mid-turn");
    expect(out).toContain("1 model switch");
  });

  test("one compaction event → exactly one compacted receipt", () => {
    const h = harness();
    h.turn.onEvent({
      type: "compaction",
      beforeTokens: 82_000,
      afterTokens: 51_000,
      limitTokens: 100_000,
    });
    h.turn.onEvent(editEnd("src/a.ts"));
    h.turn.finish();
    const matches = h.output().match(/✓ compacted/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(h.output()).toContain("82% → 51%");
  });

  test("checkpoint receipt lands in the summary strip with the /rewind hint", () => {
    const h = harness();
    h.turn.onEvent(editEnd("src/auth/session.ts"));
    h.turn.onEvent({ type: "checkpoint_saved", runId: "s1-123", version: 2, turnCount: 3 });
    h.turn.onEvent({ type: "turn_complete", stopReason: "end_turn", totalTurns: 3 });
    h.turn.finish();
    const out = h.output();
    expect(out).toContain("│ changed  1 file");
    expect(out).toContain("/rewind to roll back");
  });

  test("no checkpoint → no checkpoint line, and no invented tokens", () => {
    const h = harness();
    h.turn.onEvent(editEnd("src/a.ts"));
    h.turn.finish();
    expect(h.output()).not.toContain("checkpoint");
    expect(h.output()).not.toContain("↓ ");
  });
});
