import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  loadSavedSandboxState,
  saveSandboxState,
} from "../../../packages/shared/src/index";
import { runSettingsCommand } from "../../../packages/orchestrator/src/settings-command";

let dir: string;
let oldHome: string | undefined;
let oldConfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-settings-"));
  oldHome = process.env.RUNE_HOME;
  oldConfig = process.env.RUNE_CONFIG_PATH;
  process.env.RUNE_HOME = dir;
  process.env.RUNE_CONFIG_PATH = join(dir, "config.toml");
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.RUNE_HOME;
  else process.env.RUNE_HOME = oldHome;
  if (oldConfig === undefined) delete process.env.RUNE_CONFIG_PATH;
  else process.env.RUNE_CONFIG_PATH = oldConfig;
  rmSync(dir, { recursive: true, force: true });
});
const fakeEngine = (workspace = "") => {
  const state: Record<string, string> = { budget: "0", parallel: "3" };
  return {
    state,
    getWorkspaceRoot: () => workspace,
    readConfigSetting: (key: string) => state[key],
    applyConfigSetting: (key: string, value: string) => {
      state[key] = value;
      return { ok: true };
    },
  };
};
test("settings are direct local operations with numeric persistence and invalid-value rejection", async () => {
  const engine = fakeEngine();
  expect(await runSettingsCommand(engine, "list")).toContain("budget: 0");
  expect(existsSync(process.env.RUNE_CONFIG_PATH!)).toBe(false);
  for (const bad of ["parallel 0", "parallel 1.5", "budget NaN", "budget -1", "turns Infinity"])
    expect(await runSettingsCommand(engine, bad)).toContain("Can't set");
  expect(engine.state).toEqual({ budget: "0", parallel: "3" });
  expect(await runSettingsCommand(engine, "set budget 2.5")).toContain(
    process.env.RUNE_CONFIG_PATH!,
  );
  expect(loadConfig().cost?.maxSessionUsd).toBe(2.5);
  expect(await runSettingsCommand(engine, "budget")).toContain('"2.5"');
});
test("updates an existing project override and preserves unrelated configuration", async () => {
  mkdirSync(join(dir, ".rune"));
  const project = join(dir, ".rune", "config.toml");
  writeFileSync(
    project,
    '# project policy\n[cost]\nmaxSessionUsd = 1\n\n[llm]\nmodel = "keep-me"\n',
  );
  const message = await runSettingsCommand(fakeEngine(dir), "budget 4");
  expect(message).toContain(project);
  expect(loadConfig(dir).cost?.maxSessionUsd).toBe(4);
  expect(readFileSync(project, "utf8")).toContain('model = "keep-me"');
  expect(readFileSync(project, "utf8")).toContain("# project policy");
  expect(existsSync(process.env.RUNE_CONFIG_PATH!)).toBe(false);
});
test("sandbox config changes supersede a stale saved /sandbox choice", async () => {
  saveSandboxState(false);
  expect(loadSavedSandboxState()).toEqual({ mode: "off" });
  await runSettingsCommand(fakeEngine(), "sandbox on");
  // The mode choice is forgotten so the sidecar cannot shadow config at the
  // next launch; with nothing else saved the file is gone.
  expect(loadSavedSandboxState()).toBeNull();
  expect(loadConfig().sandbox.mode).toBe("auto-allow");
});
