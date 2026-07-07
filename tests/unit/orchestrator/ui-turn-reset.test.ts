/**
 * TurnRenderer stream_reset: a mid-stream provider retry re-streams the
 * response from scratch — the partial prose/thinking must be dropped or the
 * final answer renders doubled.
 */

import { describe, it, expect } from "bun:test";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

function harness() {
  const commits: string[] = [];
  const sink: TurnSink = {
    commit: (b) => commits.push(b),
    preview: () => {},
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return { commits, turn, plain: () => stripAnsi(commits.join("\n")) };
}

describe("TurnRenderer — stream_reset", () => {
  it("drops partial prose so the re-streamed answer isn't doubled", () => {
    const h = harness();
    h.turn.onEvent({ type: "text_delta", text: "HALF-ANSWER that got cut " });
    h.turn.onEvent({ type: "stream_reset" });
    h.turn.onEvent({ type: "text_delta", text: "The clean final answer." });
    h.turn.onEvent({ type: "turn_complete", totalTurns: 1 });
    h.turn.finish();

    const out = h.plain();
    expect(out).toContain("The clean final answer.");
    expect(out).not.toContain("HALF-ANSWER");
  });

  it("drops partial thinking too", () => {
    const h = harness();
    h.turn.onEvent({ type: "thinking_delta", text: "half a thought" });
    h.turn.onEvent({ type: "stream_reset" });
    h.turn.onEvent({ type: "text_delta", text: "Answer." });
    h.turn.onEvent({ type: "turn_complete", totalTurns: 1 });
    h.turn.finish();

    expect(h.plain()).toContain("Answer.");
  });
});
