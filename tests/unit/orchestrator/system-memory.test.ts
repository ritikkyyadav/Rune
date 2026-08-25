import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { loadSystemMemory, saveSystemMemory } from "../../../packages/shared/src/system-memory";

let dir: string;
let prev: string | undefined;

// A minimal stand-in for the LlmGateway: one registered provider and an infer()
// that returns a canned profile while capturing the request for assertions.
function fakeGateway(text: string, opts: { providers?: string[]; calls?: unknown[] } = {}) {
  const providers = opts.providers ?? ["anthropic"];
  return {
    getRegisteredProviderNames: () => providers,
    infer: async (req: unknown) => {
      opts.calls?.push(req);
      return { content: [{ type: "text", text }] };
    },
  };
}

function makeEngine(memory?: Record<string, unknown>): Engine {
  return new Engine({
    model: "gemini-2.5-flash",
    provider: "google",
    workspaceRoot: dir,
    dbPath: join(dir, "gear.db"),
    toolsBinaryPath: "gear-tools",
    yoloMode: false,
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    memory,
  });
}

/** Seed a session with a couple of turns so the dream has activity to learn from. */
function seedSession(engine: Engine, text: string): string {
  const sid = engine.createSession();
  const sessions = (engine as unknown as { sessions: { appendEvent: Function } }).sessions;
  sessions.appendEvent(sid, { type: "user_msg", payload: { content: text } });
  sessions.appendEvent(sid, {
    type: "assistant_msg",
    payload: { content: "On it.", toolUses: [{ callId: "1", toolName: "read_file" }] },
  });
  return sid;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-engine-mem-"));
  prev = process.env.GEAR_SYSTEM_MEMORY_PATH;
  process.env.GEAR_SYSTEM_MEMORY_PATH = join(dir, "system-memory.md");
});

afterEach(() => {
  if (prev === undefined) delete process.env.GEAR_SYSTEM_MEMORY_PATH;
  else process.env.GEAR_SYSTEM_MEMORY_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("engine/system-memory — injection", () => {
  it("wraps saved memory as a 'guide, not rules' block", () => {
    saveSystemMemory("# About me\n- prefers terse answers", {});
    const engine = makeEngine();
    const block = (
      engine as unknown as { buildSystemMemoryBlock(): string }
    ).buildSystemMemoryBlock();
    expect(block).toContain("prefers terse answers");
    expect(block.toLowerCase()).toContain("guide, not rules");
    engine.close();
  });

  it("injects nothing when the memory is empty", () => {
    const engine = makeEngine();
    expect(
      (engine as unknown as { buildSystemMemoryBlock(): string }).buildSystemMemoryBlock(),
    ).toBe("");
    engine.close();
  });

  it("injects nothing when memory is disabled, even with content", () => {
    saveSystemMemory("# About me\n- terse", {});
    const engine = makeEngine({ enabled: false });
    expect(
      (engine as unknown as { buildSystemMemoryBlock(): string }).buildSystemMemoryBlock(),
    ).toBe("");
    engine.close();
  });
});

describe("engine/system-memory — manual edits", () => {
  it("appends a dated note under a Notes heading and persists", () => {
    const engine = makeEngine();
    engine.appendSystemMemoryNote("prefers vitest over jest");
    const { content } = loadSystemMemory();
    expect(content).toContain("## Notes");
    expect(content).toContain("prefers vitest over jest");
    engine.close();
  });

  it("clamps an over-budget manual replacement to the configured maxTokens", () => {
    const engine = makeEngine({ maxTokens: 60 }); // ~240 chars (floor 400)
    const huge = Array.from({ length: 400 }, (_, i) => `- preference number ${i} here`).join("\n");
    const res = engine.setSystemMemoryContent(huge);
    expect(res.tokens).toBeLessThan(400);
    expect(loadSystemMemory().content).toContain("memory trimmed to fit budget");
    engine.close();
  });

  it("setSystemMemorySchedule is reflected by getSystemMemory", () => {
    const engine = makeEngine();
    engine.setSystemMemorySchedule("weekly");
    const mem = engine.getSystemMemory();
    expect(mem.scheduleLabel).toBe("weekly");
    engine.close();
  });
});

describe("engine/system-memory — the dream (reflect)", () => {
  it("distills recent activity into the profile and records bookkeeping", async () => {
    const calls: unknown[] = [];
    const engine = makeEngine({ maxTokens: 800 });
    seedSession(engine, "Help me refactor my Rust CLI parser");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(
      "# About you\n- Builds Rust CLIs\n- Likes terse, minimal-diff edits",
      { calls },
    );

    const res = await engine.reflectSystemMemory({ trigger: "manual" });
    expect(res.updated).toBe(true);

    const { content, meta } = loadSystemMemory();
    expect(content).toContain("Builds Rust CLIs");
    expect(meta.lastReflectedAt).toBeTruthy();
    expect(Object.keys(meta.foldedSeqBySession ?? {}).length).toBeGreaterThan(0);

    // The distillation must be framed as a guide and carry the seeded activity.
    const req = calls[0] as { system: string; messages: { content: { text: string }[] }[] };
    expect(req.system.toLowerCase()).toContain("guide, not rules");
    expect(req.messages[0].content[0].text).toContain("Rust CLI parser");
    engine.close();
  });

  it("no-ops with no provider configured (credit-safe)", async () => {
    const engine = makeEngine();
    seedSession(engine, "do a thing");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("x", { providers: [] });
    const res = await engine.reflectSystemMemory({ trigger: "manual" });
    expect(res.updated).toBe(false);
    expect(res.reason).toMatch(/no provider/i);
    engine.close();
  });

  it("no-ops when there is no new activity to learn from", async () => {
    const engine = makeEngine();
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("x");
    const res = await engine.reflectSystemMemory({ trigger: "manual" });
    expect(res.updated).toBe(false);
    expect(res.reason).toMatch(/no new activity/i);
    engine.close();
  });
});

describe("engine/system-memory — maybeReflect scheduling", () => {
  it("does NOT auto-run on the default manual cadence", async () => {
    const engine = makeEngine();
    seedSession(engine, "build something");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# profile");
    const res = await engine.maybeReflectSystemMemory();
    expect(res.updated).toBe(false);
    expect(res.reason).toBe("not due");
    expect(loadSystemMemory().content).toBe("");
    engine.close();
  });

  it("auto-runs once an interval cadence is set and due", async () => {
    const engine = makeEngine();
    seedSession(engine, "ship a feature");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(
      "# profile\n- ships features",
    );
    engine.setSystemMemorySchedule("daily"); // never reflected → due now
    const res = await engine.maybeReflectSystemMemory();
    expect(res.updated).toBe(true);
    expect(loadSystemMemory().content).toContain("ships features");
    engine.close();
  });
});
