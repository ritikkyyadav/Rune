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
import {
  AGENT_DOCTRINE,
  doctrineForRequest,
  extractDoctrineSection,
  type JitDoctrineSection,
  jitDoctrineText,
  FRONTEND_LOOP_DOCTRINE,
  ARCHITECTURE_PLAN_DOCTRINE,
} from "../../../packages/orchestrator/src/prompts";

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

const JIT_HEADINGS: Record<string, string> = {
  delegation: "# Delegation",
  interfaces: "# Building interfaces",
  modes: "# Built-in modes on request",
};

/** Engine-like once-per-session JIT source. */
function onceJit() {
  const sent = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    fn: (section: JitDoctrineSection) => {
      calls.push(section);
      if (sent.has(section)) return null;
      sent.add(section);
      return extractDoctrineSection(JIT_HEADINGS[section] ?? "");
    },
  };
}

function makeLoop(gateway: any, jit: (s: JitDoctrineSection) => string | null) {
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

  /**
   * P3B C2 moved "# Built-in modes on request" out of the working-phase prompt
   * and delivered it nowhere; V-C showed a mid-run mode ask then reached a
   * prompt with no routing at all. The phase gate is reverted, and the section
   * is a JIT section for the case the revert cannot reach: with all three mode
   * tools deferred to catalog lines it ships in NEITHER phase, and
   * `doctrineForRequest` is the only thing that can put it in front of a
   * request that asks for a mode.
   */
  test("the built-in-modes section is extractable verbatim", () => {
    const sec = extractDoctrineSection("# Built-in modes on request");
    expect(sec.startsWith("# Built-in modes on request")).toBe(true);
    expect(sec).toContain("interactive_dashboard");
    expect(sec).toContain("compact_context");
    expect(AGENT_DOCTRINE).toContain(sec);
    expect(new TextEncoder().encode(sec).length).toBe(739);
  });
});

describe("jit injection in the loop", () => {
  test("interface planning guidance is present BEFORE the first inference", async () => {
    const jit = onceJit();
    const gw = makeGateway([{ text: "done" }]);
    let firstRequest = "";
    const stream = gw.inferStream;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    await collect(makeLoop(gw, jit.fn).run("Build a responsive dashboard", "design", "/tmp"));
    expect(firstRequest).toContain("# Building interfaces");
    expect(firstRequest).toContain("ART DIRECTION");
    expect(firstRequest).toContain("screenshots");
  });

  test("a request that asks for a built-in mode carries its routing before the first inference", async () => {
    const jit = onceJit();
    const gw = makeGateway([{ text: "done" }]);
    let firstRequest = "";
    const stream = gw.inferStream;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    await collect(makeLoop(gw, jit.fn).run("compact the conversation", "modes", "/tmp"));
    expect(doctrineForRequest("compact the conversation")).toContain("modes");
    expect(jit.calls).toContain("modes");
    expect(firstRequest).toContain("# Built-in modes on request");
    expect(firstRequest).toContain("compact_context");
  });

  test("ordinary backend requests do not pay for interface guidance", async () => {
    const jit = onceJit();
    const loop = makeLoop(makeGateway([{ text: "done" }]), jit.fn);
    await collect(loop.run("Fix parsing of empty JSON objects", "backend", "/tmp"));
    expect(jit.calls).toEqual([]);
  });
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

// ─── Phase 5 F1: the frontend loop, and the architecture plan ───
//
// Two sections that are NOT part of AGENT_DOCTRINE: they sit in no prefix in
// any delivery mode, so the loop owns them. What has to hold is that they cost
// a frontend/architecture request ~1 KB each, cost every other request exactly
// zero bytes, and arrive once per user message — including the mid-run steer
// the backlog says JIT doctrine never reached (`agent-loop.ts:1309`).

describe("doctrineForRequest routes the Phase 5 sections by shape", () => {
  test("a frontend-shaped request gets the loop; an ordinary fix gets nothing", () => {
    for (const request of [
      "Build a responsive project dashboard",
      "redesign the settings screen",
      "fix the css on the landing page",
      "the frontend crashes when the list is empty",
    ]) {
      expect(doctrineForRequest(request)).toContain("frontend");
    }
    for (const request of [
      "Fix parsing of empty JSON objects",
      "the CSV parser drops the last row",
      "add a retry to the queue consumer",
    ]) {
      expect(doctrineForRequest(request)).not.toContain("frontend");
      expect(doctrineForRequest(request)).not.toContain("architecture");
    }
  });

  test("an architecture-shaped request gets the plan section; a local repair does not", () => {
    for (const request of [
      "migrate the store to the new schema",
      "refactor the parser into its own package",
      "extract a module for the pricing rules",
      "this is an interface change across three modules",
    ]) {
      expect(doctrineForRequest(request)).toContain("architecture");
    }
    for (const request of [
      "fix the off-by-one in nextIndex",
      "add a test for the empty case",
      "why does the queue stall?",
    ]) {
      expect(doctrineForRequest(request)).not.toContain("architecture");
    }
  });

  test("the two sections are new text, not slices of AGENT_DOCTRINE", () => {
    expect(jitDoctrineText("frontend")).toBe(FRONTEND_LOOP_DOCTRINE);
    expect(jitDoctrineText("architecture")).toBe(ARCHITECTURE_PLAN_DOCTRINE);
    expect(jitDoctrineText("interfaces")).toBe("");
    expect(AGENT_DOCTRINE).not.toContain(FRONTEND_LOOP_DOCTRINE);
    expect(AGENT_DOCTRINE).not.toContain(ARCHITECTURE_PLAN_DOCTRINE);
  });

  test("the loop states the handoff's steps in order", () => {
    const order = [
      "REQUIREMENTS AND REFERENCES",
      "THE ACTUAL STACK",
      "ART DIRECTION",
      "IMPLEMENT",
      "SERVE IT",
      "CAPTURE BOTH WIDTHS",
      "EXERCISE IT",
      "FIX what you saw",
      "HAND IT BACK",
    ];
    let at = -1;
    for (const step of order) {
      const next = FRONTEND_LOOP_DOCTRINE.indexOf(step);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });
});

describe("the Phase 5 sections in the loop", () => {
  test("a frontend request carries the loop exactly once, before the first inference", async () => {
    const jit = onceJit();
    const gw = makeGateway([{ tools: [{ name: "write_file", args: { path: "a.html" } }] }, {}]);
    let firstRequest = "";
    const stream = gw.inferStream;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    const loop = makeLoop(gw, jit.fn);
    await collect(loop.run("Build a responsive project board screen", "f1", "/tmp"));
    expect(firstRequest).toContain("# The frontend loop");
    expect(firstRequest).toContain("SERVE IT");
    const t = JSON.stringify(loop.getMessages());
    expect(t.split("# The frontend loop").length - 1).toBe(1);
  });

  test("an architecture request carries the plan section exactly once", async () => {
    const jit = onceJit();
    const gw = makeGateway([{ text: "done" }]);
    let firstRequest = "";
    const stream = gw.inferStream;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    const loop = makeLoop(gw, jit.fn);
    await collect(loop.run("migrate the storage layer to the new schema", "f4", "/tmp"));
    expect(firstRequest).toContain("# The architecture plan");
    expect(firstRequest).toContain("dependsOn");
    expect(JSON.stringify(loop.getMessages()).split("# The architecture plan").length - 1).toBe(1);
  });

  /**
   * The cost guarantee: a plain fix request must not pay one byte for either
   * section. Measured as the whole first request, not just an absence check —
   * a run that injected anything at all would move this number.
   */
  test("a plain fix request pays zero extra bytes", async () => {
    const jit = onceJit();
    const gw = makeGateway([{ text: "done" }]);
    let firstRequest = "";
    const stream = gw.inferStream;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    const loop = makeLoop(gw, jit.fn);
    await collect(loop.run("Fix parsing of empty JSON objects", "plain", "/tmp"));
    expect(jit.calls).toEqual([]);
    expect(firstRequest).not.toContain("# The frontend loop");
    expect(firstRequest).not.toContain("# The architecture plan");
    // Exactly one message went to the provider: the user's own words. Any
    // injection at all — a harness note, a doctrine section — adds a second.
    expect(loop.getMessages().length).toBe(2); // the request, and the model's reply
  });

  /**
   * The backlog's residue (`agent-loop.ts:1309`): JIT doctrine fired only from
   * the message that STARTS a run, so a steer typed into a run in flight got
   * no routing from anywhere. The steer is a user message and is routed like
   * one — so a frontend steer on a backend run delivers the loop, and a second
   * frontend steer delivers it again, because the ask moved.
   */
  test("a frontend steer mid-run is routed; the section arrives once more", async () => {
    const jit = onceJit();
    const gw = makeGateway([
      { tools: [{ name: "bash", args: { command: "ls" } }] },
      { tools: [{ name: "bash", args: { command: "ls" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, jit.fn);
    const events: AgentTurnEvent[] = [];
    for await (const e of loop.run("Fix parsing of empty JSON objects", "steer", "/tmp")) {
      events.push(e);
      if (e.type === "tool_call_end") loop.interject("actually, give it a web UI screen too");
    }
    const t = JSON.stringify(loop.getMessages());
    // Once per frontend-shaped user message: two steers were folded in.
    expect(t.split("# The frontend loop").length - 1).toBe(2);
    // The doctrine sections that DO live in the prefix stay once-per-session:
    // the engine's gate returns null on the second ask.
    expect(jit.calls.filter((c) => c === "interfaces").length).toBe(2);
    expect(t.split("# Building interfaces").length - 1).toBe(1);
  });
});
