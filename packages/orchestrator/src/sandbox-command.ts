// ─── /sandbox — pure command logic shared by the TUI and the plain CLI ───
//
// The command mirrors the three tabs the sandbox policy is made of:
//
//   /sandbox                       the interactive menu (TUI) or this readout (CLI)
//   /sandbox mode <m>              auto-allow | regular | off   (also: /sandbox on|off)
//   /sandbox override fallback     allow a failed command to retry unsandboxed
//   /sandbox override strict       refuse unsandboxed retries; excludedCommands only
//   /sandbox exclude <pattern>     run matching commands outside the sandbox
//   /sandbox unexclude <pattern>   remove a pattern
//   /sandbox config                the Config readout: exclusions and filesystem rules
//   /sandbox status                one-line state
//
// Mode and override are saved to the ~/.rune/sandbox.json sidecar (like
// /theme); the exclusion list is written to config.toml under [sandbox], so
// it is readable and editable as text. Everything returns plain lines; the
// surfaces paint them.

import {
  BUILTIN_READ_DENY,
  BUILTIN_WRITE_ALLOW,
  BUILTIN_WRITE_DENY,
  normalizeSandboxMode,
  sandboxModeLabel,
  saveSandboxState,
  setConfigValue,
  type SandboxMode,
  type SandboxPolicy,
} from "@rune/shared";
import { getSandboxCapability, isOsIsolationAvailable } from "@rune/tool-registry";

export interface SandboxCommandEngine {
  getWorkspaceRoot?(): string;
  getSandboxPolicy(): Readonly<SandboxPolicy>;
  setSandboxModeLive(mode: SandboxMode): void;
  updateSandboxPolicy(patch: Partial<SandboxPolicy>): void;
}

export interface SandboxCommandResult {
  lines: string[];
  /** Set when the command changed policy (the surface prints a banner). */
  changed?: "mode" | "override" | "excluded";
}

export const SANDBOX_MODE_CHOICES: ReadonlyArray<{
  mode: SandboxMode;
  label: string;
  hint: string;
}> = [
  {
    mode: "auto-allow",
    label: sandboxModeLabel("auto-allow"),
    hint: "sandboxed commands run without a prompt in 3rd gear and Auto",
  },
  {
    mode: "regular",
    label: sandboxModeLabel("regular"),
    hint: "still sandboxed; the gear's usual prompt applies to each command",
  },
  {
    mode: "off",
    label: sandboxModeLabel("off"),
    hint: "full host access; commands prompt as the gear dictates",
  },
];

export const SANDBOX_OVERRIDE_CHOICES: ReadonlyArray<{
  fallback: boolean;
  label: string;
  hint: string;
}> = [
  {
    fallback: true,
    label: "Allow unsandboxed fallback",
    hint: "a command that hit a sandbox wall may retry on the host, under regular permissions",
  },
  {
    fallback: false,
    label: "Strict sandbox mode",
    hint: "every command runs sandboxed unless it is in excludedCommands",
  },
];

export function sandboxModeExplanation(mode: SandboxMode): string {
  switch (mode) {
    case "auto-allow":
      return "Commands run in the OS sandbox (no network unless a call sets network: true; writes confined to the workspace, temp and Rune's cache; credential stores unreadable). Because the sandbox is the boundary, 3rd gear and Auto approve sandboxed commands without a prompt. Explicit ask/deny rules are always respected.";
    case "regular":
      return "Commands run in the same OS sandbox, but the gear's ordinary permission prompt still applies to each one — containment without the auto-approval.";
    default:
      return "No sandbox: commands run directly on this machine with full network and filesystem access. 4th gear never prompts; the other gears prompt for every command; Auto reviews anything that is not read-only.";
  }
}

export function sandboxOverrideExplanation(fallback: boolean): string {
  return fallback
    ? "Allow unsandboxed fallback: when a command fails on a sandbox restriction, the agent may retry it once with unsandboxed: true. That retry runs on the host and goes through the regular permission prompt (Auto reviews it)."
    : "Strict sandbox mode: every command runs inside the sandbox unless it is explicitly listed in excludedCommands. unsandboxed: true is refused, and the agent is told to report what host access it needed.";
}

/** The Config tab readout, one line per fact. */
export function sandboxConfigLines(
  policy: Readonly<SandboxPolicy>,
  workspaceRoot?: string,
): string[] {
  const cap = getSandboxCapability();
  const lines: string[] = [];
  lines.push(`Mode: ${policy.mode} — ${sandboxModeLabel(policy.mode)}`);
  lines.push(
    `Override: ${policy.allowUnsandboxedFallback ? "allow unsandboxed fallback" : "strict sandbox mode"}`,
  );
  lines.push(
    `Isolation: ${isOsIsolationAvailable() ? `${cap.mechanism} (OS-enforced)` : `none on this machine (${cap.mechanism}) — path-guard checks only`}`,
  );
  lines.push("");
  lines.push("Excluded commands (run outside the sandbox, regular permissions apply):");
  lines.push(policy.excludedCommands.length ? `  ${policy.excludedCommands.join(", ")}` : "  none");
  lines.push("");
  lines.push("Filesystem read restrictions:");
  lines.push(`  Denied: ${[...BUILTIN_READ_DENY, ...policy.filesystem.denyRead].join(", ")}`);
  lines.push("");
  lines.push("Filesystem write restrictions:");
  const allow = BUILTIN_WRITE_ALLOW.map((p) =>
    p === "<workspace>" ? (workspaceRoot ?? "<workspace>") : p,
  ).concat(policy.filesystem.allowWrite);
  lines.push(`  Allowed: ${allow.join(", ")}`);
  lines.push(
    `  Denied within allowed: ${[...BUILTIN_WRITE_DENY, ...policy.filesystem.denyWrite].join(", ")}`,
  );
  lines.push("");
  lines.push(
    "Network: denied by default; loopback (127.0.0.1) stays open; a call sets network: true to escalate itself.",
  );
  lines.push("");
  lines.push(
    "Change: /sandbox mode <auto-allow|regular|off> · /sandbox override <fallback|strict> · /sandbox exclude <pattern> · [sandbox] and [sandbox.filesystem] in ~/.rune/config.toml",
  );
  return lines;
}

export function sandboxStatusLine(policy: Readonly<SandboxPolicy>): string {
  const parts = [
    `mode ${policy.mode}`,
    policy.allowUnsandboxedFallback ? "fallback allowed" : "strict",
    policy.excludedCommands.length
      ? `${policy.excludedCommands.length} excluded pattern${policy.excludedCommands.length === 1 ? "" : "s"}`
      : "no exclusions",
  ];
  if (policy.mode !== "off" && !isOsIsolationAvailable())
    parts.push("NOT isolated on this machine");
  return `sandbox: ${parts.join(" · ")}`;
}

export function sandboxUsage(): string[] {
  return [
    "Usage: /sandbox                      open the menu (Mode · Overrides · Config)",
    "       /sandbox mode <auto-allow|regular|off>   (also: /sandbox on | off)",
    "       /sandbox override <fallback|strict>",
    "       /sandbox exclude <pattern>    e.g. /sandbox exclude adb *",
    "       /sandbox unexclude <pattern>",
    "       /sandbox config | status",
  ];
}

/**
 * Run one text form of the command. Returns the lines to print and what
 * changed. An empty `args` returns the status readout — the TUI intercepts
 * that case first to show the menu.
 */
export function runSandboxCommand(
  engine: SandboxCommandEngine,
  args: string,
): SandboxCommandResult {
  const raw = args.trim();
  const [head, ...rest] = raw.split(/\s+/).filter(Boolean);
  const tail = rest.join(" ").trim();
  const policy = engine.getSandboxPolicy();
  const workspaceRoot = engine.getWorkspaceRoot?.();

  if (!head || head === "status") {
    return { lines: [sandboxStatusLine(policy), ...(head ? [] : sandboxUsage())] };
  }
  if (head === "config" || head === "show" || head === "list") {
    return { lines: sandboxConfigLines(policy, workspaceRoot) };
  }

  // Mode — `/sandbox mode regular`, or the historical `/sandbox on|off` and a bare mode name.
  const modeWord = head === "mode" ? tail : head;
  const mode = normalizeSandboxMode(modeWord);
  if (head === "mode" || mode) {
    if (!mode) return { lines: [`Unknown sandbox mode "${modeWord}".`, ...sandboxUsage()] };
    engine.setSandboxModeLive(mode);
    saveSandboxState({ mode });
    return { lines: [sandboxModeExplanation(mode)], changed: "mode" };
  }

  // Overrides.
  if (head === "override" || head === "overrides" || head === "fallback" || head === "strict") {
    const word = head === "override" || head === "overrides" ? tail.toLowerCase() : head;
    const fallback =
      word === "fallback" || word === "allow" || word === "on"
        ? true
        : word === "strict" || word === "off"
          ? false
          : undefined;
    if (fallback === undefined) {
      return { lines: [`Choose an override: fallback | strict.`, ...sandboxUsage()] };
    }
    engine.updateSandboxPolicy({ allowUnsandboxedFallback: fallback });
    saveSandboxState({ allowUnsandboxedFallback: fallback });
    return { lines: [sandboxOverrideExplanation(fallback)], changed: "override" };
  }

  // Exclusions — persisted to config.toml so they read as text.
  if (head === "exclude" || head === "unexclude" || head === "include") {
    if (!tail) return { lines: [`Give a command pattern, e.g. /sandbox ${head} adb *`] };
    const current = [...policy.excludedCommands];
    const next =
      head === "exclude"
        ? current.includes(tail)
          ? current
          : [...current, tail]
        : current.filter((p) => p !== tail);
    if (next.length === current.length && head === "exclude") {
      return { lines: [`"${tail}" is already excluded.`] };
    }
    if (next.length === current.length) {
      return { lines: [`"${tail}" was not excluded. Current: ${current.join(", ") || "none"}`] };
    }
    engine.updateSandboxPolicy({ excludedCommands: next });
    let persisted: string;
    try {
      const saved = setConfigValue("sandbox.excludedCommands", next, {
        scope: "global",
        workspaceRoot,
        preferExistingProject: true,
      });
      persisted = `saved to ${saved.path}`;
    } catch (error) {
      persisted = `NOT saved (${error instanceof Error ? error.message : String(error)}) — applies to this session only`;
    }
    return {
      lines: [
        head === "exclude"
          ? `"${tail}" now runs outside the sandbox. It loses the sandbox's auto-allow with its walls, so the gear's ordinary permission prompt applies to it (Auto reviews it).`
          : `"${tail}" runs inside the sandbox again.`,
        `Excluded: ${next.join(", ") || "none"} — ${persisted}`,
      ],
      changed: "excluded",
    };
  }

  return { lines: [`Unknown /sandbox argument "${head}".`, ...sandboxUsage()] };
}
