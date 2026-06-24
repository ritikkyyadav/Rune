import { isAbsolute, relative, resolve } from "path";
import type { PermissionLevel, ToolSchema } from "@alan/tool-registry";

export type PermissionScope = "once" | "session" | "project" | "global";

export interface PermissionRule {
  tool: string;
  scope: PermissionScope;
  pattern?: string; // regex pattern on args
  grantedAt: Date;
  expiresAt?: Date;
}

export type PermissionDecision =
  | { type: "allowed" }
  | { type: "denied"; reason: string }
  | {
      type: "needs_confirmation";
      tool: string;
      argsSummary: string;
      suggestedScope: PermissionScope;
    };

// ─── Permission modes (the Shift+Tab cycle) ───
// A single, user-facing knob layered over the broker's two booleans. Shift+Tab
// cycles confirm → auto → turing → confirm, mirroring the way Claude Code cycles
// permission modes. "turing" is Alan's bypass mode (Gemini-CLI's yellow YOLO,
// Claude's bypass-permissions): it reads, writes, and runs commands without ever
// asking. The names map onto the existing machinery — turing⇒yolo, auto⇒trust —
// so nothing downstream has to learn a new concept.
export type PermissionMode = "confirm" | "auto" | "turing";

/** Cycle order for Shift+Tab. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = ["confirm", "auto", "turing"];

/** The next mode in the Shift+Tab cycle (wraps around). */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODE_ORDER.indexOf(mode);
  return PERMISSION_MODE_ORDER[(i + 1) % PERMISSION_MODE_ORDER.length]!;
}

export class PermissionBroker {
  private sessionGrants: PermissionRule[] = [];
  private yoloMode: boolean;
  private trustWorkspace: boolean;
  private workspaceRoot?: string;

  constructor(
    yoloMode = false,
    opts: { workspaceRoot?: string; trustWorkspace?: boolean } = {},
  ) {
    this.yoloMode = yoloMode;
    this.workspaceRoot = opts.workspaceRoot;
    this.trustWorkspace = opts.trustWorkspace ?? false;
  }

  setYoloMode(enabled: boolean): void {
    this.yoloMode = enabled;
  }

  setTrustWorkspace(enabled: boolean): void {
    this.trustWorkspace = enabled;
  }

  isTrustWorkspace(): boolean {
    return this.trustWorkspace;
  }

  /**
   * Set the active permission mode — the single knob the Shift+Tab cycle drives.
   * Mapped onto the two underlying booleans: turing⇒yolo, auto⇒trust, confirm⇒neither.
   */
  setMode(mode: PermissionMode): void {
    this.yoloMode = mode === "turing";
    this.trustWorkspace = mode === "auto";
  }

  /** The active permission mode, derived from the underlying booleans. */
  getMode(): PermissionMode {
    if (this.yoloMode) return "turing";
    if (this.trustWorkspace) return "auto";
    return "confirm";
  }

  check(schema: ToolSchema, args: Record<string, unknown>): PermissionDecision {
    // Yolo mode — allow everything
    if (this.yoloMode) {
      console.warn(
        `[SECURITY] Yolo mode active — all permission checks bypassed for: ${schema.name}`,
      );
      return { type: "allowed" };
    }

    // Auto-permitted tools (read-only)
    if (schema.permissionLevel === "auto") {
      return { type: "allowed" };
    }

    // Workspace trust — when enabled, auto-approve confirm/sandbox tools whose
    // effects stay inside the workspace root. `bash` is contained by the Rust
    // sandbox (no network, blocked destructive patterns, workspace cwd), and
    // path-based writes are confined when their target resolves inside the root.
    // Anything that reaches outside the folder still falls through to a prompt.
    if (this.trustWorkspace && this.isWorkspaceConfined(schema, args)) {
      return { type: "allowed" };
    }

    // Check session grants
    const grant = this.findGrant(schema.name, args);
    if (grant) {
      return { type: "allowed" };
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

  isYoloMode(): boolean {
    return this.yoloMode;
  }

  getSecurityPosture(): "strict" | "standard" | "permissive" | "yolo" {
    if (this.yoloMode) return "yolo";
    if (this.trustWorkspace) return "permissive";
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

  /**
   * Whether a confirm/sandbox tool's effect is confined to the workspace and
   * therefore safe to auto-approve under workspace trust. Path-based writes are
   * confined when their target resolves inside the workspace root; `bash` is
   * always confined because the Rust sandbox is the real containment boundary.
   * Network-reaching tools (web_fetch, web_search, n8n_trigger) are never
   * confined and keep prompting.
   */
  private isWorkspaceConfined(schema: ToolSchema, args: Record<string, unknown>): boolean {
    if (!this.workspaceRoot) return false;
    if (schema.name === "bash") return true;
    if (!PermissionBroker.PATH_CONFINED_TOOLS.has(schema.name)) return false;
    const target = args.path;
    if (typeof target !== "string" || target.length === 0) return false;
    return this.isPathInside(this.workspaceRoot, target);
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
      case "bash":
        return `bash: ${String(args.command ?? "").slice(0, 100)}`;
      default:
        return `${tool} ${JSON.stringify(args).slice(0, 100)}`;
    }
  }
}
