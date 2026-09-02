/**
 * END-TO-END retro through the REAL Engine: a fake OpenAI-compatible endpoint
 * plays the model, the run records a plan and stops with it open, and the
 * session log must end with a `retro` event that says so in numbers — the
 * record `gear audit` and `gear evolve` read, written with zero model calls.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { RunRetro } from "../../packages/orchestrator/src/retro";
import type { ProviderName } from "../../packages/llm-gateway/src/types";

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

describe("Engine retro (end-to-end, fake provider)", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-retro-"));
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a run that stops with its plan open leaves a retro that says so", async () => {
    let requests = 0;
    const script = [
      sseToolCall("todo_write", {
        items: [
          { content: "scaffold the parser", status: "in_progress" },
          { content: "write tests", status: "pending" },
        ],
      }),
      sseText("paused here for today"),
      sseText("stopping for today, the plan stands"),
    ];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.json();
        const body = script[Math.min(requests++, script.length - 1)];
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const engine = makeEngine(dir, server.port!);
    const sid = engine.createSession();
    for await (const _ of engine.chat(sid, "build me a config parser")) {
      // drain
    }
    engine.close();

    // Read the log the way `gear audit` does: straight from the database.
    const db = new Database(join(dir, "gear.db"), { readonly: true });
    const rows = (
      db
        .prepare("SELECT seq, type, payload_json FROM events WHERE session_id = ? ORDER BY seq")
        .all(sid) as Array<{ seq: number; type: string; payload_json: string }>
    ).map((r) => ({
      seq: r.seq,
      event: JSON.parse(r.payload_json) as { type: string; payload: Record<string, unknown> },
    }));
    db.close();

    const retros = rows.filter((r) => r.event.type === "retro");
    expect(retros).toHaveLength(1);
    const payload = retros[0].event.payload as unknown as { retro: RunRetro; model: string };
    expect(payload.model).toBe("fake-model");
    const retro = payload.retro;
    expect(retro.v).toBe(1);
    expect(retro.outcome).toBe("open_steps");
    expect(retro.goal).toBe("build me a config parser");
    expect(retro.steps).toEqual({ total: 2, done: 0, unproven: 0, open: 2 });
    expect(retro.tools.byName.todo_write).toBe(1);
    expect(retro.tools.failed).toBe(0);
    expect(retro.completions).toBe(3);
    expect(retro.gates.plan).toBe(1);
    expect((retro.gates.gate ?? 0) + (retro.gates.handoff ?? 0)).toBeGreaterThan(0);
    expect(retro.lessons).toEqual([]);
    expect(retro.durationMs).toBeGreaterThanOrEqual(0);
    // The retro is the last word after the run's final spine snapshot.
    const lastState = rows.filter((r) => r.event.type === "task_state").at(-1)!;
    expect(retros[0].seq).toBeGreaterThan(lastState.seq);
  });
});
