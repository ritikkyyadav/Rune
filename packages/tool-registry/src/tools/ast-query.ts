import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import * as fs from "fs";
import * as path from "path";

export const AST_QUERY_SCHEMA: ToolSchema = {
  name: "ast_query",
  version: "0.1.0",
  description: "Find functions, classes, imports, exports in a source file via pattern matching.",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path to analyze" },
      pattern: {
        type: "string",
        description: '"functions", "classes", "imports", "exports", or a regex pattern',
      },
      language: {
        type: "string",
        description: "Language hint (auto-detected from extension if omitted)",
      },
    },
    required: ["file", "pattern"],
  },
  permissionLevel: "auto",
  category: "read",
};

const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
};

const FN_PATTERNS: Record<string, RegExp> = {
  typescript:
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  javascript:
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  python: /def\s+(\w+)\s*\(/,
  rust: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  go: /func\s+(?:\([^)]*\)\s+)?(\w+)/,
  java: /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)(\w+)\s*\(/,
  ruby: /def\s+(\w+)/,
};

const CLASS_PATTERNS: Record<string, RegExp> = {
  typescript: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  javascript: /(?:export\s+)?class\s+(\w+)/,
  python: /class\s+(\w+)/,
  rust: /(?:pub\s+)?(?:struct|enum)\s+(\w+)/,
  go: /type\s+(\w+)\s+struct/,
  java: /(?:public\s+)?class\s+(\w+)/,
  ruby: /class\s+(\w+)/,
};

export function createAstQueryHandler(): ToolHandler {
  return {
    schema: AST_QUERY_SCHEMA,

    validate: (args) => {
      if (typeof args.file !== "string" || !args.file) {
        return { valid: false, error: "file is required and must be a string" };
      }
      if (typeof args.pattern !== "string" || !args.pattern) {
        return { valid: false, error: "pattern is required and must be a string" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const {
        file: fp,
        pattern,
        language,
      } = input.args as {
        file: string;
        pattern: string;
        language?: string;
      };

      const fullPath = path.isAbsolute(fp) ? fp : path.join(input.workspaceRoot, fp);

      if (!fs.existsSync(fullPath)) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: `Not found: ${fp}`,
          durationMs: Math.round(performance.now() - start),
        };
      }

      const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
      const lang = language || LANG_MAP[path.extname(fullPath)] || "typescript";

      const results: {
        name: string;
        type: string;
        line: number;
        text: string;
      }[] = [];

      const scan = (pat: RegExp, type: string) => {
        lines.forEach((l, i) => {
          const m = l.match(pat);
          if (m) {
            results.push({
              name: m[1] || m[2] || "?",
              type,
              line: i + 1,
              text: l.trim(),
            });
          }
        });
      };

      switch (pattern) {
        case "functions":
          scan(FN_PATTERNS[lang] || FN_PATTERNS.typescript, "function");
          break;
        case "classes":
          scan(CLASS_PATTERNS[lang] || CLASS_PATTERNS.typescript, "class");
          break;
        case "imports":
          lines.forEach((l, i) => {
            if (/^\s*(import |from |require\(|use |#include)/.test(l)) {
              results.push({
                name: l.trim(),
                type: "import",
                line: i + 1,
                text: l.trim(),
              });
            }
          });
          break;
        case "exports":
          lines.forEach((l, i) => {
            if (/^\s*(export |pub )/.test(l)) {
              results.push({
                name: l.trim(),
                type: "export",
                line: i + 1,
                text: l.trim(),
              });
            }
          });
          break;
        default: {
          // Treat as regex, fall back to literal match
          try {
            const re = new RegExp(pattern, "i");
            lines.forEach((l, i) => {
              if (re.test(l)) {
                results.push({
                  name: "match",
                  type: "pattern",
                  line: i + 1,
                  text: l.trim(),
                });
              }
            });
          } catch {
            lines.forEach((l, i) => {
              if (l.includes(pattern)) {
                results.push({
                  name: "match",
                  type: "literal",
                  line: i + 1,
                  text: l.trim(),
                });
              }
            });
          }
        }
      }

      const resultData = {
        file: fp,
        language: lang,
        matches: results,
        total: results.length,
      };

      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify(resultData),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
