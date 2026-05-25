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

export class PermissionBroker {
  private sessionGrants: PermissionRule[] = [];
  private yoloMode: boolean;

  constructor(yoloMode = false) {
    this.yoloMode = yoloMode;
  }

  setYoloMode(enabled: boolean): void {
    this.yoloMode = enabled;
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
    const grantedCount = this.sessionGrants?.length ?? 0;
    if (grantedCount === 0) return "strict";
    if (grantedCount > 10) return "permissive";
    return "standard";
  }

  revokeAll(): void {
    this.sessionGrants = [];
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
