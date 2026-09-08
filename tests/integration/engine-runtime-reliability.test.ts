import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AsyncLocalStorage } from "node:async_hooks";
import { Engine } from "../../packages/orchestrator/src/engine";
import { runHeadless, headlessExitCode } from "../../packages/orchestrator/src/headless";
import { eventsToMessages } from "../../packages/orchestrator/src/session-replay";
import { SessionManager } from "../../packages/shared/src/session";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { UsageProvider, usageRequest } from "../helpers/usage-provider";

type Runtime = {
  gateway: LlmGateway;
  sessions: SessionManager;
  costContext: AsyncLocalStorage<string>;
  costCapTripped: Error | null;
};
let dir: string;
let oldHome: string | undefined;
const engines: Engine[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-runtime-"));
  oldHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = join(dir, "profile");
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
  if (oldHome === undefined) delete process.env.RUNE_HOME;
  else process.env.RUNE_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});
function setup(model = "claude-sonnet-5") {
  const engine = new Engine({
    model,
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(dir, "rune.db"),
    toolsBinaryPath: "/nonexistent/rune-tools",
    yoloMode: false,
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
  });
  engines.push(engine);
  const runtime = engine as unknown as Runtime;
  const provider = new UsageProvider();
  runtime.gateway.registerProvider(provider);
  return { engine, runtime, provider };
}
async function drain(engine: Engine, session: string, text: string) {
  const events = [];
  for await (const event of engine.chat(session, text)) events.push(event);
  return events;
}

test("all gateway usage is session-scoped, durable and budgeted, including late helper replies", async () => {
  const { engine, runtime, provider } = setup();
  const first = engine.createSession();
  await drain(engine, first, "hello");
  const mainCost = engine.getListCost();
  expect(mainCost).toBeGreaterThan(0);
  let release!: () => void;
  provider.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Descendant async work keeps the first task's scope past the session switch.
  const late = runtime.costContext.run(first, () => runtime.gateway.infer(usageRequest()));
  const second = engine.createSession();
  expect(engine.getListCost()).toBe(0);
  release();
  await late;
  expect(engine.getListCost()).toBe(0);
  expect(runtime.sessions.getEvents(first, 1).filter((e) => e.event.type === "cost")).toHaveLength(
    2,
  );
  expect(runtime.sessions.getEvents(second, 1).filter((e) => e.event.type === "cost")).toHaveLength(
    0,
  );
  expect(engine.applyConfigSetting("budget", "0.001").ok).toBe(true);
  await expect(
    runtime.costContext.run(first, () => runtime.gateway.infer(usageRequest())),
  ).rejects.toThrow(/budget/i);
  expect(runtime.costCapTripped).toBeNull(); // old helper must not stop the new task
  expect(engine.applyConfigSetting("budget", "0").ok).toBe(true);
  const restarted = setup();
  restarted.engine.resumeSession(first);
  expect(restarted.engine.getListCost()).toBeCloseTo(mainCost * 2, 9);
  restarted.engine.applyConfigSetting("budget", "0.001");
  const before = restarted.provider.requests.length;
  const stopped = await runHeadless(restarted.engine, first, "continue");
  expect(restarted.provider.requests).toHaveLength(before);
  expect(JSON.stringify(stopped).toLowerCase()).toContain("budget");
  expect(stopped.ok).toBe(false);
  expect(headlessExitCode(stopped)).not.toBe(0);
  restarted.engine.applyConfigSetting("budget", "1");
  await drain(restarted.engine, first, "continue");
  expect(restarted.provider.requests.length).toBeGreaterThan(before);
  expect(restarted.engine.applyConfigSetting("parallel", "NaN").ok).toBe(false);
});

test("a completed response crossing the cap is retained; only the next run is stopped", async () => {
  const { engine, provider } = setup();
  const session = engine.createSession();
  // Simulate a provider reporting more billed input than its reservation.
  provider.usage = { inputTokens: 1_000_000, outputTokens: 100 };
  engine.applyConfigSetting("budget", "2");
  const completed = await runHeadless(engine, session, "hello");
  expect(completed.ok).toBe(true);
  expect(completed.text).toContain("Ready.");
  expect(engine.getListCost()).toBeGreaterThan(2);
  const stopped = await runHeadless(engine, session, "continue");
  expect(stopped.ok).toBe(false);
  expect(provider.requests).toHaveLength(1);
});

test("automatic compaction persists its actual working set into the next engine's first request", async () => {
  const { engine, runtime, provider } = setup();
  const session = engine.createSession();
  for (let i = 0; i < 16; i++) {
    runtime.sessions.appendEvent(session, {
      type: "user_msg",
      payload: { content: `ARCHIVE_${i}: ${"old parser details ".repeat(100)}` },
    });
    runtime.sessions.appendEvent(session, {
      type: "assistant_msg",
      payload: { content: `Previous answer ${i}` },
    });
  }
  provider.onRequest = (_request, index) =>
    index === 1
      ? [
          {
            type: "tool_use",
            toolCallId: "compact",
            toolName: "compact_context",
            toolInput: {},
          },
        ]
      : [{ type: "text", text: "Context reduced; ready to continue." }];
  await drain(engine, session, "Compact our earlier parser discussion.");
  const events = runtime.sessions.getEvents(session, 1);
  const checkpoints = events.filter((e) => e.event.type === "auto_compaction");
  expect(checkpoints.length).toBeGreaterThan(0);
  expect(checkpoints.at(-1)!.event.payload.version).toBe(1);
  const replay = eventsToMessages(events);
  expect(JSON.stringify(replay)).not.toContain("ARCHIVE_0:");
  expect(events.some((e) => e.event.payload.content?.toString().includes("ARCHIVE_0:"))).toBe(true);
  const restarted = setup();
  await drain(restarted.engine, session, "Continue working on the parser.");
  const firstRequest = JSON.stringify(restarted.provider.requests[0]);
  expect(firstRequest).toContain("retain the parser goal");
  expect(firstRequest).not.toContain("ARCHIVE_0:");
  expect(firstRequest).toContain("Continue working on the parser");
  expect(JSON.stringify(replay).length).toBeLessThan(
    JSON.stringify(events.slice(0, 32)).length / 2,
  );
});

test("an unaffordable request is refused before it reaches the provider", async () => {
  const { engine, provider } = setup();
  const session = engine.createSession();
  engine.applyConfigSetting("budget", "0.001");
  const result = await runHeadless(engine, session, "hello");
  expect(result.ok).toBe(false);
  expect(provider.requests).toHaveLength(0);
  expect(engine.getListCost()).toBe(0);
});

test("an unpriced capped model fails once before inference, and an explicit cap removal permits it", async () => {
  const { engine, provider } = setup("custom-unpriced-model");
  const session = engine.createSession();
  engine.applyConfigSetting("budget", "1");
  const events = await drain(engine, session, "hello");
  expect(provider.requests).toHaveLength(0);
  const errors = events.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  expect(JSON.stringify(errors)).toContain("unpriced");
  expect(engine.getListCost()).toBe(0);
  engine.applyConfigSetting("budget", "0");
  const allowed = await runHeadless(engine, session, "hello");
  expect(allowed.ok).toBe(true);
  expect(provider.requests).toHaveLength(1);
});
