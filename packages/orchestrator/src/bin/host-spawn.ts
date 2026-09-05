// ─── How a session host is started, from wherever Rune happens to be ───
//
// `rune serve`, `rune web` and `rune detach` all do the same thing: spawn one
// `engine-host` process per session and talk to it over a unix socket. Until
// P10.9a they all spelled that spawn the same way too —
//
//     bun <import.meta.dir>/engine-host.ts --socket <path>
//
// — which is correct for a source checkout and impossible for the artifact
// people actually install. `bun build --compile` bundles the source into the
// executable and serves it from a VIRTUAL filesystem rooted at `/$bunfs/`
// (`B:\~BUN\` on Windows). `import.meta.dir` inside a compiled binary is a
// path in that virtual root, so the join produced `/$bunfs/root/engine-host.ts`
// and every spawn died with:
//
//     error: Module not found "/$bunfs/root/engine-host.ts"
//
// visible only in `~/.rune/run/*.log`, which nobody reads. From the installed
// binary, `rune serve` could not run a single session.
//
// Phase 3 already anticipated this: `rune engine-host` is a real subcommand
// (rune-cli.ts) precisely so a packaged install can be its own sidecar. What
// was missing was the caller choosing it. That decision lives here, once, and
// is tested in both directions rather than discovered on a user's machine.

import { join } from "node:path";

/**
 * The roots Bun serves a compiled binary's own source from.
 *
 * POSIX gets `/$bunfs/`; Windows gets a synthetic `B:\~BUN\` drive. Neither is
 * a real directory, so nothing under them can be handed to a spawn.
 */
const BUNFS_ROOTS = ["/$bunfs/", "B:\\~BUN\\", "b:\\~bun\\"];

/** Whether a path is inside the compiled binary's virtual filesystem. */
export function isBunfsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BUNFS_ROOTS.some((root) => lower.startsWith(root.toLowerCase()));
}

export interface SpawnContext {
  /**
   * `import.meta.dir` of the caller — the honest signal.
   *
   * `process.execPath` alone is not enough: it is the Bun binary for a source
   * run and the rune binary for a compiled one, but a renamed or symlinked
   * `bun` would be misread. Where the CALLING MODULE lives cannot lie: under
   * `/$bunfs/` there is no source tree to point a spawn at, full stop.
   */
  moduleDir: string;
  /** The executable this process is running as. */
  execPath: string;
}

/** The context of the module asking, defaulted from the running process. */
export function currentContext(moduleDir: string): SpawnContext {
  return { moduleDir, execPath: process.execPath };
}

/**
 * Is this a compiled, standalone `rune` — as opposed to `bun some/file.ts`?
 *
 * Compiled means the source is virtual, which means `<dir>/engine-host.ts`
 * does not exist and `process.execPath` is the rune binary that knows the
 * `engine-host` subcommand.
 */
export function isCompiled(ctx: SpawnContext): boolean {
  return isBunfsPath(ctx.moduleDir);
}

/**
 * The argv that starts one engine host.
 *
 * Compiled: `<rune> engine-host <args…>` — the binary re-enters itself, so
 * nobody needs Bun or a source checkout on their machine.
 * From source: `bun <dir>/engine-host.ts <args…>` — unchanged, because a
 * developer editing engine-host.ts must see the edit on the next spawn.
 *
 * The trailing args (`--socket`, `--parent-pid`) are passed through untouched
 * in both shapes: `engine-host.ts` reads them off `process.argv` by name, so
 * the extra leading `engine-host` word in the compiled form is invisible to it.
 */
export function hostSpawnArgv(ctx: SpawnContext, args: string[]): string[] {
  if (isCompiled(ctx)) return [ctx.execPath, "engine-host", ...args];
  return ["bun", join(ctx.moduleDir, "engine-host.ts"), ...args];
}

/**
 * One line naming how hosts will be started, for a banner or a log.
 *
 * Worth printing: "which engine-host is this server going to spawn" was
 * answerable only by reading a crashed host's log file.
 */
export function hostSpawnLabel(ctx: SpawnContext): string {
  return isCompiled(ctx)
    ? `${ctx.execPath} engine-host`
    : `bun ${join(ctx.moduleDir, "engine-host.ts")}`;
}
