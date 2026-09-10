/**
 * Which `rune-tools` a native suite is actually grading.
 *
 * The containment suites are evidence about ONE build. Two ways they quietly
 * stopped being that, both recorded in the 2026-09-10 handoff:
 *
 *   * `plugin-tools-sandbox` preferred `target/release/rune-tools` over
 *     `target/debug` and read no environment variable at all, so a stale
 *     release artifact graded a freshly built debug binary — a green run that
 *     proved nothing about the code under review;
 *   * `background-sandbox` resolved a RELATIVE default against the process
 *     working directory, and treated an explicitly exported path that is not
 *     there as "this machine has no native binary" — i.e. a silent skip inside
 *     a green run, which is the failure mode the Linux CI job was fixed for.
 *
 * So the order here is: an explicitly exported `RUNE_TOOLS_BINARY` or
 * `RUNE_TOOLS_BIN` WINS over anything discovered under `target/`, and a
 * variable pointing at a file that does not exist is an ERROR, never a skip.
 * Discovery is only the fallback, and it takes the newer of debug/release so
 * that neither directory can silently outrank the build a run just made.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";

/** Both spellings, most specific first: runs and CI jobs export either one. */
export const TOOLS_BINARY_VARS = ["RUNE_TOOLS_BINARY", "RUNE_TOOLS_BIN"] as const;

export interface NativeToolsBinary {
  /** Absolute path, whether or not anything is there. */
  path: string;
  /** The variable that named it, or the artifact directory it was found in. */
  source: string;
  /** True when an environment variable chose it. */
  explicit: boolean;
  exists: boolean;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Resolve the native binary for a suite that needs a real sandbox.
 *
 * Throws when a variable names a path that does not exist: a run that was
 * pointed at a specific artifact must fail loudly rather than fall back to a
 * different one or skip. Relative values resolve against the repository root,
 * not the process cwd, so the answer does not depend on where `bun` started.
 */
export function resolveRuneToolsBinary(
  env: Record<string, string | undefined> = process.env,
): NativeToolsBinary {
  for (const name of TOOLS_BINARY_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const path = resolve(repoRoot, raw);
    if (!existsSync(path)) {
      throw new Error(
        `${name}=${raw} does not exist (resolved to ${path}). ` +
          "Build it with `cargo build --locked -p rune-tools`, or unset " +
          `${name} to grade whichever artifact is under target/.`,
      );
    }
    return { path, source: name, explicit: true, exists: true };
  }

  const debug = resolve(repoRoot, `target/debug/rune-tools${EXE}`);
  const release = resolve(repoRoot, `target/release/rune-tools${EXE}`);
  const found = [
    { path: debug, source: "target/debug" },
    { path: release, source: "target/release" },
  ]
    .filter((c) => existsSync(c.path))
    .sort((a, b) => mtime(b.path) - mtime(a.path));
  const chosen = found[0];
  if (chosen) return { ...chosen, explicit: false, exists: true };
  return { path: debug, source: "target/debug", explicit: false, exists: false };
}

/** One line a skipped suite can print so a skip is never read as a pass. */
export function describeNativeBinary(bin: NativeToolsBinary): string {
  return bin.exists
    ? `${bin.path} (${bin.source})`
    : `no rune-tools binary — looked at ${bin.path}; run \`cargo build --locked -p rune-tools\``;
}
