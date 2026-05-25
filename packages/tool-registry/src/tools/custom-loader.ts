import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { readdirSync, existsSync, watchFile, unwatchFile } from "fs";
import { join, extname } from "path";

// ─── Custom Tool Interface ───
// Users drop files in .alan/tools/ that export this shape.

interface CustomToolExport {
  schema: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  execute: (
    args: Record<string, unknown>,
    context: { workspaceRoot: string; sessionId: string },
  ) => Promise<string | Record<string, unknown>>;
}

// ─── Custom Tools Loader ───

export class CustomToolsLoader {
  private toolsDir: string;
  private handlers: Map<string, ToolHandler> = new Map();
  private watchers: string[] = [];

  constructor(workspaceRoot: string) {
    this.toolsDir = join(workspaceRoot, ".alan", "tools");
  }

  /**
   * Scan the tools directory and load all tool files.
   */
  async loadAll(): Promise<ToolHandler[]> {
    this.handlers.clear();

    if (!existsSync(this.toolsDir)) {
      return [];
    }

    const files = readdirSync(this.toolsDir).filter((f) => {
      const ext = extname(f);
      return ext === ".ts" || ext === ".js" || ext === ".mjs";
    });

    for (const file of files) {
      try {
        const handler = await this.loadToolFile(join(this.toolsDir, file));
        if (handler) {
          this.handlers.set(handler.schema.name, handler);
        }
      } catch (err) {
        console.error(
          `[CustomTools] Failed to load ${file}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return [...this.handlers.values()];
  }

  /**
   * Reload a specific tool file (for hot-reload).
   */
  async reload(filePath: string): Promise<ToolHandler | null> {
    const handler = await this.loadToolFile(filePath);
    if (handler) {
      this.handlers.set(handler.schema.name, handler);
    }
    return handler;
  }

  /**
   * Start watching the tools directory for changes.
   */
  watch(onChange: (handlers: ToolHandler[]) => void): void {
    if (!existsSync(this.toolsDir)) return;

    const files = readdirSync(this.toolsDir);
    for (const file of files) {
      const fullPath = join(this.toolsDir, file);
      watchFile(fullPath, { interval: 1000 }, async () => {
        await this.loadAll();
        onChange([...this.handlers.values()]);
      });
      this.watchers.push(fullPath);
    }
  }

  /**
   * Stop watching for changes.
   */
  unwatch(): void {
    for (const path of this.watchers) {
      unwatchFile(path);
    }
    this.watchers = [];
  }

  getHandlers(): ToolHandler[] {
    return [...this.handlers.values()];
  }

  /**
   * Validate a custom tool export for correctness and security risk.
   */
  validate(tool: CustomToolExport): {
    valid: boolean;
    errors: string[];
    riskLevel: "safe" | "review" | "dangerous";
  } {
    const errors: string[] = [];
    let riskLevel: "safe" | "review" | "dangerous" = "safe";

    if (!tool.schema?.name || !/^[a-zA-Z_]\w*$/.test(tool.schema.name)) {
      errors.push("Invalid tool name");
    }
    if (!tool.schema?.description) errors.push("Missing description");
    if (typeof tool.execute !== "function") errors.push("Missing execute function");

    // Source analysis if available
    const sourceHint = (tool as unknown as { _source?: unknown })._source;
    const src = typeof sourceHint === "string" ? sourceHint : (tool.execute?.toString?.() ?? "");
    if (/child_process|exec\(|execSync|spawn\(/.test(src)) riskLevel = "dangerous";
    if (/process\.env/.test(src)) riskLevel = riskLevel === "safe" ? "review" : riskLevel;
    if (/require\s*\(\s*['"]fs['"]/.test(src))
      riskLevel = riskLevel === "safe" ? "review" : riskLevel;

    return { valid: errors.length === 0 && riskLevel !== "dangerous", errors, riskLevel };
  }

  private async loadToolFile(filePath: string): Promise<ToolHandler | null> {
    // Use dynamic import with cache-busting for hot reload
    const mod = await import(`${filePath}?t=${Date.now()}`);
    const exported: CustomToolExport = mod.default ?? mod;

    if (!exported.schema?.name || !exported.execute) {
      console.warn(`[CustomTools] ${filePath}: missing schema.name or execute`);
      return null;
    }

    // Run validation
    const validation = this.validate(exported);
    if (!validation.valid) {
      console.warn(`[CustomTools] ${filePath} failed validation: ${validation.errors.join("; ")}`);
      return null;
    }
    if (validation.riskLevel === "review") {
      console.warn(`[CustomTools] ${filePath} flagged for review (risk: ${validation.riskLevel})`);
    }

    const prefixedName = `custom_${exported.schema.name}`;
    const schema: ToolSchema = {
      name: prefixedName,
      version: "0.1.0",
      description: exported.schema.description ?? `Custom tool: ${exported.schema.name}`,
      inputSchema: exported.schema.inputSchema ?? { type: "object", properties: {} },
      permissionLevel: "confirm",
      category: "execute",
    };

    return {
      schema,
      validate: (args: Record<string, unknown>) => {
        const inputSchema = schema.inputSchema as Record<string, unknown>;
        if (Array.isArray(inputSchema.required)) {
          for (const req of inputSchema.required as string[]) {
            if (!(req in args)) return { valid: false, error: `Missing required param: ${req}` };
          }
        }
        return { valid: true };
      },
      execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
        const start = performance.now();
        try {
          const result = await exported.execute(input.args, {
            workspaceRoot: input.workspaceRoot,
            sessionId: input.sessionId,
          });

          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          return {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: resultStr,
            durationMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: err instanceof Error ? err.message : String(err),
            durationMs: Math.round(performance.now() - start),
          };
        }
      },
    };
  }
}
