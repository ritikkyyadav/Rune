/**
 * The delegation-evidence gate.
 *
 * `AGENT_DOCTRINE` is unambiguous: "A sub-agent report is SECONDHAND. It is one
 * model's account of code you have not read — never evidence." Nothing enforced
 * it. In the EvoLab-3 build (session 01a04c74, turn 132) three workers wrote the
 * entire FastAPI backend, the entire Next.js frontend, and all the docs in one
 * response; the orchestrator read seven files out of fifty-four and moved on.
 *
 * The bar here is deliberately the one number that needs no justification:
 * ZERO. An agent that delegated everything and opened NOTHING is refused the
 * finish, once. Anything above zero is a judgement call about how much reading
 * is enough, and this gate declines to make it — the worker manifest reports
 * the sizes so a person can.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Turn 1 dispatches a worker; later turns optionally read, then finish. */
function gateway(readsAfter: string[]) {
  let step = 0;
  return {
    inferStream: mock(async function* () {
      step++;
      if (step === 1) {
        yield ev("tool_use_start", { toolCallId: "w1", toolName: "worker" });
        yield ev("tool_use_stop", {
          toolCallId: "w1",
          toolInput: { prompt: "Build the backend", files: ["backend/"] },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
        return;
      }
      const read = readsAfter[step - 2];
      if (read) {
        yield ev("tool_use_start", { toolCallId: `r${step}`, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: `r${step}`, toolInput: { path: read } });
        yield ev("message_stop", { stopReason: "tool_use" });
        return;
      }
      yield ev("content_delta", { delta: { type: "text_delta", text: "Backend complete." } });
      yield ev("message_stop", { stopReason: "end_turn" });
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

function registry() {
  return {
    toLlmTools: mock(() => [{ name: "worker", description: "", inputSchema: {} }]),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "read_file" ? "read" : "execute",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "worker"
          ? "## Integrator report\nImplemented the complete scientific backend."
          : JSON.stringify({ path: "x", content: "…" }),
      durationMs: 1,
    })),
  } as any;
}

const makeLoop = (gw: any) =>
  new AgentLoop(
    { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 12, systemPrompt: "s" } as any,
    gw,
    registry(),
  );

const gateFired = (events: AgentTurnEvent[]) =>
  events.some(
    (e) =>
      e.type === "notice" && String((e as any).message).includes("Delegated work was never read"),
  );

describe("delegation-evidence gate", () => {
  test("finishing on a worker's prose without opening a file is refused once", async () => {
    const events = await collect(makeLoop(gateway([])).run("build it", "s1", "/tmp"));
    expect(gateFired(events)).toBe(true);
  });

  test("reading anything the worker owned satisfies it", async () => {
    // One file under `backend/` is enough. The gate refuses to invent a
    // threshold above zero.
    const events = await collect(
      makeLoop(gateway(["backend/app/main.py"])).run("build it", "s1", "/tmp"),
    );
    expect(gateFired(events)).toBe(false);
  });

  test("reading somewhere else entirely does not count", async () => {
    const events = await collect(makeLoop(gateway(["README.md"])).run("build it", "s1", "/tmp"));
    expect(gateFired(events)).toBe(true);
  });

  test("it fires at most once, and the run still finishes", async () => {
    const events = await collect(makeLoop(gateway([])).run("build it", "s1", "/tmp"));
    const fired = events.filter(
      (e) =>
        e.type === "notice" && String((e as any).message).includes("Delegated work was never read"),
    );
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(fired).toHaveLength(1);
    expect(complete.stopReason).toBe("end_turn");
  });

  test("a run that never delegated is untouched", async () => {
    const plain = {
      inferStream: mock(async function* () {
        yield ev("content_delta", { delta: { type: "text_delta", text: "answered" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
      infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const events = await collect(makeLoop(plain).run("what is 2+2", "s1", "/tmp"));
    expect(gateFired(events)).toBe(false);
  });
});

describe("delegation-evidence gate — per scope, and search-shaped reads", () => {
  /** Two workers, two scopes; then a scripted list of (tool, path) reads. */
  function fleet(reads: Array<[string, string]>) {
    let step = 0;
    return {
      inferStream: mock(async function* () {
        step++;
        if (step === 1) {
          for (const [id, scope] of [
            ["w1", "backend/"],
            ["w2", "frontend/"],
          ] as const) {
            yield ev("tool_use_start", { toolCallId: id, toolName: "worker" });
            yield ev("tool_use_stop", {
              toolCallId: id,
              toolInput: { prompt: `Build ${scope}`, files: [scope] },
            });
          }
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        const read = reads[step - 2];
        if (read) {
          const [tool, path] = read;
          yield ev("tool_use_start", { toolCallId: `r${step}`, toolName: tool });
          yield ev("tool_use_stop", {
            toolCallId: `r${step}`,
            toolInput: tool === "grep" ? { pattern: "export", path } : { path },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        yield ev("content_delta", { delta: { type: "text_delta", text: "All built." } });
        yield ev("message_stop", { stopReason: "end_turn" });
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

  const fleetRegistry = () => {
    const base = registry();
    base.get = mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "worker" ? "execute" : "read",
        permissionLevel: "auto",
      },
    }));
    return base;
  };

  const run = (gw: any) =>
    collect(
      new AgentLoop(
        {
          model: "m",
          provider: "anthropic",
          maxTokens: 100,
          maxTurns: 12,
          systemPrompt: "s",
        } as any,
        gw,
        fleetRegistry(),
      ).run("build it", "s1", "/tmp"),
    );

  test("one file read in one of two scopes no longer satisfies the fleet", async () => {
    const events = await run(fleet([["read_file", "backend/app/main.py"]]));
    expect(gateFired(events)).toBe(true);
  });

  test("a read in each scope does", async () => {
    const events = await run(
      fleet([
        ["read_file", "backend/app/main.py"],
        ["read_file", "frontend/src/App.tsx"],
      ]),
    );
    expect(gateFired(events)).toBe(false);
  });

  test("a grep scoped to a worker's directory counts as reading it", async () => {
    const events = await run(
      fleet([
        ["read_file", "backend/app/main.py"],
        ["grep", "frontend/"],
      ]),
    );
    expect(gateFired(events)).toBe(false);
  });
});
