import { CONFIG_SETTINGS, displaySettingValue, resolveSetting } from "./config-settings";
import { createUpdateConfigTool } from "./update-config-tool";

export interface SettingsEngine {
  getWorkspaceRoot?(): string;
  readConfigSetting(key: string): string | undefined;
  applyConfigSetting(key: string, value: string): { ok: boolean; reason?: string };
}

/** The terminal and the model use the same validator, live setters and writer. */
export async function runSettingsCommand(engine: SettingsEngine, args: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts[0] === "set" || parts[0] === "get") parts.shift();
  if (!parts.length || parts[0] === "list") {
    return [
      "Settings",
      ...CONFIG_SETTINGS.map((s) => {
        const current = engine.readConfigSetting(s.key);
        return `${s.key}: ${current === undefined ? "per effort" : displaySettingValue(s, current)}`;
      }),
      "",
      "/config <setting> <value> · /model · /keys · /browser",
    ].join("\n");
  }
  const setting = resolveSetting(parts[0]!);
  const tool = createUpdateConfigTool({
    applyLive: (key, value) => engine.applyConfigSetting(key, value),
    readSetting: (key) => engine.readConfigSetting(key),
  });
  const result = await tool.execute({
    toolName: "update_config",
    callId: "user-settings",
    sessionId: "settings",
    workspaceRoot: engine.getWorkspaceRoot?.() ?? "",
    args: { setting: setting?.key ?? parts[0], value: parts.slice(1).join(" ") },
  });
  return result.success ? result.result : (result.error ?? "Unable to change setting.");
}
