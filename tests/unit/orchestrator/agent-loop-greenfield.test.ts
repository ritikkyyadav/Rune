/**
 * Greenfield-clarify tripwire: the task's FIRST write creating a brand-new
 * top-level project directory, with zero clarifying questions asked, gets
 * exactly one harness note pushing an ask_user round — the deterministic
 * backstop for "build me a clone of X" answered with a silently-chosen stack
 * and a static mock. Root-level files, existing directories, prior
 * clarifications, and 4th gear (no ask_user in the registry) never trip it.
 */

import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
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

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
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

function makeRegistry(opts: { askUser?: boolean } = {}) {
  const askUser = opts.askUser ?? true;
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => {
      if (name === "ask_user" && !askUser) return undefined;
      return {
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: ["write_file", "edit_file", "multi_edit"].includes(name) ? "write" : "read",
          permissionLevel: "auto",
        },
      };
    }),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(
  gateway: any,
  taskState: TaskStateStore,
  registry: any,
  opts: Record<string, unknown> = {},
) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
      ...opts,
    } as any,
    gateway,
    registry,
  );
}

const NOTE = "starting a NEW project from scratch";

function notesIn(loop: AgentLoop): number {
  const transcript = JSON.stringify(loop.getMessages());
  return transcript.split(NOTE).length - 1;
}

function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), "gear-greenfield-"));
  return fn(ws).finally(() => rmSync(ws, { recursive: true, force: true }));
}

describe("greenfield-clarify tripwire", () => {
  test("first write into a new top-level dir with no questions asked → exactly one note + incident", () =>
    withWorkspace(async (ws) => {
      const incidents: string[] = [];
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "write_file", args: { path: "newapp/index.html" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry(), {
        onIncident: (i: any) => incidents.push(i.class),
      });
      await collect(loop.run("build me a clone of cluely", "s1", ws));
      expect(notesIn(loop)).toBe(1);
      expect(incidents).toContain("loop.greenfield_nudge");
    }));

  test("writing into an EXISTING top-level dir never trips it", () =>
    withWorkspace(async (ws) => {
      mkdirSync(join(ws, "src"));
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "write_file", args: { path: "src/feature.ts" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry());
      await collect(loop.run("add the feature", "s1", ws));
      expect(notesIn(loop)).toBe(0);
    }));

  test("a root-level file is not a project — no note", () =>
    withWorkspace(async (ws) => {
      const ts = new TaskStateStore();
      const gw = makeGateway([{ tool: "write_file", args: { path: "script.py" } }, { text: "ok" }]);
      const loop = makeLoop(gw, ts, makeRegistry());
      await collect(loop.run("write me a script", "s1", ws));
      expect(notesIn(loop)).toBe(0);
    }));

  test("without ask_user in the registry (4th gear) the nudge is pointless — suppressed", () =>
    withWorkspace(async (ws) => {
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "write_file", args: { path: "newapp/index.html" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry({ askUser: false }));
      await collect(loop.run("build me a clone of cluely", "s1", ws));
      expect(notesIn(loop)).toBe(0);
    }));

  test("asking FIRST satisfies the gate — the later new-dir write gets no note", () =>
    withWorkspace(async (ws) => {
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "ask_user", args: { question: "Platform and depth?" } },
        { tool: "write_file", args: { path: "newapp/index.html" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry());
      await collect(loop.run("build me a clone of cluely", "s1", ws));
      expect(ts.clarificationCount()).toBe(1);
      expect(notesIn(loop)).toBe(0);
    }));

  test("fires at most once per run even across several new directories", () =>
    withWorkspace(async (ws) => {
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "write_file", args: { path: "appone/index.html" } },
        { tool: "write_file", args: { path: "apptwo/index.html" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry());
      await collect(loop.run("build two apps", "s1", ws));
      expect(notesIn(loop)).toBe(1);
    }));

  test("paths escaping the workspace never qualify", () =>
    withWorkspace(async (ws) => {
      const ts = new TaskStateStore();
      const gw = makeGateway([
        { tool: "write_file", args: { path: "../outside/index.html" } },
        { text: "done" },
      ]);
      const loop = makeLoop(gw, ts, makeRegistry());
      await collect(loop.run("build", "s1", ws));
      expect(notesIn(loop)).toBe(0);
    }));
});
