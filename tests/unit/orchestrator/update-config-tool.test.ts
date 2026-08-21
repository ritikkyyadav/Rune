import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveSetting,
  normalizeSettingValue,
  CONFIG_SETTINGS,
} from "../../../packages/orchestrator/src/config-settings";
import {
  createUpdateConfigTool,
  type UpdateConfigDeps,
} from "../../../packages/orchestrator/src/update-config-tool";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-updcfg-"));
  configPath = join(dir, "config.toml");
  process.env.ALAN_CONFIG_PATH = configPath;
});

afterEach(() => {
  delete process.env.ALAN_CONFIG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

// A fake engine: records live-applies and can refuse (org-policy style).
function fakeDeps(over: Partial<UpdateConfigDeps> & { refuse?: boolean } = {}) {
  const state: Record<string, string> = {
    permission_mode: "confirm",
    sandbox: "true",
    auto_commit: "false",
  };
  const applied: { key: string; value: string }[] = [];
  const deps: UpdateConfigDeps = {
    applyLive: (key, value) => {
      if (over.refuse) return { ok: false, reason: "org policy forbids it" };
      applied.push({ key, value });
      state[key] = value;
      return { ok: true };
    },
    readSetting: (key) => state[key],
    ...over,
  };
  return { deps, applied, state };
}

const call = (args: Record<string, unknown>) => ({
  callId: "c1",
  toolName: "update_config",
  args,
});

describe("config-settings catalog", () => {
  it("resolves a setting by canonical key and aliases", () => {
    expect(resolveSetting("gear")?.key).toBe("gear");
    expect(resolveSetting("permission_mode")?.key).toBe("gear");
    expect(resolveSetting("mode")?.key).toBe("gear");
    expect(resolveSetting("Permissions")?.key).toBe("gear");
    expect(resolveSetting("auto commit")?.key).toBe("auto_commit");
    expect(resolveSetting("nonsense")).toBeUndefined();
  });

  it("normalizes enum values and their aliases", () => {
    const mode = resolveSetting("gear")!;
    expect(normalizeSettingValue(mode, "hands-free")).toEqual({ value: "4" });
    expect(normalizeSettingValue(mode, "yolo")).toEqual({ value: "4" });
    expect(normalizeSettingValue(mode, "4th gear")).toEqual({ value: "4" });
    expect(normalizeSettingValue(mode, "normal")).toEqual({ value: "1" });
    expect(normalizeSettingValue(mode, "trusted")).toEqual({ value: "3" });
    expect(normalizeSettingValue(mode, "auto")).toEqual({ value: "auto" });
    expect("error" in normalizeSettingValue(mode, "banana")).toBe(true);
  });

  it("normalizes boolean values and their aliases", () => {
    const sb = resolveSetting("sandbox")!;
    expect(normalizeSettingValue(sb, "off")).toEqual({ value: "false" });
    expect(normalizeSettingValue(sb, "ON")).toEqual({ value: "true" });
    expect(normalizeSettingValue(sb, "disable")).toEqual({ value: "false" });
    expect("error" in normalizeSettingValue(sb, "maybe")).toBe(true);
  });
});

describe("update_config tool", () => {
  it("migrates hands-free to 4th gear: applied live AND persisted", async () => {
    const { deps, applied } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "mode", value: "hands-free" }));
    expect(out.success).toBe(true);
    expect(applied).toEqual([{ key: "gear", value: "4" }]);
    // Written to the (redirected) config file — under the new key.
    expect(existsSync(configPath)).toBe(true);
    const toml = readFileSync(configPath, "utf-8");
    expect(toml).toContain("[permissions]");
    expect(toml).toContain('gear = "4"');
    // The result warns about the removed guardrail.
    expect(out.result).toContain("4th gear");
  });

  it("turns the sandbox off and writes a real boolean", async () => {
    const { deps } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "sandbox", value: "off" }));
    expect(out.success).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("enabled = false");
    expect(out.result).toContain("full host");
  });

  it("rejects an invalid value WITHOUT applying or persisting", async () => {
    const { deps, applied } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "mode", value: "banana" }));
    expect(out.success).toBe(false);
    expect(applied).toHaveLength(0);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects an unknown setting", async () => {
    const { deps } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "rocket_boosters", value: "on" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("Unknown setting");
  });

  it("does NOT persist when the live apply is refused (e.g. org policy)", async () => {
    const { deps } = fakeDeps({ refuse: true });
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "mode", value: "hands-free" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("org policy");
    expect(existsSync(configPath)).toBe(false); // nothing written
  });

  it("reports the current value when given a setting but no value", async () => {
    const { deps } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({ setting: "sandbox" }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("sandbox is currently");
    expect(existsSync(configPath)).toBe(false); // a read never writes
  });

  it("lists all settings when given nothing", async () => {
    const { deps } = fakeDeps();
    const tool = createUpdateConfigTool(deps);
    const out = await tool.execute(call({}));
    expect(out.success).toBe(true);
    for (const s of CONFIG_SETTINGS) expect(out.result).toContain(s.key);
  });
});
