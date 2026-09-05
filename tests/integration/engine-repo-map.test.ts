import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { ProviderName } from "../../packages/llm-gateway/src/types";

const RUST_RELEASE = join(import.meta.dir, "../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/rune-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "cmpl-repo-map",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

describe("Engine repository-map injection", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-repo-map-engine-"));
    writeFileSync(join(dir, "service.ts"), "export function startService() { return true; }\n");
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!HAS_RUST_BIN)(
    "runs the native map once and sends it through ContextEngine",
    async () => {
      const requests: Array<{ messages: unknown }> = [];
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

      const engine = new Engine({
        model: "fake-model",
        provider: "custom" as ProviderName,
        workspaceRoot: dir,
        dbPath: join(dir, "rune.db"),
        toolsBinaryPath: RUST_BIN,
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
        context: { repoMap: true },
      });

      const session = engine.createSession();
      for await (const _event of engine.chat(session, "fix startService")) {
        // Exhaust the stream; the request capture is the assertion surface.
      }
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].messages)).toContain("startService");
      expect(JSON.stringify(requests[0].messages)).toContain("Repository map");
      engine.close();
    },
  );
});
