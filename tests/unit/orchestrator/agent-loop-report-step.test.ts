/**
 * A step that IS the report closes with the report.
 *
 * The failure this pins (session 01a067b8): "Hand the user the one command to
 * start the server locally" was refused as "nothing ran while it was open" five
 * times in one run. Each refusal cost a completion, then a command run purely
 * to back the handoff — and each one latched reasoning effort to the ceiling
 * for the rest of the run.
 *
 * The rule is narrow: the verb must address the user, or the step must be the
 * final report. Ordinary steps with nothing behind them are refused exactly as
 * before, and a step closed over a FAILING check still latches effort.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import {
  TaskStateStore,
  isReportStep,
  stepReceipt,
} from "../../../packages/orchestrator/src/task-state";

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

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      if (input.toolName === "bash" && /bun test/.test(String(input.args.command))) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          error: "2 tests failed\nerror: expect(received).toBe(expected)",
          durationMs: 1,
        };
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result:
          input.toolName === "todo_write"
            ? JSON.stringify({ items: input.args.items })
            : input.toolName === "write_file"
              ? JSON.stringify({ path: input.args.path, hash: "h" })
              : "ok",
        durationMs: 1,
      };
    }),
  } as any;
}

function makeLoop(gateway: any, taskState: TaskStateStore, incidents: string[]) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 20,
      systemPrompt: "s",
      taskState,
      effortRouting: "conservative",
      thinkingEffort: "max",
      onIncident: (i: { class: string }) => incidents.push(i.class),
    } as any,
    gateway,
    makeRegistry(),
  );
}

function toolResultFor(loop: AgentLoop, callId: string): { text: string; isError: boolean } | null {
  for (const m of loop.getMessages()) {
    if (m.role !== "tool") continue;
    for (const b of m.content as any[]) {
      if (b.type === "tool_result" && b.toolCallId === callId) {
        return { text: String(b.toolResultContent), isError: b.isError === true };
      }
    }
  }
  return null;
}

const todo = (items: Array<{ content: string; status: string }>): Step => ({
  tool: "todo_write",
  args: { items },
});

describe("isReportStep", () => {
  test("the shapes that were refused in the wild match", () => {
    expect(
      isReportStep("Hand the user the one command to start the server locally and see it"),
    ).toBe(true);
    expect(isReportStep("Hand back: what I built, what I verified, and the one command")).toBe(
      true,
    );
    expect(isReportStep("Final report with what is untested")).toBe(true);
    expect(isReportStep("Tell the user which steps remain undone")).toBe(true);
    expect(isReportStep("Explain the trade-off to the user")).toBe(true);
  });

  test("ordinary work that merely mentions reporting does not", () => {
    expect(isReportStep("Write the report generator in src/report.ts")).toBe(false);
    expect(isReportStep("Summarise the dataset into results.csv")).toBe(false);
    expect(isReportStep("Reopen index.html in the user's browser after the fix")).toBe(false);
    expect(isReportStep("Build the hero + menu")).toBe(false);
  });
});

describe("isReportStep — the shapes a weak model must NOT be able to close for free", () => {
  test("'the user' as the start of a noun phrase is ordinary work", () => {
    expect(isReportStep("Show the user's orders on the dashboard")).toBe(false);
    expect(isReportStep("Show the user’s orders on the dashboard")).toBe(false);
    expect(isReportStep("Update the user table schema")).toBe(false);
    expect(isReportStep("Present the results to the user interface")).toBe(false);
    expect(isReportStep("Tell the user model apart from the account model")).toBe(false);
  });

  test("a 'final report' that is a thing to build is ordinary work", () => {
    expect(isReportStep("Build the final report generator")).toBe(false);
    expect(isReportStep("Add the final summary endpoint")).toBe(false);
  });

  test("a hand-off to another worker is delegation, not the handoff to the user", () => {
    expect(isReportStep("Hand off the API design to the backend team")).toBe(false);
    expect(isReportStep("Hand over the parser to a sub-agent")).toBe(false);
  });

  test("…while the communication shapes still match", () => {
    expect(isReportStep("Tell the user which steps remain undone")).toBe(true);
    expect(isReportStep("Walk the user through the setup")).toBe(true);
    expect(isReportStep("Notify the user when the build is green")).toBe(true);
    expect(isReportStep("Hand off: what I built, what is untested")).toBe(true);
    expect(isReportStep("Report back to the user.")).toBe(true);
    expect(isReportStep("Final summary with what is untested")).toBe(true);
  });
});

describe("the report mark survives later plan writes", () => {
  test("re-submitting the list keeps closedBy and its receipt", () => {
    const s = new TaskStateStore();
    s.beginTurn("build the shop");
    s.setTodos([{ content: "Build index.html", status: "in_progress" }]);
    s.noteEffect("write");
    s.setTodos([
      { content: "Build index.html", status: "completed" },
      { content: "Hand the user the one command", status: "in_progress" },
    ]);
    s.setTodos([
      { content: "Build index.html", status: "completed" },
      { content: "Hand the user the one command", status: "completed" },
    ]);
    // The next write — the model adds a step — used to rebuild the item
    // without the mark, turning "closed by report" into a bare tick.
    s.setTodos([
      { content: "Build index.html", status: "completed" },
      { content: "Hand the user the one command", status: "completed" },
      { content: "Polish the footer", status: "pending" },
    ]);
    const item = s.snapshot().todos[1];
    expect(item.closedBy).toBe("report");
    expect(stepReceipt(item)).toBe("closed by report");
  });
});

describe("report steps in the ledger", () => {
  test("a report step with nothing behind it is accepted, shown as done, receipted as closed by report", () => {
    const s = new TaskStateStore();
    s.beginTurn("build the shop");
    s.setTodos([{ content: "Build index.html", status: "in_progress" }]);
    s.noteEffect("write");
    s.setTodos([
      { content: "Build index.html", status: "completed" },
      { content: "Hand the user the one command to open the site", status: "in_progress" },
    ]);
    const verdict = s.setTodos([
      { content: "Build index.html", status: "completed" },
      { content: "Hand the user the one command to open the site", status: "completed" },
    ]);
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.notes.join(" ")).toContain("closes with your report");
    const item = s.snapshot().todos[1];
    expect(item.status).toBe("completed");
    expect(item.unproven).toBeUndefined();
    expect(item.closedBy).toBe("report");
    expect(stepReceipt(item)).toBe("closed by report");
    expect(s.todoCounts()).toEqual({ done: 2, total: 2, unproven: 0, open: 0 });
  });

  test("an ordinary step with nothing behind it is still refused once", () => {
    const s = new TaskStateStore();
    s.beginTurn("build the shop");
    s.setTodos([{ content: "Wire the cart", status: "in_progress" }]);
    const verdict = s.setTodos([{ content: "Wire the cart", status: "completed" }]);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.refused[0].reason).toContain("nothing ran");
  });
});

describe("the loop: refusals and the effort latch", () => {
  test("closing the handoff step is not refused and does not latch effort", async () => {
    const incidents: string[] = [];
    const ts = new TaskStateStore();
    // A non-visual file and a real run after it, so the finish is judged by the
    // ledger alone and not by the evidence or product-sight gates.
    const gw = makeGateway([
      todo([{ content: "Build the order module", status: "in_progress" }]),
      { tool: "write_file", args: { path: "src/orders.ts", content: "export const x = 1;" } },
      { tool: "bash", args: { command: "bun run src/orders.ts" } },
      todo([
        { content: "Build the order module", status: "completed" },
        { content: "Hand the user the one command to open the site", status: "in_progress" },
      ]),
      todo([
        { content: "Build the order module", status: "completed" },
        { content: "Hand the user the one command to open the site", status: "completed" },
      ]),
      { text: "Run `bun run src/orders.ts`." },
    ]);
    const loop = makeLoop(gw, ts, incidents);
    await collect(loop.run("build me a shop site", "s1", "/tmp"));

    const last = toolResultFor(loop, "c5")!;
    expect(last.isError).toBe(false);
    expect(last.text).toContain("closes with your report");
    expect(incidents).not.toContain("loop.step_refused");
    expect(incidents).not.toContain("loop.effort_latched");
  });

  test("a no-evidence refusal on an ordinary step no longer latches effort", async () => {
    const incidents: string[] = [];
    const ts = new TaskStateStore();
    // Refused once; then the step is actually done and the list re-submitted
    // with a report step added (a different call, so the loop's own repeat
    // detector — which also latches — stays out of the measurement), so the
    // run ends with nothing open and no finish gate in the way.
    const gw = makeGateway([
      todo([{ content: "Wire the cart", status: "in_progress" }]),
      todo([{ content: "Wire the cart", status: "completed" }]),
      { tool: "bash", args: { command: "bun run src/cart.ts" } },
      todo([
        { content: "Wire the cart", status: "completed" },
        { content: "Tell the user how to run it", status: "completed" },
      ]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, incidents);
    await collect(loop.run("build me a shop site", "s1", "/tmp"));

    const refused = toolResultFor(loop, "c2")!;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("nothing ran");
    expect(incidents).toContain("loop.step_refused");
    expect(incidents).not.toContain("loop.effort_latched");
  });

  test("a step closed over a FAILING check is refused AND still latches effort", async () => {
    const incidents: string[] = [];
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([{ content: "fix the parser tests", status: "in_progress" }]),
      { tool: "bash", args: { command: "bun test" } },
      todo([{ content: "fix the parser tests", status: "completed" }]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, incidents);
    await collect(loop.run("fix the parser tests", "s1", "/tmp"));

    const refused = toolResultFor(loop, "c3")!;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("FAILED");
    expect(incidents).toContain("loop.effort_latched");
  });
});
