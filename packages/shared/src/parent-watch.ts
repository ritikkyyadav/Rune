/**
 * Commands that end when the process that started them ends.
 *
 * Rune starts several kinds of command in a process group of their own: the
 * end-of-turn check, hooks, background shells, a worker's check and the parent
 * check's witness replays. A group of its own is what lets a timeout stop the
 * whole tree. Each is killed with its group when Rune exits normally. A
 * SIGKILL, a crash or a power cut runs no handler, though, and a detached group
 * shares none of Rune's signals: on 19 October the process suite killed a run
 * with SIGKILL during its end-of-turn check, and `npm test` ran on with no one
 * waiting for it.
 *
 * `watchedArgv` runs the same argv under a POSIX shell that also watches the
 * process that started it, once a second. When that process is gone, the shell
 * kills its own process group: the command and everything it started.
 * Otherwise it runs `"$@"`, the argv exactly, and exits with its status. The
 * watcher's output goes nowhere, so it never holds the command's pipes open.
 * `rune-tools` does the same for tool calls (`parent_death.rs`).
 *
 * POSIX only. On Windows the argv is returned unchanged: there is no process
 * group to kill there. `RUNE_PARENT_WATCH=off` turns the watch off.
 */

const WATCH = [
  "p=$PPID",
  '( while kill -0 "$p" 2>/dev/null; do sleep 1; done; kill -9 0 ) </dev/null >/dev/null 2>&1 &',
  "w=$!",
  `trap 'kill "$w" 2>/dev/null' EXIT`,
  '"$@"',
].join("\n");

/** The name the watching shell runs under (`$0`), so a process listing says what it is. */
export const WATCHED_ARGV0 = "rune-watched";

export function watchedArgv(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32" || argv.length === 0) return [...argv];
  if (process.env.RUNE_PARENT_WATCH === "off") return [...argv];
  return ["/bin/sh", "-c", WATCH, WATCHED_ARGV0, ...argv];
}
