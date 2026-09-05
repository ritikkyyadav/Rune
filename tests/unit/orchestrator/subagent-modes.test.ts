/**
 * `[subagents] mode` — who does delegated work, and on what.
 *
 * Measured: delegation was 78% of all tool wall time, and children ran on
 * whatever the tier table said with a hard-coded "high" reasoning dial. The
 * modes give that budget to the user: "off" removes sub-agents entirely,
 * "mirror" makes every child the session's exact model + provider + effort
 * (no compromise between watched and delegated work), "configured" pins the
 * user's named pair, "auto" keeps tier routing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeSubagentEffort, normalizeSubagentMode } from "../../../packages/shared/src/tiers";
import { Engine, type EngineConfig } from "../../../packages/orchestrator/src/engine";
import { rmTemp } from "../../helpers/tmp";

interface EngineInternals {
  registry: { get(name: string): unknown };
  doctrineContext(): { canDelegate: boolean };
}

function makeEngine(root: string, overrides: Partial<EngineConfig> = {}): Engine {
  return new Engine({
    model: "llama3",
    provider: "ollama",
    workspaceRoot: root,
    dbPath: join(root, "rune.db"),
    toolsBinaryPath: "rune-tools",
    permissionMode: "gear-1",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    memory: { enabled: false },
    ...overrides,
  });
}

describe("normalization", () => {
  test("modes and their aliases", () => {
    expect(normalizeSubagentMode("off")).toBe("off");
    expect(normalizeSubagentMode("solo")).toBe("off");
    expect(normalizeSubagentMode("static")).toBe("mirror");
    expect(normalizeSubagentMode("session")).toBe("mirror");
    expect(normalizeSubagentMode("manual")).toBe("configured");
    expect(normalizeSubagentMode("auto")).toBe("auto");
    expect(normalizeSubagentMode("banana")).toBe("auto");
    expect(normalizeSubagentMode(undefined)).toBe("auto");
  });

  test("efforts pass through only when real", () => {
    expect(normalizeSubagentEffort("xhigh")).toBe("xhigh");
    expect(normalizeSubagentEffort("MAX")).toBe("max");
    expect(normalizeSubagentEffort("extreme")).toBeUndefined();
    expect(normalizeSubagentEffort(undefined)).toBeUndefined();
  });
});

describe("Engine orchestration modes", () => {
  let root: string;
  let engine: Engine | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rune-subagent-modes-"));
  });

  afterEach(() => {
    engine?.close();
    engine = null;
    rmTemp(root);
  });

  test("off: the delegation tools never exist and the doctrine knows it", () => {
    engine = makeEngine(root, { subagents: { mode: "off" } });
    const internals = engine as unknown as EngineInternals;
    expect(internals.registry.get("task")).toBeUndefined();
    expect(internals.registry.get("worker")).toBeUndefined();
    expect(internals.doctrineContext().canDelegate).toBe(false);
  });

  test("auto (default): both tools exist and tier routing stands", () => {
    engine = makeEngine(root);
    const internals = engine as unknown as EngineInternals;
    expect(internals.registry.get("task")).toBeDefined();
    expect(internals.registry.get("worker")).toBeDefined();
    expect(internals.doctrineContext().canDelegate).toBe(true);
    // No tier table for ollama → the session model itself, no effort override.
    const live = engine.resolveSubagentModel(undefined, "light");
    expect(live).toMatchObject({ model: "llama3", provider: "ollama" });
    expect(live.thinkingEffort).toBeUndefined();
  });

  test("mirror: the child is the session, exactly — model, provider, effort", () => {
    engine = makeEngine(root, {
      subagents: { mode: "mirror" },
      reasoningEffort: "xhigh",
    });
    expect(engine.resolveSubagentModel("light", "light")).toMatchObject({
      model: "llama3",
      provider: "ollama",
      thinkingEffort: "xhigh",
    });
  });

  test("configured: the named pair wins when its provider is registered", () => {
    engine = makeEngine(root, {
      subagents: { mode: "configured", model: "ollama/llama3.2", effort: "medium" },
    });
    expect(engine.resolveSubagentModel("heavy", "light")).toMatchObject({
      model: "llama3.2",
      provider: "ollama",
      thinkingEffort: "medium",
    });
  });

  test("configured: an unusable pair falls through to tier routing, not to a 401", () => {
    engine = makeEngine(root, {
      subagents: { mode: "configured", model: "anthropic/claude-opus-5" },
    });
    const live = engine.resolveSubagentModel(undefined, "light");
    expect(live).toMatchObject({ model: "llama3", provider: "ollama" });
    expect(live.thinkingEffort).toBeUndefined();
  });

  test("live flip: off unregisters, any other mode restores", () => {
    engine = makeEngine(root);
    const internals = engine as unknown as EngineInternals;
    engine.setSubagentMode("off");
    expect(internals.registry.get("task")).toBeUndefined();
    expect(internals.registry.get("worker")).toBeUndefined();
    expect(internals.doctrineContext().canDelegate).toBe(false);
    engine.setSubagentMode("mirror");
    expect(internals.registry.get("task")).toBeDefined();
    expect(internals.registry.get("worker")).toBeDefined();
    expect(engine.resolveSubagentModel(undefined, "light").model).toBe("llama3");
  });
});
