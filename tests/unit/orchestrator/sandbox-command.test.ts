/**
 * `/sandbox` as text: the same logic the TUI menu drives. Mode and override
 * land in the sidecar; exclusions land in config.toml; the Config readout
 * says what the sandbox enforces.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSandboxCommand,
  sandboxConfigLines,
  type SandboxCommandEngine,
} from "../../../packages/orchestrator/src/sandbox-command";
import { loadSavedSandboxState } from "../../../packages/shared/src/sandbox-store";
import {
  DEFAULT_SANDBOX_POLICY,
  mergeSandboxPolicy,
  type SandboxMode,
  type SandboxPolicy,
} from "../../../packages/shared/src/sandbox-policy";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";

setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

function fakeEngine(): SandboxCommandEngine & { policy: SandboxPolicy } {
  const state = {
    policy: mergeSandboxPolicy(DEFAULT_SANDBOX_POLICY, null),
    getWorkspaceRoot: () => "/ws",
    getSandboxPolicy: () => state.policy,
    setSandboxModeLive: (mode: SandboxMode) => {
      state.policy = { ...state.policy, mode };
    },
    updateSandboxPolicy: (patch: Partial<SandboxPolicy>) => {
      state.policy = mergeSandboxPolicy(state.policy, patch);
    },
  };
  return state;
}

describe("/sandbox", () => {
  let home = "";
  const saved = { home: process.env.RUNE_HOME, config: process.env.RUNE_CONFIG_PATH };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rune-sandbox-cmd-"));
    process.env.RUNE_HOME = home;
    process.env.RUNE_CONFIG_PATH = join(home, "config.toml");
  });
  afterEach(() => {
    if (saved.home === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = saved.home;
    if (saved.config === undefined) delete process.env.RUNE_CONFIG_PATH;
    else process.env.RUNE_CONFIG_PATH = saved.config;
    rmSync(home, { recursive: true, force: true });
  });

  test("mode: every spelling, saved to the sidecar", () => {
    const engine = fakeEngine();
    expect(runSandboxCommand(engine, "mode regular").changed).toBe("mode");
    expect(engine.policy.mode).toBe("regular");
    expect(loadSavedSandboxState(home)?.mode).toBe("regular");
    runSandboxCommand(engine, "off");
    expect(engine.policy.mode).toBe("off");
    runSandboxCommand(engine, "on");
    expect(engine.policy.mode).toBe("auto-allow");
    const bad = runSandboxCommand(engine, "mode sideways");
    expect(bad.changed).toBeUndefined();
    expect(bad.lines[0]).toContain("Unknown sandbox mode");
  });

  test("override: fallback and strict, saved beside the mode", () => {
    const engine = fakeEngine();
    expect(runSandboxCommand(engine, "override strict").changed).toBe("override");
    expect(engine.policy.allowUnsandboxedFallback).toBe(false);
    expect(loadSavedSandboxState(home)?.allowUnsandboxedFallback).toBe(false);
    runSandboxCommand(engine, "fallback");
    expect(engine.policy.allowUnsandboxedFallback).toBe(true);
    expect(runSandboxCommand(engine, "override maybe").lines[0]).toContain("fallback | strict");
  });

  test("exclude / unexclude: applied live and written to config.toml as text", () => {
    const engine = fakeEngine();
    const first = runSandboxCommand(engine, "exclude adb *");
    expect(first.changed).toBe("excluded");
    expect(engine.policy.excludedCommands).toEqual(["adb *"]);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain("[sandbox]");
    expect(toml).toContain('excludedCommands = ["adb *"]');
    expect(runSandboxCommand(engine, "exclude adb *").lines[0]).toContain("already excluded");
    runSandboxCommand(engine, "exclude docker");
    expect(engine.policy.excludedCommands).toEqual(["adb *", "docker"]);
    runSandboxCommand(engine, "unexclude adb *");
    expect(engine.policy.excludedCommands).toEqual(["docker"]);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      'excludedCommands = ["docker"]',
    );
    expect(runSandboxCommand(engine, "exclude").lines[0]).toContain("Give a command pattern");
  });

  test("config and status read back what is enforced", () => {
    const engine = fakeEngine();
    runSandboxCommand(engine, "exclude adb *");
    const lines = sandboxConfigLines(engine.policy, "/ws");
    expect(lines.join("\n")).toContain("Excluded commands");
    expect(lines.join("\n")).toContain("adb *");
    expect(lines.join("\n")).toContain("~/.ssh");
    expect(lines.join("\n")).toContain(".git/hooks");
    expect(lines.join("\n")).toContain("/ws");
    const status = runSandboxCommand(engine, "status").lines[0];
    expect(status).toContain("mode auto-allow");
    expect(status).toContain("1 excluded pattern");
    expect(runSandboxCommand(engine, "").lines.join("\n")).toContain("Usage");
    expect(runSandboxCommand(engine, "wat").lines[0]).toContain("Unknown /sandbox argument");
  });
});
