/**
 * Empty-completion guard: a stream that closes with no text and no tool calls
 * must never end the run as a silent no-op. Live failure 2026-07-07: Gemini
 * fallback returned stopReason tool_use with ZERO tool calls; the turn ended
 * with nothing rendered and nothing explained.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop, misencodedToolCall } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: () => undefined,
    execute: async () => {
      throw new Error("no tools should run in these tests");
    },
  } as any;
}

const textDelta = (text: string) => ({
  type: "content_delta",
  contentIndex: 0,
  delta: { type: "text_delta", text },
});

const stopEvent = (stopReason: string) => ({
  type: "message_stop",
  stopReason,
  usage: { inputTokens: 10, outputTokens: 0 },
});

function loopWith(gateway: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 8,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      thinking: false,
    },
    gateway,
    makeRegistry(),
  );
}

describe("AgentLoop — empty completions never end a run silently", () => {
  test.each([true, false])(
    "tool-only work followed by silence recovers or fails explicitly (recover=%s)",
    async (recover) => {
      let calls = 0;
      let executions = 0;
      const state = new TaskStateStore();
      const gateway = {
        inferStream: async function* () {
          calls++;
          if (calls === 1) {
            yield { type: "tool_use_start", toolCallId: "read-1", toolName: "read_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: "read-1",
              toolInput: { path: "answer.txt" },
            };
            yield stopEvent("tool_use");
          } else if (recover && calls === 3) {
            yield textDelta("The fixture contains 42.");
            yield stopEvent("end_turn");
          } else {
            yield {
              type: "message_stop",
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          }
        },
      };
      const registry = {
        toLlmTools: () => [],
        get: () => ({ schema: { name: "read_file", category: "read", permissionLevel: "auto" } }),
        execute: async (input: { callId: string; toolName: string }) => {
          executions++;
          return { ...input, success: true, result: "42", durationMs: 0 };
        },
      };
      const loop = new AgentLoop(
        { model: "m", provider: "google", maxTurns: 8, taskState: state },
        gateway as any,
        registry as any,
      );
      const events = await collect(
        loop.run("Read the fixture and tell me the value.", "s1", "/tmp"),
      );
      expect(executions).toBe(1); // retry the response, not the completed work
      expect(calls).toBe(recover ? 3 : 4);
      expect(
        loop.getMessages().filter((m) => m.role === "assistant" && m.content.length === 0),
      ).toHaveLength(0);
      if (recover) {
        expect(events.some((e) => e.type === "text_delta" && e.text.includes("42"))).toBe(true);
        expect(events.some((e) => e.type === "error")).toBe(false);
      } else {
        const error = events.find((e) => e.type === "error");
        expect(error?.type === "error" && error.error).toContain(
          "recorded tool results are retained",
        );
        expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
          false,
        );
        expect(
          events.some((e) => e.type === "turn_complete" && e.stopReason === "provider_lost"),
        ).toBe(true);
      }
    },
  );

  test.each([true, false])(
    "narration, tool results, then silence: one nudge, then the finish is accepted (answers=%s)",
    async (answers) => {
      let calls = 0;
      let executions = 0;
      const gateway = {
        inferStream: async function* () {
          calls++;
          if (calls === 1) {
            yield textDelta("Running the fixture read now.");
            yield { type: "tool_use_start", toolCallId: "read-1", toolName: "read_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: "read-1",
              toolInput: { path: "answer.txt" },
            };
            yield stopEvent("tool_use");
          } else if (answers && calls === 3) {
            yield textDelta("The fixture contains 42.");
            yield stopEvent("end_turn");
          } else {
            yield {
              type: "message_stop",
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          }
        },
      };
      const registry = {
        toLlmTools: () => [],
        get: () => ({ schema: { name: "read_file", category: "read", permissionLevel: "auto" } }),
        execute: async (input: { callId: string; toolName: string }) => {
          executions++;
          return { ...input, success: true, result: "42", durationMs: 0 };
        },
      };
      const loop = new AgentLoop(
        { model: "m", provider: "google", maxTurns: 8 },
        gateway as any,
        registry as any,
      );
      const events = await collect(
        loop.run("Read the fixture and tell me the value.", "s1", "/tmp"),
      );
      expect(executions).toBe(1);
      // One empty completion earns the nudge; the second is accepted on the
      // earlier narration — never a third request, never an error.
      expect(calls).toBe(3);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
        true,
      );
      const nudge = loop
        .getMessages()
        .find(
          (m) =>
            m.role === "user" &&
            m.content.some(
              (b: any) => b.type === "text" && b.text.includes("not provided an answer"),
            ),
        );
      expect(nudge).toBeDefined();
      expect(loop.originOf(nudge!)).toBe("nudge:empty-completion");
      expect(
        events.some((e) => e.type === "notice" && e.message.includes("finishing on what it said")),
      ).toBe(!answers);
      expect(events.some((e) => e.type === "text_delta" && e.text.includes("42"))).toBe(answers);
    },
  );

  test("a write followed by silence: nudged once, then the work stands as the finish", async () => {
    // Free-route gpt-oss:120b, 2026-09-10: edited the parser, passed acceptance
    // in 31 s, never wrote a closing line — and the run was failed as lost.
    let calls = 0;
    let executions = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield { type: "tool_use_start", toolCallId: "w-1", toolName: "write_file" };
          yield {
            type: "tool_use_stop",
            toolCallId: "w-1",
            toolInput: { path: "csv.ts", content: "export const parseCsv = () => []" },
          };
          yield stopEvent("tool_use");
        } else {
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
      },
    };
    const registry = {
      toLlmTools: () => [],
      get: () => ({ schema: { name: "write_file", category: "write", permissionLevel: "auto" } }),
      execute: async (input: { callId: string; toolName: string }) => {
        executions++;
        return { ...input, success: true, result: "written", durationMs: 0 };
      },
    };
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8, maxEmptyCompletionRetries: 3 },
      gateway as any,
      registry as any,
    );
    const events = await collect(loop.run("Fix the parser.", "s1", "/tmp"));
    expect(executions).toBe(1);
    // The write, one nudge, one more empty reply — then the work stands and
    // the finish gates run: a write with no check is refused once, the model
    // stays silent once more, and the run ends on the work. Four completions,
    // no error.
    expect(calls).toBe(4);
    expect(
      events.some((e) => e.type === "notice" && e.message.startsWith("Execution-evidence gate:")),
    ).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
    expect(
      events.some(
        (e) => e.type === "notice" && e.message.includes("the edits above are the result"),
      ),
    ).toBe(true);
  });

  test("tool arguments printed as text are nudged into a real call, not accepted as the answer", async () => {
    // Free-route gpt-oss:120b, 2026-09-10: `{"paths": ["csv.ts"]}` as the whole
    // reply, then end_turn; the run ended after one completion with nothing read.
    let calls = 0;
    let executions = 0;
    const READ_MANY = {
      name: "read_many",
      description: "read files",
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" } } },
        required: ["paths"],
      },
    };
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield textDelta('{\n  "paths": [\n    "csv.ts"\n  ]\n}');
          yield stopEvent("end_turn");
        } else if (calls === 2) {
          yield { type: "tool_use_start", toolCallId: "r-1", toolName: "read_many" };
          yield { type: "tool_use_stop", toolCallId: "r-1", toolInput: { paths: ["csv.ts"] } };
          yield stopEvent("tool_use");
        } else {
          yield textDelta("csv.ts splits on newlines.");
          yield stopEvent("end_turn");
        }
      },
    };
    const registry = {
      toLlmTools: () => [READ_MANY],
      get: () => ({ schema: { ...READ_MANY, category: "read", permissionLevel: "auto" } }),
      execute: async (input: { callId: string; toolName: string }) => {
        executions++;
        return { ...input, success: true, result: "contents", durationMs: 0 };
      },
    };
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8 },
      gateway as any,
      registry as any,
    );
    const events = await collect(loop.run("What does csv.ts do?", "s1", "/tmp"));
    expect(calls).toBe(3);
    expect(executions).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
    const nudge = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          m.content.some((b: any) => b.type === "text" && b.text.includes("printed as text")),
      );
    expect(nudge).toBeDefined();
    expect(loop.originOf(nudge!)).toBe("nudge:misencoded-call");
    expect(events.some((e) => e.type === "text_delta" && e.text.includes("splits on"))).toBe(true);
  });

  test("misencodedToolCall: only an object that fits one advertised schema counts", () => {
    const tools = [
      {
        name: "read_many",
        description: "",
        inputSchema: { type: "object", properties: { paths: {} }, required: ["paths"] },
      },
      {
        name: "write_file",
        description: "",
        inputSchema: {
          type: "object",
          properties: { path: {}, content: {} },
          required: ["path", "content"],
        },
      },
    ];
    expect(misencodedToolCall('{"paths": ["a.ts"]}', tools)).toBe("read_many");
    expect(misencodedToolCall('{"path": "a.ts"}', tools)).toBeNull(); // content missing
    expect(misencodedToolCall('{"paths": ["a.ts"], "extra": 1}', tools)).toBeNull();
    expect(misencodedToolCall('The file has {"paths": []} in it.', tools)).toBeNull();
    expect(misencodedToolCall("[]", tools)).toBeNull();
    expect(misencodedToolCall("{}", tools)).toBeNull();
    expect(misencodedToolCall('{"paths": []}', [])).toBeNull();
  });

  test("stopReason tool_use with zero tool calls: retries twice, then fails LOUDLY", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        yield stopEvent("tool_use"); // claims a tool call, delivers none
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("build me a dashboard", "s1", "/tmp"));

    expect(calls).toBe(3); // initial + 2 retries
    const notices = events.filter(
      (e) => e.type === "notice" && /empty response/i.test((e as any).message),
    );
    expect(notices.length).toBe(2);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).error).toContain("empty response 3 times");
    // The transcript must not be poisoned with empty assistant messages.
    const empties = loop
      .getMessages()
      .filter((m) => m.role === "assistant" && m.content.length === 0);
    expect(empties.length).toBe(0);
  });

  test("recovers when a retry produces real output", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield stopEvent("tool_use"); // defective first attempt
        } else {
          yield textDelta("Here is the answer.");
          yield stopEvent("end_turn");
        }
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("hello", "s1", "/tmp"));

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "text_delta" && (e as any).text.includes("answer"))).toBe(
      true,
    );
    const complete = events.filter((e) => e.type === "turn_complete");
    expect(complete.length).toBe(1);
    expect((complete[0] as any).stopReason).toBe("end_turn");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("first-step end_turn with literal nothing is treated as a defect, not an answer", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        yield stopEvent("end_turn"); // no content at all, first step of the run
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("say hi", "s1", "/tmp"));

    expect(calls).toBe(3);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("text accompanying a missing promised tool call cannot reset the empty-response ceiling", async () => {
    let calls = 0;
    const loop = loopWith({
      inferStream: async function* () {
        calls++;
        yield textDelta("Calling the tool now.");
        yield stopEvent("tool_use");
      },
    });
    const events = await collect(loop.run("Read the fixture.", "s1", "/tmp"));
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("incidents are reported for empty completions", async () => {
    const classes: string[] = [];
    const gateway = {
      inferStream: async function* () {
        yield stopEvent("tool_use");
      },
    };
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "google",
        maxTokens: 100,
        maxTurns: 8,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        thinking: false,
        onIncident: (i: any) => classes.push(i.class),
      } as any,
      gateway as any,
      makeRegistry(),
    );
    await collect(loop.run("x", "s1", "/tmp"));
    expect(classes.filter((c) => c === "provider.empty_completion").length).toBe(3);
  });
});
