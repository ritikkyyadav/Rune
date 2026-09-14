/**
 * S3 — shadow mode changes neither actions nor spend.
 *
 * The same scripted scenario is run twice against the same fixture: once with
 * the shadow controller on, once with it off. Three things must be identical,
 * and all three are compared as whole values rather than counts:
 *
 *   * the `AgentTurnEvent` sequence the run yields — the shadow rows are not
 *     in it, because they are not events;
 *   * the spend fingerprint — every request the loop sent, verbatim, which is
 *     what a provider bills on;
 *   * the workspace — every file the run wrote, byte for byte.
 *
 * The scenario is deliberately one that trips guards: a write with nothing
 * executed refuses the finish once (G4), the run then runs something and
 * finishes. A shadow lane that is passive must leave that sequence alone.
 *
 * Zero model calls: the gateway is a script, the registry is a fake that
 * writes real files, and nothing here reads a credential or a network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import { ShadowArbiter, type ShadowRow } from "../../packages/orchestrator/src/shadow-arbiter";
import { rmTemp } from "../helpers/tmp";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmTemp(dir);
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-shadow-"));
  temps.push(dir);
  return dir;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

/** Every request the loop sent, verbatim — the fingerprint a provider bills on. */
type Spend = { requests: string[] };

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

function makeGateway(script: Step[], spend: Spend) {
  let i = 0;
  return {
    inferStream: async function* (request: Record<string, unknown>) {
      spend.requests.push(JSON.stringify(request));
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: step.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: step.args ?? {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: step.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A registry that really writes files, so "identical files" is a real claim. */
function makeRegistry(root: string) {
  return {
    toLlmTools: () => [
      { name: "write_file", description: "", inputSchema: {} },
      { name: "bash", description: "", inputSchema: {} },
    ],
    list: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : "execute",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string; args: Record<string, unknown> }) => {
      if (input.toolName === "write_file") {
        writeFileSync(join(root, String(input.args.path ?? "out.txt")), String(input.args.content));
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: input.toolName === "write_file" ? "written" : "ok",
        durationMs: 1,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Write, try to finish (G4 refuses once), run something, finish. */
const SCRIPT: Step[] = [
  { tool: "write_file", args: { path: "a.txt", content: "one\n" } },
  { text: "all done" },
  { tool: "bash", args: { command: "node a.js" } },
  { text: "verified and done" },
];

async function run(shadowOn: boolean): Promise<{
  events: AgentTurnEvent[];
  spend: Spend;
  root: string;
  rows: ShadowRow[];
}> {
  const root = workspace();
  const spend: Spend = { requests: [] };
  const rows: ShadowRow[] = [];
  const shadow = shadowOn
    ? new ShadowArbiter({
        runId: "s1#1",
        emit: (row) => rows.push(row),
        now: () => "2026-09-14T00:00:00.000Z",
      })
    : null;
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 8,
      systemPrompt: "s",
      ...(shadow ? { shadow } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(SCRIPT, spend),
    makeRegistry(root),
  );
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("build it", "s1", root)) events.push(e);
  shadow?.finish();
  return { events, spend, root, rows };
}

function tree(root: string): Array<[string, string]> {
  return readdirSync(root)
    .sort()
    .map((name) => [name, readFileSync(join(root, name), "utf8")] as [string, string]);
}

describe("S3 — the shadow controller changes neither actions nor spend", () => {
  test("the same scenario with shadow on and off is the same run", async () => {
    const on = await run(true);
    const off = await run(false);

    // 1. The same events, in the same order, carrying the same fields.
    expect(JSON.stringify(on.events)).toBe(JSON.stringify(off.events));

    // 2. The same requests — every byte the provider would have been billed
    //    for. A shadow lane that added one token to one prompt fails here.
    expect(on.spend.requests.length).toBe(off.spend.requests.length);
    expect(on.spend.requests).toEqual(off.spend.requests);

    // 3. The same workspace.
    expect(tree(on.root)).toEqual(tree(off.root));

    // And the run really did exercise a guard, so this is not vacuous: the
    // execution-evidence gate refused the first finish.
    const notices = on.events.filter((e) => e.type === "notice").map((e) => JSON.stringify(e));
    expect(notices.some((n) => n.includes("Execution-evidence gate"))).toBe(true);
  });

  test("with shadow off not one row is written", async () => {
    const off = await run(false);
    expect(off.rows).toEqual([]);
  });

  test("with shadow on the rows exist and say they applied nothing", async () => {
    const on = await run(true);
    const written = on.rows.filter((r) => r.type === "shadow_decision");
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(row.type === "shadow_decision" && row.applied).toBe(false);
    }
    expect(on.rows.filter((r) => r.type === "shadow_summary").length).toBe(1);
  });

  test("the terminal event is identical, verdict included", async () => {
    const on = await run(true);
    const off = await run(false);
    const terminal = (events: AgentTurnEvent[]) => events.find((e) => e.type === "turn_complete");
    expect(terminal(on.events)).toEqual(terminal(off.events)!);
  });
});
