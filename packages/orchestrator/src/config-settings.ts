// ─── Settable config catalog ───
// The curated allowlist of settings Gear will change on a plain-language
// request ("switch to Autonomy III", "turn the sandbox off"). It maps the
// words a user is likely to say onto a canonical setting + value, and onto the
// dotted config.toml key the writer persists. Keeping this list small and
// explicit is deliberate: the `update_config` tool can only ever touch what's
// here, so an errant instruction can't rewrite arbitrary config.

export interface ConfigSetting {
  /** Canonical id used in the tool + reports (snake_case). */
  key: string;
  /** Dotted config.toml path the value is persisted to. */
  tomlPath: string;
  /** One-line human summary. */
  description: string;
  /** enum = a fixed set of string values; boolean = on/off. */
  kind: "enum" | "boolean";
  /** For enum: the canonical values, in the order to present them. */
  values?: readonly string[];
  /** Lowercased alias → canonical value (folded in before validation). */
  valueAliases?: Record<string, string>;
  /** Other names the user might call this setting (lowercased). */
  nameAliases?: readonly string[];
  /** Whether a change takes effect immediately (vs only on next launch). */
  live: boolean;
  /**
   * Security-relevant: relaxing it (Autonomy III, sandbox off) removes a guardrail,
   * so the tool always says so plainly. The confirmation prompt is the real gate.
   */
  sensitive?: boolean;
}

export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  {
    key: "permission_mode",
    tomlPath: "permissions.mode",
    description:
      "How Gear acts: confirm prompts; Autonomy I permits confined edits; Autonomy II " +
      "also permits sandboxed commands; Autonomy III takes full host access; Auto uses " +
      "the isolated action classifier.",
    kind: "enum",
    values: ["confirm", "autonomy-i", "autonomy-ii", "autonomy-iii", "auto"],
    valueAliases: {
      normal: "confirm",
      standard: "confirm",
      default: "confirm",
      ask: "confirm",
      prompt: "confirm",
      safe: "confirm",
      trusted: "auto",
      trust: "auto",
      "auto-approve": "auto",
      autoapprove: "auto",
      "autonomy 1": "autonomy-i",
      "autonomy i": "autonomy-i",
      "autonomy 2": "autonomy-ii",
      "autonomy ii": "autonomy-ii",
      "autonomy 3": "autonomy-iii",
      "autonomy iii": "autonomy-iii",
      handsfree: "autonomy-iii",
      "hands free": "autonomy-iii",
      "hands-free": "autonomy-iii",
      turing: "autonomy-iii",
      yolo: "autonomy-iii",
      bypass: "autonomy-iii",
      autonomous: "autonomy-iii",
      full: "autonomy-iii",
    },
    nameAliases: ["mode", "permission", "permissions", "permission mode", "permissions mode"],
    live: true,
    sensitive: true,
  },
  {
    key: "sandbox",
    tomlPath: "sandbox.enabled",
    description:
      "Whether shell commands run inside the OS sandbox (no network, workspace-confined). " +
      "Turning it off gives commands full host access.",
    kind: "boolean",
    nameAliases: ["sandboxing", "sandbox mode"],
    live: true,
    sensitive: true,
  },
  {
    key: "auto_commit",
    tomlPath: "git.autoCommit",
    description:
      "After each successful run that changed files, commit exactly those files as one " +
      'revertible "gear:" commit (undo with /undo).',
    kind: "boolean",
    nameAliases: ["autocommit", "auto commit", "git auto commit", "commit on save"],
    live: true,
  },
] as const;

/** The canonical true/false aliases every boolean setting accepts. */
const BOOL_ALIASES: Record<string, string> = {
  on: "true",
  off: "false",
  enable: "true",
  enabled: "true",
  disable: "false",
  disabled: "false",
  yes: "true",
  no: "false",
  true: "true",
  false: "false",
  "1": "true",
  "0": "false",
};

/** Resolve a setting by its canonical key or any alias (case/space-insensitive). */
export function resolveSetting(name: string): ConfigSetting | undefined {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, " ");
  return CONFIG_SETTINGS.find((s) => {
    const canon = s.key.replace(/[_\s-]+/g, " ");
    if (canon === n) return true;
    return (s.nameAliases ?? []).some((a) => a.replace(/[_\s-]+/g, " ") === n);
  });
}

/**
 * Fold a raw value onto the setting's canonical form (e.g. "yolo" → "autonomy-iii",
 * "on" → "true"), or return an error listing what's accepted. Canonical booleans
 * come back as the strings "true"/"false".
 */
export function normalizeSettingValue(
  setting: ConfigSetting,
  raw: string,
): { value: string } | { error: string } {
  const v = raw.trim().toLowerCase();
  if (setting.kind === "boolean") {
    const mapped = BOOL_ALIASES[v];
    if (!mapped) return { error: `"${raw}" is not on/off — use on or off` };
    return { value: mapped };
  }
  // enum
  const mapped = setting.valueAliases?.[v] ?? v;
  if (!setting.values!.includes(mapped)) {
    return { error: `"${raw}" is not valid — choose one of: ${setting.values!.join(", ")}` };
  }
  return { value: mapped };
}

/** The TOML literal a canonical value persists as (boolean → real bool). */
export function settingTomlValue(setting: ConfigSetting, canonical: string): string | boolean {
  if (setting.kind === "boolean") return canonical === "true";
  return canonical;
}

/** How a canonical value reads back to the user (boolean → on/off). */
export function displaySettingValue(setting: ConfigSetting, canonical: string): string {
  if (setting.kind === "boolean") return canonical === "true" ? "on" : "off";
  return canonical;
}

/** A compact catalog listing for the tool description + "what can I change" replies. */
export function settingsCatalogSummary(): string {
  return CONFIG_SETTINGS.map((s) => {
    const opts = s.kind === "boolean" ? "on | off" : s.values!.join(" | ");
    return `- ${s.key} (${opts}): ${s.description}`;
  }).join("\n");
}
