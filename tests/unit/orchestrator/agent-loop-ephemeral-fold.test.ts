/**
 * The ephemeral tail's wire shape per host.
 *
 * Every host but Codex takes the plan ledger / team / budget blocks as
 * trailing user messages. The Codex Responses backend stops extending its
 * prompt cache once a tool-loop request ends on a user message (measured
 * 2026-09-10 on gpt-5.6-sol; Pilots G and H stalled for 16 and 9 completions),
 * so there the same text rides inside the last stable message and the
 * request still ends on the tool output the model is about to read.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop, withTailFolded } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { Message } from "../../../packages/llm-gateway/src/types";
import { foldsEphemeralTail } from "../../../packages/llm-gateway/src/providers/cache-policy";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

/** Scripted gateway that captures every request as the provider would see it. */
function makeGateway(turns: Step[]) {
  let i = 0;
  const requests: Array<{ messages: Message[]; composition?: Record<string, number> }> = [];
  return {
    requests,
    inferStream: mock(async function* (req: any) {
      requests.push({ messages: req.messages, composition: req.composition });
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: t.args ?? {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, provider: string, taskState: TaskStateStore) {
  return new AgentLoop(
    {
      model: "m",
      provider,
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
    } as any,
    gateway,
    makeRegistry(),
  );
}

const PLAN: Step[] = [
  { tool: "todo_write", args: { items: [{ content: "step one", status: "in_progress" }] } },
  { tool: "read_file", args: { path: "a.ts" } },
  { text: "done" },
];

async function runOn(provider: string) {
  const gw = makeGateway(PLAN);
  await collect(
    makeLoop(gw, provider, new TaskStateStore()).run("do a multi step thing", "s1", "/tmp"),
  );
  return gw.requests as Array<{ messages: Message[]; composition?: Record<string, number> }>;
}

describe("withTailFolded", () => {
  const blocks = ["[Task state — maintained by the harness, not a user message]\nTodos (0/1 done)"];

  test("after tool results, the tail rides at the end of the last tool output", () => {
    const stored: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", toolCallId: "c1", toolName: "read_file", toolInput: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "c1", toolResultContent: "contents" },
          { type: "image", mediaType: "image/png", data: "AAAA" },
        ],
      },
    ];
    const before = JSON.stringify(stored);
    const wired = withTailFolded(stored, blocks);
    expect(wired).toHaveLength(3);
    const last = wired[2]!;
    expect(last.role).toBe("tool");
    const result = last.content[0]!;
    expect(result.type).toBe("tool_result");
    expect((result as any).toolResultContent).toBe(`contents\n\n${blocks[0]}`);
    // The image block after the result is untouched, and nothing stored moved.
    expect(last.content[1]).toEqual(stored[2]!.content[1]);
    expect(JSON.stringify(stored)).toBe(before);
  });

  test("on the opening request the tail joins the user's own message", () => {
    const stored: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const wired = withTailFolded(stored, blocks);
    expect(wired).toHaveLength(1);
    expect(wired[0]!.content.map((b) => b.type)).toEqual(["text", "text"]);
    expect((wired[0]!.content[1] as any).text).toBe(blocks[0]);
    expect(stored[0]!.content).toHaveLength(1);
  });

  test("with nothing to ride on, it falls back to the user message every host takes", () => {
    const stored: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "report" }] },
    ];
    const wired = withTailFolded(stored, ["a", "b"]);
    expect(wired).toHaveLength(3);
    expect(wired[2]).toEqual({ role: "user", content: [{ type: "text", text: "a\n\nb" }] });
  });
});

describe("ephemeral tail wire shape per host", () => {
  test("the policy folds only for codex", () => {
    expect(foldsEphemeralTail("codex")).toBe(true);
    for (const host of ["anthropic", "openai", "openrouter", "google", "ollama-turbo", "custom"]) {
      expect(foldsEphemeralTail(host)).toBe(false);
    }
  });

  test("codex: after the plan exists, the block rides inside whatever message ends the request", async () => {
    const requests = await runOn("codex");
    // Request 2 follows todo_write, so the ledger exists from here on.
    expect(requests.length).toBeGreaterThan(2);
    let toolEnded = 0;
    for (const req of requests.slice(1)) {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === "tool") {
        toolEnded++;
        const results = last.content.filter((b) => b.type === "tool_result");
        const tail = results[results.length - 1] as any;
        expect(tail.toolResultContent).toContain("[Task state — maintained by the harness");
        expect(tail.toolResultContent).toContain("[>] step one");
      } else {
        // A stored harness message (the open-steps stop) legitimately ends a
        // request on the user role; the block joins it rather than trailing
        // it as a second user message.
        expect(last.role).toBe("user");
        const texts = last.content.filter((b) => b.type === "text") as any[];
        expect(texts.length).toBeGreaterThanOrEqual(2);
        expect(texts[0].text).not.toContain("[Task state —");
        expect(texts[texts.length - 1].text).toContain("[Task state — maintained by the harness");
      }
      // Never a message that is nothing but the block.
      expect(
        last.content.length === 1 &&
          last.content[0]!.type === "text" &&
          (last.content[0] as any).text.startsWith("[Task state —"),
      ).toBe(false);
    }
    expect(toolEnded).toBeGreaterThan(0);
  });

  test("anthropic: the same run keeps the block as the trailing user message", async () => {
    const requests = await runOn("anthropic");
    for (const req of requests.slice(1)) {
      const last = req.messages[req.messages.length - 1]!;
      expect(last.role).toBe("user");
      expect((last.content[0] as any).text).toContain("[Task state — maintained by the harness");
    }
  });

  test("the composition meter reads the same on both wire shapes", async () => {
    const [codex, anthropic] = await Promise.all([runOn("codex"), runOn("anthropic")]);
    for (let i = 1; i < Math.min(codex.length, anthropic.length); i++) {
      const a = codex[i]!.composition!;
      const b = anthropic[i]!.composition!;
      expect(a.planLedger).toBeGreaterThan(0);
      expect(a.planLedger).toBe(b.planLedger);
      // The block is measured as the ledger, not as conversation, either way.
      expect(a.conversation).toBe(b.conversation);
      expect(a.total).toBe(b.total);
    }
  });

  test("codex: the stored transcript never carries the block", async () => {
    const gw = makeGateway(PLAN);
    const loop = makeLoop(gw, "codex", new TaskStateStore());
    await collect(loop.run("do a multi step thing", "s1", "/tmp"));
    const stored = loop.getMessages();
    const leaked = stored.some((m) =>
      m.content.some(
        (b: any) =>
          (b.type === "text" && b.text.includes("[Task state —")) ||
          (b.type === "tool_result" && b.toolResultContent.includes("[Task state —")),
      ),
    );
    expect(leaked).toBe(false);
  });
});
