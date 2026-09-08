// ─── apply_patch: the Codex-family edit format ───
//
// OpenAI's Codex-line models are RL-trained to emit edits as a patch envelope
// (*** Begin Patch / *** Update File: … / @@ hunks); forcing them through
// string-replace edit_file fights their training and measurably degrades edit
// success. This tool accepts that envelope natively. The FORMAT is theirs
// (implemented fresh for interoperability — see THIRD_PARTY_NOTICES.md); the
// application semantics are Rune's: every hunk routes through multi-edit's
// applyOneEdit (exact → whitespace → indentation matching, unambiguous-or-
// error), the whole patch validates in memory before anything is written, and
// writes are temp+rename with best-effort rollback. Nothing lands partially.
//
// Format accepted:
//   *** Begin Patch
//   *** Add File: <path>          (body: lines prefixed "+")
//   *** Update File: <path>       (optional "*** Move to: <path>" next line,
//                                  then one or more @@ hunks of " " / "-" / "+")
//   *** Delete File: <path>
//   *** End Patch
//
// "@@ <locator>" text is advisory (a nearby declaration in Codex's dialect,
// often NOT adjacent to the hunk) — it is ignored for matching; ambiguity is
// an error rather than a guess. "*** End of File" is accepted as a hunk
// terminator.

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { applyOneEdit, type EditOp } from "./multi-edit";
import { unifiedDiff } from "./unified-diff";
import { checkSyntax } from "./diagnostics";
import { diagnosticsBlockFor } from "./lsp/feedback";
import type { LspServerManager } from "./lsp/manager";

// ── Parsing ──

export interface PatchAdd {
  kind: "add";
  path: string;
  content: string;
}
export interface PatchDelete {
  kind: "delete";
  path: string;
}
export interface PatchUpdate {
  kind: "update";
  path: string;
  moveTo?: string;
  edits: EditOp[];
}
export type PatchOp = PatchAdd | PatchDelete | PatchUpdate;

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";
const EOF_MARK = "*** End of File";

class PatchParseError extends Error {}

/**
 * Parse a patch envelope into operations. Throws PatchParseError with a
 * line-numbered message on malformed input — the model gets told exactly
 * where its patch broke, and nothing is ever applied from a bad parse.
 */
export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const beginIdx = lines.findIndex((l) => l.trim() === BEGIN);
  if (beginIdx === -1) throw new PatchParseError(`missing "${BEGIN}" line`);
  const endIdx = lines.findIndex((l) => l.trim() === END);
  if (endIdx === -1) throw new PatchParseError(`missing "${END}" line`);
  if (endIdx < beginIdx) throw new PatchParseError(`"${END}" appears before "${BEGIN}"`);

  const ops: PatchOp[] = [];
  let i = beginIdx + 1;

  const headerPath = (line: string, prefix: string, lineNo: number): string => {
    const p = line.slice(prefix.length).trim();
    if (!p) throw new PatchParseError(`line ${lineNo}: empty path in "${line.trim()}"`);
    return p;
  };

  while (i < endIdx) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.trim() === "") {
      i++; // blank between ops is tolerated
      continue;
    }

    if (line.startsWith(ADD)) {
      const path = headerPath(line, ADD, lineNo);
      i++;
      const body: string[] = [];
      while (i < endIdx && !lines[i].startsWith("*** ")) {
        const l = lines[i];
        if (!l.startsWith("+")) {
          throw new PatchParseError(
            `line ${i + 1}: Add File body lines must start with "+" (got ${JSON.stringify(l.slice(0, 30))})`,
          );
        }
        body.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path, content: body.join("\n") + (body.length > 0 ? "\n" : "") });
      continue;
    }

    if (line.startsWith(DELETE)) {
      ops.push({ kind: "delete", path: headerPath(line, DELETE, lineNo) });
      i++;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = headerPath(line, UPDATE, lineNo);
      i++;
      let moveTo: string | undefined;
      if (i < endIdx && lines[i].startsWith(MOVE)) {
        moveTo = headerPath(lines[i], MOVE, i + 1);
        i++;
      }

      const edits: EditOp[] = [];
      let oldLines: string[] | null = null;
      let newLines: string[] | null = null;

      const flushHunk = (at: number): void => {
        if (oldLines === null || newLines === null) return;
        if (oldLines.length === 0 && newLines.length === 0) {
          oldLines = null;
          newLines = null;
          return;
        }
        if (oldLines.length === 0) {
          throw new PatchParseError(
            `line ${at}: hunk for ${path} has additions but no context/removed lines — ` +
              `an Update hunk needs at least one " " or "-" line to anchor it ` +
              `(use Add File for brand-new content)`,
          );
        }
        edits.push({ old_text: oldLines.join("\n"), new_text: newLines.join("\n") });
        oldLines = null;
        newLines = null;
      };

      while (i < endIdx && !lines[i].startsWith("*** ")) {
        const l = lines[i];
        if (l.startsWith("@@")) {
          flushHunk(i + 1);
          oldLines = [];
          newLines = [];
        } else {
          if (oldLines === null || newLines === null) {
            // Hunk body without an @@ opener — Codex sometimes omits the
            // first @@; accept it by opening an implicit hunk.
            oldLines = [];
            newLines = [];
          }
          if (l.startsWith("-")) {
            oldLines.push(l.slice(1));
          } else if (l.startsWith("+")) {
            newLines.push(l.slice(1));
          } else if (l.startsWith(" ") || l === "") {
            const ctx = l.startsWith(" ") ? l.slice(1) : "";
            oldLines.push(ctx);
            newLines.push(ctx);
          } else {
            throw new PatchParseError(
              `line ${i + 1}: hunk lines must start with " ", "-", "+", or "@@" ` +
                `(got ${JSON.stringify(l.slice(0, 30))})`,
            );
          }
        }
        i++;
      }
      if (i < endIdx && lines[i].trim() === EOF_MARK) i++;
      flushHunk(i);
      if (edits.length === 0) {
        throw new PatchParseError(`Update File ${path}: no hunks`);
      }
      ops.push({ kind: "update", path, moveTo, edits });
      continue;
    }

    if (line.trim() === EOF_MARK) {
      i++;
      continue;
    }

    throw new PatchParseError(
      `line ${lineNo}: expected an operation header (*** Add/Update/Delete File:), ` +
        `got ${JSON.stringify(line.slice(0, 40))}`,
    );
  }

  if (ops.length === 0) throw new PatchParseError("patch contains no operations");
  return ops;
}

/**
 * Every filesystem path a patch would touch (targets + move destinations).
 * Used by the permission broker to decide workspace confinement without
 * trusting the handler. Returns [] for unparseable patches (the handler will
 * reject those anyway — unconfined is the safe default for garbage).
 */
export function patchTargetPaths(patchText: string): string[] {
  try {
    const paths: string[] = [];
    for (const op of parsePatch(patchText)) {
      paths.push(op.path);
      if (op.kind === "update" && op.moveTo) paths.push(op.moveTo);
    }
    return paths;
  } catch {
    return [];
  }
}

// ── Application ──

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function resolveInside(workspaceRoot: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
  const rel = relative(resolve(workspaceRoot), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `path escapes the workspace: ${p} — apply_patch only writes inside the workspace ` +
        `(use write_file/edit_file for anything else, which prompt individually)`,
    );
  }
  return abs;
}

export const APPLY_PATCH_SCHEMA: ToolSchema = {
  name: "apply_patch",
  version: "0.1.0",
  description:
    "Apply a multi-file patch in the *** Begin Patch envelope format. " +
    "Operations: '*** Add File: path' (body lines prefixed '+'), " +
    "'*** Update File: path' (optional '*** Move to: newpath'; @@ hunks with ' ' context, '-' removed, '+' added lines), " +
    "'*** Delete File: path'. End with '*** End Patch'. " +
    "The entire patch is validated before anything is written — a context mismatch in any hunk applies NOTHING and " +
    "returns exactly which hunk failed. Context matching tolerates whitespace/indentation drift but errors on ambiguity.",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "The full patch envelope, from '*** Begin Patch' to '*** End Patch'.",
      },
    },
    required: ["patch"],
  },
  permissionLevel: "confirm",
  category: "write",
};

interface FileOutcome {
  path: string;
  action: "added" | "updated" | "deleted" | "moved";
  moved_to?: string;
  hash?: string;
  edits_applied?: number;
  syntax_issues?: Array<{ line: number; message: string }>;
  /** The unified diff of this file's change, so the transcript shows red/green.
   *  apply_patch ran in TS with both texts in hand but emitted none. */
  diff?: string;
}

/**
 * @param lspManager The registry's ONE language-server manager. When present
 * and `[lsp] autoFeedback` is on, the patch result carries the servers'
 * semantic verdict on every file it touched, under one shared 2s budget — the
 * same contract `withLspFeedback` gives the single-path write tools, which
 * cannot wrap this one because a patch touches many files at once.
 */
export function createApplyPatchHandler(lspManager?: LspServerManager): ToolHandler {
  return {
    schema: APPLY_PATCH_SCHEMA,

    validate: (args) => {
      if (typeof args.patch !== "string" || args.patch.trim() === "") {
        return { valid: false, error: "patch is required and must be a non-empty string" };
      }
      try {
        parsePatch(args.patch);
      } catch (err) {
        return {
          valid: false,
          error: `patch parse failed: ${err instanceof Error ? err.message : String(err)}`,
        };
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

      let ops: PatchOp[];
      try {
        ops = parsePatch(input.args.patch as string);
      } catch (err) {
        return fail(`patch parse failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── Phase 1: validate EVERYTHING in memory. No fs mutation here. ──
      type Planned =
        | {
            kind: "write";
            abs: string;
            path: string;
            content: string;
            action: "added" | "updated";
            edits?: number;
          }
        | {
            kind: "move";
            absFrom: string;
            absTo: string;
            path: string;
            moveTo: string;
            content: string;
            edits: number;
          }
        | { kind: "delete"; abs: string; path: string };
      const planned: Planned[] = [];
      const seen = new Set<string>();

      try {
        for (const op of ops) {
          const abs = resolveInside(input.workspaceRoot, op.path);
          if (seen.has(abs)) {
            throw new Error(`patch touches ${op.path} twice — merge the operations into one`);
          }
          seen.add(abs);

          if (op.kind === "add") {
            if (await fileExists(abs)) {
              throw new Error(`Add File: ${op.path} already exists (use Update File)`);
            }
            planned.push({
              kind: "write",
              abs,
              path: op.path,
              content: op.content,
              action: "added",
            });
            continue;
          }

          if (op.kind === "delete") {
            if (!(await fileExists(abs))) {
              throw new Error(`Delete File: ${op.path} does not exist`);
            }
            planned.push({ kind: "delete", abs, path: op.path });
            continue;
          }

          // update
          let content: string;
          try {
            content = await readFile(abs, "utf8");
          } catch {
            throw new Error(`Update File: cannot read ${op.path} (does it exist?)`);
          }
          for (let e = 0; e < op.edits.length; e++) {
            // applyOneEdit throws with a precise per-hunk message on
            // mismatch/ambiguity — surfaced verbatim, nothing written.
            const applied = applyOneEdit(content, op.edits[e], e);
            content = applied.content;
          }
          if (op.moveTo) {
            const absTo = resolveInside(input.workspaceRoot, op.moveTo);
            if (await fileExists(absTo)) {
              throw new Error(`Move to: ${op.moveTo} already exists`);
            }
            seen.add(absTo);
            planned.push({
              kind: "move",
              absFrom: abs,
              absTo,
              path: op.path,
              moveTo: op.moveTo,
              content,
              edits: op.edits.length,
            });
          } else {
            planned.push({
              kind: "write",
              abs,
              path: op.path,
              content,
              action: "updated",
              edits: op.edits.length,
            });
          }
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      // ── Phase 2: execute. Track originals for best-effort rollback. ──
      const rollback: Array<() => Promise<void>> = [];
      const outcomes: FileOutcome[] = [];
      try {
        for (const p of planned) {
          if (p.kind === "write") {
            const prior = (await fileExists(p.abs)) ? await readFile(p.abs, "utf8") : null;
            await mkdir(dirname(p.abs), { recursive: true });
            await atomicWrite(p.abs, p.content);
            rollback.push(async () => {
              if (prior === null) await unlink(p.abs);
              else await atomicWrite(p.abs, prior);
            });
            outcomes.push({
              path: p.path,
              action: p.action,
              hash: sha256Hex(p.content),
              ...(p.edits !== undefined ? { edits_applied: p.edits } : {}),
              diff: unifiedDiff(prior ?? "", p.content, p.path),
            });
          } else if (p.kind === "move") {
            const prior = await readFile(p.absFrom, "utf8");
            await mkdir(dirname(p.absTo), { recursive: true });
            await atomicWrite(p.absTo, p.content);
            await unlink(p.absFrom);
            rollback.push(async () => {
              await atomicWrite(p.absFrom, prior);
              await unlink(p.absTo);
            });
            outcomes.push({
              path: p.path,
              action: "moved",
              moved_to: p.moveTo,
              hash: sha256Hex(p.content),
              edits_applied: p.edits,
              diff: unifiedDiff(prior, p.content, p.moveTo),
            });
          } else {
            const prior = await readFile(p.abs, "utf8");
            await unlink(p.abs);
            rollback.push(async () => atomicWrite(p.abs, prior));
            outcomes.push({
              path: p.path,
              action: "deleted",
              diff: unifiedDiff(prior, "", p.path),
            });
          }
        }
      } catch (err) {
        // Undo what landed (reverse order), then report the failure honestly.
        for (const undo of rollback.reverse()) {
          try {
            await undo();
          } catch {
            // rollback is best-effort; the error below names the real cause
          }
        }
        return fail(
          `patch execution failed (${err instanceof Error ? err.message : String(err)}); ` +
            `already-applied operations were rolled back`,
        );
      }

      // ── Post-edit syntax feedback, same contract as write_file/edit_file ──
      const written: string[] = [];
      for (const o of outcomes) {
        if (o.action === "deleted") continue;
        const checkPath = o.moved_to ?? o.path;
        const abs = resolveInside(input.workspaceRoot, checkPath);
        written.push(abs);
        try {
          const content = await readFile(abs, "utf8");
          const issues = await checkSyntax(abs, content);
          if (issues && issues.length > 0) o.syntax_issues = issues;
        } catch {
          // best-effort, like diagnostics.ts
        }
      }

      // ── Semantic feedback (P10.1), one budget for the whole patch ──
      const diagnostics = lspManager
        ? await diagnosticsBlockFor(lspManager, input.workspaceRoot, written)
        : "";
      if (diagnostics) {
        // Superseded for exactly the files the server spoke about, same rule
        // as the single-path wrapper.
        for (const o of outcomes) {
          const checkPath = o.moved_to ?? o.path;
          if (lspManager?.specFor(resolveInside(input.workspaceRoot, checkPath))) {
            delete o.syntax_issues;
          }
        }
      }

      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({ files: outcomes, ...(diagnostics ? { diagnostics } : {}) }),
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}

async function fileExists(abs: string): Promise<boolean> {
  return Bun.file(abs).exists();
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.rune-tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}
