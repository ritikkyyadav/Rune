import { readdir } from "fs/promises";
import { resolve, isAbsolute, join, relative, sep } from "path";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".turbo",
  ".next",
  "coverage",
  ".cache",
];

export const GLOB_SCHEMA: ToolSchema = {
  name: "glob",
  version: "0.1.0",
  description:
    "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts'). Supports * and ? (single path segment) " +
    "and ** (recursive across directories). Returns matching file paths relative to the search root, sorted " +
    "alphabetically. Commonly-ignored directories (node_modules, .git, dist, build, target, ...) are skipped " +
    "by default; add more with `ignore`.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern. Use ** to match across directory boundaries.",
      },
      path: {
        type: "string",
        description:
          "Directory to search from (relative to workspace or absolute). Defaults to the workspace root.",
      },
      limit: { type: "number", description: "Maximum number of results (default 1000)." },
      ignore: {
        type: "array",
        items: { type: "string" },
        description: "Additional directory names to skip.",
      },
    },
    required: ["pattern"],
  },
  permissionLevel: "auto",
  category: "read",
};

/**
 * Translate a glob pattern into an anchored RegExp matched against POSIX-style
 * relative paths. `*` and `?` never cross a path separator; `**` does.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume second '*'
        if (glob[i + 1] === "/") {
          i++; // consume the slash too: '**/' matches zero or more segments
          re += "(?:[^/]*/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walk(dir: string, ignore: Set<string>, out: string[], cap: number): Promise<void> {
  if (out.length >= cap) return;
  for (const entry of await safeReaddir(dir)) {
    if (out.length >= cap) return;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name)) continue;
      await walk(full, ignore, out, cap);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export function createGlobHandler(): ToolHandler {
  return {
    schema: GLOB_SCHEMA,

    validate: (args) => {
      if (typeof args.pattern !== "string" || args.pattern.length === 0) {
        return { valid: false, error: "pattern is required and must be a non-empty string" };
      }
      if (args.path !== undefined && typeof args.path !== "string") {
        return { valid: false, error: "path must be a string" };
      }
      if (args.limit !== undefined && (typeof args.limit !== "number" || args.limit <= 0)) {
        return { valid: false, error: "limit must be a positive number" };
      }
      if (args.ignore !== undefined && !Array.isArray(args.ignore)) {
        return { valid: false, error: "ignore must be an array of strings" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const args = input.args as {
        pattern: string;
        path?: string;
        limit?: number;
        ignore?: string[];
      };
      const base = args.path
        ? isAbsolute(args.path)
          ? args.path
          : resolve(input.workspaceRoot, args.path)
        : resolve(input.workspaceRoot);
      const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 1000;
      const ignore = new Set<string>([...DEFAULT_IGNORE, ...(args.ignore ?? [])]);
      const regex = globToRegExp(args.pattern);

      const allFiles: string[] = [];
      await walk(base, ignore, allFiles, 100000);

      const matches: string[] = [];
      for (const full of allFiles) {
        const rel = relative(base, full).split(sep).join("/");
        if (regex.test(rel)) matches.push(rel);
      }
      matches.sort();

      const truncated = matches.length > limit;
      const shown = truncated ? matches.slice(0, limit) : matches;
      const durationMs = Math.round(performance.now() - start);

      if (shown.length === 0) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: `No files matched pattern: ${args.pattern}`,
          durationMs,
        };
      }

      const header = `${matches.length} match${matches.length === 1 ? "" : "es"}${
        truncated ? ` (showing ${limit})` : ""
      }:`;
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: `${header}\n${shown.join("\n")}`,
        durationMs,
      };
    },
  };
}
