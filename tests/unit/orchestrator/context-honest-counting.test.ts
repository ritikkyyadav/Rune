/**
 * Phase-1 regression tests: honest token counting + summarizer fidelity +
 * loud compaction failure + summarizer input cap.
 *
 * Each of these FAILS on the pre-fix code:
 *  - buildPrompt used to count tool results at ≤500 chars (60× undercount on
 *    tool-heavy sessions), so compaction never fired before provider rejection.
 *  - The summarizer was fed the same mutilated transcript, so file paths,
 *    commands, and error text were amputated before summarization.
 *  - generateSummary failures were swallowed by a bare catch — compaction
 *    failed silently and the run later died of context overflow.
 *  - The summarizer request itself had no input cap, so compacting a long
 *    session could overflow the summarizer too.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import { tokenCounter } from "../../../packages/orchestrator/src/tokenizer";
import type { Message } from "../../../packages/llm-gateway/src/types";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolPair(id: string, resultContent: string, path = "/tmp/x.ts"): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", toolCallId: id, toolName: "read_file", toolInput: { path } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, toolResultContent: resultContent }],
    },
  ];
}

/** Mock gateway that records every infer() request it receives. */
function capturingGateway(behavior?: { throwWith?: string; summary?: string }) {
  const requests: Array<{ userText: string; model: string; provider: string }> = [];
  return {
    requests,
    infer: mock(async (req: any) => {
      const textBlock = req.messages[0]?.content?.find((b: any) => b.type === "text");
      requests.push({ userText: textBlock?.text ?? "", model: req.model, provider: req.provider });
      if (behavior?.throwWith) throw new Error(behavior.throwWith);
      return {
        id: "r",
        content: [
          { type: "text" as const, text: behavior?.summary ?? "## Goals & requirements\nok" },
        ],
        model: req.model,
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }),
  } as any;
}

beforeEach(() => {
  // The shared counter carries per-model calibration between tests — reset so
  // counts here are the raw heuristic.
  tokenCounter.resetCalibrations();
});

describe("honest token counting (buildPrompt)", () => {
  test("a large tool result is counted at full size, not 500 chars", () => {
    const engine = new ContextEngine({}, capturingGateway());
    const big = "x ".repeat(6000); // 12,000 chars ≈ ≥3,000 tokens
    const messages: Message[] = [userMsg("read the file"), ...toolPair("t1", big)];
    const built = engine.buildPrompt("sys", [], messages);
    // Old behavior: result counted at ≤500 chars → total well under 500 tokens.
    expect(built.totalTokens).toBeGreaterThan(2500);
  });

  test("thinking blocks are counted, not treated as empty", () => {
    const engine = new ContextEngine({}, capturingGateway());
    const thinking = "reason ".repeat(2000); // 14,000 chars
    const messages: Message[] = [
      userMsg("hi"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking },
          { type: "text", text: "ok" },
        ],
      },
    ];
    const built = engine.buildPrompt("sys", [], messages);
    expect(built.totalTokens).toBeGreaterThan(2500);
  });
});

describe("summarizer transcript fidelity", () => {
  test("the tail of a long error result survives into the summarizer prompt", async () => {
    const gw = capturingGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gw);
    const errorOutput = "error line\n".repeat(260) + "FINAL_ERROR_MARKER_XYZ"; // ~2.9k chars
    const messages: Message[] = [
      userMsg("run the tests"),
      ...toolPair("t1", errorOutput),
      ...toolPair("t2", "ok"),
      ...plain(8),
    ];
    const res = await engine.compactWorkingSet(messages);
    expect(res.compacted).toBe(true);
    // Old behavior: tool results cut at 500 head chars — the marker (at the
    // very end) never reached the summarizer.
    expect(gw.requests[0].userText).toContain("FINAL_ERROR_MARKER_XYZ");
  });

  test("tool call paths survive into the summarizer prompt", async () => {
    const gw = capturingGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gw);
    const messages: Message[] = [
      userMsg("edit it"),
      ...toolPair("t1", "done", "/repo/src/deeply/nested/target-file.ts"),
      ...plain(10),
    ];
    await engine.compactWorkingSet(messages);
    expect(gw.requests[0].userText).toContain("target-file.ts");
  });
});

describe("loud compaction failure", () => {
  test("summarizer failure returns failed:true with the real reason", async () => {
    const gw = capturingGateway({ throwWith: "429 quota exhausted" });
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gw);
    const res = await engine.compactWorkingSet(plain(12));
    expect(res.compacted).toBe(false);
    expect(res.failed).toBe(true);
    expect(res.failureReason).toContain("429 quota exhausted");
    expect(engine.getLastSummaryFailure()).toContain("429 quota exhausted");
  });

  test("a quiet no-op (below threshold) is NOT marked failed", async () => {
    const gw = capturingGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gw);
    const res = await engine.compactWorkingSet(plain(4));
    expect(res.compacted).toBe(false);
    expect(res.failed).toBeUndefined();
  });
});

describe("summarizer input cap", () => {
  test("a huge transcript is clipped to the summarizer model's window, newest kept", async () => {
    const gw = capturingGateway();
    // llama3 → 8,192-token context → transcript budget ~4.5k tokens (~18k chars).
    const engine = new ContextEngine(
      { summarizeTurnsThreshold: 4, summarizerModel: "llama3", summarizerProvider: "ollama" },
      gw,
    );
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(userMsg(`OLDMSG_${i} ` + "filler ".repeat(180))); // ~1.3k chars each
    }
    messages.push(userMsg("NEWEST_MESSAGE_SENTINEL"));
    messages.push(...plain(6)); // verbatim tail
    const res = await engine.compactWorkingSet(messages);
    expect(res.compacted).toBe(true);
    const sent = gw.requests[0].userText;
    expect(sent).toContain("older messages omitted");
    expect(sent).toContain("NEWEST_MESSAGE_SENTINEL"); // newest summarized msg kept
    expect(sent).not.toContain("OLDMSG_0 "); // oldest dropped
    expect(sent.length).toBeLessThan(30_000); // bounded, vs ~55k unclipped
  });
});

/** Plain alternating filler turns. */
function plain(n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? userMsg(`turn ${i}`) : assistantMsg(`reply ${i}`),
  );
}
