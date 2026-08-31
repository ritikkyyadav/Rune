/**
 * Just-in-time doctrine: in "jit" delivery the Delegation and
 * Building-interfaces sections leave the per-request system prompt and are
 * injected ONCE into history at their first moment of relevance — the first
 * sub-agent result, the first visual write. Guidance at the moment it applies,
 * paid for once (history is cached) instead of on every request.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { AGENT_DOCTRINE, extractDoctrineSection } from "../../../packages/orchestrator/src/prompts";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k].name });
          yield ev("tool_use_stop", { toolCallId: `c${i}-${k}`, toolInput: t.tools[k].args ?? {} });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [],
      model: "m",
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
        category: ["write_file", "edit_file"].includes(name)
          ? "write"
          : name === "bash" || name === "worker"
            ? "execute"
            : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

/** Engine-like once-per-session JIT source. */
function onceJit() {
  const sent = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    fn: (section: "delegation" | "interfaces") => {
      calls.push(section);
      if (sent.has(section)) return null;
      sent.add(section);
      return extractDoctrineSection(
        section === "delegation" ? "# Delegation" : "# Building interfaces",
      );
    },
  };
}

function makeLoop(gateway: any, jit: (s: "delegation" | "interfaces") => string | null) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 10,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
      jitDoctrine: jit,
    } as any,
    gateway,
    makeRegistry(),
  );
}

describe("extractDoctrineSection", () => {
  test("returns the Delegation section verbatim", () => {
    const sec = extractDoctrineSection("# Delegation");
    expect(sec.startsWith("# Delegation")).toBe(true);
    expect(sec).toContain("SECONDHAND");
    expect(AGENT_DOCTRINE).toContain(sec);
    expect(sec.length).toBeGreaterThan(500);
  });

  test("returns the Building-interfaces section verbatim", () => {
    const sec = extractDoctrineSection("# Building interfaces");
    expect(sec.startsWith("# Building interfaces")).toBe(true);
    expect(sec).toContain("ART DIRECTION");
    expect(AGENT_DOCTRINE).toContain(sec);
  });

  test("unknown heading returns empty", () => {
    expect(extractDoctrineSection("# No Such Section")).toBe("");
  });
});

describe("jit injection in the loop", () => {
  test("the FIRST worker result carries the delegation section, later ones do not", async () => {
    const jit = onceJit();
    const gw = makeGateway([
      { tools: [{ name: "worker", args: { files: ["src/a.ts"], prompt: "build" } }] },
      { tools: [{ name: "worker", args: { files: ["src/b.ts"], prompt: "build" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, jit.fn);
    await collect(loop.run("big build", "s1", "/tmp"));
    const t = JSON.stringify(loop.getMessages());
    expect(t).toContain("applies for the rest of the session");
    expect(t.split("# Delegation").length - 1).toBe(1);
  });

  test("the first VISUAL write carries the interfaces section, non-visual writes never do", async () => {
    const jit = onceJit();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/core.ts" } }] },
      { tools: [{ name: "write_file", args: { path: "web/index.html" } }] },
      { tools: [{ name: "write_file", args: { path: "web/app.css" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, jit.fn);
    await collect(loop.run("build it", "s1", "/tmp"));
    const t = JSON.stringify(loop.getMessages());
    expect(t.split("# Building interfaces").length - 1).toBe(1);
    // The section landed on the html write, not the .ts write.
    expect(jit.calls.filter((c) => c === "interfaces").length).toBe(2); // html + css, second returned null
  });

  test("no jitDoctrine wired (full delivery, sub-agents) → nothing injected", async () => {
    const gw = makeGateway([
      { tools: [{ name: "worker", args: { files: ["web/x.html"], prompt: "p" } }] },
      { text: "done" },
    ]);
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 6,
        systemPrompt: "s",
        taskState: new TaskStateStore(),
      } as any,
      gw,
      makeRegistry(),
    );
    await collect(loop.run("build", "s1", "/tmp"));
    expect(JSON.stringify(loop.getMessages())).not.toContain("applies for the rest of the session");
  });
});
