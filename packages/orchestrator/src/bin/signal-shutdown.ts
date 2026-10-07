// ─── Being told to stop ───
//
// SIGTERM, SIGHUP and — in a run with nobody at the keyboard — SIGINT. None of
// them is a crash and none of them is a person's cancel: the machine is
// shutting down, a harness's wall limit ran out, a supervisor sent `kill`.
// What the process owes is to stop what it started, write down how the run in
// flight ended, and leave.
//
// It used to close the engine and exit on the spot. That was quick and told
// the run nothing: no row said how it ended, a check being replayed left its
// worktree registered in the user's repository, and what the engine itself had
// spawned was reaped only where an exit hook happened to know of it.
//
// The order now:
//
//   1. ask the run to stop (`stop`). Its stream, its tool children and any
//      check being run or replayed hear the same cancel a person's would send;
//   2. wait for it to have written how it ended — but not past `graceMs`. A
//      run that will not wind up is not a reason to stay alive;
//   3. release what the process holds (`close`) and exit with the signal's
//      conventional code, 128 + its number.
//
// A second signal while that is under way means "now": close and exit.
//
// One bound, not two. A second, later "hard" timer would sit behind the first
// in the same thread: everything after the grace period is synchronous, so
// nothing could reach it that the first timer had not already ended.
//
// Everything that touches the world is injected, so the unit tests play the
// whole thing on a fake clock.

/** The signals this handles, and the exit code each one owes: 128 + its number. */
export const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
export type StopSignal = keyof typeof SIGNAL_EXIT_CODES;

/** How long a run is given to write how it ended before the process leaves anyway. */
export const SHUTDOWN_GRACE_MS = 5_000;

export interface ShutdownDeps {
  /**
   * Ask the run in flight to stop. Resolves when the process may exit — the run
   * has written how it ended, or there was none. May never resolve when
   * another path will exit the process itself; the grace period still holds.
   */
  stop(signal: StopSignal): Promise<void>;
  /** Release what the process holds. Synchronous, and allowed to throw. */
  close(): void;
  exit(code: number): void;
  /** `setTimeout`, for a test's clock. */
  setTimer?(fn: () => void, ms: number): unknown;
}

export interface SignalShutdown {
  /** A signal arrived. */
  handle(signal: StopSignal): void;
  /**
   * The exit code a signal has made owed, or null when none has arrived — for
   * a path that exits the process itself and must not report its own code over
   * the signal's.
   */
  owedExitCode(): number | null;
}

export function createSignalShutdown(
  deps: ShutdownDeps,
  opts: { graceMs?: number } = {},
): SignalShutdown {
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let stopping: StopSignal | null = null;
  let left = false;

  const leave = (code: number): void => {
    if (left) return;
    left = true;
    try {
      deps.close();
    } catch {
      // Leaving anyway: cleanup must never be what keeps the process alive.
    }
    deps.exit(code);
  };

  return {
    owedExitCode: () => (stopping ? SIGNAL_EXIT_CODES[stopping] : null),
    handle(signal) {
      // Asked twice: now. The code is the FIRST signal's — that is what stopped it.
      if (stopping) return leave(SIGNAL_EXIT_CODES[stopping]);
      stopping = signal;
      const code = SIGNAL_EXIT_CODES[signal];
      setTimer(() => leave(code), graceMs);
      let asked: Promise<void>;
      try {
        asked = deps.stop(signal);
      } catch {
        return leave(code);
      }
      asked.then(
        () => leave(code),
        () => leave(code),
      );
    },
  };
}
