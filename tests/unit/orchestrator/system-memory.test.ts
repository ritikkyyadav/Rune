import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { loadSystemMemory, saveSystemMemory } from "../../../packages/shared/src/system-memory";
import { rmTemp } from "../../helpers/tmp";

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
    dbPath: join(dir, "rune.db"),
    toolsBinaryPath: "rune-tools",
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
  dir = mkdtempSync(join(tmpdir(), "rune-engine-mem-"));
  prev = process.env.RUNE_SYSTEM_MEMORY_PATH;
  process.env.RUNE_SYSTEM_MEMORY_PATH = join(dir, "system-memory.md");
});

afterEach(() => {
  if (prev === undefined) delete process.env.RUNE_SYSTEM_MEMORY_PATH;
  else process.env.RUNE_SYSTEM_MEMORY_PATH = prev;
  rmTemp(dir);
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

// ─── The dream may not shrink the profile ───
//
// The failure this pins is real and dated: 2026-09-15T12:26:08Z, a daily dream
// on a free model returned 76 output tokens and `saveSystemMemory` replaced a
// 3,976-byte evergreen profile with 326 bytes ending mid-word. Every call here
// drives the scripted in-process gateway above — no provider is reached.

/** Roughly the size of the profile that was lost. */
const REAL_PROFILE = Array.from(
  { length: 60 },
  (_, i) => `- a real sentence about how the user works, number ${i}`,
).join("\n");

describe("engine/system-memory — a dream cannot shrink the profile", () => {
  it("refuses a truncated completion and leaves the profile byte-identical", async () => {
    saveSystemMemory(REAL_PROFILE, { updatedAt: "2026-09-01T00:00:00Z" });
    const engine = makeEngine({ maxTokens: 1500 });
    seedSession(engine, "Help me refactor my Rust CLI parser");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway('Uses "well" as a');

    const res = await engine.reflectSystemMemory({ trigger: "auto" });
    expect(res.updated).toBe(false);
    expect(res.reason).toMatch(/refused/i);
    expect(res.refused?.discardedBytes).toBe(16);
    expect(res.refused?.previousBytes).toBe(Buffer.byteLength(REAL_PROFILE));
    expect(loadSystemMemory().content).toBe(REAL_PROFILE);
    expect(loadSystemMemory().meta.updatedAt).toBe("2026-09-01T00:00:00Z");
    engine.close();
  });

  it("does not fold the activity away, so a healthier model sees it again", async () => {
    saveSystemMemory(REAL_PROFILE, {});
    const engine = makeEngine({ maxTokens: 1500 });
    seedSession(engine, "Help me refactor my Rust CLI parser");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("tiny");
    await engine.reflectSystemMemory({ trigger: "auto" });
    expect(loadSystemMemory().meta.foldedSeqBySession).toBeUndefined();

    // Second dream, a healthy completion: it goes through and now folds.
    const good = REAL_PROFILE + "\n- and it learned one more thing";
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(good);
    const res = await engine.reflectSystemMemory({ trigger: "auto" });
    expect(res.updated).toBe(true);
    expect(loadSystemMemory().content).toContain("one more thing");
    expect(Object.keys(loadSystemMemory().meta.foldedSeqBySession ?? {}).length).toBeGreaterThan(0);
    engine.close();
  });

  it("keeps the profile it replaces, and `restore` puts it back", async () => {
    saveSystemMemory(REAL_PROFILE, {});
    const engine = makeEngine({ maxTokens: 1500 });
    seedSession(engine, "ship a feature");
    const rewritten = REAL_PROFILE.replace("number 0", "number zero");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(rewritten);

    expect((await engine.reflectSystemMemory({ trigger: "auto" })).updated).toBe(true);
    expect(loadSystemMemory().content).toContain("number zero");

    const kept = engine.systemMemoryBackups();
    expect(kept).toHaveLength(1);
    const r = engine.restoreSystemMemory();
    expect(r.restored).toBe(true);
    expect(loadSystemMemory().content).toBe(REAL_PROFILE);
    engine.close();
  });

  it("surfaces the refusal once, and `/memory` can still look it up after", async () => {
    saveSystemMemory(REAL_PROFILE, {});
    const engine = makeEngine({ maxTokens: 1500 });
    seedSession(engine, "do a thing");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("tiny");
    await engine.reflectSystemMemory({ trigger: "auto" });

    const first = engine.takeSystemMemoryRefusalNotice();
    expect(first?.reason).toMatch(/floor/);
    expect(engine.takeSystemMemoryRefusalNotice()).toBeUndefined(); // once
    // …but the panel's own view of it survives being told.
    expect(engine.getSystemMemory().meta.lastRefusal?.reason).toMatch(/floor/);
    engine.close();
  });

  it("the first profile a dream ever writes is not refused for being short", async () => {
    const engine = makeEngine({ maxTokens: 1500 });
    seedSession(engine, "first run");
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("- builds CLIs in Rust");
    const res = await engine.reflectSystemMemory({ trigger: "manual" });
    expect(res.updated).toBe(true);
    expect(loadSystemMemory().content).toContain("builds CLIs in Rust");
    engine.close();
  });
});
