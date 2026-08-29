/**
 * What a sub-agent actually hands back to the agent that dispatched it.
 *
 * Three defects lived here, and all three survived the full suite because
 * nothing asserted on the SHAPE of the returned text — only that it was
 * non-empty.
 *
 *  1. The summary was `finalText += event.text` across the WHOLE run, never
 *     reset and never separated. What came back was the scout's entire running
 *     commentary glued end to end ("…verify invariants.No tests exist. Now let
 *     me look at…"), so the parent read abandoned hypotheses and their own
 *     retractions as findings and wrote them into the user's report. The
 *     summary is the text after the LAST tool call — nothing else.
 *  2. `fallback` events hit the `default:` arm and vanished. A scout demoted
 *     mid-run from the session's frontier model to a free fallback reported in
 *     exactly the same voice, and neither the parent nor the user could tell.
 *  3. `stream_reset` was ignored, so a re-streamed turn appended its text twice.
 */

import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";
import { createSubagentTool } from "../../../packages/orchestrator/src/subagent";

function readTool(name: string): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async (i) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: "file contents",
      durationMs: 0,
    }),
  };
}

/**
 * A scout that behaves exactly like the recorded failure: it narrates on the
 * way to every tool call, then writes its real summary in a final text-only
 * turn. `script` is one entry per turn; a `read` turn ends on a tool call.
 */
type Turn = { text: string; read?: string };

class ScriptedProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  turn = 0;
  /** Every request body the loop sent — used to inspect injected context. */
  readonly requests: InferenceRequest[] = [];
  constructor(
    private readonly script: Turn[],
    private readonly pre?: StreamEvent[],
  ) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(req: InferenceRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const step = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn++;
    yield { type: "message_start", messageId: `m${this.turn}` };
    if (this.turn === 1 && this.pre) for (const e of this.pre) yield e;
    if (step.text) {
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: step.text },
      };
    }
    if (step.read) {
      const id = `call_${this.turn}`;
      yield { type: "tool_use_start", toolCallId: id, toolName: "read_file" };
      yield { type: "tool_use_stop", toolCallId: id, toolInput: { path: step.read } };
      yield {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return;
    }
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function subagentFor(provider: LlmProvider) {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: provider.name,
    maxRetries: 0,
    retryBaseMs: 1,
  });
  gw.registerProvider(provider);
  const registry = new ToolRegistry();
  registry.register(readTool("read_file"));
  return createSubagentTool({
    gateway: gw,
    registry,
    model: "frontier-model",
    provider: "anthropic",
  });
}

const run = (tool: ToolHandler, args: Record<string, unknown> = { prompt: "audit src/" }) =>
  tool.execute({
    toolName: "task",
    callId: "c1",
    sessionId: "s1",
    workspaceRoot: "/tmp",
    args,
  });

// The shape that produced the bug: narration before each tool call, then the
// real report last.
const NARRATED: Turn[] = [
  { text: "Now let me look at the cache to understand how science is used.", read: "src/cache.ts" },
  { text: "Critical issue spotted: this looks wrong.", read: "src/ncbi.ts" },
  { text: "So fetchCds is correct after all. Good.", read: "src/align.ts" },
  { text: "FINDING: cache.ts:44 joins an unvalidated fingerprint into a path." },
];

describe("the summary is the text after the last tool call", () => {
  test("the final report comes back", async () => {
    const out = await run(subagentFor(new ScriptedProvider(NARRATED)));
    expect(out.success).toBe(true);
    expect(out.result).toContain("cache.ts:44 joins an unvalidated fingerprint");
  });

  test("inter-tool narration does NOT come back", async () => {
    const out = await run(subagentFor(new ScriptedProvider(NARRATED)));
    expect(out.result).not.toContain("Now let me look at the cache");
    expect(out.result).not.toContain("So fetchCds is correct");
  });

  test("a retracted hypothesis cannot reach the parent as a finding", async () => {
    // The exact failure: a provisional "Critical issue spotted" and its own
    // retraction three turns later both landed in the parent's context, and
    // the parent had no way to tell either from a real finding.
    const out = await run(subagentFor(new ScriptedProvider(NARRATED)));
    expect(out.result).not.toContain("Critical issue spotted");
  });

  test("sentences from different turns are never glued together", async () => {
    // "…verify invariants.No tests exist." — the signature of concatenation
    // with no separator. No sentence-end may abut a capital with no space.
    const out = await run(subagentFor(new ScriptedProvider(NARRATED)));
    expect(out.result).not.toMatch(/[a-z]\.[A-Z]/);
  });

  test("a run that ends on a tool call returns the partial report, not narration", async () => {
    // Text before a tool call is working narration. If that is all there is,
    // the honest answer is the ground-covered report — never the narration
    // dressed up as an answer.
    const endsOnTool: Turn[] = [
      { text: "Let me check the config.", read: "src/a.ts" },
      { text: "And now the routes.", read: "src/b.ts" },
    ];
    const out = await run(subagentFor(new ScriptedProvider(endsOnTool)), {
      prompt: "find it",
      effort: "quick",
    });
    expect(out.result).toContain("INCOMPLETE");
    expect(out.result).not.toContain("And now the routes");
  });

  test("a re-streamed turn is not counted twice", async () => {
    // stream_reset means the provider abandoned the message and is sending it
    // again; keeping the discarded half duplicated the summary.
    const provider = new ScriptedProvider([{ text: "THE REPORT." }], [{ type: "stream_reset" }]);
    const out = await run(subagentFor(provider));
    expect(out.result.match(/THE REPORT\./g)?.length).toBe(1);
  });
});

describe("a mid-run model swap is declared, not hidden", () => {
  const swap: StreamEvent[] = [
    {
      type: "fallback",
      from: { provider: "codex", model: "gpt-5.6-sol" },
      to: { provider: "google", model: "gemini-2.5-flash" },
      reason: "429 The usage limit has been reached",
    } as StreamEvent,
  ];

  test("the result names the model that actually served the run", async () => {
    const out = await run(
      subagentFor(new ScriptedProvider([{ text: "FINDING: something." }], swap)),
    );
    expect(out.result).toContain("PROVENANCE");
    expect(out.result).toContain("google/gemini-2.5-flash");
    expect(out.result).toContain("429 The usage limit has been reached");
  });

  test("it tells the parent the findings are unverified", async () => {
    const out = await run(
      subagentFor(new ScriptedProvider([{ text: "FINDING: something." }], swap)),
    );
    expect(out.result).toContain("UNVERIFIED");
  });

  test("the banner leads the result so it cannot be missed", async () => {
    const out = await run(
      subagentFor(new ScriptedProvider([{ text: "FINDING: something." }], swap)),
    );
    expect(out.result.startsWith("[PROVENANCE")).toBe(true);
  });

  test("a run that never swapped carries no banner", async () => {
    const out = await run(subagentFor(new ScriptedProvider([{ text: "FINDING: something." }])));
    expect(out.result).not.toContain("PROVENANCE");
  });

  test("a partial report also carries the banner", async () => {
    // The demoted-and-out-of-turns case is the worst one to report silently.
    const provider = new ScriptedProvider([{ text: "looking…", read: "src/a.ts" }], swap);
    const out = await run(subagentFor(provider), { prompt: "survey", effort: "quick" });
    expect(out.result).toContain("PROVENANCE");
    expect(out.result).toContain("INCOMPLETE");
  });
});

describe("the scout can see the clock it was told to watch", () => {
  test("every request carries the turn budget", async () => {
    const provider = new ScriptedProvider([{ text: "done." }]);
    await run(subagentFor(provider), { prompt: "find X", effort: "quick" });
    const tail = JSON.stringify(provider.requests[0].messages.at(-1));
    expect(tail).toContain("Budget: turn 1 of 8");
  });

  test("the count advances with the run", async () => {
    const provider = new ScriptedProvider([
      { text: "a", read: "src/a.ts" },
      { text: "b", read: "src/b.ts" },
      { text: "done." },
    ]);
    await run(subagentFor(provider), { prompt: "find X", effort: "quick" });
    expect(JSON.stringify(provider.requests[2].messages.at(-1))).toContain("Budget: turn 3 of 8");
  });

  test("the last two turns escalate to 'write up now'", async () => {
    // A budget line the scout reads too late is the same as no budget line.
    const provider = new ScriptedProvider([{ text: "still looking", read: "src/a.ts" }]);
    await run(subagentFor(provider), { prompt: "survey", effort: "quick" });
    const lastRequest = provider.requests.at(-1)!;
    const tail = JSON.stringify(lastRequest.messages.at(-1));
    expect(tail).toContain("WRAP UP NOW");
  });
});
