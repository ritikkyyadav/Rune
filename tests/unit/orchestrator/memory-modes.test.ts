/**
 * Memory has three modes — off, auto, manual — and no clock.
 *
 * The founder, 2026-09-15: "For memory there should be three options only. Off:
 * turn memory off completely. Auto: the agent has the autonomy to decide when to
 * update and manage its memory. Manual: the person holds control — during a
 * session they run `/memory update` and the memory gets updated at that time.
 * Not daily, not monthly — just these three."
 *
 * This file is the semantics table, executed. Every row is driven through the
 * real Engine with a scripted in-process gateway: no provider is reached and no
 * credit can be spent by running it.
 *
 *   mode   │ inject │ extract │ promote │ clock │ agent refresh │ user refresh
 *   ───────┼────────┼─────────┼─────────┼───────┼───────────────┼──────────────
 *   off    │   no   │   no    │   no    │  no   │      no       │     no
 *   auto   │  yes   │  yes    │  yes    │  no   │   yes (1×)    │    yes
 *   manual │  yes   │ on ask  │ on ask  │  no   │      no       │    yes
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";
import { Engine } from "../../../packages/orchestrator/src/engine";
import { MemoryStore } from "../../../packages/orchestrator/src/memory";
import { loadConfig } from "../../../packages/shared/src/config";
import {
  loadSystemMemory,
  loadSystemMemoryMeta,
  saveSystemMemory,
  saveSystemMemoryMeta,
  resolveMemoryMode,
  parseMemoryMode,
  isWithdrawnCadence,
  MEMORY_CADENCE_REFUSAL,
} from "../../../packages/shared/src/system-memory";
import { rmTemp } from "../../helpers/tmp";

let dir: string;
let prevMd: string | undefined;
let prevCfg: string | undefined;

/** One registered provider and a canned completion. Nothing leaves the process. */
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

/** A session whose user message is a correction — the extractor's clearest case. */
function seedSession(engine: Engine, text = "no, always run typecheck before you claim a fix") {
  const sid = engine.createSession();
  const sessions = (engine as unknown as { sessions: { appendEvent: Function } }).sessions;
  sessions.appendEvent(sid, { type: "user_msg", payload: { content: text } });
  sessions.appendEvent(sid, {
    type: "assistant_msg",
    payload: { content: "On it.", toolUses: [{ callId: "1", toolName: "read_file" }] },
  });
  return sid;
}

/** The run-end hook, called exactly as the engine calls it after a real run. */
function runEndLearn(engine: Engine, sid: string) {
  return (
    engine as unknown as {
      captureMemory(
        s: string,
        o: Record<string, unknown>,
        l: unknown[],
      ): { proposed: number; stored: number; promoted: number };
    }
  ).captureMemory(sid, { verdictKind: "met" }, []);
}

const block = (engine: Engine): string =>
  (engine as unknown as { buildSystemMemoryBlock(): string }).buildSystemMemoryBlock();

const hasMemoryTool = (engine: Engine): boolean =>
  (engine as unknown as { registry: { get(n: string): unknown } }).registry.get("memory_update") !==
  undefined;

/** A promoted entry on disk, so "does this mode still READ what was learned?" is answerable. */
function seedPromoted(text: string): void {
  const store = new MemoryStore();
  store.observe({
    kind: "person",
    text,
    source: "user-said",
    sessionId: "seed",
    scope: "global",
  });
  store.setPinned(store.all()[0]!.id, true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-mem-modes-"));
  prevMd = process.env.RUNE_SYSTEM_MEMORY_PATH;
  // Relocates the profile, the meta sidecar AND the structured store — the
  // founder's own ~/.rune must never be touched by a test run.
  process.env.RUNE_SYSTEM_MEMORY_PATH = join(dir, "system-memory.md");
  // …and the config, because `setMemoryMode` now persists `[memory] mode`
  // there. Per-test, so one row of the table cannot set the mode for the next.
  prevCfg = process.env.RUNE_CONFIG_PATH;
  process.env.RUNE_CONFIG_PATH = join(dir, "config.toml");
});

afterEach(() => {
  if (prevMd === undefined) delete process.env.RUNE_SYSTEM_MEMORY_PATH;
  else process.env.RUNE_SYSTEM_MEMORY_PATH = prevMd;
  if (prevCfg === undefined) delete process.env.RUNE_CONFIG_PATH;
  else process.env.RUNE_CONFIG_PATH = prevCfg;
  rmTemp(dir);
});

// ─── The three, and nothing else ───

describe("memory modes — parsing and refusals", () => {
  it("parses the three (and the words people type for them)", () => {
    expect(parseMemoryMode("off")).toBe("off");
    expect(parseMemoryMode("Auto")).toBe("auto");
    expect(parseMemoryMode(" manual ")).toBe("manual");
    expect(parseMemoryMode("on")).toBe("auto");
    expect(parseMemoryMode("none")).toBe("off");
  });

  it("is not a cadence: daily, weekly, 3d and friends are not modes", () => {
    for (const s of ["daily", "weekly", "3d", "every 2 days", "monthly"]) {
      expect(parseMemoryMode(s)).toBeUndefined();
    }
    expect(isWithdrawnCadence("daily")).toBe(true);
    expect(isWithdrawnCadence("3d")).toBe(true);
    expect(isWithdrawnCadence("every 5 days")).toBe(true);
    expect(isWithdrawnCadence("auto")).toBe(false);
  });

  it("setMemoryMode refuses a cadence with the three-mode message", () => {
    const engine = makeEngine({ mode: "auto" });
    const r = engine.setMemoryMode("daily");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(MEMORY_CADENCE_REFUSAL);
    expect(r.reason).toContain("off, auto, manual");
    // …and the mode it had is the mode it keeps.
    expect(engine.memoryMode()).toBe("auto");
    engine.close();
  });
});

// ─── Migration off the withdrawn controls ───

describe("memory modes — migration", () => {
  it("daily / weekly / 3d become auto, with a note", () => {
    for (const cadence of ["daily", "weekly", "3d", "every 4 days"]) {
      const r = resolveMemoryMode({ schedule: cadence }, {});
      expect(r.mode).toBe("auto");
      expect(r.migration?.note).toContain("cadence withdrawn");
    }
  });

  it("manual stays manual", () => {
    const r = resolveMemoryMode({ schedule: "manual" }, {});
    expect(r.mode).toBe("manual");
  });

  it("enabled = false becomes off, and outranks a leftover cadence", () => {
    expect(resolveMemoryMode({ enabled: false }, {}).mode).toBe("off");
    expect(resolveMemoryMode({ enabled: false, schedule: "daily" }, {}).mode).toBe("off");
  });

  it("an explicit mode wins over every legacy field", () => {
    const r = resolveMemoryMode({ mode: "manual", enabled: false, schedule: "daily" }, {});
    expect(r.mode).toBe("manual");
    expect(r.migration).toBeUndefined();
  });

  it("a cadence chosen live in the sidecar migrates too", () => {
    expect(resolveMemoryMode({}, { schedule: "weekly" }).mode).toBe("auto");
    expect(resolveMemoryMode({}, { schedule: "manual" }).mode).toBe("manual");
  });

  it("nothing configured is auto", () => {
    expect(resolveMemoryMode({}, {}).mode).toBe("auto");
    expect(resolveMemoryMode(undefined, undefined).mode).toBe("auto");
  });

  it("the engine records the note once and hands it over once", () => {
    const engine = makeEngine({ schedule: "daily" });
    expect(engine.memoryMode()).toBe("auto");
    const first = engine.takeMemoryModeNotice();
    expect(first?.note).toContain("cadence withdrawn");
    expect(first?.mode).toBe("auto");
    // Told once…
    expect(engine.takeMemoryModeNotice()).toBeUndefined();
    // …but still on the record.
    expect(loadSystemMemoryMeta().modeMigration?.from).toBe("daily");
    engine.close();
  });

  it("choosing a mode by hand spends the migration note", () => {
    const engine = makeEngine({ schedule: "daily" });
    engine.setMemoryMode("manual");
    expect(engine.takeMemoryModeNotice()).toBeUndefined();
    expect(engine.memoryMode()).toBe("manual");
    engine.close();
  });
});

// ─── off ───

describe("memory mode: off", () => {
  it("injects nothing — neither the profile nor what was learned", () => {
    saveSystemMemory("# About me\n- prefers terse answers", {});
    seedPromoted("I want unsugared facts and no padding");
    const engine = makeEngine({ mode: "off" });
    expect(block(engine)).toBe("");
    expect(engine.learnedMemoryBlock()).toBe("");
    engine.close();
  });

  it("extracts and promotes nothing at run end", () => {
    const engine = makeEngine({ mode: "off" });
    const sid = seedSession(engine);
    expect(runEndLearn(engine, sid)).toEqual({ proposed: 0, stored: 0, promoted: 0 });
    expect(new MemoryStore().all()).toHaveLength(0);
    engine.close();
  });

  it("refuses every refresh — clock, agent and user alike", async () => {
    const engine = makeEngine({ mode: "off" });
    const sid = seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# a profile");

    expect((await engine.maybeReflectSystemMemory()).updated).toBe(false);

    const byAgent = await engine.reflectSystemMemory({ trigger: "auto", origin: "agent" });
    expect(byAgent.updated).toBe(false);
    expect(byAgent.reason).toMatch(/memory is off/i);

    const byUser = await engine.updateMemoryNow(sid);
    expect(byUser.updated).toBe(false);
    expect(byUser.reason).toMatch(/memory is off/i);

    expect(loadSystemMemory().content).toBe("");
    engine.close();
  });

  it("does not give the model a memory_update tool", () => {
    const engine = makeEngine({ mode: "off" });
    expect(hasMemoryTool(engine)).toBe(false);
    engine.close();
  });
});

// ─── auto ───

describe("memory mode: auto", () => {
  it("injects the profile and what was learned", () => {
    saveSystemMemory("# About me\n- prefers terse answers", {});
    seedPromoted("I want unsugared facts and no padding");
    const engine = makeEngine({ mode: "auto" });
    expect(block(engine)).toContain("prefers terse answers");
    expect(engine.learnedMemoryBlock()).toContain("unsugared facts");
    engine.close();
  });

  it("extracts and promotes at run end, on its own", () => {
    const engine = makeEngine({ mode: "auto" });
    const sid = seedSession(engine);
    const r = runEndLearn(engine, sid);
    expect(r.promoted).toBeGreaterThan(0);
    expect(new MemoryStore().promoted(dir).map((e) => e.text)).toContain(
      "no, always run typecheck before you claim a fix",
    );
    engine.close();
  });

  it("never refreshes on a clock", async () => {
    const engine = makeEngine({ mode: "auto" });
    seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# a profile");
    const r = await engine.maybeReflectSystemMemory();
    expect(r.updated).toBe(false);
    expect(loadSystemMemory().content).toBe("");
    engine.close();
  });

  it("gives the model a memory_update tool, and it refreshes with origin: agent", async () => {
    const engine = makeEngine({ mode: "auto" });
    const sid = seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(
      "# About you\n- builds CLIs and wants unsugared facts",
    );
    expect(hasMemoryTool(engine)).toBe(true);

    const tool = (
      engine as unknown as { registry: { get(n: string): { execute: Function } } }
    ).registry.get("memory_update");
    const out = await tool.execute({
      callId: "c1",
      toolName: "memory_update",
      args: {},
      sessionId: sid,
      workspaceRoot: dir,
    });
    expect(out.success).toBe(true);
    expect(out.result).toContain("Memory updated");
    expect(loadSystemMemory().content).toContain("builds CLIs");
    expect(loadSystemMemoryMeta().lastRefresh?.origin).toBe("agent");
    engine.close();
  });

  it("the agent gets exactly one refresh per session", async () => {
    const engine = makeEngine({ mode: "auto" });
    const sid = seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# first profile");

    const tool = (
      engine as unknown as { registry: { get(n: string): { execute: Function } } }
    ).registry.get("memory_update");
    const call = () =>
      tool.execute({
        callId: "c",
        toolName: "memory_update",
        args: {},
        sessionId: sid,
        workspaceRoot: dir,
      });
    const a = await call();
    expect(a.result).toContain("Memory updated");
    // A second session's worth of activity is waiting, so "nothing new" cannot
    // be what turns the second call away — the once-per-session gate is.
    seedSession(engine, "no, never force-push to main");
    const b = await call();
    expect(b.result).toContain("already run once this session");
    engine.close();
  });

  it("the user can still refresh by hand, recorded as origin: user", async () => {
    const engine = makeEngine({ mode: "auto" });
    const sid = seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# About you\n- ships alone");
    const r = await engine.updateMemoryNow(sid);
    expect(r.updated).toBe(true);
    expect(r.mode).toBe("auto");
    expect(loadSystemMemoryMeta().lastRefresh?.origin).toBe("user");
    engine.close();
  });
});

// ─── manual ───

describe("memory mode: manual", () => {
  it("injects the profile and what was already learned", () => {
    saveSystemMemory("# About me\n- prefers terse answers", {});
    seedPromoted("I want unsugared facts and no padding");
    const engine = makeEngine({ mode: "manual" });
    expect(block(engine)).toContain("prefers terse answers");
    expect(engine.learnedMemoryBlock()).toContain("unsugared facts");
    engine.close();
  });

  it("learns nothing at run end", () => {
    const engine = makeEngine({ mode: "manual" });
    const sid = seedSession(engine);
    expect(runEndLearn(engine, sid)).toEqual({ proposed: 0, stored: 0, promoted: 0 });
    expect(new MemoryStore().all()).toHaveLength(0);
    engine.close();
  });

  it("gives the model no memory_update tool, and refuses an agent refresh", async () => {
    const engine = makeEngine({ mode: "manual" });
    seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway("# a profile");
    expect(hasMemoryTool(engine)).toBe(false);
    const r = await engine.reflectSystemMemory({ trigger: "auto", origin: "agent" });
    expect(r.updated).toBe(false);
    expect(r.reason).toMatch(/manual mode/i);
    expect(loadSystemMemory().content).toBe("");
    engine.close();
  });

  it("`/memory update` does BOTH halves, right then: extract and refresh", async () => {
    const engine = makeEngine({ mode: "manual" });
    const sid = seedSession(engine);
    (engine as unknown as { gateway: unknown }).gateway = fakeGateway(
      "# About you\n- runs typecheck before claiming a fix",
    );
    const r = await engine.updateMemoryNow(sid);
    expect(r.mode).toBe("manual");
    expect(r.learned?.promoted).toBeGreaterThan(0);
    expect(r.updated).toBe(true);
    expect(new MemoryStore().promoted(dir).map((e) => e.text)).toContain(
      "no, always run typecheck before you claim a fix",
    );
    expect(loadSystemMemory().content).toContain("runs typecheck");
    expect(loadSystemMemoryMeta().lastRefresh?.origin).toBe("user");
    engine.close();
  });
});

// ─── The mode is live ───

describe("memory modes — switching", () => {
  it("switching to auto hands the model the tool; switching away takes it back", () => {
    const engine = makeEngine({ mode: "manual" });
    expect(hasMemoryTool(engine)).toBe(false);
    engine.setMemoryMode("auto");
    expect(hasMemoryTool(engine)).toBe(true);
    engine.setMemoryMode("off");
    expect(hasMemoryTool(engine)).toBe(false);
    engine.close();
  });

  it("a live choice is written to the config as well, and survives a new Engine", () => {
    const first = makeEngine({ mode: "auto" });
    first.setMemoryMode("off");
    first.close();
    // V8 finding 8. The sidecar used to be the only record of the choice AND
    // the top of the precedence order, which is what left the founder with no
    // way to turn memory off from outside a running session. Both halves moved:
    // `/memory off` writes `[memory] mode` too, and the resolution now reads
    // env → config → sidecar. So the choice still survives a restart — it
    // survives it in the file a person can edit, `RUNE_MEMORY_MODE` can
    // override, and `rune memory off` can write.
    expect(loadSystemMemoryMeta().mode).toBe("off");
    expect(loadConfig(dir).memory?.mode).toBe("off");
    const second = makeEngine(loadConfig(dir).memory as Record<string, unknown>);
    expect(second.memoryMode()).toBe("off");
    second.close();
  });

  it("the kill switch works from outside a session: env > config > sidecar", () => {
    // The founder's real state at the time of the audit: a sidecar that says
    // `auto`, and no `[memory]` section anywhere.
    saveSystemMemoryMeta({ mode: "auto" });
    expect(resolveMemoryMode(undefined, loadSystemMemoryMeta()).mode).toBe("auto");
    // `[memory] mode = "off"` in config.toml now outranks it…
    expect(resolveMemoryMode({ mode: "off" }, loadSystemMemoryMeta()).mode).toBe("off");
    // …so does `[memory] enabled = false`…
    expect(resolveMemoryMode({ enabled: false }, loadSystemMemoryMeta()).mode).toBe("off");
    // …and RUNE_MEMORY_MODE outranks every file, for every embedder, whatever
    // config object they assembled.
    const prev = process.env.RUNE_MEMORY_MODE;
    process.env.RUNE_MEMORY_MODE = "off";
    try {
      expect(resolveMemoryMode({ mode: "auto" }, loadSystemMemoryMeta()).mode).toBe("off");
      expect(makeEngine({ mode: "auto" }).memoryMode()).toBe("off");
    } finally {
      if (prev === undefined) delete process.env.RUNE_MEMORY_MODE;
      else process.env.RUNE_MEMORY_MODE = prev;
    }
  });

  it("a sidecar carrying a live mode AND a withdrawn cadence still reports the migration", () => {
    // V8 finding 31, and it is the founder's own sidecar: `mode: "auto"` beside
    // `schedule: "daily"`. They chose daily; the cadence is gone; the explicit
    // mode used to short-circuit before the migration branch and they were
    // never told.
    saveSystemMemoryMeta({ mode: "auto", schedule: "daily" });
    const r = resolveMemoryMode(undefined, loadSystemMemoryMeta());
    expect(r.mode).toBe("auto");
    expect(r.migration?.from).toBe("daily");
    expect(r.migration?.note).toContain("cadence withdrawn");
    // And choosing a mode by hand spends the leftover cadence with the note.
    const engine = makeEngine();
    engine.setMemoryMode("manual");
    expect(loadSystemMemoryMeta().schedule).toBeUndefined();
    expect(resolveMemoryMode(undefined, loadSystemMemoryMeta()).migration).toBeUndefined();
    engine.close();
  });

  it("cycles off → auto → manual → off", () => {
    saveSystemMemoryMeta({ mode: "off" });
    const engine = makeEngine();
    expect(engine.cycleMemoryMode()).toBe("auto");
    expect(engine.cycleMemoryMode()).toBe("manual");
    expect(engine.cycleMemoryMode()).toBe("off");
    engine.close();
  });

  it("`/config memory <mode>` goes through the same door", () => {
    const engine = makeEngine({ mode: "auto" });
    expect(engine.applyConfigSetting("memory", "manual").ok).toBe(true);
    expect(engine.readConfigSetting("memory")).toBe("manual");
    // The catalog folds a cadence onto auto rather than refusing the user —
    // "keep it current" is what they were asking for, and there is no clock.
    expect(engine.applyConfigSetting("memory", "daily").ok).toBe(true);
    expect(engine.readConfigSetting("memory")).toBe("auto");
    engine.close();
  });
});

// ─── An Engine that never heard of memory ───

describe("memory modes — the embedder's default", () => {
  it("no memory key at all: the learned store stays shut", () => {
    seedPromoted("I want unsugared facts and no padding");
    const engine = makeEngine();
    // The narrative profile keeps the reading it has always had…
    saveSystemMemory("# About me\n- terse", {});
    expect(block(engine)).toContain("terse");
    // …but nothing is learned and nothing learned is injected.
    expect(engine.learnedMemoryBlock()).toBe("");
    const sid = seedSession(engine);
    expect(runEndLearn(engine, sid)).toEqual({ proposed: 0, stored: 0, promoted: 0 });
    engine.close();
  });
});
