import { isAbsolute, relative, resolve } from "path";
import { isOsIsolationAvailable, isSandboxEnabled, patchTargetPaths } from "@alan/tool-registry";
import type { PermissionLevel, ToolSchema } from "@alan/tool-registry";
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

// ─── Permission modes (the Shift+Tab cycle) ───
// The five states are deliberately behaviorally distinct:
//   confirm       — prompt before writes and commands
//   autonomy-i    — confined workspace edits proceed; commands still prompt
//   autonomy-ii   — add sandboxed local commands and confined delegation
//   autonomy-iii  — full permission bypass (the renamed legacy Hands-Free mode)
//   auto          — independent classifier review at risky action boundaries
//
// The Engine owns the classifier layer for Auto and the sandbox transition for
// Autonomy III. The broker remains the deterministic capability boundary.
export type PermissionMode = "confirm" | "autonomy-i" | "autonomy-ii" | "autonomy-iii" | "auto";
export type LegacyPermissionMode = "turing" | "hands-free";
export type PermissionModeInput = PermissionMode | LegacyPermissionMode;

/** Cycle order for Shift+Tab. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  "confirm",
  "autonomy-i",
  "autonomy-ii",
  "autonomy-iii",
  "auto",
];

/** The next mode in the Shift+Tab cycle (wraps around). */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODE_ORDER.indexOf(mode);
  return PERMISSION_MODE_ORDER[(i + 1) % PERMISSION_MODE_ORDER.length]!;
}

/** Canonical user-facing config spellings. */
export type ConfigPermissionMode = PermissionMode;

/**
 * Map config/CLI spellings onto the canonical PermissionMode. Historical
 * Hands-Free/turing/yolo spellings remain read-compatible and migrate to
 * Autonomy III the next time the value is persisted.
 */
export function configModeToPermissionMode(mode: string | undefined): PermissionMode | undefined {
  const normalized = mode
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  switch (normalized) {
    case "hands-free":
    case "handsfree":
    case "turing":
    case "yolo":
    case "bypass":
    case "full":
    case "autonomy-3":
    case "autonomy-iii":
    case "iii":
    case "3":
      return "autonomy-iii";
    case "autonomy-2":
    case "autonomy-ii":
    case "ii":
    case "2":
      return "autonomy-ii";
    case "autonomy-1":
    case "autonomy-i":
    case "i":
    case "1":
      return "autonomy-i";
    case "auto":
      return "auto";
    case "confirm":
      return "confirm";
    default:
      return undefined;
  }
}

/** Map the internal PermissionMode back to the config's user-facing spelling. */
export function permissionModeToConfig(mode: PermissionMode): ConfigPermissionMode {
  return mode;
}

/** Signed policies may still carry the historical `turing`/`hands-free` value. */
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
 * Resolve the mode a session should start in. An explicit `--autonomy` value
 * wins, followed by legacy `--yolo`, `--trust`, persisted mode, and the legacy
 * trustWorkspace boolean. Absent everything ⇒ Confirm.
 */
export function resolveStartupPermissionFlags(opts: {
  yoloFlag?: boolean;
  trustFlag?: boolean;
  modeFlag?: string;
  configMode?: string;
  configTrustWorkspace?: boolean;
}): { yoloMode: boolean; trustWorkspace: boolean; permissionMode: PermissionMode } {
  const configMode = configModeToPermissionMode(opts.configMode);
  const explicitMode = configModeToPermissionMode(opts.modeFlag);
  const permissionMode =
    explicitMode ??
    (opts.yoloFlag
      ? "autonomy-iii"
      : opts.trustFlag
        ? "auto"
        : (configMode ?? (opts.configTrustWorkspace ? "auto" : "confirm")));
  return {
    yoloMode: permissionMode === "autonomy-iii",
    trustWorkspace: permissionMode === "auto",
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
      opts.initialMode ?? (yoloMode ? "autonomy-iii" : opts.trustWorkspace ? "auto" : "confirm");
    this.mode = isPermissionModeForbidden(this.orgPolicy, requested) ? "confirm" : requested;
  }

  setYoloMode(enabled: boolean): void {
    if (enabled) void this.setMode("autonomy-iii");
    else if (this.mode === "autonomy-iii") void this.setMode("confirm");
  }

  setTrustWorkspace(enabled: boolean): void {
    if (enabled) void this.setMode("auto");
    else if (this.mode === "auto") void this.setMode("confirm");
  }

  isTrustWorkspace(): boolean {
    return ["autonomy-i", "autonomy-ii", "auto"].includes(this.mode);
  }

  /**
   * Set the active permission mode — the single knob the Shift+Tab cycle drives.
   * Org policy can forbid modes outright (e.g. no Autonomy III on managed
   * machines) — a forbidden mode is refused, the current mode stands, and the
   * return value tells the caller why.
   */
  setMode(mode: PermissionModeInput): { ok: boolean; reason?: string } {
    const canonical = configModeToPermissionMode(mode);
    if (!canonical) return { ok: false, reason: `unknown permission mode "${mode}"` };
    if (isPermissionModeForbidden(this.orgPolicy, canonical)) {
      return { ok: false, reason: `org policy forbids "${canonical}" mode on this machine` };
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
    // terminal — Autonomy III, workspace autonomy, and session grants cannot
    // override it, or the policy would be advisory. ──
    if (this.orgPolicy) {
      const denial = policyDenial(this.orgPolicy, schema.name, args);
      if (denial) return { type: "denied", reason: denial };
    }

    // Autonomy III — allow everything after signed policy/security checks.
    if (this.mode === "autonomy-iii") {
      console.warn(
        `[SECURITY] Autonomy III active — all interactive permission checks bypassed for: ${schema.name}`,
      );
      return { type: "allowed", basis: "bypass" };
    }

    // Auto-permitted tools (read-only)
    if (schema.permissionLevel === "auto") {
      return { type: "allowed", basis: "safe_tool" };
    }

    // Autonomy I permits only deterministic, workspace-confined edits. It does
    // not approve shell commands or delegated workers.
    if (this.mode === "autonomy-i" && this.isWorkspaceEditConfined(schema, args)) {
      return { type: "allowed", basis: "workspace" };
    }

    // Autonomy II adds OS-sandboxed local commands and workspace-confined
    // delegation. Auto uses the same deterministic preliminary boundary, then
    // Engine independently classifies every risky action tier.
    if (
      (this.mode === "autonomy-ii" || this.mode === "auto") &&
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

  isYoloMode(): boolean {
    return this.mode === "autonomy-iii";
  }

  getSecurityPosture(): "strict" | "standard" | "permissive" | "yolo" {
    if (this.mode === "autonomy-iii") return "yolo";
    if (this.mode === "autonomy-ii" || this.mode === "auto") return "permissive";
    if (this.mode === "autonomy-i") return "standard";
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

  /** The narrower Autonomy I boundary: file edits only, never shell/delegation. */
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
    // means every command earns a prompt outside Autonomy III.
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
