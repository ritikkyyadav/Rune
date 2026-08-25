import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "@gear/tool-registry";
import { setConfigValue } from "@gear/shared";
import {
  CONFIG_SETTINGS,
  resolveSetting,
  normalizeSettingValue,
  settingTomlValue,
  displaySettingValue,
  settingsCatalogSummary,
} from "./config-settings";

/**
 * `update_config` — change one of Gear's own settings from a plain-language
 * request ("switch to Autonomy III", "turn the sandbox off", "enable auto
 * commit"). The change is applied live AND written back to ~/.gear/config.toml so
 * it survives the next launch. The model maps the user's words to a setting +
 * value; this tool validates them against a fixed catalog (so it can only touch
 * known settings), applies the change, then persists it.
 *
 * It is a `confirm`-level tool on purpose: shifting to 4th gear or turning the
 * sandbox off removes a guardrail, so outside 4th gear the user sees a
 * permission prompt first — an errant/injected instruction can't silently weaken
 * the setup.
 */

export interface UpdateConfigDeps {
  /** Apply a validated setting live; returns whether it took + why not. */
  applyLive: (key: string, canonicalValue: string) => { ok: boolean; reason?: string };
  /** Current canonical value of a setting (for "what is X" / reports). */
  readSetting: (key: string) => string | undefined;
}

export const UPDATE_CONFIG_TOOL_SCHEMA: ToolSchema = {
  name: "update_config",
  version: "0.1.0",
  description:
    'Change one of Gear\'s own settings when the user asks (e.g. "switch to Autonomy III", ' +
    '"turn the sandbox off", "enable auto commit"). The change applies immediately ' +
    "and is saved to ~/.gear/config.toml so it persists across restarts. Call with `setting` " +
    "and `value`. Omit `value` to read the current value; omit both to list every setting. " +
    "Only these settings can be changed:\n" +
    settingsCatalogSummary(),
  inputSchema: {
    type: "object",
    properties: {
      setting: {
        type: "string",
        description:
          "Which setting to change: gear, sandbox, or auto_commit (aliases like " +
          '"mode" or "permission_mode" work). Omit to list all current settings.',
      },
      value: {
        type: "string",
        description:
          'The new value, e.g. "1" / "2" / "3" / "4" / "auto" for gear (1 guided · 2 edits · ' +
          "3 workspace + sandboxed shell · 4 full autonomy · auto classifier), or " +
          '"on"/"off" for sandbox and auto_commit. Omit to read the current value.',
      },
    },
    required: [],
  },
  permissionLevel: "confirm",
  category: "write",
};

function ok(input: ToolCallInput, result: string, start: number): ToolCallOutput {
  return {
    callId: input.callId,
    toolName: input.toolName,
    success: true,
    result,
    durationMs: Math.round(performance.now() - start),
  };
}

function fail(input: ToolCallInput, error: string, start: number): ToolCallOutput {
  return {
    callId: input.callId,
    toolName: input.toolName,
    success: false,
    result: "",
    error,
    durationMs: Math.round(performance.now() - start),
  };
}

/** A one-line "key: value" view of every setting's current state. */
function reportAll(deps: UpdateConfigDeps): string {
  const lines = CONFIG_SETTINGS.map((s) => {
    const cur = deps.readSetting(s.key);
    const shown = cur !== undefined ? displaySettingValue(s, cur) : "unknown";
    return `- ${s.key}: ${shown}`;
  });
  return `Current settings:\n${lines.join("\n")}\n\nSay e.g. "switch to Autonomy II" to change one.`;
}

export function createUpdateConfigTool(deps: UpdateConfigDeps): ToolHandler {
  return {
    schema: UPDATE_CONFIG_TOOL_SCHEMA,

    validate: () => ({ valid: true }),

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      try {
        const args = input.args as { setting?: unknown; value?: unknown };
        const settingName = typeof args.setting === "string" ? args.setting.trim() : "";
        const rawValue = typeof args.value === "string" ? args.value.trim() : "";

        // No setting → list everything.
        if (!settingName) return ok(input, reportAll(deps), start);

        const setting = resolveSetting(settingName);
        if (!setting) {
          return fail(
            input,
            `Unknown setting "${settingName}". Settable: ${CONFIG_SETTINGS.map((s) => s.key).join(", ")}.`,
            start,
          );
        }

        // Setting named but no value → report the current value + the choices.
        if (!rawValue) {
          const cur = deps.readSetting(setting.key);
          const shown = cur !== undefined ? displaySettingValue(setting, cur) : "unknown";
          const choices = setting.kind === "boolean" ? "on | off" : setting.values!.join(" | ");
          return ok(
            input,
            `${setting.key} is currently "${shown}". Options: ${choices}. ${setting.description}`,
            start,
          );
        }

        const norm = normalizeSettingValue(setting, rawValue);
        if ("error" in norm) {
          return fail(input, `Can't set ${setting.key}: ${norm.error}.`, start);
        }
        const canonical = norm.value;
        const shown = displaySettingValue(setting, canonical);
        const already = deps.readSetting(setting.key);

        // Apply live FIRST. If the machine won't honor it (e.g. org policy forbids
        // Autonomy III), report the refusal and DON'T persist a dead setting.
        const applied = deps.applyLive(setting.key, canonical);
        if (!applied.ok) {
          return fail(
            input,
            `Couldn't change ${setting.key} to "${shown}"${applied.reason ? ` — ${applied.reason}` : ""}.`,
            start,
          );
        }

        // Persist so it sticks. A persist failure is non-fatal (the live change
        // already took) but must be reported honestly.
        let persistNote = "saved to ~/.gear/config.toml";
        try {
          setConfigValue(setting.tomlPath, settingTomlValue(setting, canonical), {
            scope: "global",
          });
        } catch (err) {
          persistNote = `applied for this session only — couldn't save it (${
            err instanceof Error ? err.message : String(err)
          }), so it resets on restart`;
        }

        const noChange = already === canonical ? " (was already set — reaffirmed)" : "";
        const caution = sensitivityNote(setting.key, canonical);
        return ok(
          input,
          `${setting.key} is now "${shown}"${noChange} — applied now and ${persistNote}.${caution}`,
          start,
        );
      } catch (err) {
        return fail(input, err instanceof Error ? err.message : String(err), start);
      }
    },
  };
}

/** A short, honest caution when a change removes a guardrail. */
function sensitivityNote(key: string, canonical: string): string {
  if ((key === "gear" || key === "permission_mode") && canonical === "4") {
    return " ⚠ 4th gear removes every permission prompt (the sandbox switch is separate).";
  }
  if (key === "sandbox" && canonical === "false") {
    return " ⚠ Sandbox off means shell commands have full host + network access.";
  }
  return "";
}
