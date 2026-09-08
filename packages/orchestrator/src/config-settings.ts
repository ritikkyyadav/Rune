// ─── Settable config catalog ───
// The curated allowlist of settings Rune will change on a plain-language
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
  /**
   * enum = a fixed set of string values; boolean = on/off; number = numeric;
   * text = a free-form string validated by `validate` (a model id, which the
   * catalog cannot enumerate without inheriting the provider-list rot that has
   * killed compaction three times).
   */
  kind: "enum" | "boolean" | "number" | "text";
  min?: number;
  max?: number;
  integer?: boolean;
  /** For enum: the canonical values, in the order to present them. */
  values?: readonly string[];
  /** Lowercased alias → canonical value (folded in before validation). */
  valueAliases?: Record<string, string>;
  /** Other names the user might call this setting (lowercased). */
  nameAliases?: readonly string[];
  /** For text: reject a value with a reason, or return undefined to accept. */
  validate?: (value: string) => string | undefined;
  /** For text: what to show in `settingChoices` (the catalog line). */
  placeholder?: string;
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
    key: "budget",
    tomlPath: "cost.maxSessionUsd",
    kind: "number",
    min: 0,
    max: 10000,
    description:
      "Session limit in USD at list rates, including workers, compaction and safety review. 0 = no limit; already in-flight calls may finish.",
    nameAliases: ["session budget", "cost cap"],
    live: true,
  },
  {
    key: "parallel",
    tomlPath: "subagents.maxParallel",
    kind: "number",
    min: 1,
    max: 16,
    integer: true,
    description: "Maximum simultaneous delegated tasks across workers, scouts and workflows.",
    nameAliases: ["max parallel", "concurrency"],
    live: true,
  },
  {
    key: "subagent_budget",
    tomlPath: "subagents.costCapUsd",
    kind: "number",
    min: 0.01,
    max: 1000,
    description: "Default per-agent spending ceiling in USD. Applies to the next dispatch.",
    live: true,
  },
  {
    key: "evidence_gate",
    tomlPath: "reliability.evidenceGate",
    kind: "enum",
    values: ["attest", "refuse"],
    valueAliases: { accept: "attest", silent: "attest", strict: "refuse", gate: "refuse" },
    description:
      "What the plan ledger does with a step closed on nothing: attest (default) accepts it as " +
      "unproven and says so in one line; refuse sends the list back once. Applies to the next run.",
    live: true,
  },
  {
    key: "turns",
    tomlPath: "reliability.maxTurns",
    kind: "number",
    min: 8,
    max: 1000,
    integer: true,
    description:
      "Maximum model turns in a run before the progress-based extension policy. Applies to the next run.",
    live: true,
  },
  {
    key: "sandbox_required",
    tomlPath: "sandbox.requireOs",
    kind: "boolean",
    description:
      "Require working OS isolation for sandboxed commands. Refuse execution when containment is unavailable.",
    live: true,
    sensitive: true,
  },
  {
    key: "playbook",
    tomlPath: "evolve.playbook",
    kind: "boolean",
    description:
      "Generate learned playbooks from repeated, verified lessons. Existing consent and evidence gates still apply.",
    live: true,
  },
  {
    key: "gear",
    tomlPath: "permissions.gear",
    description:
      "Which gear Rune runs in: 1 = guided (asks before writes and commands); 2 = workspace " +
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
    tomlPath: "sandbox.mode",
    description:
      "How shell commands run. auto-allow (default): inside the OS sandbox (no network, " +
      "workspace-confined writes) and approved without a prompt in 3rd gear and Auto. " +
      "regular: still sandboxed, but the gear's usual permission prompt applies. off: no " +
      "sandbox — commands get full host access and prompt as usual.",
    kind: "enum",
    values: ["auto-allow", "regular", "off"],
    valueAliases: {
      on: "auto-allow",
      true: "auto-allow",
      enabled: "auto-allow",
      enable: "auto-allow",
      "auto allow": "auto-allow",
      autoallow: "auto-allow",
      allow: "auto-allow",
      sandboxed: "auto-allow",
      "regular permissions": "regular",
      prompt: "regular",
      ask: "regular",
      confirm: "regular",
      false: "off",
      disabled: "off",
      disable: "off",
      none: "off",
      "no sandbox": "off",
    },
    nameAliases: ["sandboxing", "sandbox mode"],
    live: true,
    sensitive: true,
  },
  {
    key: "sandbox_fallback",
    tomlPath: "sandbox.allowUnsandboxedFallback",
    description:
      "Sandbox override. on (default): a command that failed on a sandbox restriction may be " +
      "retried with unsandboxed: true, which runs on the host under the regular permission " +
      "prompt. off = strict: every command runs sandboxed unless listed in excludedCommands.",
    kind: "boolean",
    valueAliases: {
      fallback: "true",
      allow: "true",
      "allow unsandboxed fallback": "true",
      strict: "false",
      "strict sandbox mode": "false",
    },
    nameAliases: [
      "sandbox override",
      "sandbox overrides",
      "unsandboxed fallback",
      "sandbox fallback",
      "allow unsandboxed fallback",
      "strict sandbox",
    ],
    live: true,
    sensitive: true,
  },
  {
    key: "supervisor",
    tomlPath: "permissions.autoMode.supervisor",
    description:
      "Auto mode's background safety supervisor. unusual (default): screens supervised actions " +
      "except recognized ordinary development work (builds, tests, installs, linters, local git, " +
      "containers). all: screens every supervised action. off: no background screening — the " +
      "mechanical breakers and the in-path reviewer still apply.",
    kind: "enum",
    values: ["all", "unusual", "off"],
    valueAliases: {
      everything: "all",
      full: "all",
      on: "all",
      default: "unusual",
      normal: "unusual",
      none: "off",
      disabled: "off",
    },
    nameAliases: [
      "auto supervisor",
      "background supervisor",
      "supervisor scope",
      "safety supervisor",
    ],
    live: true,
    sensitive: true,
  },
  {
    key: "unsandboxed_shell",
    tomlPath: "permissions.autoMode.unsandboxedShell",
    description:
      "What Auto mode does with a shell command that will not run inside the OS sandbox " +
      "(sandbox off, an excluded command, or a fallback retry). review (default): read-only " +
      "commands run; anything else pays one reviewer call. ask: anything not read-only prompts. " +
      "allow: only the mechanical breakers apply, as in 4th gear.",
    kind: "enum",
    values: ["review", "ask", "allow"],
    valueAliases: {
      reviewer: "review",
      classify: "review",
      prompt: "ask",
      confirm: "ask",
      open: "allow",
      trust: "allow",
    },
    nameAliases: ["unsandboxed shell", "uncontained shell", "host shell", "host commands"],
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
    key: "helper",
    tomlPath: "routing.helper",
    kind: "text",
    placeholder: "auto | off | model | provider/model",
    description:
      "Which model answers Rune's OWN calls — the compaction summarizer, the intent read, the " +
      "sub-agent report repair — as opposed to your work. 'off' (default) runs them on the " +
      "session model; 'auto' picks the cheapest healthy connected route, which may be another " +
      "provider; a model id or 'provider/model' names one. Naming one explicitly also lets it " +
      "answer Auto mode's safety questions; the automatic pick never does. Your session model " +
      "is untouched either way.",
    valueAliases: { session: "off", none: "off", default: "off", cheapest: "auto" },
    nameAliases: ["helper model", "helper route", "governance model", "routing helper"],
    validate: (v) => {
      if (v.length > 120) return "that is too long for a model id";
      // Deliberately NOT checked against a provider/model list. Every
      // hand-written union of provider or model ids in this repo has rotted
      // and rejected a live model (the sticky-model bug, the summarizer
      // graveyard). The route resolver checks it against what is actually
      // REGISTERED at resolve time, which cannot rot.
      if (/[\s]/.test(v)) return "a model id has no spaces";
      return undefined;
    },
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
    key: "lsp",
    tomlPath: "lsp.autoFeedback",
    description:
      "Attach the language server's errors and warnings for the touched file to every " +
      "successful edit, so type errors are fixed in the same turn instead of at the verifier. " +
      "On by default in TypeScript and Python projects whose server is installed.",
    kind: "boolean",
    nameAliases: [
      "lsp feedback",
      "auto feedback",
      "autofeedback",
      "post edit diagnostics",
      "diagnostics",
      "language server",
    ],
    live: true,
  },
  {
    key: "auto_commit",
    tomlPath: "git.autoCommit",
    description:
      "After each successful run that changed files, commit exactly those files as one " +
      'revertible "rune:" commit (undo with /undo).',
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
  if (setting.kind === "number") {
    const n = Number(v);
    if (
      !v ||
      !Number.isFinite(n) ||
      n < (setting.min ?? 0) ||
      n > (setting.max ?? Infinity) ||
      (setting.integer && !Number.isInteger(n))
    ) {
      return {
        error: `use ${setting.integer ? "a whole number" : "a number"} from ${setting.min ?? 0} to ${setting.max ?? "unlimited"}`,
      };
    }
    return { value: String(n) };
  }
  if (setting.kind === "text") {
    const mapped = setting.valueAliases?.[v] ?? raw.trim();
    if (!mapped) return { error: `use ${setting.placeholder ?? "a value"}` };
    const problem = setting.validate?.(mapped);
    return problem ? { error: problem } : { value: mapped };
  }
  if (setting.kind === "boolean") {
    // A boolean may carry its own vocabulary too (`strict` → off for the
    // sandbox override), folded in before the shared on/off aliases.
    const mapped = BOOL_ALIASES[setting.valueAliases?.[v] ?? v];
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
export function settingTomlValue(
  setting: ConfigSetting,
  canonical: string,
): string | boolean | number {
  if (setting.kind === "number") return Number(canonical);
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
    const opts = settingChoices(s);
    return `- ${s.key} (${opts}): ${s.description}`;
  }).join("\n");
}

export function settingChoices(setting: ConfigSetting): string {
  if (setting.kind === "boolean") return "on | off";
  if (setting.kind === "number") return `${setting.min ?? 0}..${setting.max ?? "unlimited"}`;
  if (setting.kind === "text") return setting.placeholder ?? "text";
  return setting.values!.join(" | ");
}
