// ─── File Freshness Tracking ───
//
// The harness (not the model) tracks each file's last-known content hash so
// the model doesn't have to plumb SHA-256 strings through every edit call.
// This removes two failure modes seen in real traces:
//   1. The model forgets/garbles the hash → edit rejected → wasted turn.
//   2. The model edits a file, then must re-read it purely to refresh the
//      hash before the next edit → wasted tokens.
// The Rust edit_file still performs the authoritative hash check — this layer
// just supplies the hash from the most recent read/write/edit automatically
// when the model omits it, and enforces read-before-edit when there's no
// recorded state at all.

import { realpathSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../types";

export class FileFreshness {
  private hashes = new Map<string, string>();

  private key(workspaceRoot: string, path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
    // Canonicalize through symlinks: the Rust tools echo canonicalized paths
    // (/private/var/…) while callers pass the raw workspace (/var/…, /tmp/…,
    // symlinked project dirs). Keying on the raw string split those into two
    // entries — and every relative-path edit in a symlinked workspace was
    // refused with "read the file first" despite the read.
    try {
      return realpathSync(resolved);
    } catch {
      return resolved; // file may not exist yet (first write) — raw key is fine
    }
  }

  note(workspaceRoot: string, path: string, hash: string): void {
    if (!path || !hash) return;
    this.hashes.set(this.key(workspaceRoot, path), hash);
  }

  get(workspaceRoot: string, path: string): string | undefined {
    return this.hashes.get(this.key(workspaceRoot, path));
  }
}

/** Extract `path`/`hash` from a tool output whose result is JSON. */
function parseHashFromResult(result: string): { path?: string; hash?: string } {
  try {
    const parsed = JSON.parse(result) as { path?: string; hash?: string };
    return { path: parsed.path, hash: parsed.hash };
  } catch {
    return {};
  }
}

/**
 * Wrap a file tool handler so it participates in freshness tracking:
 *  - After any successful call whose output carries a `hash`, record it.
 *  - For edit tools (`requiresFreshRead`), when the model omits
 *    `expected_hash`, inject the recorded hash — or fail with a
 *    read-before-edit error when the file was never read in this process.
 */
export function withFreshness(
  handler: ToolHandler,
  freshness: FileFreshness,
  opts: { requiresFreshRead?: boolean } = {},
): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      let callInput = input;

      if (opts.requiresFreshRead && input.args.expected_hash === undefined) {
        const path = typeof input.args.path === "string" ? input.args.path : "";
        const known = path ? freshness.get(input.workspaceRoot, path) : undefined;
        if (!known) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error:
              `You must read ${path || "the file"} (read_file) before editing it, ` +
              "so the edit can be verified against the file's current content.",
            durationMs: 0,
          };
        }
        callInput = { ...input, args: { ...input.args, expected_hash: known } };
      }

      const output = await handler.execute(callInput);

      if (output.success && output.result) {
        const { path, hash } = parseHashFromResult(output.result);
        // Prefer the path echoed by the tool; fall back to the input arg.
        const p = path ?? (typeof input.args.path === "string" ? input.args.path : "");
        if (p && hash) freshness.note(input.workspaceRoot, p, hash);
      }

      return output;
    },
  };
}
