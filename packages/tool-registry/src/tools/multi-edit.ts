import { readFile, writeFile, rename } from "fs/promises";
import { resolve, isAbsolute } from "path";
import { createHash, randomBytes } from "crypto";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

export interface EditOp {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

export type MatchStrategy = "exact" | "whitespace" | "indentation";

export interface EditReport {
  index: number;
  strategy: MatchStrategy;
  replacements: number;
}

export const MULTI_EDIT_SCHEMA: ToolSchema = {
  name: "multi_edit",
  version: "0.1.0",
  description:
    "Apply a sequence of find-and-replace edits to a single file atomically — all edits succeed or none are written. " +
    "Each edit replaces old_text with new_text. If an exact match is not found, the tool falls back to " +
    "whitespace-insensitive and then indentation-insensitive matching, but only when the match is unambiguous " +
    "(otherwise it errors instead of guessing). Pass expected_hash from a prior read_file to guard against stale edits.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to edit (relative to workspace or absolute).",
      },
      expected_hash: {
        type: "string",
        description:
          "SHA-256 hash from a prior read_file. Recommended — guards against editing a file that changed underneath you.",
      },
      edits: {
        type: "array",
        description:
          "Ordered list of edits. Applied sequentially; later edits operate on the result of earlier ones.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            old_text: {
              type: "string",
              description: "Text to find. Must be unique unless replace_all is true.",
            },
            new_text: { type: "string", description: "Replacement text." },
            replace_all: {
              type: "boolean",
              description: "Replace every occurrence instead of requiring a unique match.",
            },
          },
          required: ["old_text", "new_text"],
        },
      },
    },
    required: ["path", "edits"],
  },
  permissionLevel: "confirm",
  category: "write",
};

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

const rtrim = (s: string): string => s.replace(/[ \t\r]+$/, "");
const fulltrim = (s: string): string => s.trim();

// Returns the (non-overlapping) start indices of every line-window in `lines`
// that matches `normOld` once each line is run through `norm`.
function locateWindows(lines: string[], normOld: string[], norm: (s: string) => string): number[] {
  const starts: number[] = [];
  if (normOld.length === 0) return starts;
  for (let i = 0; i + normOld.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < normOld.length; j++) {
      if (norm(lines[i + j]) !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      starts.push(i);
      i += normOld.length - 1; // non-overlapping
    }
  }
  return starts;
}

function spliceWindows(
  lines: string[],
  starts: number[],
  oldLen: number,
  newLines: string[],
): string[] {
  const startSet = new Set(starts);
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (startSet.has(i)) {
      out.push(...newLines);
      i += oldLen;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

// Applies one edit and returns the new content plus which strategy matched.
// Throws a descriptive Error if the edit cannot be applied unambiguously, so
// the caller can abort the whole (atomic) operation without writing anything.
// Exported: apply_patch routes its parsed hunks through this same matcher so
// both edit formats share one application semantics (3-tier fallback,
// unambiguity-or-error, no partial application).
export function applyOneEdit(
  content: string,
  edit: EditOp,
  index: number,
): { content: string; report: EditReport } {
  const replaceAll = edit.replace_all === true;
  const { old_text: oldText, new_text: newText } = edit;

  // ── Tier 1: exact substring ──
  const exact = countOccurrences(content, oldText);
  if (exact > 0) {
    if (!replaceAll && exact > 1) {
      throw new Error(
        `edit[${index}]: old_text matches ${exact} times. ` +
          `Add surrounding context to make it unique, or set replace_all.`,
      );
    }
    const next = replaceAll
      ? content.split(oldText).join(newText)
      : replaceOnce(content, oldText, newText);
    return {
      content: next,
      report: { index, strategy: "exact", replacements: replaceAll ? exact : 1 },
    };
  }

  // ── Tiers 2 & 3: line-based normalized matching ──
  const lines = content.split("\n");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const tiers: Array<[MatchStrategy, (s: string) => string]> = [
    ["whitespace", rtrim],
    ["indentation", fulltrim],
  ];

  for (const [strategy, norm] of tiers) {
    const normOld = oldLines.map(norm);
    const starts = locateWindows(lines, normOld, norm);
    if (starts.length === 0) continue;
    if (!replaceAll && starts.length > 1) {
      throw new Error(
        `edit[${index}]: old_text matches ${starts.length} times after ` +
          `${strategy}-insensitive matching. Add context or set replace_all.`,
      );
    }
    const targets = replaceAll ? starts : [starts[0]];
    const out = spliceWindows(lines, targets, oldLines.length, newLines);
    return { content: out.join("\n"), report: { index, strategy, replacements: targets.length } };
  }

  throw new Error(
    `edit[${index}]: old_text not found in file ` +
      `(tried exact, whitespace-insensitive, and indentation-insensitive matching).`,
  );
}

export function createMultiEditHandler(): ToolHandler {
  return {
    schema: MULTI_EDIT_SCHEMA,

    validate: (args) => {
      if (typeof args.path !== "string" || args.path.length === 0) {
        return { valid: false, error: "path is required and must be a non-empty string" };
      }
      if (args.expected_hash !== undefined && typeof args.expected_hash !== "string") {
        return { valid: false, error: "expected_hash must be a string" };
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return { valid: false, error: "edits is required and must be a non-empty array" };
      }
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i];
        if (typeof e !== "object" || e === null) {
          return { valid: false, error: `edits[${i}] must be an object` };
        }
        const o = e as Record<string, unknown>;
        if (typeof o.old_text !== "string" || o.old_text.length === 0) {
          return {
            valid: false,
            error: `edits[${i}].old_text is required and must be a non-empty string`,
          };
        }
        if (typeof o.new_text !== "string") {
          return { valid: false, error: `edits[${i}].new_text is required and must be a string` };
        }
        if (o.replace_all !== undefined && typeof o.replace_all !== "boolean") {
          return { valid: false, error: `edits[${i}].replace_all must be a boolean` };
        }
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const fail = (error: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error,
        durationMs: Math.round(performance.now() - start),
      });

      const args = input.args as { path: string; expected_hash?: string; edits: EditOp[] };
      const abs = isAbsolute(args.path) ? args.path : resolve(input.workspaceRoot, args.path);

      let raw: Buffer;
      try {
        raw = await readFile(abs);
      } catch {
        return fail(`Cannot read file: ${args.path}`);
      }

      const currentHash = sha256Hex(raw);
      if (args.expected_hash !== undefined && args.expected_hash !== currentHash) {
        return fail(
          `Hash mismatch: ${args.path} has changed since last read. ` +
            `Expected ${args.expected_hash}, got ${currentHash}. Re-read the file first.`,
        );
      }

      let content = raw.toString("utf8");
      const reports: EditReport[] = [];
      try {
        for (let i = 0; i < args.edits.length; i++) {
          const { content: next, report } = applyOneEdit(content, args.edits[i], i);
          content = next;
          reports.push(report);
        }
      } catch (err) {
        // Atomic: any failed edit aborts the whole operation with no write.
        return fail(err instanceof Error ? err.message : String(err));
      }

      // Atomic write: write to a temp file in the same dir, then rename over.
      const tmp = `${abs}.gear-tmp-${randomBytes(6).toString("hex")}`;
      try {
        await writeFile(tmp, content, "utf8");
        await rename(tmp, abs);
      } catch (err) {
        return fail(
          `Failed to write ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const newHash = sha256Hex(Buffer.from(content, "utf8"));
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({
          path: args.path,
          hash: newHash,
          edits_applied: reports.length,
          edits: reports,
        }),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
