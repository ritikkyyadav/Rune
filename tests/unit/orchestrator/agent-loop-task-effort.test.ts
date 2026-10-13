/**
 * "task" routing: one reasoning effort for the whole request, and at most one
 * move — upward, for good — when the work itself goes wrong.
 *
 * Why it exists. Measured 2026-10-08 on Codex: a request sent at a different
 * effort from the one before it reads nothing from the prompt cache. The
 * routing Rune had ("conservative") changes effort at turn 2, again at every
 * sign of difficulty and again when the checks pass, so on Codex it was made
 * to do nothing: every turn runs at the ceiling. That is the cache kept and
 * the economy given up — and effort is what output tokens, and so most of a
 * run's wall time, are made of.
 *
 * What is held here is the SHAPE of the request trace, which is the only part
 * of this a script can speak to:
 *   · the effort does not change between two requests unless the run was
 *     raised, and it is raised at most once;
 *   · it never comes back down — not when the checks go green, not when a
 *     gate refuses the finish;
 *   · what starts below the ceiling is decided by the words of the request,
 *     before the first completion, and errs toward the ceiling.
 *
 * Whether a notch less reasoning costs quality is not something any of this
 * shows. That is what the live comparison this setting exists for is for, and
 * until it is run the default routing is unchanged.
 */

import { describe, test, expect, mock } from "bun:test";
import {
  AgentLoop,
  TASK_ROUTING_MAX_CHARS,
  startsBelowCeiling,
} from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

/** Scripted gateway that records each request's thinking effort. */
function makeGateway(turns: Step[]) {
  let i = 0;
  const efforts: string[] = [];
  return {
    efforts,
    inferStream: mock(async function* (req: any) {
      efforts.push(req.thinking?.effort ?? "(unset)");
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k]!.name });
          yield ev("tool_use_stop", {
            toolCallId: `c${i}-${k}`,
            toolInput: t.tools[k]!.args ?? {},
          });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
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
          : name === "bash"
            ? "execute"
            : "read",
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

function makeLoop(gateway: any, opts: Record<string, unknown> = {}) {
  const incidents: Array<{ class: string; message: string }> = [];
  const loop = new AgentLoop(
    {
      model: "m",
      // The host this mode is for: a change of effort costs the whole cache.
      provider: "codex",
      maxTokens: 100,
      maxTurns: 14,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
      thinkingEffort: "max",
      effortRouting: "task",
      onIncident: (i: { class: string; message: string }) => incidents.push(i),
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
  return { loop, incidents };
}

/** How many times the effort differs from the request before it. */
const changes = (efforts: string[]): number =>
  efforts.filter((e, i) => i > 0 && e !== efforts[i - 1]).length;

const SMALL = "Add a `tags: string[]` field to Note in notes.ts and let createNote take it.";
const READ_WRITE_DONE: Step[] = [
  { tools: [{ name: "read_file", args: { path: "notes.ts" } }] },
  { tools: [{ name: "write_file", args: { path: "notes.ts", content: "x" } }] },
  { text: "done" },
];

describe("a small, clear task runs at one effort from its first request to its last", () => {
  test("a notch below the ceiling, every turn — the planning turn included", async () => {
    const gw = makeGateway(READ_WRITE_DONE);
    const { loop, incidents } = makeLoop(gw);
    await collect(loop.run(SMALL, "s1", "/tmp"));
    // Four requests, not three: a file was written and nothing was run, so the
    // execution-evidence gate refuses the finish once. A refused finish is the
    // harness asking for something, and the effort does not move for it.
    expect(gw.efforts).toEqual(["high", "high", "high", "high"]);
    expect(changes(gw.efforts)).toBe(0);
    // Said once, as what it is.
    const routed = incidents.filter((i) => i.class === "loop.effort_routed");
    expect(routed).toHaveLength(1);
    expect(routed[0]!.message).toContain("runs at high under a max ceiling, every turn");
  });

  test("each ceiling steps to its own notch, and a ceiling with no notch below it stays", async () => {
    for (const [ceiling, expected] of [
      ["max", "high"],
      ["xhigh", "high"],
      ["high", "medium"],
      ["medium", "medium"],
      ["low", "low"],
    ] as const) {
      const gw = makeGateway(READ_WRITE_DONE);
      const { loop, incidents } = makeLoop(gw, { thinkingEffort: ceiling });
      await collect(loop.run(SMALL, "s1", "/tmp"));
      expect({ ceiling, efforts: [...new Set(gw.efforts)] }).toEqual({
        ceiling,
        efforts: [expected],
      });
      expect(gw.efforts.length).toBeGreaterThanOrEqual(3);
      // Nothing is announced where nothing was lowered.
      expect(incidents.some((i) => i.class === "loop.effort_routed")).toBe(expected !== ceiling);
    }
  });

  test("on a host where changing effort is free it does the same: the mode is one effort, not a host's quirk", async () => {
    const gw = makeGateway(READ_WRITE_DONE);
    const { loop } = makeLoop(gw, { provider: "ollama-turbo" });
    await collect(loop.run(SMALL, "s1", "/tmp"));
    expect(gw.efforts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(gw.efforts)).toEqual(new Set(["high"]));
  });
});

describe("what starts at the ceiling, from the first request", () => {
  const atTheCeiling: Array<[string, string]> = [
    ["a fix", "fix the crash in the date parser"],
    ["a question of why", "Why does the export drop the last row? Find the cause."],
    ["an investigation", "Investigate the memory growth in the worker pool."],
    ["an audit", "Audit the auth middleware for missing checks."],
    ["a review", "Review the retry logic in gateway.ts."],
    ["research", "Research how other CLIs handle resumable sessions."],
    ["a migration", "Migrate the note store from v1 to v2 and keep the CLI working."],
    [
      "a refactor across modules",
      "Refactor the provider registry across the gateway and orchestrator packages.",
    ],
    ["a module pulled out", "Extract a module for the session code and keep every caller working."],
    [
      "a request for care, by name",
      "Add a --json flag to the logstats CLI. Think hard about the edge cases.",
    ],
    ["the same, in another word", "Carefully add pagination to the list endpoint."],
    ["a brief", `Build the admin console. ${"It needs another screen. ".repeat(80)}`],
  ];
  for (const [why, request] of atTheCeiling) {
    test(`${why}: ${request.slice(0, 70)}`, async () => {
      expect(startsBelowCeiling(request)).toBe(false);
      const gw = makeGateway(READ_WRITE_DONE);
      const { loop, incidents } = makeLoop(gw);
      await collect(loop.run(request, "s1", "/tmp"));
      expect(new Set(gw.efforts)).toEqual(new Set(["max"]));
      expect(incidents.some((i) => i.class === "loop.effort_routed")).toBe(false);
    });
  }

  const below: Array<[string, string]> = [
    ["a page", "Build a landing page for Driftwood, a specialty coffee subscription."],
    ["a component", "Add a dismissible banner component to the settings screen."],
    ["a small feature", "Add a GET /health route to server.ts that answers 200 with {ok:true}."],
    ["a well-specified edit", SMALL],
    ["a script", "Write a script that prints the ten largest files under src."],
  ];
  for (const [why, request] of below) {
    test(`a notch down — ${why}: ${request.slice(0, 60)}`, () => {
      expect(startsBelowCeiling(request)).toBe(true);
    });
  }

  test("the length that makes a request a brief is a number, and it is this one", () => {
    const at = "Add a field. ".padEnd(TASK_ROUTING_MAX_CHARS, "x");
    expect(at.length).toBe(TASK_ROUTING_MAX_CHARS);
    expect(startsBelowCeiling(at)).toBe(true);
    expect(startsBelowCeiling(`${at}x`)).toBe(false);
    expect(startsBelowCeiling("")).toBe(false);
    expect(startsBelowCeiling("   ")).toBe(false);
  });

  test("it is the request that is read, when the task state has one, not the turn's own message", async () => {
    const taskState = new TaskStateStore();
    taskState.beginTurn("fix the crash in the date parser");
    const gw = makeGateway(READ_WRITE_DONE);
    const { loop } = makeLoop(gw, { taskState });
    // A follow-up that reads as small, inside a task that is a fix.
    await collect(loop.run("yes, go ahead", "s1", "/tmp"));
    expect(new Set(gw.efforts)).toEqual(new Set(["max"]));
  });
});

describe("when the work goes wrong the effort is raised once, and stays", () => {
  /** Fails the first time it is asked, passes after. */
  const failsOnce = () => {
    let calls = 0;
    return {
      calls: () => calls,
      verify: async () => {
        calls++;
        return calls === 1
          ? { status: "failed", passed: false, ran: true, report: "1 fail", runs: [] }
          : { status: "passed", passed: true, ran: true, report: "ok", runs: [] };
      },
    };
  };

  test("a failed check raises it; the turns after run at the ceiling", async () => {
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "notes.ts" } }] },
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "x" } }] },
      { text: "finished" }, // verification fails here
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "y" } }] },
      { text: "fixed" },
    ]);
    const { loop, incidents } = makeLoop(gw, { verifier: failsOnce() });
    await collect(loop.run(SMALL, "s1", "/tmp"));
    expect(gw.efforts).toEqual(["high", "high", "high", "max", "max"]);
    expect(changes(gw.efforts)).toBe(1);
    const raised = incidents.filter((i) => i.class === "loop.effort_latched");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.message).toContain("raised from high to the max ceiling, once");
    expect(raised[0]!.message).toContain("verification failed");
  });

  test("the checks going green afterwards do not bring it back down", async () => {
    // A plan with a step left open keeps the run going after the green check,
    // so there are turns to read on the far side of it.
    const gw = makeGateway([
      {
        tools: [
          {
            name: "todo_write",
            args: {
              items: [
                { content: "add the field", status: "in_progress" },
                { content: "update the exporter", status: "pending" },
              ],
            },
          },
        ],
      },
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "x" } }] },
      { text: "finished" }, // verification fails: raised
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "y" } }] },
      { text: "finished" }, // verification passes; the open step refuses the finish
      { text: "that is all of it" },
    ]);
    const verifier = failsOnce();
    const { loop, incidents } = makeLoop(gw, { verifier });
    await collect(loop.run(SMALL, "s1", "/tmp"));
    expect(verifier.calls()).toBeGreaterThanOrEqual(2);
    // Up once, and flat from there: the green check and the refused finish
    // that follow it move nothing.
    expect(gw.efforts.slice(0, 3)).toEqual(["high", "high", "high"]);
    expect(gw.efforts.length).toBeGreaterThanOrEqual(6);
    expect(new Set(gw.efforts.slice(3))).toEqual(new Set(["max"]));
    expect(changes(gw.efforts)).toBe(1);
    expect(incidents.filter((i) => i.class === "loop.effort_latched")).toHaveLength(1);
    expect(incidents.some((i) => i.class === "loop.effort_released")).toBe(false);
  });

  test("a gate that refuses the finish is the harness asking for something, and raises nothing", async () => {
    const gw = makeGateway([
      {
        tools: [
          {
            name: "todo_write",
            args: {
              items: [
                { content: "add the field", status: "in_progress" },
                { content: "update the exporter", status: "pending" },
              ],
            },
          },
        ],
      },
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "x" } }] },
      { text: "finished" }, // the open-steps gate refuses
      { text: "that is all of it" },
    ]);
    const { loop, incidents } = makeLoop(gw);
    const events = await collect(loop.run(SMALL, "s1", "/tmp"));
    // The gate did fire — or this would be a test of nothing.
    expect(events.some((e) => e.type === "notice" && /Open-steps gate/.test(e.message))).toBe(true);
    expect(new Set(gw.efforts)).toEqual(new Set(["high"]));
    expect(incidents.some((i) => i.class === "loop.effort_latched")).toBe(false);
  });

  test("a task that began at the ceiling has nowhere to go, and says nothing when it fails", async () => {
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "a.ts", content: "x" } }] },
      { text: "finished" },
      { text: "fixed" },
    ]);
    const { loop, incidents } = makeLoop(gw, { verifier: failsOnce() });
    await collect(loop.run("fix the crash in the date parser", "s1", "/tmp"));
    expect(new Set(gw.efforts)).toEqual(new Set(["max"]));
    expect(incidents.some((i) => i.class === "loop.effort_latched")).toBe(false);
  });
});

describe("the other modes are what they were", () => {
  test("conservative on Codex still runs every turn at the ceiling, small task or not", async () => {
    const gw = makeGateway(READ_WRITE_DONE);
    const { loop } = makeLoop(gw, { effortRouting: "conservative" });
    await collect(loop.run(SMALL, "s1", "/tmp"));
    expect(new Set(gw.efforts)).toEqual(new Set(["max"]));
  });

  test("conservative on a free host still raises on a refused finish, which task routing does not", async () => {
    const gw = makeGateway([
      {
        tools: [
          {
            name: "todo_write",
            args: {
              items: [
                { content: "add the field", status: "in_progress" },
                { content: "update the exporter", status: "pending" },
              ],
            },
          },
        ],
      },
      { tools: [{ name: "write_file", args: { path: "notes.ts", content: "x" } }] },
      { text: "finished" },
      { text: "that is all of it" },
    ]);
    const { loop, incidents } = makeLoop(gw, {
      effortRouting: "conservative",
      provider: "ollama-turbo",
    });
    await collect(loop.run(SMALL, "s1", "/tmp"));
    expect(gw.efforts.slice(0, 3)).toEqual(["max", "high", "high"]);
    expect(gw.efforts[3]).toBe("max");
    expect(incidents.some((i) => i.class === "loop.effort_latched")).toBe(true);
  });

  test("off, and unset, run the ceiling everywhere", async () => {
    for (const effortRouting of ["off", undefined]) {
      const gw = makeGateway(READ_WRITE_DONE);
      const { loop } = makeLoop(gw, { effortRouting });
      await collect(loop.run(SMALL, "s1", "/tmp"));
      expect(new Set(gw.efforts)).toEqual(new Set(["max"]));
    }
  });
});
