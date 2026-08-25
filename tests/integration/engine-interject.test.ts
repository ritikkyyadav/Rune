/**
 * END-TO-END mid-turn steering through the REAL Engine: a local fake
 * OpenAI-compatible endpoint plays the model, engine.chat() runs a real
 * session, and engine.interject() lands a user message WHILE the run is in
 * flight. Proves the full chain the unit tests can't:
 *   TUI/frontend → Engine.interject → live AgentLoop → next model request
 *   actually CONTAINS the steering text → session log persists it as a real
 *   user turn in the right position for resume/replay.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import { INTERJECTION_MARKER } from "../../packages/orchestrator/src/agent-loop";
import type { ProviderName } from "../../packages/llm-gateway/src/types";

/** One streamed OpenAI chat.completion response for the given text. */
function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

describe("Engine mid-turn steering (end-to-end, fake provider)", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-interject-"));
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test("interject mid-run: model sees it, session log persists it in order", async () => {
    // Fake model: turn 1 answers "half done", every later turn "done for real".
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        const body = (await req.json()) as (typeof requests)[number];
        requests.push(body);
        return new Response(sse(requests.length === 1 ? "half done" : "done for real"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const engine = new Engine({
      model: "fake-model",
      provider: "custom" as ProviderName,
      workspaceRoot: dir,
      dbPath: join(dir, "gear.db"),
      toolsBinaryPath: "gear-tools",
      yoloMode: false,
      customEndpoint: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
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

    const sid = engine.createSession();
    const notices: string[] = [];
    let steered = false;
    let accepted = false;
    for await (const ev of engine.chat(sid, "build the landing page")) {
      if (ev.type === "notice") notices.push(ev.message);
      if (!steered && ev.type === "text_delta") {
        steered = true;
        accepted = engine.interject("also add a dark footer");
      }
    }

    // The live run accepted the steering and told the user it landed.
    expect(accepted).toBe(true);
    expect(notices.some((n) => /folded into/i.test(n))).toBe(true);

    // The SECOND model request actually contained the steering text.
    expect(requests.length).toBe(2);
    const second = requests[1].messages.map((m) => String(m.content ?? "")).join("\n");
    expect(second).toContain(INTERJECTION_MARKER);
    expect(second).toContain("also add a dark footer");

    // The session log replays the same conversation the live run saw:
    // user → assistant(half done) → user(steering, RAW text) → assistant(done).
    const lines = engine
      .getTranscript(sid)
      .filter((l) => l.role === "user" || l.role === "assistant")
      .map((l) => `${l.role}:${l.text}`);
    expect(lines).toEqual([
      "user:build the landing page",
      "assistant:half done",
      "user:also add a dark footer",
      "assistant:done for real",
    ]);

    // Idle engine: nothing steerable — callers must queue instead.
    expect(engine.interject("too late")).toBe(false);
    engine.close();
  });
});
