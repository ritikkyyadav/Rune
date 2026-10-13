/**
 * A run with nobody to ask is not told to ask.
 *
 * Read off the three page builds recorded on 2026-10-09
 * (`~/rune-evidence/design-ab2-20261008`), each a headless run with no browser.
 * Before its first completion the harness told each one, correctly, "nobody is
 * here to answer questions … choose one yourself". Then:
 *
 *   · the note about the missing browser opened "Say so in your read-back's
 *     `leave` list", and each run made a read-back as its second completion;
 *   · each loaded the design skill, searched the web for how its genre looks
 *     and fetched one or two other companies' sites — the steps that word
 *     options for a person to choose between;
 *   · on writing its first screen each was told by the art-direction tripwire
 *     "stop now … search how that genre looks today … put TWO OR THREE concrete
 *     directions to them with ask_user … then rewrite this file".
 *
 * These pin the harness's side: what it says to a run, and when. What a model
 * then does with fewer instructions to disobey is measured by a live run and
 * by nothing here.
 */

import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentLoop,
  UNATTENDED_DESIGN_NOTE,
  UNATTENDED_GREENFIELD_NOTE,
} from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** A scripted model, keeping every request it was sent. */
function makeGateway(turns: Step[]) {
  let i = 0;
  const requests: any[] = [];
  return {
    requests,
    inferStream: mock(async function* (request: any) {
      requests.push(structuredClone({ messages: request.messages }));
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
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

/** `ask_user` is registered, as it is in a headless run; no browser tool is. */
function makeRegistry() {
  const schema = (name: string) => ({
    name,
    version: "0.1.0",
    description: "",
    inputSchema: { type: "object", properties: {} },
    category: ["write_file", "edit_file", "multi_edit"].includes(name) ? "write" : "read",
    permissionLevel: "auto",
  });
  return {
    toLlmTools: mock(() => []),
    list: mock(() => ["write_file", "todo_write", "ask_user"].map(schema)),
    get: mock((name: string) => ({ schema: schema(name) })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, userPresent: boolean | undefined, request: string) {
  const taskState = new TaskStateStore();
  taskState.beginTurn(request);
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
      ...(userPresent === undefined ? {} : { userPresent: () => userPresent }),
    } as any,
    gateway,
    makeRegistry(),
  );
}

/** Everything the model was ever shown: the requests it received and the results it got back. */
function shown(gateway: any, loop: AgentLoop): string {
  return JSON.stringify(gateway.requests) + JSON.stringify(loop.getMessages());
}

const PAGE = "Build a landing page for Driftwood, a specialty coffee subscription.";
const REPORT = "Write up the TP53 findings as something a person can read.";
const ASK_NOTE = "TWO OR THREE concrete directions";
const PAGE_BUILD: Step[] = [
  { tool: "write_file", args: { path: "index.html", content: "<main>hi</main>" } },
  { tool: "write_file", args: { path: "styles.css", content: "main{}" } },
  { text: "Built it." },
];

function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), "rune-nobody-"));
  return fn(ws).finally(() => rmSync(ws, { recursive: true, force: true }));
}

describe("a headless page build", () => {
  test("is told once, before its first completion, to choose a direction and not research one", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway(PAGE_BUILD);
      const loop = makeLoop(gateway, false, PAGE);
      await collect(loop.run(PAGE, "s1", ws));

      const first = JSON.stringify(gateway.requests[0]);
      expect(first).toContain("nobody is here to answer questions");
      expect(first).toContain("do not research one");
      // A reference the request supplies is a requirement, and stays one.
      expect(first).toContain("A reference the request itself supplies is still a requirement");
      expect(shown(gateway, loop).split("nobody is here to answer questions").length - 1).toBe(
        // Once in the transcript, and again in each later request that replays it.
        gateway.requests.length + 1,
      );
    }));

  test("is not told, on writing its first screen, to stop, search and ask after all", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway(PAGE_BUILD);
      const loop = makeLoop(gateway, false, PAGE);
      await collect(loop.run(PAGE, "s1", ws));

      const all = shown(gateway, loop);
      expect(all).not.toContain(ASK_NOTE);
      expect(all).not.toContain("search how that genre looks today");
      expect(all).not.toContain("rewrite this file to it");
    }));

  test("is told where to say the layout was not seen, without being told to make a read-back", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway(PAGE_BUILD);
      const loop = makeLoop(gateway, false, PAGE);
      await collect(loop.run(PAGE, "s1", ws));

      const first = JSON.stringify(gateway.requests[0]);
      expect(first).toContain("no browser in this run");
      expect(first).toContain("State in your final report");
      // The old opening, which every recorded run answered with a read_back call.
      expect(first).not.toContain("Say so in your read-back");
      // Still said, for the run that has one — and still forbidding the stand-in.
      expect(first).toContain("if this task has one");
      expect(first).toContain("Do not serve the page");
    }));
});

describe("a headless run whose request did not read as a screen", () => {
  test("hears it on the first screen it writes, in one sentence, and only once", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway([
        { tool: "write_file", args: { path: "report.html", content: "<main>hi</main>" } },
        { tool: "write_file", args: { path: "report.css", content: "main{}" } },
        { text: "Wrote it." },
      ]);
      const loop = makeLoop(gateway, false, REPORT);
      await collect(loop.run(REPORT, "s1", ws));

      // Nothing up front: the request named no screen.
      expect(JSON.stringify(gateway.requests[0])).not.toContain("nobody is here");
      const transcript = JSON.stringify(loop.getMessages());
      expect(transcript.split("nobody is here to answer questions").length - 1).toBe(1);
      expect(transcript).toContain("This is the first screen of something a person will look at");
      expect(transcript).not.toContain(ASK_NOTE);
    }));
});

describe("a run with someone to ask is asked, exactly as before", () => {
  for (const [label, present] of [
    ["a person is there", true],
    ["nothing says either way", undefined],
  ] as const) {
    test(`${label}: the first screen still stops for the art-direction question`, () =>
      withWorkspace(async (ws) => {
        const gateway = makeGateway(PAGE_BUILD);
        const loop = makeLoop(gateway, present, PAGE);
        await collect(loop.run(PAGE, "s1", ws));

        const all = shown(gateway, loop);
        expect(all).toContain(ASK_NOTE);
        expect(all).toContain("ask_user");
        expect(all).not.toContain("nobody is here to answer questions");
      }));
  }

  test("a plan that names a screen still gets the question at plan time", () =>
    withWorkspace(async (ws) => {
      const plan: Step[] = [
        {
          tool: "todo_write",
          args: { items: [{ content: "Build the landing page hero", status: "in_progress" }] },
        },
        { text: "Planned." },
      ];
      const asked = makeGateway(plan);
      const withPerson = makeLoop(asked, true, PAGE);
      await collect(withPerson.run(PAGE, "s1", ws));
      expect(shown(asked, withPerson)).toContain("Ask BEFORE the first screen is written");

      const unasked = makeGateway(plan);
      const alone = makeLoop(unasked, false, PAGE);
      await collect(alone.run(PAGE, "s1", ws));
      expect(shown(unasked, alone)).not.toContain("Ask BEFORE the first screen is written");
    }));
});

describe("a new project started with nobody to ask", () => {
  const scaffold: Step[] = [
    { tool: "write_file", args: { path: "tracker/package.json", content: "{}" } },
    { text: "Scaffolded." },
  ];

  test("is told to state its assumptions, not to stop and ask", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway(scaffold);
      const loop = makeLoop(gateway, false, "Build me a task tracker.");
      await collect(loop.run("Build me a task tracker.", "s1", ws));

      const transcript = JSON.stringify(loop.getMessages());
      expect(transcript).toContain("nobody is here to ask");
      expect(transcript).toContain("state each in one line of your final report");
      expect(transcript).not.toContain("stop and ask now");
    }));

  test("with a person there it is still told to stop and ask", () =>
    withWorkspace(async (ws) => {
      const gateway = makeGateway(scaffold);
      const loop = makeLoop(gateway, true, "Build me a task tracker.");
      await collect(loop.run("Build me a task tracker.", "s1", ws));

      const transcript = JSON.stringify(loop.getMessages());
      expect(transcript).toContain("stop and ask now");
      expect(transcript).not.toContain("nobody is here to ask");
    }));
});

describe("the words themselves", () => {
  test("neither note sends a headless run to a tool it was just told not to use", () => {
    for (const note of [UNATTENDED_DESIGN_NOTE, UNATTENDED_GREENFIELD_NOTE]) {
      expect(note).not.toMatch(/\bweb_search\b|\bweb_fetch\b|\bskill\b/);
      expect(note).not.toMatch(/stop now|stop and ask/i);
    }
    // The one mention of ask_user is the instruction not to call it.
    expect(UNATTENDED_DESIGN_NOTE).toContain("Do not call ask_user");
    expect(UNATTENDED_GREENFIELD_NOTE).not.toContain("ask_user");
  });
});
