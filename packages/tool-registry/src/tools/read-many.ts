// ─── read_many: the batched form of read_file ───
//
// Why this exists: the loop's measured trip count was 1.7 tool calls per model
// turn — a serial crawl where the model read one file, waited a full model
// round-trip, read the next. Each of those trips re-processes the whole
// context. Prompting the model to batch is a nudge; a tool whose SHAPE is a
// batch is a guarantee. One read_many call does what up to twelve sequential
// read_file trips did, deterministically.
//
// Composition: this wraps the registry's real read_file handler (the
// freshness-wrapped one), so every file read through here records its hash
// exactly like a plain read_file — later edit_file calls stay valid. Images
// are skipped with a pointer to read_file (attachments ride only single
// reads, by design).

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

const MAX_PATHS = 12;
/** Per-file cap keeps one giant file from starving the rest of the batch. */
const PER_FILE_CHAR_CAP = 24_000;
/** Total cap bounds the tool result before the transcript truncator sees it. */
const TOTAL_CHAR_CAP = 120_000;

export const READ_MANY_SCHEMA: ToolSchema = {
  name: "read_many",
  version: "0.1.0",
  description:
    "Read up to 12 files in ONE call — the batched form of read_file. Prefer this whenever " +
    "the next several reads don't depend on each other's contents: one call costs one model " +
    "round-trip where sequential read_file calls cost one each. Returns every file " +
    "line-numbered under a '=== <path> ===' header, with hashes recorded for later edits. " +
    "Images/binaries are skipped (use read_file); for a targeted slice of one large file, " +
    "use read_file with offset/limit.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: `File paths (relative to workspace or absolute), max ${MAX_PATHS}`,
      },
    },
    required: ["paths"],
  },
  permissionLevel: "auto",
  category: "read",
};

/** The slice of read_file's JSON result this tool re-renders. */
interface InnerRead {
  content?: string;
  hash?: string;
  truncated?: boolean;
}

export function createReadManyHandler(readFile: ToolHandler): ToolHandler {
  return {
    schema: READ_MANY_SCHEMA,
    validate: (args) => {
      const paths = args.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        return { valid: false, error: "paths must be a non-empty array of file paths" };
      }
      if (!paths.every((p) => typeof p === "string" && p.trim().length > 0)) {
        return { valid: false, error: "every entry in paths must be a non-empty string" };
      }
      return { valid: true };
    },
    async execute(input: ToolCallInput): Promise<ToolCallOutput> {
      const started = Date.now();
      const raw = Array.isArray(input.args.paths) ? (input.args.paths as unknown[]) : [];
      const all = raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      const paths = all.slice(0, MAX_PATHS);
      const dropped = all.length - paths.length;

      // Fan out through the real (freshness-wrapped) read_file, in parallel —
      // these are local subprocess reads; the expensive resource being saved
      // is the MODEL round-trip, which this whole call costs exactly once.
      const outputs = await Promise.all(
        paths.map((path, i) =>
          readFile
            .execute({
              ...input,
              toolName: "read_file",
              callId: `${input.callId}#${i}`,
              args: { path },
            })
            .catch((err): ToolCallOutput => ({
              callId: `${input.callId}#${i}`,
              toolName: "read_file",
              success: false,
              result: "",
              error: err instanceof Error ? err.message : String(err),
              durationMs: 0,
            })),
        ),
      );

      const sections: string[] = [];
      let used = 0;
      let okCount = 0;
      for (let i = 0; i < paths.length; i++) {
        const out = outputs[i];
        const head = `=== ${paths[i]} ===`;
        if (!out.success) {
          sections.push(`${head}\n(error: ${out.error ?? "read failed"})`);
          continue;
        }
        if (out.attachments && out.attachments.length > 0) {
          // An image's pixels ride only single reads — batching them would
          // multiply payloads and the loop attaches at most a handful anyway.
          sections.push(`${head}\n(image/binary — read it with read_file to view)`);
          continue;
        }
        let body = out.result;
        try {
          const parsed = JSON.parse(out.result) as InnerRead;
          if (typeof parsed.content === "string") {
            body = parsed.content;
            if (parsed.truncated) body += "\n… (file truncated by read_file)";
          }
        } catch {
          // Non-JSON result — pass through as-is.
        }
        if (body.length > PER_FILE_CHAR_CAP) {
          body =
            body.slice(0, PER_FILE_CHAR_CAP) +
            `\n… (${body.length - PER_FILE_CHAR_CAP} more chars — read_file for the rest)`;
        }
        const room = TOTAL_CHAR_CAP - used;
        if (room <= 0) {
          sections.push(`${head}\n(omitted — batch budget spent; read_file it separately)`);
          continue;
        }
        if (body.length > room) {
          body = body.slice(0, room) + "\n… (batch budget reached)";
        }
        used += body.length;
        okCount++;
        sections.push(`${head}\n${body}`);
      }
      if (dropped > 0) {
        sections.push(`(+${dropped} more paths dropped — max ${MAX_PATHS} per call)`);
      }

      return {
        callId: input.callId,
        toolName: READ_MANY_SCHEMA.name,
        success: okCount > 0,
        result: sections.join("\n\n"),
        ...(okCount === 0 ? { error: "no path could be read" } : {}),
        durationMs: Date.now() - started,
      };
    },
  };
}
