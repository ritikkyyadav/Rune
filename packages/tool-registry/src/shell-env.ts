/**
 * The environment of a shell Rune starts outside its sandbox.
 *
 * Every foreground command goes through `rune-tools`, which clears the
 * environment and passes on a short list (`curate_env` in
 * crates/rune-sandbox/src/path_guard.rs), sandboxed or not. A contained
 * background shell gets the same list from the planner. An UNcontained one, a
 * background shell started with `unsandboxed: true`, with the sandbox off or
 * for an excluded command, was handed everything Rune itself had: the
 * provider keys the launcher loads from `~/.rune/.env`, and the variables that
 * say where the session keeps its database and the person's saved sign-ins.
 * A project whose tests write to whatever credential store those variables
 * name (Rune's own repository is one; its tests built a store from
 * `process.env`) wrote into the person's real one. Found 21 October, before
 * the reliability plan's live runs, which point those variables at the
 * founder's own files.
 *
 * So it gets the foreground's list, and nothing else. `parent-watch` and the
 * sandbox wrapper add nothing to it. The list is pinned to the Rust one by
 * `tests/unit/tool-registry/shell-env.test.ts`.
 */

/** What every shell keeps, as `curate_env`'s `safe_vars`. */
export const SHELL_ENV_KEEP = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM", "SHELL"] as const;

/** What a Windows shell also needs to start at all, as `curate_env`'s `win_vars`. */
export const SHELL_ENV_KEEP_WINDOWS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

export function curatedShellEnv(
  workspaceRoot: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  const names: readonly string[] =
    platform === "win32" ? [...SHELL_ENV_KEEP, ...SHELL_ENV_KEEP_WINDOWS] : SHELL_ENV_KEEP;
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.RUNE_WORKSPACE = workspaceRoot;
  env.NO_COLOR = "1";
  return env;
}
