import type { Stats } from "fs";
import { readFile, stat } from "fs/promises";
import { resolve, isAbsolute } from "path";
import { createHash } from "crypto";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { unifiedDiff } from "./unified-diff";
import {
  decodeText,
  encodeText,
  hardLinkNote,
  replaceExact,
  writeAtomic,
  type MatchStrategy,
  type TextFile,
} from "./text-file";

export type { MatchStrategy } from "./text-file";

export interface EditOp {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

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
    "Each edit replaces old_text with new_text, matched exactly as the file holds it (line endings may differ; " +
    "indentation and trailing whitespace may not). A miss names the lines that nearly matched and what differs. " +
    "Read the file first; expected_hash is filled in from that read.",
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
          "SHA-256 hash from a prior read_file. Filled in automatically from the last read when omitted.",
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

/**
 * Apply one edit and report how it matched, or throw a message the caller can
 * act on — so the whole (atomic) operation aborts with nothing written.
 *
 * Exported: apply_patch routes its parsed hunks through this same matcher, so
 * both edit formats share one application semantics. Until 2026-10-14 a miss
 * fell back to whitespace- and then indentation-insensitive line matching and
 * spliced `new_text` in verbatim; the indentation tier applied a Python edit
 * that no longer parsed and reported success (probe P6). Matching is exact
 * now, and a miss says what nearly matched (see ./text-file).
 */
export function applyOneEdit(
  content: string,
  edit: EditOp,
  index: number,
): { content: string; report: EditReport } {
  try {
    const r = replaceExact(
      content,
      edit.old_text,
      edit.new_text,
      edit.replace_all === true,
      "the file",
    );
    return {
      content: r.content,
      report: { index, strategy: r.strategy, replacements: r.replacements },
    };
  } catch (err) {
    throw new Error(`edit[${index}]: ${err instanceof Error ? err.message : String(err)}`);
  }
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
      let info: Stats;
      try {
        [raw, info] = await Promise.all([readFile(abs), stat(abs)]);
      } catch {
        return fail(`Cannot read file: ${args.path}`);
      }
      const currentHash = sha256Hex(raw);

      // Strict UTF-8 or nothing: the lossy decode wrote U+FFFD over every byte
      // that was not UTF-8, anywhere in the file (probe P4).
      let file: TextFile;
      try {
        file = decodeText(raw, args.path, "multi_edit");
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      // A file that changed after it was read is edited only when every edit
      // still matches the current content exactly; otherwise the caller's
      // picture of the file is out of date, and that is what the refusal says.
      const stale = args.expected_hash !== undefined && args.expected_hash !== currentHash;

      let content = file.text;
      const reports: EditReport[] = [];
      try {
        for (let i = 0; i < args.edits.length; i++) {
          const { content: next, report } = applyOneEdit(content, args.edits[i], i);
          content = next;
          reports.push(report);
        }
      } catch (err) {
        // Atomic: any failed edit aborts the whole operation with no write.
        if (stale) {
          return fail(
            `Hash mismatch: ${args.path} has changed since it was last read ` +
              `(expected ${args.expected_hash}, now ${currentHash}), and its edits no longer ` +
              "match it exactly. Re-read the file first.",
          );
        }
        return fail(err instanceof Error ? err.message : String(err));
      }

      // ── Does this edit have anything to write? ──
      //
      // Compared as BYTES. Before strict decoding, `raw.toString("utf8")`
      // replaced every byte that was not valid UTF-8 with U+FFFD, so an edit
      // that reproduced the text it matched wrote those replacement characters
      // back over a file that was not UTF-8 while reporting an EMPTY diff (V-A,
      // 2026-09-11). Such files are refused above now; equal bytes still mean
      // there is nothing to write, and the file keeps its inode and mtime.
      const next = encodeText(content, file.bom);
      const unchanged = next.equals(raw);

      if (!unchanged) {
        try {
          // The replaced file's permission bits survive the rename (probe P1).
          await writeAtomic(abs, next, info.mode);
        } catch (err) {
          return fail(
            `Failed to write ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const notes: string[] = [];
      if (stale) {
        notes.push(
          `${args.path} changed after it was last read; every edit still matched exactly, so ` +
            "they were applied to the current content. Re-read it before an edit that depends " +
            "on the code around these.",
        );
      }
      const linkNote = unchanged ? undefined : hardLinkNote(args.path, info.nlink);
      if (linkNote) notes.push(linkNote);

      const newHash = unchanged ? currentHash : sha256Hex(next);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({
          path: args.path,
          hash: newHash,
          // The hash the file had BEFORE this call, and the verdict that reads
          // the two. An empty `diff` only ever says the two TEXTS matched; these
          // say whether the bytes on disk moved, which is what "this edit
          // changed nothing" has to mean to a gate that trusts it.
          prior_hash: currentHash,
          unchanged,
          edits_applied: reports.length,
          edits: reports,
          ...(stale ? { changed_since_read: true } : {}),
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          // The diff the transcript renders as red/green. multi_edit ran in TS
          // and had both texts in hand but never emitted one, so its rows showed
          // no change at all — the same gap apply_patch had. See ./unified-diff.
          diff: unifiedDiff(file.text, content, args.path),
        }),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
