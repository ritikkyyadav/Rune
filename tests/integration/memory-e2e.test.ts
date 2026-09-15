/**
 * Autonomous memory through the REAL Engine, with a fake OpenAI-compatible
 * endpoint playing the model.
 *
 * Three claims that only an end-to-end run can settle, because each of them is
 * about wiring rather than about logic:
 *
 *   · a correction the user typed in session 1 reaches session 2's REQUEST —
 *     not a store, not a renderer, the bytes the provider is sent;
 *   · the model's own prose about what it did reaches nothing at all;
 *   · `[memory] enabled = false` writes nothing and injects nothing.
 *
 * Offline: the endpoint is local, scripted, and every memory path is
 * deterministic. No model call is made anywhere but to the fake server.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/orchestrator/src/engine";
import { MemoryStore } from "../../packages/orchestrator/src/memory";
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

function makeEngine(dir: string, port: number, memory?: Record<string, unknown>): Engine {
  return new Engine({
    model: "fake-model",
    provider: "custom" as ProviderName,
    workspaceRoot: dir,
    dbPath: join(dir, "rune.db"),
    toolsBinaryPath: "rune-tools",
    yoloMode: false,
    customEndpoint: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-model", key: "test" },
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    ...(memory ? { memory } : {}),
  } as ConstructorParameters<typeof Engine>[0]);
}

describe("Engine memory (end-to-end, fake provider)", () => {
  let dir: string;
  let home: string;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let bodies: string[] = [];
  let prevDir: string | undefined;
  let prevMd: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-mem-e2e-"));
    home = mkdtempSync(join(tmpdir(), "rune-mem-home-"));
    // A scratch home. Without BOTH of these the run would write on the real
    // ~/.rune, which is the one thing a memory test must never do.
    prevDir = process.env.RUNE_MEMORY_DIR;
    prevMd = process.env.RUNE_SYSTEM_MEMORY_PATH;
    process.env.RUNE_MEMORY_DIR = join(home, "memory");
    process.env.RUNE_SYSTEM_MEMORY_PATH = join(home, "system-memory.md");
    bodies = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    if (prevDir === undefined) delete process.env.RUNE_MEMORY_DIR;
    else process.env.RUNE_MEMORY_DIR = prevDir;
    if (prevMd === undefined) delete process.env.RUNE_SYSTEM_MEMORY_PATH;
    else process.env.RUNE_SYSTEM_MEMORY_PATH = prevMd;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function serve(script: string[]): number {
    let requests = 0;
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        bodies.push(JSON.stringify(await req.json()));
        return new Response(script[Math.min(requests++, script.length - 1)], {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    return server.port!;
  }

  async function drain(engine: Engine, sid: string, message: string): Promise<void> {
    for await (const _ of engine.chat(sid, message)) {
      // drain
    }
  }

  test("a correction in session 1 is in session 2's request, verbatim", async () => {
    // The model is confidently wrong about what it did, in prose. None of it
    // may survive; the user's one sentence must.
    const port = serve([
      sseText("Done — I always use the streaming path here, it is faster and I verified it works."),
    ]);

    const first = makeEngine(dir, port);
    const s1 = first.createSession();
    await drain(first, s1, "no, always run typecheck before you claim a fix");
    first.close();

    // What the store learned, straight off disk.
    const store = new MemoryStore(join(home, "memory"));
    const promoted = store.promoted(dir);
    expect(promoted.map((e) => e.text)).toContain(
      "no, always run typecheck before you claim a fix",
    );
    const entry = promoted.find((e) => e.text.startsWith("no, always run typecheck"))!;
    expect(entry.provenance.source).toBe("user-corrected");

    // The model's prose reached nothing.
    const dump = JSON.stringify(store.all());
    expect(dump).not.toContain("streaming path");
    expect(dump).not.toContain("I verified it works");

    // Session 2, a fresh Engine over the same home.
    bodies = [];
    const second = makeEngine(dir, port);
    const s2 = second.createSession();
    await drain(second, s2, "add a flag to the parser");
    second.close();

    const firstRequest = bodies[0]!;
    expect(firstRequest).toContain("What Rune remembers about you");
    expect(firstRequest).toContain("no, always run typecheck before you claim a fix");
    expect(firstRequest).toContain("The current request outranks all of it");
  }, 30_000);

  test("memory off writes nothing and injects nothing", async () => {
    const port = serve([sseText("done")]);
    const engine = makeEngine(dir, port, { enabled: false });
    const sid = engine.createSession();
    await drain(engine, sid, "no, always run typecheck before you claim a fix");
    engine.close();

    expect(existsSync(join(home, "memory", "entries"))).toBe(false);
    expect(new MemoryStore(join(home, "memory")).all()).toHaveLength(0);
    expect(bodies.join("\n")).not.toContain("What Rune remembers about you");
  }, 30_000);

  test("learning off still injects what is already there", async () => {
    // Two switches, two meanings. `enabled = false` is "memory is off";
    // `learn = false` is "stop adding to it" — a user who has curated a profile
    // by hand should be able to freeze it without losing it.
    const seed = new MemoryStore(join(home, "memory"));
    seed.observe({
      kind: "person",
      text: "I want unsugared facts and no padding",
      source: "user-said",
      sessionId: "seed",
      scope: "global",
    });
    seed.setPinned(seed.all()[0]!.id, true);

    const port = serve([sseText("done")]);
    const engine = makeEngine(dir, port, { learn: false });
    const sid = engine.createSession();
    await drain(engine, sid, "no, always run the linter before you claim a fix");
    engine.close();

    expect(bodies[0]!).toContain("I want unsugared facts and no padding");
    // …and nothing new was learned.
    const after = new MemoryStore(join(home, "memory")).all();
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toBe("I want unsugared facts and no padding");
  }, 30_000);
});
