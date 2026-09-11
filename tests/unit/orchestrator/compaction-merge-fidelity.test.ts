/**
 * A compaction that MERGES reads its new segment at full fidelity.
 *
 * The segment a merge is handed (`toSummarize.slice(1)`) is the previous
 * compaction's verbatim tail plus everything since — material the prior state
 * has never seen. It is that segment's one and only read, so a criterion in the
 * middle of a tool result has to survive it. P3B C1 rendered it at 900
 * characters instead of 2,400 on the reasoning that the accumulated state was
 * already carrying that history; V-C showed the reasoning was about the wrong
 * messages, and these two cases are what it proved (they were red at `dd37050`
 * and are the acceptance criteria for the fix).
 *
 * The companion contract — what MAY be clipped, and the diff exemption — is
 * pinned in `context-compaction-budget.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

function recordingGateway(summary: string) {
  const seen: string[] = [];
  const infer = mock(async (req: any) => {
    seen.push(
      (req.messages ?? [])
        .flatMap((m: any) => m.content.map((b: any) => (b.type === "text" ? b.text : "")))
        .join("\n"),
    );
    return {
      content: [{ type: "text", text: summary }],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
  return {
    seen,
    gateway: {
      infer,
      inferStream: mock(async function* () {}),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getRegisteredProviderNames: () => [],
      getTotalCost: mock(() => 0),
    } as any,
  };
}

const engine = (gw: any) =>
  new ContextEngine(
    { summarizeTurnsThreshold: 4, summarizerModel: "m", summarizerProvider: "anthropic" },
    gw,
  );

const MERGED_STATE = [
  "## Goals & requirements",
  "Wire version() through the api and the client; the acceptance check must pass.",
  "## Key facts & codebase knowledge",
  "src/api.ts and src/client.ts are separate modules.",
  "## Actions taken & outcomes (files touched, commands run)",
  "Read the notes under docs/.",
  "## Decisions & open questions",
  "None open.",
  "## Current state & next step",
  "Run node check.mjs.",
].join("\n");

/** Bulk exchanges, each with a body far past any clip, to force compaction. */
function reads(from: number, n: number): Message[] {
  const out: Message[] = [];
  for (let i = from; i < from + n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `read file ${i}` }] });
    out.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: `t${i}`,
          toolName: "read_file",
          toolInput: { path: `docs/note-${i}.md` },
        },
      ] as any,
    });
    out.push({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: `t${i}`,
          toolResultContent: `note ${i} ${"z".repeat(9_000)}`,
        },
      ] as any,
    });
  }
  return out;
}

/**
 * A 2,400-character tool result — EXACTLY the first-read budget, so a first
 * compaction returns it whole — carrying the token at characters 1,000-1,400.
 */
function specBody(token: string): string {
  const head = "A".repeat(1_000);
  const mid = token.padEnd(400, "B");
  const tail = "C".repeat(2_400 - 1_000 - 400);
  const body = head + mid + tail;
  if (body.length !== 2_400) throw new Error(`fixture is ${body.length}, not 2400`);
  return body;
}

function specExchange(id: string, toolName: string, token: string): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `check ${id}` }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          toolCallId: id,
          toolName,
          toolInput: { path: `spec/${id}.md` },
        },
      ] as any,
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, toolResultContent: specBody(token) }] as any,
    },
  ];
}

const FIRST = "SPEC-TOKEN-FIRST-SEGMENT-EXIT-ZERO-ON-EMPTY-INPUT";
const SECOND = "SPEC-TOKEN-SECOND-SEGMENT-EXIT-ZERO-ON-EMPTY-INPUT";

describe("a merge reads its new segment as the only read it will ever get", () => {
  test("a criterion in the middle of a 2,400-char result reaches the summarizer on the second compaction as well as the first", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);

    // Segment 1: the spec-bearing read is folded by the FIRST compaction.
    const first = await eng.compactWorkingSet(
      [...specExchange("s1", "read_file", FIRST), ...reads(1, 8)],
      3,
      { budgetMs: 30_000 },
    );
    expect(first.compacted).toBe(true);
    expect(first.tier).toBe("summarized");

    // Segment 2: an identically shaped read, folded by the SECOND compaction.
    const second = await eng.compactWorkingSet(
      [...first.messages, ...specExchange("s2", "read_file", SECOND), ...reads(9, 8)],
      3,
      { budgetMs: 30_000 },
    );
    expect(second.compacted).toBe(true);
    expect(second.tier).toBe("summarized");
    expect(rig.seen.length).toBe(2);

    // Both bodies were rendered: no message was dropped, exactly as claimed.
    expect(rig.seen[0]).toContain("spec/s1.md");
    expect(rig.seen[1]).toContain("spec/s2.md");
    expect(rig.seen[1]).toContain("PRIOR STATE:");

    // The first compaction READ the criterion whole.
    expect({ first_segment_criterion_reached_summarizer: rig.seen[0]!.includes(FIRST) }).toEqual({
      first_segment_criterion_reached_summarizer: true,
    }); // the control

    // The second compaction is this segment's ONE AND ONLY read — the prior
    // state cannot carry what it never saw — so the criterion has to be in it.
    expect({ second_segment_criterion_reached_summarizer: rig.seen[1]!.includes(SECOND) }).toEqual({
      second_segment_criterion_reached_summarizer: true,
    });
  });

  test("an apply_patch result keeps its middle — that is where the change is", async () => {
    const rig = recordingGateway(MERGED_STATE);
    const eng = engine(rig.gateway);
    const first = await eng.compactWorkingSet(reads(1, 8), 3, { budgetMs: 30_000 });
    expect(first.compacted).toBe(true);
    const second = await eng.compactWorkingSet(
      [...first.messages, ...specExchange("p2", "apply_patch", SECOND), ...reads(9, 8)],
      3,
      { budgetMs: 30_000 },
    );
    expect(second.compacted).toBe(true);
    expect(rig.seen[1]).toContain("[tool: apply_patch(");
    // The change the patch carried lives in the middle of its own result.
    expect({ patch_middle_reached_summarizer: rig.seen[1]!.includes(SECOND) }).toEqual({
      patch_middle_reached_summarizer: true,
    });
  });
});
