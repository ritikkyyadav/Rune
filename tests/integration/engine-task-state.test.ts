/**
 * END-TO-END task-spine resume through the REAL Engine: a fake
 * OpenAI-compatible endpoint plays the model, run 1 records a todo list, the
 * engine process "restarts" (a brand-new Engine on the same session DB), and
 * the resumed run's FIRST model request must carry the [Task state] block with
 * the surviving todos. This is the contract the whole spine exists for: task
 * state independent of transcript fidelity, restored purely from the session
 * log's `task_state` snapshots.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { ProviderName } from "../../packages/llm-gateway/src/types";

type Recorded = { messages: Array<{ role: string; content: unknown }> };

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

const sseToolCall = (name: string, args: Record<string, unknown>): string =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }],
    },
    null,
  ) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

function makeEngine(dir: string, port: number): Engine {
  return new Engine({
    model: "fake-model",
    provider: "custom" as ProviderName,
    workspaceRoot: dir,
    dbPath: join(dir, "gear.db"),
    toolsBinaryPath: "gear-tools",
    yoloMode: false,
    customEndpoint: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "fake-model",
      key: "test",
    },
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
  });
}

describe("Engine task-spine resume (end-to-end, fake provider)", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-taskstate-"));
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("todos recorded in run 1 reach the model of run 2 across an engine restart", async () => {
    const requests: Recorded[] = [];
    // Script: run 1 = todo_write then a wrap-up sentence; run 2 = text only.
    const script = [
      sseToolCall("todo_write", {
        items: [
          { content: "scaffold the parser", status: "completed" },
          { content: "handle comments", status: "in_progress" },
          { content: "write tests", status: "pending" },
        ],
      }),
      sseText("paused here for today"),
      sseText("resuming where we left off"),
    ];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        requests.push((await req.json()) as Recorded);
        const body = script[Math.min(requests.length - 1, script.length - 1)];
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    // ── Run 1: the model records a plan, then stops mid-task. ──
    const engine1 = makeEngine(dir, server.port);
    const sid = engine1.createSession();
    for await (const _ of engine1.chat(sid, "build me a config parser")) {
      // drain
    }
    engine1.close();

    // ── Run 2: a BRAND NEW engine (fresh process, same DB) resumes. ──
    const engine2 = makeEngine(dir, server.port);
    for await (const _ of engine2.chat(sid, "continue")) {
      // drain
    }
    engine2.close();

    // The resumed run's first request carried the restored spine.
    const resumed = requests[2];
    expect(resumed).toBeDefined();
    const text = resumed.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(text).toContain("[Task state — maintained by the harness");
    expect(text).toContain("[x] scaffold the parser");
    expect(text).toContain("[>] handle comments");
    expect(text).toContain("[ ] write tests");
    expect(text).toContain("Goal: build me a config parser");
  });
});
