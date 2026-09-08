// ─── Sandbox policy: the shapes, defaults and pure helpers ───
//
// `/sandbox on|off` used to be the whole story: one process-wide switch
// between "commands run in the OS sandbox" and "full host access". That was
// the wrong granularity in both directions. A user whose Android toolchain
// needs the host had to drop containment for EVERYTHING to run `adb`; a user
// who wanted commands contained but still reviewed had no way to say so; and
// nobody could see what the sandbox actually denied without reading the Rust.
//
// The policy below mirrors the three tabs a person expects to find:
//
//   Mode       auto-allow | regular | off
//              auto-allow  sandboxed commands run without a permission prompt
//                          in 3rd gear and Auto (the sandbox IS the boundary).
//              regular     commands still run sandboxed, but the gear's usual
//                          permission prompt applies to them as well.
//              off         no sandbox: commands run on the host with the
//                          gear's usual prompts (4th gear never prompts).
//   Overrides  allow unsandboxed fallback | strict
//              fallback    a command that failed on a sandbox restriction may
//                          be retried with `unsandboxed: true`; that retry
//                          runs on the host under regular permissions.
//              strict      every command runs sandboxed unless it is listed
//                          in excludedCommands; `unsandboxed: true` is refused.
//   Config     excludedCommands — patterns that always run outside the
//                          sandbox (regular permissions apply to them);
//              filesystem — extra read denials, extra write roots, and paths
//                          denied for writing even inside an allowed root.
//
// This module is pure: types, defaults and string/path helpers only. The
// process-wide runtime state lives in tool-registry/sandbox-mode.ts, the
// persistence in sandbox-store.ts, and the kernel profile in
// crates/rune-sandbox (which reads the path lists this module resolves).

import { homedir } from "os";
import { isAbsolute, resolve } from "path";

export type SandboxMode = "auto-allow" | "regular" | "off";

export const SANDBOX_MODES: readonly SandboxMode[] = ["auto-allow", "regular", "off"];

export interface SandboxFilesystemPolicy {
  /** Paths denied for reading, on top of the built-in credential stores. */
  denyRead: string[];
  /** Extra writable roots, on top of the workspace, Rune's cache and temp. */
  allowWrite: string[];
  /** Paths denied for writing even when they sit inside an allowed root. */
  denyWrite: string[];
}

export interface SandboxPolicy {
  mode: SandboxMode;
  /** The Overrides tab: true = "allow unsandboxed fallback", false = "strict". */
  allowUnsandboxedFallback: boolean;
  /** Command patterns that run outside the sandbox (regular permissions apply). */
  excludedCommands: string[];
  filesystem: SandboxFilesystemPolicy;
}

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = Object.freeze({
  mode: "auto-allow",
  allowUnsandboxedFallback: true,
  excludedCommands: [],
  filesystem: Object.freeze({ denyRead: [], allowWrite: [], denyWrite: [] }),
});

/**
 * Every spelling a mode arrives in — config, the CLI, a chat request — folded
 * onto the canonical three. `on`/`true` mean auto-allow because that is what
 * "sandbox on" has always meant here; `auto` alone is deliberately NOT accepted
 * (it is the gear's name and would be read as the classifier).
 */
export function normalizeSandboxMode(input: unknown): SandboxMode | undefined {
  if (input === true) return "auto-allow";
  if (input === false) return "off";
  if (typeof input !== "string") return undefined;
  const v = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  switch (v) {
    case "auto-allow":
    case "autoallow":
    case "allow":
    case "on":
    case "true":
    case "enabled":
    case "enable":
    case "sandboxed":
      return "auto-allow";
    case "regular":
    case "regular-permissions":
    case "prompt":
    case "ask":
    case "confirm":
    case "review":
      return "regular";
    case "off":
    case "false":
    case "disabled":
    case "disable":
    case "none":
    case "no-sandbox":
    case "nosandbox":
      return "off";
    default:
      return undefined;
  }
}

export function sandboxModeLabel(mode: SandboxMode): string {
  switch (mode) {
    case "auto-allow":
      return "Sandbox bash, with auto-allow";
    case "regular":
      return "Sandbox bash, with regular permissions";
    default:
      return "No sandbox";
  }
}

/**
 * Split a shell command line into its top-level segments: the parts joined by
 * `;`, `&&`, `||`, `|`, `|&` and newlines. Quote-aware, so `echo "a; b"` is
 * one segment, and it never looks inside `$(…)` or backticks — a caller that
 * cares about those checks the raw text. Redirections stay attached to their
 * segment.
 */
export function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let depth = 0; // $( … ) and ( … ) nesting: separators inside stay put
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && next !== undefined) {
        current += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")" && depth > 0) depth--;
    if (depth === 0) {
      if (ch === "\n" || ch === ";") {
        out.push(current);
        current = "";
        continue;
      }
      if (ch === "&" && next === "&") {
        out.push(current);
        current = "";
        i++;
        continue;
      }
      if (ch === "|") {
        out.push(current);
        current = "";
        if (next === "|" || next === "&") i++;
        continue;
      }
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Does one command pattern cover one shell segment? A pattern with `*` is a
 * glob over the whole segment (`docker *`, `*--no-verify*`); a pattern without
 * one names a command prefix, so `docker` covers `docker ps` and `docker` but
 * not `dockerd`. Leading `VAR=value` assignments on the segment are ignored.
 */
export function commandPatternMatches(pattern: string, segment: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const seg = stripLeadingAssignments(segment.trim());
  if (p.includes("*")) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
    try {
      return new RegExp(`^${escaped}$`, "i").test(seg);
    } catch {
      return false;
    }
  }
  if (seg === p) return true;
  return seg.startsWith(p) && /\s/.test(seg.charAt(p.length));
}

/** True when ANY segment of the command matches one of the patterns. */
export function commandMatchesAny(
  command: string,
  patterns: readonly string[],
): string | undefined {
  if (!patterns.length) return undefined;
  for (const segment of splitShellSegments(command)) {
    const hit = patterns.find((p) => commandPatternMatches(p, segment));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The excludedCommands question. Any matching segment takes the whole command
 * out of the sandbox — a command that is half on the host is on the host — and
 * an excluded command loses the sandbox's auto-allow along with its walls, so
 * it earns the gear's ordinary permission decision instead.
 */
export function isExcludedCommand(
  command: string,
  excluded: readonly string[],
): string | undefined {
  return commandMatchesAny(command, excluded);
}

export function stripLeadingAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

/**
 * A policy path as the user wrote it — `~/.gradle`, `.rune/hooks`, `/opt/x` —
 * resolved against the home directory or the workspace. The kernel profile
 * matches absolute paths only, so this has to happen before the list crosses
 * into Rust.
 */
export function expandSandboxPath(target: string, workspaceRoot: string): string {
  const t = target.trim();
  if (!t) return t;
  if (t === "~" || t.startsWith("~/")) return resolve(homedir(), t.slice(1).replace(/^\/+/, ""));
  if (t.startsWith("$HOME/")) return resolve(homedir(), t.slice("$HOME/".length));
  return isAbsolute(t) ? resolve(t) : resolve(workspaceRoot, t);
}

/**
 * Rune's own control surface inside a workspace, denied for writing by the
 * sandbox in every gear. The Auto-mode breaker refuses these paths by policy;
 * this is the same list enforced by the kernel, so a shell that reaches them
 * through `sed -i` or a redirect is stopped whether or not Auto is watching.
 * `.git/hooks` is here because a hook is persistence: it runs on the user's
 * next commit, long after this session ends.
 */
export const BUILTIN_WRITE_DENY: readonly string[] = Object.freeze(
  [".rune", ".gear", ".alan"]
    .flatMap((dir) => [
      `${dir}/config.toml`,
      `${dir}/hooks.json`,
      `${dir}/mcp.json`,
      `${dir}/sandbox.json`,
      `${dir}/policy.json`,
      `${dir}/org.pub`,
      `${dir}/hooks`,
      `${dir}/skills`,
      `${dir}/plugins`,
      `${dir}/commands`,
    ])
    .concat([".git/hooks"]),
);

/**
 * Credential stores the sandbox never lets a command read. Display copy of
 * `credential_deny_paths()` in crates/rune-sandbox/src/lib.rs, which is the
 * enforced list; keep the two in step.
 */
export const BUILTIN_READ_DENY: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker",
  "~/.npmrc",
  "~/.netrc",
  "~/.bash_history",
  "~/.zsh_history",
  "~/.rune/secrets.json",
]);

/** Writable roots the OS profile always grants (display copy of macos.rs / linux.rs). */
export const BUILTIN_WRITE_ALLOW: readonly string[] = Object.freeze([
  "<workspace>",
  "~/.rune/cache",
  "/tmp",
  "/private/tmp",
  "/private/var/folders",
  "$TMPDIR",
]);

/** The absolute path lists handed to `rune-tools` for one command. */
export interface SandboxPathLists {
  deny_read: string[];
  allow_write: string[];
  deny_write: string[];
}

export function effectiveSandboxPaths(
  policy: Pick<SandboxPolicy, "filesystem">,
  workspaceRoot: string,
): SandboxPathLists {
  const expand = (list: readonly string[]) =>
    unique(list.map((p) => expandSandboxPath(p, workspaceRoot)).filter(Boolean));
  return {
    deny_read: expand(policy.filesystem.denyRead),
    allow_write: expand(policy.filesystem.allowWrite),
    deny_write: expand([...BUILTIN_WRITE_DENY, ...policy.filesystem.denyWrite]),
  };
}

/** Coerce whatever a config file held into a well-formed policy fragment. */
export function normalizeSandboxPolicyInput(input: unknown): Partial<SandboxPolicy> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<SandboxPolicy> = {};
  const mode = normalizeSandboxMode(raw.mode);
  if (mode) out.mode = mode;
  else if (typeof raw.enabled === "boolean") out.mode = raw.enabled ? "auto-allow" : "off";
  if (typeof raw.allowUnsandboxedFallback === "boolean") {
    out.allowUnsandboxedFallback = raw.allowUnsandboxedFallback;
  }
  const excluded = stringList(raw.excludedCommands);
  if (excluded) out.excludedCommands = excluded;
  const fs = raw.filesystem;
  if (fs && typeof fs === "object") {
    const f = fs as Record<string, unknown>;
    out.filesystem = {
      denyRead: stringList(f.denyRead) ?? [],
      allowWrite: stringList(f.allowWrite) ?? [],
      denyWrite: stringList(f.denyWrite) ?? [],
    };
  }
  return out;
}

export function mergeSandboxPolicy(
  base: SandboxPolicy,
  patch: Partial<SandboxPolicy> | undefined | null,
): SandboxPolicy {
  if (!patch) return { ...base, filesystem: { ...base.filesystem } };
  return {
    mode: patch.mode ?? base.mode,
    allowUnsandboxedFallback: patch.allowUnsandboxedFallback ?? base.allowUnsandboxedFallback,
    excludedCommands: unique(patch.excludedCommands ?? base.excludedCommands),
    filesystem: {
      denyRead: unique(patch.filesystem?.denyRead ?? base.filesystem.denyRead),
      allowWrite: unique(patch.filesystem?.allowWrite ?? base.filesystem.allowWrite),
      denyWrite: unique(patch.filesystem?.denyWrite ?? base.filesystem.denyWrite),
    },
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
