import { describe, test, expect } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "@alan/llm-gateway";

// ─── P2: summary-of-summary degradation ───
//
// Before this fix, compactWorkingSet fed the previous compaction's
// "[Earlier conversation summary]" message back through the summarizer as
// ordinary transcript. Prose summarizing prose is recursively lossy: by the
// third compaction the session's original goals had been paraphrased away.
// The fix extracts the prior summary as STATE and asks the summarizer to
// merge the new segment into it, never to re-compress it.
//
// The fake summarizer here is deterministic and mimics a faithful merger: it
// echoes back every distinctive `tok_*` token present anywhere in its request
// (prior state + new transcript). A token from turn 1 can therefore only
// appear in compaction 3's output if it survived through the prior-state
// channel — exactly the invariant the fix guarantees.

class FakeMergeGateway {
  requests: string[] = [];

  async infer(req: {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const text = req.messages[0]?.content?.find((b) => b.type === "text")?.text ?? "";
    this.requests.push(text);
    const tokens = [...new Set([...text.matchAll(/tok_[a-z0-9]+/g)].map((m) => m[0]))];
    return {
      content: [{ type: "text", text: `## Current state & next step\n${tokens.join(" ")}` }],
    };
  }

  getRegisteredProviderNames(): string[] {
    return [];
  }
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** A filler exchange so each round has enough messages to compact. */
function exchange(tag: string, n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push(user(`question ${tag}-${i}`), assistant(`answer ${tag}-${i}`));
  }
  return out;
}

function makeEngine(gateway: FakeMergeGateway): ContextEngine {
  // Low threshold so small synthetic transcripts compact without force.
  return new ContextEngine({ summarizeTurnsThreshold: 8 }, gateway as never);
}

describe("compaction summary-of-summary degradation (P2)", () => {
  test("facts from the first segment survive three successive compactions", async () => {
    const gateway = new FakeMergeGateway();
    const engine = makeEngine(gateway);

    // Round 1: 20 messages, the very first carries the session goal.
    let messages: Message[] = [
      user("The goal is tok_originalgoal — refactor the auth module."),
      assistant("Understood: tok_originalgoal."),
      ...exchange("r1", 9),
    ];
    const c1 = await engine.compactWorkingSet(messages, 6);
    expect(c1.compacted).toBe(true);
    messages = c1.messages;

    // Round 2: new work arrives, then compaction runs again.
    messages = [...messages, user("New finding: tok_secondfact."), ...exchange("r2", 9)];
    const c2 = await engine.compactWorkingSet(messages, 6);
    expect(c2.compacted).toBe(true);
    messages = c2.messages;

    // Round 3.
    messages = [...messages, user("Also: tok_thirdfact."), ...exchange("r3", 9)];
    const c3 = await engine.compactWorkingSet(messages, 6);
    expect(c3.compacted).toBe(true);
    messages = c3.messages;

    // (a) No recursive loss: the final summary still carries the round-1 goal
    // and everything since.
    const summary = messages[0];
    expect(summary.role).toBe("user");
    const summaryText = summary.content[0].type === "text" ? summary.content[0].text : "";
    expect(summaryText).toContain("tok_originalgoal");
    expect(summaryText).toContain("tok_secondfact");
    expect(summaryText).toContain("tok_thirdfact");

    // (b) Exactly one summary message exists in the working set.
    const summaryCount = messages.filter(
      (m) =>
        m.role === "user" &&
        m.content[0]?.type === "text" &&
        m.content[0].text.startsWith("[Earlier conversation summary]"),
    ).length;
    expect(summaryCount).toBe(1);

    // (c) The prior summary was merged as STATE, never re-fed as transcript:
    // no summarizer request after the first may contain the marker text, and
    // merge requests must carry the PRIOR STATE channel.
    expect(gateway.requests.length).toBe(3);
    expect(gateway.requests[0]).not.toContain("PRIOR STATE");
    for (const later of gateway.requests.slice(1)) {
      expect(later).toContain("PRIOR STATE:");
      expect(later).not.toContain("[Earlier conversation summary]");
    }

    // (d) Session memory holds only the latest summary (no unbounded growth).
    expect(engine.getMemory().summaries.length).toBe(1);
    expect(engine.getMemory().summaries[0].summary).toContain("tok_originalgoal");
  });

  test("/compress-style [Conversation summary] heads are merged too", async () => {
    const gateway = new FakeMergeGateway();
    const engine = makeEngine(gateway);

    const messages: Message[] = [
      user("[Conversation summary]\nAccumulated: tok_fromcompress."),
      ...exchange("post", 10),
    ];
    const { compacted, messages: out } = await engine.compactWorkingSet(messages, 6);
    expect(compacted).toBe(true);
    const text = out[0].content[0].type === "text" ? out[0].content[0].text : "";
    expect(text).toContain("tok_fromcompress");
    expect(gateway.requests[0]).toContain("PRIOR STATE:");
    expect(gateway.requests[0]).not.toContain("[Conversation summary]");
  });

  test("a window containing ONLY the prior summary does not compact", async () => {
    const gateway = new FakeMergeGateway();
    const engine = makeEngine(gateway);

    // Force + tiny recentK so the cut lands right after the summary head:
    // there is nothing new to fold in, so compaction must decline rather than
    // launder the old summary through the model again.
    const messages: Message[] = [
      user("[Earlier conversation summary]\nAccumulated: tok_state."),
      user("latest question"),
      assistant("latest answer"),
    ];
    const { compacted } = await engine.compactWorkingSet(messages, 2, { force: true });
    expect(compacted).toBe(false);
    expect(gateway.requests.length).toBe(0);
  });

  test("tool_use/tool_result pairing survives compaction around the cut", async () => {
    const gateway = new FakeMergeGateway();
    const engine = makeEngine(gateway);

    const toolPair: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", toolCallId: "call_1", toolName: "read_file", toolInput: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call_1", toolResultContent: "ok", isError: false },
        ],
      },
    ];
    const messages: Message[] = [...exchange("head", 5), ...toolPair, ...exchange("tail", 2)];

    const { compacted, messages: out } = await engine.compactWorkingSet(messages, 5);
    expect(compacted).toBe(true);

    // Every tool_use kept verbatim must have its tool_result kept too.
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const m of out) {
      for (const b of m.content) {
        if (b.type === "tool_use") uses.add(b.toolCallId);
        if (b.type === "tool_result") results.add(b.toolCallId);
      }
    }
    for (const id of uses) expect(results.has(id)).toBe(true);
    for (const id of results) expect(uses.has(id)).toBe(true);
  });
});
