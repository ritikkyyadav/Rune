// ─── Settable config catalog ───
// The curated allowlist of settings Gear will change on a plain-language
// request ("shift to 4th gear", "turn the sandbox off"). It maps the
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
   * Security-relevant: relaxing it (4th gear, sandbox off) removes a guardrail,
   * so the tool always says so plainly. The confirmation prompt is the real gate.
   */
  sensitive?: boolean;
}

export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  {
    key: "gear",
    tomlPath: "permissions.gear",
    description:
      "Which gear Gear runs in: 1 = guided (asks before writes and commands); 2 = workspace " +
      "file edits proceed; 3 = also sandboxed commands and confined delegation; 4 = full " +
      "autonomy, never asks first; auto = a separate classifier reviews risky actions.",
    kind: "enum",
    values: ["1", "2", "3", "4", "auto"],
    valueAliases: {
      // 1st gear
      "gear 1": "1",
      "gear-1": "1",
      "1st": "1",
      "1st gear": "1",
      first: "1",
      "first gear": "1",
      confirm: "1",
      guided: "1",
      normal: "1",
      standard: "1",
      default: "1",
      ask: "1",
      prompt: "1",
      safe: "1",
      // 2nd gear
      "gear 2": "2",
      "gear-2": "2",
      "2nd": "2",
      "2nd gear": "2",
      second: "2",
      "second gear": "2",
      "autonomy-i": "2",
      "autonomy 1": "2",
      "autonomy i": "2",
      edits: "2",
      // 3rd gear (legacy "auto-approve"/"trusted" = workspace trust)
      "gear 3": "3",
      "gear-3": "3",
      "3rd": "3",
      "3rd gear": "3",
      third: "3",
      "third gear": "3",
      "autonomy-ii": "3",
      "autonomy 2": "3",
      "autonomy ii": "3",
      workspace: "3",
      trusted: "3",
      trust: "3",
      "auto-approve": "3",
      autoapprove: "3",
      // 4th gear
      "gear 4": "4",
      "gear-4": "4",
      "4th": "4",
      "4th gear": "4",
      fourth: "4",
      "fourth gear": "4",
      "autonomy-iii": "4",
      "autonomy 3": "4",
      "autonomy iii": "4",
      handsfree: "4",
      "hands free": "4",
      "hands-free": "4",
      turing: "4",
      yolo: "4",
      bypass: "4",
      autonomous: "4",
      full: "4",
      // automatic
      automatic: "auto",
      classifier: "auto",
      "auto review": "auto",
      "auto-review": "auto",
    },
    nameAliases: [
      "gears",
      "mode",
      "permission_mode",
      "permission",
      "permissions",
      "permission mode",
      "permissions mode",
      "autonomy",
      "autonomy level",
    ],
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
    key: "effort",
    tomlPath: "llm.reasoningEffort",
    description:
      "How hard the model thinks before answering. Sent as the provider's reasoning dial " +
      "(Codex/OpenAI reasoning effort). 'max' is the deepest and slowest; 'high' is the " +
      "default and the right daily driver; 'low' rushes. A value a given model does not " +
      "accept falls back to its nearest supported one rather than failing the request.",
    kind: "enum",
    values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    valueAliases: {
      off: "none",
      lowest: "minimal",
      min: "minimal",
      fast: "low",
      quick: "low",
      balanced: "medium",
      normal: "high",
      default: "high",
      deep: "xhigh",
      "very high": "xhigh",
      "extra high": "xhigh",
      deepest: "max",
      maximum: "max",
      ultra: "max",
    },
    nameAliases: [
      "reasoning",
      "reasoning effort",
      "thinking",
      "thinking effort",
      "model effort",
      "reasoning_effort",
    ],
    live: true,
  },
  {
    key: "doctrine",
    tomlPath: "llm.doctrineDelivery",
    description:
      "How situational doctrine reaches the model. 'jit' (default) keeps the Delegation and " +
      "Building-interfaces sections out of the per-request system prompt (~2k tokens on every " +
      "request) and injects each once at its first moment of relevance. 'full' restores the " +
      "always-on prompt — use it if sub-agent or UI behavior seems to have lost guidance.",
    kind: "enum",
    values: ["jit", "full"],
    valueAliases: {
      lean: "jit",
      lazy: "jit",
      "just in time": "jit",
      always: "full",
      "always on": "full",
      big: "full",
    },
    nameAliases: ["doctrine delivery", "prompt mode", "doctrine mode", "doctrine_delivery"],
    live: true,
  },
  {
    key: "routing",
    tomlPath: "llm.effortRouting",
    description:
      "Per-turn reasoning-effort routing. 'conservative' (default) runs ordinary turns one " +
      "notch below the effort ceiling and pins the ceiling for the rest of the run at the " +
      "first sign of difficulty (failed check, replan, refused finish) — the planning turn " +
      "and fix-shaped tasks always get the ceiling. 'off' runs the ceiling on every turn.",
    kind: "enum",
    values: ["conservative", "off"],
    valueAliases: {
      on: "conservative",
      auto: "conservative",
      smart: "conservative",
      disabled: "off",
      none: "off",
    },
    nameAliases: ["effort routing", "effort_routing", "routing mode"],
    live: true,
  },
  {
    key: "subagents",
    tomlPath: "subagents.mode",
    description:
      "How sub-agents are orchestrated. 'auto' (default): the agent delegates when it helps and " +
      "routes each call's model weight (light scouts, standard workers). 'off': no sub-agents at " +
      "all — one agent with the session's full capability does everything itself. 'configured': " +
      "every sub-agent runs the model named in [subagents] model. 'mirror': every sub-agent runs " +
      "the session's exact model, provider, and reasoning effort — no compromise on delegated work.",
    kind: "enum",
    values: ["off", "auto", "configured", "mirror"],
    valueAliases: {
      none: "off",
      solo: "off",
      single: "off",
      manual: "configured",
      fixed: "configured",
      static: "mirror",
      same: "mirror",
      session: "mirror",
    },
    nameAliases: ["subagent mode", "subagents mode", "sub-agents", "sub_agents", "orchestration"],
    live: true,
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
