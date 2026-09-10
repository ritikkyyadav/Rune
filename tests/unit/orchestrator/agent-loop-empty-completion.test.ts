/**
 * Empty-completion guard: a stream that closes with no text and no tool calls
 * must never end the run as a silent no-op. Live failure 2026-07-07: Gemini
 * fallback returned stopReason tool_use with ZERO tool calls; the turn ended
 * with nothing rendered and nothing explained.
 */

import { describe, test, expect } from "bun:test";
import {
  AgentLoop,
  jsonAnswerRequested,
  misencodedToolCall,
} from "../../../packages/orchestrator/src/agent-loop";
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

/**
 * Review recovery, bounded.
 *
 * `d18fde0` lets a run that WROTE finish on silence; `be0b468` turns a printed
 * argument object back into a real call. Both are recoveries, and a recovery
 * that is not bounded, or that cannot say what state the run ended in, is a
 * loop with better manners. These fix the two boundaries — an object two tools
 * could take, and a JSON answer the user actually asked for — and pin the five
 * terminal outcomes a machine consumer has to be able to tell apart.
 */
describe("recovery stays bounded and names its outcome", () => {
  const READ_MANY = {
    name: "read_many",
    description: "",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array" } },
      required: ["paths"],
    },
  };
  const jsonReplyGateway = () => {
    let calls = 0;
    return {
      calls: () => calls,
      inferStream: async function* () {
        calls++;
        yield textDelta('{"paths": ["csv.ts"]}');
        yield stopEvent("end_turn");
      },
    };
  };
  const readOnlyRegistry = (count: { n: number }) => ({
    toLlmTools: () => [READ_MANY],
    get: () => ({ schema: { ...READ_MANY, category: "read", permissionLevel: "auto" } }),
    execute: async (input: { callId: string; toolName: string }) => {
      count.n++;
      return { ...input, success: true, result: "contents", durationMs: 0 };
    },
  });

  test("an object two tools would take names no call", () => {
    const both = [
      {
        name: "read_file",
        description: "",
        inputSchema: { type: "object", properties: { path: {} }, required: ["path"] },
      },
      {
        name: "list_dir",
        description: "",
        inputSchema: { type: "object", properties: { path: {} }, required: ["path"] },
      },
    ];
    // Registry order used to decide this; the answer is that it is undecidable.
    expect(misencodedToolCall('{"path": "src"}', both)).toBeNull();
    expect(misencodedToolCall('{"path": "src"}', [both[0]!])).toBe("read_file");
    expect(misencodedToolCall('{"path": "src"}', [both[1]!])).toBe("list_dir");
  });

  test.each([
    ["Reply in JSON with the files you would read.", true],
    ["Give me the answer as valid JSON.", true],
    ["Return JSON only.", true],
    ["Fix the JSON parser in csv.ts.", false],
    ["What does csv.ts do?", false],
    ["Read package.json and summarise it.", false],
  ])("jsonAnswerRequested(%s) === %s", (request, expected) => {
    expect(jsonAnswerRequested(request)).toBe(expected);
  });

  test("a JSON answer the user asked for is the answer, not a missed call", async () => {
    const gateway = jsonReplyGateway();
    const executions = { n: 0 };
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8 },
      gateway as any,
      readOnlyRegistry(executions) as any,
    );
    const events = await collect(
      loop.run("Reply in JSON with the files you would read.", "s1", "/tmp"),
    );
    expect(gateway.calls()).toBe(1); // no nudge, no second completion
    expect(executions.n).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
    expect(loop.getMessages().some((m) => loop.originOf(m) === "nudge:misencoded-call")).toBe(
      false,
    );
    const answer = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(answer).toBe('{"paths": ["csv.ts"]}');
  });

  test("a model that keeps printing the call is nudged twice, then the reply stands", async () => {
    const gateway = jsonReplyGateway();
    const executions = { n: 0 };
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8 },
      gateway as any,
      readOnlyRegistry(executions) as any,
    );
    const events = await collect(loop.run("What does csv.ts do?", "s1", "/tmp"));
    expect(gateway.calls()).toBe(3); // two nudges, then the reply is what it is
    expect(executions.n).toBe(0);
    expect(
      loop.getMessages().filter((m) => loop.originOf(m) === "nudge:misencoded-call"),
    ).toHaveLength(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
  });

  test("silence after a write with a step still OPEN finishes bounded and unfinished", async () => {
    // `d18fde0` says the edits are the result when the model never writes a
    // closing line. That is a finish, not a completion: the gates still run,
    // the open step stays open, and the run hands off its real state.
    const state = new TaskStateStore();
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield { type: "tool_use_start", toolCallId: "p-1", toolName: "todo_write" };
          yield {
            type: "tool_use_stop",
            toolCallId: "p-1",
            toolInput: {
              items: [{ content: "repair parseCsv", kind: "change", status: "in_progress" }],
            },
          };
          yield stopEvent("tool_use");
        } else if (calls === 2) {
          yield { type: "tool_use_start", toolCallId: "w-1", toolName: "write_file" };
          yield {
            type: "tool_use_stop",
            toolCallId: "w-1",
            toolInput: { path: "csv.ts", content: "export const parseCsv = () => []" },
          };
          yield stopEvent("tool_use");
        } else {
          yield stopEvent("end_turn"); // silence, for ever
        }
      },
    };
    const registry = {
      toLlmTools: () => [],
      get: (name: string) => ({
        schema: {
          name,
          category: name === "write_file" ? "write" : "read",
          permissionLevel: "auto",
        },
      }),
      execute: async (input: { callId: string; toolName: string; args: any }) => ({
        ...input,
        success: true,
        result:
          input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "written",
        durationMs: 0,
      }),
    };
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 12, taskState: state },
      gateway as any,
      registry as any,
    );
    const events = await collect(loop.run("Fix the parser.", "s1", "/tmp"));
    expect(calls).toBeLessThanOrEqual(8); // bounded: nudges are spent, not renewed
    const origins = loop
      .getMessages()
      .map((m) => loop.originOf(m))
      .filter((o): o is string => typeof o === "string");
    expect(origins).toContain("gate:open-steps");
    expect(origins).toContain("gate:execution-evidence");
    // Never reported as done: the step the model opened is still open.
    expect(state.todoCounts()).toMatchObject({ open: 1, done: 0 });
    expect(state.hasOpenTodos()).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("a provider that dies after a tool call keeps the work and says it was lost", async () => {
    const state = new TaskStateStore();
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield textDelta("Reading the fixture.");
          yield { type: "tool_use_start", toolCallId: "r-1", toolName: "read_file" };
          yield { type: "tool_use_stop", toolCallId: "r-1", toolInput: { path: "answer.txt" } };
          yield stopEvent("tool_use");
          return;
        }
        throw new Error("502 from provider");
      },
    };
    const registry = {
      toLlmTools: () => [],
      get: () => ({ schema: { name: "read_file", category: "read", permissionLevel: "auto" } }),
      execute: async (input: { callId: string; toolName: string }) => ({
        ...input,
        success: true,
        result: "42",
        durationMs: 0,
      }),
    };
    state.beginTurn("Read the fixture.");
    state.setTodos([{ content: "read the fixture", kind: "inspect", status: "in_progress" }]);
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8, maxConsecutiveErrors: 2, taskState: state },
      gateway as any,
      registry as any,
    );
    const events = await collect(loop.run("Read the fixture.", "s1", "/tmp"));
    expect(calls).toBe(3); // one good turn, then bounded by maxConsecutiveErrors
    const fatal = events.find((e) => e.type === "error" && e.recoverable === false);
    expect(fatal && (fatal as { error: string }).error).toContain("consecutive errors");
    // Not a completion, and the partial work survives in the transcript.
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      false,
    );
    const handoff = events.find((e) => e.type === "handoff");
    expect(handoff && (handoff as { reason: string }).reason).toBe("provider_lost");
    expect(
      loop.getMessages().some((m) => m.role === "tool" && JSON.stringify(m.content).includes("42")),
    ).toBe(true);
  });

  test("cancellation mid-loop ends as aborted and keeps what was said", async () => {
    const controller = new AbortController();
    const state = new TaskStateStore();
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        yield textDelta("Working on it.");
        yield { type: "tool_use_start", toolCallId: `r-${calls}`, toolName: "read_file" };
        yield { type: "tool_use_stop", toolCallId: `r-${calls}`, toolInput: { path: "a.txt" } };
        yield stopEvent("tool_use");
      },
    };
    const registry = {
      toLlmTools: () => [],
      get: () => ({ schema: { name: "read_file", category: "read", permissionLevel: "auto" } }),
      execute: async (input: { callId: string; toolName: string }) => {
        controller.abort(); // the user hits Ctrl-C while the tool is running
        return { ...input, success: true, result: "contents", durationMs: 0 };
      },
    };
    state.beginTurn("Read a.txt.");
    state.setTodos([{ content: "read a.txt", kind: "inspect", status: "in_progress" }]);
    const loop = new AgentLoop(
      { model: "m", provider: "google", maxTurns: 8, taskState: state },
      gateway as any,
      registry as any,
    );
    const events = await collect(loop.run("Read a.txt.", "s1", "/tmp", controller.signal));
    expect(calls).toBe(1); // no completion is bought after the abort
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "aborted")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "text_delta" && e.text.includes("Working on it"))).toBe(
      true,
    );
    const handoff = events.find((e) => e.type === "handoff");
    expect(handoff && (handoff as { reason: string }).reason).toBe("aborted");
  });
});
