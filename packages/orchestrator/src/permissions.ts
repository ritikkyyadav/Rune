import { isAbsolute, relative, resolve } from "path";
import { isOsIsolationAvailable, isSandboxEnabled, patchTargetPaths } from "@gear/tool-registry";
import type { PermissionLevel, ToolSchema } from "@gear/tool-registry";
import { policyDenial, type OrgPolicy } from "./org-policy";

export type PermissionScope = "once" | "session" | "project" | "global";

export interface PermissionRule {
  tool: string;
  scope: PermissionScope;
  pattern?: string; // regex pattern on args
  /** Stable serialized args for a narrow, exact-action grant. */
  exactArgs?: string;
  grantedAt: Date;
  expiresAt?: Date;
}

export type PermissionDecision =
  | {
      type: "allowed";
      basis: "bypass" | "safe_tool" | "workspace" | "grant" | "exact_grant";
    }
  | { type: "denied"; reason: string }
  | {
      type: "needs_confirmation";
      tool: string;
      argsSummary: string;
      suggestedScope: PermissionScope;
    };

// ─── Permission modes: the gearbox (the Shift+Tab cycle) ───
// Five states, each behaviorally distinct. Shift+Tab "shifts up" and wraps:
//   gear-1 — guided: prompt before writes and commands (the safe default)
//   gear-2 — workspace file edits proceed; commands and delegation still prompt
//   gear-3 — adds OS-sandboxed local commands and workspace-confined delegation
//   gear-4 — full autonomy: every interactive permission prompt is bypassed.
//            The OS sandbox is an independent knob and is NOT touched by gears.
//   auto   — automatic: an independent classifier reviews risky actions
//
// The broker is the deterministic capability boundary; the Engine owns the
// classifier layer for `auto`.
export type PermissionMode = "gear-1" | "gear-2" | "gear-3" | "gear-4" | "auto";
/** Historical spellings still accepted on input (config, CLI, policy, chat). */
export type LegacyPermissionMode =
  "confirm" | "autonomy-i" | "autonomy-ii" | "autonomy-iii" | "turing" | "hands-free" | "yolo";
export type PermissionModeInput = PermissionMode | LegacyPermissionMode | (string & {});

/** The five gears in Shift+Tab order. */
export const GEAR_MODES: readonly PermissionMode[] = [
  "gear-1",
  "gear-2",
  "gear-3",
  "gear-4",
  "auto",
];
/** Cycle order for Shift+Tab (alias kept for existing callers). */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = GEAR_MODES;

/** The next mode in the Shift+Tab cycle — "shift up" — wrapping after auto. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODE_ORDER.indexOf(mode);
  return PERMISSION_MODE_ORDER[(i + 1) % PERMISSION_MODE_ORDER.length]!;
}

/** Human label: "1st gear" … "4th gear", "auto". */
export function gearLabel(mode: PermissionMode): string {
  switch (mode) {
    case "gear-1":
      return "1st gear";
    case "gear-2":
      return "2nd gear";
    case "gear-3":
      return "3rd gear";
    case "gear-4":
      return "4th gear";
    default:
      return "auto";
  }
}

/** 1–4 for the manual gears, "auto" for the automatic one. */
export function gearNumber(mode: PermissionMode): 1 | 2 | 3 | 4 | "auto" {
  switch (mode) {
    case "gear-1":
      return 1;
    case "gear-2":
      return 2;
    case "gear-3":
      return 3;
    case "gear-4":
      return 4;
    default:
      return "auto";
  }
}

/** One-line behavior summary per gear, for help/status/picker surfaces. */
export const GEAR_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  "gear-1": "guided — asks before every write and command",
  "gear-2": "workspace file edits proceed; commands and delegation still ask",
  "gear-3": "adds sandboxed commands and workspace-confined delegation",
  "gear-4": "full autonomy — no prompts (the sandbox is a separate switch)",
  auto: "automatic — a separate classifier reviews risky actions",
};

export function gearDescription(mode: PermissionMode): string {
  return GEAR_DESCRIPTIONS[mode];
}

/** Persisted spelling for `[permissions] gear` in config.toml. */
export type ConfigPermissionMode = "1" | "2" | "3" | "4" | "auto";

/**
 * Map any accepted spelling onto the canonical PermissionMode. Gears read as
 * numbers ("3"), ordinals ("3rd", "third"), ids ("gear-3"), or the historical
 * names ("autonomy-ii", "hands-free", "turing", "yolo"). Returns undefined for
 * anything unrecognized.
 *
 * `opts.legacyAuto` exists for the OLD `[permissions] mode` key and the old
 * `--trust` / `trustWorkspace` inputs, where "auto" meant "auto-approve
 * workspace work" (today's 3rd gear) — NOT the classifier. New-style inputs
 * (`gear = "auto"`, `--gear auto`, `/mode auto`) mean the classifier.
 */
export function configModeToPermissionMode(
  mode: string | number | undefined | null,
  opts: { legacyAuto?: PermissionMode } = {},
): PermissionMode | undefined {
  if (mode === undefined || mode === null) return undefined;
  const normalized = String(mode)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/^gear-?(?=\S)/, "gear-")
    .replace(/-gear$/, "")
    .replace(/^g(\d)$/, "gear-$1");
  switch (normalized) {
    case "1":
    case "01":
    case "gear-1":
    case "1st":
    case "first":
    case "one":
    case "confirm":
    case "guided":
    case "ask":
    case "prompt":
    case "safe":
    case "normal":
    case "standard":
    case "default":
      return "gear-1";
    case "2":
    case "gear-2":
    case "2nd":
    case "second":
    case "two":
    case "autonomy-i":
    case "autonomy-1":
    case "i":
    case "edits":
    case "edit":
      return "gear-2";
    case "3":
    case "gear-3":
    case "3rd":
    case "third":
    case "three":
    case "autonomy-ii":
    case "autonomy-2":
    case "ii":
    case "workspace":
    case "trust":
    case "trusted":
    case "auto-approve":
    case "autoapprove":
      return "gear-3";
    case "4":
    case "gear-4":
    case "4th":
    case "fourth":
    case "four":
    case "autonomy-iii":
    case "autonomy-3":
    case "iii":
    case "hands-free":
    case "handsfree":
    case "turing":
    case "yolo":
    case "bypass":
    case "full":
    case "autonomous":
      return "gear-4";
    case "auto":
      return opts.legacyAuto ?? "auto";
    case "automatic":
    case "classifier":
    case "auto-review":
    case "gear-auto":
      return "auto";
    default:
      return undefined;
  }
}

/**
 * Resolve the OLD `[permissions] mode` key (and its env aliases). Same grammar
 * as `configModeToPermissionMode`, except the historical "auto" value means
 * "auto-approve workspace work", i.e. 3rd gear — never the classifier.
 */
export function legacyConfigModeToPermissionMode(
  mode: string | undefined | null,
): PermissionMode | undefined {
  return configModeToPermissionMode(mode, { legacyAuto: "gear-3" });
}

/** Map the internal PermissionMode to the persisted `[permissions] gear` value. */
export function permissionModeToConfig(mode: PermissionMode): ConfigPermissionMode {
  const n = gearNumber(mode);
  return n === "auto" ? "auto" : (String(n) as ConfigPermissionMode);
}

/** Signed policies may carry historical values (`turing`, `hands-free`, `autonomy-iii`). */
export function isPermissionModeForbidden(
  policy: OrgPolicy | null | undefined,
  mode: PermissionMode,
): boolean {
  return (
    policy?.forbidPermissionModes?.some((entry) => configModeToPermissionMode(entry) === mode) ??
    false
  );
}

/**
 * Resolve the gear a session should start in. Precedence: explicit `--gear`,
 * the legacy `--autonomy`, `--yolo` (4th), `--trust` (3rd), the persisted
 * `[permissions] gear`, the legacy `[permissions] mode` (where "auto" = 3rd),
 * the legacy `trustWorkspace` boolean (3rd). Absent everything ⇒ 1st gear.
 */
export function resolveStartupPermissionFlags(opts: {
  gearFlag?: string | number;
  modeFlag?: string;
  yoloFlag?: boolean;
  trustFlag?: boolean;
  configGear?: string | number;
  configMode?: string;
  configTrustWorkspace?: boolean;
}): { yoloMode: boolean; trustWorkspace: boolean; permissionMode: PermissionMode } {
  const permissionMode: PermissionMode =
    configModeToPermissionMode(opts.gearFlag) ??
    configModeToPermissionMode(opts.modeFlag) ??
    (opts.yoloFlag
      ? "gear-4"
      : opts.trustFlag
        ? "gear-3"
        : (configModeToPermissionMode(opts.configGear) ??
          legacyConfigModeToPermissionMode(opts.configMode) ??
          (opts.configTrustWorkspace ? "gear-3" : "gear-1")));
  return {
    yoloMode: permissionMode === "gear-4",
    trustWorkspace: permissionMode === "gear-3",
    permissionMode,
  };
}

export class PermissionBroker {
  private sessionGrants: PermissionRule[] = [];
  private mode: PermissionMode;
  private workspaceRoot?: string;
  private orgPolicy: OrgPolicy | null;

  constructor(
    yoloMode = false,
    opts: {
      workspaceRoot?: string;
      trustWorkspace?: boolean;
      initialMode?: PermissionMode;
      orgPolicy?: OrgPolicy | null;
    } = {},
  ) {
    this.workspaceRoot = opts.workspaceRoot;
    this.orgPolicy = opts.orgPolicy ?? null;
    const requested =
      opts.initialMode ?? (yoloMode ? "gear-4" : opts.trustWorkspace ? "gear-3" : "gear-1");
    this.mode = isPermissionModeForbidden(this.orgPolicy, requested) ? "gear-1" : requested;
  }

  /** Legacy helper: full autonomy on ⇒ 4th gear, off ⇒ back to 1st. */
  setYoloMode(enabled: boolean): void {
    if (enabled) void this.setMode("gear-4");
    else if (this.mode === "gear-4") void this.setMode("gear-1");
  }

  /** Legacy helper: "workspace trust" on ⇒ 3rd gear, off ⇒ back to 1st. */
  setTrustWorkspace(enabled: boolean): void {
    if (enabled) void this.setMode("gear-3");
    else if (this.mode === "gear-3") void this.setMode("gear-1");
  }

  /** True in every gear that auto-approves workspace-confined work (2nd, 3rd, auto). */
  isTrustWorkspace(): boolean {
    return ["gear-2", "gear-3", "auto"].includes(this.mode);
  }

  /**
   * Set the active permission mode — the single knob the Shift+Tab cycle drives.
   * Org policy can forbid gears outright (e.g. no 4th gear on managed
   * machines) — a forbidden gear is refused, the current one stands, and the
   * return value tells the caller why.
   */
  setMode(mode: PermissionModeInput): { ok: boolean; reason?: string } {
    const canonical = configModeToPermissionMode(mode);
    if (!canonical) return { ok: false, reason: `unknown gear "${mode}"` };
    if (isPermissionModeForbidden(this.orgPolicy, canonical)) {
      return {
        ok: false,
        reason: `org policy forbids ${gearLabel(canonical)} on this machine`,
      };
    }
    this.mode = canonical;
    return { ok: true };
  }

  /** The active permission mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  check(schema: ToolSchema, args: Record<string, unknown>): PermissionDecision {
    // ── Org policy: FIRST, before every shortcut. A signed policy denial is
    // terminal — 4th gear, workspace autonomy, and session grants cannot
    // override it, or the policy would be advisory. ──
    if (this.orgPolicy) {
      const denial = policyDenial(this.orgPolicy, schema.name, args);
      if (denial) return { type: "denied", reason: denial };
    }

    // 4th gear — allow everything after signed policy/security checks.
    if (this.mode === "gear-4") {
      console.warn(
        `[SECURITY] 4th gear active — all interactive permission checks bypassed for: ${schema.name}`,
      );
      return { type: "allowed", basis: "bypass" };
    }

    // Auto-permitted tools (read-only)
    if (schema.permissionLevel === "auto") {
      return { type: "allowed", basis: "safe_tool" };
    }

    // 2nd gear permits only deterministic, workspace-confined edits. It does
    // not approve shell commands or delegated workers.
    if (this.mode === "gear-2" && this.isWorkspaceEditConfined(schema, args)) {
      return { type: "allowed", basis: "workspace" };
    }

    // 3rd gear adds OS-sandboxed local commands and workspace-confined
    // delegation. Auto uses the same deterministic preliminary boundary, then
    // Engine independently classifies every risky action tier.
    if (
      (this.mode === "gear-3" || this.mode === "auto") &&
      this.isWorkspaceConfined(schema, args)
    ) {
      return { type: "allowed", basis: "workspace" };
    }

    // Check session grants
    const grant = this.findGrant(schema.name, args);
    if (grant) {
      return { type: "allowed", basis: grant.exactArgs ? "exact_grant" : "grant" };
    }

    // Needs confirmation
    const argsSummary = this.summarizeArgs(schema.name, args);
    return {
      type: "needs_confirmation",
      tool: schema.name,
      argsSummary,
      suggestedScope: schema.permissionLevel === "sandbox" ? "once" : "session",
    };
  }

  grant(rule: PermissionRule): void {
    this.sessionGrants.push(rule);
  }

  grantTool(tool: string, scope: PermissionScope): void {
    this.sessionGrants.push({
      tool,
      scope,
      grantedAt: new Date(),
    });
  }

  /**
   * Approve only one canonical tool payload for the session. Auto mode uses
   * this for "allow session" on a risky classifier escalation; a blanket bash
   * grant would otherwise let later, unrelated commands skip the reviewer.
   */
  grantExact(tool: string, args: Record<string, unknown>, scope: PermissionScope): void {
    this.sessionGrants.push({
      tool,
      scope,
      exactArgs: stableArgs(args),
      grantedAt: new Date(),
    });
  }

  /** Legacy name: true in 4th gear (full autonomy). */
  isYoloMode(): boolean {
    return this.mode === "gear-4";
  }

  getSecurityPosture(): "strict" | "standard" | "permissive" | "yolo" {
    if (this.mode === "gear-4") return "yolo";
    if (this.mode === "gear-3" || this.mode === "auto") return "permissive";
    if (this.mode === "gear-2") return "standard";
    const grantedCount = this.sessionGrants?.length ?? 0;
    if (grantedCount === 0) return "strict";
    if (grantedCount > 10) return "permissive";
    return "standard";
  }

  revokeAll(): void {
    this.sessionGrants = [];
  }

  /** Tools whose blast radius is a single `path` argument. */
  private static readonly PATH_CONFINED_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

  /** The narrower 2nd-gear boundary: file edits only, never shell/delegation. */
  private isWorkspaceEditConfined(schema: ToolSchema, args: Record<string, unknown>): boolean {
    if (!this.workspaceRoot) return false;
    if (schema.name === "apply_patch") {
      const paths = patchTargetPaths(typeof args.patch === "string" ? args.patch : "");
      return paths.length > 0 && paths.every((p) => this.isPathInside(this.workspaceRoot!, p));
    }
    if (!PermissionBroker.PATH_CONFINED_TOOLS.has(schema.name)) return false;
    const target = args.path;
    return (
      typeof target === "string" &&
      target.length > 0 &&
      this.isPathInside(this.workspaceRoot, target)
    );
  }

  /**
   * Whether a confirm/sandbox tool's effect is confined to the workspace and
   * therefore safe to auto-approve under workspace trust. Path-based writes are
   * confined when their target resolves inside the workspace root; `bash` is
   * confined because the Rust sandbox is the real containment boundary —
   * UNLESS the call escalates out of the sandbox (network: true), which must
   * keep prompting. Network-reaching tools (web_fetch, web_search,
   * n8n_trigger) are never confined and keep prompting.
   */
  private isWorkspaceConfined(schema: ToolSchema, args: Record<string, unknown>): boolean {
    if (!this.workspaceRoot) return false;
    // Both escapes leave the sandbox: network:true (explicit escalation) and
    // run_in_background:true (servers must bind ports, so they run
    // unsandboxed). Neither may be auto-approved by workspace trust — only
    // sandbox-confined foreground commands are. And when the user disabled
    // the sandbox entirely (/sandbox off), NO bash call is contained, so
    // workspace trust stops auto-approving bash altogether — full access
    // means every command earns a prompt outside 4th gear.
    //
    // Intent is not capability: "sandbox on" only justifies auto-approval when
    // this MACHINE can actually isolate (seatbelt/bwrap present). On the
    // silent-fallback path the Rust executor is path-guard-only — nothing is
    // contained, so bash must earn a prompt exactly as if the sandbox were off.
    if (schema.name === "bash") {
      return (
        isSandboxEnabled() &&
        isOsIsolationAvailable() &&
        args.network !== true &&
        args.run_in_background !== true
      );
    }
    // apply_patch's blast radius is every path named in its envelope: confined
    // when ALL of them (including move destinations) resolve inside the
    // workspace. patchTargetPaths returns [] for unparseable patches, which
    // fails confinement here — and the handler itself re-rejects any
    // out-of-workspace path at execution, so this gates the prompt only.
    if (schema.name === "apply_patch") return this.isWorkspaceEditConfined(schema, args);
    // A worker's blast radius is exactly the files it owns: confined when
    // every owned entry resolves inside the workspace (the ownership guard
    // re-enforces this mechanically at each write).
    if (schema.name === "worker") {
      const files = args.files;
      return (
        Array.isArray(files) &&
        files.length > 0 &&
        files.every(
          (f) => typeof f === "string" && f.length > 0 && this.isPathInside(this.workspaceRoot!, f),
        )
      );
    }
    return this.isWorkspaceEditConfined(schema, args);
  }

  /**
   * True when `target` resolves to `root` or a descendant. This gates the prompt
   * only — the Rust PathGuard performs the authoritative, symlink-aware check
   * before any write actually lands.
   */
  private isPathInside(root: string, target: string): boolean {
    const absRoot = resolve(root);
    const abs = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
    const rel = relative(absRoot, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private findGrant(tool: string, args: Record<string, unknown>): PermissionRule | undefined {
    return this.sessionGrants.find((grant) => {
      if (grant.tool !== tool) return false;

      // Check expiration
      if (grant.expiresAt && new Date() > grant.expiresAt) return false;

      if (grant.exactArgs !== undefined) {
        return grant.exactArgs === stableArgs(args);
      }

      // Check pattern match on args
      if (grant.pattern) {
        const argsStr = JSON.stringify(args);
        try {
          return new RegExp(grant.pattern).test(argsStr);
        } catch {
          return false;
        }
      }

      return true;
    });
  }

  private summarizeArgs(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case "write_file":
      case "edit_file":
        return `${tool} ${args.path ?? "unknown path"}`;
      case "bash": {
        const net = !isSandboxEnabled()
          ? " [sandbox off — full host access]"
          : args.network === true
            ? " [network — runs outside the sandbox]"
            : "";
        return `bash${net}: ${String(args.command ?? "").slice(0, 100)}`;
      }
      case "worker": {
        const files = Array.isArray(args.files) ? (args.files as string[]) : [];
        return `worker [owns: ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` +${files.length - 6}` : ""}]: ${String(args.prompt ?? "").slice(0, 80)}`;
      }
      default:
        return `${tool} ${JSON.stringify(args).slice(0, 100)}`;
    }
  }
}

function stableArgs(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(sort(value));
  } catch {
    return "[unserializable]";
  }
}
