/**
 * What a `worker` hands back to the lead that dispatched it.
 *
 * Parity with subagent-summary-provenance.test.ts, and it matters MORE here:
 * over three days of recorded sessions `worker` accounted for 170 minutes of
 * wall clock (against 64 for `task`), averaging 253s per call. Its report was
 * `report += event.text` across the whole run — the same accumulate-everything
 * bug — so the lead integrated builds against the worker's running commentary
 * rather than its account of what it actually built.
 *
 * These tests need no gear-tools binary: the worker writes nothing, so the
 * scripted "model" only ever emits text.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerTool } from "../../../packages/orchestrator/src/worker";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";
import type { StreamEvent } from "../../../packages/llm-gateway/src/types";

const ws = () => mkdtempSync(join(tmpdir(), "worker-rp-"));

type Turn = { text: string; tool?: boolean };

/**
 * Fake gateway. A `tool` turn ends on a `read_file` call the worker registry
 * really has (reads are unrestricted for workers), so the loop takes its
 * tool-call path without touching the filesystem guard.
 */
function scriptedGateway(script: Turn[], pre?: StreamEvent[]) {
  let turn = 0;
  const requests: any[] = [];
  return {
    requests,
    inferStream: async function* (req: any): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const step = script[Math.min(turn, script.length - 1)];
      turn++;
      yield { type: "message_start", messageId: `m${turn}` };
      if (turn === 1 && pre) for (const e of pre) yield e;
      if (step.text) {
        yield {
          type: "content_delta",
          contentIndex: 0,
          delta: { type: "text_delta", text: step.text },
        };
      }
      if (step.tool) {
        yield { type: "tool_use_start", toolCallId: `t${turn}`, toolName: "read_file" };
        yield {
          type: "tool_use_stop",
          toolCallId: `t${turn}`,
          toolInput: { path: `src/f${turn}.ts` },
        };
        yield {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

function runWorker(gateway: any, root: string, args?: Record<string, unknown>) {
  const tool = createWorkerTool({
    binaryPath: "/nonexistent/gear-tools",
    resolve: () => ({ gateway, model: "frontier-model", provider: "anthropic" as any }),
  });
  return tool.execute({
    toolName: "worker",
    callId: "c1",
    sessionId: "s",
    workspaceRoot: root,
    args: { prompt: "Build widget.ts", files: ["widget.ts"], effort: "quick", ...args },
  } as ToolCallInput);
}

const NARRATED: Turn[] = [
  { text: "Let me look at the existing widget shape first.", tool: true },
  { text: "Hmm, that import is probably circular.", tool: true },
  { text: "Actually it is fine — same module.", tool: true },
  { text: "REPORT: widget.ts exports widget(); the lead must wire it into index.ts." },
];

describe("the worker report is the text after its last tool call", () => {
  test("the real report survives", async () => {
    const out = await runWorker(scriptedGateway(NARRATED), ws());
    expect(out.result).toContain("widget.ts exports widget()");
  });

  test("working narration does not reach the lead", async () => {
    const out = await runWorker(scriptedGateway(NARRATED), ws());
    expect(out.result).not.toContain("Let me look at the existing widget shape");
    expect(out.result).not.toContain("that import is probably circular");
  });

  test("a re-streamed turn is not counted twice", async () => {
    const g = scriptedGateway([{ text: "REPORT: done." }], [{ type: "stream_reset" }]);
    const out = await runWorker(g, ws());
    expect(out.result.match(/REPORT: done\./g)?.length).toBe(1);
  });
});

describe("a demoted worker says so", () => {
  const swap: StreamEvent[] = [
    {
      type: "fallback",
      from: { provider: "anthropic", model: "frontier-model" },
      to: { provider: "openrouter", model: "minimax/minimax-m3:free" },
      reason: "429 The usage limit has been reached",
    } as StreamEvent,
  ];

  test("the report names the model that actually wrote the code", async () => {
    const out = await runWorker(scriptedGateway([{ text: "REPORT: built it." }], swap), ws());
    expect(out.result).toContain("PROVENANCE");
    expect(out.result).toContain("openrouter/minimax/minimax-m3:free");
  });

  test("it tells the lead to review the diff and run the checks", async () => {
    const out = await runWorker(scriptedGateway([{ text: "REPORT: built it." }], swap), ws());
    expect(out.result).toContain("review its diff");
  });

  test("a worker that was demoted and then built nothing names the model in its error", async () => {
    // Nothing written and nothing changed: the failure path used to report a
    // bare "produced nothing", which reads like the model's fault rather than
    // the fallback's, and sends the lead straight back into the same wall.
    const g = scriptedGateway([{ text: "" }], swap);
    const out = await runWorker(g, ws());
    expect(out.success).toBe(false);
    expect(out.error).toContain("openrouter/minimax/minimax-m3:free");
  });

  test("an undemoted worker carries no banner", async () => {
    const out = await runWorker(scriptedGateway([{ text: "REPORT: built it." }]), ws());
    expect(out.result).not.toContain("PROVENANCE");
  });
});

describe("the worker can see its turn budget", () => {
  test("every request carries the clock", async () => {
    const g = scriptedGateway([{ text: "REPORT: done." }]);
    await runWorker(g, ws());
    expect(JSON.stringify(g.requests[0].messages.at(-1))).toContain("Budget: turn 1 of 12");
  });

  test("the last two turns say to write the report now", async () => {
    const g = scriptedGateway([{ text: "still building", tool: true }]);
    await runWorker(g, ws());
    const tail = JSON.stringify(g.requests.at(-1).messages.at(-1));
    expect(tail).toContain("WRAP UP NOW");
  });
});
