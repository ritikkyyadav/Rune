/**
 * Phase-5 (Crown Flow): the agent's words stream LIVE in the pinned preview.
 * Pre-fix, text_delta was buffered into a string and released only at
 * finish() — the most-watched moment of a turn showed a bare status rung
 * while the desktop app streamed the same events live.
 */

import { describe, test, expect } from "bun:test";
import { TurnRenderer } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

function makeRenderer() {
  const commits: string[] = [];
  let preview: string[] | null = null;
  const r = new TurnRenderer(
    {
      commit: (b: string) => commits.push(b),
      preview: (l: string[] | null) => {
        preview = l;
      },
    },
    {},
  );
  return { r, commits, previewText: () => (preview ?? []).map((l) => stripAnsi(l)).join("\n") };
}

describe("live prose streaming", () => {
  test("mid-turn narration is visible in the live preview as it streams", () => {
    const { r, previewText } = makeRenderer();
    r.onEvent({ type: "text_delta", text: "Found it: the timer is cleared " } as any);
    r.onEvent({ type: "text_delta", text: "before the await, so nothing guards the gap." } as any);
    // Force a repaint past the throttle window.
    (r as any).lastProseLiveAt = 0;
    (r as any).updateLive?.() ?? (r as any).onEvent({ type: "text_delta", text: " " });
    expect(previewText()).toContain("Found it: the timer is cleared");
  });

  test("only the tail of a long answer is previewed, marked as clipped", () => {
    const { r, previewText } = makeRenderer();
    r.onEvent({ type: "text_delta", text: "intro sentence. ".repeat(120) } as any);
    r.onEvent({ type: "text_delta", text: "THE FINAL SENTENCE." } as any);
    (r as any).lastProseLiveAt = 0;
    r.onEvent({ type: "text_delta", text: " " } as any);
    const p = previewText();
    expect(p).toContain("THE FINAL SENTENCE.");
    expect(p).toContain("…");
    // Bounded: rung + up to 4 prose lines.
    expect(p.split("\n").length).toBeLessThanOrEqual(6);
  });

  test("the full answer still lands in scrollback at finish", () => {
    const { r, commits } = makeRenderer();
    r.onEvent({ type: "text_delta", text: "the complete answer" } as any);
    r.finish({});
    expect(commits.join("\n")).toContain("the complete answer");
  });
});
