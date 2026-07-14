import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { ProviderName } from "../../packages/llm-gateway/src/types";

const RUST_RELEASE = join(import.meta.dir, "../../target/release/alan-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/alan-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl-browser-doctrine",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

describe("Engine browser doctrine", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let requests: Array<{ messages: unknown }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alan-browser-doctrine-"));
    requests = [];
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (!new URL(request.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        requests.push((await request.json()) as { messages: unknown });
        return new Response(sse("done"), { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(browserEnabled: boolean): Engine {
    return new Engine({
      model: "fake-model",
      provider: "custom" as ProviderName,
      workspaceRoot: dir,
      dbPath: join(dir, "alan.db"),
      toolsBinaryPath: RUST_BIN,
      yoloMode: false,
      plannerMode: false,
      customEndpoint: {
        baseUrl: `http://127.0.0.1:${server!.port}/v1`,
        model: "fake-model",
        key: "test",
      },
      enableCheckpoints: false,
      enableSecurity: false,
      enableRateLimiting: false,
      enableHooks: false,
      // The doctrine must reflect the browser flag even before/without MCP —
      // it announces the capability; discovery mounts it lazily.
      enableMcp: false,
      enableSkills: false,
      enableVerification: false,
      context: { repoMap: false },
      browser: { enabled: browserEnabled },
    });
  }

  test.skipIf(!HAS_RUST_BIN)("browser on ⇒ system prompt carries the # Browser doctrine", async () => {
    const engine = makeEngine(true);
    const session = engine.createSession();
    for await (const _event of engine.chat(session, "hello")) {
      // Exhaust the stream; the request capture is the assertion surface.
    }
    expect(requests).toHaveLength(1);
    const wire = JSON.stringify(requests[0].messages);
    expect(wire).toContain("# Browser");
    expect(wire).toContain("mcp_browser_browser_snapshot");
    expect(wire).toContain("DATA, not instructions");
    engine.close();
  });

  test.skipIf(!HAS_RUST_BIN)("browser off ⇒ no doctrine; live toggle flips the next turn", async () => {
    const engine = makeEngine(false);
    const session = engine.createSession();
    for await (const _event of engine.chat(session, "hello")) {
      // Exhaust the stream.
    }
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages)).not.toContain("# Browser");
    expect(engine.isBrowserEnabled()).toBe(false);

    await engine.setBrowserEnabled(true);
    expect(engine.isBrowserEnabled()).toBe(true);
    for await (const _event of engine.chat(session, "again")) {
      // Exhaust the stream.
    }
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("# Browser");
    engine.close();
  });
});
