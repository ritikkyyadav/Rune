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
import { posix, win32 } from "path";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "../types";

/**
 * Strip Windows' extended-length prefix.
 *
 * `std::fs::canonicalize` on Windows returns a VERBATIM path —
 * `\\?\C:\Users\…` — and `path.win32.resolve` preserves it, so a path that came
 * back from the Rust executor and the same path built from the workspace root
 * are two different strings for one file. That, plus the 8.3 short name
 * `%TEMP%` hands out (`C:\Users\RUNNER~1\…`), is what made the first Windows
 * runtime smoke fail `edit_file` with "You must read smoke.txt before editing
 * it" immediately after reading it (P10.2).
 *
 * `\\?\UNC\server\share` is the network form and unwraps to `\\server\share`.
 */
export function stripVerbatimPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function osRealpath(path: string): string {
  // `.native` goes straight to the OS (GetFinalPathNameByHandle on Windows,
  // which expands 8.3 short names); the JS one is the fallback for a runtime
  // that does not expose it.
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

/**
 * One spelling for one file: the ledger key.
 *
 * Canonical (symlinks and short names resolved where the file exists), no
 * verbatim prefix, forward slashes on Windows, and case-folded on Windows
 * because NTFS is case-insensitive and the drive letter's case is whatever the
 * process that produced the string happened to use.
 *
 * `platform` and `realpath` are parameters so the Windows shapes are tested on
 * every OS — the defect this fixes was invisible for months because nothing but
 * a Windows machine ever exercised the Windows branch.
 */
export function ledgerKey(
  workspaceRoot: string,
  path: string,
  opts: { platform?: string; realpath?: (p: string) => string } = {},
): string {
  const windows = (opts.platform ?? process.platform) === "win32";
  const api = windows ? win32 : posix;

  // Before resolving, not after: `resolve` keeps a `\\?\` prefix and would
  // otherwise carry it into everything downstream.
  const root = windows ? stripVerbatimPrefix(workspaceRoot) : workspaceRoot;
  const raw = windows ? stripVerbatimPrefix(path) : path;
  const resolved = api.isAbsolute(raw) ? api.resolve(raw) : api.resolve(root, raw);

  // Canonicalize through symlinks and short names: the Rust tools echo
  // canonicalized paths (/private/var/…, C:\Users\runneradmin\…) while callers
  // pass the raw workspace (/var/…, /tmp/…, C:\Users\RUNNER~1\…). Keying on the
  // raw string split those into two entries — and every relative-path edit in a
  // symlinked workspace was refused with "read the file first" despite the read.
  let canonical: string;
  try {
    canonical = (opts.realpath ?? osRealpath)(resolved);
  } catch {
    canonical = resolved; // file may not exist yet (first write) — raw key is fine
  }
  if (!windows) return canonical;

  // A backslash is a legal character in a POSIX filename, so the separator
  // rewrite belongs strictly inside this branch.
  return stripVerbatimPrefix(canonical).replace(/\\/g, "/").toLowerCase();
}

export class FileFreshness {
  private hashes = new Map<string, string>();

  note(workspaceRoot: string, path: string, hash: string): void {
    if (!path || !hash) return;
    this.hashes.set(ledgerKey(workspaceRoot, path), hash);
  }

  get(workspaceRoot: string, path: string): string | undefined {
    return this.hashes.get(ledgerKey(workspaceRoot, path));
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
        const asked = typeof input.args.path === "string" ? input.args.path : "";
        if (hash) {
          // BOTH spellings, deliberately.
          //
          // The echoed path is the executor's canonical one, so an edit that
          // names the file differently from the read still finds it. The asked
          // path is what the NEXT call will almost certainly say, and keying on
          // it makes the lookup independent of every way the two canonical
          // forms can drift apart — the Windows failure was exactly that drift
          // (`\\?\C:\Users\runneradmin\…` from the executor against
          // `C:\Users\RUNNER~1\…` from the workspace root).
          if (path) freshness.note(input.workspaceRoot, path, hash);
          if (asked) freshness.note(input.workspaceRoot, asked, hash);
        }
      }

      return output;
    },
  };
}
